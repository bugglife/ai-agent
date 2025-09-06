import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

/* ───────────────── CONFIG ───────────────── */
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";

const BIZ = {
  name:  process.env.BIZ_NAME  || "Your Business",
  hours: process.env.BIZ_HOURS || "Mon–Fri 9am–5pm",
  area:  process.env.BIZ_AREA  || "Local area",
  bookingEmail: process.env.BIZ_BOOKING_EMAIL || "",
};

// IMPORTANT: Twilio prefers mulaw on outbound media
const TWILIO_CODEC = (process.env.TWILIO_CODEC || "mulaw").toLowerCase(); // "mulaw" | "pcm16"

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2; // for linear PCM
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME   = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

/* ──────────────── Supabase (optional) ─────────────── */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

const supaReady = () => !!supabase;

async function saveVoicemail(payload) {
  if (!supaReady()) return;
  const { error } = await supabase.from("voicemails").insert(payload);
  if (error) console.error("❌ saveVoicemail:", error);
}

async function saveAppointment(payload) {
  if (!supaReady()) return;
  const { error } = await supabase.from("appointments").insert(payload);
  if (error) console.error("❌ saveAppointment:", error);
}

/* ──────────────── Audio helpers ─────────────── */

// Linear16 sample (Int16) → μ-law byte
function linear16ToMulawSample(sample) {
  // Clamp
  let s = Math.max(-32768, Math.min(32767, sample));
  const SIGN = s < 0 ? 0x80 : 0x00;
  if (s < 0) s = -s;
  // Bias and clip (per G.711 μ-law)
  s = s + 0x84;
  if (s > 0x7FFF) s = 0x7FFF;

  // Determine exponent
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;

  // Mantissa
  const mantissa = (s >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  const mulaw = ~(SIGN | (exponent << 4) | mantissa) & 0xFF;

  return mulaw;
}

// Buffer (linear16) → Buffer (μ-law)
function linear16ToMulawBuffer(pcmBuf) {
  const out = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0, j = 0; i < pcmBuf.length; i += 2, j++) {
    const sample = pcmBuf.readInt16LE(i);
    out[j] = linear16ToMulawSample(sample);
  }
  return out;
}

// 1 kHz beep (linear16)
function makeBeepPcm({ hz = 1000, ms = 120, gain = 0.25 } = {}) {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const s = Math.sin(2 * Math.PI * hz * t) * gain;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.floor(s * 32767))), i * 2);
  }
  return buf;
}

