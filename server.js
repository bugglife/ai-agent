// server.js — Twilio <Stream> outbound fixed to μ-law/8k (no more static)
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// ===== Config =====
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
const ENABLE_BEEP = (process.env.ENABLE_BEEP || "true").toLowerCase() !== "false";

// Twilio media cadence (ALWAYS 8k/20ms for Streams)
const SAMPLE_RATE = 8000;         // 8 kHz
const FRAME_MS = 20;              // 20 ms
const BYTES_PER_ULAW_FRAME = 160; // 8-bit μ-law * 160 samples

// ===== Utils =====

// Generate a 1 kHz beep as PCM16-LE @ 8k (we’ll convert to μ-law before send)
function makeBeepPcm16(durationMs = 500, freqHz = 1000) {
  const totalSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const out = Buffer.alloc(totalSamples * 2);
  const amp = 0.2 * 32767;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    out.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * freqHz * t)), i * 2);
  }
  return out;
}

// Heuristic: if raw PCM looks big-endian, swap to little-endian
function ensureLittleEndianPCM16(raw) {
  const len = raw.length - (raw.length % 2);
  if (len <= 0) return raw;
  const N = Math.min(4000, len);
  let leE = 0, beE = 0;
  for (let i = 0; i < N; i += 2) {
    leE += Math.abs(raw.readInt16LE(i));
    beE += Math.abs(raw.readInt16BE(i));
  }
  if (beE > leE * 1.8) {
    const swapped = Buffer.alloc(len);
    for (let i = 0; i < len; i += 2) {
      swapped[i] = raw[i + 1];
      swapped[i + 1] = raw[i];
    }
    if (raw.length !== len) return Buffer.concat([swapped, Buffer.from([raw[len]])]);
    console.log("[TTS] PCM looked big-endian; swapped → LE.");
    return swapped;
  }
  console.log("[TTS] PCM looked little-endian; using as-is.");
  return raw;
}

// G.711 μ-law encoder (PCM16-LE → μ-law 8-bit)
function pcm16ToMulaw(pcm16) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 0x84;
  const out = Buffer.alloc(Math.floor(pcm16.length / 2));
  for (let i = 0, o = 0; i < pcm16.length - 1; i += 2, o++) {
    let sample = pcm16.readInt16LE(i);

    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
    let ulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;

    out[o] = ulaw;
  }
  return out;
}

// Chunk μ-law into 20 ms frames and send with streamSid
async function streamMulawToTwilio(ws, streamSid, mulaw, tag = "ULAW") {
  let off = 0, frames = 0;
  while (off < mulaw.length) {
    const end = Math.min(off + BYTES_PER_ULAW_FRAME, mulaw.length);
    let frame = mulaw.slice(off, end);
    if (frame.length < BYTES_PER_ULAW_FRAME) {
      const pad = Buffer.alloc(BYTES_PER_ULAW_FRAME, 0xFF /* silence in μ-law */);
      frame.copy(pad, 0);
      frame = pad;
    }
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") }, // 160-byte μ-law frame
    }));
    frames++;
    if (frames % 100 === 0) console.log(`[${tag}] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    await new Promise(r => setTimeout(r, FRAME_MS));
    off += BYTES_PER_ULAW_FRAME;
  }
  console.log(`[${tag}] done.`);
}

// ===== TTS (ElevenLabs → PCM16-LE @ 8k → μ-law) =====
async function ttsElevenLabsToMulaw(text) {
  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY not set");

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/pcm", // raw PCM
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      // Ask for 8k PCM from Eleven; if their account ignores this, we still handle it.
      output_format: "pcm_8000",
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${t}`);
  }

  let pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length % 2 !== 0) console.warn(`[WARN] TTS PCM length ${pcm.length} odd; tail byte may be ignored.`);

  pcm = ensureLittleEndianPCM16(pcm);
  const mulaw = pcm16ToMulaw(pcm);
  return mulaw;
}

// ===== WebSocket server for Twilio Stream =====
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
          const beepPcm = makeBeepPcm16(500, 1000);
          await streamMulawToTwilio(ws, state.streamSid, pcm16ToMulaw(beepPcm), "BEEP");
          console.log("[BEEP] done.");
        }

        const ttsMulaw = await ttsElevenLabsToMulaw(GREETING_TEXT);
        await streamMulawToTwilio(ws, state.streamSid, ttsMulaw, "TTS");
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
