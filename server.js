// server.js
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

// ───────────────────────────────────────────────────────────────────────────────
// App bootstrap
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

// Parse JSON for incoming webhooks
app.use(
  express.json({
    limit: "1mb",
    type: ["application/json", "text/json", "*/json"],
  })
);

// ───────────────────────────────────────────────────────────────────────────────
/** Optional simple webhook signing
 *  - Set WEBHOOK_SECRET in Render
 *  - Have your agent/posters send header: X-Webhook-Secret: <same-secret>
 *  Remove this block if you don't want auth on the webhook endpoints.
 */
app.use((req, res, next) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return next(); // no check if secret not configured
  // Only protect our webhook endpoints
  if (!req.path.startsWith("/webhooks/")) return next();
  const got = req.get("X-Webhook-Secret");
  if (got && got === secret) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// ───────────────────────────────────────────────────────────────────────────────
// Config / constants
// ───────────────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // default ElevenLabs voice

if (!ELEVEN_API_KEY) {
  console.error("❌ ELEVEN_API_KEY is not set");
}

// Twilio Media Stream facts (mono, 8kHz, 16-bit signed PCM, 20ms frames)
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// Optional “business context” (used if you later add logic that posts webhooks)
const BIZ_NAME = process.env.BIZ_NAME || "My Business";

// Optional outbound webhooks (safe if unset)
const APPT_WEBHOOK = process.env.APPT_WEBHOOK || "";
const VOICEMAIL_WEBHOOK = process.env.VOICEMAIL_WEBHOOK || "";

// ───────────────────────────────────────────────────────────────────────────────
// Small utility helpers
// ───────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Generate a short 1 kHz test tone (mono, 8kHz, 16-bit PCM). */
function generateTestTonePCM(durationMs = 500, freq = 1000) {
  const sampleCount = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(sampleCount * BYTES_PER_SAMPLE);
  const amplitude = 0.2 * 32767; // keep it gentle

  for (let i = 0; i < sampleCount; i++) {
    const t = i / SAMPLE_RATE; // seconds
    const sample = Math.round(amplitude * Math.sin(2 * Math.PI * freq * t));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/** 20ms framing + real-time pacing out to Twilio. */
async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  let frames = 0;

  while (ws.readyState === ws.OPEN && offset < pcmBuffer.length) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);

    // Pad last frame with silence to 320 bytes
    let payload;
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME);
      frame.copy(padded, 0);
      payload = padded.toString("base64");
    } else {
      payload = frame.toString("base64");
    }

    ws.send(JSON.stringify({ event: "media", media: { payload } }));

    frames++;
    if (frames % 100 === 0) {
      // ~2s per 100 frames
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }

    await sleep(FRAME_MS);
    offset += BYTES_PER_FRAME;
  }
}

/** Send N frames of pure silence (keepalive) */
async function sendSilenceFrames(ws, frameCount = 200) {
  const silent = Buffer.alloc(BYTES_PER_FRAME); // 20ms of silence
  const base64 = silent.toString("base64");

  for (let i = 0; i < frameCount; i++) {
    if (ws.readyState !== ws.OPEN) break;
    ws.send(JSON.stringify({ event: "media", media: { payload: base64 } }));
    await sleep(FRAME_MS);
  }
}

/** Start a repeating keepalive loop (sends short bursts of silence). */
function startKeepalive(ws) {
  // store interval handle on ws so we can clear it later
  if (ws._keepaliveInterval) clearInterval(ws._keepaliveInterval);

  ws._keepaliveInterval = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) return;
    console.log("[KEEPALIVE] sending 200 silence frames (~4s)");
    await sendSilenceFrames(ws, 200);
  }, 4000); // schedule every ~4s (keeps carriers happy)
}

function stopKeepalive(ws) {
  if (ws._keepaliveInterval) {
    clearInterval(ws._keepaliveInterval);
    ws._keepaliveInterval = null;
  }
}

/** ElevenLabs TTS -> 8 kHz PCM (raw) */
async function ttsElevenLabsPcm8k(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/pcm", // get raw PCM back
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      output_format: "pcm_8000", // exact match for Twilio
    }),
  });

  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${errTxt}`);
  }

  const arrayBuf = await res.arrayBuffer();
  const pcm = Buffer.from(arrayBuf);

  if (pcm.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(
      `[WARN] PCM length ${pcm.length} not sample-aligned; Twilio may ignore a tail byte.`
    );
  }
  return pcm;
}

/** (Optional) generic JSON poster for outbound webhooks */
async function safePostJSON(url, payload = {}) {
  if (!url) return { ok: false, skipped: true };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: r.ok, status: r.status, text: await r.text().catch(() => "") };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Webhook receivers
// ───────────────────────────────────────────────────────────────────────────────

app.post("/webhooks/appointment", async (req, res) => {
  try {
    console.log("📅 [APPOINTMENT] webhook payload:", JSON.stringify(req.body, null, 2));
    // Add your calendar/CRM integration here
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("📅 [APPOINTMENT] webhook error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/webhooks/voicemail", async (req, res) => {
  try {
    console.log("📨 [VOICEMAIL] webhook payload:", JSON.stringify(req.body, null, 2));
    // Add your email/CRM/file store integration here
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("📨 [VOICEMAIL] webhook error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Twilio <Connect><Stream> WebSocket endpoint (/stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore any non-JSON
    }

    if (msg.event === "connected") {
      console.log(
        `[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`
      );
      // Start the keepalive loop as soon as media can flow
      startKeepalive(ws);
    }

    if (msg.event === "start") {
      console.log(
        `[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`
      );

      try {
        // Quick 0.5s test tone so you can hear the return path is good
        const tone = generateTestTonePCM(500, 1000);
        await streamPcmToTwilio(ws, tone);

        // Friendly greeting via ElevenLabs
        const greeting = `Hi! I'm your AI receptionist at ${BIZ_NAME}. How can I help you today?`;
        console.log(`[TTS] reply -> "${greeting}"`);
        const pcm = await ttsElevenLabsPcm8k(greeting);
        await streamPcmToTwilio(ws, pcm);
      } catch (e) {
        console.error("[TTS] sending greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      // Inbound caller audio arrives continuously as base64 20ms PCM frames
      ws._rxCount = (ws._rxCount || 0) + 1;
      if (ws._rxCount % 100 === 0) {
        console.log(`[MEDIA] frames received: ${ws._rxCount}`);
      }
      // (Your recognition/intent logic can be added here later)
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rxCount || 0})`);
      stopKeepalive(ws);
    }
  });

  ws.on("close", () => {
    stopKeepalive(ws);
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => {
    console.error("[WS] error", err);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// HTTP server + WS upgrade
// ───────────────────────────────────────────────────────────────────────────────
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

// Simple healthcheck
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
