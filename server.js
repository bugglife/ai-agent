// server.js
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
// If your account/docs show a different endpoint, update here:
const ELEVEN_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

// How much audio to batch per STT request (ms)
const CHUNK_MS = 1500;

// Twilio media frames: 20ms each at 8kHz µ-law
const FRAME_MS = 20;
const FRAMES_PER_CHUNK = Math.round(CHUNK_MS / FRAME_MS);

// ---------- AUDIO HELPERS ----------

// µ-law (G.711 u-law) byte -> 16-bit PCM sample
function ulawByteToLinear(u_val) {
  // u_val is 0..255
  u_val = ~u_val & 0xff;
  const sign = (u_val & 0x80) ? -1 : 1;
  let exponent = (u_val >> 4) & 0x07;
  let mantissa = u_val & 0x0f;
  let sample = ((mantissa << 1) + 1) << (exponent + 2);
  sample -= 33; // bias (approx)
  return sign * sample; // 13-bit-ish -> we’ll clamp later
}

// Convert a Buffer of µ-law bytes -> Int16Array PCM at 8kHz mono
function ulawToPcm16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) {
    let s = ulawByteToLinear(ulawBuf[i] & 0xff);
    // clamp to 16-bit
    if (s > 32767) s = 32767;
    if (s < -32768) s = -32768;
    out[i] = s;
  }
  return out;
}

// Create a minimal WAV (PCM16, 8kHz, mono) from Int16Array
function pcm16ToWavBytes(pcm16, sampleRate = 8000, numChannels = 1) {
  const byteRate = sampleRate * numChannels * 2; // 16-bit
  const blockAlign = numChannels * 2;
  const dataSize = pcm16.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt  subchunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM header length
  buffer.writeUInt16LE(1, 20);  // PCM = 1
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample

  // data subchunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // samples
  for (let i = 0; i < pcm16.length; i++) {
    buffer.writeInt16LE(pcm16[i], 44 + i * 2);
  }
  return buffer;
}

// ---------- SERVER ----------
const app = express();
app.get("/", (_req, res) => res.send("OK"));
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/stream" });

// For Node < 18, you may need: import fetch from "node-fetch";
async function sendToElevenLabsSTT(wavBuffer) {
  if (!ELEVEN_API_KEY) {
    console.warn("[STT] Missing ELEVEN_API_KEY");
    return null;
  }

  try {
    const resp = await fetch(ELEVEN_STT_URL, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "audio/wav"
      },
      body: wavBuffer
    });

    if (!resp.ok) {
      const t = await resp.text();
      console.warn("[STT] HTTP", resp.status, t);
      return null;
    }

    const data = await resp.json();
    // Many STT APIs return { text: "..." } or { transcription: "..." }
    const text = data.text || data.transcription || JSON.stringify(data);
    return text;
  } catch (err) {
    console.error("[STT] Error:", err);
    return null;
  }
}

wss.on("connection", (ws, req) => {
  console.log("[WS] CONNECT from", req.socket.remoteAddress);
  console.log("[WS] headers:", req.headers);

  // Buffer for ~1.5s chunks
  let frameCount = 0;
  let chunkSamples = []; // array of Int16Array segments

  const keepalive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 15000);

  ws.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case "start": {
        console.log(`[WS] START callSid=${data.start?.callSid} streamSid=${data.start?.streamSid}`);
        frameCount = 0;
        chunkSamples = [];
        break;
      }

      case "media": {
        // Log a little so you can see traffic
        // console.log(`[WS] MEDIA seq=${data.media?.sequenceNumber} size=${data.media?.payload?.length}`);

        // 1) decode ulaw frame
        const ulaw = Buffer.from(data.media.payload, "base64");
        const pcm16 = ulawToPcm16(ulaw);
        chunkSamples.push(pcm16);
        frameCount++;

        // 2) keepalive ack so Twilio keeps streaming
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: "mark", mark: { name: `ack_${data.media?.sequenceNumber}` }}));
        }

        // 3) every ~1.5s, concat + send to STT
        if (frameCount >= FRAMES_PER_CHUNK) {
          // concat Int16Arrays
          let total = 0;
          for (const seg of chunkSamples) total += seg.length;
          const merged = new Int16Array(total);
          let off = 0;
          for (const seg of chunkSamples) { merged.set(seg, off); off += seg.length; }

          const wav = pcm16ToWavBytes(merged, 8000, 1);
          const text = await sendToElevenLabsSTT(wav);
          if (text) console.log(`[STT] ${text}`);

          // reset buffer
          frameCount = 0;
          chunkSamples = [];
        }
        break;
      }

      case "stop": {
        console.log("[WS] STOP");
        // Flush any remainder (optional)
        if (chunkSamples.length) {
          (async () => {
            let total = 0;
            for (const seg of chunkSamples) total += seg.length;
            const merged = new Int16Array(total);
            let off = 0;
            for (const seg of chunkSamples) { merged.set(seg, off); off += seg.length; }
            const wav = pcm16ToWavBytes(merged, 8000, 1);
            const text = await sendToElevenLabsSTT(wav);
            if (text) console.log(`[STT][final] ${text}`);
          })();
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(keepalive);
    console.log(`[WS] CLOSE code=${code} reason=${reason}`);
  });

  ws.on("error", (err) => {
    console.error("[WS] ERROR", err);
  });
});

httpServer.listen(PORT, () =>
  console.log(`Server running on port ${PORT} (ws path: /stream)`)
);
