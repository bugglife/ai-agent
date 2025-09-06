import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegPathPkg from "@ffmpeg-installer/ffmpeg";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

// Audio constants
const SR = 8000;                 // 8 kHz
const FRAME_MS = 20;             // 20 ms pacing for Twilio
const ULawBytesPerFrame = 160;   // μ-law @ 8kHz, 20ms => 160 bytes
const PCM_BYTES_PER_SAMPLE = 2;  // 16-bit LE

// -------- μ-law encoder (G.711) ----------
const BIAS = 0x84;
const CLIP = 32635;
function linear16ToMulawSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;

  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

function pcm16ToMulawBuffer(pcmBuf) {
  const samples = Math.floor(pcmBuf.length / 2);
  const out = Buffer.allocUnsafe(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = linear16ToMulawSample(pcmBuf.readInt16LE(i * 2));
  }
  return out;
}

// -------- Test tone & silence (μ-law) ----------
function makeBeepMulaw(ms = 200, freq = 1000, gain = 0.3) {
  const total = Math.floor((SR * ms) / 1000);
  const pcm = Buffer.alloc(total * PCM_BYTES_PER_SAMPLE);
  for (let i = 0; i < total; i++) {
    const v = Math.sin(2 * Math.PI * freq * (i / SR)) * gain;
    pcm.writeInt16LE(Math.floor(v * 0x7fff), i * 2);
  }
  return pcm16ToMulawBuffer(pcm);
}
function makeSilenceMulaw(ms = 200) {
  const bytes = Math.floor((SR * ms) / 1000);
  return Buffer.alloc(bytes, 0xFF);
}

// -------- Format sniffers ----------
function isRIFF(buf)   { return buf.length >= 12 && buf.toString("ascii",0,4)==="RIFF" && buf.toString("ascii",8,12)==="WAVE"; }
function isID3(buf)    { return buf.length >= 3  && buf.toString("ascii",0,3)==="ID3"; }
function isMP3Sync(buf){ return buf.length >= 2  && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0; }

// Minimal WAV extraction
function extractWavPcm(buf) {
  let off = 12;
  let fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id   = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const bodyStart = off + 8;
    const bodyEnd   = bodyStart + size;
    if (bodyEnd > buf.length) break;

    if (id === "fmt ") {
      fmt = {
        audioFormat:   buf.readUInt16LE(bodyStart + 0),
        numChannels:   buf.readUInt16LE(bodyStart + 2),
        sampleRate:    buf.readUInt32LE(bodyStart + 4),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14),
      };
    } else if (id === "data") {
      data = buf.slice(bodyStart, bodyEnd);
      break;
    }
    off = bodyEnd + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt or data");
  if (fmt.audioFormat !== 1) throw new Error(`WAV not PCM (format=${fmt.audioFormat})`);
  if (fmt.numChannels !== 1) throw new Error(`WAV not mono (ch=${fmt.numChannels})`);
  if (fmt.bitsPerSample !== 16) throw new Error(`WAV not 16-bit (bps=${fmt.bitsPerSample})`);
  if (fmt.sampleRate !== SR) console.warn(`[WAV] sampleRate=${fmt.sampleRate} (expected ${SR})`);
  return data;
}

// -------- MP3 → PCM via ffmpeg ----------
const ffmpegPath = ffmpegPathPkg?.path || ffmpegPathPkg;
function mp3ToPcm16le8kMono(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "mp3", "-i", "pipe:0",
      "-ac", "1", "-ar", String(SR),
      "-f", "s16le", "pipe:1",
    ];
    const ff = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });

    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (e) => { /* quiet; log if needed */ });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(new Error(`ffmpeg exit ${code}`));
    });

    ff.stdin.write(mp3Buffer);
    ff.stdin.end();
  });
}

// -------- ElevenLabs robust fetch ----------
async function elevenLabsPcm(text) {
  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY not set");

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/pcm",            // ask for PCM but be defensive
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      output_format: "pcm_8000"
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${err}`);
  }

  let buf = Buffer.from(await res.arrayBuffer());

  if (isRIFF(buf)) {
    console.log("[TTS] Received WAV container. Extracting PCM…");
    buf = extractWavPcm(buf);
  } else if (isID3(buf) || isMP3Sync(buf)) {
    console.log("[TTS] Received MP3 container. Transcoding to PCM with ffmpeg…");
    buf = await mp3ToPcm16le8kMono(buf);
  } else {
    // assume raw PCM
  }

  if (buf.length % 2 !== 0) {
    console.warn(`[TTS] PCM length ${buf.length} not sample-aligned; trimming 1 tail byte`);
    buf = buf.slice(0, buf.length - 1);
  }

  return buf; // 16-bit LE, mono, 8k
}

// -------- Twilio media sender (μ-law 20ms) ----------
async function streamMulaw(ws, mulawBuf, label = "OUT") {
  let off = 0, frames = 0;
  while (off < mulawBuf.length && ws.readyState === ws.OPEN) {
    const end = Math.min(off + ULawBytesPerFrame, mulawBuf.length);
    let chunk = mulawBuf.slice(off, end);
    if (chunk.length < ULawBytesPerFrame) {
      chunk = Buffer.concat([chunk, Buffer.alloc(ULawBytesPerFrame - chunk.length, 0xFF)]);
    }
    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws._streamSid,
      media: { payload: chunk.toString("base64") },
    }));
    frames++;
    if (frames % 100 === 0) console.log(`[${label}] sent ${frames} frames (~${(frames * FRAME_MS)/1000}s)`);
    await new Promise(r => setTimeout(r, FRAME_MS));
    off += ULawBytesPerFrame;
  }
  console.log(`[${label}] done.`);
}

function sendKeepalive(ws) {
  if (!ws._streamSid || ws.readyState !== ws.OPEN) return;
  const silent = makeSilenceMulaw(200);
  for (let o = 0; o < silent.length; o += ULawBytesPerFrame) {
    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws._streamSid,
      media: { payload: silent.slice(o, o + ULawBytesPerFrame).toString("base64") },
    }));
  }
  console.log("[KEEPALIVE] sent 200ms silence");
}

// -------- WebSocket server for Twilio Streams ----------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  let keepalive;

  ws.on("message", async (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
      return;
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      try {
        // Confirmation beep (μ-law)
        const beep = makeBeepMulaw(200);
        await streamMulaw(ws, beep, "BEEP");

        // TTS (handles WAV/MP3/raw) -> μ-law -> stream
        const pcm  = await elevenLabsPcm("Hi! I'm your AI receptionist. How can I help you today?");
        const ulaw = pcm16ToMulawBuffer(pcm);
        console.log("[TTS] streaming greeting…");
        await streamMulaw(ws, ulaw, "TTS");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }

      if (keepalive) clearInterval(keepalive);
      keepalive = setInterval(() => sendKeepalive(ws), 4000);
      return;
    }

    if (msg.event === "media") {
      ws._rx = (ws._rx || 0) + 1;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
      return;
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
      return;
    }
  });

  ws.on("close", () => console.log("[WS] CLOSE code=1005 reason="));
  ws.on("error", (err) => console.error("[WS] error", err));
});

// HTTP + upgrade
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// Healthcheck
app.get("/", (_req, res) => res.status(200).send("OK"));
