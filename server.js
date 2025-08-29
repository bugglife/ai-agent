import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const port = process.env.PORT || 10000;

// ----- SETTINGS -----
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // change if you like
const FRAME_SIZE = 160;                   // 20 ms of μ-law at 8kHz
const FRAME_INTERVAL_MS = 20;             // pace at 20 ms

// -------- Helpers --------

async function fetchElevenLabsUlaw(text) {
  if (!ELEVEN_API_KEY) {
    throw new Error("ELEVEN_API_KEY is missing in environment");
  }
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

  const body = {
    text,
    // Ask for u-law at 8000 Hz so we can send straight to Twilio
    output_format: "ulaw_8000",
    voice_settings: { stability: 0.5, similarity_boost: 0.5 },
  };

  console.log("[TTS] Requesting ElevenLabs", { url, output_format: body.output_format });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  console.log("[TTS] ElevenLabs status", res.status, res.statusText);

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status} ${res.statusText} :: ${txt.slice(0, 300)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  console.log("[TTS] bytes received", buf.length);
  return buf;
}

// Make buffer length a multiple of 160 bytes (20 ms frames). Pad with μ-law silence (0xFF).
function padToWholeFrames(ulawBuf) {
  const remainder = ulawBuf.length % FRAME_SIZE;
  if (remainder === 0) return ulawBuf;
  const pad = Buffer.alloc(FRAME_SIZE - remainder, 0xff);
  return Buffer.concat([ulawBuf, pad]);
}

// Send ulaw frames to Twilio at 20ms cadence
async function sendUlawFrames(ws, streamSid, ulawBuf) {
  let sent = 0;
  for (let offset = 0; offset < ulawBuf.length; offset += FRAME_SIZE) {
    const frame = ulawBuf.subarray(offset, offset + FRAME_SIZE);
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: frame.toString("base64") },
      })
    );
    sent++;
    await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
  }
  console.log("[OUT-ULAW] framesSent=", sent, `(~${sent * 20}ms)`);
}

// -------- WebSocket --------

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  let streamSid = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log("[WS] non-JSON message ignored");
      return;
    }

    const evt = msg.event;

    if (evt === "start") {
      streamSid = msg.start?.streamSid;
      console.log("[WS] START", streamSid, "| apiKeyPresent=", !!ELEVEN_API_KEY);

      try {
        const tts = await fetchElevenLabsUlaw(
          "Hi there. Your media pipeline is working."
        );
        const ulaw = padToWholeFrames(tts);
        await sendUlawFrames(ws, streamSid, ulaw);
      } catch (err) {
        console.error("[TTS error]", err.message);

        // Fallback: 2 seconds of μ-law silence so we still see frames
        const silentFrames = 100; // 100 * 20ms = 2s
        const silence = Buffer.alloc(FRAME_SIZE * silentFrames, 0xff);
        await sendUlawFrames(ws, streamSid, silence);
      }
    }

    if (evt === "media") {
      // If you want to see inbound audio flow, uncomment:
      // console.log("[IN] media bytes=", msg.media?.payload?.length || 0);
    }

    if (evt === "stop") {
      console.log("[WS] STOP");
    }
  });

  ws.on("close", () => {
    console.log("👋 WS closed");
  });

  ws.on("error", (e) => {
    console.error("[WS] error", e.message);
  });
});

// -------- HTTP --------

app.get("/", (_req, res) => {
  res.status(200).send("✅ Server is up. WebSocket endpoint: wss://<host>/stream");
});
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

const server = app.listen(port, () => {
  console.log(`🚀 HTTP listening on ${port}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
