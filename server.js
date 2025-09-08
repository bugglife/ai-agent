import express from "express";import express from "express";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws"; // <-- default WS used to dial Deepgram
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";
import { createClient } from "@supabase/supabase-js";

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const MEDIA_FORMAT = (process.env.TWILIO_MEDIA_FORMAT || "pcm16").toLowerCase();

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BOOKING_DURATION_MIN = parseInt(process.env.BOOKING_DURATION_MIN || "120", 10);
const TIMEZONE = process.env.TIMEZONE || "UTC";

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!DEEPGRAM_API_KEY) console.error("❌ DEEPGRAM_API_KEY is not set");
if (!["pcm16", "mulaw"].includes(MEDIA_FORMAT)) {
  console.warn(`⚠️ Unknown TWILIO_MEDIA_FORMAT='${MEDIA_FORMAT}', defaulting to pcm16`);
}

if (!SUPABASE_URL) console.error("❌ SUPABASE_URL not set");
if (!SUPABASE_SERVICE_ROLE) console.error("❌ SUPABASE_SERVICE_ROLE not set");

// Supabase (server-side)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

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

function linearToMulawSample(s) {
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
  const pcm = makeBeepPcm16(ms, hz);
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0, j = 0; i < pcm.length; i += 2, j++) {
    const s = pcm.readInt16LE(i);
    out[j] = linearToMulawSample(s);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS (ElevenLabs → desired format) via ffmpeg
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabsRaw(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
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
    ff.stdin.on("error", () => {});
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
    "-hide_banner","-nostdin","-loglevel","error",
    "-i","pipe:0",
    "-ac","1",
    "-ar","8000",
    "-f","s16le",
    "-acodec","pcm_s16le",
    "pipe:1",
  ]);
  if (out.length % 2 !== 0) out = out.slice(0, out.length - 1);
  return out;
}

async function ttsToMulaw(text) {
  const input = await ttsElevenLabsRaw(text);
  console.log("[TTS] Received MP3 container. Transcoding → µ-law/8k/mono");
  return await ffmpegTranscode(input, [
    "-hide_banner","-nostdin","-loglevel","error",
    "-i","pipe:0",
    "-ac","1",
    "-ar","8000",
    "-f","mulaw",
    "-acodec","pcm_mulaw",
    "pipe:1",
  ]);
}

// ───────────────────────────────────────────────────────────────────────────────
// Twilio outbound media (sends frames back to caller)
// ───────────────────────────────────────────────────────────────────────────────
async function streamFrames(ws, raw) {
  const bytesPerFrame = MEDIA_FORMAT === "mulaw" ? BYTES_PER_FRAME_MULAW : BYTES_PER_FRAME_PCM16;
  let offset = 0, frames = 0;

  while (offset < raw.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + bytesPerFrame, raw.length);
    let frame = raw.slice(offset, end);
    if (frame.length < bytesPerFrame) {
      const padded = Buffer.alloc(bytesPerFrame);
      frame.copy(padded, 0);
      frame = padded;
    }

    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws._streamSid,
      media: { payload: frame.toString("base64") },
    }));

    frames++;
    if (frames % 100 === 0) console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += bytesPerFrame;
  }
}

