import express from "express";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const DG_KEY = process.env.DEEPGRAM_API_KEY || "";

const MEDIA_FORMAT = (process.env.TWILIO_MEDIA_FORMAT || "pcm16").toLowerCase();
if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!["pcm16", "mulaw"].includes(MEDIA_FORMAT)) {
  console.warn(`⚠️ Unknown TWILIO_MEDIA_FORMAT='${MEDIA_FORMAT}', defaulting to pcm16`);
}

// Timing / frame sizes
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const BYTES_PER_SAMPLE_PCM16 = 2;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160 @ 8kHz, 20ms
const BYTES_PER_FRAME_PCM16 = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE_PCM16; // 320
const BYTES_PER_FRAME_MULAW = SAMPLES_PER_FRAME * 1; // 160

// ───────────────────────────────────────────────────────────────────────────────
// Utilities (beeps + μ-law compand/decompand)
// ───────────────────────────────────────────────────────────────────────────────
function makeBeepPcm16(ms = 180, hz = 950) {
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
  const BIAS = 0x84, CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s = s + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}
function mulawToLinearSample(u) {
  u = ~u & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign * sample;
}
function makeBeepMulaw(ms = 180, hz = 950) {
  const pcm = makeBeepPcm16(ms, hz);
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0, j = 0; i < pcm.length; i += 2, j++) {
    out[j] = linearToMulawSample(pcm.readInt16LE(i));
  }
  return out;
}

