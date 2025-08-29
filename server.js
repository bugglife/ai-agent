// server.js
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";

// ElevenLabs STT JSON endpoint (expects base64 audio + model_id)
const ELEVEN_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVEN_STT_MODEL_ID = "eleven_monolingual_v1"; // or "eleven_multilingual_v1"

// batch size (~1.5s) so we don't spam the API
const CHUNK_MS = 1500;
const FRAME_MS = 20; // Twilio frames are 20ms
const FRAMES_PER_CHUNK = Math.round(CHUNK_MS / FRAME_MS);

// ---------- AUDIO HELPERS ----------

// µ-law (G.711 u-law) byte -> 16-bit PCM sample
function ulawByteToLinear(u) {
  u = ~u & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 1) + 1) << (exponent + 2);
  sample -= 33; // bias
  sample = sign * sample;
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

// Convert a Buffer of µ-law bytes -> Int16Array PCM (8kHz mono)
function ulawToPcm16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) {
    out[i] = ulawByteToLinear(ulawBuf[i] & 0xff);
  }
  return out;
}

// Make a minimal WAV (PCM16, 8kHz, mono) from Int16Array
function pcm16ToWavBytes(pcm16, sampleRate = 8000, numChannels = 1) {
  const byteRate = sampleRate * numChannels * 2; // 16-bit
  const blockAlign = numChannels * 2;
  const dataSize = pcm16.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20);  // audio format = PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

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

// Node 18+ has global fetch; if on older Node, add `node-fetch`
async function sendToElevenLabsSTT(wavBuffer) {
  if (!ELEVEN_API_KEY) {
    console.warn("[STT] Missing ELEVEN_API_KEY");
    return null;
  }

  // ElevenLabs JSON STT expects base64 audio + model_id
  const base64 = wavBuffer.toString("base64");

  try {
    const resp = await fetch(ELEVEN_STT_URL, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model_id: ELEVEN_STT_MODEL_ID, // REQUIRED
        audio: base64
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn("[STT] HTTP", resp.status, text);
      return null;
    }

    const data = await resp.json();
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

  let frameCount = 0;
  let chunkSamples = []; // Int16Array pieces

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
        // Decode current 20ms frame from base64 µ-law
        const ulaw = Buffer.from(data.media.payload, "base64");
        const pcm16 = ulawToPcm16(ulaw);
        chunkSamples.push(pcm16);
        frameCount++;

        // Ack to keep Twilio happy
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: "mark", mark: { name: `ack_${data.media?.sequenceNumber}` }}));
        }

        // Every ~1.5s, send a chunk to STT
        if (frameCount >= FRAMES_PER_CHUNK) {
          let total = 0;
          for (const seg of chunkSamples) total += seg.length;
          const merged = new Int16Array(total);
          let off = 0;
          for (const seg of chunkSamples) { merged.set(seg, off); off += seg.length; }

          const wav = pcm16ToWavBytes(merged, 8000, 1);
          const text = await sendToElevenLabsSTT(wav);
          if (text) console.log(`[STT] ${text}`);

          // reset
          frameCount = 0;
          chunkSamples = [];
        }
        break;
      }

      case "stop": {
        console.log("[WS] STOP");
        // Flush any remainder
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
