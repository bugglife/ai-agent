// server.js
// Twilio <Connect><Stream> bridge with ElevenLabs TTS (u-law 8 kHz)
// - Sends an immediate greeting on START so you hear audio even if STT isn't enabled
// - Still replies to Twilio real-time STT "transcription" events if present

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

const wss = new WebSocketServer({ noServer: true });

// Chunk a Buffer into 160-byte μ-law frames (20 ms @ 8 kHz) and send to Twilio
async function sendMuLawFrames(ws, ulawBuffer) {
  const FRAME = 160;
  let offset = 0;
  while (offset < ulawBuffer.length && ws.readyState === WebSocket.OPEN) {
    const end = Math.min(offset + FRAME, ulawBuffer.length);
    const slice = ulawBuffer.subarray(offset, end);
    const frame =
      slice.length === FRAME
        ? slice
        : Buffer.concat([slice, Buffer.alloc(FRAME - slice.length, 0xff)]);
    ws.send(JSON.stringify({ event: "media", media: { payload: frame.toString("base64") } }));
    offset = end;
    await new Promise((r) => setTimeout(r, 20)); // pace at 20 ms
  }
}

// Ask ElevenLabs to return raw μ-law @ 8k so it matches Twilio exactly
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
      output_format: "ulaw_8000",
    }),
  });

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    console.error("[TTS] HTTP", resp.status, buf.toString());
    return null;
  }
  return buf; // raw μ-law 8 kHz
}

// Optional keep-alive (pings + brief silence) to keep the stream flowing
function startKeepAlive(ws) {
  const SILENCE = Buffer.alloc(160, 0xff);
  const id = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event: "ping" }));
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ event: "media", media: { payload: SILENCE.toString("base64") } }));
    }
  }, 10000);
  return () => clearInterval(id);
}

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  let streamSid = null;
  let mediaCount = 0;
  const stopKA = startKeepAlive(ws);

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      console.log("[WS] event:", msg);
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log(
        "[WS] START callSid=%s streamSid=%s bidi=%s",
        msg.start?.callSid,
        streamSid,
        msg.start?.bidi
      );

      // 🔊 NEW: Play a greeting immediately so you hear audio even without STT
      const greeting =
        "Hi! I’m your AI receptionist. I can hear you now. Please say something after the beep.";
      const beep = Buffer.alloc(160, 0x2a); // crude short tone as a cue
      const ulaw = await elevenTTS_Ulaw8k(greeting);
      if (ulaw) {
        console.log("[TTS] sending greeting…");
        await sendMuLawFrames(ws, ulaw);
        // quick "beep"
        for (let i = 0; i < 10; i++) {
          ws.send(JSON.stringify({ event: "media", media: { payload: beep.toString("base64") } }));
          await new Promise((r) => setTimeout(r, 20));
        }
      } else {
        console.warn("[TTS] Greeting failed (no audio returned).");
      }
      return;
    }

    if (msg.event === "media") {
      mediaCount++;
      if (mediaCount % 100 === 0) {
        console.log("[MEDIA] frames received:", mediaCount);
      }
      // No STT here; we just count frames to know we're getting audio from the caller
      return;
    }

    // If Twilio real-time STT is enabled, you'll get these:
    if (msg.event === "transcription") {
      const text = (msg.text || "").trim();
      console.log("[STT]", text);
      if (!text) return;

      const reply = `You said: ${text}`;
      const ulaw = await elevenTTS_Ulaw8k(reply);
      if (!ulaw) return;
      console.log("[TTS] sending reply frames…");
      await sendMuLawFrames(ws, ulaw);
      ws.send(JSON.stringify({ event: "mark", mark: { name: "tts_end" } }));
      return;
    }

    if (msg.event === "mark") {
      console.log("[MARK]", msg.mark?.name);
      return;
    }

    if (msg.event === "stop") {
      console.log("[WS] STOP (total inbound frames:", mediaCount, ")");
      return;
    }
  });

  ws.on("close", (code, reason) => {
    stopKA();
    console.log("[WS] CLOSE code=%s reason=%s", code, reason?.toString());
  });
});

const server = app.listen(port, () => {
  console.log(`🚀 Server running on port ${port} (ws path: /stream)`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});