async function speak(ws, text) {
  try {
    const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
    await streamFrames(ws, buf);
  } catch (e) {
    console.error("[TTS] speak error:", e.message);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram bridge (ASR)
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(ws) {
  const params = new URLSearchParams({
    model: "nova-2",
    encoding: MEDIA_FORMAT === "mulaw" ? "mulaw" : "linear16",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: "true",
  });

  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const dg = new WebSocket(url, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }});
  ws._dg = dg;

  dg.on("open", () => console.log("[DG] connected"));
  dg.on("close", () => console.log("[DG] close"));
  dg.on("error", (e) => console.error("[DG] error", e?.message || e));

  dg.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const alt = msg.channel?.alternatives?.[0];
      const transcript = alt?.transcript;
      if (transcript) {
        const isFinal = !!msg.is_final || !!msg.speech_final;
        handleTranscript(ws, transcript, isFinal);
      }
    } catch {}
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Availability helpers (Supabase)
// ───────────────────────────────────────────────────────────────────────────────
function resolveDate(dateStr) {
  const s = (dateStr || "").toLowerCase().trim();
  const now = new Date();
  const dow = { sunday:0,sun:0,monday:1,mon:1,tuesday:2,tue:2,tues:2,wednesday:3,wed:3,thursday:4,thu:4,thurs:4,friday:5,fri:5,saturday:6,sat:6 };

  if (s === "today") return toYMD(now);
  if (s === "tomorrow") return toYMD(addDays(now, 1));
  if (dow[s] !== undefined) return toYMD(nextWeekday(now, dow[s]));

  const m = s.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    const mm = parseInt(m[1], 10) - 1;
    const dd = parseInt(m[2], 10);
    return toYMD(new Date(now.getFullYear(), mm, dd));
  }
  return null;
}
function toYMD(d){ const yyyy=d.getFullYear(); const mm=String(d.getMonth()+1).padStart(2,"0"); const dd=String(d.getDate()).padStart(2,"0"); return `${yyyy}-${mm}-${dd}`; }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function nextWeekday(from, target){ const d=new Date(from); const cur=d.getDay(); let delta=target-cur; if(delta<=0) delta+=7; d.setDate(d.getDate()+delta); return d; }

function buildSlotRange(dateStr, timeStr) {
  const ymd = resolveDate(dateStr);
  if (!ymd || !timeStr) return null;
  const [hh, mm] = timeStr.split(":").map((n)=>parseInt(n,10));
  const local = new Date(`${ymd}T${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00`);
  const start = new Date(local.getTime());
  const end = new Date(local.getTime() + BOOKING_DURATION_MIN * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString(), localStart: local };
}

async function isSlotAvailable(startISO, endISO) {
  const { data, error } = await supabase
    .from("appointments")
    .select("id, starts_at, ends_at, status")
    .or("status.eq.booked,status.eq.hold")
    .lt("starts_at", endISO)
    .gt("ends_at", startISO);

  if (error) {
    console.error("[AVAILABILITY] Supabase error:", error);
    return { ok:false, reason:"db_error" };
  }
  const conflict = (data || []).length > 0;
  return { ok:true, available: !conflict };
}

