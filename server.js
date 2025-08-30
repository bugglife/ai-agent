// server.js
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // Rachel

// ❗ Create the WS server (this was missing)
const wss = new WebSocketServer({ noServer: true });

// Twilio Voice Media Stream expects PCMU (G.711 µ-law), 8kHz, mono.
const FRAME_MS = 20;
const BYTES_PER_FRAME = 160;

// ---------- Utilities ----------
function log(...args) {
  console.log(...args);
}

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

function downsample16kTo8k(int16Arr) {
  const out = new Int16Array(Math.floor(int16Arr.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = int16Arr[i];
  return out;
}

function pcm16ToMuLaw8k(linear16Buf, sourceSampleRate) {
  const int16 = new Int16Array(
    linear16Buf.buffer,
    linear16Buf.byteOffset,
    linear16Buf.byteLength / 2
  );
  let eightK;

  if (sourceSampleRate === 8000) {
    eightK = int16;
  } else if (sourceSampleRate === 16000) {
    eightK = downsample16kTo8k(int16);
  } else {
    eightK = downsample16kTo8k(int16);
  }

  const out = Buffer.alloc(eightK.length);
  for (let i = 0; i < eightK.length; i++) {
    out[i] = linearToMuLaw(eightK[i]);
  }
  return out;
}

async function sendMuLawPaced(ws, streamSid, ulawBuffer, label = "audio") {
  const frames = [];
  for (let i = 0; i < ulawBuffer.length; i += BYTES_PER_FRAME) {
    frames.push(ulawBuffer.subarray(i, i + BYTES_PER_FRAME));
  }

  log(`[OUT] ${label}: frames=${frames.length} (~${frames.length * FRAME_MS}ms)`);
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

  try {
    ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `end:${label}` } }));
  } catch {}

  log(`[OUT] ${label}: framesSent=${sent}`);
}

function generateBeepMuLaw(durationMs = 600, freqHz = 440) {
  const sampleRate = 8000;
  const totalSamples = Math.floor((durationMs / 1000) * sampleRate);
  const ulaw = Buffer.alloc(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const amp = Math.sin(2 * Math.PI * freqHz * t) * 0.5; // -6 dBFS
    const s16 = Math.trunc(amp * 32767);
    ulaw[i] = linearToMuLaw(s16);
  }
  return ulaw;
}

// ---------- ElevenLabs (PCM) ----------
async function ttsPcm(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/octet-stream",
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      output_format: "pcm_16000",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${body}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

// ---------- WebSocket handling ----------
wss.on("connection", (ws) => {
  log("🔗 WebSocket connected");
  let streamSid = null;
  let heardOnce = false;

  async function say(text, tag) {
    if (!streamSid) return;
    try {
      const pcm16 = await ttsPcm(text);
      log(`[TTS] bytes (pcm16/16k)=${pcm16.length}`);
      const ulaw = pcm16ToMuLaw8k(pcm16, 16000);
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
        // test beep
        await sendMuLawPaced(ws, streamSid, generateBeepMuLaw(600, 440), "beep");
        // greeting
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
        try { ws.close(); } catch {}
        break;
    }
  });

  ws.on("close", () => log("👋 WS closed"));
});

// ---------- HTTP + Upgrade ----------
app.get("/", (_req, res) => res.status(200).send("✅ Server OK. WS at /stream"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = app.listen(port, () => log(`🚀 Server running on port ${port}`));

server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/stream")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
