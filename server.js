// server.js — Twilio Media Streams -> ElevenLabs TTS (PCM16 8 kHz outbound)
// Node 18+ (global fetch). No node-fetch needed.

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// ===== ElevenLabs config =====
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
const ELEVEN_TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

// ===== WAV helpers =====

// Return { data: Buffer, fmt: { sampleRate, bitsPerSample, numChannels, audioFormat } }
// If not WAV, assume it's already raw PCM16 8 kHz mono and return as-is with fmt fallback.
function parseWavOrRawPcm16(buf) {
  const isRiff = buf.length >= 12 && buf.slice(0,4).toString() === "RIFF" && buf.slice(8,12).toString() === "WAVE";
  if (!isRiff) {
    // assume raw PCM16 LE mono @ 8 kHz
    return { data: buf, fmt: { sampleRate: 8000, bitsPerSample: 16, numChannels: 1, audioFormat: 1 } };
  }

  // minimal WAV parser
  let pos = 12;
  let fmt = null;
  let data = null;

  while (pos + 8 <= buf.length) {
    const id = buf.slice(pos, pos + 4).toString();
    const size = buf.readUInt32LE(pos + 4);
    const next = pos + 8 + size;

    if (id === "fmt ") {
      const audioFormat = buf.readUInt16LE(pos + 8);
      const numChannels = buf.readUInt16LE(pos + 10);
      const sampleRate = buf.readUInt32LE(pos + 12);
      const bitsPerSample = buf.readUInt16LE(pos + 22);
      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample };
    } else if (id === "data") {
      data = buf.slice(pos + 8, pos + 8 + size);
    }
    pos = next;
  }

  if (!data) data = Buffer.alloc(0);
  if (!fmt) fmt = { audioFormat: 1, numChannels: 1, sampleRate: 8000, bitsPerSample: 16 };
  return { data, fmt };
}

// ===== ElevenLabs TTS (PCM16 8 kHz) =====
async function ttsPcm8k(text) {
  if (!ELEVEN_API_KEY) {
    console.warn("[TTS] Missing ELEVEN_API_KEY");
    return null;
  }

  const body = {
    text,
    output_format: "pcm_8000" // <- Linear PCM 16-bit, 8 kHz
  };

  const resp = await fetch(ELEVEN_TTS_URL, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/octet-stream",
    },
    body: JSON.stringify(body),
  });

  const rawBuf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    console.warn("[TTS] HTTP", resp.status, rawBuf.toString("utf8").slice(0, 300));
    return null;
  }

  const { data, fmt } = parseWavOrRawPcm16(rawBuf);
  console.log(`[TTS] bytes=${rawBuf.length} wav=${rawBuf.slice(0,4).toString()==="RIFF"} dataBytes=${data.length} fmt=${JSON.stringify(fmt)}`);
  if (fmt.audioFormat !== 1 || fmt.sampleRate !== 8000 || fmt.bitsPerSample !== 16 || fmt.numChannels !== 1) {
    console.warn("[TTS] Unexpected format; expected PCM16 LE mono @ 8000 Hz");
  }
  return data;
}

// ===== Outbound to Twilio: PCM16 frames (320 bytes = 20ms @ 8kHz) =====
async function sendPcm16FramesToTwilio(ws, streamSid, pcmBuf) {
  const BYTES_PER_FRAME = 320; // 160 samples * 2 bytes = 20ms
  const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME, 0x00); // PCM16 silence

  let framesSent = 0;
  for (let off = 0; off < pcmBuf.length; off += BYTES_PER_FRAME) {
    if (ws.readyState !== ws.OPEN) break;

    let frame = pcmBuf.slice(off, Math.min(off + BYTES_PER_FRAME, pcmBuf.length));
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME, 0x00);
      frame.copy(padded);
      frame = padded;
    }

    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") }
    }));

    framesSent++;
    await new Promise(r => setTimeout(r, 20));
  }

  // a short trailing silence frame helps avoid truncation on some stacks
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: SILENCE_FRAME.toString("base64") }
    }));
    framesSent++;
  }

  console.log(`[OUT-PCM] framesSent=${framesSent} (~${framesSent * 20}ms)`);
}

// ===== WebSocket handling =====

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  let streamSid = null;

  ws.on("message", async (message) => {
    let msg;
    try { msg = JSON.parse(message.toString()); } catch { return; }

    switch (msg.event) {
      case "start":
        streamSid = msg.start?.streamSid || null;
        console.log("[WS] START streamSid:", streamSid);

        // Give Twilio a brief moment to be ready
        setTimeout(async () => {
          const pcm = await ttsPcm8k("Connected. I can speak now.");
          if (pcm && streamSid && ws.readyState === ws.OPEN) {
            await sendPcm16FramesToTwilio(ws, streamSid, pcm);
          }
        }, 250);
        break;

      case "media":
        // Acknowledge inbound frames so Twilio continues streaming
        if (msg.media?.sequenceNumber !== undefined) {
          ws.send(JSON.stringify({
            event: "mark",
            mark: { name: `ack_${msg.media.sequenceNumber}` }
          }));
        }
        break;

      case "stop":
        console.log("[WS] STOP");
        break;

      default:
        break;
    }
  });

  ws.on("close", () => console.log("🔌 WebSocket closed"));
  ws.on("error", (err) => console.error("[WS] ERROR", err));
});

// ===== HTTP/WS server =====

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

app.get("/", (_req, res) => res.send("OK"));

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
