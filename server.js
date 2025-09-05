// server.js
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

// ───────────────────────────────────────────────────────────────────────────────
// BASIC SERVER
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

app.get("/", (_req, res) => res.status(200).send("OK"));

// ───────────────────────────────────────────────────────────────────────────────
/** AUDIO CONSTANTS (Twilio expects 16-bit PCM mono @ 8kHz, 20ms frames) */
// ───────────────────────────────────────────────────────────────────────────────
const SAMPLE_RATE = 8000;              // Hz
const BYTES_PER_SAMPLE = 2;            // 16-bit PCM
const FRAME_MS = 20;                   // 20 ms/frame
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160 samples
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320 bytes

// ───────────────────────────────────────────────────────────────────────────────
/** ELEVENLABS CONFIG */
// ───────────────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

if (!ELEVEN_API_KEY)  console.error("❌ ELEVEN_API_KEY is not set");
if (!ELEVEN_VOICE_ID) console.error("❌ ELEVEN_VOICE_ID is not set");

// ───────────────────────────────────────────────────────────────────────────────
/** UTIL: stream raw PCM to Twilio in 20ms base64 media frames (pads last frame) */
// ───────────────────────────────────────────────────────────────────────────────
async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  let frames = 0;

  while (offset < pcmBuffer.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const chunk = pcmBuffer.slice(offset, end);

    // pad final chunk to full 320 bytes to avoid tail truncation/static
    let payload;
    if (chunk.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME);
      chunk.copy(padded, 0);
      payload = padded.toString("base64");
    } else {
      payload = chunk.toString("base64");
    }

    ws.send(JSON.stringify({ event: "media", media: { payload } }));

    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${((frames * FRAME_MS) / 1000).toFixed(1)}s)`);
    }

    await new Promise(r => setTimeout(r, FRAME_MS)); // pace like realtime
    offset += BYTES_PER_FRAME;
  }
}

/** UTIL: send N frames of pure silence (320 bytes each) */
async function sendSilence(ws, frames) {
  if (ws.readyState !== ws.OPEN) return;
  const silent = Buffer.alloc(BYTES_PER_FRAME).toString("base64");
  for (let i = 0; i < frames && ws.readyState === ws.OPEN; i++) {
    ws.send(JSON.stringify({ event: "media", media: { payload: silent } }));
    await new Promise(r => setTimeout(r, FRAME_MS));
  }
}

/** UTIL: background keepalive: 200 silence frames (~4s) every ~4s */
function startKeepalive(ws) {
  const id = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) return;
    await sendSilence(ws, 200);
    console.log("[KEEPALIVE] sent 200 silence frames (~4s)");
  }, 4000);
  return () => clearInterval(id);
}

// ───────────────────────────────────────────────────────────────────────────────
/** ELEVENLABS TTS (8 kHz PCM) */
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabsPcm8k(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/pcm"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      output_format: "pcm_8000",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${body}`);
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(`[WARN] PCM length ${pcm.length} not sample-aligned; tail may be ignored.`);
  }
  return pcm;
}

// ───────────────────────────────────────────────────────────────────────────────
/** PER-CALL STATE + SPEECH QUEUE */
// ───────────────────────────────────────────────────────────────────────────────
function createCallState(ws) {
  return {
    ws,
    // queue outgoing TTS so replies never overlap
    speakQueue: Promise.resolve(),
    speak(text) {
      this.speakQueue = this.speakQueue.then(async () => {
        if (!text || !text.trim()) return;
        console.log(`[TTS] reply -> "${text}"`);
        const pcm = await ttsElevenLabsPcm8k(text.trim());
        await streamPcmToTwilio(this.ws, pcm);
      }).catch(err => console.error("[TTS] error:", err.message));
      return this.speakQueue;
    },
    // dedupe partial transcriptions
    lastTranscriptionId: null,
    stopKeepalive: () => {},
  };
}

// ───────────────────────────────────────────────────────────────────────────────
/** WEBSOCKET UPGRADE + HANDLER FOR Twilio <Connect><Stream> to /stream */
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  const call = createCallState(ws);

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
      return;
    }

    if (msg.event === "start") {
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`);
      // start keepalive
      call.stopKeepalive = startKeepalive(ws);

      // Optional: 1 kHz calibration tone (0.5s) to prove outbound path is clean
      await (async () => {
        // 1 kHz sine @ -18 dBFS
        const durMs = 500;
        const totalFrames = Math.ceil(durMs / FRAME_MS);
        for (let i = 0; i < totalFrames && ws.readyState === ws.OPEN; i++) {
          const frame = Buffer.alloc(BYTES_PER_FRAME);
          for (let s = 0; s < SAMPLES_PER_FRAME; s++) {
            const t = (i * SAMPLES_PER_FRAME + s) / SAMPLE_RATE;
            const val = Math.sin(2 * Math.PI * 1000 * t) * 0.125; // -18dBFS
            frame.writeInt16LE(Math.max(-1, Math.min(1, val)) * 32767, s * 2);
          }
          ws.send(JSON.stringify({ event: "media", media: { payload: frame.toString("base64") } }));
          await new Promise(r => setTimeout(r, FRAME_MS));
        }
        console.log("[TTS] sent 1 kHz test tone (0.5s) …");
      })().catch(()=>{});

      // Greet the caller
      call.speak("Hi! I’m your AI receptionist. How can I help you today?");
      return;
    }

    // Twilio inbound audio (we just count it — STT comes in 'transcription' events)
    if (msg.event === "media") {
      ws._rx = (ws._rx || 0) + 1;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
      return;
    }

    // Real-time STT from Twilio (if enabled on your number / stream)
    if (msg.event === "transcription") {
      const t = msg.transcription || {};
      const id = t.transcription_id || t.id || null;
      const text = (t.text || "").trim();
      const isFinal = t.is_final === true || t.final === true || t.status === "final";

      if (!text) return; // ignore blanks
      if (!isFinal) return; // only respond to finals
      if (id && id === call.lastTranscriptionId) return; // dedupe
      call.lastTranscriptionId = id;

      console.log(`[STT] "${text}"`);
      // SUPER simple echo bot – replace with your NLU/agent logic
      call.speak(`You said: ${text}. What else can I do for you?`);
      return;
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
      return;
    }
  });

  ws.on("close", () => {
    call.stopKeepalive?.();
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => console.error("[WS] error", err));
});
