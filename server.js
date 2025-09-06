// server.js — Fix TTS static by forcing ElevenLabs μ-law @ 8k (fallback to PCM)
// Outbound to Twilio is always 8 kHz μ-law, 160 bytes / 20 ms.

import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// ─────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
const ENABLE_BEEP = (process.env.ENABLE_BEEP || "true").toLowerCase() !== "false";

// Twilio cadence
const SAMPLE_RATE = 8000;               // 8 kHz
const FRAME_MS = 20;                    // 20 ms
const ULAW_BYTES_PER_FRAME = 160;       // 160 samples (8-bit μ-law)

// ─────────────────────────────────────────────────────
// Tone (beep) generator (PCM16-LE → we convert to μ-law)
// ─────────────────────────────────────────────────────
function makeBeepPcm16(durationMs = 300, freqHz = 1000) {
  const totalSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const out = Buffer.alloc(totalSamples * 2);
  const amp = 0.2 * 32767;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    out.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * freqHz * t)), i * 2);
  }
  return out;
}

// ─────────────────────────────────────────────────────
// Endianness normalizer for PCM16
// ─────────────────────────────────────────────────────
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
    console.log("[TTS] PCM looked big-endian; swapped → LE.");
    if (raw.length !== len) return Buffer.concat([swapped, Buffer.from([raw[len]])]);
    return swapped;
  }
  console.log("[TTS] PCM looked little-endian; using as-is.");
  return raw;
}

// ─────────────────────────────────────────────────────
// PCM16-LE → μ-law (G.711 PCMU)
// ─────────────────────────────────────────────────────
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
    const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
    out[o] = ulaw;
  }
  return out;
}

// ─────────────────────────────────────────────────────
async function streamMulawFrames(ws, streamSid, mulaw, tag = "OUT") {
  let off = 0, frames = 0;
  while (off < mulaw.length) {
    const end = Math.min(off + ULAW_BYTES_PER_FRAME, mulaw.length);
    let frame = mulaw.slice(off, end);
    if (frame.length < ULAW_BYTES_PER_FRAME) {
      const pad = Buffer.alloc(ULAW_BYTES_PER_FRAME, 0xFF); // μ-law silence
      frame.copy(pad, 0);
      frame = pad;
    }
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") },
    }));
    frames++;
    if (frames % 100 === 0) console.log(`[${tag}] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    await new Promise(r => setTimeout(r, FRAME_MS));
    off += ULAW_BYTES_PER_FRAME;
  }
  console.log(`[${tag}] done.`);
}

// ─────────────────────────────────────────────────────
// ElevenLabs TTS with strict format handling:
// 1) Try output_format: "ulaw_8000" (ideal → stream directly)
// 2) Fallback to "pcm_8000" → convert to μ-law
// Reject MP3/OGG/WAV by sniffing headers.
// ─────────────────────────────────────────────────────
async function elevenToMulaw(text) {
  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY not set");

  const baseUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

  // Helper to call EL once
  async function callEL(output_format, acceptHeader) {
    const res = await fetch(baseUrl, {
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

  // 1) Ask for μ-law directly
  {
    const { ok, status, statusText, ct, buf } = await callEL("ulaw_8000", "audio/basic");
    if (ok) {
      // Guard against compressed/container formats by magic bytes
      const magic = buf.slice(0, 4).toString("ascii");
      if (magic === "RIFF" || magic.startsWith("ID3") || magic === "OggS") {
        console.warn(`[TTS] Unexpected container in μ-law request (ct=${ct}, magic=${magic}).`);
      } else {
        console.log(`[TTS] Using μ-law from ElevenLabs (ct=${ct || "unknown"}).`);
        return buf; // already μ-law @ 8k
      }
    } else {
      console.warn(`[TTS] μ-law request failed: ${status} ${statusText}`);
    }
  }

  // 2) Fallback to PCM → convert
  {
    const { ok, status, statusText, ct, buf } = await callEL("pcm_8000", "audio/pcm");
    if (!ok) {
      const extra = buf.toString("utf8").slice(0, 200);
      throw new Error(`[TTS] PCM request failed: ${status} ${statusText} ${extra}`);
    }
    const magic = buf.slice(0, 4).toString("ascii");
    if (magic === "RIFF" || magic.startsWith("ID3") || magic === "OggS") {
      throw new Error(`[TTS] Got container/compressed audio (ct=${ct}, magic=${magic}); not raw PCM.`);
    }
    let pcm = buf;
    if (pcm.length % 2 !== 0) {
      console.warn(`[WARN] PCM length ${pcm.length} is odd; tail byte ignored.`);
      pcm = pcm.slice(0, pcm.length - 1);
    }
    pcm = ensureLittleEndianPCM16(pcm);
    const mulaw = pcm16ToMulaw(pcm);
    console.log("[TTS] Converted PCM→μ-law.");
    return mulaw;
  }
}

// ─────────────────────────────────────────────────────
// WS server
// ─────────────────────────────────────────────────────
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
          const beepPcm = makeBeepPcm16(250, 1000);
          await streamMulawFrames(ws, state.streamSid, pcm16ToMulaw(beepPcm), "BEEP");
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
