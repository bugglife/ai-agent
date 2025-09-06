// server.js — Twilio Streams (bidirectional) with proper μ-law (PCMU) outbound audio.
// Outbound format: μ-law (8-bit), mono, 8000 Hz, 20 ms frames (160 bytes).

import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// ── ENV ────────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

// ── AUDIO CONSTANTS ───────────────────────────────────────────────────────────
const SR = 8000;                 // samples/sec
const PCM_BYTES_PER_SAMPLE = 2;  // int16 LE
const FRAME_MS = 20;             // 20 ms
const SAMPLES_PER_FRAME = (SR / 1000) * FRAME_MS; // 160
const OUT_BYTES_PER_FRAME = 160; // μ-law: 1 byte/sample * 160 samples

// ── μ-LAW ENCODER (PCM16 LE -> μ-law byte) ───────────────────────────────────
const BIAS = 0x84;
const CLIP = 32635;
function linear16ToMulawSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let mulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mulaw;
}

/** Convert a PCM16 LE buffer (8 kHz, mono) to μ-law buffer */
function pcm16ToMulawBuffer(pcmBuf) {
  const samples = pcmBuf.length / 2;
  const out = Buffer.allocUnsafe(samples);
  for (let i = 0; i < samples; i++) {
    const s = pcmBuf.readInt16LE(i * 2);
    out[i] = linear16ToMulawSample(s);
  }
  return out;
}

// ── Beep & Silence (generate PCM then convert to μ-law) ───────────────────────
function makeBeepMulaw(durationMs = 200, freq = 1000, gain = 0.3) {
  const totalSamples = Math.floor((SR * durationMs) / 1000);
  const pcm = Buffer.alloc(totalSamples * PCM_BYTES_PER_SAMPLE);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SR;
    const v = Math.sin(2 * Math.PI * freq * t) * gain;
    pcm.writeInt16LE(Math.floor(v * 0x7fff), i * 2);
  }
  return pcm16ToMulawBuffer(pcm);
}

function makeSilenceMulaw(durationMs = 200) {
  const bytes = Math.floor((SR * durationMs) / 1000); // 1 byte/sample in μ-law
  return Buffer.alloc(bytes, 0xFF); // μ-law "silence"
}

// ── ElevenLabs: ask for 8 kHz PCM16, then convert to μ-law ───────────────────
async function elevenLabsPcm(text) {
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
    const err = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${err}`);
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length % 2 !== 0) {
    console.warn(`[TTS] PCM length ${pcm.length} not sample-aligned; tail byte may be ignored`);
  }
  return pcm;
}

// ── Stream μ-law to Twilio in 20 ms frames (160 bytes) ───────────────────────
async function streamMulaw(ws, mulawBuf, label = "OUT") {
  if (!ws._streamSid) {
    console.warn(`[${label}] Missing streamSid; Twilio will drop outbound audio`);
  }
  let offset = 0, frames = 0;
  while (offset < mulawBuf.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + OUT_BYTES_PER_FRAME, mulawBuf.length);
    let chunk = mulawBuf.slice(offset, end);
    if (chunk.length < OUT_BYTES_PER_FRAME) {
      // pad last frame with μ-law silence
      chunk = Buffer.concat([chunk, Buffer.alloc(OUT_BYTES_PER_FRAME - chunk.length, 0xFF)]);
    }
    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws._streamSid,              // <- CRUCIAL
      media: { payload: chunk.toString("base64") },
    }));
    frames++;
    if (frames % 100 === 0) console.log(`[${label}] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    await new Promise(r => setTimeout(r, FRAME_MS));
    offset += OUT_BYTES_PER_FRAME;
  }
  console.log(`[${label}] done.`);
}

/** Send short μ-law silence as keepalive (200 ms) */
function sendKeepalive(ws) {
  if (!ws._streamSid || ws.readyState !== ws.OPEN) return;
  const silent = makeSilenceMulaw(200);
  let offset = 0;
  while (offset < silent.length) {
    const chunk = silent.slice(offset, offset + OUT_BYTES_PER_FRAME);
    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws._streamSid,
      media: { payload: chunk.toString("base64") },
    }));
    offset += OUT_BYTES_PER_FRAME;
  }
  console.log("[KEEPALIVE] sent 200ms silence");
}

// ── WS server ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  let keepalive;

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
      return;
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      // 1) short beep (μ-law)
      try {
        const beep = makeBeepMulaw(200);
        await streamMulaw(ws, beep, "BEEP");
      } catch (e) {
        console.error("[BEEP] failed:", e);
      }

      // 2) ElevenLabs greeting (PCM->μ-law), or fallback beep
      try {
        if (ELEVEN_API_KEY) {
          const pcm = await elevenLabsPcm("Hi! I'm your AI receptionist. How can I help you today?");
          const mulaw = pcm16ToMulawBuffer(pcm);
          console.log("[TTS] streaming greeting…");
          await streamMulaw(ws, mulaw, "TTS");
        } else {
          console.log("[TTS] ELEVEN_API_KEY missing; sending fallback beep.");
          await streamMulaw(ws, makeBeepMulaw(300), "TTS-Fallback");
        }
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }

      // keepalive every 4s
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

  ws.on("close", () => {
    if (keepalive) clearInterval(keepalive);
    console.log("[WS] CLOSE code=1005 reason=");
  });

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
