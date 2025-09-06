// server.js — robust TTS: handle u-law, PCM, WAV, MP3 → always stream 8k μ-law to Twilio

import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

let lamejs = null;
try {
  // optional import; we only load when needed
  lamejs = await import("lamejs");
} catch (e) {
  // fine if not present; we’ll warn only if we actually need MP3 decode
}

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
const ENABLE_BEEP = (process.env.ENABLE_BEEP || "true").toLowerCase() !== "false";

// Twilio framing: 8k μ-law, 20 ms, 160 bytes
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const ULAW_BYTES_PER_FRAME = 160;

// ---------------- Beep (PCM16) → μ-law ----------------
function makeBeepPcm16(durationMs = 250, freqHz = 1000) {
  const total = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(total * 2);
  const amp = 0.22 * 32767;
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    buf.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * freqHz * t)), i * 2);
  }
  return buf;
}

function ensureLittleEndianPCM16(raw) {
  const len = raw.length - (raw.length % 2);
  if (len <= 0) return raw;
  const sampleN = Math.min(4000, len);
  let leE = 0, beE = 0;
  for (let i = 0; i < sampleN; i += 2) {
    leE += Math.abs(raw.readInt16LE(i));
    beE += Math.abs(raw.readInt16BE(i));
  }
  if (beE > leE * 1.8) {
    const swapped = Buffer.alloc(len);
    for (let i = 0; i < len; i += 2) {
      swapped[i] = raw[i + 1];
      swapped[i + 1] = raw[i];
    }
    console.log("[PCM] swapped BE→LE");
    if (raw.length !== len) return Buffer.concat([swapped, Buffer.from([raw[len]])]);
    return swapped;
  }
  return raw;
}

// PCM16LE → μ-law (G.711)
function pcm16ToMulaw(pcm16) {
  const out = Buffer.alloc(Math.floor(pcm16.length / 2));
  for (let i = 0, o = 0; i < pcm16.length - 1; i += 2, o++) {
    let s = pcm16.readInt16LE(i);
    let sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    if (s > 0x1FFF) s = 0x1FFF;
    s += 0x84;
    let exp = 7;
    for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1) {}
    const mant = (s >> ((exp === 0) ? 4 : (exp + 3))) & 0x0F;
    out[o] = ~(sign | (exp << 4) | mant) & 0xFF;
  }
  return out;
}

// simple average downsampler 16k → 8k (telephony-ok)
function downsample16kTo8k(pcm16_16k) {
  const out = Buffer.alloc(Math.floor(pcm16_16k.length / 4) * 2);
  let oi = 0;
  for (let i = 0; i + 4 <= pcm16_16k.length; i += 4) {
    const s1 = pcm16_16k.readInt16LE(i);
    const s2 = pcm16_16k.readInt16LE(i + 2);
    const avg = (s1 + s2) >> 1;
    out.writeInt16LE(avg, oi);
    oi += 2;
  }
  return out;
}

async function streamMulawFrames(ws, streamSid, mulaw, tag = "OUT") {
  let off = 0, frames = 0;
  while (off < mulaw.length) {
    const end = Math.min(off + ULAW_BYTES_PER_FRAME, mulaw.length);
    let frame = mulaw.slice(off, end);
    if (frame.length < ULAW_BYTES_PER_FRAME) {
      const pad = Buffer.alloc(ULAW_BYTES_PER_FRAME, 0xFF);
      frame.copy(pad, 0);
      frame = pad;
    }
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") },
    }));
    frames++;
    if (frames % 100 === 0) console.log(`[${tag}] sent ${frames} frames`);
    await new Promise(r => setTimeout(r, FRAME_MS));
    off += ULAW_BYTES_PER_FRAME;
  }
  console.log(`[${tag}] done`);
}

// ---------------- WAV parser (PCM16 mono) ----------------
function parseWavToPcm16(buf) {
  // minimal RIFF/WAVE parser
  if (buf.slice(0, 4).toString("ascii") !== "RIFF" || buf.slice(8, 12).toString("ascii") !== "WAVE")
    throw new Error("Not a RIFF/WAVE file");
  let pos = 12;
  let fmt = null, dataPos = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.slice(pos, pos + 4).toString("ascii");
    const size = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(pos),
        numChannels: buf.readUInt16LE(pos + 2),
        sampleRate: buf.readUInt32LE(pos + 4),
        byteRate: buf.readUInt32LE(pos + 8),
        blockAlign: buf.readUInt16LE(pos + 12),
        bitsPerSample: buf.readUInt16LE(pos + 14),
      };
    } else if (id === "data") {
      dataPos = pos;
      dataLen = size;
    }
    pos += size;
  }
  if (!fmt || dataPos < 0) throw new Error("Invalid WAV (missing fmt/data)");
  if (fmt.audioFormat !== 1) throw new Error("WAV not PCM");
  if (fmt.numChannels !== 1) throw new Error("WAV must be mono");
  if (fmt.bitsPerSample !== 16) throw new Error("WAV must be 16-bit");
  const pcm = buf.slice(dataPos, dataPos + dataLen);
  return { pcm16: pcm, rate: fmt.sampleRate };
}

// ---------------- MP3 decode (lamejs) ----------------
function decodeMp3ToPcm16LE(mp3Buf) {
  if (!lamejs) throw new Error("MP3 decoder not available (install lamejs)");
  const { Mp3Decoder } = lamejs.default || lamejs;
  const dec = new Mp3Decoder();
  const samples = dec.decode(mp3Buf);
  // samples is Float32Array (mono) in most builds; convert to PCM16LE
  const f32 = Array.isArray(samples) ? samples[0] : samples; // ensure mono
  const pcm = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    let s = Math.max(-1, Math.min(1, f32[i]));
    pcm.writeInt16LE((s * 32767) | 0, i * 2);
  }
  return { pcm16: pcm, rate: 44100 }; // lamejs often outputs 44.1k
}

