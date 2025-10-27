// ═══════════════════════════════════════════════════════════════════════════════
// 🎙️ HIGH DEFINITION VERSION - OpenAI TTS HD Model
// Uses tts-1-hd for better voice quality (2x cost but still 33x cheaper than ElevenLabs)
// Cost: $30 per 1M characters vs $15 for standard
// ═══════════════════════════════════════════════════════════════════════════════
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DG_KEY = process.env.DEEPGRAM_API_KEY || "";
const MEDIA_FORMAT = (process.env.TWILIO_MEDIA_FORMAT || "pcm16").toLowerCase();

// OpenAI TTS Voice IDs for different languages
const OPENAI_VOICE_EN = process.env.OPENAI_VOICE_EN || "shimmer"; // English - clear, warm, natural
const OPENAI_VOICE_ES = process.env.OPENAI_VOICE_ES || "shimmer"; // Spanish - same voice works well
const OPENAI_VOICE_PT = process.env.OPENAI_VOICE_PT || "shimmer"; // Portuguese - same voice works well
// Available voices: alloy, echo, fable, onyx, nova, shimmer
// Best for phone: shimmer (most natural), alloy (clearest)

// SECURITY: Optional authentication - if AGENT_TOKEN is set, it will be required
// If AGENT_TOKEN is not set, authentication is disabled (for backwards compatibility)
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const AUTH_ENABLED = !!AGENT_TOKEN;