// ───────────────────────────────────────────────────────────────────────────────
// Dialog manager (lightweight)
// ───────────────────────────────────────────────────────────────────────────────
function parseDateTime(utterance) {
  const text = (utterance || "").toLowerCase().trim();
  const dayRe = /\b(today|tomorrow|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?|\d{1,2}\/\d{1,2})\b/i;
  const timeRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

  const mDate = text.match(dayRe);
  const mTime = text.match(timeRe);

  let dateStr = mDate ? mDate[0] : null;
  let timeStr = null;

  if (mTime) {
    let h = parseInt(mTime[1], 10);
    let min = mTime[2] ? parseInt(mTime[2], 10) : 0;
    const ap = mTime[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h <= 7) h += 12;
    timeStr = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return { dateStr, timeStr };
}

function detectIntent(text) {
  const t = (text || "").toLowerCase();
  if (/\b(hours?|closing|open)\b/.test(t)) return "ask_hours";
  if (/\b(available|availability|book|schedule|appointment)\b/.test(t)) return "availability";
  if (/\b(prices?|pricing|cost|rate)\b/.test(t)) return "pricing";
  if (/\b(yes|correct|that works|sounds good|okay|ok)\b/.test(t)) return "affirm";
  if (/\b(no|not really|change|different|actually)\b/.test(t)) return "negate";
  return "unknown";
}

function initDM(ws) {
  ws._dm = { state: "idle", slots: { date: null, time: null }, _debounceTimer: null, _lastPartial: "" };
}

function handleTranscript(ws, rawText, isFinal=false) {
  if (!ws?._dm) initDM(ws);
  const text = (rawText || "").trim();
  if (!text) return;

  const DEBOUNCE_MS = 1000;
  if (ws._dm._debounceTimer) clearTimeout(ws._dm._debounceTimer);

  if (isFinal) {
    processUserText(ws, text);
  } else {
    ws._dm._lastPartial = text;
    ws._dm._debounceTimer = setTimeout(() => {
      processUserText(ws, ws._dm._lastPartial);
      ws._dm._lastPartial = "";
    }, DEBOUNCE_MS);
  }
}

async function processUserText(ws, text) {
  console.log("[ASR]", text);

  const intent = detectIntent(text);
  const { dateStr, timeStr } = parseDateTime(text);
  if (dateStr) ws._dm.slots.date = dateStr;
  if (timeStr) ws._dm.slots.time = timeStr;

  if (intent === "ask_hours") {
    await speak(ws, "We're open Monday through Saturday, 8 a.m. to 6 p.m. How can I help you today?");
    ws._dm.state = "idle";
    return;
  }

  if (ws._dm.state === "idle" && intent === "availability") {
    ws._dm.state = "awaiting_availability_details";
    ws._dm.slots = { date: null, time: null };
    await speak(ws, "Sure, what date and time are you looking for?");
    return;
  }

  if (ws._dm.state === "awaiting_availability_details") {
    const haveDate = !!ws._dm.slots.date;
    const haveTime = !!ws._dm.slots.time;

    if (haveDate && haveTime) {
      ws._dm.state = "confirm_availability";
      const nice = `${ws._dm.slots.date} at ${ws._dm.slots.time.replace(":00", "")}`;
      await speak(ws, `Just to confirm, you're looking for ${nice}, right?`);
      return;
    }

    if (!haveDate && !haveTime) {
      await speak(ws, "I caught part of that. Could you please share both the date and the time?");
      return;
    }
    if (!haveDate) { await speak(ws, "Got it. And what date did you have in mind?"); return; }
    if (!haveTime) { await speak(ws, "Thanks. What time works best?"); return; }
  }

  if (ws._dm.state === "confirm_availability") {
    if (intent === "affirm") {
      const slot = buildSlotRange(ws._dm.slots.date, ws._dm.slots.time);
      if (!slot) {
        ws._dm.state = "awaiting_availability_details";
        await speak(ws, "I’m sorry, I didn’t quite catch the date and time. Could you repeat them?");
        return;
      }

      const { startISO, endISO, localStart } = slot;
      console.log("[AVAILABILITY] Checking", startISO, "→", endISO);

      const chk = await isSlotAvailable(startISO, endISO);
      if (!chk.ok) {
        await speak(ws, "I’m having trouble checking right now. Can I text you a confirmation shortly?");
        ws._dm.state = "idle";
        return;
      }

      if (chk.available) {
        const localNice = localStart.toLocaleString("en-US", { timeZone: TIMEZONE, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
        await speak(ws, `Great news — we have availability on ${localNice}. Would you like me to book it?`);
        ws._dm.state = "idle";
      } else {
        await speak(ws, "It looks like that time is taken. Would you like earlier or later the same day?");
        ws._dm.state = "awaiting_availability_details";
        ws._dm.slots.time = null;
      }
      return;
    }

    if (intent === "negate") {
      ws._dm.state = "awaiting_availability_details";
      ws._dm.slots = { date: null, time: null };
      await speak(ws, "No problem. What date and time are you looking for?");
      return;
    }

    if (ws._dm.slots.date && ws._dm.slots.time) {
      const nice = `${ws._dm.slots.date} at ${ws._dm.slots.time.replace(":00", "")}`;
      await speak(ws, `Thanks! So ${nice}. Would you like me to check availability?`);
      ws._dm.state = "confirm_availability";
      return;
    }

    await speak(ws, "Sorry, I didn't catch that. Is the date and time I mentioned okay?");
    return;
  }

  if (ws._dm.state === "idle") {
    if (intent === "pricing") {
      await speak(ws, "Standard cleanings start at one hundred twenty dollars. Would you like a quote?");
      return;
    }
    await speak(ws, "I can help with pricing, availability, or booking. What would you like to do?");
    return;
  }

  await speak(ws, "Could you say that again?");
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket (Twilio <Connect><Stream> → wss://…/stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  initDM(ws);

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      // connect Deepgram as soon as call starts
      if (DEEPGRAM_API_KEY) connectDeepgram(ws);

      try {
        if (MEDIA_FORMAT === "mulaw") {
          await streamFrames(ws, makeBeepMulaw(180, 950));
        } else {
          await streamFrames(ws, makeBeepPcm16(180, 950));
        }
        console.log("[BEEP] done.");

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
      // forward audio to Deepgram
      const b64 = msg.media?.payload;
      if (b64 && ws._dg && ws._dg.readyState === WebSocket.OPEN) {
        const audio = Buffer.from(b64, "base64");
        ws._dg.send(audio);
      }

      ws._rx = (ws._rx || 0) + 1;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
      try { ws._dg?.close(); } catch {}
    }
  });

  ws.on("close", () => {
    if (ws._dm?._debounceTimer) clearTimeout(ws._dm._debounceTimer);
    try { ws._dg?.close(); } catch {}
    console.log("[WS] CLOSE code=1005 reason=");
  });
  ws.on("error", (err) => console.error("[WS] error", err));
});

const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

app.get("/", (_req, res) => res.status(200).send("OK"));

import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";
import { createClient } from "@supabase/supabase-js";

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const MEDIA_FORMAT = (process.env.TWILIO_MEDIA_FORMAT || "pcm16").toLowerCase();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const BOOKING_DURATION_MIN = parseInt(process.env.BOOKING_DURATION_MIN || "120", 10);
const TIMEZONE = process.env.TIMEZONE || "UTC";

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!ELEVEN_VOICE_ID) console.error("❌ ELEVEN_VOICE_ID is not set");
if (!["pcm16", "mulaw"].includes(MEDIA_FORMAT)) {
  console.warn(`⚠️ Unknown TWILIO_MEDIA_FORMAT='${MEDIA_FORMAT}', defaulting to pcm16`);
}

