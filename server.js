// ==========================================
// CLEAN EASY AI RECEPTIONIST - PHONE NUMBER FIX
// ==========================================
// This version fixes all 3 phone number issues:
// 1. ✅ Accumulates partial numbers instead of replacing
// 2. ✅ Understands compound numbers (ten, twenty, thirty, etc.)
// 3. ✅ Handles chunked delivery intelligently
// ==========================================

const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

// Environment variables
const PORT = process.env.PORT || 3000;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'default-token-change-me';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Clean Easy AI Receptionist Server Running');
});

// ==========================================
// PHONE NUMBER EXTRACTION - COMPREHENSIVE FIX
// ==========================================

const NUMBER_WORDS_MAP = {
  // Single digits
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
  
  // Compound numbers (10-99)
  'ten': '10',
  'eleven': '11',
  'twelve': '12',
  'thirteen': '13',
  'fourteen': '14',
  'fifteen': '15',
  'sixteen': '16',
  'seventeen': '17',
  'eighteen': '18',
  'nineteen': '19',
  'twenty': '20',
  'thirty': '30',
  'forty': '40',
  'fifty': '50',
  'sixty': '60',
  'seventy': '70',
  'eighty': '80',
  'ninety': '90',
  
  // Common phone number patterns
  'double': 'repeat_next', // "double zero" = "00"
  'triple': 'triple_next'  // "triple five" = "555"
};

// Convert spoken numbers to digits - COMPREHENSIVE VERSION
function extractPhoneDigits(text) {
  const lower = text.toLowerCase().trim();
  let digits = '';
  
  // Split into words and process
  const words = lower.split(/[\s\-]+/);
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
    
    // Handle compound numbers like "twenty-one"
    if ((word === 'twenty' || word === 'thirty' || word === 'forty' || 
         word === 'fifty' || word === 'sixty' || word === 'seventy' || 
         word === 'eighty' || word === 'ninety') && i + 1 < words.length) {
      
      const tensDigit = NUMBER_WORDS_MAP[word];
      const onesWord = words[i + 1];
      const onesDigit = NUMBER_WORDS_MAP[onesWord];
      
      if (onesDigit && onesDigit.length === 1) {
        // Combine: "twenty one" = "21"
        const combined = (parseInt(tensDigit) + parseInt(onesDigit)).toString();
        digits += combined;
        i += 2;
        continue;
      } else {
        // Just the tens: "twenty" = "20"
        digits += tensDigit;
        i++;
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
  
  return digits;
}

// Format phone number for display
function formatPhoneNumber(digits) {
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

// Check if phone number is complete
function isPhoneNumberComplete(digits) {
  // US phone number is 10 digits
  return digits.length >= 10;
}

// ==========================================
// ENTITY EXTRACTION (unchanged from before)
// ==========================================

const SERVICE_CITIES = [
  'boston', 'cambridge', 'somerville', 'brookline', 'newton',
  'brighton', 'allston', 'jamaica plain', 'roxbury', 'dorchester',
  'charlestown', 'back bay', 'south end', 'fenway', 'kenmore'
];

function extractCity(text) {
  const lower = text.toLowerCase();
  for (const city of SERVICE_CITIES) {
    if (lower.includes(city)) {
      return city.charAt(0).toUpperCase() + city.slice(1);
    }
  }
  return null;
}

function extractDate(text) {
  const lower = text.toLowerCase();
  
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const day of days) {
    if (lower.includes(day)) {
      return day.charAt(0).toUpperCase() + day.slice(1);
    }
  }
  
  if (lower.includes('today')) return 'Today';
  if (lower.includes('tomorrow')) return 'Tomorrow';
  
  return null;
}

function extractTime(text) {
  const timePattern = /(\d{1,2})\s*(am|pm|o'clock|oclock)?/i;
  const match = text.match(timePattern);
  
  if (match) {
    let hour = parseInt(match[1]);
    const modifier = match[2] ? match[2].toLowerCase() : '';
    
    if (modifier.includes('pm') && hour < 12) hour += 12;
    if (modifier.includes('am') && hour === 12) hour = 0;
    
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    
    return `${displayHour} ${period}`;
  }
  
  return null;
}

function extractRoomCount(text) {
  const lower = text.toLowerCase();
  
  const patterns = [
    /(\d+)\s*bed/i,
    /(\d+)\s*bedroom/i,
    /(\d+)br/i,
    /(\d+)b(\d+)b/i
  ];
  
  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match) {
      return match[1] + ' bedroom';
    }
  }
  
  return null;
}

function extractAddress(text) {
  // Look for street patterns
  const streetPattern = /\d+\s+[a-z]+\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|place|pl|boulevard|blvd)/i;
  const match = text.match(streetPattern);
  
  if (match) {
    return match[0];
  }
  
  return null;
}

