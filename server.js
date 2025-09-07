// server.js

import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import prism from "prism-media";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

// ───────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

// ElevenLabs (TTS)
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");

// OpenAI / Deepgram (STT)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
if (!OPENAI_API_KEY) console.error("❌ OPENAI_API_KEY is not set");
if (!DEEPGRAM_API_KEY) console.error("❌ DEEPGRAM_API_KEY is not set");

// Business context
const BIZ = {
  name: process.env.BIZ_NAME || "Clean Easy",
};

// ───────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────

// Convert ElevenLabs MP3 stream → PCM16/8k/mono with ffmpeg
function mp3ToPcm16Transformer() {
  return new prism.FFmpeg({
    ffmpegPath: ffmpegInstaller.path,
    args: [
      "-hide_banner", "-loglevel", "error",
      "-f", "mp3", "-i", "pipe:0",
      "-ac", "1",
      "-ar", "8000",
      "-f", "s16le", "pipe:1"
    ]
  });
}

// Example TTS fetch from ElevenLabs
async function elevenLabsTTS(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`[TTS] ElevenLabs error: ${response.statusText}`);
  }

  return response.body; // returns a Readable stream (MP3)
}

// ───────────────────────────────────────────────────────────────
// WEBSOCKET SERVER (for Twilio Media Streams)
// ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("📞 WebSocket connected");

  // Example greeting when call connects
  elevenLabsTTS(`Hi! I'm your AI receptionist at ${BIZ.name}. How can I help you today?`)
    .then((mp3Stream) => {
      const transformer = mp3ToPcm16Transformer();
      mp3Stream.pipe(transformer).on("data", (chunk) => {
        // Send PCM16 to Twilio (wrap in Twilio media message)
        ws.send(JSON.stringify({
          event: "media",
          media: {
            payload: chunk.toString("base64")
          }
        }));
      });
    })
    .catch((err) => console.error("[TTS ERROR]", err));
});

// ───────────────────────────────────────────────────────────────
// EXPRESS SETUP
// ───────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("✅ Server is running");
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});
