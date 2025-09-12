import express from "express";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
const DG_KEY = process.env.DEEPGRAM_API_KEY || "";

const MEDIA_FORMAT = (process.env.TWILIO_MEDIA_FORMAT || "pcm16").toLowerCase();
if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!["pcm16", "mulaw"].includes(MEDIA_FORMAT)) {
  console.warn(`⚠️ Unknown TWILIO_MEDIA_FORMAT='${MEDIA_FORMAT}', defaulting to pcm16`);
}

// Timing / frame sizes
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const BYTES_PER_SAMPLE_PCM16 = 2;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160 @ 8kHz, 20ms
const BYTES_PER_FRAME_PCM16 = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE_PCM16; // 320
const BYTES_PER_FRAME_MULAW = SAMPLES_PER_FRAME * 1; // 160

// ASR behavior
const ASR_PARTIAL_PROMOTE_MS = 1200;   // promote latest partial to "final" if ASR goes idle
const NO_INPUT_REPROMPT_MS = 7000;     // reprompt if caller silent this long

// ───────────────────────────────────────────────────────────────────────────────
// COMPANY KNOWLEDGE BASE  (edit freely)
// ───────────────────────────────────────────────────────────────────────────────
const KB = [
  {
    id: "hours",
    keys: ["hours","open","close","time","when","business hours","what time"],
    answer:
      "We’re open 8 AM to 6 PM Monday through Friday, and 9 AM to 2 PM on Saturday. We’re closed on Sundays."
  },
  {
    id: "address",
    keys: ["address","location","where","located","office","storefront"],
    answer:
      "Clean Easy is based in the local area and we come to you. If you need to mail anything, just ask and we’ll text you the best mailing address."
  },
  {
    id: "phone",
    keys: ["phone","number","call back","contact"],
    answer:
      "You can call or text this number anytime. If we miss you, we’ll respond as soon as we’re free."
  },
  {
    id: "services",
    keys: ["service","services","deep clean","standard clean","move out","move-in","post construction","airbnb","office","commercial","recurring","one time"],
    answer:
      "We offer standard and deep cleans, move-in/move-out, short-term rental turnovers, post-construction, and office cleanings. One-time or recurring—weekly, bi-weekly, or monthly."
  },
  {
    id: "pricing",
    keys: ["price","pricing","cost","quote","estimate","how much","rates"],
    answer:
      "Pricing depends on home size and condition. We’ll give you a quick quote over the phone or by text. Deep cleans and move-out cleans take longer and are priced accordingly."
  },
  {
    id: "supplies",
    keys: ["supplies","bring supplies","equipment","vacuum","products","eco","green"],
    answer:
      "We bring all the supplies and equipment. If you prefer eco-friendly products, let us know—we’re happy to accommodate."
  },
  {
    id: "duration",
    keys: ["how long","duration","time it takes","how many hours","finish"],
    answer:
      "A typical standard clean takes 2–3 hours for an average home, while deep cleans take longer. We’ll tailor it to the size and condition of your space."
  },
  {
    id: "guarantee",
    keys: ["guarantee","quality","not satisfied","reclean","warranty"],
    answer:
      "We stand by our work. If anything was missed, let us know within 24 hours and we’ll make it right."
  },
  {
    id: "cancellation",
    keys: ["cancel","reschedule","late fee","policy","no show"],
    answer:
      "Plans change—no problem. Please give us 24 hours’ notice to cancel or reschedule to avoid a late cancellation fee."
  },
  {
    id: "payment",
    keys: ["pay","payment","card","cash","zelle","venmo","invoice","deposit"],
    answer:
      "We accept major cards and contactless payments. If you prefer cash or Zelle, just let us know when booking."
  },
  {
    id: "service_area",
    keys: ["area","serve","coverage","where do you clean","city","neighborhood"],
    answer:
      "We serve the surrounding metro area. Tell me your city or zip code and I’ll confirm availability."
  },
  {
    id: "booking",
    keys: ["book","appointment","schedule","availability","available","when can you come"],
    answer:
      "Happy to help with booking. What date and time would you like? You can say something like “Saturday at 2 PM.”"
  }
];

// optional synonyms to boost matching
const SYNONYMS = {
  "price":["pricing","cost","rate","quote","estimate"],
  "book":["schedule","appointment","reserve","availability","available"],
  "clean":["deep clean","standard clean","move out","move-in","turnover"],
  "hours":["open","close","time"],
  "where":["located","location","address"]
};