// ==========================================
// CONVERSATION STATE & CONTEXT
// ==========================================

const conversationState = new Map();

function initializeContext(callSid) {
  conversationState.set(callSid, {
    state: 'greeting',
    language: null,
    city: null,
    date: null,
    time: null,
    rooms: null,
    phone: '',  // Will accumulate digits
    address: null,
    lastInput: null,
    expectingPhoneNumber: false,
    expectingAddress: false
  });
}

function updateContext(callSid, updates) {
  const context = conversationState.get(callSid);
  if (context) {
    Object.assign(context, updates);
    conversationState.set(callSid, context);
  }
}

function getContext(callSid) {
  return conversationState.get(callSid) || initializeContext(callSid);
}

// ==========================================
// LANGUAGE DETECTION (Improved)
// ==========================================

function detectLanguage(text) {
  const lower = text.toLowerCase();
  
  // Spanish indicators (need 2+ Spanish words)
  const spanishWords = ['hola', 'buenos', 'dias', 'tardes', 'noches', 'gracias', 
                        'por favor', 'si', 'como', 'estas', 'hablas', 'español'];
  const spanishCount = spanishWords.filter(word => lower.includes(word)).length;
  
  // Portuguese indicators
  const portugueseWords = ['oi', 'olá', 'bom dia', 'boa tarde', 'obrigado', 
                          'por favor', 'sim', 'fala', 'português'];
  const portugueseCount = portugueseWords.filter(word => lower.includes(word)).length;
  
  if (spanishCount >= 2) return 'es';
  if (portugueseCount >= 2) return 'pt';
  
  return 'en';
}

function getVoiceId(language) {
  const voices = {
    'en': 'pNInz6obpgDQGcFmaJgB', // English voice
    'es': 'ThT5KcBeYPX3keUQqHPh', // Spanish voice
    'pt': 'yoZ06aMxZJJ28mfd3POQ'  // Portuguese voice
  };
  return voices[language] || voices['en'];
}

// ==========================================
// RESPONSE GENERATION WITH PHONE LOGIC
// ==========================================

