// server.js (ESM)

import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";

const app = express();
const PORT = process.env.PORT || 10000;

// ───────────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!ELEVEN_VOICE_ID) console.error("❌ ELEVEN_VOICE_ID is not set");

// Twilio media expects 16-bit PCM mono @ 8kHz → 20ms frames = 160 samples = 320 bytes
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// ───────────────────────────────────────────────────────────────────────────────
// Helpers: frame sender / beep / normalize
// ───────────────────────────────────────────────────────────────────────────────
function makeBeepPcm16le(ms = 200, hz = 1000) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const s = Math.round(0.2 * 32767 * Math.sin(2 * Math.PI * hz * t)); // 20% amplitude
    buf.writeInt16LE(s, i * 2);
  }
  return buf;
}

function normalizePcm16le(buf) {
  // if odd length, drop the last byte so we are sample-aligned
  if (buf.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(`[TTS] PCM not sample-aligned (${buf.length}); trimming 1 byte tail`);
    buf = buf.slice(0, buf.length - 1);
  }
  return buf; // ffmpeg already produced s16le (little-endian)
}

async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  let frames = 0;

  while (offset < pcmBuffer.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    let frame = pcmBuffer.slice(offset, end);

    // Pad last short frame to exactly 320 bytes
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME);
      frame.copy(padded, 0);
      frame = padded;
    }

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid: ws._streamSid, // IMPORTANT: tag the stream
        media: { payload: frame.toString("base64") },
      })
    );

    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }

    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// ElevenLabs TTS → (MP3/WAV) → ffmpeg → PCM s16le/8k/mono
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabsToPcm16le8k(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

  // Ask ElevenLabs for a compressed format (often MP3), we’ll transcode ourselves.
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg", // allow MP3 container (most widely supported)
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      // If your account supports raw PCM: set output_format:"pcm_8000" and skip ffmpeg.
      // We keep MP3+ffmpeg path for robustness across accounts.
    }),
  });

  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${errTxt}`);
  }

  const audioBytes = Buffer.from(await res.arrayBuffer());

  // Transcode (any-container) -> s16le @ 8kHz mono with ffmpeg
  console.log("[TTS] Received MP3 container. Transcoding to PCM with ffmpeg…");
  const pcm = await transcodeToS16le8k(audioBytes);
  return normalizePcm16le(pcm);
}

function transcodeToS16le8k(inputBuffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const ff = spawn(ffmpegBin.path, [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      "pipe:0", // read input from stdin
      "-ac",
      "1", // mono
      "-ar",
      "8000", // 8 kHz
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1", // write raw PCM to stdout
    ]);

    ff.stdin.on("error", () => {}); // ignore EPIPE if ffmpeg exits early
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => console.error("[ffmpeg]", d.toString().trim()));
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    ff.stdin.end(inputBuffer);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER (Twilio <Connect><Stream> → wss://.../stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON
    }

    if (msg.event === "connected") {
      console.log(
        `[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`
      );
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(
        `[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid} bidi=${msg.start?.bidirectional}`
      );

      try {
        // 1) Quick audible proof that the send path works
        const beep = makeBeepPcm16le(200);
        await streamPcmToTwilio(ws, beep);
        console.log("[BEEP] done.");

        // 2) Greeting
        console.log("[TTS] streaming greeting…");
        const pcm = await ttsElevenLabsToPcm16le8k(
          "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?"
        );
        await streamPcmToTwilio(ws, pcm);
        console.log("[TTS] done.");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      // Incoming caller audio; we’re not consuming it here beyond simple accounting.
      if (!ws._rxCount) ws._rxCount = 0;
      ws._rxCount++;
      if (ws._rxCount % 100 === 0) {
        console.log(`[MEDIA] frames received: ${ws._rxCount}`);
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rxCount || 0})`);
    }
  });

  ws.on("close", () => {
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => {
    console.error("[WS] error", err);
  });
});

// HTTP + WS upgrade
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  // Only accept upgrades for /stream
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Healthcheck
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
