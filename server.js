// server.js
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
const STREAM_TOKEN = process.env.STREAM_TOKEN || "supersecrettoken";

const MEDIA_FORMAT = (process.env.TWILIO_MEDIA_FORMAT || "pcm16").toLowerCase();
if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");
if (!["pcm16", "mulaw"].includes(MEDIA_FORMAT)) {
  console.warn(`⚠️ Unknown TWILIO_MEDIA_FORMAT='${MEDIA_FORMAT}', defaulting to pcm16`);
}

const ALERT_EMAIL = process.env.ALERT_EMAIL || ""; // e.g. "you@example.com"
const ALERT_SMS   = process.env.ALERT_SMS   || ""; // e.g. "+16175551234"
const TWILIO_SID  = process.env.TWILIO_SID  || "";
const TWILIO_TOKEN= process.env.TWILIO_TOKEN|| "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";

// Timing / frame sizes
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const BYTES_PER_SAMPLE_PCM16 = 2;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160 @8kHz
const BYTES_PER_FRAME_PCM16 = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE_PCM16; // 320
const BYTES_PER_FRAME_MULAW = SAMPLES_PER_FRAME * 1; // 160

// Conversational timing
const ASR_PARTIAL_PROMOTE_MS = 2000;
const NO_INPUT_FIRST_MS = 15000;
const NO_INPUT_REPROMPT_MS = 12000;
const POST_TTS_GRACE_MS = 1800;

// Optional: kill idle sockets
const MAX_IDLE_MS = 5 * 60 * 1000; // 5 min

// ───────────────────────────────────────────────────────────────────────────────
// Optional alert libraries (lazy/optional import so deploy doesn't fail)
// ───────────────────────────────────────────────────────────────────────────────
let _mailer = null;
async function getMailer() {
  if (_mailer !== null) return _mailer;
  try {
    const mod = await import("nodemailer");
    _mailer = mod.default.createTransport({ sendmail: true });
  } catch {
    console.warn("[ALERT] nodemailer not installed; email alerts disabled");
    _mailer = false;
  }
  return _mailer;
}

let _twilio = null;
async function getTwilio() {
  if (_twilio !== null) return _twilio;
  try {
    const mod = await import("twilio");
    _twilio = new mod.default(TWILIO_SID, TWILIO_TOKEN);
  } catch {
    console.warn("[ALERT] twilio not installed; SMS alerts disabled");
    _twilio = false;
  }
  return _twilio;
}

// ───────────────────────────────────────────────────────────────────────────────
// SERVICE AREAS
// ───────────────────────────────────────────────────────────────────────────────
const SERVICE_AREAS = [
  "Boston","Cambridge","Somerville","Brookline","Newton","Watertown","Arlington",
  "Belmont","Medford","Waltham","Needham","Wellesley","Dedham","Quincy"
];

