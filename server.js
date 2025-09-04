// server.js
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

// ───────────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // change if you like

if (!ELEVEN_API_KEY)  console.error("❌ ELEVEN_API_KEY is not set");
if (!ELEVEN_VOICE_ID) console.error("❌ ELEVEN_VOICE_ID is not set");

// Twilio media is 16-bit PCM, mono, 8 kHz → 20 ms frames = 160 samples = 320 bytes
const SAMPLE_RATE       = 8000;
const BYTES_PER_SAMPLE  = 2;     // 16-bit
const FRAME_MS          = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME   = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// ───────────────────────────────────────────────────────────────────────────────
// TX counters (so logs line up with Twilio Insights)
// ───────────────────────────────────────────────────────────────────────────────
function initTxCounter(ws) {
  ws._tx = { frames: 0, bytes: 0, startedAt: Date.now() };
}
function bumpTxCounter(ws, nBytes) {
  if (!ws._tx) initTxCounter(ws);
  ws._tx.frames += 1;
  ws._tx.bytes  += nBytes;
  if (ws._tx.frames % 100 === 0) {
    const secs = ((Date.now() - ws._tx.startedAt) / 1000).toFixed(1);
    console.log(`[TTS] sent ${ws._tx.frames} frames (~${(ws._tx.frames * FRAME_MS) / 1000}s, ${ws._tx.bytes} bytes) in ${secs}s`);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// PCM → Twilio: chunk into 20 ms frames, pad tail, pace in real-time
// ───────────────────────────────────────────────────────────────────────────────
async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  while (offset < pcmBuffer.length) {
    const end   = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);

    // If the last frame is short, pad with silence so Twilio gets a full frame
    let payload;
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME); // zeros = silence
      frame.copy(padded, 0);
      payload = padded.toString("base64");
    } else {
      payload = frame.toString("base64");
    }

    ws.send(JSON.stringify({ event: "media", media: { payload } }));
    bumpTxCounter(ws, BYTES_PER_FRAME);

    // 20 ms pacing to mimic real-time
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS (ElevenLabs): ask for raw 8 kHz PCM
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabsPcm8k(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/pcm", // raw PCM bytes
    },
    body: JSON.stringify({
      text,
      // model_id: "eleven_multilingual_v2", // optional; let EL choose if you want
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      output_format: "pcm_8000", // match Twilio exactly
    }),
  });

  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${errTxt}`);
  }

  const arrayBuf  = await res.arrayBuffer();
  const pcmBuffer = Buffer.from(arrayBuf);

  // Sanity: should be multiples of 2 bytes (16-bit samples)
  if (pcmBuffer.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(`[WARN] PCM length ${pcmBuffer.length} is not sample-aligned; Twilio may ignore one tail byte.`);
  }
  return pcmBuffer;
}

// ───────────────────────────────────────────────────────────────────────────────
// 1 kHz / 8 kHz mono test tone (to prove the audio path even without TTS)
// ───────────────────────────────────────────────────────────────────────────────
function makeTonePcm8k({ hz = 1000, seconds = 1.0, amplitude = 0.3 } = {}) {
  const totalSamples = Math.floor(SAMPLE_RATE * seconds);
  const buf = Buffer.alloc(totalSamples * BYTES_PER_SAMPLE);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const s = Math.sin(2 * Math.PI * hz * t) * amplitude;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2);
  }
  return buf;
}

// ───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER  (Twilio <Connect><Stream> → wss://…/stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON
    }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`);
      try {
        initTxCounter(ws);

        // 1) Known-good tone first (~1s)
        console.log("[TTS] sending 1 kHz test tone (1.0s) …");
        const tone = makeTonePcm8k({ hz: 1000, seconds: 1.0, amplitude: 0.25 });
        await streamPcmToTwilio(ws, tone);

        // 2) Then real TTS greeting
        console.log("[TTS] sending greeting (TTS) …");
        const pcm = await ttsElevenLabsPcm8k("Hi! I’m your AI receptionist. How can I help you today?");
        await streamPcmToTwilio(ws, pcm);

        // 3) Optional half-second of silence to “cap” the audio
        await streamPcmToTwilio(ws, Buffer.alloc(BYTES_PER_FRAME * 25)); // ~500 ms
      } catch (e) {
        console.error("[TTS] start sequence failed:", e.message);
      }
    }

    if (msg.event === "media") {
      // Inbound caller audio (base64 8 kHz, 16-bit mono). We just count it.
      ws._rxCount = (ws._rxCount || 0) + 1;
      if (ws._rxCount % 100 === 0) {
        console.log(`[MEDIA] frames received: ${ws._rxCount}`);
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rxCount || 0})`);
    }
  });

  ws.on("close", () => {
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => {
    console.error("[WS] error", err);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// HTTP server + WS upgrade (only /stream), plus a healthcheck on /
// ───────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