function generateResponse(userInput, callSid) {
  const context = getContext(callSid);
  const lower = userInput.toLowerCase();
  
  console.log('[CONTEXT]', JSON.stringify(context));
  
  // Detect language on first input (and lock it)
  if (!context.language) {
    const detectedLang = detectLanguage(userInput);
    updateContext(callSid, { language: detectedLang });
    context.language = detectedLang;
    console.log(`[LANG] Detected and locked: ${detectedLang}`);
  }
  
  // ==========================================
  // PHONE NUMBER COLLECTION - THE FIX!
  // ==========================================
  
  if (context.expectingPhoneNumber) {
    const newDigits = extractPhoneDigits(userInput);
    
    if (newDigits.length > 0) {
      // ACCUMULATE instead of replace!
      context.phone += newDigits;
      updateContext(callSid, { phone: context.phone });
      
      console.log(`[PHONE] Accumulated: ${context.phone} (added ${newDigits})`);
      
      // Check if complete
      if (isPhoneNumberComplete(context.phone)) {
        const formatted = formatPhoneNumber(context.phone);
        updateContext(callSid, { 
          expectingPhoneNumber: false,
          expectingAddress: true,
          state: 'collecting_address'
        });
        
        return {
          en: `Great, I have your number as ${formatted}. What's the address?`,
          es: `Perfecto, tengo tu número como ${formatted}. ¿Cuál es la dirección?`,
          pt: `Ótimo, tenho seu número como ${formatted}. Qual é o endereço?`
        }[context.language];
      } else {
        // Not complete yet - ask for more
        const remaining = 10 - context.phone.length;
        return {
          en: `Got it. I need ${remaining} more digits.`,
          es: `Entendido. Necesito ${remaining} dígitos más.`,
          pt: `Entendi. Preciso de mais ${remaining} dígitos.`
        }[context.language];
      }
    } else {
      // Didn't understand the input
      return {
        en: "I didn't catch that. Please say the digits one at a time, like 'six one seven five five five one two three four'.",
        es: "No entendí. Por favor di los dígitos uno por uno, como 'seis uno siete cinco cinco cinco uno dos tres cuatro'.",
        pt: "Não entendi. Por favor diga os dígitos um por vez, como 'seis um sete cinco cinco cinco um dois três quatro'."
      }[context.language];
    }
  }
  
  // ==========================================
  // ADDRESS COLLECTION
  // ==========================================
  
  if (context.expectingAddress) {
    const address = extractAddress(userInput);
    
    if (address) {
      updateContext(callSid, { 
        address: address,
        state: 'confirmed',
        expectingAddress: false
      });
      
      const formatted = formatPhoneNumber(context.phone);
      
      return {
        en: `Perfect! I have your booking for ${context.date} at ${context.time} at ${address}. We'll call you at ${formatted} to confirm. Thank you for choosing Clean Easy!`,
        es: `¡Perfecto! Tengo tu reserva para ${context.date} a las ${context.time} en ${address}. Te llamaremos al ${formatted} para confirmar. ¡Gracias por elegir Clean Easy!`,
        pt: `Perfeito! Tenho sua reserva para ${context.date} às ${context.time} em ${address}. Ligaremos para ${formatted} para confirmar. Obrigado por escolher Clean Easy!`
      }[context.language];
    } else {
      return {
        en: "I need your street address. For example, '123 Main Street'.",
        es: "Necesito tu dirección. Por ejemplo, '123 Calle Principal'.",
        pt: "Preciso do seu endereço. Por exemplo, '123 Rua Principal'."
      }[context.language];
    }
  }
  
  // ==========================================
  // EXTRACT ENTITIES FROM INPUT
  // ==========================================
  
  const city = extractCity(userInput);
  const date = extractDate(userInput);
  const time = extractTime(userInput);
  const rooms = extractRoomCount(userInput);
  
  if (city) updateContext(callSid, { city });
  if (date) updateContext(callSid, { date });
  if (time) updateContext(callSid, { time });
  if (rooms) updateContext(callSid, { rooms });
  
  // ==========================================
  // CONVERSATION ROUTING
  // ==========================================
  
  // Greetings
  if (/^(hi|hello|hey|hola|oi)/i.test(lower)) {
    updateContext(callSid, { state: 'engaged' });
    return {
      en: "Hello! I'm your AI receptionist at Clean Easy. How can I help you today?",
      es: "¡Hola! Soy tu recepcionista de IA en Clean Easy. ¿Cómo puedo ayudarte hoy?",
      pt: "Olá! Sou sua recepcionista de IA na Clean Easy. Como posso ajudá-lo hoje?"
    }[context.language];
  }
  
  // Service area questions
  if (/(available|service|do you (come|clean|work))/i.test(lower)) {
    if (city) {
      return {
        en: `Yes, we service ${city}! What date and time work best for you?`,
        es: `¡Sí, damos servicio en ${city}! ¿Qué fecha y hora te viene mejor?`,
        pt: `Sim, atendemos ${city}! Que data e hora funcionam melhor para você?`
      }[context.language];
    }
    
    return {
      en: "We service the Greater Boston area including Cambridge, Somerville, Brookline, and Newton. What city are you in?",
      es: "Damos servicio en el área del Gran Boston, incluyendo Cambridge, Somerville, Brookline y Newton. ¿En qué ciudad estás?",
      pt: "Atendemos a área da Grande Boston, incluindo Cambridge, Somerville, Brookline e Newton. Em que cidade você está?"
    }[context.language];
  }
  
  // Pricing questions
  if (/(price|cost|charge|how much)/i.test(lower)) {
    return {
      en: "Our pricing depends on the size of your space. We start at $120 for a 1-bedroom and $180 for a 2-bedroom. How many bedrooms do you have?",
      es: "Nuestros precios dependen del tamaño de tu espacio. Empezamos en $120 para 1 habitación y $180 para 2 habitaciones. ¿Cuántas habitaciones tienes?",
      pt: "Nossos preços dependem do tamanho do seu espaço. Começamos em $120 para 1 quarto e $180 para 2 quartos. Quantos quartos você tem?"
    }[context.language];
  }
  
  // Hours
  if (/(hours|open|when)/i.test(lower)) {
    return {
      en: "We're available Monday through Saturday, 8 AM to 6 PM. Would you like to book a cleaning?",
      es: "Estamos disponibles de lunes a sábado, de 8 AM a 6 PM. ¿Te gustaría reservar una limpieza?",
      pt: "Estamos disponíveis de segunda a sábado, das 8h às 18h. Gostaria de agendar uma limpeza?"
    }[context.language];
  }
  
  // Booking intent
  if (/(book|schedule|appointment|reserve|cleaning)/i.test(lower)) {
    if (context.date && context.time) {
      // Have date and time, ask for phone
      updateContext(callSid, { 
        expectingPhoneNumber: true,
        state: 'collecting_phone'
      });
      
      return {
        en: `Perfect! I have you down for ${context.date} at ${context.time}. Can I get your phone number? Please say the digits one at a time.`,
        es: `¡Perfecto! Te tengo anotado para ${context.date} a las ${context.time}. ¿Puedo tener tu número de teléfono? Por favor di los dígitos uno por uno.`,
        pt: `Perfeito! Tenho você marcado para ${context.date} às ${context.time}. Posso ter seu número de telefone? Por favor, diga os dígitos um por vez.`
      }[context.language];
    } else if (!context.date || !context.time) {
      return {
        en: "Great! What date and time would work best for you?",
        es: "¡Genial! ¿Qué fecha y hora te vendría mejor?",
        pt: "Ótimo! Que data e hora funcionariam melhor para você?"
      }[context.language];
    }
  }
  
  // Affirmative responses
  if (/^(yes|yeah|yep|sure|okay|ok|si|sim)/i.test(lower)) {
    if (!context.date || !context.time) {
      return {
        en: "Great! What date and time work for you?",
        es: "¡Genial! ¿Qué fecha y hora te vienen bien?",
        pt: "Ótimo! Que data e hora funcionam para você?"
      }[context.language];
    }
  }
  
  // Date/time provided
  if (date || time) {
    if (context.date && context.time) {
      // Have both, move to phone collection
      updateContext(callSid, { 
        expectingPhoneNumber: true,
        state: 'collecting_phone'
      });
      
      return {
        en: `Perfect! I have you down for ${context.date} at ${context.time}. Can I get your phone number? Please say the digits one at a time.`,
        es: `¡Perfecto! Te tengo anotado para ${context.date} a las ${context.time}. ¿Puedo tener tu número de teléfono? Por favor di los dígitos uno por uno.`,
        pt: `Perfeito! Tenho você marcado para ${context.date} às ${context.time}. Posso ter seu número de telefone? Por favor, diga os dígitos um por vez.`
      }[context.language];
    } else if (!context.time) {
      return {
        en: `Great, ${context.date}. What time works best?`,
        es: `Genial, ${context.date}. ¿Qué hora te viene mejor?`,
        pt: `Ótimo, ${context.date}. Que hora funciona melhor?`
      }[context.language];
    }
  }
  
  // Default fallback
  return {
    en: "I can help with booking, pricing, service areas, and hours. What would you like to know?",
    es: "Puedo ayudarte con reservas, precios, áreas de servicio y horarios. ¿Qué te gustaría saber?",
    pt: "Posso ajudar com reservas, preços, áreas de atendimento e horários. O que você gostaria de saber?"
  }[context.language];
}

