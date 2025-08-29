// server.js — Twilio <-> ElevenLabs STT + TTS (echo reply, mu-law 8 kHz)
// Node 18+ (global fetch/FormData/Blob)

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;

// ElevenLabs
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_STT_URL =
  process.env.ELEVEN_STT_URL || "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVEN_STT_MODEL_ID =
  process.env.ELEVEN_STT_MODEL_ID || "scribe_v1";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
const ELEVEN_TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

// Batching & filters
const FRAME_MS = 20;            // Twilio frames are ~20ms @ 8kHz
const CHUNK_MS = 1500;          // STT every ~1.5s
const FRAMES_PER_CHUNK = Math.round(CHUNK_MS / FRAME_MS);
const MIN_SPEECH_MS = 400;      // need ~0.4s voiced audio per chunk
const MIN_SPEECH_FRAMES = Math.round(MIN_SPEECH_MS / FRAME_MS);
const SILENCE_RMS = 300;        // rough energy gate

// ---------- AUDIO HELPERS (μ-law <-> PCM16) ----------

// μ-law byte -> 16-bit PCM sample (approx)
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

// μ-law Buffer -> Int16Array PCM (8kHz mono)
function ulawToPcm16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) out[i] = ulawByteToLinear(ulawBuf[i]);
  return out;
}

// PCM16 -> WAV buffer (8kHz mono)
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

// simple RMS meter
function rms(int16) {
  let sum = 0;
  for (let i = 0; i < int16.length; i++) sum += int16[i] * int16[i];
  return Math.sqrt(sum / (int16.length || 1));
}

// ---------- ElevenLabs STT (multipart/form-data) ----------
async function sttMultipart(wavBuffer) {
  if (!ELEVEN_API_KEY) {
    console.warn("[STT] Missing ELEVEN_API_KEY");
    return null;
  }

  const form = new FormData();
  form.append("model_id", ELEVEN_STT_MODEL_ID); // REQUIRED
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");

  try {
    const resp = await fetch(ELEVEN_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_API_KEY },
      body: form
    });
    const textBody = await resp.text();
    if (!resp.ok) {
      console.warn("[STT] HTTP", resp.status, textBody);
      return null;
    }
    let data;
    try { data = JSON.parse(textBody); } catch { data = { text: textBody }; }
    return data.text || data.transcription || textBody;
  } catch (err) {
    console.error("[STT] Error:", err);
    return null;
  }
}

// ---------- ElevenLabs TTS -> μ-law 8 kHz (no re-encode) ----------
async function ttsUlaw8k(text) {
  if (!ELEVEN_API_KEY) {
    console.warn("[TTS] Missing ELEVEN_API_KEY");
    return null;
  }
  const body = {
    text,
    // voice_settings: { stability: 0.4, similarity_boost: 0.8 },
    output_format: "ulaw_8000" // μ-law @ 8 kHz (may come as WAV)
  };

  try {
    const resp = await fetch(ELEVEN_TTS_URL, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/octet-stream"
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const errTxt = await resp.text();
      console.warn("[TTS] HTTP", resp.status, errTxt);
      return null;
    }
    const arrayBuf = await resp.arrayBuffer();
    const raw = Buffer.from(arrayBuf);
    return extractWavDataIfNeeded(raw); // <-- strip WAV header if present
  } catch (err) {
    console.error("[TTS] Error:", err);
    return null;
  }
}


// Split μ-law 8kHz into exact 160-byte frames, mark as outbound, pace at 20ms
async function sendUlawFramesToTwilio(ws, streamSid, ulawBuf) {
  const BYTES_PER_FRAME = 160; // 20ms @ 8kHz μ-law
  const SILENCE = 0xFF;       // μ-law silence

  for (let offset = 0; offset < ulawBuf.length; offset += BYTES_PER_FRAME) {
    if (ws.readyState !== ws.OPEN) break;

    let frame = ulawBuf.slice(offset, Math.min(offset + BYTES_PER_FRAME, ulawBuf.length));

    // Pad last frame to exactly 160 bytes
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME, SILENCE);
      frame.copy(padded, 0);
      frame = padded;
    }

    const payload = frame.toString("base64");
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload, track: "outbound" } // <-- IMPORTANT
    }));

    await new Promise(r => setTimeout(r, 20));
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

  let streamSid = null;
  let framesSeen = 0;
  let voicedFrames = 0;
  let chunkPieces = []; // Int16Array segments
  let sttBusy = false;
  let ttsBusy = false;

  // keepalive
  const keepalive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 15000);

  ws.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case "start": {
        streamSid = data.start?.streamSid || null;
        console.log(`[WS] START callSid=${data.start?.callSid} streamSid=${streamSid}`);
        framesSeen = 0;
        voicedFrames = 0;
        chunkPieces = [];
        sttBusy = false;
        break;
      }

      case "media": {
        // inbound 20ms μ-law frame from Twilio
        const ulaw = Buffer.from(data.media.payload, "base64");
        const pcm16 = ulawToPcm16(ulaw);

        // energy gate
        if (rms(pcm16) > SILENCE_RMS) {
          chunkPieces.push(pcm16);
          voicedFrames++;
        }
        framesSeen++;

        // keep Twilio happy
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: "mark", mark: { name: `ack_${data.media?.sequenceNumber}` }}));
        }

        // every ~1.5s, if we have speech and not already processing, send ONE STT request
        if (framesSeen >= FRAMES_PER_CHUNK && !sttBusy) {
          framesSeen = 0;

          if (voicedFrames < MIN_SPEECH_FRAMES) {
            voicedFrames = 0;
            chunkPieces = [];
            break;
          }

          sttBusy = true;

          // merge Int16 chunks
          let total = 0;
          for (const seg of chunkPieces) total += seg.length;
          const merged = new Int16Array(total);
          let off = 0;
          for (const seg of chunkPieces) { merged.set(seg, off); off += seg.length; }

          const wav = pcm16ToWavBytes(merged, 8000, 1);
          const text = await sttMultipart(wav);

          // reset for next window
          voicedFrames = 0;
          chunkPieces = [];
          sttBusy = false;

          if (text && !/^\s*\(?(silence|white noise|music|static|sighs?)\)?\s*$/i.test(text)) {
            console.log(`[STT] ${text}`);

            // --- SIMPLE ECHO BACK VIA TTS (ulaw_8000 direct) ---
            if (!ttsBusy && streamSid) {
              ttsBusy = true;
              (async () => {
                const toSay = `You said: ${text}`;
                const ulawOut = await ttsUlaw8k(toSay);
                if (ulawOut) {
                  await sendUlawFramesToTwilio(ws, streamSid, ulawOut);
                }
                ttsBusy = false;
              })();
            }
          }
        }
        break;
      }

      case "stop": {
        console.log("[WS] STOP");
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
