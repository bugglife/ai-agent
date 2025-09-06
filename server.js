// server.js (streamSid fix + pcm16 + beep)
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
const ENABLE_BEEP = (process.env.ENABLE_BEEP || "true").toLowerCase() !== "false";

// Twilio media stream assumptions
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;                                  // 20 ms
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_SAMPLE_PCM16 = 2;
const BYTES_PER_FRAME_PCM16 = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE_PCM16; // 320

// 1 kHz short beep (PCM16, 8 kHz)
function makeBeepPcm16(durationMs = 500, freqHz = 1000) {
  const total = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(total * 2);
  const amp = 0.2 * 32767;
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    buf.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * freqHz * t)), i * 2);
  }
  return buf;
}

// ElevenLabs TTS → 8 kHz PCM (so we avoid resampling)
async function ttsElevenLabsPcm8k(text) {
  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY not set");
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/pcm",
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      output_format: "pcm_8000",
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${txt}`);
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length % 2 !== 0) {
    console.warn(`[WARN] TTS PCM length ${pcm.length} not sample-aligned (odd); last byte ignored.`);
  }
  return pcm;
}

// Send one 20 ms frame to Twilio (MUST include streamSid)
function sendMediaFrame(ws, streamSid, rawFrame) {
  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,                        // ← ← REQUIRED
      media: { payload: rawFrame.toString("base64") },
    })
  );
}

// Chunk PCM16 into 20 ms frames and stream out
async function streamPcm16ToTwilio(ws, streamSid, pcm16, tag = "TTS") {
  let offset = 0;
  let frames = 0;

  while (offset < pcm16.length) {
    const end = Math.min(offset + BYTES_PER_FRAME_PCM16, pcm16.length);
    let frame = pcm16.slice(offset, end);
    if (frame.length < BYTES_PER_FRAME_PCM16) {
      const padded = Buffer.alloc(BYTES_PER_FRAME_PCM16);
      frame.copy(padded, 0);
      frame = padded;
    }
    if (frame.length !== BYTES_PER_FRAME_PCM16) {
      console.warn(`[WARN] PCM16 frame size=${frame.length} (expected ${BYTES_PER_FRAME_PCM16})`);
    }

    sendMediaFrame(ws, streamSid, frame);
    frames++;
    if (frames % 100 === 0) {
      console.log(`[${tag}] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME_PCM16;
  }
  console.log(`[${tag}] done.`);
}

// WebSocket for Twilio
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  const state = { streamSid: null, inboundFrames: 0 };

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(
        `[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`
      );
    }

    if (msg.event === "start") {
      state.streamSid = msg.start?.streamSid || null;
      console.log(
        `[WS] START callSid=${msg.start?.callSid} streamSid=${state.streamSid} bidi=${msg.start?.bidirectional}`
      );

      try {
        if (ENABLE_BEEP) {
          await streamPcm16ToTwilio(ws, state.streamSid, makeBeepPcm16(500, 1000), "BEEP");
        }
        const pcm = await ttsElevenLabsPcm8k(GREETING_TEXT);
        await streamPcm16ToTwilio(ws, state.streamSid, pcm, "TTS");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      state.inboundFrames++;
      if (state.inboundFrames % 100 === 0) {
        console.log(`[MEDIA] frames received: ${state.inboundFrames}`);
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${state.inboundFrames})`);
    }
  });

  ws.on("close", () => console.log("[WS] CLOSE code=1005 reason="));
  ws.on("error", (err) => console.error("[WS] error", err));
});

// HTTP + upgrade
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

app.get("/", (_req, res) => res.status(200).send("OK"));
