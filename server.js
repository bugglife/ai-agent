// server.js — beep OK + streamSid OK + TTS endianness auto-fix
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
const ENABLE_BEEP = (process.env.ENABLE_BEEP || "true").toLowerCase() !== "false";

// Twilio media: 8 kHz, mono, 16-bit PCM, 20ms frames
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// 1 kHz short beep (PCM16, little-endian, 8k)
function makeBeepPcm16(durationMs = 500, freqHz = 1000) {
  const totalSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(totalSamples * 2);
  const amp = 0.2 * 32767;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    buf.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * freqHz * t)), i * 2);
  }
  return buf;
}

// Heuristic: decide if PCM buffer is LE or BE. If BE, return a LE-swapped copy.
function ensureLittleEndian(pcmBuf) {
  // Safety: must be even length
  const len = pcmBuf.length - (pcmBuf.length % 2);
  if (len <= 0) return pcmBuf;

  const N = Math.min(4000, len); // inspect first ~2000 samples
  let leEnergy = 0;
  let beEnergy = 0;

  for (let i = 0; i < N; i += 2) {
    const le = pcmBuf.readInt16LE(i);
    const be = pcmBuf.readInt16BE(i);
    leEnergy += Math.abs(le);
    beEnergy += Math.abs(be);
  }

  // If BE interpretation is significantly "louder", assume BE and swap → LE
  if (beEnergy > leEnergy * 1.8) {
    const swapped = Buffer.alloc(len);
    for (let i = 0; i < len; i += 2) {
      swapped[i] = pcmBuf[i + 1];
      swapped[i + 1] = pcmBuf[i];
    }
    console.log(`[TTS] Detected big-endian PCM from TTS; byte-swapped to little-endian.`);
    // If original length was odd, append last byte (ignored by Twilio anyway)
    if (pcmBuf.length !== len) return Buffer.concat([swapped, Buffer.from([pcmBuf[len]])]);
    return swapped;
  } else {
    console.log(`[TTS] PCM appears little-endian; streaming as-is.`);
    return pcmBuf;
  }
}

// ElevenLabs → raw PCM at 8 kHz
async function ttsElevenLabsPcm8k(text) {
  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY not set");

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/pcm",
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      output_format: "pcm_8000",
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${txt}`);
  }

  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length % 2 !== 0) {
    console.warn(`[WARN] TTS PCM length ${raw.length} not sample-aligned (odd); last byte may be ignored by Twilio.`);
  }
  return ensureLittleEndian(raw);
}

// Send one 20 ms frame to Twilio (must include streamSid)
function sendMediaFrame(ws, streamSid, rawFrame320) {
  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: rawFrame320.toString("base64") },
    })
  );
}

// Chunk PCM16 into 20 ms frames and stream with real-time pacing
async function streamPcm16ToTwilio(ws, streamSid, pcm16, tag = "TTS") {
  let offset = 0;
  let frames = 0;

  while (offset < pcm16.length) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcm16.length);
    let frame = pcm16.slice(offset, end);
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME);
      frame.copy(padded, 0);
      frame = padded;
    }
    sendMediaFrame(ws, streamSid, frame);

    frames++;
    if (frames % 100 === 0) {
      console.log(`[${tag}] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }

    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
  console.log(`[${tag}] done.`);
}

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  const state = { streamSid: null, inboundFrames: 0 };

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      state.streamSid = msg.start?.streamSid || null;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${state.streamSid} bidi=${msg.start?.bidirectional}`);

      try {
        if (ENABLE_BEEP) {
          await streamPcm16ToTwilio(ws, state.streamSid, makeBeepPcm16(500, 1000), "BEEP");
          console.log(`[BEEP] done.`);
        }

        const pcm = await ttsElevenLabsPcm8k(GREETING_TEXT);
        await streamPcm16ToTwilio(ws, state.streamSid, pcm, "TTS");
        console.log(`[TTS] done.`);
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      state.inboundFrames++;
      if (state.inboundFrames % 100 === 0) {
        console.log(`[MEDIA] frames received: ${state.inboundFrames}`);
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${state.inboundFrames})`);
    }
  });

  ws.on("close", () => console.log("[WS] CLOSE code=1005 reason="));
  ws.on("error", (err) => console.error("[WS] error", err));
});

// HTTP + WS upgrade
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

app.get("/", (_req, res) => res.status(200).send("OK"));
