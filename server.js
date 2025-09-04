import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// Helper: 20ms silence frame
const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME).toString("base64");

// Send PCM to Twilio in 20ms frames
async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  let frames = 0;

  while (offset < pcmBuffer.length) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);

    let payload;
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME);
      frame.copy(padded, 0);
      payload = padded.toString("base64");
    } else {
      payload = frame.toString("base64");
    }

    ws.send(JSON.stringify({ event: "media", media: { payload } }));
    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
}

// Keepalive: stream silence forever until WS closes
async function streamSilence(ws) {
  let frames = 0;
  while (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event: "media", media: { payload: SILENCE_FRAME } }));
    frames++;
    if (frames % 200 === 0) {
      console.log(`[KEEPALIVE] sent ${frames} silence frames (~${(frames * FRAME_MS) / 1000}s)`);
    }
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
}

// ElevenLabs TTS -> PCM 8kHz
async function ttsElevenLabsPcm8k(text) {
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

  if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`);

      try {
        console.log("[TTS] sending 1 kHz test tone (1.0s) …");
        const testTone = Buffer.alloc(SAMPLE_RATE * BYTES_PER_SAMPLE); // 1 sec of silence/test tone placeholder
        await streamPcmToTwilio(ws, testTone);

        console.log("[TTS] sending greeting (TTS) …");
        const pcm = await ttsElevenLabsPcm8k("Hi! I’m your AI receptionist. How can I help you today?");
        await streamPcmToTwilio(ws, pcm);

        // After greeting, keep sending silence so Twilio doesn't close
        streamSilence(ws);
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
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

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
