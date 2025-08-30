// server.js
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // Rachel

// Twilio: 8kHz, mono, μ-law. 20ms frame = 160 bytes.
const FRAME_MS = 20;
const OUT_FRAME_BYTES = 160; // <= IMPORTANT: 160 bytes per 20ms

const wss = new WebSocketServer({ noServer: true });

function log(...args) {
  console.log(...args);
}

async function ttsUlaw(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/ulaw",           // raw ulaw stream
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      output_format: "ulaw_8000",     // 8kHz μ-law (matches Twilio)
    }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${msg}`);
  }

  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

// Pace an ulaw buffer into 160-byte frames every 20ms
async function sendUlawBufferPaced(ws, ulawBuffer, label = "TTS") {
  // Split to 160-byte frames (20ms each)
  const frames = [];
  for (let i = 0; i < ulawBuffer.length; i += OUT_FRAME_BYTES) {
    frames.push(ulawBuffer.subarray(i, i + OUT_FRAME_BYTES));
  }

  log(`[OUT] ${label}: frames=${frames.length} (~${frames.length * FRAME_MS}ms)`);

  let sent = 0;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || sent >= frames.length) {
        clearInterval(timer);
        return resolve();
      }
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: frames[sent].toString("base64") },
        })
      );
      sent++;
    }, FRAME_MS);
  });

  log(`[OUT] ${label}: framesSent=${sent}`);
}

wss.on("connection", (ws) => {
  log("🔗 WebSocket connected");
  let firstHeard = false;
  let streamSid = null;

  const say = async (phrase, tag) => {
    try {
      const ulaw = await ttsUlaw(phrase);
      log(`[TTS] bytes=${ulaw.length}`);
      await sendUlawBufferPaced(ws, ulaw, tag ?? "TTS");
    } catch (err) {
      console.error("[TTS] error:", err.message);
    }
  };

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case "connected": {
        log("[WS-IN] connected", JSON.stringify({ protocol: msg.protocol, version: msg.version }));
        // Greet to verify outbound audio path
        say("Hello. I am online. Say something and I will reply.", "greeting");
        break;
      }
      case "start": {
        streamSid = msg.start?.streamSid;
        log(`🚀 START streamSid: ${streamSid}`);
        break;
      }
      case "media": {
        // As soon as we receive inbound audio the first time, confirm audibly
        if (!firstHeard) {
          firstHeard = true;
          say("Got it. I hear you.", "heard");
        }
        break;
      }
      case "stop": {
        log("🛑 WS stop");
        try { ws.close(); } catch {}
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => log("👋 WS closed"));
});

// Minimal HTTP
app.get("/", (_req, res) =>
  res.status(200).send("✅ Server is running. Twilio WS: wss://<your-host>/stream")
);
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = app.listen(port, () => log(`🚀 Server running on port ${port}`));

// Upgrade HTTP → WS on /stream
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/stream")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
