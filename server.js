import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  ws.on("message", async (message) => {
    const msg = JSON.parse(message.toString());

    // Handle incoming transcription
    if (msg.event === "transcription") {
      console.log("[STT]", msg.text);

      // Send response back via TTS
      const reply = "Got it! You said: " + msg.text;
      const audioBuffer = await textToSpeech(reply);

      // Stream back to Twilio
      ws.send(
        JSON.stringify({
          event: "media",
          media: {
            payload: audioBuffer.toString("base64"),
          },
        })
      );
    }
  });
});

// ElevenLabs TTS call
async function textToSpeech(text) {
  const response = await fetch("https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL", {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.5 }
    })
  });

  if (!response.ok) {
    throw new Error(`❌ ElevenLabs TTS failed: ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

const server = app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