// helpers for text normalization / matching
function normalize(s){ return s.toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim(); }
function findCityInText(text){
  const q = normalize(text);
  for (const city of SERVICE_AREAS){
    const c = city.toLowerCase();
    if (q.includes(c)) return { city, known:true };
  }
  const guess = (text.match(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\b/g) || [])
    .filter(w => !SERVICE_AREAS.includes(w));
  if (guess.length) return { city:guess[0], known:false };
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// COMPANY KB + SMALL TALK
// ───────────────────────────────────────────────────────────────────────────────
const KB = [
  { id:"hours", keys:["hours","open","close","time","business hours","when"],
    answer:"We’re open 8 AM to 8 PM Monday through Saturday, and 12 PM to 8 PM on Sunday." },
  { id:"address", keys:["address","location","where","located","office","storefront"],
    answer:"Clean Easy is based in the local area and we come to you. If you need a mailing address, I can text it to you." },
  { id:"phone", keys:["phone","number","call back","contact"],
    answer:"You can call or text this number anytime. I'll always be here to help." },
  { id:"services", keys:["service","services","deep clean","standard clean","move out","move-in","post construction","airbnb","office","commercial","recurring","one time"],
    answer:"We offer standard and deep cleans, move-in/move-out, short-term rental turnovers, post-construction, and office cleanings. One-time or recurring—weekly, bi-weekly, or monthly." },
  { id:"pricing", keys:["price","pricing","cost","quote","estimate","how much","rates"],
    answer:"Pricing depends on home size and condition. Deep cleans and move-out cleans take longer and are priced accordingly. I can give you a quick quote over the phone or by text." },
  { id:"supplies", keys:["supplies","bring supplies","equipment","vacuum","products","eco","green"],
    answer:"We bring all the supplies and equipment. If you prefer eco-friendly products, let us know—we’re happy to accommodate." },
  { id:"duration", keys:["how long","duration","time it takes","how many hours","finish"],
    answer:"A typical standard clean takes 2–3 hours for an average home, while deep cleans take longer. We’ll tailor it to your space." },
  { id:"guarantee", keys:["guarantee","quality","not satisfied","reclean","warranty"],
    answer:"We stand by our work. If anything was missed, let us know within 24 hours and we’ll make it right." },
  { id:"cancellation", keys:["cancel","reschedule","late fee","policy","no show"],
    answer:"No problem—please give us 24 hours’ notice to cancel or reschedule to avoid a late cancellation fee." },
  // UPDATED payment entry
  { id:"payment", keys:["pay","payment","card","cash","zelle","venmo","invoice","deposit"],
    answer:"We accept all major credit cards, amazon pay, cash app pay, affirm and klarna." },
  { id:"booking", keys:["book","appointment","schedule","availability","available","when can you come"],
    answer:"Happy to help with booking. What date and time would you like? You can say something like “Saturday at 2 PM.”" },
];

const SMALL_TALK = [
  { keys:["hi","hello","hey"], answer:"Hi there! I’m the Clean Easy assistant. How can I help—booking or any questions?" },
  { keys:["how are you","how's it going","how are u"], answer:"I’m doing well—thanks for asking! How can I help you today?" },
  { keys:["who are you","what are you","are you a robot","your name"], answer:"I’m Clean Easy’s AI receptionist. I can answer questions and help you book a cleaning." },
  { keys:["thank you","thanks","appreciate it"], answer:"You’re very welcome! Anything else I can help with?" },
  { keys:["bye","goodbye","talk later","see you"], answer:"Thanks for calling Clean Easy. Have a great day!" },
  { keys:["can you repeat","say that again","repeat that","what did you say"], answer:"Sure—let me repeat. I can help with booking or any questions. What would you like to do?" },
];

const SYNONYMS = {
  price:["pricing","cost","rate","quote","estimate"],
  book:["schedule","appointment","reserve","availability","available"],
  clean:["deep clean","standard clean","move out","move-in","turnover"],
  hours:["open","close","time"],
  where:["located","location","address"]
};

function explodeSynonyms(tokens){
  const out=new Set(tokens);
  for(const t of tokens){ const syn=SYNONYMS[t]; if(syn) syn.forEach(s=>out.add(s));}
  return [...out];
}
function scoreKB(query){
  const q=normalize(query); const qTokens=explodeSynonyms(q.split(" "));
  let best={id:null,score:0,answer:null};
  for(const item of KB){
    let s=0;
    for(const k of item.keys){
      const kNorm=normalize(k);
      if(q.includes(kNorm)) s+=2;
      for(const tk of qTokens) if(kNorm.includes(tk)) s+=0.5;
    }
    if(s>best.score) best={id:item.id,score:s,answer:item.answer};
  }
  return best;
}
function answerFromKB(text){ const best=scoreKB(text); return best.score>=2 ? best.answer : null; }

function answerSmallTalk(text){
  const q = normalize(text);
  for(const row of SMALL_TALK){
    if (row.keys.some(k => q.includes(normalize(k)))) return row.answer;
  }
  return null;
}

function replyFor(text){
  const small = answerSmallTalk(text);
  if (small) return small;
  const city = findCityInText(text);
  if (city){
    if (city.known){
      return `Yes, we serve ${city.city} and the surrounding area. Would you like to book a time?`;
    }
    return `We’re expanding our coverage. What’s the ZIP code for ${city.city}? I can confirm availability.`;
  }
  const kb = answerFromKB(text);
  if (kb) return kb;

  const q = normalize(text);
  if(q.includes("book")||q.includes("appointment")||q.includes("schedule"))
    return "Great—what date and time would you like?";
  if(q.includes("availability")||q.includes("available"))
    return "Happy to check—what date and time are you looking for?";
  return "I can help with booking and general questions. What would you like to do?";
}

// ───────────────────────────────────────────────────────────────────────────────
// Audio utils
// ───────────────────────────────────────────────────────────────────────────────
function makeBeepPcm16(ms=180,hz=950){
  const samples=Math.floor((SAMPLE_RATE*ms)/1000); const buf=Buffer.alloc(samples*BYTES_PER_SAMPLE_PCM16);
  for(let i=0;i<samples;i++){const t=i/SAMPLE_RATE; const s=Math.round(0.18*32767*Math.sin(2*Math.PI*hz*t)); buf.writeInt16LE(s,i*2);}
  return buf;
}
function linearToMulawSample(s){const BIAS=0x84,CLIP=32635; let sign=(s>>8)&0x80; if(sign)s=-s; if(s>CLIP)s=CLIP; s=s+BIAS; let exponent=7; for(let mask=0x4000;(s&mask)===0&&exponent>0;exponent--,mask>>=1){} const mantissa=(s>>(exponent+3))&0x0f; return (~(sign|(exponent<<4)|mantissa))&0xff;}
function mulawToLinearSample(u){u=~u&0xff; const sign=(u&0x80)?-1:1; const exponent=(u>>4)&0x07; const mantissa=u&0x0f; let sample=((mantissa<<3)+0x84)<<exponent; sample-=0x84; return sign*sample;}
function makeBeepMulaw(ms=180,hz=950){const pcm=makeBeepPcm16(ms,hz); const out=Buffer.alloc(pcm.length/2); for(let i=0,j=0;i<pcm.length;i+=2,j++){out[j]=linearToMulawSample(pcm.readInt16LE(i));} return out;}
function inboundToPCM16(buf){ if(MEDIA_FORMAT==="pcm16") return buf; const out=Buffer.alloc(buf.length*2); for(let i=0,j=0;i<buf.length;i++,j+=2){out.writeInt16LE(mulawToLinearSample(buf[i]),j);} return out;}
async function streamFrames(ws,raw){
  const bytesPerFrame = MEDIA_FORMAT==="mulaw"?BYTES_PER_FRAME_MULAW:BYTES_PER_FRAME_PCM16;
  let offset=0,frames=0;
  while(offset<raw.length && ws.readyState===ws.OPEN){
    const end=Math.min(offset+bytesPerFrame,raw.length);
    let frame=raw.slice(offset,end);
    if(frame.length<bytesPerFrame){const padded=Buffer.alloc(bytesPerFrame); frame.copy(padded,0); frame=padded;}
    ws.send(JSON.stringify({event:"media",streamSid:ws._streamSid,media:{payload:frame.toString("base64")}}));
    frames++; if(frames%100===0) console.log(`[TTS] sent ${frames} frames (~${(frames*FRAME_MS)/1000}s)`);
    await new Promise(r=>setTimeout(r,FRAME_MS));
    offset+=bytesPerFrame;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// TTS Safety Gate + Alerts + Cache
// ───────────────────────────────────────────────────────────────────────────────
let TTS_ENABLED = true;
let TTS_DISABLED_UNTIL = 0;
const TTS_DISABLE_WINDOW_MS = 45 * 60 * 1000; // 45 min

// token bucket: 2 req/sec, burst 4
let ttsTokens = 4;
setInterval(() => { ttsTokens = Math.min(ttsTokens + 2, 4); }, 1000);

function ttsIsEnabled() {
  if (!TTS_ENABLED && Date.now() >= TTS_DISABLED_UNTIL) TTS_ENABLED = true;
  return TTS_ENABLED;
}

async function ttsRateLimit() {
  const start = Date.now();
  while (ttsTokens <= 0) {
    await new Promise(r => setTimeout(r, 50));
    if (Date.now() - start > 5000) throw new Error("TTS rate limiter timeout");
  }
  ttsTokens -= 1;
}

async function alertFuseTrip(reason) {
  console.error(`[ALERT] TTS disabled: ${reason}`);

  if (ALERT_EMAIL) {
    try {
      const transport = await getMailer();
      if (transport) {
        await transport.sendMail({
          from: "ai-agent@server",
          to: ALERT_EMAIL,
          subject: "[ALERT] TTS Fuse Tripped",
          text: `TTS disabled for ${TTS_DISABLE_WINDOW_MS/60000} minutes.\nReason: ${reason}\nTime: ${new Date().toISOString()}`
        });
      }
    } catch (e) {
      console.error("[ALERT] email failed:", e.message);
    }
  }

  if (ALERT_SMS && TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM) {
    try {
      const client = await getTwilio();
      if (client) {
        await client.messages.create({
          body: `TTS disabled for ${TTS_DISABLE_WINDOW_MS/60000}m. Reason: ${reason}`,
          from: TWILIO_FROM,
          to: ALERT_SMS
        });
      }
    } catch (e) {
      console.error("[ALERT] sms failed:", e.message);
    }
  }
}

function disableTTS(reason) {
  TTS_ENABLED = false;
  TTS_DISABLED_UNTIL = Date.now() + TTS_DISABLE_WINDOW_MS;
  alertFuseTrip(reason);
}

function shouldRetryTTS(status, bodyText) {
  if (!status) return true;           // network
  if (status >= 500) return true;     // server
  if (status === 429) return true;    // rate limit
  if (status === 401 || status === 403) return false;
  if (bodyText && bodyText.includes("quota_exceeded")) return false;
  return false;                       // other 4xx → do not retry
}

// ---- TTS RAW (MP3) CACHE + IN-FLIGHT COALESCING ----
const TTS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const TTS_CACHE_MAX = 64;                // entries
const ttsCache = new Map();              // key -> { buf, ts }
const ttsInflight = new Map();           // key -> Promise<Buffer>

function ttsKey(text, voiceId, settings) {
  const payload = JSON.stringify([text, voiceId, settings || { stability:0.4, similarity_boost:0.7 }]);
  return payload;
}
function cacheCleanup() {
  const now = Date.now();
  for (const [k, v] of ttsCache) {
    if (now - v.ts > TTS_CACHE_TTL_MS) ttsCache.delete(k);
  }
  while (ttsCache.size > TTS_CACHE_MAX) {
    const firstKey = ttsCache.keys().next().value;
    if (firstKey) ttsCache.delete(firstKey); else break;
  }
}

// Core call to ElevenLabs, now **cached** and **coalesced**
async function ttsElevenLabsRaw(text) {
  if (!ttsIsEnabled()) throw new Error("TTS disabled by safety fuse");
  await ttsRateLimit();

  const settings = { stability:0.4, similarity_boost:0.7 };
  const key = ttsKey(text, ELEVEN_VOICE_ID, settings);
  cacheCleanup();

  const cached = ttsCache.get(key);
  if (cached && Date.now() - cached.ts <= TTS_CACHE_TTL_MS) return cached.buf;
  if (ttsInflight.has(key)) return ttsInflight.get(key);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  let attempt = 0;
  const maxRetries = 2;
  const baseDelay = 400;

  const p = (async () => {
    try {
      while (true) {
        attempt++;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "xi-api-key": ELEVEN_API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg"
          },
          body: JSON.stringify({ text, voice_settings: settings })
        });

        const status = res.status;
        const bodyText = res.ok ? "" : await res.text();
        console.log(JSON.stringify({ svc: "elevenlabs", event: "tts_attempt", status, attempt }));

        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          ttsCache.set(key, { buf, ts: Date.now() });
          cacheCleanup();
          return buf;
        }

        if (status === 401 || status === 403 || bodyText.includes("quota_exceeded")) {
          disableTTS(`status=${status}`);
          throw new Error(`ElevenLabs TTS failed: ${status} ${bodyText}`);
        }

        if (attempt > 1 + maxRetries || !shouldRetryTTS(status, bodyText)) {
          throw new Error(`ElevenLabs TTS failed (final): ${status} ${bodyText}`);
        }

        const delay = Math.round(baseDelay * Math.pow(2, attempt - 1) * (1 + Math.random()));
        await new Promise(r => setTimeout(r, delay));
      }
    } finally {
      ttsInflight.delete(key);
    }
  })();

  ttsInflight.set(key, p);
  return p;
}

