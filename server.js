import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// pcm16 | mulaw  (set in Render env)
const MEDIA_FORMAT = (process.env.TWILIO_MEDIA_FORMAT || "pcm16").toLowerCase();

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!ELEVEN_VOICE_ID) console.error("❌ ELEVEN_VOICE_ID is not set");
if (!DEEPGRAM_API_KEY) console.error("❌ DEEPGRAM_API_KEY is not set");
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
// Utilities (beep generators & μ-law helpers)
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

// μ-law compand/expand
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
function pcm16ToMulaw(pcm) {
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0, j = 0; i < pcm.length; i += 2, j++) {
    const s = pcm.readInt16LE(i);
    out[j] = linearToMulawSample(s);
  }
  return out;
}
function mulawToPcm16(ulaw) {
  // Fast μ-law decode to PCM16
  const MULAW_MAX = 0x1fff;
  const MULAW_BIAS = 33;
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0, j = 0; i < ulaw.length; i++, j += 2) {
    let u = ~ulaw[i] & 0xff;
    let sign = (u & 0x80) ? -1 : 1;
    let exponent = (u >> 4) & 0x07;
    let mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample = sign * sample;
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    out.writeInt16LE(sample, j);
  }
  return out;
}
function makeBeepMulaw(ms = 180, hz = 950) {
  return pcm16ToMulaw(makeBeepPcm16(ms, hz));
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS: ElevenLabs → (PCM16 | μ-law) via ffmpeg
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
  console.log("[TTS] Received MP3 container. Transcoding → μ-law/8k/mono");
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
// Outbound streaming helper (Twilio)
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

// A tiny queue so TTS never overlaps
function say(ws, text) {
  if (!ws._ttsQueue) ws._ttsQueue = Promise.resolve();
  ws._ttsQueue = ws._ttsQueue.then(async () => {
    console.log("[TTS] ->", text);
    const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
    await streamFrames(ws, buf);
  }).catch((e) => console.error("[TTS] error in queue:", e.message));
  return ws._ttsQueue;
}

// ───────────────────────────────────────────────────────────────────────────────
// ASR: Deepgram realtime (we forward Twilio audio → DG; handle transcripts)
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(ws) {
  if (!DEEPGRAM_API_KEY) return;

  const url = "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000";
  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dg.on("open", () => console.log("[DG] connected"));
  dg.on("close", () => console.log("[DG] close"));
  dg.on("error", (err) => console.error("[DG] error", err));

  dg.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const alt = msg.channel?.alternatives?.[0];
      const text = (alt?.transcript || "").trim();
      const isFinal = !!msg.is_final;
      if (!text) return;
      if (isFinal) {
        console.log("[ASR]", text);
        onUserText(ws, text.toLowerCase());
      }
    } catch {}
  });

  ws._dg = dg;
}

// feed Twilio media into DG (convert μ-law → pcm16 when needed)
function sendAudioToDG(ws, base64Payload) {
  if (!ws._dg || ws._dg.readyState !== WebSocket.OPEN) return;
  const raw = Buffer.from(base64Payload, "base64");
  const pcm = MEDIA_FORMAT === "mulaw" ? mulawToPcm16(raw) : raw; // pcm16 passes through
  ws._dg.send(pcm);
}

