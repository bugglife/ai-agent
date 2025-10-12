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
if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
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
const POST_TTS_GRACE_MS = 1200; // Shorter grace - just enough to prevent echo, not responses

// ───────────────────────────────────────────────────────────────────────────────
// SERVICE AREAS & PRICING
// ───────────────────────────────────────────────────────────────────────────────
const SERVICE_AREAS = [
  "Boston","Cambridge","Somerville","Brookline","Newton","Watertown","Arlington",
  "Belmont","Medford","Waltham","Needham","Wellesley","Dedham","Quincy"
];

// Common STT errors / phonetic variations
const CITY_ALIASES = {
  "brooklyn": "Brookline",
  "brook line": "Brookline",
  "brooklin": "Brookline",
  "brook": "Brookline",  // Deepgram often cuts off "Brookline" to just "Brook"
  "brooks": "Brookline",
  "brooke": "Brookline",
  "cambridge": "Cambridge",
  "somerville": "Somerville",
  "sommerville": "Somerville",
  "newton": "Newton",
  "new town": "Newton",
  "watertown": "Watertown",
  "water town": "Watertown",
  "arlington": "Arlington",
  "belmont": "Belmont",
  "beaumont": "Belmont",
  "medford": "Medford",
  "waltham": "Waltham",
  "needham": "Needham",
  "wellesley": "Wellesley",
  "wellsley": "Wellesley",
  "dedham": "Dedham",
  "quincy": "Quincy",
  "quinsy": "Quincy",
};

// Your actual pricing matrix: bedroom-bathroom combos
const PRICING_MATRIX = {
  standard: {
    Studio: 100, "1-1": 120, "1-2": 140, "2-1": 160, "2-2": 180, "2-3": 200, "2-4": 220, "2-5+": 240,
    "3-1": 200, "3-2": 220, "3-3": 260, "3-4": 280, "3-5+": 300,
    "4-1": 260, "4-2": 270, "4-3": 280, "4-4": 300, "4-5+": 320,
    "5+-1": 300, "5+-2": 310, "5+-3": 320, "5+-4": 320, "5+-5+": 340,
  },
  airbnb: {
    Studio: 120, "1-1": 140, "1-2": 160, "2-1": 180, "2-2": 200, "2-3": 220, "2-4": 240, "2-5+": 260,
    "3-1": 220, "3-2": 240, "3-3": 270, "3-4": 290, "3-5+": 310,
    "4-1": 280, "4-2": 290, "4-3": 300, "4-4": 320, "4-5+": 350,
    "5+-1": 330, "5+-2": 340, "5+-3": 350, "5+-4": 350, "5+-5+": 370,
  },
  deep: {
    Studio: 150, "1-1": 180, "1-2": 200, "2-1": 220, "2-2": 240, "2-3": 260, "2-4": 280, "2-5+": 300,
    "3-1": 275, "3-2": 295, "3-3": 335, "3-4": 355, "3-5+": 375,
    "4-1": 335, "4-2": 345, "4-3": 365, "4-4": 385, "4-5+": 415,
    "5+-1": 385, "5+-2": 395, "5+-3": 415, "5+-4": 415, "5+-5+": 435,
  },
  moveout: {
    Studio: 180, "1-1": 220, "1-2": 260, "2-1": 280, "2-2": 320, "2-3": 340, "2-4": 360, "2-5+": 380,
    "3-1": 355, "3-2": 375, "3-3": 415, "3-4": 435, "3-5+": 455,
    "4-1": 415, "4-2": 435, "4-3": 465, "4-4": 485, "4-5+": 515,
    "5+-1": 485, "5+-2": 495, "5+-3": 515, "5+-4": 515, "5+-5+": 535,
  },
};

const FREQUENCY_DISCOUNTS = {
  weekly: 0.15,
  biweekly: 0.12,
  monthly: 0.05,
  onetime: 0,
};

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function findCityInText(text) {
  const q = normalize(text);
  
  // Check if question is about service area
  const isServiceAreaQuery = q.includes("service") || q.includes("cover") || 
                             q.includes("serve") || q.includes("area") || q.includes("clean") ||
                             q.includes("servicio") || q.includes("servico") ||
                             q.includes("atiende") || q.includes("atende") ||
                             q.includes("do you") || q.includes("can you");
  
  console.log(`[CITY DETECTION] Query: "${text}" | isServiceAreaQuery: ${isServiceAreaQuery}`);
  
  // First, check for exact matches in known cities
  for (const city of SERVICE_AREAS) {
    const cityNorm = city.toLowerCase();
    const regex = new RegExp(`\\b${cityNorm}\\b`, "i");
    if (regex.test(text)) {
      console.log(`[CITY] Found exact match: ${city}`);
      return { city, known: true, isQuery: isServiceAreaQuery };
    }
  }
  
  // Check for phonetic aliases (STT often mishears city names)
  for (const [alias, realCity] of Object.entries(CITY_ALIASES)) {
    const regex = new RegExp(`\\b${alias}\\b`, "i");
    if (regex.test(q)) {
      console.log(`[CITY] Found via alias '${alias}' → ${realCity}`);
      return { city: realCity, known: true, isQuery: isServiceAreaQuery };
    }
  }
  
  // If it's a service area query but city not found, try to extract city name from common patterns
  if (isServiceAreaQuery) {
    // More robust pattern that skips articles
    // "in Brookline", "in the town of Brookline", "to Brookline", etc.
    const cityPatterns = [
      /(?:in|at|to|of)\s+(?:the\s+)?(?:town\s+of\s+|city\s+of\s+|area\s+of\s+)?([A-Z][a-z]{2,}(?:\s[A-Z][a-z]+)?)/gi,
      /(?:town|city|area)\s+of\s+(?:the\s+)?([A-Z][a-z]{2,}(?:\s[A-Z][a-z]+)?)/gi,
    ];
    
    for (const pattern of cityPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const extractedCity = match[1];
        
        // Skip common words that aren't cities
        const skipWords = ["the", "town", "city", "area", "this", "that"];
        if (skipWords.includes(extractedCity.toLowerCase())) {
          console.log(`[CITY] Skipped non-city word: ${extractedCity}`);
          continue;
        }
        
        console.log(`[CITY] Extracted from pattern: ${extractedCity}`);
        
        // Double-check if this extracted city is in our known list
        const knownCity = SERVICE_AREAS.find(c => c.toLowerCase() === extractedCity.toLowerCase());
        if (knownCity) {
          console.log(`[CITY] Matched to known city: ${knownCity}`);
          return { city: knownCity, known: true, isQuery: true };
        }
        
        // Check aliases too
        const aliasMatch = CITY_ALIASES[extractedCity.toLowerCase()];
        if (aliasMatch) {
          console.log(`[CITY] Matched via alias: ${extractedCity} → ${aliasMatch}`);
          return { city: aliasMatch, known: true, isQuery: true };
        }
        
        // If not in our list, return as unknown (only if 3+ chars to avoid garbage)
        if (extractedCity.length >= 3) {
          console.log(`[CITY] Not in service area: ${extractedCity}`);
          return { city: extractedCity, known: false, isQuery: true };
        }
      }
    }
  }
  
  console.log(`[CITY] No city found in query`);
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// LANGUAGE DETECTION & MULTILINGUAL CONTENT
// ───────────────────────────────────────────────────────────────────────────────
function detectLanguage(text) {
  const q = normalize(text);
  
  // Spanish indicators
  const spanishWords = ["hola", "si", "bueno", "gracias", "como", "que", "limpieza", "servicio", "precio", "cuando", "donde"];
  if (spanishWords.some(w => q.includes(w))) return "es";
  
  // Portuguese indicators
  const portugueseWords = ["ola", "sim", "obrigado", "obrigada", "como", "que", "limpeza", "servico", "preco", "quando", "onde"];
  if (portugueseWords.some(w => q.includes(w))) return "pt";
  
  return "en";
}

