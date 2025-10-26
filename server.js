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
const ELEVEN_VOICE_ID_EN = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // English
const ELEVEN_VOICE_ID_ES = process.env.ELEVEN_VOICE_ID_ES || "VR6AewLTigWG4xSOukaG"; // Spanish
const ELEVEN_VOICE_ID_PT = process.env.ELEVEN_VOICE_ID_PT || "yoZ06aMxZJJ28mfd3POQ"; // Portuguese
const DG_KEY = process.env.DEEPGRAM_API_KEY || "";
const MEDIA_FORMAT = (process.env.TWILIO_MEDIA_FORMAT || "pcm16").toLowerCase();

// SECURITY: Optional authentication - if AGENT_TOKEN is set, it will be required
// If AGENT_TOKEN is not set, authentication is disabled (for backwards compatibility)
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const AUTH_ENABLED = !!AGENT_TOKEN;

if (!ELEVEN_API_KEY) { 
  console.error("❌ Missing ELEVEN_API_KEY"); 
  process.exit(1); 
}

if (AUTH_ENABLED) {
  console.log("🔒 Authentication ENABLED - token required");
} else {
  console.log("⚠️  Authentication DISABLED - no token required (set AGENT_TOKEN to enable)");
}

if (!["pcm16", "mulaw"].includes(MEDIA_FORMAT)) {
  console.warn(`⚠️ Unknown TWILIO_MEDIA_FORMAT='${MEDIA_FORMAT}', defaulting to pcm16`);
}

const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const BYTES_PER_SAMPLE_PCM16 = 2;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS;
const BYTES_PER_FRAME_PCM16 = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE_PCM16;
const BYTES_PER_FRAME_MULAW = SAMPLES_PER_FRAME * 1;
const ASR_PARTIAL_PROMOTE_MS = 1200;
const NO_INPUT_REPROMPT_MS = 7000;
const POST_TTS_GRACE_MS = 800;

// ───────────────────────────────────────────────────────────────────────────────
// SERVICE AREAS & PRICING
// ───────────────────────────────────────────────────────────────────────────────
const SERVICE_AREAS = [
  "Boston","Cambridge","Somerville","Brookline","Newton","Watertown","Arlington",
  "Belmont","Medford","Waltham","Needham","Wellesley","Dedham","Quincy"
];

const CITY_ALIASES = {
  "brooklyn": "Brookline", "brook line": "Brookline", "brooklin": "Brookline",
  "brook": "Brookline", "brooks": "Brookline", "brooke": "Brookline",
  "sommerville": "Somerville", "new town": "Newton", "water town": "Watertown",
  "beaumont": "Belmont", "wellsley": "Wellesley", "quinsy": "Quincy",
  "jamaica plain": "Boston", "south boston": "Boston", "west roxbury": "Boston",
  "roslindale": "Boston", "dorchester": "Boston", "roxbury": "Boston",
  "allston": "Boston", "brighton": "Boston", "back bay": "Boston",
  "south end": "Boston", "north end": "Boston", "charlestown": "Boston",
  "east boston": "Boston", "hyde park": "Boston", "mattapan": "Boston",
  "fenway": "Boston", "mission hill": "Boston", "west end": "Boston",
  "beacon hill": "Boston", "seaport": "Boston",
  "jp": "Boston", "j p": "Boston", "southie": "Boston", "eastie": "Boston",
  "westie": "Boston", "rozzie": "Boston", "dot": "Boston",
};

