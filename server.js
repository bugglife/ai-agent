// server.js
// Node 18+ (uses global fetch / FormData / Blob)

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_STT_URL =
  process.env.ELEVEN_STT_URL || "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVEN_STT_MODEL_ID =
  process.env.ELEVEN_STT_MODEL_ID || "scribe_v1"; // <- your requested model

// Batching & filters
const FRAME_MS = 20;           // each Twilio frame ~20ms @ 8kHz µ-law
const CHUNK_MS = 1500;         // send to STT roughly every 1.5s
const FRAMES_PER_CHUNK = Math.round(CHUNK_MS / FRAME_MS);
const MIN_SPEECH_MS = 400;     // require ~0.4s of voiced audio per chunk
const MIN_SPEECH_FRAMES = Math.round(MIN_SPEECH_MS / FRAME_MS);
const SILENCE_RMS = 300;       // simple energy gate (0..32768)

// ---------- AUDIO HELPERS ----------

// µ-law (G.711) byte -> 16-bit PCM sample (approx)
function ulawByteToLinear(u) {
  u = ~u & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 1) + 1) << (exponent + 2);
  sample -= 33;
  sample = sign * sample;
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

// µ-law Buffer -> Int16Array PCM (8kHz mono)
function ulawToPcm16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) out[i] = ulawByteToLinear(ulawBuf[i]);
  return out;
}

// simple RMS
function rms(int16) {
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i];
    sum += v * v;
  }
  return Math.sqrt(sum / (int16.length || 1));
}

// make minimal WAV (PCM16, 8kHz mono)
function pcm16ToWavBytes(pcm16, sampleRate = 8000, numChannels = 1) {
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcm16.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcm16.length; i++) {
    buffer.writeInt16LE(pcm16[i], 44 + i * 2);
  }
  return buffer;
}

// ---------- STT CALL (multipart/form-data) ----------
async function sttMultipart(wavBuffer) {
  if (!ELEVEN_API_KEY) {
    console.warn("[STT] Missing ELEVEN_API_KEY");
    return null;
  }

  const form = new FormData();
  form.append("model_id", ELEVEN_STT_MODEL_ID); // REQUIRED by ElevenLabs
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");

  try {
    const resp = await fetch(ELEVEN_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_API_KEY }, // let fetch add Content-Type boundary
      body: form,
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      console.warn("[STT] HTTP", resp.status, bodyText);
      return null;
    }
    let data;
    try { data = JSON.parse(bodyText); } catch { data = { text: bodyText }; }
    const text = data.text || data.transcription || bodyText;
    return text;
  } catch (err) {
    console.error("[STT] Error:", err);
    return null;
  }
}

// ---------- SERVER ----------
const app = express();
app.get("/", (_req, res) => res.send("OK"));
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/stream" });

wss.on("connection", (ws, req) => {
  console.log("[WS] CONNECT from", req.socket.remoteAddress);
  console.log("[WS] headers:", req.headers);

  // per-connection state
  let framesSeen = 0;
  let voicedFrames = 0;
  let chunkPieces = [];      // Int16Array segments
  let processing = false;    // ensure ONE STT request at a time

  // keepalive pings so free-tier hosts don't time out the socket
  const keepalive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 15000);

  ws.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case "start": {
        console.log(`[WS] START callSid=${data.start?.callSid} streamSid=${data.start?.streamSid}`);
        framesSeen = 0;
        voicedFrames = 0;
        chunkPieces = [];
        processing = false;
        break;
      }

      case "media": {
        // One 20ms frame of μ-law audio
        const ulaw = Buffer.from(data.media.payload, "base64");
        const pcm16 = ulawToPcm16(ulaw);

        // Energy gate to reduce "white noise" / silence spam
        if (rms(pcm16) > SILENCE_RMS) {
          chunkPieces.push(pcm16);
          voicedFrames++;
        }
        framesSeen++;

        // Ack so Twilio keeps streaming
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: "mark", mark: { name: `ack_${data.media?.sequenceNumber}` } }));
        }

        // Every ~1.5s, if we have speech and not already processing, send ONE STT request
        if (framesSeen >= FRAMES_PER_CHUNK && !processing) {
          framesSeen = 0;

          if (voicedFrames < MIN_SPEECH_FRAMES) {
            // mostly silence; drop it
            voicedFrames = 0;
            chunkPieces = [];
            break;
          }

          processing = true;

          // Merge Int16 chunks into one Int16Array
          let total = 0;
          for (const seg of chunkPieces) total += seg.length;
          const merged = new Int16Array(total);
          let off = 0;
          for (const seg of chunkPieces) { merged.set(seg, off); off += seg.length; }

          const wav = pcm16ToWavBytes(merged, 8000, 1);
          const text = await sttMultipart(wav);

          // Log meaningful text
          if (text && !/^\s*\(?(silence|white noise|music|static)\)?\s*$/i.test(text)) {
            console.log(`[STT] ${text}`);
          }

          voicedFrames = 0;
          chunkPieces = [];
          processing = false;
        }
        break;
      }

      case "stop": {
        console.log("[WS] STOP");
        // Optional final flush (if any voiced audio remains and we're not processing)
        if (!processing && chunkPieces.length) {
          (async () => {
            let total = 0;
            for (const seg of chunkPieces) total += seg.length;
            const merged = new Int16Array(total);
            let off = 0;
            for (const seg of chunkPieces) { merged.set(seg, off); off += seg.length; }
            const wav = pcm16ToWavBytes(merged, 8000, 1);
            const text = await sttMultipart(wav);
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
