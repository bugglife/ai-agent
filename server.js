// server.js — AI Phone Agent (inbound audio stream) for CleanEasy
// Runtime: Node 18+
// Deploy target: Render (or any Node host)
//
// Features
// - Twilio Voice webhook (/voice) returns TwiML that starts a one-way media stream (track="inbound_track").
// - WebSocket endpoint (/media) receives 8kHz μ-law audio frames from Twilio.
// - Bridges audio to Deepgram Realtime STT; receives transcripts.
// - Tiny intent router handles: hours, service area, booking, voicemail (EN/ES).
// - On detected intent: sends an SMS with the answer/link; logs lead/voicemail to Supabase.
// - Environment-driven business profile (name, hours, areas, booking URL).
//
// Notes
// - Twilio Media Streams over <Start> <Stream> with track="inbound_track" are *receive-only*.
//   That means we cannot inject live audio back mid-call from this WebSocket. We reply via SMS
//   and store/transact server-side actions while the call is ongoing.
//
// Required ENV VARS
// PORT
// PUBLIC_BASE_URL (e.g. https://your-app.onrender.com)
// TWILIO_ACCOUNT_SID
// TWILIO_AUTH_TOKEN
// TWILIO_MESSAGING_SERVICE_SID (or TWILIO_FROM_NUMBER) — for sending SMS
// DEEPGRAM_API_KEY
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// BIZ_NAME (e.g., "CleanEasy")
// BIZ_HOURS (e.g., "Mon–Sat 8am–6pm ET")
// BIZ_AREA (e.g., "Boston & Greater Boston")
// BOOKING_URL (e.g., "https://book.cleaneasy.example")

import express from 'express';
import crypto from 'crypto';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

// ───────────────────────────────────────────────────────────────────────────────
// Config & Clients
// ───────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // must be external HTTPS URL

if (!PUBLIC_BASE_URL) {
  console.warn('[BOOT] PUBLIC_BASE_URL is not set. Twilio will fail to connect to /media.');
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// Business profile
const BIZ = {
  name: process.env.BIZ_NAME || 'CleanEasy',
  hours: process.env.BIZ_HOURS || 'Mon–Sat 8am–6pm ET',
  area: process.env.BIZ_AREA || 'Boston & Greater Boston',
  bookingUrl: process.env.BOOKING_URL || 'https://example.com/book',
};

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────
function verifyTwilioSignature(req) {
  const twilioSignature = req.headers['x-twilio-signature'];
  if (!twilioSignature) return false;
  const url = `${PUBLIC_BASE_URL}${req.path}`;
  const params = req.method === 'POST' ? req.body : {};
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, twilioSignature, url, params);
}

function sms(to, body) {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_FROM_NUMBER; // fallback if no Messaging Service
  const payload = messagingServiceSid ? { messagingServiceSid } : { from };
  return twilioClient.messages.create({ ...payload, to, body });
}

function nowISO() {
  return new Date().toISOString();
}

// ───────────────────────────────────────────────────────────────────────────────
// Minimal NLU / Intent Router
// ───────────────────────────────────────────────────────────────────────────────
const INTENTS = {
  HOURS: 'hours',
  AREA: 'area',
  BOOKING: 'booking',
  VOICEMAIL: 'voicemail',
  NONE: 'none',
};

function detectLanguage(text) {
  // Naive language hint for EN/ES, just for templates
  // If text contains common Spanish words -> 'es' else 'en'
  const esHints = /(horario|hora|abren|cierran|área|zona|servicio|cita|reservar|agendar|correo|mensaje|buzón|grabar|español)/i;
  return esHints.test(text) ? 'es' : 'en';
}

function routeIntent(text) {
  const t = text.toLowerCase();
  if (/(hour|open|close|when|schedule|time|horario|abren|cierran)/.test(t)) return INTENTS.HOURS;
  if (/(service area|areas? served|where|cover|zona|área|barrios|vecindarios|servís)/.test(t)) return INTENTS.AREA;
  if (/(book|appointment|quote|estimate|schedule|reserve|reservar|agendar|cita)/.test(t)) return INTENTS.BOOKING;
  if (/(voicemail|leave a message|call back|mensaje|buzón|dejar recado)/.test(t)) return INTENTS.VOICEMAIL;
  return INTENTS.NONE;
}

