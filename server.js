// server.js
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

// --- Config ---
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.STREAM_AUTH_TOKEN || ""; // optional shared secret

// --- Basic HTTP server (health endpoint) ---
const app = express();
app.get("/", (_req, res) => res.send("OK"));
const httpServer = createServer(app);

// --- WebSocket server at /stream ---
const wss = new WebSocketServer({ server: httpServer, path: "/stream" });

wss.on("connection", (ws, req) => {
  // Optional: simple shared-secret auth via query string ?token=...
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token") || "";
  if (AUTH_TOKEN && token !== AUTH_TOKEN) {
    ws.close(1008, "Unauthorized");
    return;
  }

  console.log("[WS] Client connected from", req.socket.remoteAddress);

  ws.on("message", async (msg) => {
    // Twilio sends JSON messages per the Media Streams spec
    // e.g. { event: "start" | "media" | "stop", ... }
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.warn("[WS] Non-JSON message received");
      return;
    }

    if (data.event === "start") {
      console.log(
        `[WS] Stream started: callSid=${data.start?.callSid} streamSid=${data.start?.streamSid}`
      );
      // If you plan to send audio back, you can send a "clear" or initial message here later.
    }

    if (data.event === "media") {
      // media.payload is base64-encoded audio (PCMU μ-law 8000Hz, 20ms frames by default)
      // Decode if you want to forward to STT:
      // const pcmu = Buffer.from(data.media.payload, "base64");
      // -> forward pcmu to STT (e.g., ElevenLabs/OpenAI) here
      // Keep it lightweight for now:
      // console.log(`[WS] media seq=${data.media.sequenceNumber}`);
    }

    if (data.event === "stop") {
      console.log("[WS] Stream stopped");
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] Client closed. code=${code} reason=${reason}`);
  });
});

// Start server
httpServer.listen(PORT, () =>
  console.log(`Server running on port ${PORT} (ws path: /stream)`)
);
