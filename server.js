// server.js
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// ───────────────────────────────────────────────────────────────────────────────
// ENV
// ───────────────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // ElevenLabs default demo voice
const TWILIO_CODEC = (process.env.TWILIO_CODEC || "pcm16").toLowerCase(); // "pcm16" or "mulaw"
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
const ENABLE_BEEP = (process.env.ENABLE_BEEP || "true").toLowerCase() !== "false";

// TwiML must use: <Connect><Stream url="wss://.../stream" track="inbound_track"/></Connect>

// ───────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ───────────────────────────────────────────────────────────────────────────────
// Twilio Media Streams use 8 kHz mono
const SAMPLE_RATE = 8000;
// 20 ms/frame @ 8 kHz → 0.02 * 8000 = 160 samples per frame
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_SAMPLE_PCM16 = 2; // little-endian signed 16-bit
const BYTES_PER_FRAME_PCM16 = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE_PCM16; // 320
const BYTES_PER_FRAME_MULAW = SAMPLES_PER_FRAME; // 160

// ───────────────────────────────────────────────────────────────────────────────
// UTIL: Robust G.711 µ-law reference encoder
// (We won't use it while TWILIO_CODEC=pcm16, but it's here and correct.)
// ───────────────────────────────────────────────────────────────────────────────
const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

function linear16ToMulawSampleRef(sample) {
  let s = sample;
  if (s > 32767) s = 32767;
  if (s < -32768) s = -32768;

  let sign = (s >> 8) & 0x80; // 0x80 if negative
  if (s < 0) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s = s + MULAW_BIAS;

  // exponent
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  // mantissa 4 bits
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  let ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;

  // CCITT zero trap
  if (ulaw === 0x00) ulaw = 0x02;

  return ulaw;
}

