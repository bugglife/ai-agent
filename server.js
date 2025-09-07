import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

// pcm16 | mulaw  (set in Render env)
const MEDIA_FORMAT = (process.env.TWILIO_MEDIA_FORMAT || "pcm16").toLowerCase();

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!ELEVEN_VOICE_ID) console.error("❌ ELEVEN_VOICE_ID is not set");
if (!["pcm16", "mulaw"].includes(MEDIA_FORMAT)) {
  console.warn(`⚠️ Unknown TWILIO_MEDIA_FORMAT='${MEDIA_FORMAT}', defaulting to pcm16`);
}

// Common timing
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;

// Frame sizing per format
const BYTES_PER_SAMPLE_PCM16 = 2;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160 samples @ 8k, 20ms
const BYTES_PER_FRAME_PCM16 = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE_PCM16; // 320
const BYTES_PER_FRAME_MULAW = SAMPLES_PER_FRAME * 1; // 160 (8-bit)

// ───────────────────────────────────────────────────────────────────────────────
// Utilities (beep generators in the chosen format)
// ───────────────────────────────────────────────────────────────────────────────
function makeBeepPcm16(ms = 200, hz = 1000) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE_PCM16);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const s = Math.round(0.18 * 32767 * Math.sin(2 * Math.PI * hz * t));
    buf.writeInt16LE(s, i * 2);
  }
  return buf;
}

// µ-law companding tables (fast)
function linearToMulawSample(s) {
  // s: signed 16-bit PCM
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s = s + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  let ulaw = ~(sign | (exponent << 4) | mantissa);
  return ulaw & 0xff;
}

function makeBeepMulaw(ms = 200, hz = 1000) {
  // create in PCM then compand
  const pcm = makeBeepPcm16(ms, hz);
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0, j = 0; i < pcm.length; i += 2, j++) {
    const s = pcm.readInt16LE(i);
    out[j] = linearToMulawSample(s);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// Transcoding helpers (ElevenLabs → desired format)
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabsRaw(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg", // get MP3/wrapped audio, we will transcode
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${err}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function ffmpegTranscode(inputBuf, args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const ff = spawn(ffmpegBin.path, args);
    ff.stdin.on("error", () => {}); // ignore EPIPE
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => console.error("[ffmpeg]", d.toString().trim()));
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`))));
    ff.stdin.end(inputBuf);
  });
}

async function ttsToPcm16(text) {
  const input = await ttsElevenLabsRaw(text);
  console.log("[TTS] Received MP3 container. Transcoding → PCM16/8k/mono");
  let out = await ffmpegTranscode(input, [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", "pipe:0",
    "-ac", "1",
    "-ar", "8000",
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "pipe:1",
  ]);
  // sample-align
  if (out.length % 2 !== 0) out = out.slice(0, out.length - 1);
  return out;
}

async function ttsToMulaw(text) {
  const input = await ttsElevenLabsRaw(text);
  console.log("[TTS] Received MP3 container. Transcoding → µ-law/8k/mono");
  return await ffmpegTranscode(input, [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", "pipe:0",
    "-ac", "1",
    "-ar", "8000",
    "-f", "mulaw",
    "-acodec", "pcm_mulaw",
    "pipe:1",
  ]);
}

// ───────────────────────────────────────────────────────────────────────────────
// Outbound streaming (Twilio)
// ───────────────────────────────────────────────────────────────────────────────
async function streamFrames(ws, raw) {
  const bytesPerFrame =
    MEDIA_FORMAT === "mulaw" ? BYTES_PER_FRAME_MULAW : BYTES_PER_FRAME_PCM16;

  let offset = 0;
  let frames = 0;

  while (offset < raw.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + bytesPerFrame, raw.length);
    let frame = raw.slice(offset, end);

    // pad last fragment to whole frame
    if (frame.length < bytesPerFrame) {
      const padded = Buffer.alloc(bytesPerFrame);
      frame.copy(padded, 0);
      frame = padded;
    }

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid: ws._streamSid,
        media: { payload: frame.toString("base64") },
      })
    );

    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }

    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += bytesPerFrame;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket (Twilio <Connect><Stream> → wss://…/stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      console.log(
        `[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`
      );
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      try {
        // 1) Beep in the chosen format so you instantly know the format matches
        if (MEDIA_FORMAT === "mulaw") {
          await streamFrames(ws, makeBeepMulaw(180, 950));
        } else {
          await streamFrames(ws, makeBeepPcm16(180, 950));
        }
        console.log("[BEEP] done.");

        // 2) Greeting
        console.log(`[TTS] streaming greeting as ${MEDIA_FORMAT}…`);
        const text = "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
        const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
        await streamFrames(ws, buf);
        console.log("[TTS] done.");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      ws._rx = (ws._rx || 0) + 1;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
    }
  });

  ws.on("close", () => console.log("[WS] CLOSE code=1005 reason="));
  ws.on("error", (err) => console.error("[WS] error", err));
});

const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

app.get("/", (_req, res) => res.status(200).send("OK"));
