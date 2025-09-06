import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

// ───────────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

// ElevenLabs (TTS)
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");

// OpenAI (STT)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.error("❌ OPENAI_API_KEY is not set");

// Business context
const BIZ = {
  name: process.env.BIZ_NAME || "Our Business",
  hours: process.env.BIZ_HOURS || "Mon–Fri 9am–5pm",
  area: process.env.BIZ_SERVICE_AREA || "the local area",
  apptUrl: process.env.APPT_URL || "",
};

// Twilio REST (for SMS)
const TWILIO = {
  sid: process.env.TWILIO_ACCOUNT_SID || "",
  token: process.env.TWILIO_AUTH_TOKEN || "",
  from: process.env.TWILIO_FROM || "",
  mss: process.env.TWILIO_MESSAGING_SERVICE_SID || "",
};
if ((TWILIO.sid && TWILIO.token) && (!TWILIO.from && !TWILIO.mss)) {
  console.error("❌ Provide TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID");
}

// Optional webhooks
const BOOKING_WEBHOOK = process.env.BOOKING_WEBHOOK || "";
const VOICEMAIL_WEBHOOK = process.env.VOICEMAIL_WEBHOOK || "";

// Media format
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// STT batching
const STT_SLICE_MS = 3000;
const STT_MIN_BYTES = Math.floor(
  (SAMPLE_RATE * BYTES_PER_SAMPLE * STT_SLICE_MS) / 1000
);

// Keepalive
const KEEPALIVE_EVERY_MS = 4000;
const KEEPALIVE_FRAMES = 200;

// ───────────────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────────────

function alignToSample(pcm) {
  const rem = pcm.length % BYTES_PER_SAMPLE;
  if (rem === 0) return pcm;
  return Buffer.concat([pcm, Buffer.alloc(BYTES_PER_SAMPLE - rem)]);
}

async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  let frames = 0;

  while (offset < pcmBuffer.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);
    const payload =
      frame.length === BYTES_PER_FRAME
        ? frame.toString("base64")
        : Buffer.concat([frame, Buffer.alloc(BYTES_PER_FRAME - frame.length)]).toString("base64");

    ws.send(JSON.stringify({ event: "media", media: { payload } }));

    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
}

function sendSilenceFrames(ws, n = KEEPALIVE_FRAMES) {
  const silence = Buffer.alloc(BYTES_PER_FRAME);
  const payload = silence.toString("base64");
  for (let i = 0; i < n && ws.readyState === ws.OPEN; i++) {
    ws.send(JSON.stringify({ event: "media", media: { payload } }));
  }
}

function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * BYTES_PER_SAMPLE;
  const blockAlign = numChannels * BYTES_PER_SAMPLE;
  const subchunk2Size = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + subchunk2Size, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(subchunk2Size, 40);

  return Buffer.concat([header, pcm]);
}

async function ttsElevenLabsPcm8k(text) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
    {
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
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${body}`);
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  return alignToSample(pcm);
}

async function transcribeWithWhisper(pcmSlice) {
  const wav = pcmToWav(alignToSample(pcmSlice));
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Whisper STT failed: ${res.status} ${res.statusText} ${body}`);
  }

  const json = await res.json();
  return (json.text || "").trim();
}

// Phone parser / normalizer
function extractPhone(text) {
  if (!text) return null;
  const m = text.replace(/[^\d+]/g, " ").match(/(\+?\d[\d\s\-().]{6,}\d)/);
  if (!m) return null;
  const digits = m[1].replace(/[^\d+]/g, "");
  // Very naive; you can enhance with libphonenumber if you want
  if (digits.length < 7) return null;
  return digits.startsWith("+") ? digits : `+1${digits.replace(/^1/, "")}`;
}

// POST helper
async function postJson(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`Webhook ${url} failed: ${res.status}`);
  } catch (e) {
    console.error(`Webhook ${url} error:`, e.message);
  }
}