const TRANSLATIONS = {
  en: {
    greeting: "Hi! I'm your AI receptionist at Clean Easy. I can help with booking or answer questions. What would you like to do?",
    serviceTypes: { standard: "standard", deep: "deep", moveout: "move-out", airbnb: "Airbnb turnover" },
    askServiceType: "What type of cleaning would you like—standard, deep, move-out, or Airbnb turnover?",
    askBedrooms: "How many bedrooms?",
    askBathrooms: "And how many bathrooms?",
    askCity: "What city are you in?",
    askDateTime: "What date and time work best for you? You can say something like Saturday at 2 PM.",
    askName: "Great! Can I get your name for the booking?",
    askPhone: "And what's the best phone number to reach you?",
    priceQuote: "That would be around $",
    confirmation: "Perfect! Let me confirm:",
    confirmQuestion: "Does that sound good?",
    finalConfirm: "Perfect! We'll send a confirmation to",
    anythingElse: "Is there anything else you'd like to know?",
    stillThere: "Are you still there? I can help with booking or any questions.",
    coverCity: "Yes, we serve",
    andSurrounding: "and the surrounding area. Would you like to book a time?",
    hours: "We're open 8 AM to 8 PM Monday through Saturday, and 12 PM to 8 PM on Sunday.",
    services: "We offer standard and deep cleans, move-in and move-out services, Airbnb turnovers, and office cleanings. You can book one-time or recurring services.",
    payment: "We accept all major credit cards, Amazon Pay, Cash App Pay, Affirm, and Klarna.",
    supplies: "We bring all the supplies and equipment. If you prefer eco-friendly products, just let us know.",
    duration: "A typical standard clean takes 2 to 3 hours, while deep cleans take longer. We'll tailor it to your space.",
    guarantee: "We stand by our work. If anything was missed, let us know within 24 hours and we'll make it right.",
    cancellation: "No problem—please give us 24 hours' notice to cancel or reschedule to avoid a late cancellation fee.",
    pets: "We love pets! Just let us know about any pets so our team can be prepared.",
    smallTalk: {
      hi: "Hi there! I'm the Clean Easy assistant. How can I help—booking or any questions?",
      howAreYou: "I'm doing well—thanks for asking! How can I help you today?",
      whoAreYou: "I'm Clean Easy's AI receptionist. I can answer questions and help you book a cleaning.",
      thanks: "You're very welcome! Anything else I can help with?",
      bye: "Thanks for calling Clean Easy. Have a great day!",
    }
  },
  es: {
    greeting: "¡Hola! Soy tu recepcionista de IA de Clean Easy. Puedo ayudarte con reservas o responder preguntas. ¿Qué te gustaría hacer?",
    serviceTypes: { standard: "estándar", deep: "profunda", moveout: "mudanza", airbnb: "turno de Airbnb" },
    askServiceType: "¿Qué tipo de limpieza te gustaría—estándar, profunda, mudanza, o turno de Airbnb?",
    askBedrooms: "¿Cuántas habitaciones?",
    askBathrooms: "¿Y cuántos baños?",
    askCity: "¿En qué ciudad estás?",
    askDateTime: "¿Qué fecha y hora te funcionan mejor? Puedes decir algo como sábado a las 2 PM.",
    askName: "¡Genial! ¿Puedo tener tu nombre para la reserva?",
    askPhone: "¿Y cuál es el mejor número de teléfono para contactarte?",
    priceQuote: "Eso costaría alrededor de $",
    confirmation: "¡Perfecto! Déjame confirmar:",
    confirmQuestion: "¿Te parece bien?",
    finalConfirm: "¡Perfecto! Te enviaremos una confirmación a",
    anythingElse: "¿Hay algo más que te gustaría saber?",
    stillThere: "¿Sigues ahí? Puedo ayudarte con reservas o cualquier pregunta.",
    coverCity: "Sí, servimos",
    andSurrounding: "y el área circundante. ¿Te gustaría reservar?",
    hours: "Estamos abiertos de 8 AM a 8 PM de lunes a sábado, y de 12 PM a 8 PM los domingos.",
    services: "Ofrecemos limpieza estándar y profunda, servicios de mudanza, turnos de Airbnb, y limpieza de oficinas. Puedes reservar servicios únicos o recurrentes.",
    payment: "Aceptamos todas las tarjetas de crédito principales, Amazon Pay, Cash App Pay, Affirm y Klarna.",
    supplies: "Traemos todos los suministros y equipos. Si prefieres productos ecológicos, solo háznoslo saber.",
    duration: "Una limpieza estándar típica toma de 2 a 3 horas, mientras que las limpiezas profundas toman más tiempo.",
    guarantee: "Respaldamos nuestro trabajo. Si falta algo, avísanos dentro de las 24 horas y lo arreglaremos.",
    cancellation: "No hay problema—por favor avísanos con 24 horas de anticipación para cancelar o reprogramar y evitar una tarifa.",
    pets: "¡Amamos las mascotas! Solo háznoslo saber para que nuestro equipo esté preparado.",
    smallTalk: {
      hi: "¡Hola! Soy el asistente de Clean Easy. ¿Cómo puedo ayudarte—reservas o preguntas?",
      howAreYou: "Estoy bien—¡gracias por preguntar! ¿Cómo puedo ayudarte hoy?",
      whoAreYou: "Soy el recepcionista de IA de Clean Easy. Puedo responder preguntas y ayudarte a reservar.",
      thanks: "¡De nada! ¿Algo más en lo que pueda ayudar?",
      bye: "¡Gracias por llamar a Clean Easy. Que tengas un gran día!",
    }
  },
  pt: {
    greeting: "Olá! Sou sua recepcionista de IA da Clean Easy. Posso ajudar com reservas ou responder perguntas. O que você gostaria de fazer?",
    serviceTypes: { standard: "padrão", deep: "profunda", moveout: "mudança", airbnb: "turno Airbnb" },
    askServiceType: "Que tipo de limpeza você gostaria—padrão, profunda, mudança, ou turno Airbnb?",
    askBedrooms: "Quantos quartos?",
    askBathrooms: "E quantos banheiros?",
    askCity: "Em que cidade você está?",
    askDateTime: "Que data e hora funcionam melhor para você? Pode dizer algo como sábado às 2 da tarde.",
    askName: "Ótimo! Posso ter seu nome para a reserva?",
    askPhone: "E qual é o melhor número de telefone para contato?",
    priceQuote: "Isso custaria cerca de $",
    confirmation: "Perfeito! Deixe-me confirmar:",
    confirmQuestion: "Parece bom?",
    finalConfirm: "Perfeito! Enviaremos uma confirmação para",
    anythingElse: "Há mais alguma coisa que você gostaria de saber?",
    stillThere: "Você ainda está aí? Posso ajudar com reservas ou perguntas.",
    coverCity: "Sim, atendemos",
    andSurrounding: "e a área circundante. Gostaria de reservar?",
    hours: "Estamos abertos das 8h às 20h de segunda a sábado, e das 12h às 20h aos domingos.",
    services: "Oferecemos limpeza padrão e profunda, serviços de mudança, turnos Airbnb, e limpeza de escritórios. Você pode reservar serviços únicos ou recorrentes.",
    payment: "Aceitamos todos os principais cartões de crédito, Amazon Pay, Cash App Pay, Affirm e Klarna.",
    supplies: "Trazemos todos os suprimentos e equipamentos. Se preferir produtos ecológicos, é só avisar.",
    duration: "Uma limpeza padrão típica leva de 2 a 3 horas, enquanto limpezas profundas levam mais tempo.",
    guarantee: "Garantimos nosso trabalho. Se algo foi esquecido, avise-nos dentro de 24 horas e vamos corrigir.",
    cancellation: "Sem problema—por favor avise com 24 horas de antecedência para cancelar ou reagendar e evitar uma taxa.",
    pets: "Adoramos animais de estimação! Apenas nos avise para que nossa equipe esteja preparada.",
    smallTalk: {
      hi: "Olá! Sou o assistente da Clean Easy. Como posso ajudar—reservas ou perguntas?",
      howAreYou: "Estou bem—obrigado por perguntar! Como posso ajudá-lo hoje?",
      whoAreYou: "Sou a recepcionista de IA da Clean Easy. Posso responder perguntas e ajudar a reservar.",
      thanks: "De nada! Mais alguma coisa que eu possa ajudar?",
      bye: "Obrigado por ligar para a Clean Easy. Tenha um ótimo dia!",
    }
  }
};