// Decode incoming Twilio frame → PCM16 (Deepgram needs linear16)
function inboundToPCM16(buf) {
  if (MEDIA_FORMAT === "pcm16") return buf; // already LE s16
  // μ-law → PCM16
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0, j = 0; i < buf.length; i++, j += 2) {
    out.writeInt16LE(mulawToLinearSample(buf[i]), j);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS via ElevenLabs (MP3) → ffmpeg → target format buffer
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
    body: JSON.stringify({ text, voice_settings: { stability: 0.4, similarity_boost: 0.7 } }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function ffmpegTranscode(inputBuf, args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const ff = spawn(ffmpegBin.path, args);
    ff.stdin.on("error", () => {});
    ff.stdout.on("data", d => chunks.push(d));
    ff.stderr.on("data", d => console.error("[ffmpeg]", d.toString().trim()));
    ff.on("close", code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`)));
    ff.stdin.end(inputBuf);
  });
}

async function ttsToPcm16(text) {
  const input = await ttsElevenLabsRaw(text);
  console.log("[TTS] Received MP3. → PCM16/8k/mono");
  let out = await ffmpegTranscode(input, [
    "-hide_banner","-nostdin","-loglevel","error",
    "-i","pipe:0","-ac","1","-ar","8000",
    "-f","s16le","-acodec","pcm_s16le","pipe:1",
  ]);
  if (out.length % 2 !== 0) out = out.slice(0, out.length - 1);
  return out;
}
async function ttsToMulaw(text) {
  const input = await ttsElevenLabsRaw(text);
  console.log("[TTS] Received MP3. → μ-law/8k/mono");
  return await ffmpegTranscode(input, [
    "-hide_banner","-nostdin","-loglevel","error",
    "-i","pipe:0","-ac","1","-ar","8000",
    "-f","mulaw","-acodec","pcm_mulaw","pipe:1",
  ]);
}

// Stream TTS frames out to Twilio
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
    ws.send(JSON.stringify({ event: "media", streamSid: ws._streamSid, media: { payload: frame.toString("base64") } }));
    frames++;
    if (frames % 100 === 0) console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    await new Promise(r => setTimeout(r, FRAME_MS));
    offset += bytesPerFrame;
  }
}

// Small helper that wraps TTS + stream + speaking gate
async function speak(ws, text) {
  if (ws._speaking) return;
  ws._speaking = true;
  try {
    const out = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
    await streamFrames(ws, out);
  } catch (e) {
    console.error("[TTS] speak failed:", e.message);
  } finally {
    ws._speaking = false;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Company FAQ + Booking-focused flow
// ───────────────────────────────────────────────────────────────────────────────
const COMPANY = {
  name: "Clean Easy",
  phone: "(555) 123-4567",
  email: "hello@bookcleaneasy.com",
  website: "bookcleaneasy.com",
  hours: "We’re open 8 AM–6 PM Monday–Friday, and 9 AM–2 PM on Saturday.",
  area: "We serve the greater metro area within a 25-minute drive.",
  guarantee: "If anything was missed, let us know within 24 hours and we’ll make it right.",
  cancellation: "Please give 24 hours notice to avoid a cancellation fee.",
  supplies: "Our teams bring supplies and equipment. If you prefer eco-friendly products, just ask.",
  pets: "We’re pet-friendly. Please secure pets if they’re anxious around vacuums.",
  services: "Standard, Deep, and Move-in/Move-out cleanings.",
  duration: "Most homes take 2–4 hours depending on size and condition.",
  prep: "Please tidy up surfaces and pick up items from floors so we can focus on cleaning.",
  payment: "We accept major credit cards and payment is due at the time of service."
};

const FAQS = [
  { triggers: ["hour","open","close","time"], answer: () => COMPANY.hours },
  { triggers: ["call","phone","number","contact"], answer: () => `You can reach us at ${COMPANY.phone}.` },
  { triggers: ["email","mail"], answer: () => `Our email is ${COMPANY.email}.` },
  { triggers: ["where","area","serve","service area","coverage"], answer: () => COMPANY.area },
  { triggers: ["guarantee","warranty","quality"], answer: () => COMPANY.guarantee },
  { triggers: ["cancel","cancellation","reschedule","rescheduling"], answer: () => COMPANY.cancellation },
  { triggers: ["supply","supplies","equipment","products"], answer: () => COMPANY.supplies },
  { triggers: ["pet","dog","cat","animal"], answer: () => COMPANY.pets },
  { triggers: ["service","what do you do","deep","move"], answer: () => COMPANY.services },
  { triggers: ["how long","duration","time take","hours take"], answer: () => COMPANY.duration },
  { triggers: ["prep","prepare","before","ready"], answer: () => COMPANY.prep },
  { triggers: ["pay","payment","card","credit"], answer: () => COMPANY.payment },
  { triggers: ["website","site"], answer: () => `You can also visit ${COMPANY.website}.` },
];

function answerFromKB(text) {
  const q = text.toLowerCase();
  for (const item of FAQS) {
    if (item.triggers.some(t => q.includes(t))) {
      return typeof item.answer === "function" ? item.answer(q) : item.answer;
    }
  }
  return null;
}

// naive date/time recognizer to move the flow forward (no external libs)
function detectDateTime(text) {
  const q = text.toLowerCase();
  const hasDay =
    /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)/.test(q) ||
    /\b(0?[1-9]|1[0-2])\/([0-2]?[0-9]|3[01])\b/.test(q) || // 3/14
    /\b([0-2]?[0-9])-(0?[1-9]|1[0-2])\b/.test(q);          // 14-3

  const timeMatch = q.match(/\b([0-1]?[0-9]|2[0-3])(:[0-5][0-9])?\s?(am|pm)?\b/);
  if (hasDay && timeMatch) return true;
  // “this saturday at 2” style
  if (/(saturday|sunday|monday|tuesday|wednesday|thursday|friday)\s+at\s+([0-1]?[0-9]|2[0-3])/.test(q)) return true;
  return false;
}

function basePrompt() {
  return "I can help you book an appointment and answer questions about Clean Easy. What can I help with?";
}

// prevent rapid re-asks
function shouldReask(ws, key, ms = 6000) {
  const now = Date.now();
  if (ws._lastPromptKey === key && ws._lastPromptAt && now - ws._lastPromptAt < ms) return false;
  ws._lastPromptKey = key;
  ws._lastPromptAt = now;
  return true;
}

async function handleUtterance(ws, txt) {
  const q = txt.toLowerCase();

  // 1) FAQ first
  const kb = answerFromKB(q);
  if (kb) {
    await speak(ws, kb + " Would you like to book an appointment?");
    return;
  }

  // Ensure ctx exists
  ws._ctx = ws._ctx || { flow: null, awaiting: null, datetime: null };

  // 2) New intent → booking by default
  if (!ws._ctx.flow) {
    if (q.includes("book") || q.includes("availability") || q.includes("available") || q.includes("appointment")) {
      ws._ctx.flow = "availability";
      ws._ctx.awaiting = "datetime";
      if (shouldReask(ws, "ask-dt")) {
        await speak(ws, "Sure—what date and time are you looking for?");
      }
      return;
    }
    // No intent → prompt
    await speak(ws, basePrompt());
    return;
  }

  // 3) Booking flow (very light)
  if (ws._ctx.flow === "availability") {
    if (ws._ctx.awaiting === "datetime") {
      if (detectDateTime(q)) {
        ws._ctx.datetime = txt;
        ws._ctx.awaiting = null;
        // You can plug a real availability check here later
        await speak(ws, `Great. We likely have availability ${txt}. I can pencil this in and a teammate will confirm shortly. Anything else I can help with?`);
        // reset flow so conversation can continue
        ws._ctx = { flow: null, awaiting: null, datetime: null };
        return;
      } else {
        if (shouldReask(ws, "ask-dt")) {
          await speak(ws, "Got it. Could you share the date and time you prefer? For example, Saturday at 2 PM.");
        }
        return;
      }
    }
  }

  // 4) Fallback
  await speak(ws, basePrompt());
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram realtime: forward inbound audio, get transcripts
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(onTranscript) {
  if (!DG_KEY) {
    console.warn("⚠️ DEEPGRAM_API_KEY missing — STT disabled.");
    return null;
  }
  const url = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&punctuate=true&vad_events=true&endpointing=true`;
  const dg = new WebSocket(url, { headers: { Authorization: `Token ${DG_KEY}` } });

  dg.on("open", () => console.log("[DG] connected"));
  dg.on("message", (d) => {
    try {
      const msg = JSON.parse(d.toString());
      if (msg.channel?.alternatives?.[0]?.transcript && (msg.is_final || msg.speech_final)) {
        const txt = msg.channel.alternatives[0].transcript.trim();
        if (txt) onTranscript(txt);
      }
    } catch {}
  });
  dg.on("close", () => console.log("[DG] close"));
  dg.on("error", (e) => console.error("[DG] error", e.message));
  return dg;
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket (Twilio <Stream> → wss://…/stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  ws._rx = 0;
  ws._speaking = false;
  ws._ctx = { flow: null, awaiting: null, datetime: null };
  ws._lastPromptAt = 0;
  ws._lastPromptKey = "";

  const dg = connectDeepgram(async (finalText) => {
    console.log(`[ASR] ${finalText}`);
    if (ws._speaking) return; // don't ASR-while-speaking to reduce barge-in
    try {
      await handleUtterance(ws, finalText);
    } catch (e) {
      console.error("[FLOW] error:", e.message);
    }
  });

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: connected proto=${msg.protocol} v=${msg.version}`);
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      if (MEDIA_FORMAT === "mulaw") await streamFrames(ws, makeBeepMulaw());
      else await streamFrames(ws, makeBeepPcm16());
      console.log("[BEEP] done.");

      try {
        console.log(`[TTS] greeting… (${MEDIA_FORMAT})`);
        await speak(ws, "Hi! I’m your AI receptionist at Clean Easy. I can help you book an appointment and answer questions. What can I help with?");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      ws._rx++;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
      if (dg && dg.readyState === dg.OPEN && !ws._speaking) {
        const b = Buffer.from(msg.media.payload, "base64");
        const pcm16 = inboundToPCM16(b);
        dg.send(pcm16);
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
      if (dg && dg.readyState === dg.OPEN) dg.close();
    }
  });

  ws.on("close", () => console.log("[WS] CLOSE code=1005"));
  ws.on("error", (err) => console.error("[WS] error", err));
});

// ───────────────────────────────────────────────────────────────────────────────
// HTTP: health + debug speak
// ───────────────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/debug/say", async (req, res) => {
  try {
    const text = (req.query.text || "This is a test.").toString();
    const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
    res.setHeader("Content-Type", MEDIA_FORMAT === "mulaw" ? "audio/basic" : "audio/L16");
    res.send(buf);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ───────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
