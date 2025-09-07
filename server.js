// server.js
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { twiml as TwiML } from "twilio";
import fetch from "node-fetch";
import prism from "prism-media";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { Readable } from "stream";
import sgMail from "@sendgrid/mail";

// ───────────────────────────────────────────────────────────────────────────────
// Config & Env
// ───────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g. https://your-app.onrender.com

// ElevenLabs
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID_ENV = process.env.ELEVEN_VOICE_ID || "";
const ELEVEN_FALLBACK_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel

// SendGrid Alerts (optional; safe no-op if not configured)
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || "";
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || "";
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

// Point prism to the correct ffmpeg binary.
prism.FFmpeg.setFfmpegPath(ffmpegInstaller.path);

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────
function chooseVoiceId() {
  const voice = ELEVEN_VOICE_ID_ENV || ELEVEN_FALLBACK_VOICE;
  if (!ELEVEN_API_KEY) {
    console.error("❌ ELEVEN_API_KEY is not set (no TTS will play).");
  }
  if (!ELEVEN_VOICE_ID_ENV) {
    console.log(`[TTS] Using fallback ElevenLabs voice: ${ELEVEN_FALLBACK_VOICE}`);
  } else {
    console.log(`[TTS] Using configured ElevenLabs voice: ${ELEVEN_VOICE_ID_ENV}`);
  }
  return voice;
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

async function sendAlertEmail(subject, message) {
  try {
    if (!SENDGRID_API_KEY || !ALERT_EMAIL_FROM || !ALERT_EMAIL_TO) {
      // not configured; silently skip
      return;
    }
    const msg = {
      to: ALERT_EMAIL_TO,
      from: ALERT_EMAIL_FROM,
      subject: subject,
      text: message,
    };
    await sgMail.send(msg);
    console.log(`[ALERT] email sent: ${subject}`);
  } catch (err) {
    console.error("[ALERT] send failed:", err?.message || err);
  }
}

/**
 * Speak text to an active Twilio media stream.
 * - ElevenLabs MP3 -> ffmpeg -> PCM16 / 8k / mono
 * - Streams base64 PCM frames via websocket 'media' events
 */
async function ttsSay(ws, text) {
  if (!ELEVEN_API_KEY) return;

  const voiceId = chooseVoiceId();
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "accept": "audio/mpeg",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch (err) {
    console.error("[TTS] network error:", err);
    await sendAlertEmail("[ERROR] TTS greeting", String(err));
    return;
  }

  if (!res.ok) {
    const body = await safeReadText(res);
    console.error("[TTS] greeting failed:", res.status, body);
    await sendAlertEmail("[ERROR] TTS greeting", `status=${res.status} body=${body}`);
    return;
  }

  // Build a proper Readable stream (avoid 'pipe is not a function')
  let mp3Readable = res.body;
  if (!mp3Readable || typeof mp3Readable.pipe !== "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    mp3Readable = Readable.from(buf);
  }

  // Transcode MP3 -> PCM16/8k/mono
  const ffmpeg = new prism.FFmpeg({
    args: [
      "-loglevel", "error",
      "-f", "mp3",
      "-i", "pipe:0",
      "-f", "s16le",
      "-ar", "8000",
      "-ac", "1",
      "pipe:1",
    ],
  });

  return new Promise((resolve) => {
    mp3Readable
      .pipe(ffmpeg)
      .on("error", async (err) => {
        console.error("[TTS] ffmpeg error:", err);
        await sendAlertEmail("[ERROR] TTS greeting", `ffmpeg: ${String(err)}`);
        resolve();
      })
      .on("data", (chunk) => {
        // Send PCM frames to Twilio
        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: chunk.toString("base64") },
          })
        );
      })
      .on("end", () => resolve());
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Express + Twilio TwiML for Voice → Media Streams
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Twilio webhook that returns TwiML to connect the call to our WS media stream.
app.post("/voice", (req, res) => {
  if (!PUBLIC_URL) {
    console.error("❌ PUBLIC_URL is not set. Twilio cannot reach your WS.");
  }
  const response = new TwiML.VoiceResponse();
  const connect = response.connect();
  connect.stream({ url: `${PUBLIC_URL.replace(/\/$/, "")}/media` });
  res.type("text/xml").send(response.toString());
});

// Quick ping route
app.get("/", (_req, res) => res.send("OK"));

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket server (Twilio Media Streams)
// ───────────────────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  const id = Math.random().toString(36).slice(2, 7);
  console.log(`[${id}] 🔗 WebSocket connected`);

  // Twilio sends JSON messages
  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      console.log(
        `[${id}] [WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid}`
      );
      // Speak greeting
      const greeting =
        "Hi! I’m your AI receptionist at Clean Easy. How can I help you today?";
      ttsSay(ws, greeting);
    }

    if (msg.event === "media") {
      // Incoming audio frame from caller (base64 PCM @ 8k mono)
      // You can forward to STT here if you’d like.
    }

    if (msg.event === "stop") {
      console.log(`[${id}] [WS] STOP`);
    }
  });

  ws.on("close", () => {
    console.log(`[${id}] [WS] CLOSE`);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Start
// ───────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
