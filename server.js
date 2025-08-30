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

    // Handle incoming transcription (from Twilio)
    if (msg.event === "transcription") {
      console.log("[STT]", msg.text);

      // Build response text
      const reply = "Got it! You said: " + msg.text;

      try {
        const audioBuffer = await textToSpeech(reply);

        // Send back as u-law 8000Hz audio to Twilio
        ws.send(
          JSON.stringify({
            event: "media",
            media: {
              payload: audioBuffer.toString("base64"),
            },
          })
        );

        console.log(`[OUT-ULAW] sent ${audioBuffer.length} bytes`);
      } catch (err) {
        console.error("❌ TTS error:", err.message);
      }
    }
  });
});

// ElevenLabs TTS call with u-law 8000 format
async function textToSpeech(text) {
  const response = await fetch(
    "https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/stream",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/ulaw" // 👈 Force Twilio-compatible audio
      },
      body: JSON.stringify({
        text,
        voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed: ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// ✅ Health check routes
app.get("/", (req, res) => {
  res.status(200).send("✅ Server is running. WebSocket endpoint is at /stream");
});

app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true });
});

// WebSocket upgrade
const server = app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
