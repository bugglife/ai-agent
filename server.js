// server.js
import express from "express";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { spawn } from "child_process";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { createClient } from "@supabase/supabase-js";

/* ──────────────────────────────────────────────────────────────────────────
   ENV & CONSTANTS
────────────────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 10000;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID =
  process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || "";

const BIZ_NAME = process.env.BIZ_NAME || "Clean Easy";
const BIZ_HOURS =
  process.env.BIZ_HOURS ||
  "Mon–Fri 9am–6pm, Sat 10am–2pm, closed Sunday.";
const BIZ_SERVICE_AREA =
  process.env.BIZ_SERVICE_AREA || "Downtown, Midtown and Westside.";

// Twilio Media WS is 8kHz, mono. We are standardizing on μ-law end-to-end.
const SAMPLE_RATE = 8000;
const BYTES_PER_ULAW_FRAME = 160; // 20ms of μ-law @ 8kHz → 160 samples → 160 bytes
const FRAME_MS = 20;

/* ──────────────────────────────────────────────────────────────────────────
   SUPABASE
────────────────────────────────────────────────────────────────────────── */
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

/* ──────────────────────────────────────────────────────────────────────────
   UTIL: base64 chunk sender (μ-law frames)
────────────────────────────────────────────────────────────────────────── */
async function streamMulawToTwilio(ws, ulawBuf, label = "TTS") {
  let offset = 0;
  let frames = 0;
  while (offset < ulawBuf.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + BYTES_PER_ULAW_FRAME, ulawBuf.length);
    const chunk = ulawBuf.slice(offset, end);

    // Pad tail to full 20ms if needed
    let payload;
    if (chunk.length < BYTES_PER_ULAW_FRAME) {
      const padded = Buffer.alloc(BYTES_PER_ULAW_FRAME, 0x7f); // μ-law silence
      chunk.copy(padded, 0);
      payload = padded.toString("base64");
    } else {
      payload = chunk.toString("base64");
    }

    ws.send(JSON.stringify({ event: "media", media: { payload } }));
    frames++;
    if (frames % 100 === 0) {
      console.log(`[${label}] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    }
    await new Promise((r) => setTimeout(r, FRAME_MS));
    offset += BYTES_PER_ULAW_FRAME;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   BEEP: synthesize a short 1 kHz μ-law beep (250ms)
────────────────────────────────────────────────────────────────────────── */
function pcmSampleToUlaw(pcm) {
  // 16-bit PCM to μ-law (approx, G.711)
  const BIAS = 0x84;
  let sign = (pcm >> 8) & 0x80;
  if (sign !== 0) pcm = -pcm;
  if (pcm > 32635) pcm = 32635;
  pcm += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  let mantissa = (pcm >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulaw;
}

function makeBeepUlaw(ms = 250, freq = 1000) {
  const totalSamples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(totalSamples);
  for (let n = 0; n < totalSamples; n++) {
    // 16-bit sine @ -6 dBFS
    const t = n / SAMPLE_RATE;
    const pcm = Math.floor(0.5 * 32767 * Math.sin(2 * Math.PI * freq * t));
    buf[n] = pcmSampleToUlaw(pcm);
  }
  return buf;
}
const BEEP_ULAW = makeBeepUlaw(180); // short & polite :)

/* ──────────────────────────────────────────────────────────────────────────
   TTS (ElevenLabs) → always end up μ-law/8k mono
   - If Eleven returns MP3/other, we transcode with ffmpeg to μ-law.
   - Cache greeting μ-law in-memory to skip ffmpeg per call
────────────────────────────────────────────────────────────────────────── */
let GREETING_CACHE = null;
async function ttsToUlaw(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg", // their API often returns MP3 container even if we ask for PCM
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      // If your plan supports raw PCM, set: output_format: "pcm_8000"
    }),
  });
  if (!res.ok) {
    const e = await res.text().catch(() => "");
    throw new Error(`[TTS] HTTP ${res.status} ${res.statusText} ${e}`);
  }
  const inBuf = Buffer.from(await res.arrayBuffer());

  // Transcode to μ-law/8k/mono via ffmpeg
  return await transcodeToUlaw(inBuf);
}

async function transcodeToUlaw(inputBuffer) {
  return new Promise((resolve, reject) => {
    // ffmpeg -i pipe:0 -f mulaw -ar 8000 -ac 1 pipe:1
    const ff = spawn(ffmpegPath.path, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "mulaw",
      "-ar", `${SAMPLE_RATE}`,
      "-ac", "1",
      "pipe:1",
    ]);
    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => {
      // Keep quiet unless truly fails; ffmpeg prints progress on stderr
    });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`[TTS] ffmpeg exited ${code}`));
      }
    });
    ff.stdin.end(inputBuffer);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   Deepgram live WS (μ-law/8k/mono) + simple intent router & VAD
────────────────────────────────────────────────────────────────────────── */
function connectDeepgram(onTranscript, onOpen, onClose) {
  if (!DEEPGRAM_API_KEY) return null;

  const url =
    "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2&punctuate=true&interim_results=true&vad_events=true";
  const dg = new (require("ws"))(url, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dg.on("open", () => {
    console.log("[DG] connected");
    onOpen && onOpen();
  });

  dg.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "transcript" && data.channel?.alternatives?.length) {
        const alt = data.channel.alternatives[0];
        const transcript = alt.transcript || "";
        const isFinal = !!data.is_final;
        if (transcript) onTranscript(transcript, isFinal);
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  dg.on("close", (code) => {
    console.log("[DG] close", code);
    onClose && onClose(code);
  });

  dg.on("error", (e) => console.error("[DG] error", e));
  return dg;
}

// Per-call brain state
function makeBrain() {
  return {
    stage: "greeting", // collecting_name / collecting_date / idle / voicemail
    lastUserSpeechTs: Date.now(),
    bargeIn: true,
    booking: { name: "", date: "", phone: "" },
  };
}

function routeIntent(text) {
  const t = text.toLowerCase();
  if (/(hours?|open|close|when)/.test(t)) return { intent: "hours" };
  if (/(area|serve|service area|where|locations?)/.test(t)) return { intent: "service_area" };
  if (/(book|schedule|appointment|quote|estimate)/.test(t)) return { intent: "book" };
  if (/(leave.*message|voicemail|record)/.test(t)) return { intent: "voicemail" };
  return { intent: "chit_chat" };
}

async function handleIntent(brain, intent, say) {
  switch (intent) {
    case "hours":
      await say(`Our hours are ${BIZ_HOURS}`);
      brain.stage = "idle";
      break;
    case "service_area":
      await say(`We currently serve ${BIZ_SERVICE_AREA}`);
      brain.stage = "idle";
      break;
    case "book":
      brain.stage = "collecting_name";
      await say("Great! I can help with that. What name should I put it under?");
      break;
    case "voicemail":
      brain.stage = "voicemail";
      await say("Okay. I’ll start recording after the tone. Leave your message and hang up when done.");
      break;
    default:
      // light small talk
      await say("I can help with hours, our service area, booking an appointment, or taking a message. What would you like?");
      brain.stage = "idle";
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Voicemail file helper (save μ-law stream → WAV in Supabase storage)
────────────────────────────────────────────────────────────────────────── */
async function saveVoicemailToSupabase(ulawPath, meta) {
  if (!supabase) return;
  const outPath = `${ulawPath}.wav`;

  // Wrap μ-law raw into WAV
  await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath.path, [
      "-f", "mulaw",
      "-ar", `${SAMPLE_RATE}`,
      "-ac", "1",
      "-i", ulawPath,
      "-c:a", "pcm_s16le",
      outPath,
    ]);
    ff.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg wrap failed"))));
  });

  // Upload
  const bucket = "voicemails"; // create this bucket in Supabase → Storage
  const fileName = `vm_${Date.now()}.wav`;
  const arrayBuf = await fsPromises.readFile(outPath);
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(fileName, arrayBuf, { contentType: "audio/wav", upsert: false });
  if (error) {
    console.error("[VM] upload failed:", error);
    return;
  }
  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(fileName);
  // Record a row for easy dashboard
  await supabase.from("voicemails").insert([{ url: pub.publicUrl, meta }]).catch(() => {});
}

/* ──────────────────────────────────────────────────────────────────────────
   HTTP + WS SERVER
────────────────────────────────────────────────────────────────────────── */
const app = express();
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/version", (_req, res) => {
  res.json({ name: "twilio-media-bridge", version: "brain-1", time: new Date().toISOString() });
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  const call = {
    brain: makeBrain(),
    deepgram: null,
    greetingDone: false,
    rxFrames: 0,
    // voicemail buffer file (if stage switches to voicemail)
    voicemailFile: null,
    voicemailStream: null,
    sendLock: false,
  };

  // Utility to TTS+send (with μ-law)
  const say = async (text) => {
    try {
      const ulaw = await ttsToUlaw(text);
      await streamMulawToTwilio(ws, ulaw, "TTS");
    } catch (e) {
      console.error("[TTS] failed:", e.message);
    }
  };

  const startDeepgram = () => {
    if (!DEEPGRAM_API_KEY || call.deepgram) return;
    call.deepgram = connectDeepgram(
      async (transcript, isFinal) => {
        call.brain.lastUserSpeechTs = Date.now();
        // Barge-in: if user speaks while we were about to say something, we simply react
        if (isFinal) {
          console.log("[STT]", transcript);
          const { intent } = routeIntent(transcript);
          await handleIntent(call.brain, intent, say);
        }
      },
      null,
      () => (call.deepgram = null)
    );
  };

  const greetingText = `Hi! I'm your AI receptionist at ${BIZ_NAME}. How can I help you today?`;

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      console.log(`[WS] event: connected proto=${msg.protocol} v=${msg.version}`);
    }

    if (msg.event === "start") {
      console.log(
        `[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid}`
      );

      // 1) Short polite beep
      await streamMulawToTwilio(ws, BEEP_ULAW, "BEEP");

      // 2) Greeting (cached)
      try {
        if (!GREETING_CACHE) {
          console.log("[TTS] streaming greeting as mulaw…");
          const ulaw = await ttsToUlaw(greetingText);
          GREETING_CACHE = ulaw;
        }
        await streamMulawToTwilio(ws, GREETING_CACHE, "TTS");
        call.greetingDone = true;
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }

      // 3) Start Deepgram (barge-in ready now)
      startDeepgram();

      // 4) VAD idle checker: if no speech 20s after greeting → offer voicemail
      const idleCheck = setInterval(async () => {
        if (ws.readyState !== ws.OPEN) return clearInterval(idleCheck);
        const idleFor = Date.now() - call.brain.lastUserSpeechTs;
        if (idleFor > 20000 && call.brain.stage === "idle") {
          call.brain.stage = "voicemail";
          await say("If you’d like, I can take a quick voicemail. Start speaking after the tone.");
          await streamMulawToTwilio(ws, BEEP_ULAW, "BEEP");
        }
      }, 2500);
    }

    if (msg.event === "media") {
      call.rxFrames++;
      const b64 = msg.media?.payload || "";
      if (!b64) return;

      // Forward inbound μ-law frames to Deepgram
      if (call.deepgram && call.deepgram.readyState === call.deepgram.OPEN) {
        try {
          call.deepgram.send(
            JSON.stringify({
              type: "InputAudioBuffer.Append",
              audio: b64,
            })
          );
        } catch {}
      }

      // If in voicemail stage → write to temp μ-law file
      if (call.brain.stage === "voicemail") {
        const buf = Buffer.from(b64, "base64");
        if (!call.voicemailFile) {
          const { mkdtempSync, writeFileSync } = await import("fs");
          const { tmpdir } = await import("os");
          const { join } = await import("path");
          const dir = mkdtempSync(join(tmpdir(), "vm-"));
          call.voicemailFile = join(dir, "message.ulaw");
          writeFileSync(call.voicemailFile, buf);
        } else {
          const { appendFileSync } = await import("fs");
          appendFileSync(call.voicemailFile, buf);
        }
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${call.rxFrames})`);
      try {
        call.deepgram && call.deepgram.close();
      } catch {}
    }
  });

  ws.on("close", async () => {
    console.log("[WS] CLOSE");

    // If we recorded a voicemail file, wrap & store it
    if (call.voicemailFile && supabase) {
      try {
        await saveVoicemailToSupabase(call.voicemailFile, {
          name: call.brain.booking.name || null,
          phone: call.brain.booking.phone || null,
          ts: new Date().toISOString(),
        });
      } catch (e) {
        console.error("[VM] finalize failed:", e.message);
      }
    }
  });

  ws.on("error", (err) => console.error("[WS] error", err));
});

/* ──────────────────────────────────────────────────────────────────────────
   UPGRADE HANDLER
────────────────────────────────────────────────────────────────────────── */
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
