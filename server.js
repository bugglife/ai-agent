// server.js — Twilio Media Streams <-> ElevenLabs TTS (ulaw_8000), no node-fetch
// Node 18+ provides global fetch/FormData/Blob

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// ElevenLabs
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
const ELEVEN_TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

// ---------- Helpers ----------

// Some ElevenLabs formats come wrapped in WAV. If so, pull the raw "data" chunk.
function extractWavDataIfNeeded(buf) {
  if (buf.length >= 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WAVE") {
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.slice(pos, pos + 4).toString();
      const size = buf.readUInt32LE(pos + 4);
      const next = pos + 8 + size;
      if (id === "data") return buf.slice(pos + 8, pos + 8 + size);
      pos = next;
    }
  }
  return buf;
}

// Ask ElevenLabs for μ-law 8kHz (perfect for phone) and return raw μ-law bytes
async function ttsUlaw8k(text) {
  if (!ELEVEN_API_KEY) {
    console.warn("[TTS] Missing ELEVEN_API_KEY");
    return null;
  }
  const body = { text, output_format: "ulaw_8000" };

  const resp = await fetch(ELEVEN_TTS_URL, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/octet-stream",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    console.warn("[TTS] HTTP", resp.status, errTxt);
    return null;
  }
  const raw = Buffer.from(await resp.arrayBuffer());
  return extractWavDataIfNeeded(raw);
}

// Send μ-law 8kHz bytes back to Twilio as exact 20ms frames (160 bytes), outbound track
async function sendUlawFramesToTwilio(ws, streamSid, ulawBuf) {
  const BYTES_PER_FRAME = 160; // 20ms @ 8 kHz μ-law
  const SILENCE = 0xff;       // μ-law silence byte

  for (let off = 0; off < ulawBuf.length; off += BYTES_PER_FRAME) {
    if (ws.readyState !== ws.OPEN) break;

    let frame = ulawBuf.slice(off, Math.min(off + BYTES_PER_FRAME, ulawBuf.length));
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME, SILENCE);
      frame.copy(padded);
      frame = padded;
    }

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: frame.toString("base64"), track: "outbound" },
      })
    );

    // Pace frames approximately in real time
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------- WebSocket handling ----------

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  let streamSid = null;

  ws.on("message", async (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start":
        streamSid = msg.start?.streamSid || null;
        console.log("[WS] START streamSid:", streamSid);

        // Play a quick greeting to prove audio return path is correct
        (async () => {
          const ulaw = await ttsUlaw8k("Connected. I can speak now.");
          if (ulaw && streamSid) await sendUlawFramesToTwilio(ws, streamSid, ulaw);
        })();

        break;

      case "media":
        // Acknowledge inbound frames so Twilio keeps streaming
        ws.send(
          JSON.stringify({
            event: "mark",
            mark: { name: `ack_${msg.media?.sequenceNumber}` },
          })
        );
        break;

      case "stop":
        console.log("[WS] STOP");
        break;

      default:
        break;
    }
  });

  ws.on("close", () => console.log("🔌 WebSocket closed"));
  ws.on("error", (err) => console.error("[WS] ERROR", err));
});

// ---------- HTTP/WS server ----------

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

app.get("/", (_req, res) => res.send("OK"));

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
