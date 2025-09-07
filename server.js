// server.js
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import sgMail from "@sendgrid/mail";
import { createClient } from "@supabase/supabase-js";
import ffmpegPathPack from "@ffmpeg-installer/ffmpeg";
import { Readable } from 'stream';


const FFMPG = ffmpegPathPack.path;

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

const ELEVEN_API = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || "Rachel";

const DG_API_KEY = process.env.DG_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || "";
const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

const SENDGRID_KEY = process.env.SENDGRID_API_KEY || "";
if (SENDGRID_KEY) sgMail.setApiKey(SENDGRID_KEY);
const ALERT_FROM = process.env.ALERT_EMAIL_FROM || "alerts@bookcleaneasy.com";
const ALERT_TO = process.env.ALERT_EMAIL_TO || "";

const BIZ_NAME = process.env.BIZ_NAME || "Clean Easy";
const BIZ_HOURS = process.env.BIZ_HOURS || "Mon–Fri 9–5";
const BIZ_AREA = process.env.BIZ_AREA || "our local service area";

// Audio constants for Twilio <Stream>
const SAMPLE_RATE = 8000;
const SAMPLES_PER_FRAME = 160; // 20 ms @ 8kHz
const BYTES_PER_SAMPLE = 2; // linear16
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE;

// ───────────────────────────────────────────────────────────────────────────────
// Helpers: alerts, μ-law decoding, WAV writer, timers
// ───────────────────────────────────────────────────────────────────────────────
async function sendAlertEmail(subject, html) {
  if (!SENDGRID_KEY || !ALERT_TO) return;
  try {
    await sgMail.send({
      to: ALERT_TO,
      from: ALERT_FROM,
      subject,
      html,
    });
    console.log("[ALERT] email sent:", subject);
  } catch (err) {
    console.error("[ALERT] sendgrid error:", err?.response?.body || err.message);
  }
}

