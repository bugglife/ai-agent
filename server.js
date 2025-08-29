// server.js
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { URL } from "url";

const app = express();
const port = process.env.PORT || 10000;

// ✅ Set this in Render environment variables
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
if (!ELEVEN_API_KEY) {
  console.warn("⚠️ ELEVEN_API_KEY is not set. TTS calls will fail.");
}

// ---- Helpers ---------------------------------------------------------------

// Ask ElevenLabs for u-law 8kHz mono, which Twilio can play directly.
async function ttsUlaw8000(text) {
  const voiceId = "EXAVITQu4vr4xnSDxMaL"; // change if you want another voice
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        // We'll receive raw audio data
        Accept: "application/octet-stream",
      },
      body: JSON.stringify({
        text,
        // 👇 This is the key: ask for u-law 8kHz so we can send it straight to Twilio
        output_format: "ulaw_8000",
        voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      }),
    }
  );

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${resp.status} ${resp.statusText} ${t}`);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf); // raw u-law bytes
}

// Split a Buffer into 20ms frames at 8kHz u-law (1 byte per sample => 160 bytes per 20ms).
function chunkUlaw20ms(buf) {
  const FRAME_BYTES = 160; // 20ms * 8000 samples/sec * 1 byte/sample
  const frames = [];
  for (let i = 0; i < buf.length; i += FRAME_BYTES) {
    frames.push(buf.slice(i, i + FRAME_BYTES));
  }
  return frames;
}

// Send frames to Twilio as "media" messages (base64 payload)
async function streamUlawFrames(ws, frames, pace = true) {
  for (const frame of frames) {
    ws.send(
      JSON.stringify({
        event: "media",
        media: { payload: frame.toString("base64") },
      })
    );

    // Twilio expects ~real-time pacing (~20ms/frame).
    if (pace) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  // Let Twilio know we’re done sending media for this segment.
  ws.send(JSON.stringify({ event: "mark", mark: { name: "tts-complete" } }));
}

// ---- WebSocket server ------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WS connected");

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      console.log(`[WS] START ${msg.start?.streamSid || ""}`);
      // Say something on connect, just to prove audio is flowing
      try {
        const ulaw = await ttsUlaw8000("Hello! I can hear you. Say something after the beep.");
        const frames = chunkUlaw20ms(ulaw);
        await streamUlawFrames(ws, frames);
      } catch (err) {
        console.error("TTS on start failed:", err.message);
      }

      // Send a short beep (simple 1kHz tone) — optional:
      // You can pre-generate u-law frames if you want a real beep.
    }

    if (msg.event === "media") {
      // Incoming audio from caller (u-law base64 in msg.media.payload).
      // If you want live echo, you can forward it straight back:
      // ws.send(JSON.stringify({ event: "media", media: { payload: msg.media.payload } }));
    }

    if (msg.event === "stop") {
      console.log("[WS] STOP");
    }
  });

  ws.on("close", () => console.log("👋 WS closed"));
});

// ---- Express HTTP (health & upgrade) ---------------------------------------

app.get("/", (_req, res) => {
  res
    .status(200)
    .send("✅ Server is running. WebSocket endpoint is at wss://<host>/stream");
});
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

const server = createServer(app);

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

server.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