if (!SUPABASE_URL) console.error("❌ SUPABASE_URL not set");
if (!SUPABASE_SERVICE_ROLE) console.error("❌ SUPABASE_SERVICE_ROLE not set");

// Supabase (server-side)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

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
      Accept: "audio/mpeg",
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
// Availability helpers (Supabase)
// ───────────────────────────────────────────────────────────────────────────────

// Resolve casual date strings ("today", "tomorrow", "saturday", "10/12") to a YYYY-MM-DD (local).
function resolveDate(dateStr) {
  const s = (dateStr || "").toLowerCase().trim();
  const now = new Date();
  const dowMap = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
  };

  if (s === "today") return toYMD(now);
  if (s === "tomorrow") return toYMD(addDays(now, 1));

  if (dowMap[s] !== undefined) {
    const target = nextWeekday(now, dowMap[s]);
    return toYMD(target);
  }

  // mm/dd
  const m = s.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    const mm = parseInt(m[1], 10) - 1;
    const dd = parseInt(m[2], 10);
    const d = new Date(now.getFullYear(), mm, dd);
    return toYMD(d);
  }

  // If not recognized, return null
  return null;
}

function toYMD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function nextWeekday(from, targetDow) {
  const d = new Date(from);
  const cur = d.getDay();
  let delta = targetDow - cur;
  if (delta <= 0) delta += 7;
  d.setDate(d.getDate() + delta);
  return d;
}

// Build start/end timestamps (UTC ISO) for a requested date+time, using BOOKING_DURATION_MIN
function buildSlotRange(dateStr, timeStr) {
  const ymd = resolveDate(dateStr);
  if (!ymd || !timeStr) return null;

  // timeStr like "14:00" (24h)
  const [hh, mm] = timeStr.split(":").map((n) => parseInt(n, 10));
  const local = new Date(`${ymd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`);
  const start = new Date(local.getTime());
  const end = new Date(local.getTime() + BOOKING_DURATION_MIN * 60 * 1000);

  return { startISO: start.toISOString(), endISO: end.toISOString(), localStart: local };
}

