// server.js
import express from 'express';
import { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import { Readable } from 'stream';
import { spawn } from 'child_process';

// -------------------------
// Config
// -------------------------
const PORT = process.env.PORT || 10000;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || '';
const AUDIO_FORMAT = (process.env.TWILIO_AUDIO_FORMAT || 'mulaw').toLowerCase(); // 'mulaw' or 'pcm16'
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// frame sizing @ 8kHz, 20ms per frame
const FRAME_BYTES = AUDIO_FORMAT === 'mulaw' ? 160 : 320; // mulaw=160, pcm16=320

// -------------------------
// (Optional) SendGrid alerts
// -------------------------
let sendAlertEmail = async (subject, body) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.ALERT_EMAIL_TO || !process.env.ALERT_EMAIL_FROM) {
    console.warn('[ALERT] skipped (missing SENDGRID config):', subject);
    return;
  }
  const { default: sgMail } = await import('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  try {
    await sgMail.send({
      to: process.env.ALERT_EMAIL_TO,
      from: { email: process.env.ALERT_EMAIL_FROM, name: process.env.ALERT_EMAIL_NAME || 'CleanEasy Alerts' },
      subject: subject || 'Voice Agent Alert',
      text: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    });
    console.log('[ALERT] email sent:', subject);
  } catch (err) {
    console.error('[ALERT] send failed:', err?.response?.body || err);
  }
};

// -------------------------
// HTTP server + health/debug
// -------------------------
const app = express();
app.get('/', (_, res) => res.send('Media bridge running'));
app.get('/debug/say', async (req, res) => {
  const text = req.query.q || 'This is a debug test.';
  // no WebSocket here; just validate we can fetch TTS successfully
  try {
    await fetchElevenLabs(text); // if this fails, it throws
    res.send('TTS fetch OK (audio not played here)');
  } catch (e) {
    res.status(500).send('TTS fetch failed: ' + (e?.message || e));
  }
});
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// -------------------------
// WebSocket for Twilio Media Streams
// -------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('🔗 stream connected');

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === 'connected') {
      console.log('[WS] connected proto=Call v=', msg.protocol);
      return;
    }

    if (msg.event === 'start') {
      const callSid = msg?.start?.callSid;
      const streamSid = msg?.start?.streamSid;
      console.log('[WS] START callSid=', callSid, ' streamSid=', streamSid);

      // Send a short "beep" (optional)
      try { await ttsSay(ws, ''); } catch {}

      // Greeting
      const greeting = "Hi! I’m your AI receptionist at Clean Easy. How can I help you today?";
      console.log('[TTS] ->', greeting);
      try {
        await ttsSay(ws, greeting);
      } catch (e) {
        console.error('[TTS] greeting failed:', e?.message || e);
        await sendAlertEmail('[ERROR] TTS greeting', e?.message || String(e));
      }
      return;
    }

    if (msg.event === 'media') {
      // inbound audio frames from Twilio arrive here if you want to pump to STT
      // msg.media.payload is base64 mulaw PCM from Twilio
      return;
    }

    if (msg.event === 'stop') {
      console.log('[WS] STOP (rx frames:', msg?.stop?.tracksReceived || 'n/a', ')');
      return;
    }
  });

  ws.on('close', () => console.log('[WS] CLOSE'));
});

// -------------------------
// Twilio helpers: send audio back to caller
// -------------------------
function sendFrameToTwilio(ws, rawFrameBuffer) {
  // rawFrameBuffer is either 160 bytes (mulaw) or 320 bytes (pcm16)
  const payload = rawFrameBuffer.toString('base64');
  const msg = JSON.stringify({
    event: 'media',
    media: { payload }
  });
  ws.send(msg);
}

function sendMark(ws, name) {
  ws.send(JSON.stringify({ event: 'mark', mark: { name } }));
}

// -------------------------
// ElevenLabs TTS + FFmpeg transcoding (no prism-media)
// -------------------------
async function fetchElevenLabs(text) {
  if (!ELEVEN_KEY || !ELEVEN_VOICE) {
    const err = new Error('ELEVENLABS_API_KEY / VOICE_ID not set');
    err.code = 'NO_TTS_CONFIG';
    throw err;
  }
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_KEY,
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    }),
  });

  if (!r.ok) {
    const details = await r.text().catch(() => '');
    const msg = `ElevenLabs error ${r.status}: ${details}`;
    throw new Error(msg);
  }
  // Convert Web ReadableStream -> Node stream
  return Readable.fromWeb(r.body);
}

/**
 * Fetch TTS (MP3) and transcode to 8kHz mono frames with ffmpeg, then
 * send 20ms frames back to Twilio via the websocket.
 */
async function ttsSay(ws, text) {
  // If text is empty we can optionally play a 50ms beep using ffmpeg tone
  if ((text || '').trim().length === 0) {
    await toneBeep(ws, 450, 0.05); // 450 Hz for 50ms
    return;
  }

  const mp3Stream = await fetchElevenLabs(text);

  // Compose ffmpeg args based on requested output format
  const outFmt = AUDIO_FORMAT === 'mulaw' ? 'mulaw' : 's16le';
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ar', '8000',
    '-ac', '1',
    '-f', outFmt,
    'pipe:1'
  ];

  const ff = spawn(FFMPEG, args);
  mp3Stream.pipe(ff.stdin);

  ff.stdout.on('data', (chunk) => {
    for (let off = 0; off + FRAME_BYTES <= chunk.length; off += FRAME_BYTES) {
      const frame = chunk.subarray(off, off + FRAME_BYTES);
      sendFrameToTwilio(ws, frame);
    }
  });

  ff.on('close', (code) => {
    if (code !== 0) {
      const msg = `[TTS] ffmpeg exited ${code}`;
      console.error(msg);
      sendAlertEmail('[ERROR] ffmpeg TTS', msg).catch(() => {});
    }
    // optional: mark end-of-utterance
    try { sendMark(ws, 'tts_end'); } catch {}
  });

  ff.stderr.on('data', d => console.error('[ffmpeg]', d.toString()));
}

/**
 * Tiny utility to generate a short beep using ffmpeg’s sine filter.
 */
async function toneBeep(ws, hz = 440, seconds = 0.05) {
  const outFmt = AUDIO_FORMAT === 'mulaw' ? 'mulaw' : 's16le';
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=8000:duration=${seconds}`,
    '-ar', '8000', '-ac', '1',
    '-f', outFmt, 'pipe:1'
  ];
  const ff = spawn(FFMPEG, args);

  let buffers = [];
  ff.stdout.on('data', (chunk) => buffers.push(chunk));
  ff.on('close', () => {
    const buff = Buffer.concat(buffers);
    for (let off = 0; off + FRAME_BYTES <= buff.length; off += FRAME_BYTES) {
      sendFrameToTwilio(ws, buff.subarray(off, off + FRAME_BYTES));
    }
  });
  ff.stderr.on('data', d => console.error('[ffmpeg beep]', d.toString()));
}
