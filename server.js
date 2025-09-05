// server.js
// Tiny-ML receptionist over Twilio <Connect><Stream> + ElevenLabs TTS (8kHz PCM)
// No external deps beyond node-fetch and ws (already in your app).

import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

// ───────────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

// “Business profile” (tune to your org)
const BIZ_NAME   = process.env.BIZ_NAME   || "our office";
const BIZ_HOURS  = process.env.BIZ_HOURS  || "Mon–Fri 9am–6pm, Sat 10am–2pm, closed Sunday.";
const BIZ_AREAS  = (process.env.SERVICE_AREAS || "Downtown, Midtown, Northside, West Hills")
  .split(",").map(s => s.trim());

// Optional webhooks to receive structured JSON
const APPT_WEBHOOK      = process.env.APPT_WEBHOOK      || "";
const VOICEMAIL_WEBHOOK = process.env.VOICEMAIL_WEBHOOK || "";

// Guardrails
if (!ELEVEN_API_KEY)  console.error("❌ ELEVEN_API_KEY is not set");
if (!ELEVEN_VOICE_ID) console.error("❌ ELEVEN_VOICE_ID is not set");

// Twilio media: 8 kHz, 16-bit PCM, mono, 20 ms frames (160 samples → 320 bytes)
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME   = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// ───────────────────────────────────────────────────────────────────────────────
// LOW-LEVEL AUDIO I/O
// ───────────────────────────────────────────────────────────────────────────────
async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  let frames = 0;

  while (offset < pcmBuffer.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);
    const payload = (frame.length === BYTES_PER_FRAME)
      ? frame.toString("base64")
      : Buffer.concat([frame, Buffer.alloc(BYTES_PER_FRAME - frame.length)]).toString("base64");

    ws.send(JSON.stringify({ event: "media", media: { payload } }));
    frames++;
    if (frames % 100 === 0) console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS)/1000}s)`);
    await new Promise(r => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
}

async function ttsElevenLabsPcm8k(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/pcm"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      output_format: "pcm_8000"
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${body}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(`[WARN] PCM length ${buf.length} not sample-aligned; Twilio may ignore a tail byte.`);
  }
  return buf;
}

// Simple 1 kHz tone (test/beep)
function tone1k(durationMs = 500, vol = 0.2) {
  const samples = Math.floor(SAMPLE_RATE * (durationMs / 1000));
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  const f = 1000;
  for (let i = 0; i < samples; i++) {
    const s = Math.sin(2 * Math.PI * f * (i / SAMPLE_RATE));
    const v = Math.max(-1, Math.min(1, s * vol));
    buf.writeInt16LE(Math.floor(v * 32767), i * 2);
  }
  return buf;
}

// Queue & speak
async function speak(ws, text) {
  try {
    const pcm = await ttsElevenLabsPcm8k(text);
    await streamPcmToTwilio(ws, pcm);
  } catch (e) {
    console.error("[TTS] error:", e.message);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// TINY BRAIN: intents + state machine
// ───────────────────────────────────────────────────────────────────────────────
const calls = new Map(); // callSid -> state

function getState(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      stage: "greeting",
      lastHeard: "",
      intent: "",
      slots: { name: "", phone: "", date: "", time: "", area: "", message: "" }
    });
  }
  return calls.get(callSid);
}

// Naive entity pickers
const rxName  = /\b(?:i(?:'m| am)\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/;
const rxPhone = /(\+?\d[\d\-\s().]{6,}\d)/;
const rxDate  = /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;
const rxTime  = /\b(\d{1,2}(:\d{2})?\s?(?:am|pm)?)\b/i;

// Very small NLU
function detectIntent(text) {
  const t = text.toLowerCase();

  if (/\b(hours?|open|close|closing|time)\b/.test(t)) return { intent: "hours" };
  if (/\b(area|areas|service|serve|coverage|where)\b/.test(t)) return { intent: "service_area" };
  if (/\b(appointment|book|schedule|consult|visit|meeting)\b/.test(t)) return { intent: "book_appt" };
  if (/\b(voicemail|message|leave a message|record|call back)\b/.test(t)) return { intent: "voicemail" };

  // fallback — greeting/affirm/negation
  if (/\b(hi|hello|hey)\b/.test(t)) return { intent: "greet" };
  if (/\b(yes|yeah|yep|sure|ok)\b/.test(t)) return { intent: "affirm" };
  if (/\b(no|nope|not now|later)\b/.test(t)) return { intent: "deny" };

  return { intent: "unknown" };
}

async function handleIntent(ws, callSid, text) {
  const s = getState(callSid);
  s.lastHeard = text || "";

  // slot extraction pass
  const name  = (text.match(rxName)  || [,""])[1];
  const phone = (text.match(rxPhone) || [,""])[1];
  const date  = (text.match(rxDate)  || [,""])[0];
  const time  = (text.match(rxTime)  || [,""])[1];

  if (name  && !s.slots.name)  s.slots.name  = name;
  if (phone && !s.slots.phone) s.slots.phone = phone;
  if (date  && !s.slots.date)  s.slots.date  = date;
  if (time  && !s.slots.time)  s.slots.time  = time;

  // detect or continue current intent
  const { intent } = s.intent ? { intent: s.intent } : detectIntent(text);
  if (!s.intent) s.intent = intent;

  switch (s.stage) {
    case "greeting": {
      // If caller spoke first thing
      if (!s.intent || s.intent === "greet") {
        s.stage = "listening";
        await speak(ws, `Hi, you’ve reached ${BIZ_NAME}. I can share our hours and service areas, book an appointment, or take a voicemail. How can I help?`);
        break;
      }
      s.stage = "routing";
      return handleIntent(ws, callSid, text); // re-enter
    }

    case "listening": {
      if (intent === "hours") {
        s.stage = "done";
        await speak(ws, `We’re open ${BIZ_HOURS}. Anything else I can help with?`);
        s.intent = ""; s.stage = "listening"; // keep the line alive
        break;
      }
      if (intent === "service_area") {
        s.stage = "done";
        const areaStr = BIZ_AREAS.join(", ");
        await speak(ws, `We currently serve ${areaStr}. Would you like to book an appointment?`);
        s.intent = ""; s.stage = "listening";
        break;
      }
      if (intent === "book_appt") {
        s.stage = "book_collect";
        await speak(ws, `Great. What date and time works for you? You can say something like “tomorrow at 2 pm”.`);
        break;
      }
      if (intent === "voicemail") {
        s.stage = "vm_intro";
        await speak(ws, `Okay. After the tone, please dictate your message. Say “done” when you finish.`);
        await streamPcmToTwilio(ws, tone1k(600));
        s.slots.message = "";
        break;
      }
      // Unknown → nudge
      await speak(ws, `I can help with hours, service area, booking, or taking a message. What would you like to do?`);
      break;
    }

    case "book_collect": {
      // keep harvesting slots until we have date+time and a name/phone
      if (!s.slots.date) {
        await speak(ws, `What date would you like? You can say “tomorrow” or a calendar date.`);
        break;
      }
      if (!s.slots.time) {
        await speak(ws, `What time works for you?`);
        break;
      }
      if (!s.slots.name) {
        await speak(ws, `Got it. What name should I put the appointment under?`);
        break;
      }
      if (!s.slots.phone) {
        await speak(ws, `And a callback number, just in case?`);
        break;
      }
      // Confirm
      s.stage = "book_confirm";
      await speak(ws, `Confirming: ${s.slots.name}, ${s.slots.phone}, ${s.slots.date} at ${s.slots.time}. Is that correct?`);
      break;
    }

    case "book_confirm": {
      if (/\b(yes|correct|that’s right|sounds good|yep|sure)\b/i.test(text)) {
        s.stage = "done";
        await speak(ws, `Perfect — I’ll save that now and send a confirmation text if available.`);
        // push webhook
        if (APPT_WEBHOOK) {
          postJSON(APPT_WEBHOOK, { type: "appointment", callSid, ...s.slots }).catch(()=>{});
        } else {
          console.log("[APPT]", { type: "appointment", callSid, ...s.slots });
        }
        s.intent = ""; s.stage = "listening"; s.slots = { name:"", phone:"", date:"", time:"", area:"", message:"" };
        break;
      }
      if (/\b(no|change|edit|wrong)\b/i.test(text)) {
        s.stage = "book_collect";
        await speak(ws, `No worries. What would you like to change — the date, the time, the name, or the phone number?`);
        break;
      }
      await speak(ws, `Sorry, was that a yes to confirm the appointment?`);
      break;
    }

    case "vm_intro":
    case "vm_record": {
      s.stage = "vm_record";
      const t = text.trim();
      if (/^(done|that’s all|end)$/i.test(t)) {
        s.stage = "done";
        await speak(ws, `Thanks! I’ve saved your message and will route it to the right team.`);
        // push webhook
        const payload = { type: "voicemail", callSid, name: s.slots.name, phone: s.slots.phone, message: s.slots.message.trim() };
        if (VOICEMAIL_WEBHOOK) postJSON(VOICEMAIL_WEBHOOK, payload).catch(()=>{});
        else console.log("[VOICEMAIL]", payload);
        s.intent = ""; s.stage = "listening"; s.slots = { name:"", phone:"", date:"", time:"", area:"", message:"" };
      } else {
        // keep appending transcript to message buffer
        if (t) s.slots.message += (s.slots.message ? " " : "") + t;
        // light keep-alive tone every ~8s handled elsewhere
      }
      break;
    }

    default: {
      // safety net
      s.stage = "listening";
      await speak(ws, `How else can I help?`);
    }
  }
}

// optional webhook post
async function postJSON(url, body) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER (Twilio <Connect><Stream> hits wss://.../stream)
// IMPORTANT: TwiML for <Connect><Stream> must use track="inbound_track" (no bidi)
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const wss = new WebSocketServer({ noServer: true });

// Keep-alive: every 4s of silence, send 200 silent frames (~4s) so Twilio doesn't drop
const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME, 0);
function startKeepalive(ws) {
  let accumFrames = 0;
  const loop = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    // push ~4s of silence (200 frames)
    for (let i = 0; i < 200; i++) {
      ws.send(JSON.stringify({ event: "media", media: { payload: SILENCE_FRAME.toString("base64") }}));
      accumFrames++;
    }
    console.log("[KEEPALIVE] sent 200 silence frames (~4s)");
  }, 4000);
  ws._keepalive = loop;
}
function stopKeepalive(ws) {
  if (ws._keepalive) clearInterval(ws._keepalive);
  ws._keepalive = null;
}

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  // Start slow keepalive so Twilio won’t idle time out during caller pauses
  startKeepalive(ws);

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      const callSid = msg.start?.callSid || "unknown";
      const s = getState(callSid);
      console.log(`[WS] START callSid=${callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`);

      // quick 1 kHz chirp + greeting
      await streamPcmToTwilio(ws, tone1k(500, 0.15));
      await speak(ws, `Hi! I’m your AI receptionist. How can I help you today?`);
      s.stage = "listening";
    }

    if (msg.event === "media") {
      // Inbound caller audio — we don’t decode here (Twilio Scribe will send text events)
      ws._rx = (ws._rx || 0) + 1;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
    }

    // This is where the “brain” wakes up — when Twilio Scribe sends text.
    // Make sure your TwiML <Connect><Stream> has proper Scribe config on your side.
    if (msg.event === "transcription" && msg.text) {
      // Only react on final/meaningful chunks; if your Scribe sends interim, you can gate on msg.is_final
      const callSid = msg.transcription?.call_sid || msg.start?.callSid || "unknown";
      console.log("[STT]", msg.text);
      await handleIntent(ws, callSid, msg.text);
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
      stopKeepalive(ws);
    }
  });

  ws.on("close", () => {
    console.log("[WS] CLOSE code=1005 reason=");
    stopKeepalive(ws);
  });

  ws.on("error", (err) => {
    console.error("[WS] error", err);
    stopKeepalive(ws);
  });
});

// HTTP server + WS upgrade (only /stream)
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// Health
app.get("/", (_req, res) => res.status(200).send("OK"));
