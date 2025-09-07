// server.js

import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import prism from "prism-media";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const app = express();
const PORT = process.env.PORT || 10000;

// Config
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const BIZ = { name: process.env.BIZ_NAME || "Clean Easy" };

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY missing");

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

// ffmpeg transformer MP3 → PCM16/8k/mono
function mp3ToPCM16() {
  return new prism.FFmpeg({
    ffmpegPath: ffmpegInstaller.path,
    args: [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "mp3", "-i", "pipe:0",
      "-ac", "1",
      "-ar", "8000",
      "-f", "s16le",
      "pipe:1"
    ]
  });
}

// Call ElevenLabs → returns ReadableStream (MP3)
async function elevenLabsTTS(text) {
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    }
  );

  if (!resp.ok) {
    throw new Error(`TTS error: ${resp.status} ${await resp.text()}`);
  }

  return resp.body; // Node.js Readable (MP3)
}

// ──────────────────────────────────────────────
// WebSocket: Twilio Media Stream
// ──────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws) => {
  console.log("📞 WebSocket connected");

  try {
    // Greeting
    const mp3Stream = await elevenLabsTTS(
      `Hi! I’m your AI receptionist at ${BIZ.name}. How can I help you today?`
    );

    const ffmpeg = mp3ToPCM16();

    mp3Stream.pipe(ffmpeg).on("data", (chunk) => {
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: chunk.toString("base64") }
        })
      );
    });

    ffmpeg.on("end", () => {
      console.log("✅ Greeting finished");
    });
  } catch (err) {
    console.error("❌ Greeting failed:", err);
  }
});

// ──────────────────────────────────────────────
// Express
// ──────────────────────────────────────────────
app.get("/", (req, res) => res.send("✅ Server is running"));

const server = app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});
