// server.js
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // Rachel

// Twilio Voice Media Stream expects PCMU (G.711 µ-law), 8kHz, mono.
// We'll generate 20ms frames = 160 bytes each.
const FRAME_MS = 20;
const BYTES_PER_FRAME = 160;

// ---------- Utilities ----------

function log(...args) {
  console.log(...args);
}

// µ-law encode a single 16-bit linear PCM sample
// (Standard ITU-T G.711 µ-law)
function linearToMuLaw(sample) {
  const MAX = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MAX) sample = MAX;

  let exponent = 7;
  for (let expMask = 0x4000, i = 7; i > 0; i--, expMask >>= 1) {
    if (sample & expMask) {
      exponent = i;
      break;
    }
  }
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let ulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulaw;
}

// Downsample PCM16 from 16k -> 8k by dropping every other sample
function downsample16kTo8k(int16Arr) {
  const out = new Int16Array(Math.floor(int16Arr.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = int16Arr[i];
  return out;
}

// Convert PCM16 buffer (mono) to µ-law Buffer at 8kHz
function pcm16ToMuLaw8k(linear16Buf, sourceSampleRate) {
  // Interpret incoming as 16-bit signed little-endian
  const int16 = new Int16Array(linear16Buf.buffer, linear16Buf.byteOffset, linear16Buf.byteLength / 2);
  let eightK;

  if (sourceSampleRate === 8000) {
    eightK = int16;
  } else if (sourceSampleRate === 16000) {
    eightK = downsample16kTo8k(int16);
  } else {
    // crude fallback: assume 16k
    eightK = downsample16kTo8k(int16);
  }

  const out = Buffer.alloc(eightK.length);
  for (let i = 0; i < eightK.length; i++) {
    out[i] = linearToMuLaw(eightK[i]);
  }
  return out;
}

// Pace a µ-law buffer into 160-byte frames every 20ms with streamSid
async function sendMuLawPaced(ws, streamSid, ulawBuffer, label = "audio") {
  // Frame into 160 byte chunks
  const frames = [];
  for (let i = 0; i < ulawBuffer.length; i += BYTES_PER_FRAME) {
    frames.push(ulawBuffer.subarray(i, i + BYTES_PER_FRAME));
  }

  log(`[OUT] ${label}: frames=${frames.length} (~${frames.length * FRAME_MS}ms)`);

  // Tiny settle delay helps some endpoints
  await new Promise((r) => setTimeout(r, 80));

  let sent = 0;
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || sent >= frames.length) {
        clearInterval(t);
        return resolve();
      }
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: frames[sent].toString("base64") },
        })
      );
      sent++;
    }, FRAME_MS);
  });

  // mark end (optional)
  try {
    ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `end:${label}` } }));
  } catch {}

  log(`[OUT] ${label}: framesSent=${sent}`);
}

// Generate a 1s 440Hz test beep in µ-law @8k
function generateBeepMuLaw(durationMs = 1000, freqHz = 440) {
  const sampleRate = 8000;
  const totalSamples = Math.floor((durationMs / 1000) * sampleRate);
  const ulaw = Buffer.alloc(totalSamples);

  // Generate sine wave as linear PCM then µ-law encode
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const amp = Math.sin(2 * Math.PI * freqHz * t);
    // 16-bit range
    const sample = Math.max(-1, Math.min(1, amp)) * 0.5; // scale down to avoid clipping
    const s16 = Math.trunc(sample * 32767);
    ulaw[i] = linearToMuLaw(s16);
  }

  return ulaw;
}

// ---------- ElevenLabs (PCM) ----------
// We request raw PCM at 16kHz and convert locally to µ-law 8k.
async function ttsPcm(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      // octet-stream ensures we get raw data; we’ll set output_format below
      Accept: "application/octet-stream",
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      output_format: "pcm_16000", // RAW 16k mono 16-bit PCM
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${body}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr); // raw PCM16 @ 16kHz
}

wss.on("connection", (ws) => {
  log("🔗 WebSocket connected");
  let streamSid = null;
  let heardOnce = false;

  async function say(text, tag) {
    if (!streamSid) return;
    try {
      // 1) Get PCM 16k from ElevenLabs
      const pcm16 = await ttsPcm(text);
      log(`[TTS] bytes (pcm16/16k)=${pcm16.length}`);

      // 2) Convert to µ-law 8k
      const ulaw = pcm16ToMuLaw8k(pcm16, 16000);

      // 3) Pace to Twilio
      await sendMuLawPaced(ws, streamSid, ulaw, tag || "tts");
    } catch (e) {
      console.error("[TTS] error:", e.message);
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "connected":
        log("[WS-IN] connected", JSON.stringify({ protocol: msg.protocol, version: msg.version }));
        break;

      case "start":
        streamSid = msg.start?.streamSid;
        log(`🚀 START streamSid: ${streamSid}`);

        // Send a short, clean test beep first — if you hear this,
        // transport & encoding are correct.
        {
          const beep = generateBeepMuLaw(600, 440);
          await sendMuLawPaced(ws, streamSid, beep, "beep");
        }

        // Now the spoken greeting
        await say("Hello. I am online. Say something and I will reply.", "greeting");
        break;

      case "media":
        if (!heardOnce && streamSid) {
          heardOnce = true;
          await say("Got it. I hear you.", "heard");
        }
        break;

      case "stop":
        log("🛑 WS stop");
        try {
          ws.close();
        } catch {}
        break;
    }
  });

  ws.on("close", () => log("👋 WS closed"));
});

// Health routes
app.get("/", (_req, res) => res.status(200).send("✅ Server OK. WS at /stream"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = app.listen(port, () => log(`🚀 Server running on port ${port}`));

// Only upgrade /stream to WS
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/stream")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
