// server.js — Twilio <-> ElevenLabs bridge with tolerant PCM/WAV handling.
// Node 18+. Set ELEVEN_API_KEY (required), ELEVEN_VOICE_ID (optional)

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
const FRAME_MS = 20;           // 20 ms
const BYTES_PER_FRAME = 160;   // μ-law @ 8kHz, 20ms
const SILENCE_ULAW = 0xFF;

// STT batching
const CHUNK_MS = 1500;
const FRAMES_PER_CHUNK = Math.round(CHUNK_MS / FRAME_MS);
const ENERGY_GATE = 300;

// ------------------ HTTP ------------------
const app = express();
app.get("/", (_req, res) => res.send("OK"));
const server = createServer(app);

// ------------------ WS SERVER ------------------
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  try { console.log("[UPGRADE] url: /stream"); } catch {}
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  console.log("🔗 WebSocket connected from", req.socket?.remoteAddress);

  let streamSid = null;
  let framesSeen = 0;
  let voicedFrames = 0;
  let chunkPieces = []; // Int16Array[]
  let sttBusy = false;
  let ttsBusy = false;

  const keepAlive = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 15000);

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${streamSid}`);

      // Greeting (fix: tolerant PCM/WAV)
      ttsBusy = true;
      const greet = await ttsToUlaw8k("You are connected. Say something and I will echo it back.");
      if (greet) await sendUlawFrames(ws, streamSid, greet);
      ttsBusy = false;
      return;
    }

    if (msg.event === "media") {
      const ulaw = Buffer.from(msg.media.payload, "base64");
      const pcm16 = ulawToPcm16(ulaw); // inbound -> PCM

      if (rms(pcm16) > ENERGY_GATE) {
        chunkPieces.push(pcm16);
        voicedFrames++;
      }
      framesSeen++;

      if (framesSeen >= FRAMES_PER_CHUNK && !sttBusy) {
        framesSeen = 0;
        if (voicedFrames < 4) { voicedFrames = 0; chunkPieces = []; return; }

        sttBusy = true;
        const wav = pcm16ChunksToWav(chunkPieces, 8000);
        voicedFrames = 0;
        chunkPieces = [];

        const text = await sttOnce(wav);
        sttBusy = false;

        if (text) {
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

    if (msg.event === "stop") { console.log("[WS] STOP"); return; }

    if (msg.event === "warning" || msg.event === "error") {
      console.warn(`[WS] ${msg.event.toUpperCase()}:`, msg);
      return;
    }

    console.log("[WS] event:", msg);
  });

  ws.on("close", (code, reason) => {
    clearInterval(keepAlive);
    console.log(`[WS] CLOSE code=${code} reason=${reason}`);
  });
  ws.on("error", (err) => console.error("[WS] ERROR", err));
});

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ------------------ AUDIO HELPERS ------------------
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
function linearToUlaw(sample) {
  const MU_MAX = 0x1FFF;
  let s = Math.max(-32768, Math.min(32767, sample));
  const sign = (s < 0) ? 0x80 : 0x00;
  if (s < 0) s = -s;
  s = Math.min(MU_MAX, s + 0x84);
  const exponent = Math.floor(Math.log2(s)) - 6;
  const mantissa = exponent < 0 ? (s >> 1) & 0x0F : (s >> (exponent + 3)) & 0x0F;
  return ~(sign | ((exponent & 0x07) << 4) | mantissa) & 0xFF;
}
function pcm16ToUlaw(pcm16) {
  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = linearToUlaw(pcm16[i]);
  return out;
}
function rms(int16) {
  let s = 0; for (let i = 0; i < int16.length; i++) s += int16[i] * int16[i];
  return Math.sqrt(s / (int16.length || 1));
}
function pcm16ChunksToWav(chunks, sr = 8000) {
  let total = 0; for (const c of chunks) total += c.length;
  const merged = new Int16Array(total);
  let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }

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

  for (let i = 0; i < merged.length; i++) buf.writeInt16LE(merged[i], 44 + i*2);
  return buf;
}

// WAV parser (PCM 16-bit, mono, 8k). Returns Int16Array
function parsePcmWav(buffer) {
  if (buffer.length < 12) throw new Error("Not a WAV file");
  if (buffer.slice(0,4).toString() !== "RIFF" || buffer.slice(8,12).toString() !== "WAVE")
    throw new Error("Not a WAV file");
  let pos = 12;
  let fmt = null, dataPos = null, dataSize = null;
  while (pos + 8 <= buffer.length) {
    const id = buffer.slice(pos, pos+4).toString();
    const size = buffer.readUInt32LE(pos+4);
    const next = pos + 8 + size;
    if (id === "fmt ") fmt = { pos: pos+8, size };
    else if (id === "data") { dataPos = pos+8; dataSize = size; }
    pos = next;
  }
  if (!fmt || dataPos == null) throw new Error("Malformed WAV");
  const audioFormat = buffer.readUInt16LE(fmt.pos);
  const numChannels = buffer.readUInt16LE(fmt.pos + 2);
  const sampleRate = buffer.readUInt32LE(fmt.pos + 4);
  const bitsPerSample = buffer.readUInt16LE(fmt.pos + 14);
  if (audioFormat !== 1) throw new Error(`WAV not PCM (fmt=${audioFormat})`);
  if (numChannels !== 1) throw new Error(`WAV not mono (ch=${numChannels})`);
  if (sampleRate !== 8000) throw new Error(`WAV not 8000 Hz (sr=${sampleRate})`);
  if (bitsPerSample !== 16) throw new Error(`WAV not 16-bit (bps=${bitsPerSample})`);

  const samples = new Int16Array(dataSize / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(dataPos + i*2);
  return samples;
}

// Fallback: raw PCM 16-bit LE → Int16Array
function rawPcm16LEToInt16(buffer) {
  if (buffer.length % 2 !== 0) throw new Error("Raw PCM length not even");
  const n = buffer.length / 2;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buffer.readInt16LE(i*2);
  return out;
}

// ------------------ ELEVENLABS ------------------

// TOLERANT: ask for PCM 8k, accept WAV **or** raw PCM 16LE and encode to μ-law
async function ttsToUlaw8k(text) {
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
      output_format: "pcm_8000"   // request PCM 8kHz
    })
  });

  const arr = await resp.arrayBuffer();
  const buf = Buffer.from(arr);

  if (!resp.ok) {
    console.warn("[TTS] HTTP", resp.status, buf.toString());
    return null;
  }

  let pcm16;
  try {
    // Try WAV first
    pcm16 = parsePcmWav(buf);
  } catch {
    // Not a WAV — try raw PCM 16LE
    try {
      pcm16 = rawPcm16LEToInt16(buf);
    } catch (e2) {
      console.warn("[TTS] parse failed (neither WAV nor raw PCM):", e2.message);
      return null;
    }
  }

  const ulaw = pcm16ToUlaw(pcm16);
  return ulaw;
}

// STT once (upload small WAV) using scribe_v1
async function sttOnce(wavBuffer) {
  if (!ELEVEN_API_KEY) { console.warn("[STT] Missing ELEVEN_API_KEY"); return null; }
  const form = new FormData();
  form.append("model_id", ELEVEN_STT_MODEL);
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");

  const resp = await fetch(ELEVEN_STT_URL, { method: "POST", headers: { "xi-api-key": ELEVEN_API_KEY }, body: form });
  const txt = await resp.text();
  if (!resp.ok) { console.warn("[STT] HTTP", resp.status, txt); return null; }
  try { const j = JSON.parse(txt); return j.text || j.transcription || txt; } catch { return txt; }
}

// Send μ-law bytes as 160-byte frames every 20 ms
async function sendUlawFrames(ws, streamSid, ulawBuf) {
  if (!ulawBuf || !ulawBuf.length || !streamSid) return;

  let frames = 0;
  for (let o = 0; o < ulawBuf.length; o += BYTES_PER_FRAME) {
    if (ws.readyState !== ws.OPEN) break;

    let frame = ulawBuf.slice(o, Math.min(o + BYTES_PER_FRAME, ulawBuf.length));
    if (frame.length < BYTES_PER_FRAME) {
      const pad = Buffer.alloc(BYTES_PER_FRAME, SILENCE_ULAW);
      frame.copy(pad); frame = pad;
    }

    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") }
    }));

    frames++;
    await new Promise(r => setTimeout(r, FRAME_MS));
  }
  console.log(`[TTS] sent ${frames} frames (~${(frames*FRAME_MS/1000).toFixed(2)}s)`);
}
