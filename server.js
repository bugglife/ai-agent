// server.js — AI receptionist with μ-law audio, Deepgram STT, voicemail to Supabase,
// SendGrid/Twilio alerts, /debug, and /voicemails/latest

import express from "express";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { spawn } from "child_process";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { createClient } from "@supabase/supabase-js";
import Twilio from "twilio";

// ───────────────────────────────────────────────────────────────────────────────
// SendGrid alert helper (voicemail/errors/ops notifications)
// ───────────────────────────────────────────────────────────────────────────────
import sgMail from "@sendgrid/mail";
if (process.env.SENDGRID_API_KEY) {
  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  } catch (_) {}
}

async function sendAlertEmail({
  subject,
  text,
  html,          // optional; if omitted we’ll fall back to text
  to = process.env.ALERT_EMAIL_TO,
}) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn("[ALERT] SENDGRID_API_KEY missing; skipping email.");
    return;
  }
  if (!to || !process.env.ALERT_EMAIL_FROM) {
    console.warn("[ALERT] ALERT_EMAIL_TO or ALERT_EMAIL_FROM missing; skipping email.");
    return;
  }

  const msg = {
    to,
    from: {
      email: process.env.ALERT_EMAIL_FROM,         // ex: alerts@bookcleaneasy.com
      name: "CleanEasy Alerts",                    // display name
    },
    replyTo: process.env.ALERT_EMAIL_REPLY_TO || "support@bookcleaneasy.com",
    subject,
    // Prefer text for deliverability; include simple HTML if provided
    text: text || (html ? html.replace(/<[^>]+>/g, " ") : ""),
    html: html || `<pre style="font-family:ui-monospace, Menlo, monospace; white-space:pre-wrap">${(text||"").replace(/&/g,"&amp;").replace(/</g,"&lt;")}</pre>`,
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
      openTracking: { enable: true },
    },
    mailSettings: {
      sandboxMode: { enable: false },
    },
  };

  try {
    await sgMail.send(msg);
    console.log("[ALERT] Email sent:", subject);
  } catch (err) {
    console.error("[ALERT] SendGrid failed:", err?.response?.body || err?.message || err);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// ENV / CONFIG
// ───────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || "";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || "";
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || "";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const ALERT_SMS_FROM = process.env.ALERT_SMS_FROM || "";
const ALERT_SMS_TO = process.env.ALERT_SMS_TO || "";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || ""; // optional
const DEBUG_KEY = process.env.DEBUG_KEY || "";

const BIZ_NAME = process.env.BIZ_NAME || "Your Business";
const BIZ_HOURS = process.env.BIZ_HOURS || "Mon–Fri 9–5";
const BIZ_SERVICE_AREA = process.env.BIZ_SERVICE_AREA || "Local area";

if (!ELEVEN_API_KEY) console.warn("⚠️ ELEVEN_API_KEY missing");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn("⚠️ Supabase env missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE");
}
if (!SENDGRID_API_KEY) console.warn("⚠️ SENDGRID_API_KEY missing (email alerts disabled)");
if (!ALERT_EMAIL_FROM) console.warn("⚠️ ALERT_EMAIL_FROM missing (email alerts disabled)");
if (!ALERT_EMAIL_TO) console.warn("⚠️ ALERT_EMAIL_TO missing (email alerts disabled)");
if (!DEBUG_KEY) console.warn("⚠️ DEBUG_KEY missing (debug route less secure)");

// ───────────────────────────────────────────────────────────────────────────────
// Clients / globals
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const sb = (SUPABASE_URL && SUPABASE_SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
  : null;

if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);
const smsClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// one-shot announcement spoken after the greeting on the NEXT call
let NEXT_ANNOUNCEMENT = "";

// Twilio stream constants (μ-law @ 8kHz)
const SR = 8000;
const FRAME_MS = 20;
const BYTES_PER_FRAME_MULAW = 160; // 20ms * 8kHz * 1 byte

// ───────────────────────────────────────────────────────────────────────────────
// Audio helpers (μ-law path)
// ───────────────────────────────────────────────────────────────────────────────
function pcm16ToUlawSample(s) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1) {}
  const mant = (s >> (exp + 3)) & 0x0f;
  return (~(sign | (exp << 4) | mant)) & 0xff;
}

