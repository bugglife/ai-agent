wss.on("connection", (ws) => {
  console.log("🔗 WebSocket connected");
  initDM(ws); // <-- NEW

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log(`[WS] event: { event: 'connected', protocol: '${msg.protocol}', version: '${msg.version}' }`);
    }

    if (msg.event === "start") {
      ws._streamSid = msg.start?.streamSid;
      console.log(`[WS] START callSid=${msg.start?.callSid} streamSid=${ws._streamSid}`);

      try {
        // Beep in chosen format
        if (MEDIA_FORMAT === "mulaw") {
          await streamFrames(ws, makeBeepMulaw(180, 950));
        } else {
          await streamFrames(ws, makeBeepPcm16(180, 950));
        }
        console.log("[BEEP] done.");

        // Greeting (unchanged)
        console.log(`[TTS] streaming greeting as ${MEDIA_FORMAT}…`);
        const text = "Hi! I'm your AI receptionist at Clean Easy. How can I help you today?";
        const buf = MEDIA_FORMAT === "mulaw" ? await ttsToMulaw(text) : await ttsToPcm16(text);
        await streamFrames(ws, buf);
        console.log("[TTS] done.");
      } catch (e) {
        console.error("[TTS] greeting failed:", e.message);
      }
    }

    // ⬇️ NEW: catch ASR transcripts from different shapes
    if (msg.event === "media") {
      ws._rx = (ws._rx || 0) + 1;
      if (ws._rx % 100 === 0) console.log(`[MEDIA] frames received: ${ws._rx}`);
    }

    // Deepgram/Twilio transcript envelopes vary. Try several fields:
    const dgAlt = msg?.speech?.alternatives?.[0];
    const dgText = dgAlt?.transcript;
    const dgFinal = msg?.speech?.is_final ?? dgAlt?.confidence !== undefined ? msg?.speech?.is_final : undefined;

    const genericText = msg?.transcript || msg?.text || msg?.asr;
    const genericFinal = msg?.is_final ?? msg?.final ?? false;

    const textCandidate = dgText || genericText;
    const isFinal = (dgFinal !== undefined) ? dgFinal : genericFinal;

    if (textCandidate) {
      handleTranscript(ws, textCandidate, !!isFinal); // <-- FEED the DM
    }

    if (msg.event === "stop") {
      console.log(`[WS] STOP (total inbound frames: ${ws._rx || 0})`);
    }
  });

  ws.on("close", () => {
    if (ws._dm?._debounceTimer) clearTimeout(ws._dm._debounceTimer);
    console.log("[WS] CLOSE code=1005 reason=");
  });
  ws.on("error", (err) => console.error("[WS] error", err));
});
