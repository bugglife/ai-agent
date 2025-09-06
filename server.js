import express from "express";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";

const app = express();
const PORT = process.env.PORT || 10000;

// ───────────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────────
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // change if you like
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// tiny “business brain” context
const BIZ = {
  name: process.env.BIZ_NAME || "Your Business",
  hours: process.env.BIZ_HOURS || "Mon–Fri 9–5",
  area: process.env.BIZ_AREA || "Local area",
};

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!DEEPGRAM_API_KEY) console.error("❌ DEEPGRAM_API_KEY is not set");

// Twilio media expects 16-bit PCM mono @ 8kHz → 20ms frames = 160 samples = 320 bytes
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

// ───────────────────────────────────────────────────────────────────────────────
// UTIL: 20ms real-time PCM streaming to Twilio
// ───────────────────────────────────────────────────────────────────────────────
async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  let frames = 0;

  // trim any dangling byte to stay sample-aligned
  if (pcmBuffer.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(
      `[TTS] PCM length ${pcmBuffer.length} not sample-aligned; trimming 1 byte tail`
    );
    pcmBuffer = pcmBuffer.slice(0, pcmBuffer.length - 1);
  }

  while (offset < pcmBuffer.length) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);

    // If last frame is short, pad with silence so Twilio gets full frame
    let payload;
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME);
      frame.copy(padded, 0);
      payload = padded.toString("base64");
    } else {
      payload = frame.toString("base64");
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: "media", media: { payload } }));
    } else {
      break;
    }

    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }

    // Real-time pacing
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// UTIL: short beep (1 kHz, ~120ms)
// ───────────────────────────────────────────────────────────────────────────────
function generateBeepPcm(durationMs = 120, freq = 1000, amp = 0.3) {
  const samples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const pcm = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const s = Math.sin(2 * Math.PI * freq * t);
    const v = Math.max(-1, Math.min(1, s * amp));
    pcm.writeInt16LE(Math.floor(v * 32767), i * 2);
  }
  return pcm;
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS (ElevenLabs) → MP3 → ffmpeg → PCM 16k/8k mono
// We ask for audio/mpeg; many accounts return MP3 reliably. We transcode to PCM.
// ───────────────────────────────────────────────────────────────────────────────
async function elevenLabsTtsMp3(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg", // ask for MP3
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(
      `ElevenLabs TTS failed: ${res.status} ${res.statusText} ${errTxt}`
    );
  }

  const mp3 = Buffer.from(await res.arrayBuffer());
  return mp3;
}

async function mp3ToPcm8k(mp3Buffer) {
  return new Promise((resolve, reject) => {
    console.log("[TTS] Received MP3 container. Transcoding to PCM with ffmpeg…");
    const ff = spawn(ffmpegBin.path, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "mp3",
      "-i",
      "pipe:0",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "s16le",
      "pipe:1",
    ]);

    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (e) => {
      // optional: console.error("[ffmpeg]", e.toString());
    });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(new Error("ffmpeg exited with code " + code));
    });

    ff.stdin.end(mp3Buffer);
  });
}

