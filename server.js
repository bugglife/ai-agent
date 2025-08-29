// server.js
import express from "express";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ----- CONFIG -----
const app = express();
const port = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY; // <-- set in Render
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // optional

if (!ELEVEN_API_KEY) {
  console.warn(
    "[WARN] ELEVEN_API_KEY is not set. TTS calls will fail until you add it."
  );
}

// Simple health routes (so https://.../ loads and Render health checks pass)
app.get("/", (_req, res) => {
  res
    .status(200)
    .send("✅ Server is running. WebSocket endpoint is at wss://<host>/stream");
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

// ----- WEBSOCKET SERVER -----
const wss = new WebSocketServer({ noServer: true });

// Utility: wait (ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch µ-law 8kHz audio from ElevenLabs for the given text.
// We request the **telephony**-ready format so we don't need to transcode.
async function ttsUlaw8000(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const body = {
    text,
    // Request telephony format directly from ElevenLabs:
    // (They support this: "output_format": "ulaw_8000")
    output_format: "ulaw_8000",
    voice_settings: { stability: 0.5, similarity_boost: 0.5 },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY ?? "",
      "Content-Type": "application/json",
      // Accept can be generic; output_format governs the actual encoding
      Accept: "application/octet-stream",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const textErr = await resp.text().catch(() => "");
    throw new Error(
      `ElevenLabs TTS failed: ${resp.status} ${resp.statusText} ${textErr}`
    );
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab); // raw µ-law samples @ 8kHz
}

// Send µ-law audio back to Twilio as 20ms frames (160 bytes per frame @ 8kHz)
async function sendUlawToTwilio(ws, ulawBuffer) {
  // Twilio expects ~20ms media frames. At 8kHz and 1 byte/sample (µ-law),
  // 20ms = 160 bytes per frame.
  const FRAME_SIZE = 160; // 20ms @ 8kHz

  for (let offset = 0; offset < ulawBuffer.length; offset += FRAME_SIZE) {
    const chunk = ulawBuffer.slice(offset, offset + FRAME_SIZE);
    const b64 = chunk.toString("base64");

    ws.send(
      JSON.stringify({
        event: "media",
        media: {
          // This payload should be base64 of µ-law samples
          payload: b64,
        },
      })
    );

    // Pace at 20ms/frame so Twilio hears continuous audio
    await sleep(20);
  }

  // (Optional) Send a mark so you can detect "speech finished" client-side
  ws.send(JSON.stringify({ event: "mark", mark: { name: "tts_complete" } }));
}

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  let streamSid = null;

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // 'start' event carries streamSid and params
    if (data.event === "start") {
      streamSid = data.start?.streamSid;
      console.log("[WS] START", streamSid);

      // Say hello as a quick sanity test
      try {
        const hello = await ttsUlaw8000("Hello. I am connected.");
        await sendUlawToTwilio(ws, hello);
      } catch (e) {
        console.error("[TTS] Error on hello:", e?.message || e);
      }
      return;
    }

    // Twilio sends caller audio frames here (base64)
    if (data.event === "media") {
      // If you want transcription later, this is where you'd pass audio to ASR.
      // For now, we won't do anything with inbound media.
      return;
    }

    if (data.event === "mark") {
      // You could react to marks if you need
      return;
    }

    if (data.event === "stop") {
      console.log("[WS] STOP", streamSid || "");
      try {
        ws.close();
      } catch {}
      return;
    }
  });

  ws.on("close", () => {
    console.log("👋 WS closed");
  });

  ws.on("error", (err) => {
    console.error("[WS] error", err);
  });
});

// Upgrade ONLY the /stream path to WebSocket (Twilio connects here)
const server = app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});
