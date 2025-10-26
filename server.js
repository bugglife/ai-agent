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
const PHONE_COLLECTION_GRACE_MS = 1500; // 🔧 FIX: Longer grace period during phone collection

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
// LANGUAGE DETECTION - Conservative approach
// ───────────────────────────────────────────────────────────────────────────────
function detectLanguage(text) {
  const q = normalize(text);
  
  // Require MULTIPLE strong Spanish indicators
  const spanishWords = ["hola", "si", "bueno", "gracias", "como estas", "que tal", "limpieza", "servicio", "precio", "cuando", "donde", "necesito", "quiero"];
  const spanishCount = spanishWords.filter(w => q.includes(w)).length;
  
  // Only detect Spanish if we see 2+ Spanish words OR very clear Spanish phrases
  if (spanishCount >= 2 || q.includes("como estas") || q.includes("que tal") || q.includes("hablas espanol")) {
    return "es";
  }
  
  // Require MULTIPLE strong Portuguese indicators
  const portugueseWords = ["ola", "sim", "obrigado", "obrigada", "como vai", "tudo bem", "limpeza", "servico", "preco", "quando", "onde", "preciso", "quero"];
  const portugueseCount = portugueseWords.filter(w => q.includes(w)).length;
  
  // Only detect Portuguese if we see 2+ Portuguese words OR very clear Portuguese phrases
  if (portugueseCount >= 2 || q.includes("como vai") || q.includes("tudo bem") || q.includes("fala portugues")) {
    return "pt";
  }
  
  // Default to English
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
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      output_format: "pcm_16000",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resampleWithFFmpeg(inBuf, inRate, outRate) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f", "s16le", "-ar", inRate.toString(), "-ac", "1", "-i", "pipe:0",
      "-f", "s16le", "-ar", outRate.toString(), "-ac", "1", "pipe:1",
    ];
    const proc = spawn(ffmpegBin.path, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stdout.on("end", () => resolve(Buffer.concat(chunks)));
    proc.on("error", reject);
    proc.stdin.write(inBuf);
    proc.stdin.end();
  });
}

async function ttsToPcm16(text, lang = "en") {
  const rawPcm = await ttsElevenLabsRaw(text, lang);
  return await resampleWithFFmpeg(rawPcm, 16000, SAMPLE_RATE);
}

