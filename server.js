import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

/*─────────────────────────────────────────────────────────
  CONFIG
─────────────────────────────────────────────────────────*/
const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";

const STT_PROVIDER = (process.env.STT_PROVIDER || "openai").toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const BIZ_NAME = process.env.BIZ_NAME || "Clean Easy";
const BIZ_HOURS = process.env.BIZ_HOURS || "We’re open 9 to 5, Monday through Friday.";
const BIZ_SERVICE_AREA = process.env.BIZ_SERVICE_AREA || "We service the greater metro area.";

if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is missing");
if (STT_PROVIDER === "openai" && !OPENAI_API_KEY) console.error("❌ OPENAI_API_KEY is missing for STT_PROVIDER=openai");
if (STT_PROVIDER === "deepgram" && !DEEPGRAM_API_KEY) console.error("❌ DEEPGRAM_API_KEY is missing for STT_PROVIDER=deepgram");

/*─────────────────────────────────────────────────────────
  TELEPHONY AUDIO CONSTANTS (Twilio <Stream>)
  8 kHz, mono, 16-bit PCM LE, 20 ms frames = 160 samples = 320 bytes
─────────────────────────────────────────────────────────*/
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320

/*─────────────────────────────────────────────────────────
  UTIL: sample-aligned padding and WAV wrapping
─────────────────────────────────────────────────────────*/
function alignToSample(buf) {
  // make sure we end on an even byte boundary (16-bit sample)
  if (buf.length % BYTES_PER_SAMPLE === 1) {
    const padded = Buffer.alloc(buf.length + 1);
    buf.copy(padded, 0);
    return padded;
  }
  return buf;
}

// Minimal WAV header for 16-bit PCM mono
function pcmToWav(pcmBuffer, sampleRate = SAMPLE_RATE) {
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * BYTES_PER_SAMPLE;
  const blockAlign = numChannels * BYTES_PER_SAMPLE;
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/*─────────────────────────────────────────────────────────
  BEEP (0.5s at 1 kHz, -6 dB) → PCM
─────────────────────────────────────────────────────────*/
function generateBeep(durationMs = 500, freq = 1000) {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const amp = 0.5 * 32767; // -6 dBFS
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const sample = Math.round(amp * Math.sin(2 * Math.PI * freq * t));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/*─────────────────────────────────────────────────────────
  STREAM OUT: chunk PCM into 20 ms frames to Twilio
─────────────────────────────────────────────────────────*/
async function streamPcmToTwilio(ws, pcmBuffer) {
  let offset = 0;
  let frames = 0;

  while (offset < pcmBuffer.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const frame = pcmBuffer.slice(offset, end);

    // pad last frame with silence if short
    let payloadBuf = frame;
    if (frame.length < BYTES_PER_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_FRAME);
      frame.copy(padded, 0);
      payloadBuf = padded;
    }

    ws.send(JSON.stringify({
      event: "media",
      media: { payload: payloadBuf.toString("base64") },
    }));

    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }
    await new Promise(r => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_FRAME;
  }
}

/*─────────────────────────────────────────────────────────
  KEEPALIVE SILENCE (optional filler between replies)
─────────────────────────────────────────────────────────*/
async function sendSilence(ws, ms = 4000) {
  const frames = Math.ceil(ms / FRAME_MS);
  const silence = Buffer.alloc(BYTES_PER_FRAME); // one silent frame
  for (let i = 0; i < frames && ws.readyState === ws.OPEN; i++) {
    ws.send(JSON.stringify({
      event: "media",
      media: { payload: silence.toString("base64") },
    }));
    if ((i + 1) % 100 === 0) console.log(`[KEEPALIVE] sent ${(i + 1)} silence frames (~${((i + 1) * FRAME_MS) / 1000}s)`);
    await new Promise(r => setTimeout(r, FRAME_MS));
  }
}

/*─────────────────────────────────────────────────────────
  ELEVENLABS TTS → 8 kHz PCM
─────────────────────────────────────────────────────────*/
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
    const e = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${e}`);
  }

  const arrayBuf = await res.arrayBuffer();
  let pcm = Buffer.from(arrayBuf);
  if (pcm.length % BYTES_PER_SAMPLE !== 0) {
    console.warn(`[WARN] PCM length ${pcm.length} not sample-aligned; Twilio may ignore a tail byte.`);
    pcm = alignToSample(pcm);
  }
  return pcm;
}

async function speak(ws, text) {
  const pcm = await ttsElevenLabsPcm8k(text);
  await streamPcmToTwilio(ws, pcm);
}

/*─────────────────────────────────────────────────────────
  STT PROVIDERS
─────────────────────────────────────────────────────────*/
async function transcribeWithOpenAI(pcmSlice) {
  const wav = pcmToWav(alignToSample(pcmSlice), SAMPLE_RATE);
  const fd = new FormData();
  fd.set("model", "gpt-4o-mini-transcribe"); // or "whisper-1"
  fd.set("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI STT failed: ${res.status} ${res.statusText} ${t}`);
  }
  const json = await res.json();
  return (json.text || "").trim();
}

