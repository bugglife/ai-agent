// server.js
// Minimal Twilio <Stream> bridge with ElevenLabs TTS (u-law 8kHz), chunked to 20ms frames

import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

// -------- Settings --------
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY; // <-- make sure this is set in Render
const ELEVEN_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";   // any voice you like

// Twilio expects 8kHz, mono, µ-law (PCMU), framed at 20ms => 160 bytes per frame
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 1;      // µ-law = 1 byte per sample
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * FRAME_MS) / 1000; // 160

// -------- WebSocket Server for Twilio <Stream> --------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  // Keep track of the active interval when we stream audio out
  let streamInterval = null;

  // Helper: stop any active streaming loop
  const stopStreaming = () => {
    if (streamInterval) {
      clearInterval(streamInterval);
      streamInterval = null;
    }
  };

  // Helper: stream a u-law 8kHz Buffer to Twilio in 20ms frames
  const streamUlawBuffer = async (buffer) => {
    // Defensive: pad to a multiple of FRAME_BYTES so we don’t send a short tail frame
    const remainder = buffer.length % FRAME_BYTES;
    if (remainder !== 0) {
      const padded = Buffer.alloc(buffer.length + (FRAME_BYTES - remainder));
      buffer.copy(padded);
      buffer = padded;
    }

    console.log(
      `[OUT-ULAW] bytes=${buffer.length} frames=${buffer.length / FRAME_BYTES} (~${
        (buffer.length / FRAME_BYTES) * FRAME_MS
      }ms)`
    );

    let offset = 0;
    stopStreaming();
    streamInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        stopStreaming();
        return;
      }
      if (offset >= buffer.length) {
        stopStreaming();
        return;
      }
      const frame = buffer.subarray(offset, offset + FRAME_BYTES);
      offset += FRAME_BYTES;

      ws.send(
        JSON.stringify({
          event: "media",
          media: {
            // Twilio expects base64 of raw µ-law bytes
            payload: frame.toString("base64"),
          },
        })
      );
    }, FRAME_MS);
  };

  // ElevenLabs: fetch audio already encoded as u-law (PCMU) at 8kHz
  async function textToSpeechULaw(text) {
    if (!ELEVEN_API_KEY) {
      throw new Error("ELEVEN_API_KEY is not set");
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;
    console.log("[TTS] Requesting ElevenLabs {");
    console.log(`  url: '${url}',`);
    console.log(`  accept: 'audio/ulaw'`);
    console.log("}");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        // 👇 This is the fix: get u-law bytes back (not MP3)
        Accept: "audio/ulaw",
      },
      body: JSON.stringify({
        text,
        voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs TTS failed: ${response.status} ${response.statusText} ${text}`
      );
    }

    const arrayBuf = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    console.log(`[TTS] ElevenLabs status ${response.status} OK`);
    console.log(`[TTS] bytes received ${buf.length}`);
    return buf; // already u-law 8kHz mono
  }

  // Handle messages from Twilio <Stream>
  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.warn("[WS] non-JSON message:", msg.toString().slice(0, 80));
      return;
    }

    const event = data.event;

    if (event === "start") {
      console.log(
        `[WS] START ${data.streamSid} | apiKeyPresent= ${!!ELEVEN_API_KEY}`
      );

      try {
        // A quick “connection check” phrase so you can hear something immediately
        const ulaw = await textToSpeechULaw(
          "Great, we are connected. You should hear me clearly now."
        );
        await streamUlawBuffer(ulaw);
      } catch (err) {
        console.error("[TTS] error:", err);
      }
    }

    // You can ignore inbound "media" unless you want to do STT.
    // Twilio sends downlink media in base64 PCM/ulaw here if you asked for both_tracks.

    if (event === "mark") {
      console.log("[WS] mark:", data?.mark?.name);
    }

    if (event === "stop") {
      console.log("[WS] STOP");
      stopStreaming();
    }
  });

  ws.on("close", () => {
    console.log("👋 WS closed");
    stopStreaming();
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
    stopStreaming();
  });
});

// -------- Friendly HTTP routes (for Render & quick checks) --------
app.get("/", (_, res) => {
  res
    .status(200)
    .send("✅ Server is running. WebSocket endpoint is wss://<your-host>/stream");
});

app.get("/healthz", (_, res) => {
  res.status(200).json({ ok: true });
});

// -------- Boot HTTP & upgrade to WS on /stream --------
const server = app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

server.on("upgrade", (request, socket, head) => {
  // Only accept websocket upgrades on /stream
  if (request.url !== "/stream") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
