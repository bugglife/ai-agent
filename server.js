import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

/*──────────────── CONFIG ────────────────*/
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

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME   = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

/*──────────────── Supabase ────────────────*/
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

const supaReady = () => {
  if (!supabase) {
    console.warn("⚠️ Supabase not configured; skipping DB writes.");
    return false;
  }
  return true;
};

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

/*──────────────── Audio helpers ──────────*/
function makeBeepPcm({ hz = 1000, ms = 150, gain = 0.3 } = {}) {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const s = Math.sin(2 * Math.PI * hz * t) * gain;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.floor(s * 32767))), i * 2);
  }
  return buf;
}

async function streamPcmToTwilio(ws, pcm) {
  let off = 0;
  while (off < pcm.length) {
    const end = Math.min(off + BYTES_PER_FRAME, pcm.length);
    const frame = pcm.slice(off, end);
    const payload =
      frame.length === BYTES_PER_FRAME
        ? frame.toString("base64")
        : Buffer.concat([frame, Buffer.alloc(BYTES_PER_FRAME - frame.length)]).toString("base64");

    ws.send(JSON.stringify({ event: "media", media: { payload } }));
    await new Promise((r) => setTimeout(r, FRAME_MS));
    off += BYTES_PER_FRAME;
  }
}

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
  if (pcm.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(`[WARN] PCM length ${pcm.length} not sample-aligned; Twilio may ignore a tail byte.`);
  }
  return pcm;
}

async function speak(ws, text) {
  const beep = makeBeepPcm({ ms: 120, hz: 1000, gain: 0.25 });
  const tts  = await ttsElevenLabsPcm8k(text);
  await streamPcmToTwilio(ws, Buffer.concat([beep, tts]));
}

/*──────────────── Router ────────────────*/
async function routeIntent(ws, text, state) {
  const lower = text.toLowerCase();

  if (/\bhours?\b|\bopen\b|\bclose\b/.test(lower)) {
    return speak(ws, `${BIZ.name} is open ${BIZ.hours}. How can I help you next?`);
  }

  if (/\barea\b|\bserve\b|\bcoverage\b|\bwhere\b/.test(lower)) {
    return speak(ws, `We serve ${BIZ.area}. Would you like to book an appointment?`);
  }

  if (/\bbook\b|\bappointment\b|\bschedule\b/.test(lower)) {
    state.booking = state.booking || {};
    const when = (lower.match(/\b(?:on )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?)(?:.*\d{1,2}(:\d{2})?\s?(am|pm)?)?/i) || [])[0];
    await saveAppointment({
      caller_name: state.callerName || null,
      phone: state.from || null,
      email: null,
      service: "General",
      notes: `Heard: "${text}"`,
      start_at: new Date().toISOString(), // placeholder
      raw: { heard: text, when },
    });
    return speak(ws, `Great. I’ve placed a pending appointment${when ? ` for ${when}` : ""}. You’ll get a confirmation shortly. Anything else?`);
  }

  if (/\bvoicemail\b|\bleave (a )?message\b|\bmessage\b/.test(lower)) {
    state.voicemailMode = true;
    return speak(ws, `Sure. After the tone, please leave your message. When you finish, say “done”.`);
  }

  if (state.voicemailMode) {
    if (/\bdone\b|\bthat’s all\b|\bthat is all\b/.test(lower)) {
      const transcript = (state.voicemailText || []).join(" ");
      await saveVoicemail({
        call_sid: state.callSid,
        from_number: state.from,
        to_number: state.to,
        transcript,
        duration_sec: null,
        audio_url: null,
        raw: { segments: state.voicemailText || [] },
      });
      state.voicemailMode = false;
      state.voicemailText = [];
      return speak(ws, `Thanks! Your voicemail has been saved. Anything else I can help with?`);
    } else {
      state.voicemailText = state.voicemailText || [];
      state.voicemailText.push(text);
      return; // keep collecting
    }
  }

  return speak(ws, `I can help with hours, our service area, booking an appointment, or leaving a voicemail. What would you like to do?`);
}

/*──────────────── Deepgram bridge ───────*/
function openDeepgramSocket({ onTranscript }) {
  if (!DEEPGRAM_API_KEY) {
    console.warn("⚠️ DEEPGRAM_API_KEY missing; STT disabled.");
    return null;
  }

  const qs = new URLSearchParams({
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
    punctuate: "true",
    smart_format: "true",
    interim_results: "false",
    vad_events: "true",
    endpointing: "200",
    // language: "en-US", // add if you need a specific locale
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
      // Deepgram sends { is_final, channel: { alternatives: [ { transcript } ] } }
      const alt = msg?.channel?.alternatives?.[0];
      const text = alt?.transcript || "";
      const isFinal = !!msg?.is_final;

      if (text && isFinal) onTranscript(text);
    } catch { /* ignore keepalives */ }
  });

  return dg;
}

/*──────────────── WebSocket server ───────*/
const app = express();
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  const state = {
    callSid: null,
    streamSid: null,
    from: null,
    to: null,
    callerName: null,
    voicemailMode: false,
    voicemailText: [],
    rxFrames: 0,
    dg: null,
    dgQueue: [], // media frames while Deepgram socket is not yet open
  };

  const ensureDeepgram = () => {
    if (state.dg || !DEEPGRAM_API_KEY) return;
    state.dg = openDeepgramSocket({
      onTranscript: async (text) => {
        console.log("[STT]", text);
        try { await routeIntent(ws, text, state); } catch (e) { console.error("router error", e); }
      },
    });

    if (!state.dg) return;

    state.dg.on("open", () => {
      // flush any buffered inbound frames
      for (const buf of state.dgQueue) state.dg.send(buf);
      state.dgQueue = [];
    });
  };

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
      return;
    }

    if (msg.event === "start") {
      state.callSid   = msg.start?.callSid || null;
      state.streamSid = msg.start?.streamSid || null;
      state.from      = msg.start?.customParameters?.From || null;
      state.to        = msg.start?.customParameters?.To || null;

      console.log(`[WS] START callSid=${state.callSid} streamSid=${state.streamSid} bidi=${msg.start?.bidirectional}`);

      ensureDeepgram();

      // 0.5s connection tone + greeting
      try {
        const tone = makeBeepPcm({ ms: 500, hz: 1000, gain: 0.15 });
        await streamPcmToTwilio(ws, tone);
        await speak(ws, `Hi! I’m your AI receptionist at ${BIZ.name}. How can I help you today?`);
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
      return;
    }

    if (msg.event === "media") {
      state.rxFrames++;
      // Forward caller audio to Deepgram (binary 16-bit PCM)
      if (state.dg) {
        const raw = Buffer.from(msg.media.payload, "base64"); // 8k linear16 mono
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

  ws.on("close", () => {
    try { state.dg?.close(); } catch {}
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => console.error("[WS] error", err));
});

/*──────────────── HTTP+Upgrade ───────────*/
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

app.get("/", (_req, res) => res.status(200).send("OK"));
