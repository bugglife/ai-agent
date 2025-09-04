// server.js — Twilio <Connect><Stream> <-> ElevenLabs (STT + TTS)
// Node 18+.  Render ENV needed: ELEVEN_API_KEY; optional ELEVEN_VOICE_ID

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
const ELEVEN_TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
const ELEVEN_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVEN_STT_MODEL = "scribe_v1";

// Twilio stream framing (PCMU @8k):
const FRAME_MS = 20;
const ULAW_BYTES_PER_FRAME = 160; // 20ms @8kHz = 160 samples
const SILENCE_ULAW = 0xff;

// Very light STT batching / VAD
const CHUNK_MS = 1200;
const FRAMES_PER_CHUNK = Math.round(CHUNK_MS / FRAME_MS);
const ENERGY_GATE = 300;

// -----------------------------------------------------------------------------
// HTTP + WS
// -----------------------------------------------------------------------------
const app = express();
app.get("/", (_req, res) => res.send("OK"));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log("[UPGRADE] url: /stream");
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// -----------------------------------------------------------------------------
// Audio utilities
// -----------------------------------------------------------------------------

// μ-law <-> PCM16
function ulawByteToLinear(u) {
  u = ~u & 0xff;
  const sign = u & 0x80 ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 1) + 1) << (exponent + 2);
  sample -= 33;
  sample = sign * sample;
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}
function ulawToPcm16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) out[i] = ulawByteToLinear(ulawBuf[i]);
  return out;
}
function linearToUlaw(sample) {
  const MU_MAX = 0x1fff;
  let s = Math.max(-32768, Math.min(32767, sample));
  const sign = s < 0 ? 0x80 : 0x00;
  if (s < 0) s = -s;
  s = Math.min(MU_MAX, s + 0x84);
  const exponent = Math.floor(Math.log2(s)) - 6;
  const mantissa =
    exponent < 0 ? (s >> 1) & 0x0f : (s >> (exponent + 3)) & 0x0f;
  return ~(sign | ((exponent & 0x07) << 4) | mantissa) & 0xff;
}
function pcm16ToUlaw(int16) {
  const out = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = linearToUlaw(int16[i]);
  return out;
}

// Linear resample Int16 PCM between rates
function resamplePcm16(int16, inRate,
