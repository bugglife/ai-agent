import express from "express";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
if (!ELEVEN_API_KEY) console.error("❌ ELEVEN_API_KEY is not set");

// ── Twilio media format ─────────────────────────────────────────────────────────
const SAMPLE_RATE = 8000;           // 8 kHz
const BYTES_PER_SAMPLE = 2;         // 16-bit PCM
const FRAME_MS = 20;                // 20 ms frames
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS; // 160
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 320
const SILENCE_FRAME_B64 = Buffer.alloc(BYTES_PER_FRAME).toString("base64");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Stream PCM back to Twilio in 20ms frames ───────────────────────────────────
async function streamPcmFrames(ws, pcmBuffer) {
  let offset = 0, frames = 0;
  while (offset < pcmBuffer.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const slice = pcmBuffer.slice(offset, end);

    // pad final partial frame
    const payload = (slice.length < BYTES_PER_FRAME)
      ? Buffer.concat([slice, Buffer.alloc(BYTES_PER_FRAME - slice.length)]).toString("base64")
      : slice.toString("base64");

    ws.send(JSON.stringify({ event: "media", media: { payload } }));
    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS)/1000}s)`);
    }
    await sleep(FRAME_MS);
    offset += BYTES_PER_FRAME;
  }
}

// ── Keepalive (FIXED: token method, no TDZ) ─────────────────────────────────────
const keepaliveLoops = new WeakMap();

function stopKeepalive(ws) {
  keepaliveLoops.delete(ws);
}

function startKeepalive(ws) {
  stopKeepalive(ws);
  const token = {};                    // unique token for this loop
  keepaliveLoops.set(ws, token);

  (async () => {
    let frames = 0;
    while (ws.readyState === ws.OPEN && keepaliveLoops.get(ws) === token) {
      ws.send(JSON.stringify({ event: "media", media: { payload: SILENCE_FRAME_B64 } }));
      frames++;
      if (frames % 200 === 0) {
        console.log(`[KEEPALIVE] sent ${frames} silence frames (~${(frames*FRAME_MS)/1000}s)`);
      }
      await sleep(FRAME_MS);
    }
  })().catch(() => {});
}

// ── ElevenLabs TTS (8 kHz PCM) ─────────────────────────────────────────────────
async function ttsElevenLabsPcm8k(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/pcm",
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
      output_format: "pcm_8000",
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── ElevenLabs STT (scribe_v1) ─────────────────────────────────────────────────
function pcmToWav(pcm, sampleRate = SAMPLE_RATE, channels = 1, bytesPerSample = BYTES_PER_SAMPLE) {
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const wav = Buffer.alloc(44 + pcm.length);

  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);

  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);                // PCM chunk size
  wav.writeUInt16LE(1, 20);                 // PCM format
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);

  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);

  return wav;
}

async function sttElevenLabsScribeV1(wavBuffer) {
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "speech.wav");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_API_KEY },
    body: form,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ElevenLabs STT failed: ${res.status} ${res.statusText} ${t}`);
  }
  const json = await res.json();
  return json.text || "";
}

// ── Simple VAD/utterance assembler ─────────────────────────────────────────────
class UtteranceAssembler {
  constructor() {
    this.buffer = [];
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
  }
  pushFrame(frameBuf) {
    this.buffer.push(frameBuf);

    // RMS energy
    let sum = 0;
    for (let i = 0; i < frameBuf.length; i += 2) {
      const s = frameBuf.readInt16LE(i) / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / (frameBuf.length / 2));
    const isSpeech = rms > 0.01; // tweak as needed

    if (isSpeech) {
      this.speaking = true;
      this.speechMs += FRAME_MS;
      this.silenceMs = 0;
    } else if (this.speaking) {
      this.silenceMs += FRAME_MS;
    }

    const minSpeechMs = 500;  // ≥0.5s of speech
    const gapMs       = 700;  // 0.7s trailing silence ends utterance

    if (this.speaking && this.speechMs >= minSpeechMs && this.silenceMs >= gapMs) {
      const pcm = Buffer.concat(this.buffer);
      this.buffer = [];
      this.speaking = false;
      this.speechMs = 0;
      this.silenceMs = 0;
      return pcm;
    }

    // trim idle buffers
    if (!this.speaking && this.buffer.length > 300) this.buffer = [];
    return null;
  }
}

// ── WebSocket server (/stream) ─────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  const vad = new UtteranceAssembler();

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${msg.start?.streamSid} bidi=${msg.start?.bidirectional}`);

      try {
        console.log("[TTS] sending greeting (TTS) …");
        const greet = await ttsElevenLabsPcm8k("Hi! I’m your AI receptionist. How can I help you today?");
        await streamPcmFrames(ws, greet);
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      } finally {
        if (ws.readyState === ws.OPEN) startKeepalive(ws);
      }
    }

    if (msg.event === "media") {
      ws._rxCount = (ws._rxCount || 0) + 1;
      if (ws._rxCount % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rxCount}`);

      const pcmFrame = Buffer.from(msg.media.payload, "base64");
      const utterance = vad.pushFrame(pcmFrame);

      if (utterance) {
        try {
          stopKeepalive(ws);
          const wav = pcmToWav(utterance);
          const text = await sttElevenLabsScribeV1(wav);
          console.log(`[STT] "${text}"`);

          const reply = text
            ? `Got it. You said: ${text}`
            : "Sorry, I didn't catch that. Could you repeat?";
          const tts = await ttsElevenLabsPcm8k(reply);
          await streamPcmFrames(ws, tts);
        } catch (e) {
          console.error("[STT/TTS] error:", e.message);
        } finally {
          if (ws.readyState === ws.OPEN) startKeepalive(ws);
        }
      }
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rxCount || 0})`);
    }
  });

  ws.on("close", () => {
    stopKeepalive(ws);
    console.log("[WS] CLOSE code=1005 reason=");
  });

  ws.on("error", (err) => {
    stopKeepalive(ws);
    console.error("[WS] error", err);
  });
});

// HTTP + upgrade
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

app.get("/", (_req, res) => res.status(200).send("OK"));
