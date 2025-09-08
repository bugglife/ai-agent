import express from "express";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";

/* ──────────────────────────────────────────────────────────────────────────
   Config
   ────────────────────────────────────────────────────────────────────────── */
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

/* Timing / frame sizes */
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const BYTES_PER_SAMPLE_PCM16 = 2;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160 @ 8kHz, 20ms
const BYTES_PER_FRAME_PCM16 = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE_PCM16; // 320
const BYTES_PER_FRAME_MULAW = SAMPLES_PER_FRAME * 1; // 160

/* Dialog timing */
const BARGE_IN_HOLD_MS = 1200;  // ignore ASR for this long after we finish speaking
const REASK_COOLDOWN_MS = 5000; // don't repeat the same question faster than this

/* ──────────────────────────────────────────────────────────────────────────
   Utilities (beeps + μ-law compand/decompand)
   ────────────────────────────────────────────────────────────────────────── */
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

/* Decode incoming Twilio frame → PCM16 (Deepgram needs linear16) */
function inboundToPCM16(buf) {
  if (MEDIA_FORMAT === "pcm16") return buf; // already LE s16
  // μ-law → PCM16
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0, j = 0; i < buf.length; i++, j += 2) {
    out.writeInt16LE(mulawToLinearSample(buf[i]), j);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   TTS via ElevenLabs (MP3) → ffmpeg → target format buffer
   ────────────────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────────────────
   Outbound streaming (Twilio frames)
   ────────────────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────────────────
   Conversation helpers (FSM, parsing, availability)
   ────────────────────────────────────────────────────────────────────────── */

function basePrompt() {
  return "I can help with pricing, booking, and availability. What would you like to do?";
}

function parseDateTime(text) {
  // days
  const dayMap = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  const lower = text.toLowerCase();
  let dayIdx = null;
  for (const d in dayMap) {
    if (lower.includes(d)) { dayIdx = dayMap[d]; break; }
  }
  // time: "2", "2pm", "2:30", "14:00"
  const m = lower.match(/(\b\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m && dayIdx == null) return null;

  let h = m ? parseInt(m[1], 10) : null;
  let min = m && m[2] ? parseInt(m[2], 10) : 0;
  const ap = m && m[3] ? m[3] : null;

  if (h != null) {
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h <= 7) h += 12; // "2" → assume afternoon
  }

  return { dayIdx, hour: h, minute: min };
}

// Replace this with your real availability system later
function checkAvailability({ dayIdx, hour, minute }) {
  // assume slots every hour 9–5 except lunch at 12
  const hh = hour ?? 9;
  const slots = [];
  for (let i = 9; i <= 17; i++) if (i !== 12) slots.push(`${i % 12 || 12}:00`);
  const requested = `${(hh % 12) || 12}:${(minute ?? 0).toString().padStart(2, "0")}`;
  const ok = slots.includes(`${(hh % 12) || 12}:00`);
  return {
    ok,
    requested,
    suggestions: ok ? [requested] : slots.slice(0, 3),
  };
}

async function speak(ws, text) {
  ws._speaking = true;
  try {
    const out = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
    await streamFrames(ws, out);
  } finally {
    ws._speaking = false;
    ws._asrHoldUntil = Date.now() + BARGE_IN_HOLD_MS;
  }
}

function shouldReask(ws, promptKey) {
  const now = Date.now();
  if (ws._lastPromptKey !== promptKey) return true;
  return (now - (ws._lastPromptAt || 0)) > REASK_COOLDOWN_MS;
}

async function handleUtterance(ws, txt) {
  // basic guard: ignore speech while we're within the post-TTS hold
  if ((ws._asrHoldUntil || 0) > Date.now()) return;

  const q = txt.toLowerCase();

  // If we aren't in a flow yet, route high-level intent
  if (!ws._ctx.flow) {
    if (q.includes("price")) {
      ws._ctx.flow = "pricing";
      await speak(ws, "For standard cleanings we start at one hundred fifty dollars. Would you like to check availability?");
      return;
    }
    if (q.includes("book") || q.includes("availability") || q.includes("available")) {
      ws._ctx.flow = "availability";
      ws._ctx.awaiting = "datetime";
      if (shouldReask(ws, "ask-dt")) {
        ws._lastPromptKey = "ask-dt"; ws._lastPromptAt = Date.now();
        await speak(ws, "Sure—what date and time are you looking for?");
      }
      return;
    }
    if (q.includes("hour") || q.includes("open") || q.includes("close")) {
      await speak(ws, "We’re open eight a m to six p m Monday through Friday, and nine a m to two p m on Saturday. Would you like to check availability?");
      return;
    }
    await speak(ws, basePrompt());
    return;
  }

  // Availability flow
  if (ws._ctx.flow === "availability") {
    if (ws._ctx.awaiting === "datetime") {
      const dt = parseDateTime(q);
      if (!dt) {
        if (shouldReask(ws, "ask-dt")) {
          ws._lastPromptKey = "ask-dt"; ws._lastPromptAt = Date.now();
          await speak(ws, "Got it. Could you share the date and time you're looking for? For example, Saturday at two p m.");
        }
        return;
      }
      ws._ctx.request = dt;
      const result = checkAvailability(dt);
      if (result.ok) {
        ws._ctx.awaiting = null;
        await speak(ws, `We have availability at ${result.requested}. Would you like me to reserve that slot?`);
        ws._ctx.awaiting = "confirm";
        return;
      } else {
        ws._ctx.awaiting = "choice";
        await speak(ws, `I don’t have that exact time free. I can offer ${result.suggestions.join(", ")}. Which works best?`);
        return;
      }
    }

    if (ws._ctx.awaiting === "choice") {
      const dt = parseDateTime(q);
      if (dt) {
        const result = checkAvailability(dt);
        if (result.ok) {
          ws._ctx.awaiting = "confirm";
          await speak(ws, `Great, ${result.requested} works. Should I book it?`);
          return;
        }
      }
      // fallback pick first suggestion verbally
      await speak(ws, "I can do two p m, three p m, or four p m. Which would you prefer?");
      return;
    }

    if (ws._ctx.awaiting === "confirm") {
      if (q.includes("yes") || q.includes("book") || q.includes("sure") || q.includes("confirm")) {
        await speak(ws, "All set. I’ve reserved that slot. Anything else I can help with?");
        ws._ctx = {}; // reset flow
      } else if (q.includes("no") || q.includes("cancel")) {
        ws._ctx = {};
        await speak(ws, "No problem. Anything else I can help with?");
      } else {
        await speak(ws, "Should I go ahead and book that time?");
      }
      return;
    }
  }

  // If we fall through, give the base prompt to keep the conversation going
  await speak(ws, basePrompt());
}

/* ──────────────────────────────────────────────────────────────────────────
   Deepgram realtime: forward inbound audio, get transcripts
   ────────────────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────────────────
   WebSocket (Twilio <Stream> → wss://…/stream)
   ────────────────────────────────────────────────────────────────────────── */
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  ws._rx = 0;
  ws._speaking = false;
  ws._asrHoldUntil = 0;
  ws._ctx = {}; // conversation state
  ws._lastPromptKey = null;
  ws._lastPromptAt = 0;

  const dg = connectDeepgram(async (finalText) => {
    console.log(`[ASR] ${finalText}`);
    if (ws._speaking) return;
    await handleUtterance(ws, finalText);
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
        console.log(`[TTS] streaming greeting as ${MEDIA_FORMAT}…`);
        const text = "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
        await speak(ws, text);
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      ws._rx++;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
      if (dg && dg.readyState === dg.OPEN && !ws._speaking && (ws._asrHoldUntil || 0) <= Date.now()) {
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

/* ──────────────────────────────────────────────────────────────────────────
   HTTP: health + debug speak
   ────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────── */
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
