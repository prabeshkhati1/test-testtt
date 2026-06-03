// ═══════════════════════════════════════════════════════════════════
// SECTION 15 — VOICE INTERACTION
//
// Append this entire block to the bottom of app.js.
//
// HOW IT WORKS:
//   1. User clicks the mic button → voice overlay opens
//   2. Browser SpeechRecognition listens → transcript shown live
//   3. When user stops speaking, transcript is sent as a chat message
//   4. While AI streams its reply, TTS is queued and played in chunks
//   5. When AI finishes, mic opens again for the next turn
//   6. User can close the overlay at any time to end the session
//
// BROWSER SUPPORT:
//   - Chrome / Edge: full support ✓
//   - Firefox: SpeechRecognition not supported (voice btn hidden automatically)
//   - Safari iOS/macOS: partial — works on iOS 14.5+, not on desktop Safari
//
// APIs USED:
//   - window.SpeechRecognition (speech-to-text) — free, no API key
//   - window.speechSynthesis   (text-to-speech) — free, no API key
// ═══════════════════════════════════════════════════════════════════


// ───────────────────────────────────────────────────────────────────
// VOICE CONFIG
//
// Tweak these to change voice behaviour.
// ───────────────────────────────────────────────────────────────────

const VOICE_CONFIG = {
  // BCP-47 language tag for speech recognition
  // 'en-US' = American English. Change to 'en-GB', 'ne-NP', etc. as needed.
  lang: "en-US",

  // How long (ms) of silence triggers auto-send after the user stops speaking.
  // The browser handles this natively via continuous recognition — this value
  // is used for our own UI timeout fallback only.
  silenceTimeoutMs: 1800,

  // TTS voice settings — browser picks the best available voice automatically.
  // You can optionally filter by voice name below in pickVoice().
  ttsRate:   1.0,   // Speaking speed: 0.5 (slow) – 2.0 (fast)
  ttsPitch:  1.0,   // Pitch: 0 (low) – 2 (high)
  ttsVolume: 1.0,   // Volume: 0–1
};


// ───────────────────────────────────────────────────────────────────
// VOICE STATE
// ───────────────────────────────────────────────────────────────────

const voiceState = {
  active:       false,   // Is voice overlay open?
  listening:    false,   // Is mic capturing right now?
  speaking:     false,   // Is TTS currently playing?
  recognition:  null,    // SpeechRecognition instance
  silenceTimer: null,    // Timeout handle for silence detection fallback
  ttsQueue:     [],      // Sentences waiting to be spoken
  currentUtter: null,    // Currently playing SpeechSynthesisUtterance
};


// ───────────────────────────────────────────────────────────────────
// DOM REFERENCES (voice-specific elements from chat.html)
// ───────────────────────────────────────────────────────────────────

const voiceBtn      = $("voiceBtn");
const voiceOverlay  = $("voiceOverlay");
const voiceOrb      = $("voiceOrb");
const voiceLabel    = $("voiceLabel");
const voiceTranscript = $("voiceTranscript");
const voiceCloseBtn = $("voiceCloseBtn");
const voiceStatus   = $("voiceStatus");


// ───────────────────────────────────────────────────────────────────
// BROWSER SUPPORT CHECK
//
// If the browser doesn't support SpeechRecognition, hide the button
// and bail out — no errors, no broken UI.
// ───────────────────────────────────────────────────────────────────

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

if (!SpeechRecognition) {
  // Hide the mic button gracefully
  if (voiceBtn) voiceBtn.style.display = "none";
  console.info("[voice] SpeechRecognition not supported in this browser. Voice button hidden.");
}


// ───────────────────────────────────────────────────────────────────
// TTS HELPERS
// ───────────────────────────────────────────────────────────────────

/**
 * pickVoice()
 * Tries to pick a good English voice from the browser's available list.
 * Returns the best match, or null (browser picks its default).
 */
function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  // Prefer a local (non-remote) English voice for lower latency
  const preferred = voices.find(
    (v) => v.lang.startsWith("en") && v.localService
  );
  // Fall back to any English voice
  const fallback = voices.find((v) => v.lang.startsWith("en"));

  return preferred || fallback || null;
}

/**
 * splitIntoSentences(text)
 * Splits a text string into natural sentence-length chunks for TTS.
 * This lets us start speaking the first sentence while the rest streams in.
 */