// ───────────────────────────────────────────────────────────────────────────────
// Dialogue Manager – super simple rules + slots
// ───────────────────────────────────────────────────────────────────────────────
function initState(ws) {
  ws._dm = {
    step: "idle",
    slots: { date: null, time: null, bedrooms: null },
    lastActAt: Date.now(),
  };
}
function onUserText(ws, text) {
  ws._dm.lastActAt = Date.now();

  // quick intent guessers
  const has = (k) => text.includes(k);
  const intent =
    has("hour") || has("open") || has("close") ? "hours" :
    has("price") || has("pricing") || has("cost") ? "pricing" :
    has("availability") || has("available") || has("slot") ? "availability" :
    has("book") || has("schedule") || has("appointment") ? "booking" :
    has("bye") || has("goodbye") || has("thank") ? "goodbye" :
    "other";

  console.log("[DM] intent=", intent, "step=", ws._dm.step);

  // Simple slot filling for availability
  const maybeDate = text.match(/\b(mon|tue|wed|thu|fri|sat|sun|today|tomorrow|\d{1,2}\/\d{1,2})\b/i);
  const maybeTime = text.match(/\b(\d{1,2}(:\d{2})?\s?(am|pm)?)\b/i);

  if (ws._dm.step === "awaiting_availability_details") {
    if (maybeDate && !ws._dm.slots.date) ws._dm.slots.date = maybeDate[0];
    if (maybeTime && !ws._dm.slots.time) ws._dm.slots.time = maybeTime[0];

    if (ws._dm.slots.date && ws._dm.slots.time) {
      say(ws, `Great. We have openings around ${ws._dm.slots.time} on ${ws._dm.slots.date}. Would you like me to book that for you?`);
      ws._dm.step = "offer_booking";
      return;
    }
    say(ws, "Got it. Could you share the date and time you're looking for?");
    return;
  }

  if (ws._dm.step === "offer_booking") {
    if (has("yes") || has("yeah") || has("book")) {
      say(ws, "Awesome — I’ll text you a confirmation link to finalize the booking. Is that okay?");
      ws._dm.step = "confirm_sms";
      return;
    }
    if (has("no")) {
      say(ws, "No problem. Anything else I can help with — pricing, availability, or booking?");
      ws._dm.step = "idle";
      return;
    }
  }

  if (ws._dm.step === "confirm_sms") {
    if (has("yes")) {
      say(ws, "Perfect. I’ve sent the link. Thanks for calling Clean Easy!");
      ws._dm.step = "idle";
      return;
    }
    if (has("no")) {
      say(ws, "Alright — we can complete it over the phone later. Anything else I can help with?");
      ws._dm.step = "idle";
      return;
    }
  }

  // Top-level intents
  switch (intent) {
    case "hours":
      say(ws, "We’re open Monday through Saturday, 8 a.m. to 6 p.m., and Sundays 10 to 4.");
      break;

    case "pricing":
      say(ws, "Standard home cleanings start at one hundred twenty nine dollars for up to two bedrooms. Deep cleanings start at one ninety nine.");
      break;

    case "availability":
      ws._dm.step = "awaiting_availability_details";
      ws._dm.slots = { date: null, time: null };
      say(ws, "Sure — what date and time are you looking for?");
      break;

    case "booking":
      ws._dm.step = "offer_booking";
      say(ws, "Great — I can hold a spot for you. Would you like me to book the next available appointment?");
      break;

    case "goodbye":
      say(ws, "Thanks for calling Clean Easy. Have a great day!");
      break;

    default:
      // gentle fallback with options
      say(ws, "I can help with pricing, availability, or booking. Which would you like?");
      break;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket (Twilio <Connect><Stream> → wss://…/stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  initState(ws);

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      console.log(
        `[WS] event: connected proto=${msg.protocol} v=${msg.version}`
      );
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      // connect ASR
      connectDeepgram(ws);

      // Format beep so we instantly know format is correct
      const beep = MEDIA_FORMAT === "mulaw" ? makeBeepMulaw() : makeBeepPcm16();
      await streamFrames(ws, beep);
      console.log("[BEEP] done.");

      // Greeting
      say(ws, "Hi! I’m your A I receptionist at Clean Easy. How can I help you today?");
    }

    if (msg.event === "media") {
      ws._rx = (ws._rx || 0) + 1;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
      // forward to Deepgram
      if (msg.media?.payload) sendAudioToDG(ws, msg.media.payload);
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
    }
  });

  ws.on("close", () => {
    if (ws._dg && ws._dg.readyState === WebSocket.OPEN) ws._dg.close();
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
