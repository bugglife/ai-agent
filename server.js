import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ------------------- Basic HTTP app -------------------
const app = express();

// Simple health check so Render can hit GET /
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

// ------------------- WebSocket server -----------------
const server = app.listen(
  parseInt(process.env.PORT || "10000", 10),
  "0.0.0.0",
  () => {
    const bound = (server.address && typeof server.address === "object")
      ? `${server.address().address}:${server.address().port}`
      : server.address();
    console.log(`🚀 Server listening on ${bound}`);
  }
);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Log Twilio Call event
    if (msg.event === "connected") {
      console.log("[WS] event:", msg);
      // Optional: send a short greeting so we know outbound media works.
      // (Twilio ignores our outbound audio for track=inbound, but keeping this harmless.)
      return;
    }

    // Count inbound media frames (helps debugging)
    if (msg.event === "media" && msg.media?.payload) {
      // do nothing; just proving we receive inbound frames
      return;
    }

    // Log transcriptions (from your STT if you send them)
    if (msg.event === "transcription") {
      console.log("[STT]", msg.text);
      return;
    }
  });

  ws.on("close", (code, reason) => {
    console.log("[WS] CLOSE code=%s reason=%s", code, reason?.toString?.() || "");
  });
});
