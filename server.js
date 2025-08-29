// server.js — Twilio ↔ ElevenLabs STT + TTS (echo reply)
// Node 18+ (global fetch/FormData/Blob)

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;

// ElevenLabs
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_STT_URL = process.env.ELEVEN_STT_URL || "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVEN_STT_MODEL_ID = process.env.ELEVEN_STT_MODEL_ID || "scribe_v1";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel (public sample voice)
const ELEVEN_TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

// batching & filters
const FRAME_MS = 20;           // Twilio frames are ~20ms @ 8kHz
const CHUNK_MS = 1500;         // STT every ~1.5s
const FRAMES_PER_CHUNK = Math.round(CHUNK_MS / FRAME_MS);
const MIN_SPEECH_MS = 400;     // require ~0.4s voiced audio in a chunk
const MIN_SPEECH_FRAMES = Math.round(MIN_SPEECH_MS / FRAME_MS);
const SILENCE_RMS = 300;       // rough energy gate (0..32768)

// ---------- AUDIO HELPERS: μ-law <-> PCM16 ----------

// Decode μ-law Byte -> 16-bit PCM sample
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

// Encode 16-bit PCM sample -> μ-law Byte
function linearToUlaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
  const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulaw;
}

// μ-law Buffer -> Int16Array PCM (8kHz mono)
function ulawToPcm16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) out[i] = ulawByteToLinear(ulawBuf[i]);
  return out;
}

// PCM16 Int16Array -> WAV buffer (8kHz, mono)
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

// Simple RMS
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
  form.append("model_id", ELEVEN_STT_MODEL_ID);     // REQUIRED
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

// ---------- ElevenLabs TTS -> PCM 8 kHz ----------
async function ttsPcm8k(text) {
  if (!ELEVEN_API_KEY) {
    console.warn("[TTS] Missing ELEVEN_API_KEY");
    return null;
  }
  const body = {
    text,
    // optional: tweak voice style using voice_settings
    // voice_settings: { stability: 0.4, similarity_boost: 0.8 },
    // Ask for raw 8 kHz PCM so it maps cleanly to phone audio
    output_format: "pcm_8000"
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
    return Buffer.from(arrayBuf); // raw PCM16 LE, 8000 Hz, mono
  } catch (err) {
    console.error("[TTS] Error:", err);
    return null;
  }
}

// Split a PCM16 buffer (8kHz) into μ-law 20ms frames (base64 payloads ready for Twilio)
function pcm16ToUlawFramesBase64(pcm16Buf) {
  // 20ms at 8kHz => 160 samples (Int16) => 320 bytes PCM16
  const SAMPLES_PER_FRAME = 160;
  const totalSamples = pcm16Buf.length / 2; // bytes -> samples
  const frames = [];
  for (let startSample = 0; startSample < totalSamples; startSample += SAMPLES_PER_FRAME) {
    const endSample = Math.min(startSample + SAMPLES_PER_FRAME, totalSamples);
    const frameSamples = endSample - startSample;

    // Read PCM16 little-endian samples
    const framePCM = new Int16Array(frameSamples);
    for (let i = 0; i < frameSamples; i++) {
      framePCM[i] = pcm16Buf.readInt16LE((startSample + i) * 2);
    }

    // Encode to μ-law
    const ulaw = Buffer.alloc(frameSamples);
    for (let i = 0; i < frameSamples; i++) {
      ulaw[i] = linearToUlaw(framePCM[i]);
    }
    frames.push(ulaw.toString("base64"));
  }
  return frames;
}

// Send μ-law frames back to Twilio as 20ms "media" events
async function sendFramesToTwilio(ws, streamSid, base64Frames) {
  for (const payload of base64Frames) {
    if (ws.readyState !== ws.OPEN) break;
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
    // Pace frames ~20ms to match real-time
    await new Promise((r) => setTimeout(r, 20));
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
  let chunkPieces = [];     // Int16Array segments
  let sttBusy = false;      // prevent overlapping STT calls
  let ttsBusy = false;      // prevent overlapping TTS sends

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

        // Energy gate
        if (rms(pcm16) > SILENCE_RMS) {
          chunkPieces.push(pcm16);
          voicedFrames++;
        }
        framesSeen++;

        // Keep Twilio happy
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: "mark", mark: { name: `ack_${data.media?.sequenceNumber}` }}));
        }

        // Every ~1.5s try an STT chunk
        if (framesSeen >= FRAMES_PER_CHUNK && !sttBusy) {
          framesSeen = 0;

          if (voicedFrames < MIN_SPEECH_FRAMES) {
            voicedFrames = 0;
            chunkPieces = [];
            break;
          }

          sttBusy = true;

          // Merge Int16 chunks
          let total = 0;
          for (const seg of chunkPieces) total += seg.length;
          const merged = new Int16Array(total);
          let off = 0;
          for (const seg of chunkPieces) { merged.set(seg, off); off += seg.length; }

          const wav = pcm16ToWavBytes(merged, 8000, 1);
          const text = await sttMultipart(wav);

          // Reset for next window
          voicedFrames = 0;
          chunkPieces = [];
          sttBusy = false;

          if (text && !/^\s*\(?(silence|white noise|music|static|sighs?)\)?\s*$/i.test(text)) {
            console.log(`[STT] ${text}`);

            // --- SIMPLE ECHO BACK VIA TTS ---
            if (!ttsBusy && streamSid) {
              ttsBusy = true;
              (async () => {
                const toSay = `You said: ${text}`;
                const pcm = await ttsPcm8k(toSay);
                if (pcm) {
                  const frames = pcm16ToUlawFramesBase64(pcm);
                  await sendFramesToTwilio(ws, streamSid, frames);
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