if (!OPENAI_API_KEY) { 
  console.error("❌ Missing OPENAI_API_KEY"); 
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
const PHONE_COLLECTION_GRACE_MS = 1500;

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
// TTS via OpenAI
// ───────────────────────────────────────────────────────────────────────────────
async function ttsOpenAIRaw(text, lang = "en") {
  // Select voice based on language (you can customize these)
  const voice = lang === "es" ? OPENAI_VOICE_ES : 
                lang === "pt" ? OPENAI_VOICE_PT : OPENAI_VOICE_EN;
  
  const url = "https://api.openai.com/v1/audio/speech";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ 
      model: "tts-1-hd", // HD model for better quality (2x cost but still cheap)
      voice: voice,
      input: text,
      response_format: "pcm", // Get raw PCM audio
      speed: 1.0
    }),
  });
  
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI TTS failed: ${res.status} ${errorText}`);
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
  // OpenAI returns PCM at 24kHz 16-bit mono, we need to resample to 8kHz for Twilio
  const input = await ttsOpenAIRaw(text, lang);
  
  // Resample from 24kHz to 8kHz
  let out = await ffmpegTranscode(input, [
    "-hide_banner","-nostdin","-loglevel","error",
    "-f","s16le","-ar","24000","-ac","1","-i","pipe:0", // Input: 24kHz PCM16 mono
    "-f","s16le","-ar","8000","-ac","1","pipe:1", // Output: 8kHz PCM16 mono
  ]);
  
  if (out.length % 2 !== 0) out = out.slice(0, out.length - 1);
  return out;
}

async function ttsToMulaw(text, lang = "en") {
  const input = await ttsOpenAIRaw(text, lang);
  return await ffmpegTranscode(input, [
    "-hide_banner","-nostdin","-loglevel","error",
    "-f","s16le","-ar","24000","-ac","1","-i","pipe:0", // Input: 24kHz PCM16 mono
    "-f","mulaw","-ar","8000","-ac","1","pipe:1", // Output: 8kHz mulaw
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
// Conversation context with state tracking
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.language = "en";
    this.languageDetected = false; // Flag to prevent language switching mid-conversation
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
    this.greeted = false;
    this.state = "greeting"; // greeting, booking, pricing, confirming, complete
    this.collectingPhone = false; // Track when actively collecting phone
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
// Entity extraction helpers
// ───────────────────────────────────────────────────────────────────────────────
function extractCity(text) {
  const q = normalize(text);
  
  // Check aliases first
  for (const [alias, city] of Object.entries(CITY_ALIASES)) {
    if (q.includes(alias)) return city;
  }
  
  // Check service areas
  for (const city of SERVICE_AREAS) {
    if (q.includes(city.toLowerCase())) return city;
  }
  
  return null;
}

function extractDateTime(text) {
  const q = normalize(text);
  const result = { day: null, time: null, raw: text };
  
  // Days of week
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  for (const day of days) {
    if (q.includes(day)) {
      result.day = day.charAt(0).toUpperCase() + day.slice(1);
      break;
    }
  }
  
  // Relative days
  if (q.includes("today")) result.day = "today";
  if (q.includes("tomorrow")) result.day = "tomorrow";
  if (q.includes("next week")) result.day = "next week";
  
  // Time patterns
  const timeMatch = q.match(/(\d{1,2})\s*(am|pm|o\s*clock|oclock)/i);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const meridiem = timeMatch[2];
    if (meridiem.includes("pm") || meridiem.includes("p m")) {
      result.time = hour === 12 ? "12 PM" : `${hour} PM`;
    } else if (meridiem.includes("am") || meridiem.includes("a m")) {
      result.time = hour === 12 ? "12 AM" : `${hour} AM`;
    } else { // o'clock - assume context
      result.time = hour < 8 ? `${hour} PM` : `${hour} AM`;
    }
  }
  
  // Time range patterns (e.g., "between 2 and 4")
  const rangeMatch = q.match(/between\s+(\d{1,2})\s+and\s+(\d{1,2})/);
  if (rangeMatch) {
    result.time = `${rangeMatch[1]}-${rangeMatch[2]}`;
  }
  
  return result.day || result.time ? result : null;
}

function extractRoomCount(text) {
  const q = normalize(text);
  const result = { bedrooms: null, bathrooms: null };
  
  // Bedroom patterns
  const bedroomMatch = q.match(/(\d+|one|two|three|four|five|studio)\s*(bed|bedroom)/);
  if (bedroomMatch) {
    const num = bedroomMatch[1];
    if (num === "studio") result.bedrooms = 0;
    else if (num === "one") result.bedrooms = 1;
    else if (num === "two") result.bedrooms = 2;
    else if (num === "three") result.bedrooms = 3;
    else if (num === "four") result.bedrooms = 4;
    else if (num === "five") result.bedrooms = 5;
    else result.bedrooms = parseInt(num);
  }
  
  // Bathroom patterns
  const bathroomMatch = q.match(/(\d+|one|two|three|four|half)\s*(bath|bathroom)/);
  if (bathroomMatch) {
    const num = bathroomMatch[1];
    if (num === "half") result.bathrooms = 0.5;
    else if (num === "one") result.bathrooms = 1;
    else if (num === "two") result.bathrooms = 2;
    else if (num === "three") result.bathrooms = 3;
    else if (num === "four") result.bathrooms = 4;
    else result.bathrooms = parseInt(num);
  }
  
  return result.bedrooms !== null || result.bathrooms !== null ? result : null;
}


// ───────────────────────────────────────────────────────────────────────────────
// 📞 PHONE NUMBER EXTRACTION - COMPREHENSIVE FIX
// ───────────────────────────────────────────────────────────────────────────────
const NUMBER_WORDS_MAP = {
  'zero': '0', 'oh': '0', 'o': '0',
  'one': '1', 'won': '1',
  'two': '2', 'to': '2', 'too': '2',
  'three': '3', 'tree': '3',
  'four': '4', 'for': '4', 'fore': '4',
  'five': '5',
  'six': '6', 'sicks': '6',
  'seven': '7',
  'eight': '8', 'ate': '8',
  'nine': '9',
  'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14',
  'fifteen': '15', 'sixteen': '16', 'seventeen': '17', 'eighteen': '18', 'nineteen': '19',
  'twenty': '20', 'thirty': '30', 'forty': '40', 'fifty': '50', 'sixty': '60',
  'seventy': '70', 'eighty': '80', 'ninety': '90',
  'double': 'repeat_next', 'triple': 'triple_next'
};


function extractPhoneNumber(text) {
  const q = normalize(text);
  const phonePattern = /(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/;
  const match = q.match(phonePattern);
  if (match) return match[1].replace(/\D/g, '');
  
  let digits = '';
  const words = q.split(/\s+/);
  let i = 0;
  
  while (i < words.length) {
    const word = words[i];
    
    // Handle "double" pattern
    if (word === 'double' && i + 1 < words.length) {
      const nextDigit = NUMBER_WORDS_MAP[words[i + 1]];
      if (nextDigit && nextDigit !== 'repeat_next' && nextDigit !== 'triple_next') {
        digits += nextDigit + nextDigit;
        i += 2;
        continue;
      }
    }
    
    // Handle "triple" pattern
    if (word === 'triple' && i + 1 < words.length) {
      const nextDigit = NUMBER_WORDS_MAP[words[i + 1]];
      if (nextDigit && nextDigit !== 'repeat_next' && nextDigit !== 'triple_next') {
        digits += nextDigit + nextDigit + nextDigit;
        i += 2;
        continue;
      }
    }
    
    // Handle "X hundred" pattern - NEW!
    if (i + 1 < words.length && words[i + 1] === 'hundred') {
      const multiplierWord = word;
      const multiplierDigit = NUMBER_WORDS_MAP[multiplierWord];
      if (multiplierDigit && multiplierDigit.length === 1) {
        // "two hundred" = 200, "three hundred" = 300
        digits += multiplierDigit + '00';
        i += 2;
        continue;
      }
    }
    
    
    // Regular number mapping
    if (NUMBER_WORDS_MAP[word]) {
      const mapped = NUMBER_WORDS_MAP[word];
      if (mapped !== 'repeat_next' && mapped !== 'triple_next') {
        digits += mapped;
      }
    }
    
    // Direct digits
    if (/^\d+$/.test(word)) {
      digits += word;
    }
    
    i++;
  }
  return digits.length > 0 ? digits : null;
}


function formatPhoneNumber(digits) {
  if (digits.length === 10) {
    // Format with spaces so TTS says each digit individually
    return `${digits[0]} ${digits[1]} ${digits[2]}, ${digits[3]} ${digits[4]} ${digits[5]}, ${digits[6]} ${digits[7]} ${digits[8]} ${digits[9]}`;
  }
  return digits;
}

function extractAddress(text) {
  const q = normalize(text);
  
  // Look for common address patterns
  // Number + Street name + Street type
  const addressPattern = /\d+\s+[a-z]+\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|circle|court|ct|boulevard|blvd|place|pl)/;
  const match = q.match(addressPattern);
  if (match) return match[0];
  
  // Just capture the full text if it seems like an address
  // (Contains numbers and common street words)
  if (q.match(/\d+/) && (q.includes('street') || q.includes('avenue') || q.includes('road'))) {
    return text.trim();
  }
  
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Intent routing with context and entity extraction
// ───────────────────────────────────────────────────────────────────────────────
function routeWithContext(text, ctx) {
  const q = normalize(text);
  const words = q.split(/\s+/); // Declare words at top so it's available throughout function
  
  // Defensive: ensure context data object exists
  if (!ctx.data) {
    ctx.data = {
      city: null,
      date: null,
      time: null,
      bedrooms: null,
      bathrooms: null,
      cleaningType: null,
      frequency: null,
      phone: null,
      address: null,
    };
  }
  
  // Extract entities from user input
  const city = extractCity(text);
  const dateTime = extractDateTime(text);
  const rooms = extractRoomCount(text);
  // ONLY extract phone during confirming state to prevent address numbers from being added
  let phone = null;
  if (ctx.state === "confirming" && (!ctx.data.phone || ctx.data.phone.length < 10)) {
    phone = extractPhoneNumber(text);
    ctx.collectingPhone = true;
  } else if (ctx.data.phone && ctx.data.phone.length >= 10) {
    ctx.collectingPhone = false;
  }
  const address = extractAddress(text);
  
  // Store extracted entities in context - with safe null checks
  if (city) ctx.data.city = city;
  if (dateTime && dateTime.day) ctx.data.date = dateTime.day;
  if (dateTime && dateTime.time) ctx.data.time = dateTime.time;
  if (rooms && rooms.bedrooms !== null && rooms.bedrooms !== undefined) {
    ctx.data.bedrooms = rooms.bedrooms;
  }
  if (rooms && rooms.bathrooms !== null && rooms.bathrooms !== undefined) {
    ctx.data.bathrooms = rooms.bathrooms;
  }
  if (address) ctx.data.address = address;
  
  // STATE: Waiting for date/time after asking for it
  if (ctx.state === "booking" && dateTime) {
    ctx.state = "confirming";
    const dayStr = (ctx.data && ctx.data.date) ? ctx.data.date : "that day";
    const timeStr = (ctx.data && ctx.data.time) ? ctx.data.time : "that time";
    return `Perfect! I have you down for ${dayStr} at ${timeStr}. Can you give me your phone number? Say the digits one at a time.`;
  }
  
  
  // ───────────────────────────────────────────────────────────────────────────────
  // STATE: Collecting contact info (phone and address) - PHONE FIX APPLIED
  // ───────────────────────────────────────────────────────────────────────────────
  if (ctx.state === "confirming") {
    // ACCUMULATE phone digits instead of replacing
    if (phone) {
      ctx.data.phone += phone;
      console.log(`[PHONE] Accumulated: ${ctx.data.phone} (added ${phone})`);
    }
    
    const currentPhone = ctx.data.phone || "";
    const hasCompletePhone = currentPhone.length >= 10;
    const hasAddress = ctx.data.address;
    
    if (phone && !hasCompletePhone) {
      const remaining = 10 - currentPhone.length;
      if (remaining > 0) {
        return `Got it. I need ${remaining} more digits.`;
      }
    }
    
    if (hasCompletePhone && !hasAddress) {
      if (address) {
        ctx.state = "complete";
        const formatted = formatPhoneNumber(currentPhone);
        return `Perfect! I have your booking for ${ctx.data.date || 'that day'} at ${ctx.data.time || 'that time'} at ${address}. We'll call you at ${formatted} to confirm. Thank you for choosing Clean Easy!`;
      } else {
        const formatted = formatPhoneNumber(currentPhone);
        return `Great, I have your number as ${formatted}. What's the address for the cleaning?`;
      }
    }
    
    if (address && !hasAddress && hasCompletePhone) {
      ctx.state = "complete";
      const formatted = formatPhoneNumber(currentPhone);
      return `Perfect! I have your booking for ${ctx.data.date || 'that day'} at ${ctx.data.time || 'that time'} at ${address}. We'll call you at ${formatted} to confirm. Thank you for choosing Clean Easy!`;
    }
    
    if (hasCompletePhone && hasAddress) {
      ctx.state = "complete";
      const formatted = formatPhoneNumber(currentPhone);
      return `Perfect! I have your booking for ${ctx.data.date || 'that day'} at ${ctx.data.time || 'that time'} at ${ctx.data.address}. We'll call you at ${formatted} to confirm. Thank you for choosing Clean Easy!`;
    }
    
    if (!phone && !address) {
      // Handle conversational responses during phone collection
      if (q.includes("what") || q.includes("have") || q.includes("so far")) {
        // User is asking what we have
        if (currentPhone && currentPhone.length > 0) {
          const formatted = currentPhone.length === 10 ? formatPhoneNumber(currentPhone) : currentPhone;
          const remaining = 10 - currentPhone.length;
          if (remaining > 0) {
            return `I have ${formatted} so far. I need ${remaining} more digits.`;
          } else {
            return `I have your number as ${formatted}. What's the address for the cleaning?`;
          }
        } else {
          return "I don't have any digits yet. Can you give me your phone number?";
        }
      }
      
      // Handle acknowledgments (okay, sure, yes) - just repeat what we need
      if (q.match(/^(okay|ok|sure|yes|yeah|yep|alright)\b/)) {
        if (!currentPhone || currentPhone.length === 0) {
          return "Can you give me your phone number? Say the digits one at a time.";
        } else if (!hasCompletePhone) {
          const remaining = 10 - currentPhone.length;
          return `I need ${remaining} more digits for your phone number.`;
        } else if (!hasAddress) {
          return "What's the address for the cleaning?";
        }
      }
      
      // Default - didn't catch anything useful
      if (!currentPhone || currentPhone.length === 0) {
        return "I didn't catch that. Can you give me your phone number? Say the digits one at a time.";
      } else if (!hasCompletePhone) {
        const remaining = 10 - currentPhone.length;
        return `I need ${remaining} more digits for your phone number.`;
      } else if (!hasAddress) {
        return "And what's the address for the cleaning?";
      }
    }
  }
  
  // STATE: Waiting for room count after asking for it
  if (ctx.state === "pricing" && rooms) {
    // Defensive: ensure data object exists and has default values
    if (!ctx.data) ctx.data = {};
    const bed = ctx.data.bedrooms ?? 1;
    const bath = ctx.data.bathrooms ?? 1;
    const price = 100 + (bed * 30) + (bath * 20);
    return `For a ${bed === 0 ? 'studio' : bed + ' bedroom'} with ${bath} bathroom, our standard cleaning starts at around $${price}. Would you like to book a cleaning?`;
  }
  
  // Service area question with city mentioned - includes conversational queries
  if (city && (q.includes("available") || q.includes("service") || q.includes("area") || q.includes("come") || q.includes("you say") || q.includes("did you") || q.includes("do you mean") || q.includes("is that") || q.includes("you mean"))) {
    if (SERVICE_AREAS.includes(city)) {
      ctx.state = "booking";
      return `Yes, we service ${city}! What date and time work best for you?`;
    } else {
      return `I'm sorry, we don't currently service ${city}. We serve the Greater Boston area including Cambridge, Somerville, Brookline, Newton, and surrounding cities.`;
    }
  }
  
  // FALLBACK: City mentioned but without clear service keywords
  // Handles: "quincy", "that are quincy", "what about", etc.
  if (city && words.length <= 5) {
    // User mentioned a city in a short response - likely answering "What area are you in?"
    if (SERVICE_AREAS.includes(city)) {
      ctx.state = "booking";
      return `Yes, we service ${city}! What date and time work best for you?`;
    } else {
      return `I'm sorry, we don't currently service ${city}. We serve the Greater Boston area including Cambridge, Somerville, Brookline, Newton, and surrounding cities.`;
    }
  }
  
  // Availability / Booking / Scheduling (without city)
  if (q.includes("available") || q.includes("availability") || 
      q.includes("book") || q.includes("appointment") || 
      q.includes("schedule") || q.includes("reserve")) {
    ctx.state = "booking";
    return "Yes, we're available! What date and time work best for you?";
  }
  
  // They provided date/time without us asking
  if (dateTime && ctx.state !== "booking") {
    ctx.state = "confirming";
    const dayStr = (ctx.data && ctx.data.date) ? ctx.data.date : "that day";
    const timeStr = (ctx.data && ctx.data.time) ? ctx.data.time : "that time";
    return `Great! I can schedule you for ${dayStr} at ${timeStr}. Can you give me your phone number? Say the digits one at a time.`;
  }
  
  // Service area check (general)
  if (q.includes("area") || q.includes("service") || q.includes("where") ||
      q.includes("location") || q.includes("come to")) {
    return "We service the Greater Boston area including Cambridge, Somerville, Brookline, Newton, and surrounding cities. What area are you in?";
  }
  
  // Hours / Open times
  if (q.includes("hour") || q.includes("open") || q.includes("close") ||
      q.includes("when") && (q.includes("open") || q.includes("available"))) {
    return "We're open 8 AM to 6 PM Monday through Friday, and 9 AM to 2 PM on Saturday.";
  }
  
  // Pricing
  if (q.includes("price") || q.includes("pricing") || q.includes("cost") || 
      q.includes("how much") || q.includes("charge")) {
    ctx.state = "pricing";
    return "Our pricing depends on the size of your space and the type of cleaning. How many bedrooms and bathrooms do you have?";
  }
  
  // Types of cleaning
  if (q.includes("deep clean") || q.includes("move out") || q.includes("airbnb") ||
      q.includes("type") && q.includes("clean")) {
    return "We offer standard cleaning, deep cleaning, Airbnb turnover, and move-out cleaning. Which are you interested in?";
  }
  
  // Affirmative responses (yes, yeah, sure)
  if (q.match(/^(yes|yeah|yep|sure|ok|okay)\b/)) {
    if (ctx.state === "pricing") {
      ctx.state = "booking";
      return "Great! What date and time work best for you?";
    }
    return "Great! What specifically would you like help with - booking a cleaning, pricing information, or something else?";
  }
  
  // Greetings - ONLY if it's just a greeting with no other content (moved to end)
  // Check if the message is ONLY a greeting (5 words or less, no substantive keywords)
  const isJustGreeting = words.length <= 5 && 
    q.match(/^(hi|hello|hey|good morning|good afternoon|good evening)\b/) &&
    !q.includes("available") && !q.includes("book") && !q.includes("price") &&
    !q.includes("hour") && !q.includes("service") && !q.includes("clean");
  
  if (isJustGreeting && !ctx.greeted) {
    return "Hello! How can I help you today?";
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
    // Use longer grace when collecting phone to avoid interrupting
    const gracePeriod = ws._ctx.collectingPhone ? PHONE_COLLECTION_GRACE_MS : POST_TTS_GRACE_MS;
    
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
      const nextGracePeriod = ws._ctx.collectingPhone ? PHONE_COLLECTION_GRACE_MS : POST_TTS_GRACE_MS;
      ws._graceUntil = Date.now() + nextGracePeriod;
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
