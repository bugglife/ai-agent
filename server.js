// server.js — Diagnostic: send known-good μ-law 8k (silence + 440Hz tone) to Twilio
// Node 18+ (global fetch). No dependencies.

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// ----- μ-law helpers -----

// PCM16 sample -> 8-bit μ-law (PCMU). ITU-T G.711 μ-law
function linear16ToUlaw(sample) {
  // clamp
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;

  const BIAS = 0x84; // 132
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  sample = sample + BIAS;
  if (sample > 0x7FFF) sample = 0x7FFF;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulawByte;
}

// Generate μ-law 8kHz buffer for a sine tone (duration ms, freq Hz)
function genUlawTone(durationMs, freqHz, sampleRate = 8000) {
  const samples = Math.round(sampleRate * (durationMs / 1000));
  const buf = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    // sine at -6 dBFS approx
    const s = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    const pcm16 = Math.round(s * 0.5 * 32767); // -6 dBFS
    buf[i] = linear16ToUlaw(pcm16);
  }
  return buf;
}

// Generate μ-law silence (0xFF)
function genUlawSilence(durationMs, sampleRate = 8000) {
  const samples = Math.round(sampleRate * (durationMs / 1000));
  return Buffer.alloc(samples, 0xFF);
}

// Send μ-law 8kHz as 20ms frames (160 bytes), track OUTBOUND
async function sendUlawFrames(ws, streamSid, ulawBuf) {
  const BYTES_PER_FRAME = 160;
  let framesSent = 0;
  for (let off = 0; off < ulawBuf.length; off += BYTES_PER_FRAME) {
    if (ws.readyState !== ws.OPEN) break;
    let frame = ulawBuf.slice(off, Math.min(off + BYTES_PER_FRAME, ulawBuf.length));
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME, 0xFF);
      frame.copy(padded);
      frame = padded;
    }
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      track: "outbound",                   // REQUIRED by many accounts
      media: { payload: frame.toString("base64") }
    }));
    framesSent++;
    await new Promise(r => setTimeout(r, 20));
  }
  console.log(`[OUT-ULAW] framesSent=${framesSent} (~${framesSent * 20}ms)`);
}

// ----- WebSocket -----

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  let streamSid = null;

  ws.on("message", async (message) => {
    let msg;
    try { msg = JSON.parse(message.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("[WS] START streamSid:", streamSid);

      // small arm time
      setTimeout(async () => {
        // 2s silence then 1s 440Hz tone
        const ulaw = Buffer.concat([
          genUlawSilence(2000),
          genUlawTone(1000, 440)
        ]);
        if (ws.readyState === ws.OPEN && streamSid) {
          await sendUlawFrames(ws, streamSid, ulaw);
        }
      }, 250);
    } else if (msg.event === "media") {
      // ack inbound so Twilio keeps streaming
      if (msg.media?.sequenceNumber !== undefined) {
        ws.send(JSON.stringify({ event: "mark", mark: { name: `ack_${msg.media.sequenceNumber}` } }));
      }
    } else if (msg.event === "stop") {
      console.log("[WS] STOP");
    }
  });

  ws.on("close", () => console.log("🔌 WebSocket closed"));
  ws.on("error", (e) => console.error("[WS] ERROR", e));
});

// ----- HTTP/WS server -----

const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

app.get("/", (_req, res) => res.send("OK"));
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
