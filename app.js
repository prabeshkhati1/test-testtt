"use strict";

// ═══════════════════════════════════════════════════════════════════
// app.js — PrabeshGPT Frontend Logic
//
// This file runs in the browser (on chat.html).
// It does NOT contain any API keys — those live in api/chat.js.
//
// WHAT THIS FILE DOES:
//   1. Populates the model dropdown from the MODELS list
//   2. Lets the user type a message and hit Send
//   3. Sends the message to our backend proxy (/api/chat)
//   4. Reads the streaming response and shows text as it arrives
//   5. Saves the conversation to localStorage so it survives a refresh
//   6. Shows a copy button on each AI message bubble
//
// SECURITY CHANGES vs original:
//   [1] clientSecret removed — it was visible to anyone in DevTools.
//       The server now uses CORS + origin checks + rate limiting instead.
//   [2] systemPrompt removed — it now lives only in api/chat.js on the
//       server, so users can't read or tamper with it.
//   [3] baseURL is no longer sent to the server — the server derives it
//       from the model ID via its own whitelist. Prevents SSRF.
//   [4] AI message HTML is sanitised with DOMPurify before being written
//       to innerHTML, preventing XSS from malicious markdown content.
//       Requires DOMPurify to be loaded in chat.html (see comment below).
// ═══════════════════════════════════════════════════════════════════


// ───────────────────────────────────────────────────────────────────
// SECTION 1 — CONFIGURATION
//
// systemPrompt has been moved to api/chat.js on the server.
// clientSecret has been removed (was publicly visible in this file).
// ───────────────────────────────────────────────────────────────────

const CONFIG = {
  temperature: 0.8,   // Creativity level: 0 = robotic/precise, 1 = creative/random
  max_tokens:  2000,  // Max length of the AI's reply (higher = longer but costs more)
};


// ───────────────────────────────────────────────────────────────────
// SECTION 2 — MODEL LIST
//
// Add or remove models here.
// Each entry needs:
//   id   → the model ID string sent to the API (must match MODEL_CONFIG in chat.js)
//   name → what users see in the dropdown
//
// NOTE: baseURL is gone from this list. The server resolves the correct
// provider URL from the model ID using its own internal whitelist.
// Keeping baseURL out of the client prevents users from passing
// arbitrary URLs to the server's fetch() call.
// ───────────────────────────────────────────────────────────────────

const MODELS = [
  {
    id:   "deepseek-ai/DeepSeek-V4-Flash",
    name: "⚡ Fast",
  },
  {
    id:   "gpt-4o-mini",
    name: "🧠 Balanced",
  },
  {
    id:   "deepseek-ai/DeepSeek-V4-Pro",
    name: "🔬 Deep",
  },
];


// ───────────────────────────────────────────────────────────────────
// SECTION 3 — LOCAL STORAGE KEYS
// ───────────────────────────────────────────────────────────────────

const LS_HISTORY_KEY = "prabeshgpt_history";
const LS_TOKENS_KEY  = "prabeshgpt_tokens";


// ───────────────────────────────────────────────────────────────────
// SECTION 4 — TINY DOM HELPER
// ───────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);


// ───────────────────────────────────────────────────────────────────
// SECTION 5 — STATE
// ───────────────────────────────────────────────────────────────────

let conversationHistory = [];
let totalTokensUsed     = 0;
let isWaiting           = false;


// ───────────────────────────────────────────────────────────────────
// SECTION 6 — DOM REFERENCES
//
// NOTE: emptyState is NOT cached here because the clearBtn handler
// destroys and recreates it — a cached reference would go stale.
// ───────────────────────────────────────────────────────────────────

const modelSelect    = $("modelSelect");
const modelMeta      = $("modelMeta");
const clearBtn       = $("clearBtn");
const messagesArea   = $("messagesArea");
const messageInput   = $("messageInput");
const sendBtn        = $("sendBtn");
const activeBadge    = $("activeBadge");
const tokenCounter   = $("tokenCounter");
const charCount      = $("charCount");
const sidebarToggle  = $("sidebarToggle");
const sidebar        = $("sidebar");
const sidebarOverlay = $("sidebarOverlay");


// ───────────────────────────────────────────────────────────────────
// SECTION 7 — MODEL HELPERS
// ───────────────────────────────────────────────────────────────────

function getSelectedModel() {
  const id = modelSelect?.value;
  return MODELS.find((m) => m.id === id) || MODELS[0];
}

