// server.js
// Minimal Twilio <Connect><Stream> bridge with ElevenLabs TTS (u-law 8 kHz)

import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

// === ENV ===
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY; // REQUIRED
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // Rachel default

const ELEVEN_TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

// Twilio sends inbound audio only on <Connect><Stream>. We send our own audio back.

const wss = new WebSocketServer({ noServer: true });

// Utility: chunk a Buffer into 160-byte frames (20 ms @ 8k μ-law) and send to Twilio
async function sendMuLawFrames(ws, ulawBuffer) {
  const FRAME = 160; // 160 samples @ 8kHz = 20ms
  const total = ulawBuffer.length;
  let offset = 0;

  while (offset < total && ws.readyState === WebSocket.OPEN) {
    const end = Math.min(offset + FRAME, total);
    const slice = ulawBuffer.subarray(offset, end);
    // If last chunk is short, pad with silence (0xFF for μ-law silence)
    const frame =
      slice.length === FRAME ? slice : Buffer.concat([slice, Buffer.alloc(FRAME - slice.length, 0xff)]);

    ws.send(
      JSON.stringify({
        event: "media",
        media: { payload: frame.toString("base64") },
      })
    );

    offset = end;
    // 20ms pacing to match real-time
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ElevenLabs TTS -> raw μ-law @ 8 kHz (matches Twilio exactly)
async function elevenTTS_Ulaw8k(text) {
  if (!ELEVEN_API_KEY) {
    console.error("[TTS] Missing ELEVEN_API_KEY");
    return null;
  }

  const resp = await fetch(ELEVEN_TTS_URL, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "*/*",
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      // 👇 This is the key: ask for μ-law 8000 directly (no WAV / MP3 / resample)
      output_format: "ulaw_8000",
    }),
  });

  const buf = Buffer.from(await resp.arrayBuffer());

  if (!resp.ok) {
    // If ElevenLabs sends JSON error, this prints it
    console.error("[TTS] HTTP", resp.status, buf.toString());
    return null;
  }

  return buf; // already raw μ-law @ 8kHz
}

// Optional: keep the stream alive with silence every ~10s
function startKeepAlive(ws) {
  const SILENCE = Buffer.alloc(160, 0xff); // μ-law silence
  const id = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event: "ping" }));
    // short silence burst to keep media flowing
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ event: "media", media: { payload: SILENCE.toString("base64") } }));
    }
  }, 10000);
  return () => clearInterval(id);
}

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  let streamSid = null;
  const stopKeepAlive = startKeepAlive(ws);

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Twilio "connected" control event
    if (msg.event === "connected") {
      console.log("[WS] event:", msg);
      return;
    }

    // Twilio "start" event => capture streamSid
    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log("[WS] START callSid=%s streamSid=%s bidi=%s", msg.start?.callSid, streamSid, msg.start?.bidi);
      return;
    }

    // Raw audio from caller (we aren't decoding in this demo)
    if (msg.event === "media") {
      // If you want VAD or STT here, you can add it later.
      return;
    }

    // If you have Twilio real-time STT enabled, you'll see "transcription" events.
    if (msg.event === "transcription") {
      const text = (msg.text || "").trim();
      console.log("[STT]", text);

      if (!text) return;

      // Simple demo reply: echo what the user said
      const reply = `You said: ${text}`;
      const ulaw = await elevenTTS_Ulaw8k(reply);
      if (!ulaw) return;

      console.log("[TTS] sending reply frames…");
      await sendMuLawFrames(ws, ulaw);

      // optional: mark playback end
      ws.send(JSON.stringify({ event: "mark", mark: { name: "tts_end" } }));
      return;
    }

    if (msg.event === "mark") {
      // marker round-trips from Twilio to confirm queued media completed
      console.log("[MARK]", msg.mark?.name);
      return;
    }

    if (msg.event === "stop") {
      console.log("[WS] STOP");
      return;
    }
  });

  ws.on("close", (code, reason) => {
    stopKeepAlive();
    console.log("[WS] CLOSE code=%s reason=%s", code, reason?.toString());
  });
});

const server = app.listen(port, () => {
  console.log(`🚀 Server running on port ${port} (ws path: /stream)`);
});

// Upgrade HTTP -> WS at /stream
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});
