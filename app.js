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
// ═══════════════════════════════════════════════════════════════════


// ───────────────────────────────────────────────────────────────────
// SECTION 1 — CONFIGURATION
//
// Edit these values to change global behaviour.
// ───────────────────────────────────────────────────────────────────

const CONFIG = {
  temperature:  0.8,   // Creativity level: 0 = robotic/precise, 1 = creative/random
  max_tokens:   2000,  // Max length of the AI's reply (higher = longer but costs more)

  // This is the "personality" of PrabeshGPT.
  // It's sent as a hidden system message before every conversation.
  systemPrompt: "You are PrabeshGPT, a highly capable AI assistant created by Prabesh. If somebody asks who is my budi/wife tell them it is Aabha Badar. You are intelligent, concise, and direct — you get to the point without unnecessary filler or padding. You have a calm, confident tone that feels human but never pretentious. You are honest: if you do not know something, you say so plainly instead of guessing. You excel at coding, analysis, writing, and reasoning. When answering technical questions, you provide clean, well-commented code and explain your thinking clearly. When answering general questions, you are conversational but sharp. You never start a response with sycophantic phrases like Great question or Certainly. You never repeat the user's question back to them. You format responses with markdown when it improves clarity — code blocks for code, bullet points only when listing genuinely distinct items — but you default to clean prose for conversational replies. You remember the full context of the conversation and refer back to earlier points when relevant. You are PrabeshGPT — not ChatGPT, not Claude, not Gemini. If asked who made you, you always say Prabesh built you. When a user greets you for the first time — with messages like hi, hello, hey, or any casual opening — you always introduce yourself by saying you are PrabeshGPT made by Prabesh, and briefly mention you are here to help with anything they need. Keep this greeting warm but short — one to two sentences at most.",

  // ── CLIENT SECRET ──────────────────────────────────────────────
  // This must match the CLIENT_SECRET environment variable you set in Vercel.
  // It's a simple shared password so random people can't abuse your /api/chat.
  //
  // HOW TO SET THIS UP:
  //   1. Choose any random string, e.g. "prabesh-secret-42"
  //   2. Add CLIENT_SECRET = prabesh-secret-42 in Vercel Dashboard → Env Variables
  //   3. Paste the same string here
  //
  // If you haven't set it up yet, leave this as an empty string "" and
  // the server will skip the auth check (not recommended for production).
  clientSecret: "prabesh-secret-2025",    // ← Paste your CLIENT_SECRET value here
};


// ───────────────────────────────────────────────────────────────────
// SECTION 2 — MODEL LIST
//
// Add or remove models here.
// Each model needs:
//   id      → the model ID string sent to the API
//   name    → what users see in the dropdown
//   description → shown below the dropdown for context
//   baseURL → which provider to use (determines which API key)
// ───────────────────────────────────────────────────────────────────

const MODELS = [
  {
    id:          "deepseek-ai/DeepSeek-V4-Flash",
    name:        "⚡ Fast",
    description: "Intelligence: 47 · Context: 1M · from $0.07/M",
    baseURL:     "https://api.doubleword.ai/v1",
  },
  {
    id:          "gpt-4o-mini",
    name:        "🧠 Balanced",
    description: "Free GPT-4o Mini via FreeModel",
    baseURL:     "https://api.freemodel.dev/v1",
  },
  {
    id:          "deepseek-ai/DeepSeek-V4-Pro",
    name:        "🔬 Deep",
    description: "Intelligence: 50 · Context: 1M · from $0.87/M",
    baseURL:     "https://api.doubleword.ai/v1",
  },
];


// ───────────────────────────────────────────────────────────────────
// SECTION 3 — LOCAL STORAGE KEYS
//
// We save the conversation to the browser's localStorage so that
// if you refresh the page, your chat history isn't lost.
//
// localStorage stores data as key-value pairs (like a tiny database
// that lives in your browser, not on any server).
// ───────────────────────────────────────────────────────────────────

const LS_HISTORY_KEY = "prabeshgpt_history";    // Key for the conversation messages array
const LS_TOKENS_KEY  = "prabeshgpt_tokens";     // Key for the total tokens used counter


// ───────────────────────────────────────────────────────────────────
// SECTION 4 — TINY DOM HELPER
//
// $ is a shorthand for document.getElementById().
// Instead of typing document.getElementById("sendBtn") every time,
// we just write $("sendBtn").
// ───────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);