function makeBeepUlaw(ms = 180, hz = 950) {
  const samples = Math.floor((SR * ms) / 1000);
  const ulaw = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / SR;
    const pcm = Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * hz * t));
    ulaw[i] = pcm16ToUlawSample(pcm);
  }
  return ulaw;
}
const BEEP_ULAW = makeBeepUlaw();

// send μ-law frames to Twilio (tagging streamSid if present)
async function streamUlaw(ws, ulawBuf, label = "OUT") {
  let off = 0, frames = 0;
  while (off < ulawBuf.length && ws.readyState === ws.OPEN) {
    const end = Math.min(off + BYTES_PER_FRAME_MULAW, ulawBuf.length);
    let chunk = ulawBuf.slice(off, end);
    if (chunk.length < BYTES_PER_FRAME_MULAW) {
      const pad = Buffer.alloc(BYTES_PER_FRAME_MULAW, 0x7f); // μ-law silence
      chunk.copy(pad);
      chunk = pad;
    }
    ws.send(JSON.stringify({
      event: "media",
      streamSid: ws._streamSid,
      media: { payload: chunk.toString("base64") }
    }));
    frames++;
    if (frames % 100 === 0) {
      console.log(`[${label}] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }
    await new Promise(r => setTimeout(r, FRAME_MS));
    off += BYTES_PER_FRAME_MULAW;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// ElevenLabs TTS → ffmpeg → μ-law/8k/mono
// ───────────────────────────────────────────────────────────────────────────────
async function ttsUlaw(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg", // robust (we’ll transcode)
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`[TTS] ${res.status} ${res.statusText} ${err}`);
  }
  const inBuf = Buffer.from(await res.arrayBuffer());
  return await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath.path, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", String(SR),
      "-f", "mulaw",
      "-acodec", "pcm_mulaw",
      "pipe:1"
    ]);
    const chunks = [];
    ff.stdout.on("data", d => chunks.push(d));
    ff.stderr.on("data", d => console.error("[ffmpeg]", d.toString().trim()));
    ff.on("close", c => c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("ffmpeg exit " + c)));
    ff.stdin.end(inBuf);
  });
}

// cache greeting ulaw to skip per-call transcode
let GREETING_CACHE = null;

// ───────────────────────────────────────────────────────────────────────────────
// Supabase helpers: save voicemail file + alerts + list latest
// ───────────────────────────────────────────────────────────────────────────────
async function uploadVoicemailWav(rawUlawPath, outWavPath) {
  // wrap raw μ-law into 16-bit PCM WAV for portability
  await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath.path, [
      "-f", "mulaw", "-ar", String(SR), "-ac", "1",
      "-i", rawUlawPath,
      "-c:a", "pcm_s16le",
      outWavPath
    ]);
    ff.on("close", c => c === 0 ? resolve() : reject(new Error("ffmpeg wrap failed")));
  });

  const fs = await import("fs");
  const data = await fs.promises.readFile(outWavPath);
  const store = sb.storage.from("voicemail");
  const key = `vm_${Date.now()}.wav`;
  const { error } = await store.upload(key, data, { contentType: "audio/wav", upsert: false });
  if (error) throw error;
  return key; // storage path (key) inside bucket
}

async function signedUrlFor(path, expiresSec = 86400) {
  const store = sb.storage.from("voicemail");
  const { data, error } = await store.createSignedUrl(path, expiresSec);
  if (error) throw error;
  return data.signedUrl;
}

async function insertVoicemailRow({ callSid, from, to, durationSec, storagePath }) {
  const { error } = await sb.from("voicemails").insert({
    call_sid: callSid,
    from_number: from,
    to_number: to,
    duration_sec: durationSec ?? null,
    storage_path: storagePath
  });
  if (error) throw error;
}

async function sendVoicemailAlerts({ callSid, from, to, durationSec, signedUrl }) {
  const line = `New voicemail (${durationSec ?? "?"}s) from ${from ?? "unknown"} — ${signedUrl}`;

  // Email
  if (SENDGRID_API_KEY && ALERT_EMAIL_FROM && ALERT_EMAIL_TO) {
    try {
      await sgMail.send({
        to: ALERT_EMAIL_TO,
        from: ALERT_EMAIL_FROM,
        subject: `New voicemail from ${from || "unknown"}`,
        text: `${line}\nCall SID: ${callSid || ""}`,
        html: `<p>${line}</p><p>Call SID: ${callSid || ""}</p>`,
      });
      console.log("[ALERT][EMAIL] sent");
    } catch (e) {
      console.warn("[ALERT][EMAIL] failed:", e.response?.body || e.message);
    }
  }

  // SMS (optional)
  if (smsClient && ALERT_SMS_FROM && ALERT_SMS_TO) {
    try {
      await smsClient.messages.create({
        from: ALERT_SMS_FROM,
        to: ALERT_SMS_TO,
        body: line
      });
      console.log("[ALERT][SMS] sent");
    } catch (e) {
      console.warn("[ALERT][SMS] failed:", e.message);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram (optional) — pass-through μ-law frames for STT & barge-in intent
// ───────────────────────────────────────────────────────────────────────────────
import WebSocket from "ws";
function connectDeepgram(onTranscript) {
  if (!DEEPGRAM_API_KEY) return null;
  const url = "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2&punctuate=true&interim_results=true&vad_events=true";
  const dg = new WebSocket(url, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
  dg.on("open", () => console.log("[DG] connected"));
  dg.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "transcript" && msg.channel?.alternatives?.[0]) {
        const t = msg.channel.alternatives[0].transcript || "";
        const final = !!msg.is_final;
        if (t) onTranscript(t, final);
      }
    } catch {}
  });
  dg.on("close", (c) => console.log("[DG] close", c));
  dg.on("error", (e) => console.error("[DG] error", e));
  return dg;
}

// tiny router
function classifyIntent(text) {
  const t = text.toLowerCase();
  if (/(hours?|open|close|when)/.test(t)) return "hours";
  if (/(area|serve|service area|where|locations?)/.test(t)) return "service_area";
  if (/(book|schedule|appointment|quote|estimate)/.test(t)) return "book";
  if (/(voicemail|leave.*message|record)/.test(t)) return "voicemail";
  return "chat";
}

// ───────────────────────────────────────────────────────────────────────────────
// HTTP routes (health, debug, voicemails)
// ───────────────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.status(200).send("OK"));

app.get("/debug", async (req, res) => {
  try {
    if (!DEBUG_KEY || req.query.key !== DEBUG_KEY) {
      return res.status(401).send("Unauthorized");
    }

    const text = (req.query.text || "").toString().trim();
    const to = (req.query.email || "").toString().trim();
    const subject = (req.query.subject || "Clean Easy test").toString();
    const body = (req.query.body || "If you see this, domain auth is working!").toString();

    if (text) {
      NEXT_ANNOUNCEMENT = text;
      console.log("[DEBUG] queued announcement:", text);
    }

    let email = "skipped";
    if (to) {
      if (!SENDGRID_API_KEY || !ALERT_EMAIL_FROM) {
        return res.status(400).send("SendGrid not configured");
      }
      await sgMail.send({ to, from: ALERT_EMAIL_FROM, subject, text: body });
      console.log(`[DEBUG][EMAIL] sent to ${to}`);
      email = "sent";
    }

    res.json({ ok: true, queued_announcement: !!text, email });
  } catch (e) {
    console.error("[DEBUG] error", e);
    res.status(500).send("Internal error");
  }
});

// List latest N voicemails with signed URLs (default 20)
app.get("/voicemails/latest", async (req, res) => {
  try {
    if (!sb) return res.status(500).send("Supabase not configured");
    const n = Math.max(1, Math.min(100, parseInt(req.query.n || "20", 10)));

    const { data, error } = await sb
      .from("voicemails")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(n);

    if (error) throw error;

    // Attach signed URLs
    const enriched = await Promise.all(
      (data || []).map(async (row) => {
        try {
          const url = await signedUrlFor(row.storage_path, 3600); // 1 hour
          return { ...row, signed_url: url };
        } catch {
          return { ...row, signed_url: null };
        }
      })
    );

    res.json({ ok: true, count: enriched.length, items: enriched });
  } catch (e) {
    console.error("[/voicemails/latest] error", e);
    res.status(500).send("Internal error");
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Twilio <Connect><Stream> WebSocket
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 stream connected");
  let dg = null;
  let rx = 0;

  const say = async (text) => {
    try {
      const ulaw = await ttsUlaw(text);
      await streamUlaw(ws, ulaw, "TTS");
    } catch (e) {
      console.error("[TTS] failed:", e.message);
    }
  };

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] connected proto=${msg.protocol} v=${msg.version}`);
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      // beep
      await streamUlaw(ws, BEEP_ULAW, "BEEP");

      // greeting (cache)
      try {
        if (!GREETING_CACHE) {
          const text = `Hi! I'm your AI receptionist at ${BIZ_NAME}. How can I help you today?`;
          GREETING_CACHE = await ttsUlaw(text);
        }
        await streamUlaw(ws, GREETING_CACHE, "TTS");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }

      // one-shot announcement (from /debug)
      if (NEXT_ANNOUNCEMENT) {
        console.log("[DEBUG] speaking announcement:", NEXT_ANNOUNCEMENT);
        await say(NEXT_ANNOUNCEMENT);
        NEXT_ANNOUNCEMENT = "";
      }

      // attach Deepgram (optional)
      if (DEEPGRAM_API_KEY) {
        dg = connectDeepgram(async (transcript, isFinal) => {
          if (!isFinal) return;
          const intent = classifyIntent(transcript);
          switch (intent) {
            case "hours":          await say(`Our hours are ${BIZ_HOURS}.`); break;
            case "service_area":   await say(`We currently serve ${BIZ_SERVICE_AREA}.`); break;
            case "book":           await say("Great—what day works for you? (Booking flow coming up next!)"); break;
            case "voicemail":
              await say("Okay—please leave your message after the tone, then hang up.");
              await streamUlaw(ws, BEEP_ULAW, "BEEP");
              ws._recordVm = true; // start raw μ-law capture (handled in 'media')
              break;
            default:
              await say("I can help with hours, service area, booking, or taking a message. What would you like?");
          }
        });
      }
    }

    if (msg.event === "media") {
      rx++;
      const b64 = msg.media?.payload;
      if (!b64) return;

      // forward to Deepgram
      if (dg && dg.readyState === dg.OPEN) {
        try {
          dg.send(JSON.stringify({ type: "InputAudioBuffer.Append", audio: b64 }));
        } catch {}
      }

      // if voicemail recording: append raw μ-law to temp file
      if (ws._recordVm) {
        const { mkdtempSync, appendFileSync, existsSync, writeFileSync } = await import("fs");
        const { tmpdir } = await import("os");
        const { join } = await import("path");
        if (!ws._vmDir) ws._vmDir = mkdtempSync(join(tmpdir(), "vm-"));
        if (!ws._vmRaw) {
          ws._vmRaw = join(ws._vmDir, "message.ulaw");
          writeFileSync(ws._vmRaw, Buffer.from(b64, "base64"));
        } else {
          appendFileSync(ws._vmRaw, Buffer.from(b64, "base64"));
        }
      }

      if (rx % 100 === 0) console.log(`[MEDIA] rx frames: ${rx}`);
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (rx=${rx})`);
      try { dg && dg.close(); } catch {}
    }
  });

  ws.on("close", async () => {
    console.log("[WS] CLOSE");
    try { dg && dg.close(); } catch {}

    // finalize voicemail if captured
    if (ws._vmRaw && sb) {
      try {
        const { join } = await import("path");
        const wavPath = ws._vmRaw.replace(/\.ulaw$/, ".wav");
        const storagePath = await uploadVoicemailWav(ws._vmRaw, wavPath);

        // optional: derive meta
        const callSid = ws._streamSid ? String(ws._streamSid) : null;

        await insertVoicemailRow({
          callSid,
          from: null, to: null, durationSec: null,
          storagePath
        });

        const signedUrl = await signedUrlFor(storagePath, 86400);
        await sendVoicemailAlerts({
          callSid,
          from: null, to: null, durationSec: null,
          signedUrl
        });
      } catch (e) {
        console.error("[VM] finalize failed:", e.message);
      }
    }
  });

  ws.on("error", (e) => console.error("[WS] error", e));
});

// HTTP+WS upgrade
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