const PRICING_MATRIX = {
  standard: {
    Studio: 100, "1-1": 120, "1-2": 140, "2-1": 160, "2-2": 180, "2-3": 200, 
    "2-4": 220, "2-5+": 240, "3-1": 200, "3-2": 220, "3-3": 260, "3-4": 280, 
    "3-5+": 300, "4-1": 260, "4-2": 270, "4-3": 280, "4-4": 300, "4-5+": 320,
    "5+-1": 300, "5+-2": 310, "5+-3": 320, "5+-4": 320, "5+-5+": 340,
  },
  airbnb: {
    Studio: 120, "1-1": 140, "1-2": 160, "2-1": 180, "2-2": 200, "2-3": 220,
    "2-4": 240, "2-5+": 260, "3-1": 220, "3-2": 240, "3-3": 270, "3-4": 290,
    "3-5+": 310, "4-1": 280, "4-2": 290, "4-3": 300, "4-4": 320, "4-5+": 350,
    "5+-1": 330, "5+-2": 340, "5+-3": 350, "5+-4": 350, "5+-5+": 370,
  },
  deep: {
    Studio: 150, "1-1": 180, "1-2": 200, "2-1": 220, "2-2": 240, "2-3": 260,
    "2-4": 280, "2-5+": 300, "3-1": 275, "3-2": 295, "3-3": 335, "3-4": 355,
    "3-5+": 375, "4-1": 335, "4-2": 345, "4-3": 365, "4-4": 385, "4-5+": 415,
    "5+-1": 385, "5+-2": 395, "5+-3": 415, "5+-4": 415, "5+-5+": 435,
  },
  moveout: {
    Studio: 180, "1-1": 220, "1-2": 260, "2-1": 280, "2-2": 320, "2-3": 340,
    "2-4": 360, "2-5+": 380, "3-1": 355, "3-2": 375, "3-3": 415, "3-4": 435,
    "3-5+": 455, "4-1": 415, "4-2": 435, "4-3": 465, "4-4": 485, "4-5+": 515,
    "5+-1": 485, "5+-2": 495, "5+-3": 515, "5+-4": 515, "5+-5+": 535,
  },
};

const FREQUENCY_DISCOUNTS = {
  weekly: 0.15, biweekly: 0.12, monthly: 0.05, onetime: 0,
};

// ───────────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────────
function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function safeLog(s) {
  return String(s).replace(/[\r\n]/g, " ").slice(0, 300);
}

// ───────────────────────────────────────────────────────────────────────────────
// LANGUAGE DETECTION
// ───────────────────────────────────────────────────────────────────────────────
function detectLanguage(text) {
  const q = normalize(text);
  const spanishWords = ["hola", "si", "bueno", "gracias", "como", "que", "limpieza"];
  if (spanishWords.some(w => q.includes(w))) return "es";
  const portugueseWords = ["ola", "sim", "obrigado", "obrigada", "limpeza"];
  if (portugueseWords.some(w => q.includes(w))) return "pt";
  return "en";
}

// ───────────────────────────────────────────────────────────────────────────────
// Beeps + μ-law
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

