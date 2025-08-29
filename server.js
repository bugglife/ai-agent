import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const port = process.env.PORT || 10000;

/* -------------------------- health & root routes -------------------------- */
app.get("/", (_req, res) => {
  res.status(200).send("✅ Server is running. WebSocket endpoint: wss://<host>/stream");
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ---------------------------- WebSocket server ---------------------------- */
const server = app.listen(port, () => {
  console.log(`🚀 HTTP listening on ${port}`);
});

// we’ll mount the WS server at path /stream
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

/* -------------------------- Twilio stream handling ------------------------ */
/**
 * Twilio expects 8kHz μ-law audio in 20ms frames (160 samples -> 160 bytes).
 * We’ll generate a 1s 440Hz sine wave, μ-law encode it, and send it as 50 frames.
 */

function linearToMulaw(sample /* float -1..1 */) {
  // convert float to 16-bit PCM
  let pcm = Math.max(-1, Math.min(1, sample));
  pcm = pcm < 0 ? pcm * 32768 : pcm * 32767;
  let s = pcm | 0;

  // μ-law constants
  const SIGN_BIT = 0x80;
  const QUANT_MASK = 0x0f;
  const SEG_SHIFT = 4;
  const SEG_MASK = 0x70;

  let mask;
  if (s < 0) {
    s = -s;
    mask = SIGN_BIT;
  } else {
    mask = 0x00;
  }
  s += 0x84; // MU_LAW_BIAS = 132

  let seg = 0;
  for (let v = 0x400; (v & 0x7f00) !== 0x7f00; v <<= 1) {
    if (s <= v) break;
    seg++;
    if (seg >= 8) break;
  }

  let uval = (seg << SEG_SHIFT) | ((s >> (seg + 3)) & QUANT_MASK);
  return ~(uval ^ mask) & 0xff;
}

function makeBeepFrames({ seconds = 1.0, freq = 440, sampleRate = 8000 }) {
  const totalSamples = Math.floor(seconds * sampleRate);
  const frameSamples = 160; // 20ms @ 8kHz
  const frames = [];

  for (let i = 0; i < totalSamples; i += frameSamples) {
    const buf = new Uint8Array(frameSamples);
    for (let n = 0; n < frameSamples; n++) {
      const t = i + n;
      const s = Math.sin((2 * Math.PI * freq * t) / sampleRate); // sine wave
      buf[n] = linearToMulaw(s * 0.5); // moderate volume
    }
    frames.push(Buffer.from(buf).toString("base64"));
  }
  return frames;
}

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  let streamSid = null;

  ws.on("message", async (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn("⚠️ Non-JSON message, ignoring");
      return;
    }

    const evt = msg.event;
    if (evt === "start") {
      streamSid = msg.start?.streamSid;
      console.log("[WS] START", streamSid);

      // Send a 1-second beep back to the caller (50 frames * 20ms)
      const frames = makeBeepFrames({ seconds: 1.0, freq: 440 });
      for (const payload of frames) {
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload },
          })
        );
        await new Promise((r) => setTimeout(r, 20)); // pace at 20ms/frame
      }
    } else if (evt === "media") {
      // Incoming audio from caller (μ-law @ 8kHz) — fine to ignore for now
      // const pcmuBase64 = msg.media.payload;
    } else if (evt === "mark") {
      console.log("[WS] MARK", msg.mark?.name);
    } else if (evt === "stop") {
      console.log("[WS] STOP");
    } else {
      // Twilio sometimes sends `ping` (ignore), etc.
      // console.log("[WS] event:", evt);
    }
  });

  ws.on("close", () => console.log("👋 WS closed"));
  ws.on("error", (e) => console.error("WS error:", e));
});