async function transcribeWithDeepgram(pcmSlice) {
  const wav = pcmToWav(alignToSample(pcmSlice), SAMPLE_RATE);
  const res = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-2-general&smart_format=true&punctuate=true&detect_language=true",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "audio/wav",
      },
      body: wav,
    }
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Deepgram STT failed: ${res.status} ${res.statusText} ${t}`);
  }
  const json = await res.json();
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  return (alt?.transcript || "").trim();
}

async function transcribeSlice(pcmSlice) {
  if (STT_PROVIDER === "deepgram") return await transcribeWithDeepgram(pcmSlice);
  return await transcribeWithOpenAI(pcmSlice);
}

/*─────────────────────────────────────────────────────────
  INTENT ROUTER (very lightweight)
─────────────────────────────────────────────────────────*/
function routeIntent(text) {
  const t = text.toLowerCase();

  if (/hour|open|close|time/.test(t)) {
    return { kind: "hours", reply: `${BIZ_HOURS}` };
  }
  if (/service|area|where|locations?/.test(t)) {
    return { kind: "area", reply: `${BIZ_SERVICE_AREA}` };
  }
  if (/book|schedule|appointment|quote/.test(t)) {
    return {
      kind: "booking",
      reply:
        `I can get you booked with ${BIZ_NAME}. ` +
        `What day and time works best, and what's your name? ` +
        `I’ll text a confirmation if needed.`,
    };
  }
  if (/voicemail|message|leave a message|not available|call back/.test(t)) {
    return {
      kind: "voicemail",
      reply:
        `Sure. Please state your name, callback number, and a brief message after the tone. ` +
        `When you’re done, just say “finished”.`,
    };
  }
  // Default smalltalk/echo-ish
  return {
    kind: "smalltalk",
    reply:
      `Thanks. I can share our hours and service area, book an appointment, or take a voicemail. ` +
      `What would you like to do?`,
  };
}

/*─────────────────────────────────────────────────────────
  WS SERVER
─────────────────────────────────────────────────────────*/
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  const ctx = {
    rxBuffer: Buffer.alloc(0),
    sttTimer: null,
    voicemailMode: false,
  };

  // periodic STT on accumulated inbound audio
  const startSttTimer = () => {
    if (ctx.sttTimer) return;
    ctx.sttTimer = setInterval(async () => {
      if (ctx.rxBuffer.length < SAMPLE_RATE * BYTES_PER_SAMPLE * 0.9) return; // ~0.9s
      const slice = ctx.rxBuffer;
      ctx.rxBuffer = Buffer.alloc(0);
      try {
        const text = await transcribeSlice(slice);
        if (!text) return;
        console.log(`[STT] ${JSON.stringify(text)}`);

        if (ctx.voicemailMode) {
          if (/finish|done|that'?s all|end/i.test(text)) {
            ctx.voicemailMode = false;
            await speak(ws, "Thanks! Your voicemail has been recorded. We’ll get back to you soon.");
            return;
          }
          // Keep acknowledging lightly during voicemail
          await speak(ws, "Got it.");
          await sendSilence(ws, 1000);
          return;
        }

        const { kind, reply } = routeIntent(text);
        if (kind === "voicemail") ctx.voicemailMode = true;
        await speak(ws, reply);
        await sendSilence(ws, 1500);
      } catch (e) {
        console.error("[STT] error:", e.message);
      }
    }, 1200);
  };

  const stopSttTimer = () => {
    if (ctx.sttTimer) clearInterval(ctx.sttTimer);
    ctx.sttTimer = null;
  };

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      console.log(`[WS] event:`, msg);
    }

    if (msg.event === "start") {
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`);
      try {
        // 0) short beep
        console.log("[TTS] sending 1 kHz test tone (0.5s) …");
        await streamPcmToTwilio(ws, generateBeep(500, 1000));

        // 1) greeting
        const greet = `Hi! I'm your AI receptionist at ${BIZ_NAME}. How can I help you today?`;
        console.log(`[TTS] reply -> ${JSON.stringify(greet)}`);
        await speak(ws, greet);

        // Send a tiny silence tail so the call doesn’t feel clipped
        await sendSilence(ws, 800);
      } catch (e) {
        console.error("[TTS] greeting error:", e.message);
      }
      startSttTimer();
    }

    if (msg.event === "media") {
      const chunk = Buffer.from(msg.media.payload, "base64");
      ctx.rxBuffer = Buffer.concat([ctx.rxBuffer, chunk], ctx.rxBuffer.length + chunk.length);
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound bytes: ${ctx.rxBuffer.length})`);
      stopSttTimer();
    }
  });

  ws.on("close", () => {
    console.log("[WS] CLOSE code=1005 reason=");
    stopSttTimer();
  });
  ws.on("error", (err) => console.error("[WS] error", err));
});

/*─────────────────────────────────────────────────────────
  HTTP + UPGRADE
─────────────────────────────────────────────────────────*/
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// healthcheck
app.get("/", (_req, res) => res.status(200).send("OK"));