// ---------------- ElevenLabs fetchers ----------------
async function elCall(output_format, acceptHeader, text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: acceptHeader,
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      output_format,
    }),
  });
  const ct = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, statusText: res.statusText, ct, buf };
}

function magicStr(buf) {
  const m = buf.slice(0, 4).toString("ascii");
  if (m === "RIFF") return "RIFF";
  if (m.startsWith("ID3")) return "ID3";
  if (m === "OggS") return "OggS";
  return m;
}

async function elevenToMulaw(text) {
  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY not set");

  // 1) ask for μ-law directly
  {
    const { ok, ct, buf } = await elCall("ulaw_8000", "audio/basic", text);
    if (ok) {
      const magic = magicStr(buf);
      if (magic === "RIFF" || magic === "ID3" || magic === "OggS") {
        console.warn(`[TTS] μ-law request returned container (ct=${ct}, magic=${magic}).`);
      } else {
        console.log(`[TTS] Using μ-law from EL (ct=${ct})`);
        return buf;
      }
    }
  }

  // 2) try raw PCM 8k
  {
    const { ok, ct, buf, status, statusText } = await elCall("pcm_8000", "audio/pcm", text);
    if (ok) {
      const magic = magicStr(buf);
      if (magic !== "RIFF" && magic !== "ID3" && magic !== "OggS") {
        let pcm = buf;
        if (pcm.length % 2) pcm = pcm.slice(0, pcm.length - 1);
        pcm = ensureLittleEndianPCM16(pcm);
        console.log("[TTS] Got raw PCM 8k → μ-law");
        return pcm16ToMulaw(pcm);
      }
      console.warn(`[TTS] PCM request returned container (ct=${ct}, magic=${magic}).`);
    } else {
      console.warn(`[TTS] PCM request failed: ${status} ${statusText}`);
    }
  }

  // 3) ask for WAV (container) and parse
  {
    const { ok, ct, buf } = await elCall("wav", "audio/wav", text);
    if (ok && magicStr(buf) === "RIFF") {
      const { pcm16, rate } = parseWavToPcm16(buf);
      const pcm8k = rate === 8000 ? pcm16
                  : rate === 16000 ? downsample16kTo8k(pcm16)
                  : (() => { throw new Error(`WAV sampleRate ${rate} unsupported`); })();
      console.log(`[TTS] Decoded WAV (${rate} Hz) → μ-law`);
      return pcm16ToMulaw(pcm8k);
    } else {
      console.warn(`[TTS] WAV request not RIFF (ct=${ct}, magic=${magicStr(buf)})`);
    }
  }

  // 4) last resort: MP3 → decode → downsample
  {
    const { ok, ct, buf } = await elCall("mp3_64k", "audio/mpeg", text);
    if (ok && magicStr(buf).startsWith("ID3")) {
      if (!lamejs) throw new Error("MP3 decode needed but lamejs not installed");
      const { pcm16, rate } = decodeMp3ToPcm16LE(buf);
      const pcm8k =
        rate === 8000 ? pcm16 :
        rate === 16000 ? downsample16kTo8k(pcm16) :
        rate === 44100 ? downsample16kTo8k(Buffer.from([])) /* placeholder */ : // simple path covered below
        pcm16;
      // simple resample for 44.1k → 8k (nearest step); good enough for telephony short prompts
      let finalPcm = pcm8k;
      if (rate !== 8000) {
        if (rate === 44100) {
          const ratio = 44100 / 8000;
          const outLen = Math.floor(pcm16.length / 2 / ratio);
          finalPcm = Buffer.alloc(outLen * 2);
          let oi = 0;
          for (let i = 0; i < outLen; i++) {
            const si = Math.floor(i * ratio) * 2;
            if (si + 1 < pcm16.length) finalPcm.writeInt16LE(pcm16.readInt16LE(si), oi);
            oi += 2;
          }
        } else if (rate === 16000) {
          finalPcm = downsample16kTo8k(pcm16);
        }
      }
      console.log(`[TTS] Decoded MP3 (${rate} Hz) → μ-law`);
      return pcm16ToMulaw(finalPcm);
    } else {
      throw new Error(`[TTS] Unexpected last-resort MP3 response (ct=${ct}, magic=${magicStr(buf)})`);
    }
  }
}

// ---------------- WebSocket server ----------------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  const state = { streamSid: null, inbound: 0 };

  ws.on("message", async (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      state.streamSid = msg.start?.streamSid || null;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${state.streamSid} bidi=${msg.start?.bidirectional}`);

      try {
        if (ENABLE_BEEP) {
          await streamMulawFrames(ws, state.streamSid, pcm16ToMulaw(makeBeepPcm16()), "BEEP");
          console.log("[BEEP] done.");
        }
        const mulaw = await elevenToMulaw(GREETING_TEXT);
        await streamMulawFrames(ws, state.streamSid, mulaw, "TTS");
        console.log("[TTS] done.");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      state.inbound++;
      if (state.inbound % 100 === 0) console.log(`[MEDIA] frames received: ${state.inbound}`);
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${state.inbound})`);
    }
  });

  ws.on("close", () => console.log("[WS] CLOSE code=1005 reason="));
  ws.on("error", (err) => console.error("[WS] error", err));
});

// HTTP + WS upgrade
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

app.get("/", (_req, res) => res.status(200).send("OK"));
