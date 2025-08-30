import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;

const wss = new WebSocketServer({ noServer: true });
// server.js — Inbound-only stream + Call Update to play TTS, then resume streaming
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import twilio from "twilio";

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g. https://ai-agent-63p0.onrender.com
const STREAM_WS_URL = `${PUBLIC_BASE_URL.replace("https", "wss")}/stream`;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
const ELEVEN_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVEN_STT_MODEL_ID = "scribe_v1";

const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ---------- Simple audio serving (for <Play>) ----------
const memAudio = new Map(); // id -> Buffer (MP3)

const app = express();
app.get("/", (_, res) => res.send("OK"));
app.get("/tts/:id.mp3", (req, res) => {
  const buf = memAudio.get(req.params.id);
  if (!buf) return res.status(404).end();
  res.set("Content-Type", "audio/mpeg");
  res.send(buf);
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/stream" });

// ---------- Minimal ulaw -> PCM16 to build WAV for STT ----------
function ulawByteToLinear(u) {
  u = ~u & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let s = ((mant << 1) + 1) << (exp + 2);
  s -= 33;
  s = sign * s;
  if (s > 32767) s = 32767;
  if (s < -32768) s = -32768;
  return s;
}
function ulawToPcm16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) out[i] = ulawByteToLinear(ulawBuf[i]);
  return out;
}
function pcm16ToWavBytes(pcm16, sampleRate = 8000) {
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcm16.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm16.length; i++) buf.writeInt16LE(pcm16[i], 44 + i * 2);
  return buf;
}

// ---------- ElevenLabs STT (multipart) ----------
async function sttMultipart(wavBuffer) {
  const form = new FormData();
  form.append("model_id", ELEVEN_STT_MODEL_ID);
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
  const resp = await fetch(ELEVEN_STT_URL, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_API_KEY },
    body: form
  });
  const txt = await resp.text();
  if (!resp.ok) { console.warn("[STT] HTTP", resp.status, txt); return null; }
  try { return (JSON.parse(txt).text) || txt; } catch { return txt; }
}

// ---------- ElevenLabs TTS (MP3 for <Play>) ----------
async function ttsMp3(text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({ text })
  });
  if (!r.ok) {
    console.warn("[TTS] HTTP", r.status, await r.text());
    return null;
  }
  return Buffer.from(await r.arrayBuffer());
}

// ---------- Play MP3, then resume the stream ----------
async function playThenResume(callSid, playUrl) {
  const twiml =
    `<Response>
       <Play>${playUrl}</Play>
       <Connect><Stream url="${STREAM_WS_URL}" track="inbound_track"/></Connect>
     </Response>`;
  await tw.calls(callSid).update({ twiml });
}

// ---------- WS handling ----------
wss.on("connection", (ws, req) => {
  console.log("[WS] CONNECT", req.socket.remoteAddress);

  let callSid = null;
  let frames = [];

  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.event === "start") {
      callSid = data.start?.callSid || null;
      frames = [];
      console.log("[WS] START callSid", callSid, "streamSid", data.start?.streamSid);
    }

    if (data.event === "media") {
      const ulaw = Buffer.from(data.media.payload, "base64");
      frames.push(ulaw);
      // every ~1.5s do STT (simple window)
      if (frames.length >= 75) { // 75 * 20ms = 1500ms
        const all = Buffer.concat(frames);
        frames = [];

        const pcm16 = ulawToPcm16(all);
        const wav = pcm16ToWavBytes(pcm16, 8000);
        const text = await sttMultipart(wav);
        if (text && !/^\s*\(?(silence|music|white noise|static)\)?\s*$/i.test(text)) {
          console.log("[STT]", text);

          // Generate TTS MP3, host it, tell Twilio to Play, then resume stream
          const mp3 = await ttsMp3(`You said: ${text}`);
          if (mp3 && callSid) {
            const id = Math.random().toString(36).slice(2);
            memAudio.set(id, mp3);
            const playUrl = `${PUBLIC_BASE_URL}/tts/${id}.mp3`;
            await playThenResume(callSid, playUrl);
            setTimeout(() => memAudio.delete(id), 60_000);
          }
        }
      }
    }

    if (data.event === "stop") {
      console.log("[WS] STOP");
    }
  });

  ws.on("close", () => console.log("[WS] CLOSE"));
  ws.on("error", (e) => console.error("[WS] ERROR", e));
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (ws path: /stream)`);
});

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  ws.on("message", async (message) => {
    const msg = JSON.parse(message.toString());

    // Handle incoming transcription
    if (msg.event === "transcription") {
      console.log("[STT]", msg.text);

      // Send response back via TTS
      const reply = "Got it! You said: " + msg.text;
      const audioBuffer = await textToSpeech(reply);

      // Stream back to Twilio
      ws.send(
        JSON.stringify({
          event: "media",
          media: {
            payload: audioBuffer.toString("base64"),
          },
        })
      );
    }
  });
});

// ElevenLabs TTS call
async function textToSpeech(text) {
  const response = await fetch("https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL", {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.5 }
    })
  });

  if (!response.ok) {
    throw new Error(`❌ ElevenLabs TTS failed: ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

const server = app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