// ==========================================
// WEBSOCKET SERVER
// ==========================================

server.on('upgrade', (request, socket, head) => {
  console.log('\n🔗 WebSocket upgrade request received');
  
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get('token');
  
  // ⚠️ AUTHENTICATION DISABLED FOR TESTING
  console.log('⚠️  Authentication DISABLED - Accepting all connections');
  
  const wss = new WebSocket.Server({ noServer: true });
  wss.handleUpgrade(request, socket, head, (ws) => {
    handleWebSocket(ws, request);
  });
});

function handleWebSocket(ws, request) {
  console.log('[WS] Client connected');
  
  let callSid = null;
  let streamSid = null;
  let deepgramWs = null;
  let elevenWs = null;
  
  // Initialize call context
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);
      
      if (msg.event === 'start') {
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        
        console.log(`[WS] START callSid=${callSid}`);
        
        // Initialize context for this call
        initializeContext(callSid);
        
        // Connect to Deepgram for speech recognition
        deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&model=nova-2', {
          headers: { 'Authorization': `Token ${DEEPGRAM_API_KEY}` }
        });
        
        deepgramWs.on('open', () => {
          console.log('[DG] Connected to Deepgram');
        });
        
        deepgramWs.on('message', (data) => {
          const result = JSON.parse(data);
          if (result.channel?.alternatives?.[0]?.transcript) {
            const transcript = result.channel.alternatives[0].transcript.trim();
            if (transcript.length > 0) {
              console.log(`[ASR] ${transcript}`);
              handleUserInput(transcript, callSid, ws);
            }
          }
        });
        
        deepgramWs.on('error', (error) => {
          console.error('[DG] Error:', error);
        });
        
        // Send greeting
        const greeting = {
          en: "Hi! I'm your AI receptionist at Clean Easy. How can I help you?",
          es: "¡Hola! Soy tu recepcionista de IA en Clean Easy. ¿Cómo puedo ayudarte?",
          pt: "Olá! Sou sua recepcionista de IA na Clean Easy. Como posso ajudá-lo?"
        };
        
        sendToElevenLabs(greeting.en, 'en', ws, streamSid);
      }
      
      if (msg.event === 'media') {
        // Forward audio to Deepgram
        if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
          const audioBuffer = Buffer.from(msg.media.payload, 'base64');
          deepgramWs.send(audioBuffer);
        }
      }
      
      if (msg.event === 'stop') {
        console.log('[WS] STOP');
        if (deepgramWs) deepgramWs.close();
        if (elevenWs) elevenWs.close();
        conversationState.delete(callSid);
      }
      
    } catch (error) {
      console.error('[WS] Error:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    if (deepgramWs) deepgramWs.close();
    if (elevenWs) elevenWs.close();
    if (callSid) conversationState.delete(callSid);
  });
}

