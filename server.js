import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // change if you like

const wss = new WebSocketServer({ noServer: true });

// --- helpers ---------------------------------------------------------------

function wsSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    console.error("❌ WS send error:", e);
  }
}

async function ttsUlaw8000(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "content-type": "application/json",
      "accept": "audio/ulaw", // Twilio expects 8k mu-law
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status} ${res.statusText}: ${body}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// --- websocket handling ----------------------------------------------------

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  let streamSid = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("❌ Could not parse WS message:", e);
      return;
    }

    // Log everything for now so we can see the flow
    console.log("[WS-IN]", msg.event, msg);

    try {
      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || msg.streamSid || null;
        console.log("➡️  START streamSid:", streamSid);

        // (Optional) say hello right away (requires track="both_tracks" + account flag)
        const audio = await ttsUlaw8000("Hello! I am ready.");
        wsSend(ws, {
          event: "media",
          streamSid,                       // ✅ required by Twilio
          media: { payload: audio.toString("base64") },
        });
        console.log(`[OUT-ULAW] bytes=${audio.length}`);
      }

      // Twilio will send a lot of "media" with inbound audio from the caller.
      // We don't need to do anything with it for a simple test, but we could
      // collect speech and then reply via TTS.
      else if (msg.event === "media") {
        // You can inspect msg.media.payload (base64 μ-law) if needed
      }

      else if (msg.event === "mark" || msg.event === "stop") {
        console.log("➡️  Event:", msg.event);
      }

      // If you ever wire STT yourself and produce text, you can TTS and send:
      else if (msg.event === "transcription" && msg.text) {
        if (!streamSid) {
          console.warn("No streamSid yet; cannot send audio back.");
          return;
        }
        const audio = await ttsUlaw8000(`You said: ${msg.text}`);
        wsSend(ws, {
          event: "media",
          streamSid,
          media: { payload: audio.toString("base64") },
        });
        console.log(`[OUT-ULAW] bytes=${audio.length}`);
      }
    } catch (err) {
      console.error("❌ Handler error:", err);
    }
  });

  ws.on("close", () => console.log("👋 WS closed"));
  ws.on("error", (e) => console.error("❌ WS error:", e));
});

// --- health endpoints ------------------------------------------------------

app.get("/", (_req, res) => {
  res.status(200).send("✅ Server is running. WebSocket endpoint is at /stream");
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- HTTP server + Upgrade to WS ------------------------------------------

const server = app.listen(port, () =>
  console.log(`🚀 Server running on port ${port}`)
);

server.on("upgrade", (req, socket, head) => {
  // only accept /stream
  if (req.url !== "/stream") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});