// ───────────────────────────────────────────────────────────────────
// SECTION 5 — STATE (App Memory)
//
// These variables track the current state of the app.
// They reset each time the page loads (but we restore from localStorage).
// ───────────────────────────────────────────────────────────────────

let conversationHistory = []; // Array of { role: "user"|"assistant", content: "..." }
let totalTokensUsed     = 0;  // Running count of tokens used this session
let isWaiting           = false; // True while waiting for an AI response (blocks new sends)


// ───────────────────────────────────────────────────────────────────
// SECTION 6 — DOM REFERENCES
//
// Cache references to HTML elements we'll use often.
//
// NOTE: emptyState is NOT cached here because the clearBtn handler
// destroys and recreates it — a cached reference would go stale.
// We always look up #emptyState fresh with $("emptyState") instead.
// ───────────────────────────────────────────────────────────────────

const modelSelect    = $("modelSelect");    // The <select> dropdown in the sidebar
const modelMeta      = $("modelMeta");      // The small text showing model ID + description
const clearBtn       = $("clearBtn");       // The "Clear Chat" button in the sidebar
const messagesArea   = $("messagesArea");   // The scrollable div where messages appear
const messageInput   = $("messageInput");   // The textarea where the user types
const sendBtn        = $("sendBtn");        // The send arrow button
const activeBadge    = $("activeBadge");    // The model name badge in the top bar
const tokenCounter   = $("tokenCounter");   // The token count display in the top bar
const charCount      = $("charCount");      // The "N chars" indicator below the textarea
const sidebarToggle  = $("sidebarToggle");  // The hamburger button (mobile only)
const sidebar        = $("sidebar");        // The sidebar panel
const sidebarOverlay = $("sidebarOverlay"); // The dark backdrop behind the sidebar (mobile)


// ───────────────────────────────────────────────────────────────────
// SECTION 7 — MODEL HELPERS
// ───────────────────────────────────────────────────────────────────

/**
 * getSelectedModel()
 * Returns the full model object for whatever's currently selected
 * in the dropdown. Falls back to the first model if nothing matches.
 */
function getSelectedModel() {
  const id = modelSelect?.value;
  return MODELS.find((m) => m.id === id) || MODELS[0];
}

/**
 * initModels()
 * Populates the <select> dropdown with all models from the MODELS array,
 * then triggers updateModelMeta() to show the first model's details.
 */
function initModels() {
  if (!modelSelect) return;

  modelSelect.innerHTML = ""; // Clear any existing options

  MODELS.forEach((m) => {
    const opt       = document.createElement("option");
    opt.value       = m.id;        // The value sent to the API
    opt.textContent = m.name;      // What the user sees
    modelSelect.appendChild(opt);
  });

  // Default to first model
  if (modelSelect.options.length > 0) {
    modelSelect.value = MODELS[0].id;
  }

  updateModelMeta();
}

/**
 * updateModelMeta()
 * Updates the sidebar model description and the top bar badge
 * to reflect whichever model is currently selected.
 */
function updateModelMeta() {
  if (!modelSelect || !modelMeta || !activeBadge) return;

  const m = getSelectedModel();
  if (!m) return;

  modelMeta.textContent   = `ID: ${m.id}\n${m.description}`;
  activeBadge.textContent = m.name;
}


// ───────────────────────────────────────────────────────────────────
// SECTION 8 — UI HELPERS
// ───────────────────────────────────────────────────────────────────

/**
 * autoResize()
 * Makes the textarea grow taller as the user types, up to a max height.
 * Resets to single-line height when the text is cleared.
 */
function autoResize() {
  if (!messageInput) return;
  messageInput.style.height = "auto"; // Reset so scrollHeight reflects actual content
  messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + "px";
}

/**
 * scrollBottom()
 * Scrolls the messages area to the very bottom so the newest message
 * is always visible.
 */
