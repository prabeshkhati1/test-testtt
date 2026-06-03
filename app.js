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
/* ═══════════════════════════════════════════
   17. VOICE FEATURE
   Append this block to the bottom of style.css
════════════════════════════════════════════ */

/* ── Voice button (sits in input bar) ────── */
.voice-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-dim);
  width: 38px; height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  min-width: 38px;
  min-height: 38px;
  align-self: flex-end;
  position: relative;
}
.voice-btn:hover {
  border-color: var(--border-hi);
  color: var(--text-sub);
}
.voice-btn:active {
  background: var(--bg3);
}

/* Recording state */
.voice-btn.recording {
  border-color: var(--red);
  color: var(--red);
  background: rgba(239, 68, 68, 0.08);
  animation: voice-btn-pulse 1.5s ease infinite;
}
@keyframes voice-btn-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.3); }
  50%       { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
}

/* Speaking state (AI is talking) */
.voice-btn.speaking {
  border-color: var(--green);
  color: var(--green);
  background: rgba(34, 197, 94, 0.08);
}

/* Show/hide mic vs stop icon based on state */
.voice-btn .voice-icon-stop { display: none; }
.voice-btn.recording .voice-icon-mic  { display: none; }
.voice-btn.recording .voice-icon-stop { display: block; }

/* Voice status label in input-meta row */
.voice-status {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  color: var(--text-dim);
  letter-spacing: 0.04em;
  transition: color 0.2s;
  flex: 1;
  text-align: center;
}
.voice-status.active   { color: var(--red);   }
.voice-status.speaking { color: var(--green);  }
.voice-status.error    { color: var(--red); opacity: 0.7; }

/* ── Voice overlay (full-screen modal) ────── */
.voice-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
}
.voice-overlay.active {
  opacity: 1;
  pointer-events: all;
}

.voice-modal {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  padding: 3rem 2rem;
  text-align: center;
  max-width: 380px;
  width: 100%;
}

/* Orb */
.voice-orb-wrap {
  position: relative;
  width: 120px;
  height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.voice-orb {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: var(--bg3);
  border: 1px solid var(--border-hi);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  position: relative;
  z-index: 1;
  transition: border-color 0.2s, color 0.2s, background 0.2s;
}

/* Listening state — red pulsing ring */
.voice-orb.listening {
  border-color: var(--red);
  color: var(--red);
  background: rgba(239,68,68,0.06);
}
.voice-orb.listening::before,
.voice-orb.listening::after {
  content: '';
  position: absolute;
  inset: -10px;
  border-radius: 50%;
  border: 1px solid rgba(239,68,68,0.3);
  animation: orb-ring 1.8s ease-out infinite;
}
.voice-orb.listening::after {
  inset: -20px;
  animation-delay: 0.6s;
}
@keyframes orb-ring {
  0%   { opacity: 1;   transform: scale(1); }
  100% { opacity: 0;   transform: scale(1.35); }
}

/* Speaking state — green pulsing */
.voice-orb.speaking {
  border-color: var(--green);
  color: var(--green);
  background: rgba(34,197,94,0.06);
  animation: orb-speak 0.8s ease infinite alternate;
}
@keyframes orb-speak {
  from { transform: scale(1);    box-shadow: none; }
  to   { transform: scale(1.04); box-shadow: 0 0 28px rgba(34,197,94,0.2); }
}

/* Processing state — dimmed */
.voice-orb.processing {
  border-color: var(--border-hi);
  color: var(--text-dim);
  opacity: 0.6;
}

.voice-label {
  font-family: var(--font-display);
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}

.voice-transcript {
  font-family: var(--font-body);
  font-size: 0.88rem;
  color: var(--text-mid);
  line-height: 1.7;
  min-height: 2.5em;
  max-width: 320px;
  word-break: break-word;
  font-style: italic;
}

.voice-close-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-dim);
  font-family: var(--font-body);
  font-size: 0.8rem;
  font-weight: 500;
  padding: 10px 20px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
  margin-top: 0.5rem;
  min-height: var(--touch-min);
}
.voice-close-btn:hover {
  border-color: var(--border-hi);
  color: var(--text);
}
.voice-close-btn:active {
  background: var(--bg3);
}

/* Responsive adjustments for voice overlay */
@media (max-width: 640px) {
  .voice-modal { padding: 2rem 1.25rem; gap: 1.25rem; }
  .voice-orb   { width: 80px; height: 80px; }
  .voice-orb svg { width: 26px; height: 26px; }
  .voice-label  { font-size: 0.95rem; }
}