function linear16ToMulawBufferRef(pcmBufLE) {
  const out = Buffer.alloc(pcmBufLE.length / 2);
  for (let i = 0, j = 0; i < pcmBufLE.length; i += 2, j++) {
    const sample = pcmBufLE.readInt16LE(i);
    out[j] = linear16ToMulawSampleRef(sample);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// UTIL: Generate a short 1 kHz test tone (PCM16, 8 kHz, 0.5 s)
// ───────────────────────────────────────────────────────────────────────────────
function makeBeepPcm16(durationMs = 500, freqHz = 1000) {
  const totalSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(totalSamples * BYTES_PER_SAMPLE_PCM16);
  const amplitude = 0.2 * 32767; // keep it gentle
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const sample = Math.round(amplitude * Math.sin(2 * Math.PI * freqHz * t));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS (ElevenLabs) → request 8 kHz PCM directly so we don't resample
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabsPcm8k(text) {
  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY not set");
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/pcm", // raw linear PCM stream
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      // key point: get 8 kHz PCM to match Twilio media exactly
      output_format: "pcm_8000",
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${txt}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const pcm = Buffer.from(arrayBuf);

  // sample-alignment sanity
  if (pcm.length % 2 !== 0) {
    console.warn(
      `[WARN] TTS PCM length ${pcm.length} is not sample-aligned; last byte will be ignored by Twilio.`
    );
  }

  return pcm;
}

// ───────────────────────────────────────────────────────────────────────────────
// STREAM: Chunk audio to 20 ms frames, convert (if needed), send to Twilio
// ───────────────────────────────────────────────────────────────────────────────
async function streamAudioToTwilio(ws, pcm16Buffer, tag = "TTS") {
  let offset = 0;
  let frames = 0;

  while (offset < pcm16Buffer.length) {
    // Slice one 20ms frame in PCM16 (320 bytes)
    const end = Math.min(offset + BYTES_PER_FRAME_PCM16, pcm16Buffer.length);
    let frame = pcm16Buffer.slice(offset, end);

    // If last frame is short, pad with silence to keep exact frame size
    if (frame.length < BYTES_PER_FRAME_PCM16) {
      const padded = Buffer.alloc(BYTES_PER_FRAME_PCM16);
      frame.copy(padded, 0);
      frame = padded;
    }

    // Convert to µ-law if requested; otherwise keep PCM16
    let outFrame;
    if (TWILIO_CODEC === "mulaw") {
      const ulaw = linear16ToMulawBufferRef(frame);
      // sanity check: exactly 160 bytes
      if (ulaw.length !== BYTES_PER_FRAME_MULAW) {
        console.warn(
          `[WARN] µ-law frame size ${ulaw.length} (expected ${BYTES_PER_FRAME_MULAW})`
        );
      }
      outFrame = ulaw;
    } else {
      // sanity check: exactly 320 bytes
      if (frame.length !== BYTES_PER_FRAME_PCM16) {
        console.warn(
          `[WARN] PCM16 frame size ${frame.length} (expected ${BYTES_PER_FRAME_PCM16})`
        );
      }
      outFrame = frame;
    }

    ws.send(
      JSON.stringify({
        event: "media",
        media: {
          // Twilio expects base64 of raw bytes (pcm16le or PCMU) at 8 kHz, 20 ms per frame
          payload: outFrame.toString("base64"),
        },
      })
    );

    frames++;
    // lightweight progress log
    if (frames % 100 === 0) {
      console.log(`[${tag}] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }

    // real-time pacing: 20 ms
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME_PCM16;
  }
  console.log(`[${tag}] greeting done.`);
}

// ───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER (Twilio <Connect><Stream> hits wss://.../stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  // Keep a little state per call
  const state = {
    streamSid: null,
    inboundFrames: 0,
    keepaliveInterval: null,
  };

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
      state.streamSid = msg.start?.streamSid || null;
      console.log(
        `[WS] START callSid=${msg.start?.callSid} streamSid=${state.streamSid} bidi=${msg.start?.bidirectional}`
      );
      console.log(`[TTS] sending greeting…`);

      try {
        // optional: quick 1 kHz beep to confirm audio path
        if (ENABLE_BEEP) {
          const beep = makeBeepPcm16(500, 1000);
          await streamAudioToTwilio(ws, beep, "BEEP");
        }

        // TTS → PCM16 8 kHz → stream
        const pcm = await ttsElevenLabsPcm8k(GREETING_TEXT);
        await streamAudioToTwilio(ws, pcm, "TTS");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }

      // Start a very lightweight keepalive: insert periodic silence so the RTP doesn’t collapse
      // (We use 200 frames (~4s) of silence every ~4s worth of inbound audio processed.)
      // You can remove this if you don’t need it.
      state.keepaliveInterval = setInterval(() => {
        const silentFrame =
          TWILIO_CODEC === "mulaw"
            ? Buffer.alloc(BYTES_PER_FRAME_MULAW, 0xff) // µ-law "silence"
            : Buffer.alloc(BYTES_PER_FRAME_PCM16, 0x00);

        // Send 200 frames of silence (~4s)
        for (let i = 0; i < 200; i++) {
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: silentFrame.toString("base64") },
            })
          );
        }
        console.log(`[KEEPALIVE] sent 200 silence frames (~${(200 * FRAME_MS) / 1000}s)`);
      }, 4000);
    }

    if (msg.event === "media") {
      // inbound audio from caller (not used here; STT bridge can read it if needed)
      state.inboundFrames++;
      if (state.inboundFrames % 100 === 0) {
        console.log(`[MEDIA] frames received: ${state.inboundFrames}`);
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${state.inboundFrames})`);
      if (state.keepaliveInterval) {
        clearInterval(state.keepaliveInterval);
        state.keepaliveInterval = null;
      }
    }
  });

  ws.on("close", () => {
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => {
    console.error("[WS] error", err);
  });
});

// HTTP server + WS upgrade
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Simple healthcheck
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