async function speak(ws, text, state) {
  // mute STT during TTS
  state.isTtsPlaying = true;
  try {
    const mp3 = await elevenLabsTtsMp3(text);
    const pcm = await mp3ToPcm8k(mp3);
    await streamPcmToTwilio(ws, pcm);
  } catch (err) {
    console.error("[TTS] error:", err.message);
  } finally {
    state.isTtsPlaying = false;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
/** Deepgram live WebSocket for 8k linear16 mono */
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(state) {
  const url =
    "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&punctuate=true&smart_format=true&interim_results=false";
  const dg = new WebSocket(url, {
  headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dg.on("open", () => {
    console.log("[DG] connected");
    state.dgReady = true;
  });

  dg.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Deepgram sends results in `channel.alternatives[0].transcript`
      const alt = msg?.channel?.alternatives?.[0];
      const transcript = alt?.transcript || msg?.transcript;
      const isFinal = msg?.is_final ?? msg?.speech_final ?? msg?.type === "Results";

      if (transcript && transcript.trim().length && (isFinal ?? true)) {
        console.log("[STT]", JSON.stringify(transcript));
        await handleUserUtterance(transcript.trim(), state);
      }
    } catch (e) {
      // non-JSON pings etc.
    }
  });

  dg.on("close", (code) => {
    console.log("[DG] close", code);
    state.dgReady = false;
  });

  dg.on("error", (err) => {
    console.error("[DG] error", err);
  });

  return dg;
}

// ───────────────────────────────────────────────────────────────────────────────
// Tiny intent router + slot filling for booking/voicemail
// ───────────────────────────────────────────────────────────────────────────────
function classifyIntent(text) {
  const t = text.toLowerCase();

  if (/\b(hours?|open|close|closing|time)\b/.test(t)) return { intent: "hours" };
  if (/\b(area|service|where|location|deliver|cover)\b/.test(t))
    return { intent: "area" };
  if (/\b(book|appointment|schedule|reserve|slot)\b/.test(t))
    return { intent: "book" };
  if (/\b(voicemail|message|can't talk|call back|leave a message)\b/.test(t))
    return { intent: "voicemail" };

  // simple slot extraction hints
  const date =
    t.match(
      /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/
    )?.[0] || null;
  const name = t.match(/\b(?:i[' ]?m|this is)\s+([a-z]+)\b/i)?.[1] || null;
  const phone =
    t.match(/\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/)?.[0] || null;

  return { intent: "general", slots: { date, name, phone } };
}

async function handleUserUtterance(text, state) {
  const { ws } = state;
  if (!ws || ws.readyState !== ws.OPEN) return;

  // ignore user while we are currently speaking
  if (state.isTtsPlaying) return;

  // recording voicemail?
  if (state.mode === "voicemail_record") {
    // very simple: stop recording if caller says “done”
    if (/\b(done|finished|stop)\b/i.test(text)) {
      state.mode = "idle";
      await speak(
        ws,
        "Thanks. I saved your message and we'll get back to you soon.",
        state
      );
      return;
    }
    // otherwise acknowledge lightly to avoid overlap
    return; // keep recording passively
  }

  const { intent, slots } = classifyIntent(text);

  switch (intent) {
    case "hours":
      await speak(ws, `${BIZ.name} is open ${BIZ.hours}.`, state);
      break;

    case "area":
      await speak(ws, `We currently serve ${BIZ.area}.`, state);
      break;

    case "book": {
      // naive slot filling
      state.booking = state.booking || { name: null, date: null, phone: null };
      if (!state.booking.name && slots?.name) state.booking.name = slots.name;
      if (!state.booking.phone && slots?.phone) state.booking.phone = slots.phone;
      if (!state.booking.date && slots?.date) state.booking.date = slots.date;

      if (!state.booking.name) {
        state.awaiting = "name";
        await speak(ws, "Great. What's your name?", state);
        break;
      }
      if (!state.booking.date) {
        state.awaiting = "date";
        await speak(ws, "What day works for you?", state);
        break;
      }
      if (!state.booking.phone) {
        state.awaiting = "phone";
        await speak(ws, "What's a good phone number to confirm?", state);
        break;
      }

      const { name, date, phone } = state.booking;
      state.booking = null;
      state.awaiting = null;
      await speak(
        ws,
        `Booked! I've reserved a slot for ${name} on ${date}. We'll text you a confirmation at ${phone}.`,
        state
      );
      break;
    }

    case "voicemail":
      state.mode = "voicemail_record";
      state.recording = true;
      await speak(ws, "Okay—please leave your message after the tone.", state);
      await streamPcmToTwilio(ws, generateBeepPcm(180, 900)); // softer, longer beep
      // (Recording of inbound frames happens automatically in 'media' handler while state.recording=true)
      break;

    default: {
      // slot follow-ups if booking is in progress
      if (state.awaiting) {
        const t = text.trim();
        if (state.awaiting === "name") {
          state.booking = state.booking || {};
          state.booking.name = t.split(/\s+/)[0];
          state.awaiting = null;
          await speak(ws, `Thanks ${state.booking.name}. What day works for you?`, state);
          state.awaiting = "date";
        } else if (state.awaiting === "date") {
          state.booking.date = t;
          state.awaiting = null;
          await speak(ws, "And the best phone number to confirm?", state);
          state.awaiting = "phone";
        } else if (state.awaiting === "phone") {
          state.booking.phone = t;
          const { name, date, phone } = state.booking;
          state.booking = null;
          state.awaiting = null;
          await speak(
            ws,
            `Perfect. I've reserved a slot for ${name} on ${date}. We'll send a confirmation to ${phone}.`,
            state
          );
        }
        break;
      }

      // fallback small talk
      await speak(
        ws,
        "I can help with our hours, service area, booking an appointment, or taking a voicemail. How can I help?",
        state
      );
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER (Twilio <Connect><Stream> hits wss://.../stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  // per-call state
  const state = {
    ws,
    dg: null,
    dgReady: false,
    isTtsPlaying: false,
    mode: "idle", // idle | voicemail_record
    recording: false,
    rxCount: 0,
    awaiting: null,
    booking: null,
  };

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON pings etc.
    }

    if (msg.event === "connected") {
      console.log(
        `[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`
      );
      return;
    }

    if (msg.event === "start") {
      console.log(
        `[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`
      );

      // Deepgram WS
      state.dg = connectDeepgram(state);

      // beep confirmation
      await streamPcmToTwilio(ws, generateBeepPcm());

      // greeting
      await speak(
        ws,
        `Hi! I'm your AI receptionist at ${BIZ.name}. How can I help you today?`,
        state
      );
      return;
    }

    if (msg.event === "media") {
      // inbound 8k PCM16 mono base64
      state.rxCount++;
      const payload = msg.media?.payload;
      if (!payload) return;

      const buf = Buffer.from(payload, "base64");

      // forward to Deepgram only when not speaking
      if (state.dg && state.dgReady && !state.isTtsPlaying) {
        try {
          state.dg.send(buf);
        } catch (e) {
          // ignore transient
        }
      }

      // if we’re recording voicemail, buffer or stream to storage here (stub)
      if (state.recording) {
        // example: accumulate or push to storage
        // (kept minimal here; integrate Supabase/S3 if you like)
      }

      // light logging
      if (state.rxCount % 100 === 0) {
        console.log(`[MEDIA] frames received: ${state.rxCount}`);
      }
      return;
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${state.rxCount})`);
      if (state.dg && state.dg.readyState === state.dg.OPEN) {
        try {
          state.dg.close(1000);
        } catch {}
      }
      return;
    }
  });

  ws.on("close", () => {
    console.log("[WS] CLOSE code=1005 reason=");
    if (state.dg && state.dg.readyState === state.dg.OPEN) {
      try {
        state.dg.close(1000);
      } catch {}
    }
  });

  ws.on("error", (err) => {
    console.error("[WS] error", err);
  });
});

// HTTP server + WS upgrade
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  // Only accept upgrades for /stream
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Simple healthcheck
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
