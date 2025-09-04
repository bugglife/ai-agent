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

// ── Small helpers ───────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function streamPcmFrames(ws, pcmBuffer) {
  let offset = 0, frames = 0;
  while (offset < pcmBuffer.length && ws.readyState === ws.OPEN) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const slice = pcmBuffer.slice(offset, end);

    // pad last partial frame with silence
    let payload;
    if (slice.length < BYTES_PER_FRAME) {
      const pad = Buffer.alloc(BYTES_PER_FRAME);
      slice.copy(pad, 0);
      payload = pad.toString("base64");
    } else {
      payload = slice.toString("base64");
    }

    ws.send(JSON.stringify({ event: "media", media: { payload } }));
    frames++;
    if (frames % 100 === 0) {
      console.log(`[TTS] sent ${frames} frames (~${(frames * FRAME_MS)/1000}s)`);
    }
    await sleep(FRAME_MS);
    offset += BYTES_PER_FRAME;
  }
}

// Keep the stream alive while idle
let keepaliveLoops = new WeakMap();
async function startKeepalive(ws) {
  // stop any previous loop
  stopKeepalive(ws);
  const loop = (async () => {
    let frames = 0;
    while (ws.readyState === ws.OPEN && keepaliveLoops.get(ws) === loop) {
      ws.send(JSON.stringify({ event: "media", media: { payload: SILENCE_FRAME_B64 } }));
      frames++;
      if (frames % 200 === 0) {
        console.log(`[KEEPALIVE] sent ${frames} silence frames (~${(frames*FRAME_MS)/1000}s)`);
      }
      await sleep(FRAME_MS);
    }
  })();
  keepaliveLoops.set(ws, loop);
}
function stopKeepalive(ws) { keepaliveLoops.delete(ws); }

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
// We send a short WAV wrapper around the PCM so the API knows format.
function pcmToWav(pcm, sampleRate = SAMPLE_RATE, numChannels = 1, bytesPerSample = BYTES_PER_SAMPLE) {
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const wav = Buffer.alloc(44 + pcm.length);

  // RIFF header
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);

  // fmt chunk
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);            // PCM chunk size
  wav.writeUInt16LE(1, 20);             // PCM format
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);

  // data chunk
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);

  return wav;
}

async function sttElevenLabsScribeV1(wavBuffer) {
  // Uses native FormData in Node 18+ via undici (node-fetch doesn’t export it).
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
  // Response commonly: { text: "...", ... }
  return json.text || "";
}

// ── Utterance segmentation (very simple VAD) ───────────────────────────────────
// We compute RMS energy per frame and detect speech when above threshold.
// End utterance when we've seen at least minSpeechMs and then silenceGapMs.
class UtteranceAssembler {
  constructor() {
    this.buffer = [];
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
  }
  // returns Buffer when an utterance completes; otherwise null
  pushFrame(frameBuf) {
    this.buffer.push(frameBuf);
    const rms = this._rms(frameBuf);
    const isSpeech = rms > 0.01; // tweak threshold as needed

    if (isSpeech) {
      this.speaking = true;
      this.speechMs += FRAME_MS;
      this.silenceMs = 0;
    } else {
      if (this.speaking) this.silenceMs += FRAME_MS;
    }

    const minSpeechMs = 500;   // at least 0.5s of speech
    const silenceGapMs = 700;  // consider end after 0.7s of silence

    if (this.speaking && this.speechMs >= minSpeechMs && this.silenceMs >= silenceGapMs) {
      // utterance done
      const pcm = Buffer.concat(this.buffer);
      this.buffer = [];
      this.speaking = false;
      this.speechMs = 0;
      this.silenceMs = 0;
      return pcm;
    }

    // reset if too long without strong energy (avoid runaway buffers)
    if (!this.speaking && this.buffer.length > 300) { // ~6s idle
      this.buffer = [];
    }
    return null;
  }
  _rms(buf) {
    // 16-bit little-endian PCM mono
    let sum = 0;
    for (let i = 0; i < buf.length; i += 2) {
      const sample = buf.readInt16LE(i) / 32768;
      sum += sample * sample;
    }
    const mean = sum / (buf.length / 2);
    return Math.sqrt(mean);
  }
}

// ── WebSocket server (Twilio <Connect><Stream> to /stream) ─────────────────────
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
        // (Optional) short alignment probe
        console.log("[TTS] sending 1 kHz test tone (1.0s) …");
        await streamPcmFrames(ws, Buffer.alloc(SAMPLE_RATE * BYTES_PER_SAMPLE)); // 1s silence probe

        console.log("[TTS] sending greeting (TTS) …");
        const greet = await ttsElevenLabsPcm8k("Hi! I’m your AI receptionist. How can I help you today?");
        await streamPcmFrames(ws, greet);

        // start keepalive while we wait for speech
        startKeepalive(ws);
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    if (msg.event === "media") {
      // Inbound 20ms frame from caller (base64 8k/16-bit/mono)
      ws._rxCount = (ws._rxCount || 0) + 1;
      if (ws._rxCount % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rxCount}`);

      const pcmFrame = Buffer.from(msg.media.payload, "base64");

      // feed VAD
      const utterancePcm = vad.pushFrame(pcmFrame);
      if (utterancePcm) {
        // We got a full utterance — STT -> TTS
        try {
          stopKeepalive(ws); // avoid double audio
          const wav = pcmToWav(utterancePcm, SAMPLE_RATE, 1, BYTES_PER_SAMPLE);
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
          // go back to idle keepalive
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