// ───── KB retrieval helpers
function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function explodeSynonyms(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) {
    const syns = SYNONYMS[t];
    if (syns) syns.forEach(s => out.add(s));
  }
  return [...out];
}
function scoreKB(query) {
  const q = normalize(query);
  const qTokens = explodeSynonyms(q.split(" "));
  let best = {id:null,score:0,answer:null};
  for (const item of KB) {
    let s = 0;
    for (const k of item.keys) {
      const kNorm = normalize(k);
      if (q.includes(kNorm)) s += 2;                // phrase hit
      for (const tk of qTokens) if (kNorm.includes(tk)) s += 0.5; // token overlap
    }
    if (s > best.score) best = {id:item.id,score:s,answer:item.answer};
  }
  return best;
}
function answerFromKB(text) {
  const best = scoreKB(text);
  // tweak threshold to be chatty or conservative
  return best.score >= 2.0 ? best.answer : null;
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS via ElevenLabs (MP3) → ffmpeg → target format buffer
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabsRaw(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({ text, voice_settings: { stability: 0.4, similarity_boost: 0.7 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
function ffmpegTranscode(inputBuf, args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const ff = spawn(ffmpegBin.path, args);
    ff.stdin.on("error", () => {});
    ff.stdout.on("data", d => chunks.push(d));
    ff.stderr.on("data", d => console.error("[ffmpeg]", d.toString().trim()));
    ff.on("close", code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`)));
    ff.stdin.end(inputBuf);
  });
}
async function ttsToPcm16(text) {
  const input = await ttsElevenLabsRaw(text);
  console.log("[TTS] Received MP3. → PCM16/8k/mono");
  let out = await ffmpegTranscode(input, [
    "-hide_banner","-nostdin","-loglevel","error",
    "-i","pipe:0","-ac","1","-ar","8000",
    "-f","s16le","-acodec","pcm_s16le","pipe:1",
  ]);
  if (out.length % 2 !== 0) out = out.slice(0, out.length - 1);
  return out;
}
async function ttsToMulaw(text) {
  const input = await ttsElevenLabsRaw(text);
  console.log("[TTS] Received MP3. → μ-law/8k/mono");
  return await ffmpegTranscode(input, [
    "-hide_banner","-nostdin","-loglevel","error",
    "-i","pipe:0","-ac","1","-ar","8000",
    "-f","mulaw","-acodec","pcm_mulaw","pipe:1",
  ]);
}

// ───────────────────────────────────────────────────────────────────────────────
// Audio utilities (beeps + μ-law/PCM handling)
// ───────────────────────────────────────────────────────────────────────────────
function makeBeepPcm16(ms = 180, hz = 950) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE_PCM16);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const s = Math.round(0.18 * 32767 * Math.sin(2 * Math.PI * hz * t));
    buf.writeInt16LE(s, i * 2);
  }
  return buf;
}
function linearToMulawSample(s) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s = s + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}
function mulawToLinearSample(u) {
  u = ~u & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign * sample;
}
function makeBeepMulaw(ms = 180, hz = 950) {
  const pcm = makeBeepPcm16(ms, hz);
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0, j = 0; i < pcm.length; i += 2, j++) {
    out[j] = linearToMulawSample(pcm.readInt16LE(i));
  }
  return out;
}
function inboundToPCM16(buf) {
  if (MEDIA_FORMAT === "pcm16") return buf;
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0, j = 0; i < buf.length; i++, j += 2) {
    out.writeInt16LE(mulawToLinearSample(buf[i]), j);
  }
  return out;
}
async function streamFrames(ws, raw) {
  const bytesPerFrame = MEDIA_FORMAT === "mulaw" ? BYTES_PER_FRAME_MULAW : BYTES_PER_FRAME_PCM16;
  let offset = 0, frames = 0;
  while (offset < raw.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + bytesPerFrame, raw.length);
    let frame = raw.slice(offset, end);
    if (frame.length < bytesPerFrame) {
      const padded = Buffer.alloc(bytesPerFrame);
      frame.copy(padded, 0);
      frame = padded;
    }
    ws.send(JSON.stringify({ event: "media", streamSid: ws._streamSid, media: { payload: frame.toString("base64") } }));
    frames++;
    if (frames % 100 === 0) console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS) / 1000}s)`);
    await new Promise(r => setTimeout(r, FRAME_MS));
    offset += bytesPerFrame;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Conversational logic: KB first, then task routing
// ───────────────────────────────────────────────────────────────────────────────
function replyFor(text) {
  // 1) Try KB answer
  const kb = answerFromKB(text);
  if (kb) return kb;

  // 2) Light task routing (booking/availability)
  const q = normalize(text);
  if (q.includes("hour") || q.includes("open") || q.includes("close")) {
    return answerFromKB("hours");
  }
  if (q.includes("book") || q.includes("appointment") || q.includes("schedule")) {
    return "Great—what date and time would you like?";
  }
  if (q.includes("availability") || q.includes("available")) {
    return "Happy to check—what date and time are you looking for?";
  }
  return "I can help with booking and general questions. What would you like to do?";
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram realtime with partial buffering + idle promotion
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(onFinal, onAnyTranscript) {
  if (!DG_KEY) {
    console.warn("⚠️ DEEPGRAM_API_KEY missing — STT disabled.");
    return null;
  }
  const url = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&punctuate=true&vad_events=true&endpointing=true`;
  const dg = new WebSocket(url, { headers: { Authorization: `Token ${DG_KEY}` } });

  let lastPartial = "";
  let partialTimer = null;

  function promotePartial(reason = "idle") {
    if (!lastPartial) return;
    const promoted = lastPartial.trim();
    lastPartial = "";
    if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
    if (promoted) {
      console.log(`[ASR promote:${reason}] ${promoted}`);
      onFinal(promoted);
    }
  }

  dg.on("open", () => console.log("[DG] connected"));

  dg.on("message", (d) => {
    try {
      const msg = JSON.parse(d.toString());

      const alt = msg.channel?.alternatives?.[0];
      const transcript = alt?.transcript?.trim() || "";

      // reset no-input on any transcript
      if (transcript) onAnyTranscript?.(transcript);

      if (transcript && (msg.is_final || msg.speech_final)) {
        if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
        lastPartial = "";
        console.log(`[ASR] ${transcript}`);
        onFinal(transcript);
        return;
      }

      if (transcript) {
        lastPartial = transcript;
        console.log(`[ASR~] ${lastPartial}`);
        if (partialTimer) clearTimeout(partialTimer);
        partialTimer = setTimeout(() => promotePartial("timeout"), ASR_PARTIAL_PROMOTE_MS);
      }
    } catch {}
  });

  dg.on("close", () => { console.log("[DG] close"); promotePartial("dg_close"); });
  dg.on("error", (e) => console.error("[DG] error", e.message));
  return dg;
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket (Twilio <Stream> → wss://…/stream)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  ws._rx = 0;
  ws._speaking = false;

  let noInputTimer = null;
  const resetNoInputTimer = () => {
    if (noInputTimer) clearTimeout(noInputTimer);
    noInputTimer = setTimeout(async () => {
      if (ws._speaking) return;
      ws._speaking = true;
      try {
        const prompt = "Are you still there? I can help with booking or any questions.";
        const out = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(prompt) : await ttsToPcm16(prompt);
        await streamFrames(ws, out);
      } catch (e) {
        console.error("[TTS] reprompt failed:", e.message);
      } finally {
        ws._speaking = false;
        resetNoInputTimer();
      }
    }, NO_INPUT_REPROMPT_MS);
  };

  const dg = connectDeepgram(
    async (finalText) => {
      if (ws._speaking) return;
      const reply = replyFor(finalText);
      ws._speaking = true;
      try {
        const out = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(reply) : await ttsToPcm16(reply);
        await streamFrames(ws, out);
      } catch (e) {
        console.error("[TTS] reply failed:", e.message);
      } finally {
        ws._speaking = false;
        resetNoInputTimer();
      }
    },
    () => resetNoInputTimer()
  );

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: connected proto=${msg.protocol} v=${msg.version}`);
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      if (MEDIA_FORMAT === "mulaw") await streamFrames(ws, makeBeepMulaw());
      else await streamFrames(ws, makeBeepPcm16());
      console.log("[BEEP] done.");

      try {
        console.log(`[TTS] streaming greeting as ${MEDIA_FORMAT}…`);
        const text = "Hi! I'm your AI receptionist at Clean Easy. I can help with booking or answer questions. What would you like to do?";
        const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
        await streamFrames(ws, buf);
        console.log("[TTS] done.");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }

      resetNoInputTimer();
    }

    if (msg.event === "media") {
      ws._rx++;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
      if (dg && dg.readyState === dg.OPEN && !ws._speaking) {
        const b = Buffer.from(msg.media.payload, "base64");
        const pcm16 = inboundToPCM16(b);
        dg.send(pcm16);
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
      if (dg && dg.readyState === dg.OPEN) dg.close();
      if (noInputTimer) clearTimeout(noInputTimer);
    }
  });

  ws.on("close", () => { console.log("[WS] CLOSE code=1005"); if (noInputTimer) clearTimeout(noInputTimer); });
  ws.on("error", (err) => console.error("[WS] error", err));
});

// ───────────────────────────────────────────────────────────────────────────────
// HTTP: health + debug speak
// ───────────────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/debug/say", async (req, res) => {
  try {
    const text = (req.query.text || "This is a test.").toString();
    const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
    res.setHeader("Content-Type", MEDIA_FORMAT === "mulaw" ? "audio/basic" : "audio/L16");
    res.send(buf);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ───────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