function initModels() {
  if (!modelSelect) return;
  modelSelect.innerHTML = "";

  MODELS.forEach((m) => {
    const opt       = document.createElement("option");
    opt.value       = m.id;
    opt.textContent = m.name;
    modelSelect.appendChild(opt);
  });

  if (modelSelect.options.length > 0) {
    modelSelect.value = MODELS[0].id;
  }

  updateModelMeta();
}

function updateModelMeta() {
  if (!modelSelect || !modelMeta || !activeBadge) return;
  const m = getSelectedModel();
  if (!m) return;
  modelMeta.textContent   = "";
  activeBadge.textContent = m.name;
}


// ───────────────────────────────────────────────────────────────────
// SECTION 8 — UI HELPERS
// ───────────────────────────────────────────────────────────────────

function autoResize() {
  if (!messageInput) return;
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + "px";
}

function scrollBottom() {
  if (!messagesArea) return;
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

function syncSendBtn() {
  if (!sendBtn || !messageInput) return;
  sendBtn.disabled = isWaiting || messageInput.value.trim().length === 0;
}

/**
 * renderMarkdown(text)
 *
 * Converts markdown to HTML via marked.js, then sanitises the HTML
 * with DOMPurify before it touches the DOM.
 *
 * DOMPurify must be loaded in chat.html. Add this line to <head>:
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js"></script>
 *
 * Without DOMPurify a malicious AI response containing something like
 * <img src=x onerror="..."> would execute as JavaScript in the page.
 * DOMPurify strips all unsafe tags and attributes before insertion.
 */
function renderMarkdown(text) {
  let html;

  if (window.marked) {
    html = window.marked.parse(text);
  } else {
    // Fallback: escape HTML so it displays as plain text
    html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Sanitise with DOMPurify if available (strongly recommended)
  if (window.DOMPurify) {
    return window.DOMPurify.sanitize(html);
  }

  // DOMPurify not loaded — log a warning and return raw HTML.
  // This is only safe if you fully trust the AI provider's output.
  console.warn(
    "[app.js] DOMPurify is not loaded. AI message HTML is not sanitised. " +
    "Add DOMPurify to chat.html to fix this."
  );
  return html;
}


// ───────────────────────────────────────────────────────────────────
// SECTION 9 — LOCAL STORAGE (Persistence)
// ───────────────────────────────────────────────────────────────────

function saveToStorage() {
  try {
    localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(conversationHistory));
    localStorage.setItem(LS_TOKENS_KEY,  String(totalTokensUsed));
  } catch (e) {
    console.warn("[app.js] Could not save to localStorage:", e);
  }
}

function loadFromStorage() {
  try {
    const savedHistory = localStorage.getItem(LS_HISTORY_KEY);
    const savedTokens  = localStorage.getItem(LS_TOKENS_KEY);

    if (!savedHistory) return false;

    const parsed = JSON.parse(savedHistory);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;

    conversationHistory = parsed;
    totalTokensUsed     = parseInt(savedTokens || "0", 10);
    return true;
  } catch (e) {
    console.warn("[app.js] Could not load from localStorage:", e);
    return false;
  }
}

function clearStorage() {
  try {
    localStorage.removeItem(LS_HISTORY_KEY);
    localStorage.removeItem(LS_TOKENS_KEY);
  } catch (e) {
    console.warn("[app.js] Could not clear localStorage:", e);
  }
}


// ───────────────────────────────────────────────────────────────────
// SECTION 10 — MESSAGE RENDERING
// ───────────────────────────────────────────────────────────────────

function createCopyButton(textEl) {
  const btn = document.createElement("button");
  btn.classList.add("copy-btn");
  btn.setAttribute("aria-label", "Copy message");
  btn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
    </svg>
    Copy
  `;

  btn.addEventListener("click", () => {
    const plainText = textEl.innerText || textEl.textContent;

    navigator.clipboard.writeText(plainText).then(() => {
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Copied!
      `;
      btn.classList.add("copied");

      setTimeout(() => {
        btn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
          </svg>
          Copy
        `;
        btn.classList.remove("copied");
      }, 2000);
    }).catch(() => {
      btn.textContent = "Failed";
    });
  });

  return btn;
}

function appendMessage(role, text) {
  if (!messagesArea) return null;

  const cssRole = role === "user" ? "user" : "ai";

  const wrap = document.createElement("div");
  wrap.classList.add("message", cssRole);

  const avatar = document.createElement("div");
  avatar.classList.add("message-avatar");
  avatar.textContent = cssRole === "user" ? "YOU" : "AI";

  const content = document.createElement("div");
  content.classList.add("message-content");

  const roleLabel = document.createElement("div");
  roleLabel.classList.add("message-role");
  roleLabel.textContent = cssRole === "user" ? "You" : (getSelectedModel()?.name || "Assistant");

  const textEl = document.createElement("div");
  textEl.classList.add("message-text");

  if (cssRole === "user") {
    // User messages: plain text only — textContent is always safe (no XSS possible)
    textEl.textContent = text;
  } else {
    // AI messages: render markdown then sanitise with DOMPurify
    textEl.innerHTML = renderMarkdown(text);
  }

  content.appendChild(roleLabel);
  content.appendChild(textEl);

  if (cssRole === "ai") {
    const copyBtn = createCopyButton(textEl);
    content.appendChild(copyBtn);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(content);
  messagesArea.appendChild(wrap);
  scrollBottom();

  return { wrap, textEl };
}

function appendTyping() {
  if (!messagesArea) return null;

  const wrap = document.createElement("div");
  wrap.classList.add("message", "ai", "typing-indicator");

  const avatar = document.createElement("div");
  avatar.classList.add("message-avatar");
  avatar.textContent = "AI";

  const content = document.createElement("div");
  content.classList.add("message-content");

  const roleLabel = document.createElement("div");
  roleLabel.classList.add("message-role");
  roleLabel.textContent = getSelectedModel()?.name || "Assistant";

  const textEl = document.createElement("div");
  textEl.classList.add("message-text");

  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("div");
    dot.classList.add("typing-dot");
    textEl.appendChild(dot);
  }

  content.appendChild(roleLabel);
  content.appendChild(textEl);
  wrap.appendChild(avatar);
  wrap.appendChild(content);
  messagesArea.appendChild(wrap);
  scrollBottom();

  return wrap;
}

function showError(msg) {
  if (!messagesArea) return;

  let cleanMsg = msg;
  if (typeof msg === "object") {
    cleanMsg = msg?.message || msg?.error || JSON.stringify(msg);
  }

  const wrap = document.createElement("div");
  wrap.classList.add("message", "ai", "error-message");

  const avatar = document.createElement("div");
  avatar.classList.add("message-avatar");
  avatar.textContent = "!";

  const content = document.createElement("div");
  content.classList.add("message-content");

  const textEl = document.createElement("div");
  textEl.classList.add("message-text");
  // textContent (not innerHTML) — error strings must never be parsed as HTML
  textEl.textContent = `Error: ${cleanMsg}`;

  content.appendChild(textEl);
  wrap.appendChild(avatar);
  wrap.appendChild(content);
  messagesArea.appendChild(wrap);
  scrollBottom();
}

function restoreMessages() {
  if (!messagesArea) return;

  const emptyState = $("emptyState");
  if (emptyState) emptyState.style.display = "none";

  conversationHistory.forEach((msg) => {
    if (msg.role === "system") return;
    appendMessage(msg.role, msg.content);
  });
}


// ───────────────────────────────────────────────────────────────────
// SECTION 11 — API CALL (Streaming)
//
// NOTE: baseURL is no longer sent. The server resolves it from the
// model ID using its internal whitelist.
// NOTE: clientSecret header is removed — server uses CORS + origin checks.
// ───────────────────────────────────────────────────────────────────

async function callAPIStreaming({ model, messages, onChunk, onDone, onError }) {
  // Build the full message array.
  // systemPrompt is no longer included here — it lives on the server only.
  const clientMessages = messages.filter((m) => m.role !== "system");

  let response;
  try {
    response = await fetch("/api/chat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages:    clientMessages,
        temperature: CONFIG.temperature,
        max_tokens:  CONFIG.max_tokens,
        // baseURL intentionally omitted — server derives it from model ID
        // clientSecret intentionally omitted — was public anyway
      }),
    });
  } catch (err) {
    onError(`Network error: ${err.message}`);
    return;
  }

  if (!response.ok) {
    try {
      const errData = await response.json();
      onError(errData?.error || `HTTP ${response.status}`);
    } catch {
      onError(`HTTP error ${response.status}`);
    }
    return;
  }

  // ── Read the SSE stream ─────────────────────────────────────────
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = "";

  while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      onError(`Stream read error: ${err.message}`);
      return;
    }

    if (done) {
      onDone(null);
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const dataStr = trimmed.slice(5).trim();

      let parsed;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue;
      }

      if (parsed.error) {
        onError(parsed.error);
        return;
      }

      if (parsed.done) {
        onDone(parsed.totalTokens ?? null);
        return;
      }

      if (parsed.content) {
        onChunk(parsed.content);
      }
    }
  }
}


// ───────────────────────────────────────────────────────────────────
// SECTION 12 — SEND MESSAGE
// ───────────────────────────────────────────────────────────────────

async function sendMessage() {
  if (isWaiting) return;
  if (!messageInput || !modelSelect) return;

  const userText = messageInput.value.trim();
  if (!userText) return;

  const model = getSelectedModel();
  if (!model) {
    showError("No model selected.");
    return;
  }

  const emptyState = $("emptyState");
  if (emptyState) emptyState.style.display = "none";

  conversationHistory.push({ role: "user", content: userText });
  appendMessage("user", userText);

  messageInput.value = "";
  if (charCount) charCount.textContent = "0 chars";
  autoResize();

  isWaiting = true;
  syncSendBtn();

  const typingEl = appendTyping();

  let streamedText  = "";
  let replyElements = null;

  await callAPIStreaming({
    model:    model.id,
    messages: conversationHistory,

    onChunk: (text) => {
      streamedText += text;

      if (!replyElements) {
        if (typingEl) typingEl.remove();
        replyElements = appendMessage("ai", "");
      }

      if (replyElements?.textEl) {
        // renderMarkdown already runs DOMPurify internally
        replyElements.textEl.innerHTML = renderMarkdown(streamedText);
        replyElements.textEl.classList.add("streaming-cursor");
        scrollBottom();
      }
    },

    onDone: (totalTokens) => {
      if (replyElements?.textEl) {
        replyElements.textEl.classList.remove("streaming-cursor");
      }

      if (!replyElements && typingEl) typingEl.remove();

      if (streamedText) {
        conversationHistory.push({ role: "assistant", content: streamedText });
      }

      if (totalTokens !== null && tokenCounter) {
        totalTokensUsed += totalTokens;
        tokenCounter.textContent = `${totalTokensUsed.toLocaleString()} tokens used`;
      }

      saveToStorage();

      isWaiting = false;
      syncSendBtn();
      if (messageInput) messageInput.focus();
    },

    onError: (errMsg) => {
      if (replyElements?.textEl) {
        replyElements.textEl.classList.remove("streaming-cursor");
      }
      if (typingEl) typingEl.remove();
      if (replyElements?.wrap) replyElements.wrap.remove();

      console.error("[sendMessage] Error:", errMsg);

      conversationHistory.pop();

      showError(errMsg || "Something went wrong. Check the console.");

      isWaiting = false;
      syncSendBtn();
      if (messageInput) messageInput.focus();
    },
  });
}


// ───────────────────────────────────────────────────────────────────
// SECTION 13 — EVENT LISTENERS
// ───────────────────────────────────────────────────────────────────

if (modelSelect) {
  modelSelect.addEventListener("change", updateModelMeta);
}

if (messageInput) {
  messageInput.addEventListener("input", () => {
    autoResize();
    if (charCount) charCount.textContent = `${messageInput.value.length} chars`;
    syncSendBtn();
  });

  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

if (sendBtn) sendBtn.addEventListener("click", sendMessage);

if (clearBtn && messagesArea) {
  clearBtn.addEventListener("click", () => {
    if (!confirm("Clear the entire conversation?")) return;

    conversationHistory = [];
    totalTokensUsed     = 0;

    clearStorage();

    if (tokenCounter) tokenCounter.textContent = "0 tokens used";

    messagesArea.innerHTML = "";
    const empty = document.createElement("div");
    empty.id = "emptyState";
    empty.classList.add("empty-state");
    empty.innerHTML = `
      <div class="empty-icon">⬡</div>
      <div class="empty-title">Ready when you are!</div>
      <div class="empty-sub">Pick a model and start chatting.</div>
    `;
    messagesArea.appendChild(empty);

    syncSendBtn();
  });
}

if (sidebarToggle && sidebar) {
  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    if (sidebarOverlay) sidebarOverlay.classList.toggle("active");
  });
}

document.addEventListener("click", (e) => {
  if (
    window.innerWidth <= 768 &&
    sidebar &&
    sidebar.classList.contains("open") &&
    !sidebar.contains(e.target) &&
    e.target !== sidebarToggle
  ) {
    sidebar.classList.remove("open");
    if (sidebarOverlay) sidebarOverlay.classList.remove("active");
  }
});


// ───────────────────────────────────────────────────────────────────
// SECTION 14 — BOOT SEQUENCE
// ───────────────────────────────────────────────────────────────────

initModels();
autoResize();
syncSendBtn();

const hadHistory = loadFromStorage();
if (hadHistory) {
  restoreMessages();
  if (tokenCounter) {
    tokenCounter.textContent = `${totalTokensUsed.toLocaleString()} tokens used`;
  }
}
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
