// server.js - Minimal Twilio Media Streams bridge that plays a 440 Hz beep in G.711 u-law.

// Node 18+ required on Render
import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const port = process.env.PORT || 10000;

// ---- μ-law encoder (16-bit PCM -> 8-bit μ-law) ----
function linear16ToULaw(sample) {
  // clamp to 16-bit
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;

  const BIAS = 0x84; // 132
  const CLIP = 32635;

  let sign = (sample >> 8) & 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;

  sample = sample + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let ulawByte = ~(sign | (exponent << 4) | mantissa);
  return ulawByte & 0xFF;
}

// Generate one 20ms frame (160 samples) of μ-law for a sine tone
function makeToneFrameULaw({ freq = 440, sampleRate = 8000, amplitude = 0.25, phase = 0 }) {
  const frameLen = 160; // 20ms at 8kHz
  const buf = Buffer.alloc(frameLen);
  for (let i = 0; i < frameLen; i++) {
    const t = (phase + i) / sampleRate;
    // 16-bit PCM sample
    const s = Math.sin(2 * Math.PI * freq * t) * (amplitude * 32767);
    const s16 = Math.max(-32768, Math.min(32767, Math.round(s)));
    buf[i] = linear16ToULaw(s16);
  }
  return { frame: buf, nextPhase: phase + frameLen };
}

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WS connected");

  let phase = 0;
  let framesSent = 0;
  let toneTimer = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Twilio sends { event: "start" } first
    if (msg.event === "start") {
      console.log("[WS] START", msg.start?.streamSid || "");
      // Send ~3 seconds of tone: 3s / 20ms = 150 frames
      const framesToSend = 150;

      toneTimer = setInterval(() => {
        const { frame, nextPhase } = makeToneFrameULaw({ phase });
        phase = nextPhase;
        ws.send(JSON.stringify({
          event: "media",
          media: { payload: frame.toString("base64") }
        }));
        framesSent++;
        if (framesSent >= framesToSend) {
          clearInterval(toneTimer);
          // optional: stop the stream, or let Twilio keep it open
          // ws.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
        }
      }, 20); // 20ms per frame
    }

    if (msg.event === "stop") {
      console.log("[WS] STOP");
      if (toneTimer) clearInterval(toneTimer);
      // Twilio will close the socket shortly after
    }

    // You can also observe inbound audio chunks:
    // if (msg.event === "media") console.log("[INBOUND]", msg.media?.payload?.length);
  });

  ws.on("close", () => {
    if (toneTimer) clearInterval(toneTimer);
    console.log("👋 WS closed");
  });
});

const server = app.listen(port, () => {
  console.log(`🚀 Server on :${port} (ws path: /stream)`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