async function ttsToMulaw(text, lang = "en") {
  const pcm16 = await ttsToPcm16(text, lang);
  const out = Buffer.alloc(pcm16.length / 2);
  for (let i = 0, j = 0; i < pcm16.length; i += 2, j++) {
    out[j] = linearToMulawSample(pcm16.readInt16LE(i));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// Phone number extraction - ENHANCED with compound numbers
// ───────────────────────────────────────────────────────────────────────────────
function extractPhoneNumber(text) {
  const q = normalize(text);
  const digitMap = {
    zero: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
    ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
    fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
    twenty: "20", thirty: "30", forty: "40", fifty: "50",
    sixty: "60", seventy: "70", eighty: "80", ninety: "90",
  };
  
  let result = "";
  const words = q.split(/\s+/);
  
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    
    // Direct digit matches
    if (digitMap[word]) {
      result += digitMap[word];
      continue;
    }
    
    // Check for compound numbers like "twenty one" → "21"
    if (["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].includes(word)) {
      const nextWord = words[i + 1];
      if (nextWord && ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].includes(nextWord)) {
        result += digitMap[word] + digitMap[nextWord];
        i++; // Skip next word since we consumed it
        continue;
      }
      // Just the tens digit alone
      result += digitMap[word];
      continue;
    }
    
    // Check for "hundred" patterns like "two hundred" → "200"
    if (word === "hundred") {
      const prevWord = words[i - 1];
      if (prevWord && digitMap[prevWord]) {
        // Already added the digit, just add "00"
        result += "00";
        continue;
      }
    }
    
    // Raw numeric digits
    if (/^\d+$/.test(word)) {
      result += word;
    }
  }
  
  return result;
}

// ───────────────────────────────────────────────────────────────────────────────
// ConversationContext
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.language = "en";
    this.languageDetected = false;
    this.greeted = false;
    this.askedFor = null;
    this.data = {
      city: null,
      date: null,
      time: null,
      bedrooms: null,
      bathrooms: null,
      cleaningType: null,
      frequency: null,
      phone: "",
      address: null,
    };
    this.collectingPhone = false; // 🔧 FIX: Track when we're actively collecting phone
  }
  
  t(key) {
    const translations = {
      en: {
        greeting: "Hi! I was wondering if you service Brookline.",
        stillThere: "Are you still there?",
        serviceConfirm: (city) => `Yes, we service ${city}! What date and time work best for you?`,
        serviceUnknown: (city) => `I'm not sure if we service ${city}. Let me check. Can I get your phone number and address?`,
        askPhone: "Can I get your phone number and address to confirm your booking?",
        needMoreDigits: (n) => `Got it. I need ${n} more digit${n === 1 ? "" : "s"}.`,
        phoneComplete: (formatted) => `Great, I have your number as ${formatted}. What's the address for the cleaning?`,
        askAddress: "What's the address for the cleaning?",
        confirmBooking: (details) => `Perfect! I have you scheduled for ${details.date} at ${details.time} in ${details.city}. Your phone is ${details.phone} and address is ${details.address}. We'll send you a confirmation shortly.`,
        help: "I can help with booking, pricing, service areas, and hours. What would you like to know?",
        didntCatch: "I didn't catch that. Could you repeat?",
      },
      es: {
        greeting: "¡Hola! Me preguntaba si dan servicio en Brookline.",
        stillThere: "¿Sigues ahí?",
        serviceConfirm: (city) => `¡Sí, damos servicio en ${city}! ¿Qué fecha y hora te viene mejor?`,
        serviceUnknown: (city) => `No estoy seguro si damos servicio en ${city}. Déjame verificar. ¿Puedo obtener tu número de teléfono y dirección?`,
        askPhone: "¿Puedo obtener tu número de teléfono y dirección para confirmar tu reserva?",
        needMoreDigits: (n) => `Entendido. Necesito ${n} dígito${n === 1 ? "" : "s"} más.`,
        phoneComplete: (formatted) => `Perfecto, tengo tu número como ${formatted}. ¿Cuál es la dirección para la limpieza?`,
        askAddress: "¿Cuál es la dirección para la limpieza?",
        confirmBooking: (details) => `¡Perfecto! Te tengo programado para ${details.date} a las ${details.time} en ${details.city}. Tu teléfono es ${details.phone} y la dirección es ${details.address}. Te enviaremos una confirmación pronto.`,
        help: "Puedo ayudar con reservas, precios, áreas de servicio y horarios. ¿Qué te gustaría saber?",
        didntCatch: "No entendí eso. ¿Puedes repetir?",
      },
      pt: {
        greeting: "Olá! Gostaria de saber se vocês atendem Brookline.",
        stillThere: "Você ainda está aí?",
        serviceConfirm: (city) => `Sim, atendemos ${city}! Qual data e horário funcionam melhor para você?`,
        serviceUnknown: (city) => `Não tenho certeza se atendemos ${city}. Deixe-me verificar. Posso pegar seu número de telefone e endereço?`,
        askPhone: "Posso pegar seu número de telefone e endereço para confirmar sua reserva?",
        needMoreDigits: (n) => `Entendi. Preciso de mais ${n} dígito${n === 1 ? "" : "s"}.`,
        phoneComplete: (formatted) => `Ótimo, tenho seu número como ${formatted}. Qual é o endereço para a limpeza?`,
        askAddress: "Qual é o endereço para a limpeza?",
        confirmBooking: (details) => `Perfeito! Tenho você agendado para ${details.date} às ${details.time} em ${details.city}. Seu telefone é ${details.phone} e o endereço é ${details.address}. Enviaremos uma confirmação em breve.`,
        help: "Posso ajudar com reservas, preços, áreas de atendimento e horários. O que você gostaria de saber?",
        didntCatch: "Não entendi isso. Pode repetir?",
      },
    };
    
    const msgs = translations[this.language] || translations.en;
    return typeof msgs[key] === "function" ? msgs[key] : msgs[key] || msgs.didntCatch;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// City extraction
// ───────────────────────────────────────────────────────────────────────────────
function extractCity(text) {
  const q = normalize(text);
  
  // Check aliases first (handles misspellings and variations)
  for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
    if (q.includes(alias)) {
      return canonical;
    }
  }
  
  // Check main service areas
  for (const city of SERVICE_AREAS) {
    if (q.includes(city.toLowerCase())) {
      return city;
    }
  }
  
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Date/time extraction
// ───────────────────────────────────────────────────────────────────────────────
function extractDateTime(text) {
  const q = normalize(text);
  
  // Days of week
  const dayMap = {
    monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
    thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
  };
  
  // Time patterns
  const timePatterns = [
    { regex: /(\d{1,2})\s*(am|pm|a m|p m)/i, format: (m) => `${m[1]} ${m[2].replace(" ", "").toUpperCase()}` },
    { regex: /(\d{1,2})\s*o\s*clock/i, format: (m) => `${m[1]}:00` },
    { regex: /(morning|afternoon|evening)/i, format: (m) => m[1] },
  ];
  
  let date = null;
  let time = null;
  
  // Extract day
  for (const [key, value] of Object.entries(dayMap)) {
    if (q.includes(key)) {
      date = value;
      break;
    }
  }
  
  // Extract time
  for (const pattern of timePatterns) {
    const match = q.match(pattern.regex);
    if (match) {
      time = pattern.format(match);
      break;
    }
  }
  
  return { date, time };
}

// ───────────────────────────────────────────────────────────────────────────────
// Main routing logic
// ───────────────────────────────────────────────────────────────────────────────
function routeWithContext(input, ctx) {
  const q = normalize(input);
  
  // 🔧 FIX BUG #1: ONLY extract phone if we're actively collecting it
  if (ctx.collectingPhone) {
    const digits = extractPhoneNumber(input);
    if (digits.length > 0) {
      ctx.data.phone += digits;
      console.log(`[PHONE] Accumulated: ${ctx.data.phone} (added ${digits})`);
      
      // Check if complete
      if (ctx.data.phone.length >= 10) {
        // Format with spaces so TTS says each digit: "6 1 7, 7 7 8, 5 4 5 4"
        const formatted = `${ctx.data.phone[0]} ${ctx.data.phone[1]} ${ctx.data.phone[2]}, ${ctx.data.phone[3]} ${ctx.data.phone[4]} ${ctx.data.phone[5]}, ${ctx.data.phone[6]} ${ctx.data.phone[7]} ${ctx.data.phone[8]} ${ctx.data.phone[9]}`;
        ctx.collectingPhone = false; // Done collecting phone
        ctx.askedFor = "address";
        return ctx.t("phoneComplete")(formatted);
      } else {
        const needed = 10 - ctx.data.phone.length;
        return ctx.t("needMoreDigits")(needed);
      }
    }
  }
  
  // Extract city (always check for city mentions)
  const city = extractCity(input);
  if (city) {
    ctx.data.city = city;
  }
  
  // Extract date/time (always check)
  const { date, time } = extractDateTime(input);
  if (date) ctx.data.date = date;
  if (time) ctx.data.time = time;
  
  // SERVICE AREA QUESTIONS
  if (q.match(/\b(service|available|area|cover|you say|do you)\b/)) {
    if (ctx.data.city && SERVICE_AREAS.includes(ctx.data.city)) {
      return ctx.t("serviceConfirm")(ctx.data.city);
    }
    if (ctx.data.city) {
      ctx.askedFor = "phone";
      ctx.collectingPhone = true; // Start collecting phone
      return ctx.t("serviceUnknown")(ctx.data.city);
    }
  }
  
  // PHONE COLLECTION - Start collecting
  if (q.match(/\b(phone|number|call|contact)\b/) || ctx.askedFor === "phone") {
    if (!ctx.collectingPhone && ctx.data.phone.length < 10) {
      ctx.collectingPhone = true;
      ctx.askedFor = "phone";
      return ctx.t("askPhone");
    }
  }
  
  // ADDRESS COLLECTION
  if (ctx.askedFor === "address" || q.match(/\b(address|street|avenue|road|apt|unit)\b/)) {
    // Extract address - but don't extract phone digits here!
    if (input.length > 3 && !ctx.collectingPhone) {
      ctx.data.address = input;
      ctx.askedFor = null;
      
      // If we have all booking details, confirm
      if (ctx.data.city && ctx.data.date && ctx.data.time && ctx.data.phone && ctx.data.address) {
        // Format with spaces so TTS says each digit
        const formatted = `${ctx.data.phone[0]} ${ctx.data.phone[1]} ${ctx.data.phone[2]}, ${ctx.data.phone[3]} ${ctx.data.phone[4]} ${ctx.data.phone[5]}, ${ctx.data.phone[6]} ${ctx.data.phone[7]} ${ctx.data.phone[8]} ${ctx.data.phone[9]}`;
        return ctx.t("confirmBooking")({
          city: ctx.data.city,
          date: ctx.data.date,
          time: ctx.data.time,
          phone: formatted,
          address: ctx.data.address,
        });
      }
      
      return "Thank you. Can you confirm your name and email address?";
    }
  }
  
  // HELP / GENERAL
  if (q.match(/\b(help|what can|services|hours|price|cost)\b/)) {
    return ctx.t("help");
  }
  
  // FALLBACK
  return ctx.t("didntCatch");
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram connection
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(onFinal, onPartialTimeout, lang, ws) {
  const languageMap = { en: "en-US", es: "es", pt: "pt" };
  const dgLang = languageMap[lang] || "en-US";
  const url = `wss://api.deepgram.com/v1/listen?language=${dgLang}&punctuate=false&encoding=linear16&sample_rate=${SAMPLE_RATE}`;
  
  const dg = new WebSocket(url, { headers: { Authorization: `Token ${DG_KEY}` } });
  
  let partialTimer;
  let lastPartialText = "";
  
  dg.on("open", () => console.log("[DG] connected"));
  
  dg.on("message", (data) => {
    let result;
    try { result = JSON.parse(data.toString()); } catch { return; }
    
    const transcript = result?.channel?.alternatives?.[0]?.transcript || "";
    if (!transcript || transcript.trim() === "") return;
    
    if (result.is_final) {
      if (partialTimer) {
        clearTimeout(partialTimer);
        partialTimer = null;
      }
      lastPartialText = "";
      console.log(`[ASR] ${safeLog(transcript)}`);
      onFinal(transcript);
    } else {
      lastPartialText = transcript;
      if (partialTimer) clearTimeout(partialTimer);
      partialTimer = setTimeout(() => {
        if (lastPartialText && lastPartialText.trim() !== "") {
          console.log(`[ASR] promoted partial: ${safeLog(lastPartialText)}`);
          onFinal(lastPartialText);
          lastPartialText = "";
        }
      }, ASR_PARTIAL_PROMOTE_MS);
      
      if (onPartialTimeout) onPartialTimeout();
    }
  });
  
  dg.on("error", (err) => console.error("[DG] error", err));
  dg.on("close", () => {
    console.log("[DG] close");
    if (partialTimer) clearTimeout(partialTimer);
  });
  
  return dg;
}

// ───────────────────────────────────────────────────────────────────────────────
// Stream frames
// ───────────────────────────────────────────────────────────────────────────────
async function streamFrames(ws, buf) {
  const frameSize = MEDIA_FORMAT === "mulaw" ? BYTES_PER_FRAME_MULAW : BYTES_PER_FRAME_PCM16;
  for (let offset = 0; offset < buf.length; offset += frameSize) {
    const chunk = buf.slice(offset, offset + frameSize);
    if (chunk.length === 0) continue;
    
    const paddedChunk = chunk.length < frameSize ? 
      Buffer.concat([chunk, Buffer.alloc(frameSize - chunk.length)]) : chunk;
    
    const msg = JSON.stringify({
      event: "media",
      streamSid: ws._streamSid,
      media: { payload: paddedChunk.toString("base64") },
    });
    
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
      await new Promise((r) => setImmediate(r));
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

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
    // 🔧 FIX BUG #2: Use longer grace period during phone collection
    const currentGracePeriod = ws._ctx.collectingPhone ? PHONE_COLLECTION_GRACE_MS : POST_TTS_GRACE_MS;
    
    if (Date.now() < ws._graceUntil) {
      console.log("[GRACE] Ignoring input during grace period");
      return;
    }
    if (ws._speaking) return;

    // Detect language ONLY on first input, then lock it in
    if (!ws._ctx.languageDetected) {
      const detectedLang = detectLanguage(finalText);
      ws._ctx.language = detectedLang;
      ws._ctx.languageDetected = true;
      console.log(`[LANG] Detected and locked to: ${ws._ctx.language}`);
      
      // Reconnect Deepgram with correct language if needed
      if (detectedLang !== "en") {
        if (ws._dgConnection) ws._dgConnection.close();
        ws._dgConnection = connectDeepgram(handleFinal, () => resetNoInputTimer(), ws._ctx.language, ws);
      }
    }

    console.log(`[USER] "${safeLog(finalText)}"`);
    
    let reply;
    try {
      reply = routeWithContext(finalText, ws._ctx);
      console.log(`[BOT] "${safeLog(reply)}"`);
      console.log(`[CONTEXT] ${safeLog(JSON.stringify(ws._ctx.data))}`);
    } catch (e) {
      console.error("[ROUTING] Error in routeWithContext:", e.message);
      reply = "I'm sorry, I had trouble processing that. Could you please repeat?";
    }

    ws._speaking = true;
    try {
      const out = MEDIA_FORMAT === "mulaw" ? 
        await ttsToMulaw(reply, ws._ctx.language) : 
        await ttsToPcm16(reply, ws._ctx.language);
      await streamFrames(ws, out);
      console.log("[TTS] Successfully streamed response");
    } catch (e) {
      console.error("[TTS] reply failed:", e.message, e.stack);
      // Try to send an error message to the user
      try {
        const errorMsg = "I'm having trouble with my voice. Please try again.";
        const errorBuf = MEDIA_FORMAT === "mulaw" ? 
          await ttsToMulaw(errorMsg, "en") : 
          await ttsToPcm16(errorMsg, "en");
        await streamFrames(ws, errorBuf);
      } catch (e2) {
        console.error("[TTS] Error message also failed:", e2.message);
      }
    } finally {
      ws._speaking = false;
      // 🔧 FIX BUG #2: Apply appropriate grace period
      ws._graceUntil = Date.now() + currentGracePeriod;
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
        console.log(`[GREETING] Attempting to say: "${safeLog(text)}"`);
        const buf = MEDIA_FORMAT === "mulaw" ? 
          await ttsToMulaw(text) : 
          await ttsToPcm16(text);
        console.log(`[GREETING] TTS generated ${buf.length} bytes`);
        await streamFrames(ws, buf);
        console.log(`[GREETING] Successfully streamed greeting`);
        ws._ctx.greeted = true;
        // NO grace period after greeting - user should be able to respond immediately
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message, e.stack);
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