function splitIntoSentences(text) {
  // Split on sentence-ending punctuation followed by a space or end of string
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * speakText(text)
 * Speaks a single string via browser TTS.
 * Calls back when finished so we can chain sentences.
 */
function speakText(text, onEnd) {
  if (!text || !window.speechSynthesis) {
    onEnd?.();
    return;
  }

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang   = VOICE_CONFIG.lang;
  utter.rate   = VOICE_CONFIG.ttsRate;
  utter.pitch  = VOICE_CONFIG.ttsPitch;
  utter.volume = VOICE_CONFIG.ttsVolume;

  const voice = pickVoice();
  if (voice) utter.voice = voice;

  utter.onend   = () => onEnd?.();
  utter.onerror = () => onEnd?.(); // On error just move on

  voiceState.currentUtter = utter;
  window.speechSynthesis.speak(utter);
}

/**
 * stopSpeaking()
 * Cancels any in-progress TTS and clears the queue.
 */
function stopSpeaking() {
  window.speechSynthesis.cancel();
  voiceState.ttsQueue   = [];
  voiceState.currentUtter = null;
  voiceState.speaking   = false;
}

/**
 * flushTTSQueue()
 * Speaks queued sentences one by one.
 * Called whenever a new sentence is added to the queue.
 */
function flushTTSQueue() {
  if (voiceState.speaking) return;      // Already draining — do nothing
  if (!voiceState.ttsQueue.length) return;

  voiceState.speaking = true;
  setOrbState("speaking");
  setVoiceLabel("Speaking…");

  function speakNext() {
    if (!voiceState.ttsQueue.length || !voiceState.active) {
      // Queue drained or session ended
      voiceState.speaking = false;

      if (voiceState.active) {
        // Auto-restart listening after AI finishes speaking
        startListening();
      }
      return;
    }

    const sentence = voiceState.ttsQueue.shift();
    speakText(sentence, speakNext);
  }

  speakNext();
}


// ───────────────────────────────────────────────────────────────────
// UI STATE HELPERS
// ───────────────────────────────────────────────────────────────────

/**
 * setOrbState(state)
 * Updates the visual orb in the overlay.
 * state: "idle" | "listening" | "speaking" | "processing"
 */
function setOrbState(state) {
  if (!voiceOrb) return;
  voiceOrb.className = "voice-orb"; // Reset
  if (state !== "idle") voiceOrb.classList.add(state);
}

/**
 * setVoiceLabel(text)
 * Updates the text label below the orb in the overlay.
 */
function setVoiceLabel(text) {
  if (voiceLabel) voiceLabel.textContent = text;
}

/**
 * setVoiceStatusBar(text, type)
 * Updates the small status line in the input-meta row (below the text box).
 * type: "" | "active" | "speaking" | "error"
 */
function setVoiceStatusBar(text, type = "") {
  if (!voiceStatus) return;
  voiceStatus.textContent = text;
  voiceStatus.className   = "voice-status" + (type ? ` ${type}` : "");
}


// ───────────────────────────────────────────────────────────────────
// SPEECH RECOGNITION
// ───────────────────────────────────────────────────────────────────

/**
 * startListening()
 * Creates a fresh SpeechRecognition session and starts capturing.
 * Each call creates a new instance — reusing one instance across
 * starts/stops leads to browser-specific bugs.
 */
function startListening() {
  if (!SpeechRecognition || !voiceState.active) return;
  if (voiceState.listening) return; // Already listening

  // Stop any in-progress TTS before mic opens (prevents feedback loop)
  stopSpeaking();

  const recognition = new SpeechRecognition();
  recognition.lang            = VOICE_CONFIG.lang;
  recognition.continuous      = false; // Single utterance per session (more reliable)
  recognition.interimResults  = true;  // Show words as they're heard
  recognition.maxAlternatives = 1;

  voiceState.recognition = recognition;
  voiceState.listening   = true;

  setOrbState("listening");
  setVoiceLabel("Listening…");
  setVoiceStatusBar("🔴 Listening", "active");
  if (voiceBtn) voiceBtn.classList.add("recording");

  let finalTranscript = "";

  // ── Live interim transcript ─────────────────────────────────────
  recognition.onresult = (event) => {
    let interim = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript + " ";
      } else {
        interim += result[0].transcript;
      }
    }

    // Show live transcript in overlay
    if (voiceTranscript) {
      voiceTranscript.textContent = (finalTranscript + interim).trim();
    }

    // Reset silence timer on every new word
    clearTimeout(voiceState.silenceTimer);
    voiceState.silenceTimer = setTimeout(() => {
      recognition.stop(); // Trigger onend → sends message
    }, VOICE_CONFIG.silenceTimeoutMs);
  };

  // ── Recognition ended ──────────────────────────────────────────
  recognition.onend = () => {
    voiceState.listening = false;
    clearTimeout(voiceState.silenceTimer);
    if (voiceBtn) voiceBtn.classList.remove("recording");

    const text = finalTranscript.trim();

    if (!text || !voiceState.active) {
      // Nothing heard or session was closed — go back to listening
      if (voiceState.active && !voiceState.speaking) {
        setTimeout(startListening, 400);
      }
      return;
    }

    // ── Submit the transcript as a chat message ─────────────────
    setOrbState("processing");
    setVoiceLabel("Thinking…");
    setVoiceStatusBar("⏳ Processing", "");
    if (voiceTranscript) voiceTranscript.textContent = `"${text}"`;

    // Put the transcript into the textarea and send it
    // sendVoiceMessage() handles the actual API call + TTS pipeline
    sendVoiceMessage(text);
  };

  // ── Errors ─────────────────────────────────────────────────────
  recognition.onerror = (event) => {
    voiceState.listening = false;
    clearTimeout(voiceState.silenceTimer);
    if (voiceBtn) voiceBtn.classList.remove("recording");

    if (event.error === "no-speech") {
      // Silence timeout — just restart listening
      if (voiceState.active && !voiceState.speaking) {
        setTimeout(startListening, 300);
      }
      return;
    }

    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      setVoiceLabel("Microphone access denied");
      setVoiceStatusBar("Mic blocked — check browser permissions", "error");
      // Don't auto-restart — user needs to fix permissions
      return;
    }

    // Other errors — log and restart
    console.warn("[voice] SpeechRecognition error:", event.error);
    if (voiceState.active && !voiceState.speaking) {
      setTimeout(startListening, 500);
    }
  };

  try {
    recognition.start();
  } catch (err) {
    // Can throw if called too quickly after a previous stop
    voiceState.listening = false;
    console.warn("[voice] recognition.start() threw:", err);
    if (voiceState.active) setTimeout(startListening, 600);
  }
}

