import http from "http";
import { WebSocketServer } from "ws";

// Twilio will connect to wss://<your-host>/stream
const PORT = process.env.PORT || 10000;
const WS_PATH = "/stream";

// ---- μ-law encoder (G.711) ----
function linearToULaw(sample) {
  // sample: 16-bit signed PCM (-32768..32767)
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  let mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulawByte;
}

// Generate one 20ms frame of μ-law tone (8kHz, 160 samples)
function toneFrameULaw(freqHz = 440, phaseRef = 0) {
  const SR = 8000;          // sample rate
  const N = 160;            // 20ms
  const TWO_PI = 2 * Math.PI;
  const frame = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    const t = (phaseRef + i) / SR;
    // Sine @ ~ -12 dBFS for headroom
    const pcm = Math.round(10000 * Math.sin(TWO_PI * freqHz * t));
    frame[i] = linearToULaw(pcm);
  }
  return frame;
}

// ---- HTTP + WS server ----
const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  // Keep-alive (so Twilio doesn’t drop us)
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  const pingIv = setInterval(() => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }, 25000);

  // Send a 440Hz tone: 20ms frames, every 20ms
  let phase = 0;
  const SR = 8000;
  const N = 160;
  const sendIv = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    const frame = toneFrameULaw(440, phase);
    phase += N; // advance phase by 20ms worth of samples
    const b64 = Buffer.from(frame).toString("base64");
    ws.send(JSON.stringify({ event: "media", media: { payload: b64 } }));
  }, 20);

  ws.on("message", (data) => {
    // Optional: log Twilio messages (start/media/stop)
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "start") console.log("[WS] START", msg.streamSid);
      if (msg.event === "media") {/* inbound audio from caller */}
      if (msg.event === "stop") console.log("[WS] STOP");
    } catch {}
  });

  ws.on("close", () => {
    clearInterval(sendIv);
    clearInterval(pingIv);
    console.log("👋 WebSocket closed");
  });

  ws.on("error", (e) => console.error("WS error:", e.message));
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT} (ws path: ${WS_PATH})`);
});