function buildReply(intent, lang = 'en') {
  const L = (en, es) => (lang === 'es' ? es : en);
  switch (intent) {
    case INTENTS.HOURS:
      return L(
        `${BIZ.name} hours: ${BIZ.hours}. I just texted you the details as well.`,
        `Horario de ${BIZ.name}: ${BIZ.hours}. También te envié un SMS con los detalles.`
      );
    case INTENTS.AREA:
      return L(
        `${BIZ.name} serves ${BIZ.area}. I texted you more info.`,
        `${BIZ.name} atiende ${BIZ.area}. Te envié más información por SMS.`
      );
    case INTENTS.BOOKING:
      return L(
        `To book, tap the link I texted you: ${BIZ.bookingUrl}. I can also take your info and log a request for a callback.`,
        `Para reservar, abre el enlace que te envié por SMS: ${BIZ.bookingUrl}. También puedo tomar tus datos y solicitar que te llamemos.`
      );
    case INTENTS.VOICEMAIL:
      return L(
        `Okay, I\'ll capture your message now. Please say your name, address, and request.`,
        `De acuerdo, voy a grabar tu mensaje ahora. Por favor di tu nombre, dirección y solicitud.`
      );
    default:
      return L(
        `I\'m listening. Ask about hours, service area, booking, or leave a message.`,
        `Te escucho. Pregunta por horario, zona de servicio, reservar, o deja un mensaje.`
      );
  }
}

// Simple slot capture (very naive)
const leadStateByCall = new Map(); // callSid -> { intent, transcript, voicemailActive, slots, phone }

function upsertLeadState(callSid, patch) {
  const prev = leadStateByCall.get(callSid) || { intent: INTENTS.NONE, transcript: '', voicemailActive: false, slots: {}, phone: '' };
  const next = { ...prev, ...patch };
  leadStateByCall.set(callSid, next);
  return next;
}

async function persistLead(callSid) {
  const state = leadStateByCall.get(callSid);
  if (!state) return;
  const { intent, transcript, slots, phone } = state;
  try {
    const { data, error } = await supabase
      .from('leads')
      .insert([{ created_at: nowISO(), call_sid: callSid, phone, intent, transcript, slots }])
      .select();
    if (error) throw error;
    console.log('[SUPABASE] lead inserted', data?.[0]?.id);
  } catch (e) {
    console.error('[SUPABASE] insert lead failed', e);
  }
}

