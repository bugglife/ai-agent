import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// ───────────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // change if you like

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");

// Twilio media expects 16-bit PCM mono @ 8kHz → 20ms frames = 160 samples = 320 bytes
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// ───────────────────────────────────────────────────────────────────────────────
// UTIL: Chunk PCM into 20ms frames and send to Twilio
// Pads the FINAL frame to a full 20ms and guarantees even byte length.
// ───────────────────────────────────────────────────────────────────────────────
async function streamPcmToTwilio(ws, pcmBuffer) {
  // Safety: make whole buffer even-length to avoid "not sample-aligned" warning.
  if (pcmBuffer.length % BYTES_PER_SAMPLE === 1) {
    pcmBuffer = Buffer.concat([pcmBuffer, Buffer.from([0])]);
  }

  let offset = 0;
  let frames = 0;

  while (offset < pcmBuffer.length) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);

    // If last frame is short, pad with silence so Twilio gets full frame
    let out = frame;
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME);
      frame.copy(padded, 0);
      out = padded;
    }

    // Extra safety: ensure frame is even-length (should always be true here)
    if (out.length % BYTES_PER_SAMPLE === 1) {
      out = Buffer.concat([out, Buffer.from([0])]);
    }

    ws.send(
      JSON.stringify({
        event: "media",
        media: { payload: out.toString("base64") },
      })
    );

    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }

    // Real-time pacing at ~20ms per frame
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS: Ask ElevenLabs for 8kHz PCM (16-bit, mono)
// If pcm_8000 isn’t available on your plan, switch to pcm_16000 and we’ll downsample.
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabsPcm8k(text) {
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
    const errTxt = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${errTxt}`);
  }

  const arrayBuf = await res.arrayBuffer();
  let pcmBuffer = Buffer.from(arrayBuf);

  // Warn if it’s not sample-aligned (should be fixed by the safety pad in streamPcmToTwilio)
  if (pcmBuffer.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(
      `[WARN] PCM length ${pcmBuffer.length} is not sample-aligned; will pad tail before streaming.`
    );
  }

  return pcmBuffer;
}

// ───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER (Twilio <Connect><Stream> hits wss://.../stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON pings etc.
    }

    if (msg.event === "connected") {
      console.log(
        `[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`
      );
    }

    if (msg.event === "start") {
      console.log(
        `[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`
      );

      try {
        console.log("[TTS] sending greeting…");
        const pcm = await ttsElevenLabsPcm8k(
          "Hi! I’m your AI receptionist. How can I help you today?"
        );
        await streamPcmToTwilio(ws, pcm);
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      // Inbound caller audio; keep lightweight for backpressure
      ws._rxCount = (ws._rxCount || 0) + 1;
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
