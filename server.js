// server.js — Twilio <Stream> ⇄ Deepgram STT ⇄ Tiny Brain ⇄ ElevenLabs TTS
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { FFmpeg } from "prism-media";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

const app = express();
const PORT = process.env.PORT || 10000;

// ───────────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const BIZ_NAME = process.env.BIZ_NAME || "Our business";
const BIZ_HOURS = process.env.BIZ_HOURS || "Mon–Fri 9am–5pm";
const BIZ_SERVICE_AREAS = process.env.BIZ_SERVICE_AREAS || "Local area";
const BOOK_URL = process.env.BOOK_URL || "https://example.com/book";

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!DEEPGRAM_API_KEY) console.error("❌ DEEPGRAM_API_KEY is not set");

// Twilio media: 16-bit PCM mono @ 8kHz, 20ms frames (320 bytes)
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// Keep per-call context
const calls = new WeakMap(); // ws -> { dg, rxCount, speaking }

// ───────────────────────────────────────────────────────────────────────────────
// UTIL: base64 PCM frames → Twilio "media" messages (with padding for last chunk)
// ───────────────────────────────────────────────────────────────────────────────
async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  let frames = 0;

  while (offset < pcmBuffer.length) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);

    let payload;
    if (frame.length < BYTES_PER_FRAME) {
      const pad = Buffer.alloc(BYTES_PER_FRAME);
      frame.copy(pad, 0);
      payload = pad.toString("base64");
    } else {
      payload = frame.toString("base64");
    }

    ws.send(JSON.stringify({ event: "media", media: { payload } }));
    frames++;

    // pacing ~20ms per frame
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS (ElevenLabs) → always return PCM16/8k/mono
// We request MP3 (fast) and transcode to s16le/8k/mono with ffmpeg when needed.
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabs(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      // Fastest/most compatible pipe is mp3; we'll transcode reliably.
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      // If your plan supports raw pcm_8000 you can switch to that and skip ffmpeg.
      // output_format: "pcm_8000",
    }),
  });

  if (!res.ok) {
    throw new Error(`[TTS] HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const audioBuf = Buffer.from(await res.arrayBuffer());

  // If ElevenLabs ever returns raw s16le, just pass through
  if (contentType.includes("audio/pcm") || contentType.includes("audio/x-raw")) {
    return audioBuf;
  }

  // Otherwise transcode mp3 → s16le/8k/mono
  return await transcodeToPcm16Mono8k(audioBuf);
}

function transcodeToPcm16Mono8k(inputBuffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const ff = new FFmpeg({
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "mp3",
        "-i",
        "pipe:0",
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "-f",
        "s16le",
        "pipe:1",
      ],
    });

    // Ensure ffmpeg path (Render can resolve it from installer)
    process.env.FFMPEG_PATH = ffmpegPath.path;

    ff.on("error", (e) => reject(e));
    ff.on("data", (d) => chunks.push(d));
    ff.on("end", () => resolve(Buffer.concat(chunks)));

    ff.end(inputBuffer);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
async function say(ws, text) {
  console.log(`[TTS] -> "${text}"`);
  try {
    const pcm = await ttsElevenLabs(text);
    await streamPcmToTwilio(ws, pcm);
  } catch (e) {
    console.error("[TTS] failed:", e.message);
  }
}

// Short beep (200ms, 1kHz)
function beepBuffer(ms = 180, freq = 1000) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const s = Math.sin(2 * Math.PI * freq * t);
    const v = Math.max(-1, Math.min(1, s)) * 0.25; // volume
    buf.writeInt16LE((v * 0x7fff) | 0, i * 2);
  }
  return buf;
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram: connect and stream linear16/8k from Twilio to DG
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(forWs) {
  const qs = new URLSearchParams({
    model: "nova-2-general",
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
    interim_results: "false",
    smart_format: "true",
    punctuate: "true",
  }).toString();

  const url = `wss://api.deepgram.com/v1/listen?${qs}`;
  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dg.on("open", () => console.log("[DG] connected"));
  dg.on("close", (c) => console.log("[DG] close", c));
  dg.on("error", (e) => console.error("[DG] error", e.message || e));

  dg.on("message", async (data) => {
    // Deepgram sends JSON messages
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // Final transcript payload shape:
    // { type:"Results", channel:{ alternatives:[{ transcript, confidence }], ...}, is_final:true }
    if (msg.type === "Results" && msg.is_final) {
      const alt = msg.channel?.alternatives?.[0];
      const transcript = (alt?.transcript || "").trim();
      if (transcript) {
        console.log("[STT]", transcript);
        await handleUserText(forWs, transcript);
      }
    }
  });

  return dg;
}

// ───────────────────────────────────────────────────────────────────────────────
// Tiny Brain (very simple intent router; safe and deterministic)
// ───────────────────────────────────────────────────────────────────────────────
async function handleUserText(ws, text) {
  const lower = text.toLowerCase();

  // simple slots/intents
  if (/(hours|open|close|closing|opening|when)/i.test(lower)) {
    await say(ws, `${BIZ_NAME} is open ${BIZ_HOURS}.`);
    return;
  }

  if (/(service|area|where|locations?|coverage)/i.test(lower)) {
    await say(ws, `We currently serve ${BIZ_SERVICE_AREAS}.`);
    return;
  }

  if (/(book|appointment|schedule|estimate|quote)/i.test(lower)) {
    if (BOOK_URL.startsWith("http")) {
      await say(ws, `I can text you our booking link, or schedule you here. The link is ${BOOK_URL}. How can I help?`);
    } else {
      await say(ws, `I can help schedule you. What day works for you?`);
    }
    return;
  }

  if (/(leave|voicemail|message|call you back)/i.test(lower)) {
    await say(ws, `Sure—please tell me your name, number, and what you need. I’ll save your voicemail and alert the team.`);
    // (Optional: switch to "record mode" if you want; omitted for brevity.)
    return;
  }

  // default fallback
  await say(
    ws,
    `I think you asked: "${text}". I can help with hours, service areas, booking an appointment, or taking a voicemail. What would you like to do?`
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER (Twilio <Connect><Stream> hits wss://.../stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 stream connected");
  calls.set(ws, { dg: null, rxCount: 0, speaking: false });

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON
    }

    if (msg.event === "connected") {
      console.log(`[WS] connected proto=${msg.protocol} v=${msg.version}`);
    }

    if (msg.event === "start") {
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid}`);

      // Connect Deepgram (STT)
      const ctx = calls.get(ws);
      ctx.dg = connectDeepgram(ws);

      // tiny beep + greeting (non-blocking)
      streamPcmToTwilio(ws, beepBuffer(160, 1000)).catch(() => {});
      say(ws, `Hi! I’m your AI receptionist at ${BIZ_NAME}. How can I help you today?`).catch(() => {});
      return;
    }

    if (msg.event === "media") {
      // Inbound 20ms PCM16/8k frame from Twilio (base64)
      const ctx = calls.get(ws);
      if (!ctx) return;
      ctx.rxCount++;
      if (ctx.rxCount % 100 === 0) {
        console.log(`[MEDIA] rx frames: ${ctx.rxCount * 1}`);
      }

      // Forward raw bytes to Deepgram
      const dg = ctx.dg;
      if (dg && dg.readyState === WebSocket.OPEN) {
        try {
          dg.send(Buffer.from(msg.media.payload, "base64"));
        } catch (e) {
          console.error("[DG] send error:", e.message);
        }
      }
      return;
    }

    if (msg.event === "stop") {
      const ctx = calls.get(ws);
      console.log(`[WS] STOP (rx=${ctx?.rxCount || 0})`);
      if (ctx?.dg && ctx.dg.readyState === WebSocket.OPEN) ctx.dg.close(1000);
      return;
    }
  });

  ws.on("close", () => {
    const ctx = calls.get(ws);
    if (ctx?.dg && ctx.dg.readyState === WebSocket.OPEN) ctx.dg.close(1000);
    console.log("[WS] CLOSE");
    calls.delete(ws);
  });

  ws.on("error", (err) => console.error("[WS] error", err));
});

// HTTP server + WS upgrade
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  // Only accept upgrades for /stream
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Simple healthcheck
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