async function persistVoicemail(callSid) {
  const state = leadStateByCall.get(callSid);
  if (!state) return;
  const { transcript, phone } = state;
  try {
    const { data, error } = await supabase
      .from('voicemails')
      .insert([{ created_at: nowISO(), call_sid: callSid, phone, transcript_text: transcript }])
      .select();
    if (error) throw error;
    console.log('[SUPABASE] voicemail inserted', data?.[0]?.id);
  } catch (e) {
    console.error('[SUPABASE] insert voicemail failed', e);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Twilio Voice Webhook → returns TwiML that starts the Media Stream
// ───────────────────────────────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  // Optional: verify signature for extra security
  try {
    if (!verifyTwilioSignature(req)) {
      console.warn('[SECURITY] Twilio signature verification failed');
      // You can choose to reject here. For dev, we allow.
    }
  } catch (e) {
    console.warn('[SECURITY] Verification error:', e.message);
  }

  const from = req.body.From || '';
  const callSid = req.body.CallSid || crypto.randomUUID();

  const greeting = `Thanks for calling ${BIZ.name}. I\'m your AI assistant. I\'ll listen and text you helpful links while we talk.`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${greeting}</Say>
  <Start>
    <Stream url="wss://${new URL(PUBLIC_BASE_URL).host}/media" track="inbound_track" />
  </Start>
  <Pause length="60"/>
  <Say>Goodbye.</Say>
</Response>`;

  // Prime state
  upsertLeadState(callSid, { phone: from });

  res.type('text/xml').send(twiml);
});

// Health
app.get('/', (_req, res) => {
  res.send('OK - AI Agent server');
});

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket: /media (Twilio → our server) → Deepgram Realtime bridge
// ───────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[BOOT] Server listening on :${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', async (ws, req) => {
  console.log('[WS] Twilio connected to /media');

  // Create Deepgram realtime connection
  const dgUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2-general&encoding=mulaw&sample_rate=8000&endpointing=true&vad_turnoff=1000&multichannel=false&punctuate=true&smart_format=true&language=en-US&detect_language=true';
  const dg = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  let callSid = '';
  let caller = '';
  let channelReady = false;

  dg.on('open', () => {
    channelReady = true;
    console.log('[DG] realtime opened');
  });

  dg.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      // Deepgram sends transcripts in channel.alternatives
      const transcript = data?.channel?.alternatives?.[0]?.transcript || '';
      if (!transcript) return;

      // Accumulate transcript
      if (callSid) {
        const lang = detectLanguage(transcript);
        const intent = routeIntent(transcript);
        const state = upsertLeadState(callSid, {
          transcript: (leadStateByCall.get(callSid)?.transcript || '') + ' ' + transcript,
          intent: intent !== INTENTS.NONE ? intent : (leadStateByCall.get(callSid)?.intent || INTENTS.NONE),
        });

        // If we just found a decisive intent, act once
        if (!state._acted && intent !== INTENTS.NONE) {
          state._acted = true; // mark acted to avoid spamming

          // Compose response + SMS
          const reply = buildReply(intent, lang);
          if (caller) {
            try {
              await sms(caller, reply);
              // Bonus: tailored links
              if (intent === INTENTS.BOOKING) {
                await sms(caller, `Book here: ${BIZ.bookingUrl}`);
              }
            } catch (e) {
              console.error('[SMS] send failed', e);
            }
          }

          // Persist early lead
          if (intent === INTENTS.BOOKING) {
            await persistLead(callSid);
          }

          // Start voicemail capture mode (transcript-only) if requested
          if (intent === INTENTS.VOICEMAIL) {
            upsertLeadState(callSid, { voicemailActive: true });
            if (caller) await sms(caller, 'Beep! I\'m recording your message (transcript). Say your name, address, and request.');
          }
        }

        // If voicemail mode, keep accumulating; on long pause, persist
        if (leadStateByCall.get(callSid)?.voicemailActive) {
          const current = leadStateByCall.get(callSid)?.transcript || '';
          if (current.length > 300) {
            await persistVoicemail(callSid);
            upsertLeadState(callSid, { voicemailActive: false });
            if (caller) await sms(caller, 'Got it! Your message has been recorded. We\'ll call you back soon.');
          }
        }
      }
    } catch (e) {
      // Deepgram will also send keepalives and metadata; ignore parsing errors gently
    }
  });

  dg.on('close', () => console.log('[DG] realtime closed'));
  dg.on('error', (e) => console.error('[DG] error', e));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'start') {
        callSid = msg.start.callSid;
        caller = msg.start.from || '';
        console.log('[WS] start', { callSid, from: caller });
      }
      if (msg.event === 'media') {
        // Media payload is base64 μ-law @8kHz
        // Forward to Deepgram when ready
        if (channelReady) {
          dg.send(JSON.stringify({ type: 'Binary', audio: msg.media.payload }));
        }
      }
      if (msg.event === 'stop') {
        console.log('[WS] stop', { callSid });
        try {
          await persistLead(callSid);
          if (leadStateByCall.get(callSid)?.voicemailActive) {
            await persistVoicemail(callSid);
          }
        } catch (_) {}
        dg.close();
        ws.close();
      }
    } catch (e) {
      console.error('[WS] parse error', e);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Twilio closed');
    try { dg.close(); } catch (_) {}
  });

  ws.on('error', (e) => {
    console.error('[WS] error', e);
    try { dg.close(); } catch (_) {}
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Minimal schema helper (optional):
// Create the following tables in Supabase SQL editor:
//
// create table if not exists public.leads (
//   id bigint generated by default as identity primary key,
//   created_at timestamptz default now(),
//   call_sid text,
//   phone text,
//   intent text,
//   transcript text,
//   slots jsonb
// );
//
// create table if not exists public.voicemails (
//   id bigint generated by default as identity primary key,
//   created_at timestamptz default now(),
//   call_sid text,
//   phone text,
//   transcript_text text
// );
//
// Make sure your Service Role key is used only on the server.
// ───────────────────────────────────────────────────────────────────────────────
