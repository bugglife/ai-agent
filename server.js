// server.js — Twilio <-> ElevenLabs with correct tracks & μ-law framing
// Node 18+ recommended. Requires ELEVEN_API_KEY in env.

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ------------------ CONFIG ------------------
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
const ELEVEN_TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
const ELEVEN_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVEN_STT_MODEL = "scribe_v1";

// Twilio media framing
const FRAME_MS = 20;             // 20 ms per Twilio frame
const BYTES_PER_FRAME = 160;     // 20 ms @ 8 kHz μ-law = 160 bytes
const SILENCE_ULAW = 0xFF;       // μ-law silence

// Simple STT chunking params
const CHUNK_MS = 1500;                            // batch STT roughly every 1.5s
const FRAMES_PER_CHUNK = Math.round(CHUNK_MS / FRAME_MS);
const ENERGY_GATE = 300;                          // basic energy threshold

// ------------------ HTTP ------------------
const app = express();
app.get("/", (_req, res) => res.send("OK"));

const server = createServer(app);

// ------------------ WS SERVER ------------------
const wss = new WebSocketServer({ noServer: true });

// Accept upgrade on any path (log it so we can see what Twilio used)
server.on("upgrade", (req, socket, head) => {
  try { console.log("[UPGRADE] url:", req.url); } catch (_) {}
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  console.log("🔗 WebSocket connected from", req.socket?.remoteAddress);

  let streamSid = null;

  // STT batching state
  let framesSeen = 0;
  let voicedFrames = 0;
  let chunkPieces = []; // Int16Array list
  let sttBusy = false;
  let ttsBusy = false;

  const keepAlive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 15000);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Log anything unknown so we can spot Twilio warnings/errors
    const type = msg.event;

    if (type === "start") {
      streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${streamSid}`);

      // Immediate TTS greeting over the stream to validate outbound audio
      if (!ttsBusy) {
        ttsBusy = true;
        const greet = await ttsUlaw8k("You are connected. Say something and I will echo it back.");
        if (greet) await sendUlawFrames(ws, streamSid, greet);
        ttsBusy = false;
      }
      return;
    }

    if (type === "media") {
      // inbound μ-law bytes from Twilio (20 ms)
      const ulaw = Buffer.from(msg.media.payload, "base64");
      const pcm16 = ulawToPcm16(ulaw);

      // simple energy gate
      if (rms(pcm16) > ENERGY_GATE) {
        chunkPieces.push(pcm16);
        voicedFrames++;
      }
      framesSeen++;

      // Optional: acknowledge back (not required)
      // ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `ack_${msg.media.sequenceNumber}` }}));

      // Time to run STT?
      if (framesSeen >= FRAMES_PER_CHUNK && !sttBusy) {
        framesSeen = 0;

        if (voicedFrames < 4) { // roughly 80 ms voiced
          voicedFrames = 0;
          chunkPieces = [];
          return;
        }

        sttBusy = true;
        const wav = pcm16ChunksToWav(chunkPieces, 8000);
        voicedFrames = 0;
        chunkPieces = [];

        const text = await sttOnce(wav);
        sttBusy = false;

        if (text && !ttsBusy) {
          console.log("[STT]", text);
          ttsBusy = true;
          const reply = await ttsUlaw8k(`You said: ${text}`);
          if (reply) await sendUlawFrames(ws, streamSid, reply);
          ttsBusy = false;
        }
      }
      return;
    }

    if (type === "stop") {
      console.log("[WS] STOP");
      return;
    }

    // Twilio may send warnings/errors as events
    if (type === "warning" || type === "error") {
      console.warn(`[WS] ${type.toUpperCase()}:`, msg);
      return;
    }

    // Catch-all
    console.log("[WS] event:", msg);
  });

  ws.on("close", (code, reason) => {
    clearInterval(keepAlive);
    console.log(`[WS] CLOSE code=${code} reason=${reason}`);
  });

  ws.on("error", (err) => console.error("[WS] ERROR", err));
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ------------------ AUDIO HELPERS ------------------

// μ-law byte -> PCM16 (approx)
function ulawByteToLinear(u) {
  u = ~u & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
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

function rms(int16) {
  let s = 0;
  for (let i = 0; i < int16.length; i++) s += int16[i] * int16[i];
  return Math.sqrt(s / (int16.length || 1));
}

// Merge Int16 chunks -> mono 8kHz WAV
function pcm16ChunksToWav(chunks, sr = 8000) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Int16Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }

  const numChannels = 1;
  const byteRate = sr * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = merged.length * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < merged.length; i++) {
    buf.writeInt16LE(merged[i], 44 + i * 2);
  }
  return buf;
}

// If ElevenLabs responds with WAV container for μ-law, extract 'data' bytes
function extractWavDataIfNeeded(buf) {
  if (buf.length >= 12 &&
      buf.slice(0, 4).toString() === "RIFF" &&
      buf.slice(8, 12).toString() === "WAVE") {
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.slice(pos, pos + 4).toString();
      const size = buf.readUInt32LE(pos + 4);
      const next = pos + 8 + size;
      if (id === "data") return buf.slice(pos + 8, pos + 8 + size);
      pos = next;
    }
  }
  return buf; // raw already
}

// ------------------ ELEVENLABS ------------------

// TTS -> μ-law 8kHz (raw bytes)
async function ttsUlaw8k(text) {
  if (!ELEVEN_API_KEY) { console.warn("[TTS] Missing ELEVEN_API_KEY"); return null; }

  const resp = await fetch(ELEVEN_TTS_URL, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/octet-stream"
    },
    body: JSON.stringify({
      text,
      output_format: "ulaw_8000"
    })
  });

  const arr = await resp.arrayBuffer();
  if (!resp.ok) {
    console.warn("[TTS] HTTP", resp.status, Buffer.from(arr).toString());
    return null;
  }
  return extractWavDataIfNeeded(Buffer.from(arr));
}

// STT once (upload a small WAV) using scribe_v1
async function sttOnce(wavBuffer) {
  if (!ELEVEN_API_KEY) { console.warn("[STT] Missing ELEVEN_API_KEY"); return null; }

  // Using global FormData/Blob available in Node 18 via undici
  const form = new FormData();
  form.append("model_id", ELEVEN_STT_MODEL);
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");

  const resp = await fetch(ELEVEN_STT_URL, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_API_KEY },
    body: form
  });

  const txt = await resp.text();
  if (!resp.ok) { console.warn("[STT] HTTP", resp.status, txt); return null; }

  try { const j = JSON.parse(txt); return j.text || j.transcription || txt; }
  catch { return txt; }
}

// Send μ-law bytes as 160-byte frames every 20 ms, with track="outbound"
async function sendUlawFrames(ws, streamSid, ulawBuf) {
  if (!ulawBuf || !ulawBuf.length || !streamSid) return;
  for (let o = 0; o < ulawBuf.length; o += BYTES_PER_FRAME) {
    if (ws.readyState !== ws.OPEN) break;

    let frame = ulawBuf.slice(o, Math.min(o + BYTES_PER_FRAME, ulawBuf.length));
    if (frame.length < BYTES_PER_FRAME) {
      const pad = Buffer.alloc(BYTES_PER_FRAME, SILENCE_ULAW);
      frame.copy(pad);
      frame = pad;
    }

    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64"), track: "outbound" }
    }));

    await new Promise(r => setTimeout(r, FRAME_MS));
  }
}