// Twilio SMS via REST API (no twilio sdk needed)
async function sendSms({ to, body }) {
  if (!TWILIO.sid || !TWILIO.token) {
    console.warn("SMS skipped: Twilio credentials missing");
    return false;
  }
  if (!to) {
    console.warn("SMS skipped: missing destination phone");
    return false;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO.sid}/Messages.json`;

  const form = new URLSearchParams();
  form.append("To", to);
  if (TWILIO.mss) form.append("MessagingServiceSid", TWILIO.mss);
  else form.append("From", TWILIO.from);
  form.append("Body", body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${TWILIO.sid}:${TWILIO.token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("Twilio SMS error:", res.status, res.statusText, txt);
    return false;
  }
  return true;
}

// ───────────────────────────────────────────────────────────────────────────────
// Intent Router + Flows (booking + voicemail)
// ───────────────────────────────────────────────────────────────────────────────

function routeIntent(text, ctx) {
  const t = text.toLowerCase();

  // greetings
  if (/^(hi|hello|hey)\b/.test(t)) {
    return `Hi! This is ${BIZ.name}. How can I help you today?`;
  }

  // hours
  if (/(hour|open|close|time|until|when.*open|when.*close)/.test(t)) {
    return `${BIZ.name} is open ${BIZ.hours}.`;
  }

  // service area
  if (/(service|serve|area|where|locations?)/.test(t)) {
    return `We service ${BIZ.area}.`;
  }

  // booking intent
  if (/(book|appointment|schedule|estimate|quote)/.test(t)) {
    ctx.mode = "booking";
    if (BIZ.apptUrl) {
      if (ctx.callerPhone) ctx.actions.queueSms = { type: "booking-link" };
      return ctx.callerPhone
        ? `Great, I’ll text you our booking link now. If you prefer, tell me a preferred day/time and I’ll note it.`
        : `Happy to help. What phone number can I text our booking link to?`;
    }
    return `Absolutely. Tell me your preferred day/time and your callback number, and I’ll note it for a callback.`;
  }

  // voicemail intent
  if (/(voicemail|leave.*message|call.*back|take.*message)/.test(t)) {
    ctx.mode = "voicemail";
    return `I can take a message. What's your name, a callback number, and a brief description?`;
  }

  // mode handlers
  if (ctx.mode === "booking") {
    // capture phone if present
    const phone = extractPhone(text);
    if (phone) {
      ctx.callerPhone = phone;
      if (BIZ.apptUrl) ctx.actions.queueSms = { type: "booking-link" };
      return `Thanks! I’ve got ${phone}. I’ll text the booking link now. Anything else I can help with?`;
    }
    // collect note/time (we just treat as note here)
    if (text.length > 6) {
      ctx.booking.note = (ctx.booking.note || "") + " " + text;
      return `Noted. If you want the link by text, please share the best number.`;
    }
  }

  if (ctx.mode === "voicemail") {
    // accumulate voicemail fields
    const phone = extractPhone(text);
    if (phone) ctx.voicemail.phone = phone;

    // naive name heuristic
    if (!ctx.voicemail.name && /\b(i'?m|this is|my name is)\b/i.test(text)) {
      const m = text.match(/\b(?:i'?m|this is|my name is)\s+([\w\-'. ]{2,})/i);
      if (m) ctx.voicemail.name = m[1].trim();
    }

    // append message
    ctx.voicemail.message = (ctx.voicemail.message || "") + " " + text;

    // when we have phone + at least some message, submit
    if (ctx.voicemail.phone && (ctx.voicemail.message || "").length > 20) {
      ctx.actions.submitVoicemail = true;
      return `Thanks—I've recorded your message and contact number. We’ll follow up shortly. Anything else I can help with?`;
    }

    // keep collecting
    if (!ctx.voicemail.phone) return `Got it. What’s the best callback number?`;
    return `Thanks—anything else you’d like to add? Say “that’s it” when you’re done.`;
  }

  // fallback
  return `Got it. Would you like our hours, service area, or to book an appointment?`;
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket server (Twilio <Connect><Stream> → wss://.../stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  const ctx = {
    callSid: null,
    streamSid: null,

    rxBytes: 0,
    rxBuffer: Buffer.alloc(0),
    sttBusy: false,

    lastTtsAt: 0,

    mode: "idle", // idle | booking | voicemail
    callerPhone: null,

    booking: { note: "" },
    voicemail: { name: "", phone: "", message: "" },

    actions: {
      queueSms: null,        // { type: 'booking-link' }
      submitVoicemail: false // bool
    },
  };

  const keepalive = setInterval(() => {
    const idle = Date.now() - ctx.lastTtsAt > KEEPALIVE_EVERY_MS - 200;
    if (idle && ws.readyState === ws.OPEN) {
      sendSilenceFrames(ws, KEEPALIVE_FRAMES);
    }
  }, KEEPALIVE_EVERY_MS);

  async function speak(text) {
    const pcm = await ttsElevenLabsPcm8k(text);
    ctx.lastTtsAt = Date.now();
    await streamPcmToTwilio(ws, pcm);
  }

  async function afterTurnSideEffects() {
    // Booking link SMS
    if (ctx.actions.queueSms?.type === "booking-link") {
      ctx.actions.queueSms = null;
      if (BIZ.apptUrl && ctx.callerPhone) {
        await sendSms({
          to: ctx.callerPhone,
          body: `Hi from ${BIZ.name}! Book here: ${BIZ.apptUrl}`,
        });
        if (BOOKING_WEBHOOK) {
          await postJson(BOOKING_WEBHOOK, {
            callSid: ctx.callSid,
            phone: ctx.callerPhone,
            note: ctx.booking.note?.trim() || "",
            link: BIZ.apptUrl,
            ts: new Date().toISOString(),
          });
        }
      }
    }

    // Voicemail submission
    if (ctx.actions.submitVoicemail) {
      ctx.actions.submitVoicemail = false;
      const payload = {
        callSid: ctx.callSid,
        name: ctx.voicemail.name || "",
        phone: ctx.voicemail.phone || ctx.callerPhone || "",
        message: (ctx.voicemail.message || "").trim(),
        ts: new Date().toISOString(),
      };
      if (VOICEMAIL_WEBHOOK) {
        await postJson(VOICEMAIL_WEBHOOK, payload);
      }
      // confirmation SMS if we have a phone
      const to = payload.phone || ctx.callerPhone;
      if (to) {
        await sendSms({
          to,
          body: `Thanks for your message to ${BIZ.name}. We’ll be in touch soon.`,
        });
      }
      // reset voicemail context for safety
      ctx.mode = "idle";
      ctx.voicemail = { name: "", phone: "", message: "" };
    }
  }

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
      return;
    }

    if (msg.event === "start") {
      ctx.callSid = msg.start?.callSid || null;
      ctx.streamSid = msg.start?.streamSid || null;
      console.log(
        `[WS] START callSid=${ctx.callSid} streamSid=${ctx.streamSid} bidi=${msg.start?.bidirectional}`
      );

      // greet
      try {
        await speak(`Hi! I'm your AI receptionist at ${BIZ.name}. How can I help you today?`);
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
      return;
    }

    if (msg.event === "media") {
      const chunk = Buffer.from(msg.media.payload, "base64");
      ctx.rxBytes += chunk.length;
      ctx.rxBuffer = Buffer.concat([ctx.rxBuffer, chunk]);

      if (!ctx.sttBusy && ctx.rxBuffer.length >= STT_MIN_BYTES) {
        ctx.sttBusy = true;
        const slice = ctx.rxBuffer.subarray(0, STT_MIN_BYTES);
        ctx.rxBuffer = ctx.rxBuffer.subarray(STT_MIN_BYTES);

        (async () => {
          try {
            const text = await transcribeWithWhisper(slice);
            if (text) {
              console.log(`[STT] "${text}"`);

              // opportunistically capture a phone number anytime it appears
              const maybe = extractPhone(text);
              if (maybe) ctx.callerPhone = ctx.callerPhone || maybe;

              const reply = routeIntent(text, ctx);
              await speak(reply);
              await afterTurnSideEffects();
            }
          } catch (err) {
            console.error("[STT] error:", err.message);
          } finally {
            ctx.sttBusy = false;
          }
        })().catch(() => {});
      }
      return;
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound bytes: ${ctx.rxBytes})`);
      // best-effort flush
      if (!ctx.sttBusy && ctx.rxBuffer.length >= 1600) {
        ctx.sttBusy = true;
        (async () => {
          try {
            const text = await transcribeWithWhisper(ctx.rxBuffer);
            if (text) console.log(`[STT][final] "${text}"`);
          } catch {}
          finally { ctx.sttBusy = false; }
        })();
      }
      return;
    }
  });

  ws.on("close", () => {
    clearInterval(keepalive);
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => {
    clearInterval(keepalive);
    console.error("[WS] error", err);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// HTTP + WS upgrade
// ───────────────────────────────────────────────────────────────────────────────
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

app.get("/", (_req, res) => res.status(200).send("OK"));
