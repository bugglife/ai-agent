// server.js — Twilio <Connect><Stream> <-> ElevenLabs bridge
// Node 18+.  Env: ELEVEN_API_KEY (required), ELEVEN_VOICE_ID (optional)

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

// Twilio stream (PCMU @8k) framing:
const FRAME_MS = 20;
const ULAW_BYTES_PER_FRAME = 160; // 20ms PCMU @ 8k
const SILENCE_ULAW = 0xff;

// STT batching
const CHUNK_MS = 1500;
const FRAMES_PER_CHUNK = Math.round(CHUNK_MS / FRAME_MS);
const ENERGY_GATE = 300;

// -----------------------------------------------------------------------------
// Web server + WS
// -----------------------------------------------------------------------------
const app = express();
app.get("/", (_req, res) => res.send("OK"));
const server = createServer(app);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  try {
    console.log("[UPGRADE] url: /stream");
  } catch {}
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// -----------------------------------------------------------------------------
// Audio utils (μ-law, resample, WAV wrapper for STT uploads)
// -----------------------------------------------------------------------------
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
function pcm16ToUlaw(pcm16) {
  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = linearToUlaw(pcm16[i]);
  return out;
}
function rms(int16) {
  let s = 0;
  for (let i = 0; i < int16.length; i++) s += int16[i] * int16[i];
  return Math.sqrt(s / (int16.length || 1));
}
// Linear resampler for Int16 PCM
function resamplePcm16(int16, inRate, outRate) {
  if (inRate === outRate) return int16;
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.round(int16.length * ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(int16.length - 1, i0 + 1);
    const frac = srcPos - i0;
    const s = int16[i0] * (1 - frac) + int16[i1] * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
  }
  return out;
}
// Build a tiny WAV (mono 16-bit PCM) for STT upload
function pcm16ToWav(pcm16, sr = 8000) {
  const numChannels = 1;
  const byteRate = sr * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcm16.length * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // bits
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm16.length; i++) buf.writeInt16LE(pcm16[i], 44 + i * 2);
  return buf;
}

// -----------------------------------------------------------------------------
// ElevenLabs calls
// -----------------------------------------------------------------------------

// TTS → raw PCM16 @16k from ElevenLabs, resample to 8k, μ-law, return Buffer
async function ttsToUlaw8k(text) {
  if (!ELEVEN_API_KEY) {
    console.warn("[TTS] Missing ELEVEN_API_KEY");
    return null;
  }
  const resp = await fetch(ELEVEN_TTS_URL, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/pcm", // request raw PCM (no container)
    },
    body: JSON.stringify({
      text,
      // raw PCM output @ 16k from ElevenLabs
      output_format: "pcm_16000",
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
    }),
  });

  const arr = await resp.arrayBuffer();
  if (!resp.ok) {
    console.warn("[TTS] HTTP", resp.status, Buffer.from(arr).toString());
    return null;
  }

  // Interpret as little-endian 16-bit PCM @ 16k
  const int16_16k = new Int16Array(arr.byteLength / 2);
  const view = new DataView(arr);
  for (let i = 0; i < int16_16k.length; i++) {
    int16_16k[i] = view.getInt16(i * 2, true);
  }

  // Resample to 8 kHz for Twilio
  const int16_8k = resamplePcm16(int16_16k, 16000, 8000);
  const ulaw = pcm16ToUlaw(int16_8k);
  return ulaw;
}

// One-off STT (upload WAV) using scribe_v1
async function sttOnce(wavBuffer) {
  if (!ELEVEN_API_KEY) {
    console.warn("[STT] Missing ELEVEN_API_KEY");
    return null;
  }
  const form = new FormData();
  form.append("model_id", ELEVEN_STT_MODEL);
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");

  const resp = await fetch(ELEVEN_STT_URL, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_API_KEY },
    body: form,
  });

  const txt = await resp.text();
  if (!resp.ok) {
    console.warn("[STT] HTTP", resp.status, txt);
    return null;
  }
  try {
    const j = JSON.parse(txt);
    return j.text || j.transcription || txt;
  } catch {
    return txt;
  }
}

// Send μ-law bytes as 160B frames every 20ms
async function sendUlawFrames(ws, streamSid, ulawBuf) {
  if (!ulawBuf || !ulawBuf.length || !streamSid) return;
  let frames = 0;
  for (let o = 0; o < ulawBuf.length; o += ULAW_BYTES_PER_FRAME) {
    if (ws.readyState !== ws.OPEN) break;
    let frame = ulawBuf.slice(o, Math.min(o + ULAW_BYTES_PER_FRAME, ulawBuf.length));
    if (frame.length < ULAW_BYTES_PER_FRAME) {
      const pad = Buffer.alloc(ULAW_BYTES_PER_FRAME, SILENCE_ULAW);
      frame.copy(pad);
      frame = pad;
    }
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") },
    }));
    frames++;
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS / 1000).toFixed(2)}s)`);
}

// -----------------------------------------------------------------------------
// WS connection handling
// -----------------------------------------------------------------------------
wss.on("connection", (ws, req) => {
  console.log("🔗 WebSocket connected from", req.socket?.remoteAddress);

  let streamSid = null;
  let framesSeen = 0;
  let voicedFrames = 0;
  let chunkPieces = []; // Int16Array[]
  let sttBusy = false;
  let ttsBusy = false;

  const keepAlive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 15000);

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      console.log("[WS] event:", msg);
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${streamSid}`);

      // Greeting
      ttsBusy = true;
      const greet = await ttsToUlaw8k("You are connected. Say something and I will echo it back.");
      if (greet) await sendUlawFrames(ws, streamSid, greet);
      ttsBusy = false;
      return;
    }

    if (msg.event === "media") {
      // inbound from Twilio: μ-law @8k in base64
      const ulaw = Buffer.from(msg.media.payload, "base64");
      const pcm16 = ulawToPcm16(ulaw);

      if (rms(pcm16) > ENERGY_GATE) {
        chunkPieces.push(pcm16);
        voicedFrames++;
      }
      framesSeen++;

      // Every ~1.5s, if speech was detected, send to STT
      if (framesSeen >= FRAMES_PER_CHUNK && !sttBusy) {
        framesSeen = 0;

        if (voicedFrames < 4) {
          voicedFrames = 0;
          chunkPieces = [];
          return;
        }

        sttBusy = true;
        const all = mergeInt16(chunkPieces);
        voicedFrames = 0;
        chunkPieces = [];

        const wav = pcm16ToWav(all, 8000);
        const text = await sttOnce(wav);
        sttBusy = false;

        if (text && text.trim()) {
          console.log("[STT]", text);
          if (!ttsBusy) {
            ttsBusy = true;
            const reply = await ttsToUlaw8k(`You said: ${text}`);
            if (reply) await sendUlawFrames(ws, streamSid, reply);
            ttsBusy = false;
          }
        }
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("[WS] STOP");
      return;
    }

    if (msg.event === "warning" || msg.event === "error") {
      console.warn(`[WS] ${msg.event.toUpperCase()}:`, msg);
      return;
    }

    // Fallback log
    console.log("[WS] event:", msg);
  });

  ws.on("close", (code, reason) => {
    clearInterval(keepAlive);
    console.log(`[WS] CLOSE code=${code} reason=${reason}`);
  });
  ws.on("error", (err) => console.error("[WS] ERROR", err));
});

// Merge array of Int16Array into one
function mergeInt16(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return merged;
}

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
