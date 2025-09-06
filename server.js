// server.js
// Minimal Twilio <Connect><Stream> bridge that plays a beep + greeting.
// FIXED: every outbound "media" frame now includes the Twilio streamSid.
// Audio format: 16-bit PCM, little-endian, mono, 8000 Hz, 20 ms frames (320 bytes).

import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// ───────────────────────────────────────────────────────────────────────────────
// Config / Env
// ───────────────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // default "Bella"

// Twilio media framing constants
const SAMPLE_RATE = 8000;           // 8 kHz
const BYTES_PER_SAMPLE = 2;         // 16-bit PCM (LE)
const FRAME_MS = 20;                // 20 ms per frame
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// ───────────────────────────────────────────────────────────────────────────────
// Helpers: Beep, Silence, TTS(11labs), and framed streaming to Twilio
// ───────────────────────────────────────────────────────────────────────────────

/** Generate a simple 1 kHz beep (durationMs) as 16-bit PCM LE @ 8 kHz */
function makeBeepPcm(durationMs = 500, freq = 1000, gain = 0.3) {
  const totalSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(totalSamples * BYTES_PER_SAMPLE);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const sample = Math.max(-1, Math.min(1, Math.sin(2 * Math.PI * freq * t))) * gain;
    buf.writeInt16LE(Math.floor(sample * 0x7fff), i * 2);
  }
  return buf;
}

/** Make n ms of silence */
function makeSilencePcm(durationMs = 200) {
  const totalSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  return Buffer.alloc(totalSamples * BYTES_PER_SAMPLE);
}

/** Stream a PCM buffer to Twilio as 20 ms frames, tagging streamSid */
async function streamPcmToTwilio(ws, pcmBuffer, label = "TTS/PCM") {
  if (!ws._streamSid) {
    console.warn(`[${label}] No streamSid on socket — Twilio will drop frames`);
  }
  let offset = 0, frames = 0;
  while (offset < pcmBuffer.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);
    const payload =
      frame.length === BYTES_PER_FRAME
        ? frame
        : Buffer.concat([frame, Buffer.alloc(BYTES_PER_FRAME - frame.length)]);

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid: ws._streamSid,              // ← CRITICAL
        media: { payload: payload.toString("base64") },
      })
    );

    frames++;
    if (frames % 100 === 0) {
      console.log(`[${label}] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }

    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
  console.log(`[${label}] done.`);
}

/** Send N ms of *silent* media frames (keepalive) */
function sendSilence(ws, ms = 200) {
  if (!ws._streamSid || ws.readyState !== ws.OPEN) return;
  const frames = Math.ceil(ms / FRAME_MS);
  const silentFrame = Buffer.alloc(BYTES_PER_FRAME).toString("base64");
  for (let i = 0; i < frames; i++) {
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid: ws._streamSid,              // ← include streamSid
        media: { payload: silentFrame },
      })
    );
  }
}

/** ElevenLabs TTS → raw PCM (8 kHz, 16-bit) */
async function elevenLabsTtsPcm(text) {
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
      output_format: "pcm_8000", // 8 kHz PCM
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs failed: ${res.status} ${res.statusText} ${body}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const pcm = Buffer.from(arrayBuf);
  if (pcm.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(`[TTS] PCM length ${pcm.length} not sample-aligned; tail byte may be ignored`);
  }
  return pcm;
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket server (Twilio will connect to wss://<host>/stream)
// ───────────────────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  // Keepalive timer (send 200ms silence every 4s while idle)
  let keepaliveTimer = null;
  const armKeepalive = () => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => sendSilence(ws, 200), 4000);
  };

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

      // Short beep so we know audio downstream is working
      console.log("[BEEP] playing 200 ms…");
      try { await streamPcmToTwilio(ws, makeBeepPcm(200), "BEEP"); } catch (e) { console.error(e); }

      // Greeting (use ElevenLabs if configured, else another short beep as placeholder)
      try {
        if (ELEVEN_API_KEY) {
          const greeting = await elevenLabsTtsPcm("Hi! I'm your AI receptionist. How can I help you today?");
          console.log("[TTS] streaming greeting as PCM…");
          await streamPcmToTwilio(ws, greeting, "TTS");
        } else {
          console.log("[TTS] ELEVEN_API_KEY missing; sending fallback beep.");
          await streamPcmToTwilio(ws, makeBeepPcm(300), "TTS-Fallback");
        }
      } catch (err) {
        console.error("[TTS] greeting failed:", err.message);
      }

      // start keepalive after greeting
      armKeepalive();
      return;
    }

    if (msg.event === "media") {
      // inbound audio from caller (we're not decoding it here)
      ws._rxFrames = (ws._rxFrames || 0) + 1;
      if (ws._rxFrames % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rxFrames}`);
      return;
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rxFrames || 0})`);
      return;
    }
  });

  ws.on("close", () => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => console.error("[WS] error", err));
});

// HTTP entry + WS upgrade for /stream only
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// Simple health check
app.get("/", (_req, res) => res.status(200).send("OK"));
