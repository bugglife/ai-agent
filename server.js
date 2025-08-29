import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const WS_PATH = "/stream";

// ---- μ-law (G.711) encoder ----
function linearToULaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

function toneFrameULaw(freqHz = 440, startSample = 0) {
  const SR = 8000, N = 160, TWO_PI = 2 * Math.PI;
  const u = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = (startSample + i) / SR;
    const pcm = Math.round(10000 * Math.sin(TWO_PI * freqHz * t)); // headroom
    u[i] = linearToULaw(pcm);
  }
  return u;
}

// HTTP server (health)
const httpServer = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end("not found");
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== WS_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch { socket.destroy(); }
});

wss.on("connection", (ws) => {
  console.log("🔗 WS connected");

  // keep-alive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  const pingIv = setInterval(() => {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }, 25000);

  // send 20ms μ-law frames forever
  let samplePtr = 0;
  const sendIv = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    const frame = toneFrameULaw(440, samplePtr);     // 440 Hz
    samplePtr += 160;                                // 20ms at 8kHz
    const b64 = Buffer.from(frame).toString("base64");
    ws.send(JSON.stringify({ event: "media", media: { payload: b64 } }));
  }, 20);

  ws.on("message", (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.event === "start") console.log("[WS] START", m.streamSid);
      if (m.event === "stop")  console.log("[WS] STOP");
    } catch {}
  });

  ws.on("close", () => { clearInterval(sendIv); clearInterval(pingIv); console.log("👋 WS closed"); });
  ws.on("error", (e) => console.log("WS error:", e.message));
});

httpServer.listen(PORT, () => console.log(`🚀 Listening on ${PORT} (ws path ${WS_PATH})`));