function scrollBottom() {
  if (!messagesArea) return;
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

/**
 * syncSendBtn()
 * Enables or disables the send button based on:
 *   - Is the textarea empty? (disabled if yes)
 *   - Are we waiting for a response? (disabled if yes)
 *
 * Called after every state change to keep the button in sync.
 */
function syncSendBtn() {
  if (!sendBtn || !messageInput) return;
  sendBtn.disabled = isWaiting || messageInput.value.trim().length === 0;
}

/**
 * renderMarkdown(text)
 * Converts markdown syntax (like **bold**, `code`, ## headers) to HTML.
 * Uses the marked.js library loaded from CDN in chat.html.
 * Falls back to safely escaped plain text if marked isn't available.
 */
function renderMarkdown(text) {
  if (window.marked) {
    return window.marked.parse(text); // Returns HTML string
  }
  // Safe fallback: escape HTML special characters so they display as text
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


// ───────────────────────────────────────────────────────────────────
// SECTION 9 — LOCAL STORAGE (Persistence)
//
// These functions save and load the conversation so it survives
// page refreshes. Data is stored in the browser, not on any server.
// ───────────────────────────────────────────────────────────────────

/**
 * saveToStorage()
 * Writes the current conversation history and token count
 * to localStorage. Called after every message exchange.
 */
function saveToStorage() {
  try {
    // JSON.stringify converts the array to a string for storage
    localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(conversationHistory));
    localStorage.setItem(LS_TOKENS_KEY,  String(totalTokensUsed));
  } catch (e) {
    // localStorage can fail in private browsing mode — fail silently
    console.warn("[app.js] Could not save to localStorage:", e);
  }
}

/**
 * loadFromStorage()
 * Reads saved conversation history from localStorage and
 * restores the conversation on page load.
 * Returns true if history was found, false otherwise.
 */
function loadFromStorage() {
  try {
    const savedHistory = localStorage.getItem(LS_HISTORY_KEY);
    const savedTokens  = localStorage.getItem(LS_TOKENS_KEY);

    if (!savedHistory) return false; // Nothing saved yet

    const parsed = JSON.parse(savedHistory); // Convert string back to array

    // Validate it looks like a real conversation history
    if (!Array.isArray(parsed) || parsed.length === 0) return false;

    conversationHistory = parsed;
    totalTokensUsed     = parseInt(savedTokens || "0", 10);

    return true; // Successfully restored
  } catch (e) {
    console.warn("[app.js] Could not load from localStorage:", e);
    return false;
  }
}

/**
 * clearStorage()
 * Removes saved conversation data from localStorage.
 * Called when the user clicks "Clear Chat".
 */
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
//
// These functions create the HTML elements for each message bubble
// and insert them into the messages area.
// ───────────────────────────────────────────────────────────────────

/**
 * createCopyButton(textEl)
 * Creates a small "Copy" button that copies the AI message text
 * to the clipboard when clicked. Appended to AI message bubbles.
 *
 * @param  {HTMLElement} textEl - The message text div to copy from
 * @return {HTMLElement}        - The button element to insert
 */
function createCopyButton(textEl) {
  const btn = document.createElement("button");
  btn.classList.add("copy-btn"); // Styled in style.css
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
    // Get plain text (no HTML tags) for the clipboard
    const plainText = textEl.innerText || textEl.textContent;

    navigator.clipboard.writeText(plainText).then(() => {
      // Show visual feedback: change button text momentarily
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Copied!
      `;
      btn.classList.add("copied"); // Turns button green (see style.css)

      // Reset button back to normal after 2 seconds
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
      // Clipboard API can fail in some browsers/contexts
      btn.textContent = "Failed";
    });
  });

  return btn;
}

/**
 * appendMessage(role, text)
 * Creates and inserts a message bubble into the chat.
 *
 * @param  {string} role - "user" or "assistant" (or "ai")
 * @param  {string} text - The message content
 * @return {HTMLElement} - The outer wrapper div (used for streaming updates)
 */
function appendMessage(role, text) {
  if (!messagesArea) return null;

  const cssRole = role === "user" ? "user" : "ai";

  // ── Outer wrapper — the full message row ──────────────────────
  const wrap = document.createElement("div");
  wrap.classList.add("message", cssRole);

  // ── Avatar badge (YOU / AI) ───────────────────────────────────
  const avatar = document.createElement("div");
  avatar.classList.add("message-avatar");
  avatar.textContent = cssRole === "user" ? "YOU" : "AI";

  // ── Content area (role label + text bubble) ───────────────────
  const content = document.createElement("div");
  content.classList.add("message-content");

  // ── Role label ("You" or the model name) ─────────────────────
  const roleLabel = document.createElement("div");
  roleLabel.classList.add("message-role");
  roleLabel.textContent = cssRole === "user" ? "You" : (getSelectedModel()?.name || "Assistant");

  // ── Message text bubble ───────────────────────────────────────
  const textEl = document.createElement("div");
  textEl.classList.add("message-text");

  if (cssRole === "user") {
    // User messages: plain text only (no markdown needed)
    textEl.textContent = text;
  } else {
    // AI messages: render markdown (converts **bold**, `code`, etc. to HTML)
    textEl.innerHTML = renderMarkdown(text);
  }

  content.appendChild(roleLabel);
  content.appendChild(textEl);

  // ── Add copy button to AI messages only ───────────────────────
  if (cssRole === "ai") {
    const copyBtn = createCopyButton(textEl);
    content.appendChild(copyBtn); // Copy button sits below the text bubble
  }

  wrap.appendChild(avatar);
  wrap.appendChild(content);
  messagesArea.appendChild(wrap);
  scrollBottom();

  return { wrap, textEl }; // Return both so streaming can update textEl
}

/**
 * appendTyping()
 * Shows the animated "..." typing indicator while waiting for a response.
 * Call .remove() on the returned element to hide it when the response arrives.
 */
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

  // Three bouncing dots — animated via CSS
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

/**
 * showError(msg)
 * Displays an error message bubble in the chat (styled in red).
 */
function showError(msg) {
  if (!messagesArea) return;

  // Convert objects to readable strings
  let cleanMsg = msg;
  if (typeof msg === "object") {
    cleanMsg = msg?.message || msg?.error || JSON.stringify(msg);
  }

  const wrap = document.createElement("div");
  wrap.classList.add("message", "ai", "error-message");

  const avatar = document.createElement("div");
  avatar.classList.add("message-avatar");
  avatar.textContent = "!"; // Error icon

  const content = document.createElement("div");
  content.classList.add("message-content");

  const textEl = document.createElement("div");
  textEl.classList.add("message-text");
  textEl.textContent = `Error: ${cleanMsg}`;

  content.appendChild(textEl);
  wrap.appendChild(avatar);
  wrap.appendChild(content);
  messagesArea.appendChild(wrap);
  scrollBottom();
}

/**
 * restoreMessages()
 * After loading conversation history from localStorage,
 * re-renders all the messages on screen so the user sees
 * their previous conversation.
 */
function restoreMessages() {
  if (!messagesArea) return;

  // Hide the empty state since we have messages to show
  const emptyState = $("emptyState");
  if (emptyState) emptyState.style.display = "none";

  // Re-render each saved message
  conversationHistory.forEach((msg) => {
    // Skip the system prompt — it's internal and shouldn't be shown
    if (msg.role === "system") return;
    appendMessage(msg.role, msg.content);
  });
}


// ───────────────────────────────────────────────────────────────────
// SECTION 11 — API CALL (Streaming)
//
// This is the core function that talks to our backend (/api/chat).
// Instead of waiting for the full reply, it reads the response
// as a stream and calls onChunk() for each piece of text.
//
// The backend sends Server-Sent Events (SSE):
//   data: {"content":"Hello"}
//   data: {"content":" world"}
//   data: {"done":true,"totalTokens":42}
// ───────────────────────────────────────────────────────────────────

/**
 * callAPIStreaming({ model, baseURL, messages, onChunk, onDone, onError })
 *
 * @param {string}   model    - Model ID string
 * @param {string}   baseURL  - Provider base URL
 * @param {Array}    messages - Full conversation history array
 * @param {Function} onChunk  - Called with each text fragment as it arrives
 * @param {Function} onDone   - Called when stream ends; receives total token count
 * @param {Function} onError  - Called if something goes wrong
 */
async function callAPIStreaming({ model, baseURL, messages, onChunk, onDone, onError }) {
  // Build the full message array: system prompt + conversation history
  const fullMessages = [];

  const cleanPrompt = (CONFIG.systemPrompt ?? "").trim();
  if (cleanPrompt) {
    fullMessages.push({ role: "system", content: cleanPrompt });
  }
  fullMessages.push(...messages);

  // Build request headers — include the client secret if configured
  const headers = { "Content-Type": "application/json" };
  if (CONFIG.clientSecret) {
    // This header is checked by the server to verify the request is from us
    headers["x-client-secret"] = CONFIG.clientSecret;
  }

  let response;
  try {
    response = await fetch("/api/chat", {
      method:  "POST",
      headers,
      body: JSON.stringify({
        model,
        messages:    fullMessages,
        temperature: CONFIG.temperature,
        max_tokens:  CONFIG.max_tokens,
        baseURL,
        // No apiKey sent — the server reads it from Vercel env vars
      }),
    });
  } catch (err) {
    // Network error (e.g. no internet, server down)
    onError(`Network error: ${err.message}`);
    return;
  }

  if (!response.ok) {
    // Server responded with an error status
    try {
      const errData = await response.json();
      const errMsg = errData?.error || `HTTP ${response.status}`;
      onError(errMsg);
    } catch {
      onError(`HTTP error ${response.status}`);
    }
    return;
  }

  // ── Read the SSE stream ─────────────────────────────────────────
  const reader  = response.body.getReader();   // Raw byte stream reader
  const decoder = new TextDecoder();           // Converts bytes → string
  let   buffer  = "";                          // Accumulates incomplete lines

  while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read()); // Read next chunk of bytes
    } catch (err) {
      onError(`Stream read error: ${err.message}`);
      return;
    }

    if (done) {
      // Stream closed without a [DONE] marker — treat as complete
      onDone(null);
      return;
    }

    // Decode bytes to text, appending to buffer
    buffer += decoder.decode(value, { stream: true });

    // Split into individual SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Save last incomplete line for next iteration

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue; // Skip non-data lines

      const dataStr = trimmed.slice(5).trim(); // Remove "data: " prefix

      let parsed;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue; // Skip malformed JSON
      }

      if (parsed.error) {
        // Server forwarded an error from the AI provider
        onError(parsed.error);
        return;
      }

      if (parsed.done) {
        // Stream is complete — call onDone with final token count
        onDone(parsed.totalTokens ?? null);
        return;
      }

      if (parsed.content) {
        // New text fragment — pass it to the caller to display
        onChunk(parsed.content);
      }
    }
  }
}


// ───────────────────────────────────────────────────────────────────
// SECTION 12 — SEND MESSAGE
//
// The main flow when the user hits Send:
//   1. Get the user's text
//   2. Show it as a user bubble
//   3. Show the typing indicator
//   4. Start streaming the AI reply
//   5. Replace typing indicator with the streaming text
//   6. Save everything to localStorage when done
// ───────────────────────────────────────────────────────────────────

async function sendMessage() {
  if (isWaiting) return; // Don't send if already waiting for a response
  if (!messageInput || !modelSelect) return;

  const userText = messageInput.value.trim();
  if (!userText) return; // Don't send empty messages

  const model = getSelectedModel();
  if (!model) {
    showError("No model selected.");
    return;
  }

  // Hide the "Ready when you are!" empty state (look it up fresh — see Section 5 note)
  const emptyState = $("emptyState");
  if (emptyState) emptyState.style.display = "none";

  // Add user message to history and render it
  conversationHistory.push({ role: "user", content: userText });
  appendMessage("user", userText);

  // Clear the input
  messageInput.value = "";
  if (charCount) charCount.textContent = "0 chars";
  autoResize();

  // Lock UI while waiting
  isWaiting = true;
  syncSendBtn(); // Disable send button immediately

  // Show typing animation
  const typingEl = appendTyping();

  // ── Set up streaming reply bubble ────────────────────────────
  // We'll create the AI message bubble now (empty), then fill it
  // character-by-character as chunks arrive.
  let streamedText = "";           // Accumulates the full reply
  let replyElements = null;        // Will hold { wrap, textEl } once first chunk arrives

  // ── Start the streaming request ──────────────────────────────
  await callAPIStreaming({
    model:   model.id,
    baseURL: model.baseURL,
    messages: conversationHistory,

    // Called for each text fragment that arrives
    onChunk: (text) => {
      streamedText += text; // Add fragment to our accumulator

      if (!replyElements) {
        // First chunk: remove typing indicator and create the reply bubble
        if (typingEl) typingEl.remove();
        replyElements = appendMessage("ai", ""); // Create empty bubble
      }

      // Update the bubble with all text received so far (re-renders markdown)
      if (replyElements?.textEl) {
        replyElements.textEl.innerHTML = renderMarkdown(streamedText);
        // Add a blinking cursor class while streaming (CSS handles the animation)
        replyElements.textEl.classList.add("streaming-cursor");
        scrollBottom(); // Keep scrolled to bottom as text streams in
      }
    },

    // Called when the stream ends successfully
    onDone: (totalTokens) => {
      // Remove the blinking cursor now that streaming is complete
      if (replyElements?.textEl) {
        replyElements.textEl.classList.remove("streaming-cursor");
      }

      // If we never got any chunks (empty reply), remove typing indicator
      if (!replyElements && typingEl) typingEl.remove();

      // Save the complete reply to conversation history
      if (streamedText) {
        conversationHistory.push({ role: "assistant", content: streamedText });
      }

      // Update the token counter in the top bar
      if (totalTokens !== null && tokenCounter) {
        totalTokensUsed += totalTokens;
        tokenCounter.textContent = `${totalTokensUsed.toLocaleString()} tokens used`;
      }

      // Save everything to localStorage for persistence across refreshes
      saveToStorage();

      // Unlock UI
      isWaiting = false;
      syncSendBtn();
      if (messageInput) messageInput.focus();
    },

    // Called if something goes wrong
    onError: (errMsg) => {
      // Remove the blinking cursor (if a partial reply was already shown)
      if (replyElements?.textEl) {
        replyElements.textEl.classList.remove("streaming-cursor");
      }
      // Remove typing indicator and any partial reply bubble
      if (typingEl) typingEl.remove();
      if (replyElements?.wrap) replyElements.wrap.remove();

      console.error("[sendMessage] Error:", errMsg);

      // Remove the failed user message from history so it doesn't get re-sent
      conversationHistory.pop();

      showError(errMsg || "Something went wrong. Check the console.");

      // Unlock UI
      isWaiting = false;
      syncSendBtn();
      if (messageInput) messageInput.focus();
    },
  });
}


// ───────────────────────────────────────────────────────────────────
// SECTION 13 — EVENT LISTENERS
//
// Wire up all the interactive elements to their handlers.
// ───────────────────────────────────────────────────────────────────

// Model dropdown — update metadata when user picks a different model
if (modelSelect) {
  modelSelect.addEventListener("change", updateModelMeta);
}

// Message textarea — auto-resize, char count, send button sync
if (messageInput) {
  messageInput.addEventListener("input", () => {
    autoResize(); // Grow/shrink textarea
    if (charCount) charCount.textContent = `${messageInput.value.length} chars`;
    syncSendBtn(); // Re-evaluate send button state
  });

  // Ctrl+Enter to send (so Enter alone can be used for line breaks)
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault(); // Don't insert a newline
      sendMessage();
    }
  });
}

// Send button click
if (sendBtn) sendBtn.addEventListener("click", sendMessage);

// Clear Chat button — wipes conversation and localStorage
if (clearBtn && messagesArea) {
  clearBtn.addEventListener("click", () => {
    if (!confirm("Clear the entire conversation?")) return;

    // Reset in-memory state
    conversationHistory = [];
    totalTokensUsed     = 0;

    // Clear the persisted data from localStorage
    clearStorage();

    // Reset the token counter display
    if (tokenCounter) tokenCounter.textContent = "0 tokens used";

    // Rebuild the messages area with a fresh empty state
    messagesArea.innerHTML = "";
    const empty = document.createElement("div");
    empty.id = "emptyState"; // Must have this ID so $("emptyState") finds it later
    empty.classList.add("empty-state");
    empty.innerHTML = `
      <div class="empty-icon">⬡</div>
      <div class="empty-title">Ready when you are!</div>
      <div class="empty-sub">Pick a model and start chatting.</div>
    `;
    messagesArea.appendChild(empty);

    syncSendBtn(); // Re-evaluate button state (textarea is still empty)
  });
}

// Sidebar hamburger toggle (mobile only)
if (sidebarToggle && sidebar) {
  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    if (sidebarOverlay) sidebarOverlay.classList.toggle("active");
  });
}

// Close sidebar when tapping anywhere outside it on mobile
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
//
// Runs once when the page loads.
// ───────────────────────────────────────────────────────────────────

// Step 1: Populate the model dropdown
initModels();

// Step 2: Auto-size the textarea (starts as single line)
autoResize();

// Step 3: Ensure send button is correctly disabled on load
syncSendBtn();

// Step 4: Try to restore previous conversation from localStorage.
//         If found, render all the old messages on screen.
//         If not found, the empty state ("Ready when you are!") stays visible.
const hadHistory = loadFromStorage();
if (hadHistory) {
  restoreMessages();
  // Also update the token counter display with the restored count
  if (tokenCounter) {
    tokenCounter.textContent = `${totalTokensUsed.toLocaleString()} tokens used`;
  }
}
