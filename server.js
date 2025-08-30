// server.js
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // Rachel

// Twilio voice media stream: 8kHz, mono, μ-law.
// 20ms frame = 160 bytes.
const FRAME_MS = 20;
const OUT_FRAME_BYTES = 160;

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
      Accept: "audio/ulaw", // raw μ-law @ 8kHz
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      output_format: "ulaw_8000",
    }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${msg}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

// Pace a μ-law buffer into 160-byte frames every 20ms.
// IMPORTANT: include streamSid in each outbound message.
async function sendUlawBufferPaced(ws, streamSid, ulawBuffer, label = "TTS") {
  // Optional: tiny delay to let Twilio’s jitter buffer settle
  await new Promise((r) => setTimeout(r, 100));

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
          streamSid, // <= REQUIRED
          media: { payload: frames[sent].toString("base64") },
        })
      );
      sent++;
    }, FRAME_MS);
  });

  // Send a mark so Twilio knows this clip ended (optional but nice)
  try {
    ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `end:${label}` } }));
  } catch {}

  log(`[OUT] ${label}: framesSent=${sent}`);
}

wss.on("connection", (ws) => {
  log("🔗 WebSocket connected");
  let streamSid = null;
  let heardOnce = false;

  const say = async (phrase, tag) => {
    if (!streamSid) return; // we need a streamSid to talk back
    try {
      const ulaw = await ttsUlaw(phrase);
      log(`[TTS] bytes=${ulaw.length}`);
      await sendUlawBufferPaced(ws, streamSid, ulaw, tag ?? "TTS");
    } catch (err) {
      console.error("[TTS] error:", err.message);
    }
  };

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "connected": {
        log("[WS-IN] connected", JSON.stringify({ protocol: msg.protocol, version: msg.version }));
        break;
      }
      case "start": {
        streamSid = msg.start?.streamSid;
        log(`🚀 START streamSid: ${streamSid}`);
        // Send greeting once we know the streamSid
        say("Hello. I am online. Say something and I will reply.", "greeting");
        break;
      }
      case "media": {
        // First inbound audio → acknowledge
        if (!heardOnce && streamSid) {
          heardOnce = true;
          say("Got it. I hear you.", "heard");
        }
        break;
      }
      case "stop": {
        log("🛑 WS stop");
        try {
          ws.close();
        } catch {}
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => log("👋 WS closed"));
});

// HTTP for health check
app.get("/", (_req, res) =>
  res.status(200).send("✅ Server is running. Twilio WS at /stream")
);
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = app.listen(port, () => log(`🚀 Server running on port ${port}`));

// Upgrade to WS only for /stream
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/stream")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