// Query Supabase to see if there’s any overlapping appointment (booked/hold)
async function isSlotAvailable(startISO, endISO) {
  const { data, error } = await supabase
    .from("appointments")
    .select("id, starts_at, ends_at, status")
    .or("status.eq.booked,status.eq.hold")
    .lt("starts_at", endISO)
    .gt("ends_at", startISO);

  if (error) {
    console.error("[AVAILABILITY] Supabase error:", error);
    // Fail open (say “we’ll check and get back to you”) – but here we just return false.
    return { ok: false, reason: "db_error" };
  }
  const conflict = (data || []).length > 0;
  return { ok: true, available: !conflict };
}

// ───────────────────────────────────────────────────────────────────────────────
// Dialog Manager helpers (parsing, speaking, debounce)
// ───────────────────────────────────────────────────────────────────────────────
async function speak(ws, text) {
  try {
    const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
    await streamFrames(ws, buf);
  } catch (e) {
    console.error("[TTS] speak error:", e.message);
  }
}

function parseDateTime(utterance) {
  const text = (utterance || "").toLowerCase().trim();

  const dayRe =
    /\b(today|tomorrow|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?|\d{1,2}\/\d{1,2})\b/i;
  const mDate = text.match(dayRe);

  const timeRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
  const mTime = text.match(timeRe);

  let dateStr = mDate ? mDate[0] : null;

  let timeStr = null;
  if (mTime) {
    let h = parseInt(mTime[1], 10);
    let min = mTime[2] ? parseInt(mTime[2], 10) : 0;
    const ap = mTime[3]?.toLowerCase();

    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;

    if (!ap && h <= 7) h += 12;

    timeStr = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  return { dateStr, timeStr };
}

function detectIntent(text) {
  const t = (text || "").toLowerCase();
  if (/\b(hours?|closing|open)\b/.test(t)) return "ask_hours";
  if (/\b(available|availability|book|schedule|appointment)\b/.test(t)) return "availability";
  if (/\b(prices?|pricing|cost|rate)\b/.test(t)) return "pricing";
  if (/\b(yes|correct|that works|sounds good|okay|ok)\b/.test(t)) return "affirm";
  if (/\b(no|not really|change|different|actually)\b/.test(t)) return "negate";
  return "unknown";
}

function initDM(ws) {
  ws._dm = {
    state: "idle",
    slots: { date: null, time: null },
    _debounceTimer: null,
    _lastPartial: "",
  };
}

function handleTranscript(ws, rawText, isFinal = false) {
  if (!ws?._dm) initDM(ws);
  const text = (rawText || "").trim();
  if (!text) return;

  const DEBOUNCE_MS = 1000;
  if (ws._dm._debounceTimer) clearTimeout(ws._dm._debounceTimer);

  if (isFinal) {
    processUserText(ws, text);
  } else {
    ws._dm._lastPartial = text;
    ws._dm._debounceTimer = setTimeout(() => {
      processUserText(ws, ws._dm._lastPartial);
      ws._dm._lastPartial = "";
    }, DEBOUNCE_MS);
  }
}

async function processUserText(ws, text) {
  console.log("[ASR]", text);

  const intent = detectIntent(text);
  const { dateStr, timeStr } = parseDateTime(text);

  if (dateStr) ws._dm.slots.date = dateStr;
  if (timeStr) ws._dm.slots.time = timeStr;

  if (intent === "ask_hours") {
    await speak(ws, "We're open Monday through Saturday, 8 a.m. to 6 p.m. How can I help you today?");
    ws._dm.state = "idle";
    return;
  }

  if (ws._dm.state === "idle" && intent === "availability") {
    ws._dm.state = "awaiting_availability_details";
    ws._dm.slots = { date: null, time: null };
    await speak(ws, "Sure, what date and time are you looking for?");
    return;
  }

  if (ws._dm.state === "awaiting_availability_details") {
    const haveDate = !!ws._dm.slots.date;
    const haveTime = !!ws._dm.slots.time;

    if (haveDate && haveTime) {
      ws._dm.state = "confirm_availability";
      const nice = `${ws._dm.slots.date} at ${ws._dm.slots.time.replace(":00", "")}`;
      await speak(ws, `Just to confirm, you're looking for ${nice}, right?`);
      return;
    }

    if (!haveDate && !haveTime) {
      await speak(ws, "I caught part of that. Could you please share both the date and the time?");
      return;
    }
    if (!haveDate) {
      await speak(ws, "Got it. And what date did you have in mind?");
      return;
    }
    if (!haveTime) {
      await speak(ws, "Thanks. What time works best?");
      return;
    }
  }

  if (ws._dm.state === "confirm_availability") {
    if (intent === "affirm") {
      // Real check here
      const slot = buildSlotRange(ws._dm.slots.date, ws._dm.slots.time);
      if (!slot) {
        ws._dm.state = "awaiting_availability_details";
        await speak(ws, "I’m sorry, I didn’t quite catch the date and time. Could you repeat them?");
        return;
      }

      const { startISO, endISO, localStart } = slot;
      console.log("[AVAILABILITY] Checking", startISO, "→", endISO);

      const chk = await isSlotAvailable(startISO, endISO);
      if (!chk.ok) {
        await speak(ws, "I’m having trouble checking right now. Can I text you a confirmation in a moment?");
        ws._dm.state = "idle";
        return;
      }

      if (chk.available) {
        const localNice = localStart.toLocaleString("en-US", { timeZone: TIMEZONE, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
        await speak(ws, `Great news — we have availability on ${localNice}. Would you like me to book it?`);
        ws._dm.state = "idle"; // keep simple; next step would be booking flow
      } else {
        await speak(ws, "It looks like that time is taken. Would you like me to check earlier or later the same day?");
        ws._dm.state = "awaiting_availability_details";
        // keep their date; clear time so we ask for a new time
        ws._dm.slots.time = null;
      }
      return;
    }

    if (intent === "negate") {
      ws._dm.state = "awaiting_availability_details";
      ws._dm.slots = { date: null, time: null };
      await speak(ws, "No problem. What date and time are you looking for?");
      return;
    }

    // If user replaced date/time during confirm step, accept and reconfirm
    if (ws._dm.slots.date && ws._dm.slots.time) {
      const nice = `${ws._dm.slots.date} at ${ws._dm.slots.time.replace(":00", "")}`;
      await speak(ws, `Thanks! So ${nice}. Would you like me to check availability?`);
      ws._dm.state = "confirm_availability";
      return;
    }

    await speak(ws, "Sorry, I didn't catch that. Is the date and time I mentioned okay?");
    return;
  }

  if (ws._dm.state === "idle") {
    if (intent === "pricing") {
      await speak(ws, "Standard cleanings start at one hundred twenty dollars. Would you like a quote?");
      return;
    }
    await speak(ws, "I can help with pricing, availability, or booking. What would you like to do?");
    return;
  }

  await speak(ws, "Could you say that again?");
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket (Twilio <Connect><Stream> → wss://…/stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  initDM(ws);

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      try {
        if (MEDIA_FORMAT === "mulaw") {
          await streamFrames(ws, makeBeepMulaw(180, 950));
        } else {
          await streamFrames(ws, makeBeepPcm16(180, 950));
        }
        console.log("[BEEP] done.");

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

    // Accept transcripts from different shapes
    const dgAlt = msg?.speech?.alternatives?.[0];
    const dgText = dgAlt?.transcript;
    const dgFinal = (msg?.speech?.is_final ?? undefined);

    const genericText = msg?.transcript || msg?.text || msg?.asr;
    const genericFinal = msg?.is_final ?? msg?.final ?? false;

    const textCandidate = dgText || genericText;
    const isFinal = (dgFinal !== undefined) ? dgFinal : genericFinal;

    if (textCandidate) {
      handleTranscript(ws, textCandidate, !!isFinal);
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
    }
  });

  ws.on("close", () => {
    if (ws._dm?._debounceTimer) clearTimeout(ws._dm._debounceTimer);
    console.log("[WS] CLOSE code=1005 reason=");
  });
  ws.on("error", (err) => console.error("[WS] error", err));
});

const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

app.get("/", (_req, res) => res.status(200).send("OK"));
