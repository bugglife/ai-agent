/**
 * server.js — Twilio media bridge with ElevenLabs TTS (streamed),
 * FFmpeg → PCM16 (8k/mono) via prism-media, optional alerts, and helper routes.
 *
 * Required env vars:
 *  - PORT=10000 (or your choice)
 *  - ELEVEN_API_KEY=...
 *  - ELEVEN_VOICE_ID=Rachel    (or a concrete voice ID; “Rachel” works fine too)
 *  - ALERT_EMAIL_TO=ops@bookcleaneasy.com       (comma-separated is OK)
 *  - ALERT_EMAIL_FROM=alerts@bookcleaneasy.com  (a sender on your authenticated domain)
 *  - SENDGRID_API_KEY=...
 *  - (Optional) BIZ_NAME="Clean Easy"  BIZ_HOURS="Mon–Fri 9–5"  SERVICE_AREA="..."
 *  - (Optional for /voicemails/latest) SUPABASE_URL=...  SUPABASE_ANON_KEY=...
 *
 * package.json deps:
 *  {
 *    "type": "module",
 *    "engines": { "node": ">=18 <23" },
 *    "dependencies": {
 *      "@supabase/supabase-js": "^2.45.4",
 *      "@sendgrid/mail": "^8.1.0",
 *      "express": "^4.19.2",
 *      "prism-media": "^1.3.5",
 *      "ws": "^8.17.1"
 *    }
 *  }
 */

import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import prism from 'prism-media';
import sgMail from '@sendgrid/mail';
import { createClient } from '@supabase/supabase-js';

// ---------- Config & helpers ----------

const PORT = process.env.PORT || 10000;

const BIZ_NAME = process.env.BIZ_NAME || 'Clean Easy';
const DEFAULT_GREETING =
  process.env.GREETING_TEXT ||
  `Hi! I’m your AI receptionist at ${BIZ_NAME}. How can I help you today?`;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || 'Rachel';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || '';
const ALERT_EMAIL_TO = (process.env.ALERT_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);

// simple logger
const log = (tag, msg) => console.log(`${new Date().toISOString()} [${tag}] ${msg}`);

// optional SendGrid init
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

async function sendAlertEmail(subject, body) {
  try {
    if (!SENDGRID_API_KEY || !ALERT_EMAIL_FROM || ALERT_EMAIL_TO.length === 0) return;
    const msg = {
      to: ALERT_EMAIL_TO,
      from: ALERT_EMAIL_FROM,
      subject,
      text: body || subject,
    };
    await sgMail.send(msg);
    log('ALERT', `email sent: ${subject}`);
  } catch (err) {
    log('ALERT', `send failed: ${err.message}`);
  }
}

// optional Supabase
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

// Precompute 200ms of PCM16 silence at 8 kHz (0x00 bytes)
const SILENCE_200MS = Buffer.alloc(0.2 * 8000 * 2); // 3200 bytes
const SILENCE_200MS_B64 = SILENCE_200MS.toString('base64');

function sendSilence(ws) {
  ws.send(JSON.stringify({ event: 'media', media: { payload: SILENCE_200MS_B64 } }));
}

// Text override for the next call via /debug
let nextGreetingOverride = null;

// ---------- ElevenLabs streaming TTS -> PCM16 (8k/mono) ----------

/**
 * Fetch a streaming MP3 from ElevenLabs for “text”.
 * Returns a Node Readable stream (audio/mpeg).
 */