/**
 * stopListening()
 * Stops the current recognition session without processing results.
 */
function stopListening() {
  clearTimeout(voiceState.silenceTimer);
  if (voiceState.recognition) {
    try { voiceState.recognition.abort(); } catch (_) {}
    voiceState.recognition = null;
  }
  voiceState.listening = false;
  if (voiceBtn) voiceBtn.classList.remove("recording");
}


// ───────────────────────────────────────────────────────────────────
// VOICE MESSAGE SEND + TTS PIPELINE
//
// This replaces the normal sendMessage() flow for voice mode.
// Key difference: instead of rendering the AI reply only in the chat,
// we also stream it into the TTS queue sentence by sentence.
// ───────────────────────────────────────────────────────────────────

/**
 * sendVoiceMessage(text)
 * Sends a voice transcript as a chat message and pipes the AI's
 * streaming reply into the TTS queue in real time.
 */
async function sendVoiceMessage(text) {
  if (isWaiting) return;

  const model = getSelectedModel();
  if (!model) return;

  // Hide empty state
  const emptyState = $("emptyState");
  if (emptyState) emptyState.style.display = "none";

  // Add to conversation and render in chat (same as normal send)
  conversationHistory.push({ role: "user", content: text });
  appendMessage("user", text);

  isWaiting = true;
  syncSendBtn();

  const typingEl = appendTyping();

  let streamedText  = "";
  let replyElements = null;

  // Tracks the text that has already been pushed into the TTS queue,
  // so we only queue new complete sentences as they arrive.
  let ttsProcessed = "";

  /**
   * tryQueueNewSentences(fullText, isFinal)
   * Looks at the portion of fullText not yet queued for TTS,
   * extracts complete sentences, and adds them to the queue.
   * If isFinal is true, queues whatever remains (no need for a full sentence).
   */
  function tryQueueNewSentences(fullText, isFinal) {
    const unprocessed = fullText.slice(ttsProcessed.length);
    if (!unprocessed) return;

    if (isFinal) {
      // Queue everything left
      const remaining = unprocessed.trim();
      if (remaining) {
        voiceState.ttsQueue.push(remaining);
        ttsProcessed = fullText;
        flushTTSQueue();
      }
      return;
    }

    // Queue complete sentences only (ends with . ! ?)
    const sentences = splitIntoSentences(unprocessed);
    if (sentences.length < 2) return; // Last element is likely incomplete

    // All but the last are definitely complete
    const complete = sentences.slice(0, -1);
    complete.forEach((s) => {
      voiceState.ttsQueue.push(s);
    });

    // Advance the processed pointer
    const queued = complete.join(" ") + " ";
    ttsProcessed += queued;
    flushTTSQueue();
  }

  await callAPIStreaming({
    model:    model.id,
    messages: conversationHistory,

    onChunk: (chunk) => {
      streamedText += chunk;

      if (!replyElements) {
        if (typingEl) typingEl.remove();
        replyElements = appendMessage("ai", "");
      }

      if (replyElements?.textEl) {
        replyElements.textEl.innerHTML = renderMarkdown(streamedText);
        replyElements.textEl.classList.add("streaming-cursor");
        scrollBottom();
      }

      // Try to queue newly completed sentences for TTS
      tryQueueNewSentences(streamedText, false);
    },

    onDone: (totalTokens) => {
      if (replyElements?.textEl) {
        replyElements.textEl.classList.remove("streaming-cursor");
      }
      if (!replyElements && typingEl) typingEl.remove();

      if (streamedText) {
        conversationHistory.push({ role: "assistant", content: streamedText });
        // Queue any remaining text that didn't end in punctuation
        tryQueueNewSentences(streamedText, true);
      }

      if (totalTokens !== null && tokenCounter) {
        totalTokensUsed += totalTokens;
        tokenCounter.textContent = `${totalTokensUsed.toLocaleString()} tokens used`;
      }

      saveToStorage();

      isWaiting = false;
      syncSendBtn();

      // Voice mode: don't refocus textarea — TTS will play, then mic restarts
    },

    onError: (errMsg) => {
      if (replyElements?.textEl) {
        replyElements.textEl.classList.remove("streaming-cursor");
      }
      if (typingEl) typingEl.remove();
      if (replyElements?.wrap) replyElements.wrap.remove();

      conversationHistory.pop();
      showError(errMsg || "Something went wrong.");

      isWaiting = false;
      syncSendBtn();

      // On error in voice mode, restart listening after a short pause
      if (voiceState.active) {
        setVoiceLabel("Something went wrong. Listening again…");
        setTimeout(startListening, 1500);
      }
    },
  });
}