// Send (beep or TTS) to Twilio in real-time frames
async function streamAudioToTwilio(ws, linearPcm) {
  const frames = [];
  for (let off = 0; off < linearPcm.length; off += BYTES_PER_FRAME) {
    let frame = linearPcm.slice(off, Math.min(off + BYTES_PER_FRAME, linearPcm.length));
    if (frame.length < BYTES_PER_FRAME) {
      frame = Buffer.concat([frame, Buffer.alloc(BYTES_PER_FRAME - frame.length)]);
    }
    if (TWILIO_CODEC === "mulaw") {
      frame = linear16ToMulawBuffer(frame); // convert to μ-law
    }
    frames.push(frame);
  }

  console.log(`[TTS] streaming ${frames.length} frames as ${TWILIO_CODEC} …`);
  for (let i = 0; i < frames.length; i++) {
    ws.send(JSON.stringify({ event: "media", media: { payload: frames[i].toString("base64") } }));
    if ((i + 1) % 100 === 0) console.log(`[TTS] sent ${(i + 1)} frames (~${((i + 1) * FRAME_MS) / 1000}s)`);
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
}

// ElevenLabs TTS (linear16 8k)
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
    const txt = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${txt}`);
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length % 2 !== 0) {
    console.warn(`[WARN] PCM length ${pcm.length} not sample-aligned; tail byte may be ignored.`);
  }
  return pcm;
}

async function speak(ws, text) {
  console.log(`[TTS] reply -> "${text}"`);
  const beep = makeBeepPcm({ ms: 120, hz: 1000, gain: 0.25 });
  const voice = await ttsElevenLabsPcm8k(text);
  await streamAudioToTwilio(ws, Buffer.concat([beep, voice]));
}

/* ─────────────── Intent router ─────────────── */
async function routeIntent(ws, text, state) {
  const lower = text.toLowerCase();

  if (/\bhours?\b|\bopen\b|\bclose\b/.test(lower)) {
    return speak(ws, `${BIZ.name} is open ${BIZ.hours}. How can I help you next?`);
  }
  if (/\barea\b|\bserve\b|\bcoverage\b|\bwhere\b/.test(lower)) {
    return speak(ws, `We serve ${BIZ.area}. Would you like to book an appointment?`);
  }
  if (/\bbook\b|\bappointment\b|\bschedule\b/.test(lower)) {
    await saveAppointment({
      caller_name: state.callerName || null,
      phone: state.from || null,
      email: null,
      service: "General",
      notes: `Heard: "${text}"`,
      start_at: new Date().toISOString(),
      raw: { heard: text },
    });
    return speak(ws, `Great. I’ve placed a pending appointment request. You’ll get a confirmation shortly. Anything else?`);
  }
  if (/\bvoicemail\b|\bleave (a )?message\b|\bmessage\b/.test(lower)) {
    state.voicemailMode = true;
    return speak(ws, `Sure. After the tone, please leave your message. When you finish, say “done”.`);
  }
  if (state.voicemailMode) {
    if (/\bdone\b|\bthat’s all\b|\bthat is all\b/.test(lower)) {
      const transcript = (state.voicemailText || []).join(" ");
      await saveVoicemail({
        call_sid: state.callSid, from_number: state.from, to_number: state.to,
        transcript, duration_sec: null, audio_url: null, raw: { segments: state.voicemailText || [] },
      });
      state.voicemailMode = false; state.voicemailText = [];
      return speak(ws, `Thanks! Your voicemail has been saved. Anything else I can help with?`);
    } else {
      state.voicemailText = state.voicemailText || [];
      state.voicemailText.push(text);
      return;
    }
  }
  return speak(ws, `I can help with hours, our service area, booking an appointment, or leaving a voicemail. What would you like to do?`);
}

/* ─────────────── Deepgram bridge ─────────────── */
function openDeepgramSocket({ onTranscript }) {
  if (!DEEPGRAM_API_KEY) { console.warn("⚠️ DEEPGRAM_API_KEY missing; STT disabled."); return null; }

  const qs = new URLSearchParams({
    encoding: "linear16", sample_rate: String(SAMPLE_RATE),
    channels: "1", punctuate: "true", smart_format: "true",
    interim_results: "false", vad_events: "true", endpointing: "200",
  });

  const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?${qs.toString()}`, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dg.on("open", () => console.log("[DG] connected"));
  dg.on("close", (c, r) => console.log("[DG] close", c, r?.toString() || ""));
  dg.on("error", (e) => console.error("[DG] error", e.message || e));
  dg.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const alt = msg?.channel?.alternatives?.[0];
      const text = alt?.transcript || "";
      const isFinal = !!msg?.is_final;
      if (text && isFinal) onTranscript(text);
    } catch {}
  });

  return dg;
}

/* ─────────────── WS server ─────────────── */
const app = express();
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  const state = {
    callSid: null, streamSid: null, from: null, to: null,
    callerName: null, voicemailMode: false, voicemailText: [],
    rxFrames: 0, dg: null, dgQueue: [],
  };

  const ensureDG = () => {
    if (state.dg || !DEEPGRAM_API_KEY) return;
    state.dg = openDeepgramSocket({
      onTranscript: async (text) => {
        console.log("[STT]", text);
        try { await routeIntent(ws, text, state); } catch (e) { console.error("router error", e); }
      },
    });
    if (!state.dg) return;
    state.dg.on("open", () => {
      for (const buf of state.dgQueue) state.dg.send(buf);
      state.dgQueue = [];
    });
  };

  ws.on("message", async (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
      return;
    }

    if (msg.event === "start") {
      state.callSid   = msg.start?.callSid || null;
      state.streamSid = msg.start?.streamSid || null;
      console.log(`[WS] START callSid=${state.callSid} streamSid=${state.streamSid} bidi=${msg.start?.bidirectional}`);

      ensureDG();

      try {
        console.log("[TTS] sending greeting…");
        const tone = makeBeepPcm({ ms: 500, hz: 1000, gain: 0.15 });
        await streamAudioToTwilio(ws, tone);
        await speak(ws, `Hi! I'm your AI receptionist at ${BIZ.name}. How can I help you today?`);
        console.log("[TTS] greeting done.");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
      return;
    }

    if (msg.event === "media") {
      state.rxFrames++;
      const raw = Buffer.from(msg.media.payload, "base64"); // inbound linear16
      if (state.dg) {
        if (state.dg.readyState === WebSocket.OPEN) state.dg.send(raw);
        else state.dgQueue.push(raw);
      }
      if (state.rxFrames % 100 === 0) console.log(`[MEDIA] frames received: ${state.rxFrames}`);
      return;
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${state.rxFrames})`);
      try { state.dg?.close(); } catch {}
      return;
    }
  });

  ws.on("close", () => { try { state.dg?.close(); } catch {}; console.log("[WS] CLOSE code=1005 reason="); });
  ws.on("error", (err) => console.error("[WS] error", err));
});

/* ─────────────── HTTP/Upgrade ─────────────── */
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} (TWILIO_CODEC=${TWILIO_CODEC})`));
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
app.get("/", (_req, res) => res.status(200).send("OK"));