// ───────────────────────────────────────────────────────────────────────────────
// ENTITY EXTRACTION (multilingual)
// ───────────────────────────────────────────────────────────────────────────────
function extractName(text) {
  const patterns = [
    /(?:my name is|i'm|i am|this is|call me|me llamo|mi nombre es|meu nome é)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i,
    /^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)$/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

function extractPhone(text) {
  const m = text.match(/(\d{3}[\s.-]?\d{3}[\s.-]?\d{4}|\d{10})/);
  return m ? m[1].replace(/[^\d]/g, "") : null;
}

function extractDateTime(text) {
  const q = normalize(text);
  console.log(`[EXTRACT DateTime] Input: "${text}" → Normalized: "${q}"`);
  let day = null, time = null;
  
  const daysEn = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday","tomorrow","today"];
  const daysEs = ["lunes","martes","miercoles","jueves","viernes","sabado","domingo","mañana","hoy"];
  const daysPt = ["segunda","terca","quarta","quinta","sexta","sabado","domingo","amanha","hoje"];
  
  // Find day
  for (const d of [...daysEn, ...daysEs, ...daysPt]) {
    if (q.includes(d)) { 
      day = d;
      console.log(`[EXTRACT] Day: ${day}`);
      break; 
    }
  }
  
  // Find time - handle multiple patterns including word numbers
  const timeWords = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", 
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "eleven": "11", "twelve": "12"
  };
  
  // Pattern 1: Digit with AM/PM: "4 PM", "4:30 PM"
  let m = text.match(/(\d{1,2})\s*(?::|h)?\s*(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/i);
  if (m) {
    time = m[0];
    console.log(`[EXTRACT] Time (with AM/PM): ${time}`);
    return { day, time };
  }
  
  // Pattern 2: "at four", "at 4", "at four PM", "thinking thursday at four"
  m = text.match(/(?:at|on)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})(?:\s*(am|pm|a\.m\.|p\.m\.))?/i);
  if (m) {
    let hour = timeWords[m[1].toLowerCase()] || m[1];
    let period = m[2] || "";
    time = period ? `${hour} ${period}` : `${hour}`;
    console.log(`[EXTRACT] Time (at/on + number): ${time}`);
    return { day, time };
  }
  
  // Pattern 3: Just a number in time context (e.g., "Thursday four")
  if (day) {
    m = q.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\b/);
    if (m && !["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].includes(m[1])) {
      time = timeWords[m[1]] || m[1];
      console.log(`[EXTRACT] Time (context + number): ${time}`);
      return { day, time };
    }
  }
  
  // Pattern 4: "morning", "afternoon", "evening"
  m = text.match(/(morning|afternoon|evening|noon)/i);
  if (m) {
    time = m[0];
    console.log(`[EXTRACT] Time (period): ${time}`);
    return { day, time };
  }
  
  // Pattern 5: "o'clock"
  m = text.match(/(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(o'?clock|oclock)/i);
  if (m) {
    let hour = timeWords[m[1].toLowerCase()] || m[1];
    time = `${hour} o'clock`;
    console.log(`[EXTRACT] Time (o'clock): ${time}`);
    return { day, time };
  }
  
  return { day, time };
}

function extractBedrooms(text) {
  const q = normalize(text);
  
  // REJECT filler words that might be misheard as numbers
  if (q === "uh" || q === "um" || q === "er" || q === "ah" || q === "hmm") {
    console.log(`[EXTRACT] Rejected filler word: ${q}`);
    return null;
  }
  
  // Number words to digits
  const numberWords = {
    "studio": "Studio",
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "5+", "seven": "5+", "eight": "5+",
    "uno": "1", "dos": "2", "tres": "3", "cuatro": "4", "cinco": "5",
    "um": "1", "dois": "2", "tres": "3", "quatro": "4", "cinco": "5",
  };
  
  // Try word patterns first
  for (const [word, num] of Object.entries(numberWords)) {
    if (q.includes(word + " bed") || q.includes(word + " room") || 
        q.includes(word + " habitacion") || q.includes(word + " quarto")) {
      console.log(`[EXTRACT] Bedrooms via word: ${word} → ${num}`);
      return num;
    }
  }
  
  // Try just the number word if context suggests bedrooms
  if (q.includes("bedroom") || q.includes("habitacion") || q.includes("quarto")) {
    for (const [word, num] of Object.entries(numberWords)) {
      const wordPattern = new RegExp(`\\b${word}\\b`);
      if (wordPattern.test(q)) {
        console.log(`[EXTRACT] Bedrooms via number word: ${word} → ${num}`);
        return num;
      }
    }
  }
  
  // Try digit patterns
  const digitMatch = q.match(/(\d+)\s*(?:bed|bedroom|br|habitacion|quarto)/);
  if (digitMatch) {
    const num = parseInt(digitMatch[1]);
    const result = num >= 5 ? "5+" : num.toString();
    console.log(`[EXTRACT] Bedrooms via digit: ${num} → ${result}`);
    return result;
  }
  
  // If JUST a standalone number (and nothing else suspicious)
  const justNumber = q.match(/^(one|two|three|four|five|six|1|2|3|4|5|6|studio)$/);
  if (justNumber) {
    const word = justNumber[1];
    const result = numberWords[word] || (parseInt(word) >= 5 ? "5+" : word);
    console.log(`[EXTRACT] Bedrooms via standalone: ${word} → ${result}`);
    return result;
  }
  
  return null;
}

function extractBathrooms(text) {
  const q = normalize(text);
  
  const numberWords = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "uno": "1", "dos": "2", "tres": "3", "cuatro": "4", "cinco": "5",
    "um": "1", "dois": "2", "tres": "3", "quatro": "4", "cinco": "5",
  };
  
  // Try word patterns
  for (const [word, num] of Object.entries(numberWords)) {
    if (q.includes(word + " bath") || q.includes(word + " bano") || q.includes(word + " banheiro")) {
      console.log(`[EXTRACT] Bathrooms via word: ${word} → ${num}`);
      return num >= 5 ? "5+" : num;
    }
  }
  
  // Try digit patterns
  const digitMatch = q.match(/(\d+)\s*(?:bath|bathroom|baño|banheiro)/);
  if (digitMatch) {
    const num = parseInt(digitMatch[1]);
    const result = num >= 5 ? "5+" : num.toString();
    console.log(`[EXTRACT] Bathrooms via digit: ${num} → ${result}`);
    return result;
  }
  
  // If in bathroom context and just a number
  const justNumber = q.match(/^(one|two|three|four|five|1|2|3|4|5)$/);
  if (justNumber) {
    const word = justNumber[1];
    const result = numberWords[word] || word;
    console.log(`[EXTRACT] Bathrooms via standalone: ${word} → ${result}`);
    return result;
  }
  
  return null;
}

function extractServiceType(text, lang) {
  const q = normalize(text);
  if (lang === "en") {
    if (q.includes("deep") || q.includes("thorough")) return "deep";
    if (q.includes("move out") || q.includes("move-out") || q.includes("moveout")) return "moveout";
    if (q.includes("airbnb") || q.includes("turnover")) return "airbnb";
    if (q.includes("standard") || q.includes("regular") || q.includes("basic")) return "standard";
  } else if (lang === "es") {
    if (q.includes("profunda") || q.includes("fondo")) return "deep";
    if (q.includes("mudanza")) return "moveout";
    if (q.includes("airbnb") || q.includes("turno")) return "airbnb";
    if (q.includes("estandar") || q.includes("basica")) return "standard";
  } else if (lang === "pt") {
    if (q.includes("profunda") || q.includes("fundo")) return "deep";
    if (q.includes("mudanca")) return "moveout";
    if (q.includes("airbnb") || q.includes("turno")) return "airbnb";
    if (q.includes("padrao") || q.includes("basica")) return "standard";
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// CONVERSATION STATE
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.state = "initial";
    this.language = null;
    this.data = {
      serviceType: null,
      bedrooms: null,
      bathrooms: null,
      city: null,
      date: null,
      time: null,
      name: null,
      phone: null,
      frequency: "onetime",
      estimatedPrice: null,
    };
  }
  
  t(key) {
    if (!this.language) return TRANSLATIONS.en[key] || "";
    return TRANSLATIONS[this.language][key] || TRANSLATIONS.en[key] || "";
  }
  
  calculatePrice() {
    if (!this.data.serviceType || !this.data.bedrooms) return null;
    const type = this.data.serviceType;
    const bathrooms = this.data.bathrooms || "1"; // Default to 1 if not specified
    const key = this.data.bedrooms === "Studio" ? "Studio" : 
                `${this.data.bedrooms}-${bathrooms}`;
    const basePrice = PRICING_MATRIX[type]?.[key];
    if (!basePrice) {
      console.log(`[PRICE] No match for ${type} ${key}`);
      return null;
    }
    const discount = FREQUENCY_DISCOUNTS[this.data.frequency] || 0;
    const finalPrice = Math.round(basePrice * (1 - discount));
    console.log(`[PRICE] ${type} ${key}: ${basePrice} - ${discount*100}% = ${finalPrice}`);
    return finalPrice;
  }
  
  hasAllBookingInfo() {
    return this.data.serviceType && this.data.bedrooms && this.data.city && 
           this.data.date && this.data.time && this.data.name && this.data.phone;
  }
  
  getSummary(includePrice = false) {
    const t = this.t("serviceTypes");
    const parts = [];
    if (this.data.serviceType) parts.push(`${t[this.data.serviceType]} ${this.language === "es" ? "limpieza" : this.language === "pt" ? "limpeza" : "clean"}`);
    if (this.data.bedrooms) {
      const br = this.data.bedrooms === "Studio" ? "studio" : `${this.data.bedrooms} ${this.language === "es" ? "habitaciones" : this.language === "pt" ? "quartos" : "bedroom"}`;
      parts.push(br);
    }
    if (this.data.bathrooms) parts.push(`${this.data.bathrooms} ${this.language === "es" ? "baños" : this.language === "pt" ? "banheiros" : "bathroom"}`);
    if (this.data.city) parts.push(`${this.language === "es" ? "en" : this.language === "pt" ? "em" : "in"} ${this.data.city}`);
    if (this.data.date && this.data.time) parts.push(`${this.language === "es" ? "el" : this.language === "pt" ? "em" : "on"} ${this.data.date} ${this.language === "es" || this.language === "pt" ? "a las" : "at"} ${this.data.time}`);
    if (includePrice && this.data.estimatedPrice) parts.push(`${this.language === "es" ? "por" : this.language === "pt" ? "por" : "for"} ${this.data.estimatedPrice}`);
    return parts.join(", ");
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// INTELLIGENT ROUTER
// ───────────────────────────────────────────────────────────────────────────────
function routeWithContext(text, ctx) {
  const q = normalize(text);
  console.log(`[ROUTE] Input: "${text}" → Normalized: "${q}"`);
  
  // Detect language on first turn
  if (!ctx.language) {
    ctx.language = detectLanguage(text);
    console.log(`[LANG] Detected: ${ctx.language}`);
  }
  
  const lang = ctx.language;
  
  // Extract entities
  const name = extractName(text);
  const phone = extractPhone(text);
  const dateTime = extractDateTime(text);
  const serviceType = extractServiceType(text, lang);
  const city = findCityInText(text);
  
  // Smart extraction based on context
  let bedrooms = null;
  let bathrooms = null;
  
  // If we're in booking flow and missing bathrooms but have bedrooms, prioritize bathroom extraction
  if (ctx.state === "booking_flow" && ctx.data.bedrooms && !ctx.data.bathrooms) {
    bathrooms = extractBathrooms(text);
    console.log(`[CONTEXT] Prioritizing bathroom extraction: ${bathrooms}`);
  } else if (ctx.state === "booking_flow" && !ctx.data.bedrooms) {
    bedrooms = extractBedrooms(text);
    console.log(`[CONTEXT] Prioritizing bedroom extraction: ${bedrooms}`);
  } else {
    // Extract both normally
    bedrooms = extractBedrooms(text);
    bathrooms = extractBathrooms(text);
  }
  
  if (name && !ctx.data.name) ctx.data.name = name;
  if (phone && !ctx.data.phone) ctx.data.phone = phone;
  if (dateTime.day && !ctx.data.date) {
    ctx.data.date = dateTime.day;
    console.log(`[DATA] Set date: ${dateTime.day}`);
  }
  if (dateTime.time && !ctx.data.time) {
    ctx.data.time = dateTime.time;
    console.log(`[DATA] Set time: ${dateTime.time}`);
  }
  if (bedrooms && !ctx.data.bedrooms) {
    ctx.data.bedrooms = bedrooms;
    console.log(`[DATA] Set bedrooms: ${bedrooms}`);
  }
  if (bathrooms && !ctx.data.bathrooms) {
    ctx.data.bathrooms = bathrooms;
    console.log(`[DATA] Set bathrooms: ${bathrooms}`);
  }
  if (serviceType && !ctx.data.serviceType) ctx.data.serviceType = serviceType;
  if (city && city.known && !ctx.data.city) ctx.data.city = city.city;
  
  if (ctx.data.serviceType && ctx.data.bedrooms && !ctx.data.estimatedPrice) {
    ctx.data.estimatedPrice = ctx.calculatePrice();
  }
  
  // PRIORITY 1: Service area queries (check FIRST before small talk)
  if (city) {
    if (city.known) {
      if (!ctx.data.city) ctx.data.city = city.city;
      // If it's explicitly a service query, confirm coverage
      if (city.isQuery) {
        console.log(`[ROUTING] Confirming service area: ${city.city}`);
        return `${ctx.t("coverCity")} ${city.city} ${ctx.t("andSurrounding")}`;
      }
      // Otherwise just note the city for booking flow
      if (ctx.state !== "booking_flow") {
        console.log(`[ROUTING] City mentioned, asking about service type`);
        return `${ctx.t("coverCity")} ${city.city}! ${lang === "es" ? "¿Qué tipo de limpieza te interesa?" : lang === "pt" ? "Que tipo de limpeza você gostaria?" : "What type of cleaning are you interested in—standard, deep, move-out, or Airbnb?"}`;
      }
    } else if (city.isQuery) {
      // Unknown city but they're asking about coverage
      console.log(`[ROUTING] Unknown city, asking for ZIP: ${city.city}`);
      return lang === "es" ? `Estamos expandiendo nuestra cobertura. ¿Cuál es el código postal de ${city.city}?` :
             lang === "pt" ? `Estamos expandindo nossa cobertura. Qual é o CEP de ${city.city}?` :
             `We're expanding our coverage. What's the ZIP code for ${city.city}? I can confirm if we serve that area.`;
    }
  }
  
  // Handle "I don't know the ZIP" when previously asked
  if ((q.includes("don't know") || q.includes("no se") || q.includes("nao sei") || q.includes("i don't know")) && 
      (q.includes("zip") || q.includes("codigo") || q.includes("cep") || q.includes("code"))) {
    console.log(`[ROUTING] User doesn't know ZIP, checking for city mentions`);
    
    // Check the current query for any city mentions (even partial like "brook")
    for (const [alias, realCity] of Object.entries(CITY_ALIASES)) {
      if (q.includes(alias)) {
        if (!ctx.data.city) ctx.data.city = realCity;
        console.log(`[ROUTING] Found city via alias in "don't know ZIP" response: ${alias} → ${realCity}`);
        return `${lang === "es" ? "No hay problema" : lang === "pt" ? "Sem problema" : "No problem"}! ${ctx.t("coverCity")} ${realCity}. ${lang === "es" ? "¿Te gustaría reservar?" : lang === "pt" ? "Gostaria de reservar?" : "Would you like to book?"}`;
      }
    }
    
    // Check if they mentioned a city we actually serve
    for (const serviceCity of SERVICE_AREAS) {
      const cityNorm = serviceCity.toLowerCase();
      if (q.includes(cityNorm) || ctx.data.city === serviceCity) {
        if (!ctx.data.city) ctx.data.city = serviceCity;
        console.log(`[ROUTING] Found known city in "don't know ZIP" response: ${serviceCity}`);
        return `${lang === "es" ? "No hay problema" : lang === "pt" ? "Sem problema" : "No problem"}! ${ctx.t("coverCity")} ${serviceCity}. ${lang === "es" ? "¿Te gustaría reservar?" : lang === "pt" ? "Gostaria de reservar?" : "Would you like to book?"}`;
      }
    }
    
    // Check history/context for city mentions
    if (ctx.data.city && SERVICE_AREAS.includes(ctx.data.city)) {
      console.log(`[ROUTING] Using city from context: ${ctx.data.city}`);
      return `${lang === "es" ? "No hay problema" : lang === "pt" ? "Sem problema" : "No problem"}! ${ctx.t("coverCity")} ${ctx.data.city}. ${lang === "es" ? "¿Te gustaría reservar?" : lang === "pt" ? "Gostaria de reservar?" : "Would you like to book?"}`;
    }
    
    console.log(`[ROUTING] No city found in context for ZIP response`);
  }
  
  // PRIORITY 2: KB questions (substantive queries)
  if (ctx.state === "initial") {
    if (q.includes("hour") || q.includes("open") || q.includes("horario")) return ctx.t("hours");
    if (q.includes("service") || q.includes("servicio") || q.includes("servico")) return ctx.t("services");
    if (q.includes("pay") || q.includes("pago") || q.includes("pagamento")) return ctx.t("payment");
    if (q.includes("supplies") || q.includes("productos") || q.includes("produtos")) return ctx.t("supplies");
    if (q.includes("how long") || q.includes("cuanto tiempo") || q.includes("quanto tempo")) return ctx.t("duration");
    if (q.includes("guarantee") || q.includes("garantia")) return ctx.t("guarantee");
    if (q.includes("cancel") || q.includes("cancelar")) return ctx.t("cancellation");
    if (q.includes("pet") || q.includes("mascota") || q.includes("animal")) return ctx.t("pets");
  }
  
  // PRIORITY 3: Small talk (ONLY if no substantive query detected AND short message)
  if (ctx.state === "initial") {
    // Check if this is ONLY small talk (short message with no other content)
    const words = q.split(" ").filter(w => w.length > 0);
    const substantiveWords = ["service", "serve", "cover", "book", "price", "cost", "clean", "hour", 
                             "servicio", "servico", "precio", "preco", "limpieza", "limpeza",
                             "brooklyn", "brookline", "brook", "cambridge", "boston"];
    const hasSubstantiveContent = words.some(w => substantiveWords.includes(w));
    
    console.log(`[SMALL TALK CHECK] Words: ${words.length}, HasSubstantive: ${hasSubstantiveContent}, Words: [${words.join(", ")}]`);
    
    // Only respond to small talk if message is short AND has no substantive content
    if (!hasSubstantiveContent && words.length <= 3) {
      if (q.includes("hi") || q.includes("hello") || q.includes("hola") || q === "ola") {
        console.log(`[SMALL TALK] Triggered greeting`);
        return ctx.t("smallTalk").hi;
      }
      if (q.includes("how are") || q.includes("como estas") || q.includes("como esta")) {
        console.log(`[SMALL TALK] Triggered how are you`);
        return ctx.t("smallTalk").howAreYou;
      }
    }
    
    // These can be longer, so check separately
    if (q.includes("who are you") || q.includes("quien eres") || q.includes("quem e")) {
      console.log(`[SMALL TALK] Triggered who are you`);
      return ctx.t("smallTalk").whoAreYou;
    }
    if (q.includes("thank") || q.includes("gracias") || q.includes("obrigad")) {
      console.log(`[SMALL TALK] Triggered thanks`);
      return ctx.t("smallTalk").thanks;
    }
    if (q.includes("bye") || q.includes("adios") || q.includes("tchau")) {
      console.log(`[SMALL TALK] Triggered bye`);
      return ctx.t("smallTalk").bye;
    }
  }
  
  // KB questions
  if (ctx.state === "initial") {
    if (q.includes("hour") || q.includes("open") || q.includes("horario")) return ctx.t("hours");
    if (q.includes("service") || q.includes("servicio") || q.includes("servico")) return ctx.t("services");
    if (q.includes("pay") || q.includes("pago") || q.includes("pagamento")) return ctx.t("payment");
    if (q.includes("supplies") || q.includes("productos") || q.includes("produtos")) return ctx.t("supplies");
    if (q.includes("how long") || q.includes("cuanto tiempo") || q.includes("quanto tempo")) return ctx.t("duration");
    if (q.includes("guarantee") || q.includes("garantia")) return ctx.t("guarantee");
    if (q.includes("cancel") || q.includes("cancelar")) return ctx.t("cancellation");
    if (q.includes("pet") || q.includes("mascota") || q.includes("animal")) return ctx.t("pets");
  }
  
  // Booking intent - handle variations
  if (ctx.state === "initial" && (
      q.includes("book") || q.includes("schedule") || q.includes("make an appointment") ||
      q.includes("reserva") || q.includes("agendar") || q.includes("marcar") ||
      q.includes("i would like to book") || q.includes("i want to book")
    )) {
    ctx.state = "booking_flow";
    if (!ctx.data.serviceType) return ctx.t("askServiceType");
  }
  
  // Handle affirmative responses to "Would you like to book?" 
  if (ctx.state === "initial" && 
      (q.includes("yes") || q.includes("yeah") || q.includes("yep") || q.includes("sure") || 
       q.includes("that would be great") || q.includes("sounds good") ||
       q.includes("si") || q.includes("sim") || q.includes("claro"))) {
    // Check if we previously mentioned booking
    if (ctx.data.city) {
      ctx.state = "booking_flow";
      return ctx.t("askServiceType");
    }
  }
  
  // Pricing
  if (q.includes("price") || q.includes("cost") || q.includes("precio") || q.includes("preco") || q.includes("cuanto")) {
    if (ctx.data.estimatedPrice) {
      return `${ctx.t("priceQuote")}${ctx.data.estimatedPrice}. ${lang === "es" ? "¿Te gustaría reservar?" : lang === "pt" ? "Gostaria de reservar?" : "Would you like to book?"}`;
    }
    if (!ctx.data.bedrooms) return ctx.t("askBedrooms");
    if (!ctx.data.serviceType) return ctx.t("askServiceType");
  }
  
  // Booking flow
  if (ctx.state === "booking_flow") {
    // Final confirmation after user says yes
    if ((q.includes("yes") || q.includes("si") || q.includes("sim") || q.includes("sounds good") || q.includes("that's correct")) && ctx.hasAllBookingInfo()) {
      const msg = lang === "es" ? `¡Perfecto! Enviaremos una confirmación a ${ctx.data.phone}. ¿Hay algo más que te gustaría saber?` :
                  lang === "pt" ? `Perfeito! Enviaremos uma confirmação para ${ctx.data.phone}. Há mais alguma coisa que você gostaria de saber?` :
                  `Perfect! We'll send a confirmation to ${ctx.data.phone}. Is there anything else you'd like to know?`;
      return msg;
    }
    
    console.log(`[BOOKING FLOW] Missing: serviceType=${!ctx.data.serviceType}, bedrooms=${!ctx.data.bedrooms}, bathrooms=${!ctx.data.bathrooms}, city=${!ctx.data.city}, date=${!ctx.data.date}, time=${!ctx.data.time}, name=${!ctx.data.name}, phone=${!ctx.data.phone}`);
    
    if (!ctx.data.serviceType) return ctx.t("askServiceType");
    if (!ctx.data.bedrooms) return ctx.t("askBedrooms");
    if (!ctx.data.bathrooms && ctx.data.bedrooms !== "Studio") return ctx.t("askBathrooms");
    if (!ctx.data.city) return ctx.t("askCity");
    
    // Calculate price silently (for later use) but don't mention it yet
    if (ctx.data.serviceType && ctx.data.bedrooms && !ctx.data.estimatedPrice) {
      ctx.data.estimatedPrice = ctx.calculatePrice();
    }
    
    if (!ctx.data.date || !ctx.data.time) {
      // DON'T mention price here - just ask for date/time naturally
      return ctx.t("askDateTime");
    }
    if (!ctx.data.name) return ctx.t("askName");
    if (!ctx.data.phone) return ctx.t("askPhone");
    
    // Final confirmation WITH price
    if (ctx.hasAllBookingInfo()) {
      const priceMsg = ctx.data.estimatedPrice ? ` ${lang === "es" ? "por alrededor de" : lang === "pt" ? "por cerca de" : "for about"} ${ctx.data.estimatedPrice}` : "";
      return `${ctx.t("confirmation")} ${ctx.getSummary()}${priceMsg}. ${ctx.t("confirmQuestion")}`;
    }
  }
  
  // Fallback: if they keep asking about service/coverage but we haven't detected a city
  if ((q.includes("service") || q.includes("cover") || q.includes("serve") || q.includes("what about")) && 
      !city && ctx.state === "initial") {
    console.log(`[ROUTING] Service query without detected city, asking for clarification`);
    return lang === "es" ? "¿En qué ciudad te encuentras?" :
           lang === "pt" ? "Em que cidade você está?" :
           "What city are you in? We serve the Greater Boston area including Brookline, Cambridge, Somerville, and more.";
  }
  
  // Generic fallback
  if (ctx.state === "initial") {
    console.log(`[ROUTING] Generic fallback`);
    return lang === "es" ? "Puedo ayudar con reservas o preguntas sobre nuestros servicios. ¿Qué te gustaría saber?" :
           lang === "pt" ? "Posso ajudar com reservas ou perguntas sobre nossos serviços. O que você gostaria de saber?" :
           "I can help with booking or questions about our services. What would you like to know?";
  }
  
  return lang === "es" ? "¿En qué más puedo ayudarte?" :
         lang === "pt" ? "Em que mais posso ajudá-lo?" :
         "What else can I help you with?";
}

// ───────────────────────────────────────────────────────────────────────────────
// Audio & TTS
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

async function ttsElevenLabsRaw(text, lang = "en") {
  const voiceId = lang === "es" ? ELEVEN_VOICE_ID_ES : lang === "pt" ? ELEVEN_VOICE_ID_PT : ELEVEN_VOICE_ID_EN;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({ text, voice_settings: { stability: 0.4, similarity_boost: 0.7 } }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText}`);
  }
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
    if (frames % 100 === 0) console.log(`[TTS] sent ${frames} frames`);
    await new Promise(r => setTimeout(r, FRAME_MS));
    offset += bytesPerFrame;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram with multi-language
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(onFinal, onAnyTranscript, lang = "en") {
  if (!DG_KEY) {
    console.warn("⚠️ DEEPGRAM_API_KEY missing — STT disabled.");
    return null;
  }
  const langCode = lang === "es" ? "es" : lang === "pt" ? "pt" : "en-US";
  const url = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&punctuate=true&language=${langCode}`;
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

  dg.on("open", () => console.log(`[DG] connected (${langCode})`));

  dg.on("message", (d) => {
    try {
      const msg = JSON.parse(d.toString());
      const alt = msg.channel?.alternatives?.[0];
      const transcript = alt?.transcript?.trim() || "";

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
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  ws._rx = 0;
  ws._speaking = false;
  ws._graceUntil = 0; // Grace period to prevent barge-in
  ws._ctx = new ConversationContext();
  ws._dgConnection = null;

  let noInputTimer = null;
  const resetNoInputTimer = () => {
    if (noInputTimer) clearTimeout(noInputTimer);
    noInputTimer = setTimeout(async () => {
      // Don't reprompt if in grace period or speaking
      if (ws._speaking || Date.now() < ws._graceUntil) return;
      
      ws._speaking = true;
      try {
        const prompt = ws._ctx.t("stillThere");
        const out = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(prompt, ws._ctx.language) : await ttsToPcm16(prompt, ws._ctx.language);
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
    // Don't process during grace period (agent just finished speaking)
    if (Date.now() < ws._graceUntil) {
      console.log("[GRACE] Ignoring input during grace period");
      return;
    }
    
    if (ws._speaking) return;
    
    // If language just detected, reconnect Deepgram
    if (!ws._ctx.language) {
      ws._ctx.language = detectLanguage(finalText);
      console.log(`[LANG] Switching to ${ws._ctx.language}`);
      if (ws._dgConnection) ws._dgConnection.close();
      ws._dgConnection = connectDeepgram(handleFinal, () => resetNoInputTimer(), ws._ctx.language);
    }
    
    console.log(`[USER] "${finalText}"`);
    const reply = routeWithContext(finalText, ws._ctx);
    console.log(`[BOT] "${reply}"`);
    console.log(`[CONTEXT] ${JSON.stringify(ws._ctx.data)}`);
    
    ws._speaking = true;
    try {
      const out = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(reply, ws._ctx.language) : await ttsToPcm16(reply, ws._ctx.language);
      await streamFrames(ws, out);
    } catch (e) {
      console.error("[TTS] reply failed:", e.message);
    } finally {
      ws._speaking = false;
      ws._graceUntil = Date.now() + POST_TTS_GRACE_MS; // Set grace period after speaking
      console.log(`[GRACE] Set until ${new Date(ws._graceUntil).toISOString()}`);
      resetNoInputTimer();
    }
  };

  ws._dgConnection = connectDeepgram(handleFinal, () => resetNoInputTimer());

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: connected`);
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid}`);

      if (MEDIA_FORMAT === "mulaw") await streamFrames(ws, makeBeepMulaw());
      else await streamFrames(ws, makeBeepPcm16());

      try {
        const text = "Hi! I'm your AI receptionist at Clean Easy. I can help with booking or answer questions. What would you like to do?";
        const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
        await streamFrames(ws, buf);
        ws._graceUntil = Date.now() + POST_TTS_GRACE_MS; // Grace period after greeting
        console.log(`[GRACE] Set after greeting until ${new Date(ws._graceUntil).toISOString()}`);
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }

      resetNoInputTimer();
    }

    if (msg.event === "media") {
      ws._rx++;
      // Only send to Deepgram if not speaking and not in grace period
      if (ws._dgConnection && ws._dgConnection.readyState === ws._dgConnection.OPEN && 
          !ws._speaking && Date.now() >= ws._graceUntil) {
        const b = Buffer.from(msg.media.payload, "base64");
        const pcm16 = inboundToPCM16(b);
        ws._dgConnection.send(pcm16);
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP`);
      if (ws._dgConnection && ws._dgConnection.readyState === ws._dgConnection.OPEN) ws._dgConnection.close();
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
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/debug/say", async (req, res) => {
  try {
    const text = (req.query.text || "This is a test.").toString();
    const lang = req.query.lang || "en";
    const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text, lang) : await ttsToPcm16(text, lang);
    res.setHeader("Content-Type", MEDIA_FORMAT === "mulaw" ? "audio/basic" : "audio/L16");
    res.send(buf);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
