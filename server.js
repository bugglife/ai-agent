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

  ws.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === "start") {
      console.log(`[WS] START callSid=${data.start?.callSid} streamSid=${data.start?.streamSid}`);
    } else if (data.event === "media") {
      // Comment in if you want to see traffic volume
      // console.log(`[WS] MEDIA seq=${data.media?.sequenceNumber}`);
    } else if (data.event === "stop") {
      console.log("[WS] STOP");
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] CLOSE code=${code} reason=${reason}`);
  });

  ws.on("error", (err) => {
    console.error("[WS] ERROR", err);
  });
});

httpServer.listen(PORT, () =>
  console.log(`Server running on port ${PORT} (ws path: /stream)`)
);