// μ-law (PCMU) 8-bit -> linear16 (s16le) decode
function ulawByteToLinear16(u) {
  u = ~u & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign * sample;
}
function ulawBufferToLinear16(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    const s = ulawByteToLinear16(ulawBuf[i]);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

// Wrap linear16 PCM (8k mono) into a WAV buffer (16-bit PCM)
function pcm16ToWav(pcmBuf, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  const dataLen = pcmBuf.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmBuf]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram: open a raw-audio websocket (linear16 8k mono)
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(forWs) {
  return new Promise((resolve, reject) => {
    const url = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=${SAMPLE_RATE}&channels=1&smart_format=true&punctuate=true&language=en-US`;
    const dg = new WebSocket(url, {
      headers: { Authorization: `Token ${DG_API_KEY}` },
    });

    dg.on("open", () => {
      console.log("[DG] connected");
      resolve(dg);
    });

    dg.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "Results" && msg.channel) {
          const alt = msg.channel.alternatives?.[0];
          const transcript = (alt?.transcript || "").trim();
          if (!transcript) return;
          console.log("[STT]", transcript);
          await handleUserText(forWs, transcript);
        }
      } catch (e) {
        // Deepgram also sends binary keepalives
      }
    });

    dg.on("close", (code) => {
      console.log("[DG] close", code);
    });

    dg.on("error", (err) => {
      console.error("[DG] error", err.message);
      reject(err);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// ElevenLabs TTS -> MP3 -> ffmpeg -> PCM16 (8k) -> Twilio media frames
// ───────────────────────────────────────────────────────────────────────────────
async function ttsSay(ws, text) {
  console.log("[TTS] ->", JSON.stringify(text));
  // Short 'beep' before greeting only (optional)
  // await sendBeep(ws);

  // Call ElevenLabs Text-to-Speech
  const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE)}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!ttsRes.ok) {
    console.error("[TTS] ElevenLabs error", await ttsRes.text());
    return;
  }

  // Stream the MP3 through ffmpeg to s16le 8k mono
  const transformer = new prism.FFmpeg({
    args: [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "mp3",
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", String(SAMPLE_RATE),
      "-f", "s16le",
      "pipe:1",
    ],
    shell: false,
    ffmpeg: FFMPG,
  });

  const reader = ttsRes.body; // Node 18 web stream
  const readerStream = reader; // already a stream
  const nodeReadable = Readable.fromWeb(readerStream);

  const pcmReadable = nodeReadable.pipe(transformer);

  let carry = Buffer.alloc(0);
  for await (const chunk of pcmReadable) {
    let buf = Buffer.concat([carry, chunk]);
    const frames = Math.floor(buf.length / BYTES_PER_FRAME);
    const cut = frames * BYTES_PER_FRAME;
    for (let i = 0; i < frames; i++) {
      const frame = buf.slice(i * BYTES_PER_FRAME, (i + 1) * BYTES_PER_FRAME);
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: frame.toString("base64") },
        })
      );
      // 20ms pacing to match real-time
      await sleep(20);
    }
    carry = buf.slice(cut);
  }
  if (carry.length) {
    // pad last partial frame with zeros
    const last = Buffer.alloc(BYTES_PER_FRAME);
    carry.copy(last);
    ws.send(
      JSON.stringify({
        event: "media",
        media: { payload: last.toString("base64") },
      })
    );
  }

  // Twilio requires a mark you’re done speaking if you want to detect barge-in yourself
  ws.send(JSON.stringify({ event: "mark", mark: { name: "tts_done" } }));
}

// Optional short beep (440Hz 150ms) to cue voicemail / greeting
async function sendBeep(ws, ms = 120, freq = 880) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE));
    pcm.writeInt16LE(v, i * 2);
  }
  let offset = 0;
  while (offset < pcm.length) {
    const frame = pcm.slice(offset, offset + BYTES_PER_FRAME);
    ws.send(JSON.stringify({ event: "media", media: { payload: frame.toString("base64") } }));
    offset += BYTES_PER_FRAME;
    await sleep(20);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Simple brain / intent router (FAQ + Book + Voicemail)
// ───────────────────────────────────────────────────────────────────────────────
async function handleUserText(ws, text) {
  const t = text.toLowerCase();

  if (/hour|open|close/.test(t)) {
    await ttsSay(ws, `${BIZ_NAME}'s hours are ${BIZ_HOURS}. Would you like to book an appointment?`);
    return;
  }

  if (/service|area|where|location/.test(t)) {
    await ttsSay(ws, `We currently serve ${BIZ_AREA}. Would you like to book a cleaning?`);
    return;
  }

  if (/book|appointment|schedule/.test(t)) {
    await ttsSay(ws, `Great! I can take a message for scheduling and we'll confirm shortly. Please say your name, address, preferred date and time after the beep. Say done when finished.`);
    const ctx = calls.get(ws); if (ctx) ctx.voicemailMode = true;
    await sendBeep(ws);
    return;
  }

  if (/voicemail|message|record/.test(t)) {
    await ttsSay(ws, `Okay. Please leave your message after the beep. Say done when finished.`);
    const ctx = calls.get(ws); if (ctx) ctx.voicemailMode = true;
    await sendBeep(ws);
    return;
  }

  if (/done|that's it|finish|thank you/.test(t)) {
    const ctx = calls.get(ws);
    if (ctx?.voicemailMode) {
      await finalizeVoicemail(ws);
      return;
    }
  }

  // fallback
  await ttsSay(ws, `Sorry, I didn't catch that. I can tell you our hours, service area, book an appointment, or take a voicemail. What would you like to do?`);
}

// ───────────────────────────────────────────────────────────────────────────────
// Voicemail capture: collect caller PCM (linear16) and save to Supabase
// ───────────────────────────────────────────────────────────────────────────────
async function finalizeVoicemail(ws) {
  const ctx = calls.get(ws);
  if (!ctx) return;

  const pcm = Buffer.concat(ctx.vc || []);
  if (pcm.length < BYTES_PER_FRAME * 3) {
    await ttsSay(ws, `I didn't receive any audio. Want to try again?`);
    ctx.voicemailMode = false;
    ctx.vc = [];
    return;
  }

  const wav = pcm16ToWav(pcm, SAMPLE_RATE);
  const fname = `voicemail_${Date.now()}.wav`;

  try {
    if (!supabase) throw new Error("Supabase not configured");
    // upload to storage bucket "voicemails"
    const { data, error } = await supabase.storage.from("voicemails").upload(fname, wav, {
      contentType: "audio/wav",
      upsert: true,
    });
    if (error) throw error;

    const { data: pub } = supabase.storage.from("voicemails").getPublicUrl(fname);
    const url = pub?.publicUrl || "";

    // store metadata in table "voicemails"
    await supabase.from("voicemails").insert({
      file_name: fname,
      url,
      duration_ms: Math.round((pcm.length / BYTES_PER_FRAME) * 20),
      created_at: new Date().toISOString(),
    });

    await sendAlertEmail(
      `New voicemail for ${BIZ_NAME}`,
      `<p>You have a new voicemail.</p><p><a href="${url}">${fname}</a></p>`
    );

    await ttsSay(ws, `Thanks! Your message has been recorded. We'll get back to you shortly.`);
  } catch (e) {
    console.error("[VM] save error", e.message);
    await sendAlertEmail(`[ERROR] voicemail save failed`, `<pre>${e.message}</pre>`);
    await ttsSay(ws, `Sorry, I couldn't save that message due to a technical issue.`);
  }

  // reset
  ctx.voicemailMode = false;
  ctx.vc = [];
}

// ───────────────────────────────────────────────────────────────────────────────
// Express + WS setup
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Simple health
app.get("/", (_req, res) => res.send("OK"));

// Debug route: speak any text to the *last* active call
let lastWs = null;
app.post("/debug", async (req, res) => {
  const text = (req.body?.text || req.query?.text || "").toString().slice(0, 500);
  if (!text) return res.status(400).json({ ok: false, error: "Missing text" });
  if (!lastWs || lastWs.readyState !== WebSocket.OPEN) {
    return res.status(409).json({ ok: false, error: "No active call" });
  }
  await ttsSay(lastWs, text);
  res.json({ ok: true });
});

// Quick access to latest voicemail row (if you set up the table)
app.get("/voicemails/latest", async (_req, res) => {
  if (!supabase) return res.json({ ok: false, error: "Supabase not configured" });
  const { data, error } = await supabase.from("voicemails").select("*").order("created_at", { ascending: false }).limit(1);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, data: data?.[0] || null });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Track per-call context
const calls = new Map();

// Incoming Twilio media stream websocket
wss.on("connection", async (ws, req) => {
  console.log("🔗 stream connected");

  ws.on("error", (err) => console.error("[WS] error", err.message));

  ws.on("message", async (raw) => {
    let msg = {};
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      console.log("[WS] connected proto=Call v=", msg.protocol || "");
      // Initialize context
      calls.set(ws, {
        rxCount: 0,
        voicemailMode: false,
        vc: [], // voicemail PCM frames
        dg: null,
      });
      lastWs = ws;

      // greet right away
      ttsSay(ws, `Hi! I’m your AI receptionist at ${BIZ_NAME}. How can I help you today?`);

      // connect Deepgram
      try {
        const dg = await connectDeepgram(ws);
        const ctx = calls.get(ws);
        if (ctx) ctx.dg = dg;
      } catch (e) {
        console.error("[DG] failed to connect:", e.message);
        sendAlertEmail(`[ERROR] Deepgram connect`, `<pre>${e.message}</pre>`);
      }
      return;
    }

    if (msg.event === "start") {
      console.log("[WS] START callSid=", msg.start?.callSid, " streamSid=", msg.start?.streamSid);
      return;
    }

    if (msg.event === "mark") {
      // optional: marks you send after TTS
      return;
    }

    if (msg.event === "media") {
      const ctx = calls.get(ws);
      if (!ctx) return;
      ctx.rxCount++;
      if (ctx.rxCount % 100 === 0) console.log("[MEDIA] rx frames:", ctx.rxCount);

      const dg = ctx.dg;
      // decode Twilio audio (could be PCMU μ-law 160 bytes or linear16 320 bytes)
      let linear16;
      const rawBuf = Buffer.from(msg.media.payload, "base64");

      if (rawBuf.length === SAMPLES_PER_FRAME) {
        // μ-law
        linear16 = ulawBufferToLinear16(rawBuf);
      } else if (rawBuf.length === BYTES_PER_FRAME) {
        // already linear16
        linear16 = rawBuf;
      } else {
        // try to guess; fall back to μ-law for small chunks
        linear16 = rawBuf.length < BYTES_PER_FRAME ? ulawBufferToLinear16(rawBuf) : rawBuf;
      }

      // When in voicemail mode, accumulate caller audio
      if (ctx.voicemailMode) ctx.vc.push(Buffer.from(linear16)); // keep as linear16

      // forward to Deepgram
      if (dg && dg.readyState === WebSocket.OPEN) {
        try {
          dg.send(linear16);
        } catch (e) {
          console.error("[DG] send error:", e.message);
        }
      }
      return;
    }

    if (msg.event === "stop") {
      const frames = msg.stop ? msg.stop.total_media_frames_received : "n/a";
      console.log("[WS] STOP (total inbound frames:", frames + ")");
      return;
    }

    if (msg.event === "close") {
      // ignore, we close below on ws close
      return;
    }
  });

  ws.on("close", () => {
    console.log("[WS] CLOSE");
    const ctx = calls.get(ws);
    if (ctx?.dg) {
      try { ctx.dg.close(1000); } catch {}
    }
    calls.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
