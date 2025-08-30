// server.js
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

// ---- Config ----
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // Rachel as default
const VERBOSE_MEDIA = false; // set true only when debugging frame-by-frame

// Twilio media format: 8kHz, mono, μ-law (G.711 u-law)
// 20ms per frame => 160 samples => 160 bytes (μ-law), but Twilio typically carries 320 bytes (2x 10ms)
const FRAME_MS = 20;
const CHUNK_BYTES = 320; // 20ms at 8k μ-law as Twilio sends

// ---- WebSocket (Twilio) ----
const wss = new WebSocketServer({ noServer: true });

function log(...args) {
  console.log(...args);
}

// Turn a raw μ-law buffer into paced Twilio media frames
async function sendUlawBufferPaced(ws, ulawBuffer) {
  // Split into 320-byte frames and send at ~20ms cadence
  const frames = [];
  for (let i = 0; i < ulawBuffer.length; i += CHUNK_BYTES) {
    frames.push(ulawBuffer.subarray(i, i + CHUNK_BYTES));
  }

  let idx = 0;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (idx >= frames.length || ws.readyState !== WebSocket.OPEN) {
        clearInterval(timer);
        return resolve();
      }
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: frames[idx].toString("base64") },
        })
      );
      idx++;
    }, FRAME_MS); // ~20ms between frames
  });
}

async function ttsUlaw(text) {
  // ElevenLabs non-streaming TTS → μ-law output
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      // μ-law at 8kHz so it matches Twilio
      Accept: "audio/ulaw",
    },
    body: JSON.stringify({
      text,
      // basic settings; tweak if you want
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

wss.on("connection", (ws) => {
  log("🔗 WebSocket connected");
  let firstHeard = false;
  let streamSid = null;
  let framesIn = 0;

  const safeSpeak = async (phrase) => {
    try {
      const ulaw = await ttsUlaw(phrase);
      log(`[TTS] bytes=${ulaw.length}`);
      await sendUlawBufferPaced(ws, ulaw);
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
        // Twilio tells us media format here (ulaw/8000/mono)
        log(
          "[WS-IN] connected",
          JSON.stringify(
            {
              protocol: msg.protocol,
              version: msg.version,
              mediaFormat: msg.mediaFormat,
            },
            null,
            0
          )
        );
        // Greet the caller to prove outbound audio works
        safeSpeak("Hello! I’m online. Say something and I’ll reply.");
        break;
      }

      case "start": {
        streamSid = msg.start?.streamSid;
        log(`🚀 START streamSid: ${streamSid}`);
        break;
      }

      case "media": {
        framesIn++;
        if (VERBOSE_MEDIA && framesIn <= 10) {
          // print only first few to avoid log floods
          log("[WS-IN] media", {
            seq: msg.sequenceNumber,
            chunk: msg.media?.chunk,
            ts: msg.media?.timestamp,
          });
        }

        // First time we detect any media, confirm back to caller
        if (!firstHeard) {
          firstHeard = true;
          safeSpeak("Got it. I hear you.");
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
        // ignore other events to keep logs clean
        break;
    }
  });

  ws.on("close", () => {
    log("👋 WS closed");
  });
});

// ---- Minimal HTTP (health + root) ----
app.get("/", (_req, res) => {
  res
    .status(200)
    .send("✅ Server is running. Twilio WebSocket endpoint: wss://<host>/stream");
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = app.listen(port, () => {
  log(`🚀 Server running on port ${port}`);
});

// Upgrade HTTP → WS at /stream
server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  if (!url || !url.startsWith("/stream")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