// ───────────────────────────────────────────────────────────────────
// VOICE SESSION OPEN / CLOSE
// ───────────────────────────────────────────────────────────────────

/**
 * openVoiceSession()
 * Shows the overlay, requests mic permission, starts listening.
 */
function openVoiceSession() {
  if (!SpeechRecognition) return;

  voiceState.active = true;
  if (voiceOverlay)  {
    voiceOverlay.classList.add("active");
    voiceOverlay.setAttribute("aria-hidden", "false");
  }
  if (voiceBtn) voiceBtn.classList.add("speaking"); // Highlight mic btn

  setVoiceStatusBar("Voice mode on", "active");
  if (voiceTranscript) voiceTranscript.textContent = "";

  // Small delay so overlay animation completes before mic dialog appears
  setTimeout(startListening, 300);
}

/**
 * closeVoiceSession()
 * Stops everything and hides the overlay.
 */
function closeVoiceSession() {
  voiceState.active = false;

  stopListening();
  stopSpeaking();

  if (voiceOverlay) {
    voiceOverlay.classList.remove("active");
    voiceOverlay.setAttribute("aria-hidden", "true");
  }
  if (voiceBtn) {
    voiceBtn.classList.remove("recording", "speaking");
  }

  setOrbState("idle");
  setVoiceLabel("Listening…");
  setVoiceStatusBar("");
  if (voiceTranscript) voiceTranscript.textContent = "";

  // Return focus to the text input
  if (messageInput) messageInput.focus();
}


// ───────────────────────────────────────────────────────────────────
// VOICE EVENT LISTENERS
// ───────────────────────────────────────────────────────────────────

// Mic button — toggles voice session
if (voiceBtn && SpeechRecognition) {
  voiceBtn.addEventListener("click", () => {
    if (voiceState.active) {
      closeVoiceSession();
    } else {
      openVoiceSession();
    }
  });
}

// Close button inside the overlay
if (voiceCloseBtn) {
  voiceCloseBtn.addEventListener("click", closeVoiceSession);
}

// Escape key closes voice overlay
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && voiceState.active) {
    closeVoiceSession();
  }
});

// If the user speaks (types) normally while voice is open, close voice mode
// so the two input paths don't conflict.
if (messageInput) {
  messageInput.addEventListener("focus", () => {
    if (voiceState.active) closeVoiceSession();
  });
}

// Voices can load asynchronously in some browsers — warm up the list now
// so pickVoice() has voices ready when first needed.
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices(); // Trigger the load
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    window.speechSynthesis.getVoices(); // Cache them
  });
}