function handleUserInput(userInput, callSid, ws) {
  console.log(`[USER] "${userInput}"`);
  
  const response = generateResponse(userInput, callSid);
  const context = getContext(callSid);
  
  console.log(`[BOT] "${response}"`);
  
  const voiceId = getVoiceId(context.language);
  sendToElevenLabs(response, context.language, ws, null, voiceId);
}

function sendToElevenLabs(text, language, ws, streamSid, voiceId) {
  // Use provided voiceId or default to English
  const voice = voiceId || getVoiceId(language);
  
  const elevenWs = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/${voice}/stream-input?model_id=eleven_turbo_v2_5`);
  
  elevenWs.on('open', () => {
    const config = {
      text: ' ',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8
      },
      xi_api_key: ELEVEN_API_KEY
    };
    elevenWs.send(JSON.stringify(config));
    
    elevenWs.send(JSON.stringify({ text: text + ' ' }));
    elevenWs.send(JSON.stringify({ text: '' }));
  });
  
  elevenWs.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.audio) {
      ws.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: {
          payload: msg.audio
        }
      }));
    }
  });
  
  elevenWs.on('error', (error) => {
    console.error('[11L] Error:', error);
  });
}

// Start server
server.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`🔗 WebSocket endpoint: ws://localhost:${PORT}/stream`);
  console.log(`⚠️  Authentication: DISABLED (accepting all connections)`);
});