async function fetchElevenLabsStream(text) {
  if (!ELEVEN_API_KEY) throw new Error('ELEVEN_API_KEY missing');

  // Using the “stream” endpoint for lowest latency
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    ELEVEN_VOICE_ID
  )}/stream?optimize_streaming_latency=3&output_format=mp3_22050_32`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      // Add style options if desired:
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!resp.ok || !resp.body) {
    const textErr = await resp.text().catch(() => '');
    throw new Error(`ElevenLabs ${resp.status} ${resp.statusText}: ${textErr}`);
  }

  // Node Readable stream
  return resp.body;
}

/**
 * Speak “text” to the Twilio media WS by:
 *   MP3 (ElevenLabs) -> FFmpeg (prism-media) -> PCM16 8k mono
 *   and sending base64 frames to WS.
 */
async function ttsSay(ws, text) {
  log('TTS', `-> ${text}`);

  try {
    const mp3Stream = await fetchElevenLabsStream(text);

    // FFmpeg transform: MP3 -> signed 16-bit PCM, 8kHz, mono
    const ffmpeg = new prism.FFmpeg({
      args: [
        '-analyzeduration',
        '0',
        '-loglevel',
        '0',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        '8000',
        '-ac',
        '1',
      ],
    });

    const pcmStream = mp3Stream.pipe(ffmpeg);

    // As PCM chunks arrive, base64 them into Twilio “media” events
    pcmStream.on('data', (chunk) => {
      const b64 = chunk.toString('base64');
      ws.send(JSON.stringify({ event: 'media', media: { payload: b64 } }));
    });

    return await new Promise((resolve, reject) => {
      pcmStream.on('end', () => {
        log('TTS', 'done.');
        resolve();
      });
      pcmStream.on('error', (err) => {
        log('TTS', `pipeline error: ${err.message}`);
        reject(err);
      });
      mp3Stream.on('error', (err) => {
        log('TTS', `stream fetch error: ${err.message}`);
        reject(err);
      });
    });
  } catch (err) {
    log('TTS', `greeting failed: ${err.message}`);
    await sendAlertEmail('[ERROR] TTS greeting', err.message);
  }
}

// ---------- Express HTTP + WS ----------

const app = express();
app.use(express.json());

// health
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Set the next call’s greeting to arbitrary text (for quick tests)
app.post('/debug', (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: 'Provide { "text": "..." }' });
  }
  nextGreetingOverride = text.slice(0, 800);
  log('DEBUG', `next greeting override set (${nextGreetingOverride.length} chars)`);
  res.json({ ok: true });
});

// Retrieve latest voicemail (requires Supabase + your “voicemails” table).
app.get('/voicemails/latest', async (_, res) => {
  if (!supabase) return res.status(501).json({ ok: false, error: 'Supabase not configured' });
  try {
    const { data, error } = await supabase
      .from('voicemails')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    res.json({ ok: true, voicemail: data || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start HTTP server
const server = app.listen(PORT, () => log('HTTP', `Server running on port ${PORT}`));

// WS server for Twilio media stream (no path constraints; Twilio connects to your WS URL)
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2, 7);
  log(id, '🔗 WebSocket connected');

  let streamSid = null;
  let keepAliveTimer = null;
  let rxFrames = 0;

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      sendSilence(ws);
      log(id, '[KEEPALIVE] sent 200ms silence (~4s)');
    }, 4000);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case 'connected':
        log(id, `[WS] event: connected (protocol: '${msg.protocol}', version: '${msg.version}')`);
        break;

      case 'start':
        streamSid = msg.start?.streamSid;
        log(id, `[WS] START callSid=${msg.start?.callSid} streamSid=${streamSid}`);
        // kick off greeting
        try {
          const text = nextGreetingOverride || DEFAULT_GREETING;
          nextGreetingOverride = null;
          startKeepAlive();
          await ttsSay(ws, text);
        } catch (err) {
          log(id, `[TTS] greeting error: ${err.message}`);
        }
        break;

      case 'media':
        rxFrames += 1;
        if (rxFrames % 100 === 0) {
          log(id, `[MEDIA] rx frames: ${rxFrames}`);
        }
        // If you want STT, forward msg.media.payload (base64 PCM16 8k) to your STT engine here.
        break;

      case 'stop':
        log(id, `[WS] STOP (rx=${rxFrames})`);
        stopKeepAlive();
        break;

      default:
        // ignore others (mark/clear/whatever)
        break;
    }
  });

  ws.on('close', () => {
    stopKeepAlive();
    log(id, '[WS] CLOSE');
  });

  ws.on('error', (err) => {
    stopKeepAlive();
    log(id, `[WS] ERROR ${err.message}`);
  });
});