async function ttsToPcm16(text){
  const input=await ttsElevenLabsRaw(text);
  console.log("[TTS] MP3 → PCM16/8k/mono");
  let out=await ffmpegTranscode(input,["-hide_banner","-nostdin","-loglevel","error","-i","pipe:0","-ac","1","-ar","8000","-f","s16le","-acodec","pcm_s16le","pipe:1"]);
  if(out.length%2!==0) out=out.slice(0,out.length-1);
  return out;
}
async function ttsToMulaw(text){
  const input=await ttsElevenLabsRaw(text);
  console.log("[TTS] MP3 → μ-law/8k/mono");
  return await ffmpegTranscode(input,["-hide_banner","-nostdin","-loglevel","error","-i","pipe:0","-ac","1","-ar","8000","-f","mulaw","-acodec","pcm_mulaw","pipe:1"]);
}

// ffmpeg transcoder
function ffmpegTranscode(inputBuf,args){
  return new Promise((resolve,reject)=>{
    const chunks=[]; const ff=spawn(ffmpegBin.path,args);
    ff.stdin.on("error",()=>{}); ff.stdout.on("data",d=>chunks.push(d));
    ff.stderr.on("data",d=>console.error("[ffmpeg]",d.toString().trim()));
    ff.on("close",code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error(`ffmpeg exited ${code}`)));
    ff.stdin.end(inputBuf);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Deepgram realtime with partial buffering + idle promotion
// ───────────────────────────────────────────────────────────────────────────────
function connectDeepgram(onFinal,onAnyTranscript){
  if(!DG_KEY){ console.warn("⚠️ DEEPGRAM_API_KEY missing — STT disabled."); return null; }
  const url=`wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&punctuate=true&vad_events=true&endpointing=true`;
  const dg=new WebSocket(url,{headers:{Authorization:`Token ${DG_KEY}`}});

  let lastPartial=""; let partialTimer=null;
  function promotePartial(reason="idle"){
    if(!lastPartial) return;
    const promoted=lastPartial.trim(); lastPartial="";
    if(partialTimer){clearTimeout(partialTimer); partialTimer=null;}
    if(promoted){ console.log(`[ASR promote:${reason}] ${promoted}`); onFinal(promoted); }
  }

  dg.on("open",()=>console.log("[DG] connected"));
  dg.on("message",(d)=>{
    try{
      const msg=JSON.parse(d.toString());
      const alt=msg.channel?.alternatives?.[0];
      const transcript=alt?.transcript?.trim()||"";

      if(transcript) onAnyTranscript?.(transcript);

      if(transcript && (msg.is_final||msg.speech_final)){
        if(partialTimer){clearTimeout(partialTimer); partialTimer=null;}
        lastPartial=""; console.log(`[ASR] ${transcript}`); onFinal(transcript); return;
      }
      if(transcript){
        lastPartial=transcript; console.log(`[ASR~] ${lastPartial}`);
        if(partialTimer) clearTimeout(partialTimer);
        partialTimer=setTimeout(()=>promotePartial("timeout"),ASR_PARTIAL_PROMOTE_MS);
      }
    }catch{}
  });
  dg.on("close",()=>{console.log("[DG] close"); promotePartial("dg_close");});
  dg.on("error",(e)=>console.error("[DG] error",e.message));
  return dg;
}

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket (Twilio <Stream> → wss://…/stream) with auth + reprompt caps
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection",(ws)=>{
  console.log("🔗 WebSocket connected");
  ws._rx=0;
  ws._speaking=false;
  ws._graceUntil=0;
  let firstTurn=true;

  let repromptCount=0;
  const MAX_REPROMPTS=3;

  let noInputTimer=null;
  const startNoInputTimer = (ms)=>{
    if(noInputTimer) clearTimeout(noInputTimer);
    noInputTimer=setTimeout(async ()=>{
      if(ws._speaking || Date.now()<ws._graceUntil) return;
      if(!ttsIsEnabled()){
        console.warn("[TTS] skipped reprompt (gate disabled)");
        startNoInputTimer(NO_INPUT_REPROMPT_MS*2);
        return;
      }
      if(repromptCount>=MAX_REPROMPTS){
        console.warn("[TTS] reprompt cap reached; no further reprompts on this connection");
        return;
      }
      ws._speaking=true;
      try{
        const prompt="Are you still there? I can help with booking or any questions.";
        const out = MEDIA_FORMAT==="mulaw"?await ttsToMulaw(prompt):await ttsToPcm16(prompt);
        repromptCount++;
        await streamFrames(ws,out);
      }catch(e){ console.error("[TTS] reprompt failed:",e.message); }
      finally{
        ws._speaking=false;
        ws._graceUntil=Date.now()+POST_TTS_GRACE_MS;
        startNoInputTimer(NO_INPUT_REPROMPT_MS);
      }
    }, ms);
  };
  const resetNoInputTimer = ()=> startNoInputTimer(firstTurn?NO_INPUT_FIRST_MS:NO_INPUT_REPROMPT_MS);

  const connectedAt = Date.now();
  const idleTicker = setInterval(()=>{
    if(Date.now() - connectedAt > MAX_IDLE_MS){
      try { ws.close(); } catch {}
    }
  }, 30000);

  const dg=connectDeepgram(
    async (finalText)=>{
      if(ws._speaking) return;
      if(Date.now()<ws._graceUntil) return;
      const reply=replyFor(finalText);
      ws._speaking=true;
      try{
        if(!ttsIsEnabled()) throw new Error("TTS disabled by safety fuse");
        const out = MEDIA_FORMAT==="mulaw"?await ttsToMulaw(reply):await ttsToPcm16(reply);
        await streamFrames(ws,out);
      }catch(e){ console.error("[TTS] reply failed:",e.message); }
      finally{
        ws._speaking=false;
        ws._graceUntil=Date.now()+POST_TTS_GRACE_MS;
        firstTurn=false;
        resetNoInputTimer();
      }
    },
    ()=>{ if(Date.now()>=ws._graceUntil) resetNoInputTimer(); }
  );

  ws.on("message", async (data)=>{
    let msg; try{ msg=JSON.parse(data.toString()); }catch{ return; }

    if(msg.event==="connected"){
      console.log(`[WS] event: connected proto=${msg.protocol} v=${msg.version}`);
    }

    if(msg.event==="start"){
      ws._streamSid=msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      if(MEDIA_FORMAT==="mulaw") await streamFrames(ws,makeBeepMulaw());
      else await streamFrames(ws,makeBeepPcm16());
      console.log("[BEEP] done.");

      try{
        console.log(`[TTS] streaming greeting as ${MEDIA_FORMAT}…`);
        if(!ttsIsEnabled()) throw new Error("TTS disabled by safety fuse");
        const text="Hi! I'm your AI receptionist at Clean Easy. I can help with booking or answer questions. What would you like to do?";
        const buf = MEDIA_FORMAT==="mulaw"?await ttsToMulaw(text):await ttsToPcm16(text);
        await streamFrames(ws,buf);
      }catch(e){ console.error("[TTS] greeting failed:",e.message); }
      finally{
        ws._graceUntil=Date.now()+POST_TTS_GRACE_MS;
        firstTurn=true;
        resetNoInputTimer();
      }
    }

    if(msg.event==="media"){
      ws._rx++;
      if(ws._rx%100===0) console.log(`[MEDIA] frames received: ${ws._rx}`);
      if(dg && dg.readyState===dg.OPEN && !ws._speaking && Date.now()>=ws._graceUntil){
        const b=Buffer.from(msg.media.payload,"base64");
        const pcm16=inboundToPCM16(b);
        dg.send(pcm16);
      }
    }

    if(msg.event==="stop"){
      console.log(`[WS] STOP (total inbound frames: ${ws._rx||0})`);
      if(dg && dg.readyState===dg.OPEN) dg.close();
      if(noInputTimer) clearTimeout(noInputTimer);
      clearInterval(idleTicker);
    }
  });

  ws.on("close",()=>{ console.log("[WS] CLOSE code=1005"); if(noInputTimer) clearTimeout(noInputTimer); clearInterval(idleTicker); });
  ws.on("error",(err)=>console.error("[WS] error",err));
});

// ───────────────────────────────────────────────────────────────────────────────
// HTTP: health + debug speak
// ───────────────────────────────────────────────────────────────────────────────
app.get("/",(_req,res)=>res.status(200).send("OK"));
app.get("/debug/say",async (req,res)=>{
  try{
    if (!ttsIsEnabled()) return res.status(503).send("TTS disabled");
    const text=(req.query.text||"This is a test.").toString();
    const buf = MEDIA_FORMAT==="mulaw"?await ttsToMulaw(text):await ttsToPcm16(text);
    res.setHeader("Content-Type", MEDIA_FORMAT==="mulaw"?"audio/basic":"audio/L16");
    res.send(buf);
  }catch(e){ res.status(500).send(e.message); }
});

// ───────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT,()=>console.log(`🚀 Server running on port ${PORT}`));
server.on("upgrade",(req,socket,head)=>{
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if(u.pathname!=="/stream") return socket.destroy();
    if (u.searchParams.get("token") !== STREAM_TOKEN) return socket.destroy();
    wss.handleUpgrade(req,socket,head,(ws)=>wss.emit("connection",ws,req));
  } catch {
    socket.destroy();
  }
});
