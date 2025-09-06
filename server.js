import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import prism from "prism-media";
import ffbin from "@ffmpeg-installer/ffmpeg";

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!ELEVEN_VOICE_ID) console.error("❌ ELEVEN_VOICE_ID is not set");

// Twilio expects 8kHz, 16-bit PCM mono; 20ms = 160 samples = 320 bytes
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

// Send a 0.2s 1kHz beep (3200 bytes total). Sounds crisp and short.
function sendShortBeep(ws) {
  const frames = Math.round((0.2 * 1000) / FRAME_MS); // 10 frames
  const payloads = [];
  for (let i = 0; i < frames; i++) {
    const buf = Buffer.alloc(BYTES_PER_FRAME);
    // simple 1kHz sine @ 8kHz
    for (let s = 0; s < SAMPLES_PER_FRAME; s++) {
      const t = (i * SAMPLES_PER_FRAME + s) / SAMPLE_RATE;
      const sample = Math.sin(2 * Math.PI * 1000 * t) * 0.25; // 25% amplitude
      buf.writeInt16LE(Math.max(-1, Math.min(1, sample)) * 32767, s * 2);
    }
    payloads.push(buf.toString("base64"));
  }
  for (const pl of payloads) {
    ws.send(JSON.stringify({ event: "media", media: { payload: pl } }));
  }
  console.log("[BEEP] done.");
}

// Frame a raw PCM stream (s16le 8k mono) into 20ms packets to Twilio.
async function streamPcmFrames(ws, readable, label = "TTS") {
  return new Promise((resolve, reject) => {
    let carry = Buffer.alloc(0);
    let sent = 0;

    readable.on("data", (chunk) => {
      carry = Buffer.concat([carry, chunk]);
      while (carry.length >= BYTES_PER_FRAME) {
        const frame = carry.subarray(0, BYTES_PER_FRAME);
        carry = carry.subarray(BYTES_PER_FRAME);
        ws.send(JSON.stringify({ event: "media", media: { payload: frame.toString("base64") } }));
        sent++;
        if (sent % 100 === 0) {
          console.log(`[${label}] sent ${sent} frames (~${(sent * FRAME_MS) / 1000}s)`);
        }
      }
    });

    readable.on("end", () => {
      // pad tail (avoid odd leftover that can click)
      if (carry.length > 0) {
        const pad = Buffer.alloc(BYTES_PER_FRAME);
        carry.copy(pad);
        ws.send(JSON.stringify({ event: "media", media: { payload: pad.toString("base64") } }));
        sent++;
      }
      console.log(`[${label}] greeting done.`);
      resolve();
    });

    readable.on("error", (e) => {
      reject(e);
    });
  });
}

// Request ElevenLabs; prefer raw PCM. If we get MP3/container, use FFmpeg.
async function elevenLabsAsPcmReadable(text) {
  // 1) Try asking for PCM directly via query param (works on ElevenLabs)
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=pcm_8000`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "*/*"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 }
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`[TTS] ElevenLabs error ${res.status} ${res.statusText} ${t}`);
  }

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  // If Eleven sent raw PCM or octet-stream, just use the body stream.
  if (ct.includes("audio/pcm") || ct.includes("application/octet-stream")) {
    console.log(`[TTS] streaming as pcm (ct=${ct || "unknown"}) …`);
    return res.body; // Readable stream of raw PCM (s16le 8k mono)
  }

  // MP3 or other container → FFmpeg transcode to raw s16le 8k mono.
  console.warn(`[TTS] ${ct.includes("audio/mpeg") ? "MP3" : "container"} detected (ct=${ct}); transcoding…`);
  const ff = new prism.FFmpeg({
    args: [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",     // input from stdin
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "-f", "s16le",
      "pipe:1"            // output raw PCM
    ],
    shell: false,
    ffmpegPath: ffbin.path
  });

  res.body.pipe(ff);
  return ff;
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket (Twilio <Connect><Stream> → wss://…/stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  ws._rx = 0;
  ws._lastOut = Date.now();

  const keepalive = setInterval(() => {
    // If we haven’t sent anything in ~2s, send 200ms of silence (10 frames)
    if (Date.now() - ws._lastOut > 2000) {
      const silence = Buffer.alloc(BYTES_PER_FRAME, 0);
      for (let i = 0; i < 10; i++) {
        ws.send(JSON.stringify({ event: "media", media: { payload: silence.toString("base64") } }));
      }
      ws._lastOut = Date.now();
      console.log("[KEEPALIVE] sent 200ms silence");
    }
  }, 1000);

  ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`);
      try {
        // short beep and greeting
        sendShortBeep(ws);
        const text = "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
        const pcmReadable = await elevenLabsAsPcmReadable(text);
        // wrap to track last-out for keepalive suppression while streaming
        pcmReadable.on("data", () => { ws._lastOut = Date.now(); });
        await streamPcmFrames(ws, pcmReadable, "TTS");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message || e);
      }
    }

    if (msg.event === "media") {
      ws._rx++;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx})`);
    }
  });

  ws.on("close", () => {
    clearInterval(keepalive);
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => {
    clearInterval(keepalive);
    console.error("[WS] error", err);
  });
});

// HTTP + upgrade
app.get("/", (_req, res) => res.status(200).send("OK"));

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