// ───────────────────────────────────────────────────────────────────────────────
// TTS via ElevenLabs
// ───────────────────────────────────────────────────────────────────────────────
async function ttsElevenLabsRaw(text, lang = "en") {
  const voiceId = lang === "es" ? ELEVEN_VOICE_ID_ES : 
                  lang === "pt" ? ELEVEN_VOICE_ID_PT : ELEVEN_VOICE_ID_EN;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({ 
      text, 
      voice_settings: { stability: 0.4, similarity_boost: 0.7 } 
    }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function ffmpegTranscode(inputBuf, args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const ff = spawn(ffmpegBin.path, args);
    ff.stdin.on("error", () => {});
    ff.stdout.on("data", d => chunks.push(d));
    ff.stderr.on("data", () => {}); // suppress ffmpeg logs
    ff.on("close", code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`)));
    ff.stdin.end(inputBuf);
  });
}

async function ttsToPcm16(text, lang = "en") {
  const input = await ttsElevenLabsRaw(text, lang);
  let out = await ffmpegTranscode(input, [
    "-hide_banner","-nostdin","-loglevel","error",
    "-i","pipe:0","-ac","1","-ar","8000",
    "-f","s16le","-acodec","pcm_s16le","pipe:1",
  ]);
  if (out.length % 2 !== 0) out = out.slice(0, out.length - 1);
  return out;
}

async function ttsToMulaw(text, lang = "en") {
  const input = await ttsElevenLabsRaw(text, lang);
  return await ffmpegTranscode(input, [
    "-hide_banner","-nostdin","-loglevel","error",
    "-i","pipe:0","-ac","1","-ar","8000",
    "-f","mulaw","-acodec","pcm_mulaw","pipe:1",
  ]);
}

// ───────────────────────────────────────────────────────────────────────────────
// Stream frames to Twilio
// ───────────────────────────────────────────────────────────────────────────────
async function streamFrames(ws, raw) {
  const bytesPerFrame = MEDIA_FORMAT === "mulaw" ? BYTES_PER_FRAME_MULAW : BYTES_PER_FRAME_PCM16;
  let offset = 0;
  while (offset < raw.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + bytesPerFrame, raw.length);
    let frame = raw.slice(offset, end);
    if (frame.length < bytesPerFrame) {
      const padded = Buffer.alloc(bytesPerFrame);
      frame.copy(padded, 0);
      frame = padded;
    }
    ws.send(JSON.stringify({ 
      event: "media", 
      streamSid: ws._streamSid, 
      media: { payload: frame.toString("base64") } 
    }));
    await new Promise(r => setTimeout(r, FRAME_MS));
    offset += bytesPerFrame;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Simple conversation context
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.language = "en";
    this.data = {};
    this.greeted = false;
  }
  
  t(key) {
    const translations = {
      en: {
        greeting: "Hi! I'm your AI receptionist at Clean Easy. How can I help you?",
        stillThere: "Are you still there? I can help with booking or any questions.",
      },
      es: {
        greeting: "¡Hola! Soy tu recepcionista de IA en Clean Easy. ¿Cómo puedo ayudarte?",
        stillThere: "¿Sigues ahí? Puedo ayudarte con reservas o cualquier pregunta.",
      },
      pt: {
        greeting: "Olá! Sou sua recepcionista de IA na Clean Easy. Como posso ajudar?",
        stillThere: "Você ainda está aí? Posso ajudar com reservas ou perguntas.",
      }
    };
    return translations[this.language]?.[key] || translations.en[key];
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Intent routing with context
// ───────────────────────────────────────────────────────────────────────────────
function routeWithContext(text, ctx) {
  const q = normalize(text);
  
  // Greetings - respond naturally
  if (q.match(/^(hi|hello|hey|good morning|good afternoon|good evening)\b/)) {
    return "Hello! How can I help you today?";
  }
  
  // Availability / Booking / Scheduling
  if (q.includes("available") || q.includes("availability") || 
      q.includes("book") || q.includes("appointment") || 
      q.includes("schedule") || q.includes("reserve")) {
    return "Yes, we're available! What date and time work best for you?";
  }
  
  // Service area check
  if (q.includes("area") || q.includes("service") || q.includes("where") ||
      q.includes("location") || q.includes("come to")) {
    return "We service the Greater Boston area including Cambridge, Somerville, Brookline, Newton, and surrounding cities.";
  }
  
  // Hours / Open times
  if (q.includes("hour") || q.includes("open") || q.includes("close") ||
      q.includes("when") && (q.includes("open") || q.includes("available"))) {
    return "We're open 8 AM to 6 PM Monday through Friday, and 9 AM to 2 PM on Saturday.";
  }
  
  // Pricing
  if (q.includes("price") || q.includes("pricing") || q.includes("cost") || 
      q.includes("how much") || q.includes("charge")) {
    return "Our pricing depends on the size of your space and the type of cleaning. How many bedrooms and bathrooms do you have?";
  }
  
  // Types of cleaning
  if (q.includes("deep clean") || q.includes("move out") || q.includes("airbnb") ||
      q.includes("type") && q.includes("clean")) {
    return "We offer standard cleaning, deep cleaning, Airbnb turnover, and move-out cleaning. Which are you interested in?";
  }
  
  // Affirmative responses (yes, yeah, sure)
  if (q.match(/^(yes|yeah|yep|sure|ok|okay)\b/)) {
    return "Great! What specifically would you like help with - booking a cleaning, pricing information, or something else?";
  }
  
  // Default - encourage specifics
  return "I can help with booking, pricing, service areas, and hours. What would you like to know?";
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram realtime STT
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(onFinal, onAnyTranscript, lang = "en", ws) {
  if (!DG_KEY) {
    console.warn("⚠️ DEEPGRAM_API_KEY missing — STT disabled.");
    return null;
  }
  
  const langCode = lang === "es" ? "es" : lang === "pt" ? "pt" : "en";
  const url = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&language=${langCode}&punctuate=true&endpointing=true`;
  const dg = new WebSocket(url, { headers: { Authorization: `Token ${DG_KEY}` } });

  let lastPartial = "";
  let partialTimer = null;

  function promotePartial(reason = "idle") {
    if (!lastPartial) return;
    const promoted = lastPartial.trim();
    lastPartial = "";
    if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
    if (promoted) {
      console.log(`[ASR promote:${reason}] ${safeLog(promoted)}`);
      onFinal(promoted);
    }
  }

  dg.on("open", () => console.log("[DG] connected"));
  dg.on("message", (d) => {
    try {
      const msg = JSON.parse(d.toString());
      const alt = msg.channel?.alternatives?.[0];
      const transcript = alt?.transcript?.trim() || "";

      if (transcript) onAnyTranscript?.(transcript);

      if (transcript && (msg.is_final || msg.speech_final)) {
        if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
        lastPartial = "";
        console.log(`[ASR] ${safeLog(transcript)}`);
        onFinal(transcript);
        return;
      }
      if (transcript) {
        lastPartial = transcript;
        if (partialTimer) clearTimeout(partialTimer);
        partialTimer = setTimeout(() => promotePartial("timeout"), ASR_PARTIAL_PROMOTE_MS);
      }
    } catch {}
  });
  dg.on("close", () => {
    console.log("[DG] close");
    promotePartial("dg_close");
  });
  dg.on("error", (e) => console.error("[DG] error", e.message));
  return dg;
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

wss.on("connection", (ws, req) => {
  console.log("🔗 WebSocket connected");
  ws._rx = 0;
  ws._speaking = false;
  ws._graceUntil = 0;
  ws._ctx = new ConversationContext();
  ws._dgConnection = null;
  let noInputTimer = null;

  const resetNoInputTimer = () => {
    if (noInputTimer) clearTimeout(noInputTimer);
    noInputTimer = setTimeout(async () => {
      if (ws._speaking || Date.now() < ws._graceUntil) return;
      ws._speaking = true;
      try {
        const prompt = ws._ctx.t("stillThere");
        const out = MEDIA_FORMAT === "mulaw" ? 
          await ttsToMulaw(prompt, ws._ctx.language) : 
          await ttsToPcm16(prompt, ws._ctx.language);
        await streamFrames(ws, out);
      } catch (e) {
        console.error("[TTS] reprompt failed:", e.message);
      } finally {
        ws._speaking = false;
        ws._graceUntil = Date.now() + POST_TTS_GRACE_MS;
        resetNoInputTimer();
      }
    }, NO_INPUT_REPROMPT_MS);
  };

  const handleFinal = async (finalText) => {
    if (Date.now() < ws._graceUntil) {
      console.log("[GRACE] Ignoring input during grace period");
      return;
    }
    if (ws._speaking) return;

    // Detect language on first input
    if (!ws._ctx.language || ws._ctx.language === "en") {
      const detectedLang = detectLanguage(finalText);
      if (detectedLang !== ws._ctx.language) {
        ws._ctx.language = detectedLang;
        console.log(`[LANG] Switching to ${ws._ctx.language}`);
        if (ws._dgConnection) ws._dgConnection.close();
        ws._dgConnection = connectDeepgram(handleFinal, () => resetNoInputTimer(), ws._ctx.language, ws);
      }
    }

    console.log(`[USER] "${safeLog(finalText)}"`);
    const reply = routeWithContext(finalText, ws._ctx);
    console.log(`[BOT] "${safeLog(reply)}"`);

    ws._speaking = true;
    try {
      const out = MEDIA_FORMAT === "mulaw" ? 
        await ttsToMulaw(reply, ws._ctx.language) : 
        await ttsToPcm16(reply, ws._ctx.language);
      await streamFrames(ws, out);
    } catch (e) {
      console.error("[TTS] reply failed:", e.message);
    } finally {
      ws._speaking = false;
      ws._graceUntil = Date.now() + POST_TTS_GRACE_MS;
      resetNoInputTimer();
    }
  };

  ws._dgConnection = connectDeepgram(handleFinal, () => resetNoInputTimer(), "en", ws);

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    
    if (msg.event === "connected") {
      console.log(`[WS] event: connected`);
    }
    
    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${safeLog(msg.start?.callSid || "")}`);
      
      // Beep
      if (MEDIA_FORMAT === "mulaw") await streamFrames(ws, makeBeepMulaw());
      else await streamFrames(ws, makeBeepPcm16());
      
      // Greeting
      try {
        const text = ws._ctx.t("greeting");
        const buf = MEDIA_FORMAT === "mulaw" ? 
          await ttsToMulaw(text) : 
          await ttsToPcm16(text);
        await streamFrames(ws, buf);
        ws._ctx.greeted = true;
        // NO grace period after greeting - user should be able to respond immediately
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
      resetNoInputTimer();
    }
    
    if (msg.event === "media") {
      const payload = msg?.media?.payload;
      if (typeof payload !== "string" || payload.length === 0) return;
      let b;
      try { b = Buffer.from(payload, "base64"); } catch { return; }
      ws._rx++;
      
      if (ws._dgConnection && ws._dgConnection.readyState === ws._dgConnection.OPEN &&
          !ws._speaking && Date.now() >= ws._graceUntil) {
        const pcm16 = inboundToPCM16(b);
        ws._dgConnection.send(pcm16);
      }
    }
    
    if (msg.event === "stop") {
      console.log(`[WS] STOP`);
      if (ws._dgConnection && ws._dgConnection.readyState === ws._dgConnection.OPEN) {
        ws._dgConnection.close();
      }
      if (noInputTimer) clearTimeout(noInputTimer);
    }
  });
  
  ws.on("close", () => {
    console.log("[WS] CLOSE");
    if (noInputTimer) clearTimeout(noInputTimer);
  });
  ws.on("error", (err) => console.error("[WS] error", err));
});

// ───────────────────────────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/debug/say", async (req, res) => {
  try {
    const text = (req.query.text || "This is a test.").toString();
    const lang = (req.query.lang || "en").toString().slice(0, 5);
    const buf = MEDIA_FORMAT === "mulaw" ? 
      await ttsToMulaw(text, lang) : 
      await ttsToPcm16(text, lang);
    res.setHeader("Content-Type", MEDIA_FORMAT === "mulaw" ? "audio/basic" : "audio/L16");
    res.send(buf);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket upgrade with OPTIONAL authentication
// ───────────────────────────────────────────────────────────────────────────────
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://" + req.headers.host);
    
    // Check path
    if (url.pathname !== "/stream") {
      console.log("❌ Invalid path:", url.pathname);
      socket.destroy();
      return;
    }
    
    // OPTIONAL authentication - only check token if AUTH_ENABLED
    if (AUTH_ENABLED) {
      const token = url.searchParams.get("token");
      if (token !== AGENT_TOKEN) {
        console.log("❌ Invalid or missing token");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      console.log("✅ Token validated");
    }
    
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch (e) {
    console.error("[UPGRADE] error:", e.message);
    socket.destroy();
  }
});
