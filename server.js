// server.js
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

const app = express();
app.get("/", (_req, res) => res.send("OK"));
const httpServer = createServer(app);

const wss = new WebSocketServer({ server: httpServer, path: "/stream" });

wss.on("connection", (ws, req) => {
  console.log("[WS] CONNECT from", req.socket.remoteAddress);
  console.log("[WS] headers:", req.headers);

  // Optional: keep the TCP socket alive
  const keepalive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 15000);

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    switch (data.event) {
      case "start": {
        console.log(
          `[WS] START callSid=${data.start?.callSid} streamSid=${data.start?.streamSid}`
        );
        break;
      }

      case "media": {
        // You’ll forward this audio to STT later:
        // const pcmu = Buffer.from(data.media.payload, "base64");

        // --- Keepalive / ack so Twilio keeps the stream open ---
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              event: "mark",
              mark: { name: `got_media_${data.media?.sequenceNumber}` },
            })
          );
        }
        break;
      }

      case "stop": {
        console.log("[WS] STOP");
        break;
      }

      default:
        // other events: mark, clear, dtmf, etc.
        break;
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(keepalive);
    console.log(`[WS] CLOSE code=${code} reason=${reason}`);
  });

  ws.on("error", (err) => {
    console.error("[WS] ERROR", err);
  });
});

httpServer.listen(PORT, () =>
  console.log(`Server running on port ${PORT} (ws path: /stream)`)
);
