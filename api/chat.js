// ═══════════════════════════════════════════════════════════════════
// api/chat.js — Vercel Serverless Function
//
// This is the ONLY file that ever touches API keys.
// The browser (app.js) sends messages and receives replies,
// but NEVER sees the actual keys — they live here, loaded from
// Vercel environment variables at runtime.
//
// HOW IT WORKS (simple overview):
//   1. Browser sends POST /api/chat with { model, messages }
//      NOTE: baseURL is NO LONGER sent from the browser — the server
//      now looks it up from the model ID directly (fixes SSRF risk).
//   2. This function figures out which API key to use (by model ID)
//   3. It forwards the request to the real AI provider (DeepSeek, OpenAI, etc.)
//   4. It streams the reply back to the browser in real-time
//   5. Browser shows tokens as they arrive instead of waiting for the full reply
//
// SECURITY CHANGES vs original:
//   [1] baseURL is no longer accepted from the client — derived server-side
//       from a whitelist keyed by model ID. Eliminates SSRF.
//   [2] client-secret check is removed from the client (it was in public JS).
//       Protection is now: CORS + origin check + rate limiting + input validation.
//   [3] Input validation: message count cap, per-message length cap,
//       temperature + max_tokens clamped to safe ranges.
//   [4] role:"system" messages from the client are stripped — only the
//       server's own system prompt is used.
//   [5] CORS header locks requests to your own domain only.
// ═══════════════════════════════════════════════════════════════════


// ───────────────────────────────────────────────────────────────────
// SECTION 1 — ENVIRONMENT VARIABLES
//
// Set these in Vercel Dashboard → Your Project → Settings → Environment Variables
//   DOUBLEWORD_KEY = sk-...       (for DeepSeek models)
//   FREEMODEL_KEY  = fe_oa_...   (for GPT-4o Mini)
//
// CLIENT_SECRET has been removed — it was stored in public app.js
// and provided no real security. Origin checking + rate limiting
// is the right defence for a personal project like this.
// ───────────────────────────────────────────────────────────────────

const DOUBLEWORD_KEY = process.env.DOUBLEWORD_KEY;
const FREEMODEL_KEY  = process.env.FREEMODEL_KEY;

// ───────────────────────────────────────────────────────────────────
// SECTION 2 — MODEL WHITELIST (server-side source of truth)
//
// IMPORTANT: This is the only place that defines which models are
// allowed and which provider URL + API key each one uses.
// The client (app.js) sends a model ID; we look it up here.
// If the model ID isn't in this map, the request is rejected.
//
// This replaces the old "trust baseURL from the client" approach,
// which allowed any URL to be passed to fetch() on the server.
// ───────────────────────────────────────────────────────────────────

const MODEL_CONFIG = {
  "deepseek-ai/DeepSeek-V4-Flash": {
    baseURL:      "https://api.doubleword.ai/v1",
    apiKeyEnvVar: "DOUBLEWORD_KEY",
    isAnthropic:  false,
  },
  "gpt-4o-mini": {
    baseURL:      "https://api.freemodel.dev/v1",
    apiKeyEnvVar: "FREEMODEL_KEY",
    isAnthropic:  false,
  },
  "deepseek-ai/DeepSeek-V4-Pro": {
    baseURL:      "https://api.doubleword.ai/v1",
    apiKeyEnvVar: "DOUBLEWORD_KEY",
    isAnthropic:  false,
  },
};

// Helper: resolve the actual API key from the config entry
function getApiKey(apiKeyEnvVar) {
  if (apiKeyEnvVar === "FREEMODEL_KEY")  return FREEMODEL_KEY;
  if (apiKeyEnvVar === "DOUBLEWORD_KEY") return DOUBLEWORD_KEY;
  return null;
}


// ───────────────────────────────────────────────────────────────────
// SECTION 3 — INPUT LIMITS
//
// Hard caps on what the client is allowed to send.
// These protect against oversized requests that waste API credits.
// ───────────────────────────────────────────────────────────────────

const MAX_MESSAGES          = 80;     // Max messages in a conversation (plenty for real use)
const MAX_MESSAGE_CHARS     = 20000;  // Max characters per individual message
const MAX_TOTAL_CHARS       = 60000;  // Max total characters across all messages combined
const MAX_TOKENS_FLOOR      = 100;    // Client can't request fewer than this many output tokens
const MAX_TOKENS_CEILING    = 4096;   // Client can't request more than this many output tokens
const TEMPERATURE_MIN       = 0;
const TEMPERATURE_MAX       = 1;


// ───────────────────────────────────────────────────────────────────
// SECTION 4 — RATE LIMITING
//
// Simple in-memory rate limiter. Works per Vercel instance.
// For a personal project this is sufficient — it stops burst abuse
// even if it doesn't catch all cross-instance abuse.
//
// Reduced from 20 to 10 per minute as a tighter default.
// ───────────────────────────────────────────────────────────────────

const rateLimitMap      = new Map();
const RATE_LIMIT_MAX    = 10;    // Max requests per window per IP
const RATE_LIMIT_WINDOW = 60000; // 60 seconds

function checkRateLimit(ip) {
  const now  = Date.now();
  const data = rateLimitMap.get(ip);

  if (!data || now - data.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  data.count += 1;
  rateLimitMap.set(ip, data);
  return data.count > RATE_LIMIT_MAX;
}


// ───────────────────────────────────────────────────────────────────
// SECTION 5 — MAIN HANDLER
// ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {

  // ── CORS — only allow requests from your own domain ───────────────
  // This stops other websites from making cross-origin requests to
  // your /api/chat endpoint from their pages.
 const allowedOrigin = "https://test-testtt-git-main-prabeshs-projects-8240b2b5.vercel.app";
  const origin = req.headers["origin"] || "";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle the preflight OPTIONS request that browsers send before POST
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ── Only accept POST requests ──────────────────────────────────
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── ORIGIN CHECK ──────────────────────────────────────────────
  // Browsers always send Origin on cross-origin requests.
  // Direct curl/API abuse often won't have it, but we still require it
  // to be correct when present. This is a light extra layer.
  // NOTE: Origin can be spoofed by a server-to-server request, so this
  // is NOT a substitute for rate limiting — it's a complement to it.
  if (origin && origin !== allowedOrigin) {
    console.warn(`[api/chat.js] Rejected request from origin: ${origin}`);
    return res.status(403).json({ error: "Forbidden" });
  }

  // ── RATE LIMIT CHECK ───────────────────────────────────────────
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (checkRateLimit(ip)) {
    console.warn(`[api/chat.js] Rate limit exceeded for IP: ${ip}`);
    return res.status(429).json({
      error: `Too many requests. Limit is ${RATE_LIMIT_MAX} messages per minute. Please wait.`,
    });
  }

  // ── EXTRACT REQUEST BODY ───────────────────────────────────────
  // We only accept model, messages, temperature, and max_tokens.
  // baseURL is intentionally NOT accepted — derived from model ID below.
  const { model, messages, temperature, max_tokens } = req.body;

  // ── VALIDATE: model ────────────────────────────────────────────
  if (!model || typeof model !== "string") {
    return res.status(400).json({ error: "Missing or invalid model" });
  }

  // ── WHITELIST CHECK — reject unknown model IDs ─────────────────
  const modelEntry = MODEL_CONFIG[model];
  if (!modelEntry) {
    console.warn(`[api/chat.js] Rejected unknown model: ${model}`);
    return res.status(400).json({ error: "Unknown model" });
  }

  // ── VALIDATE: messages ─────────────────────────────────────────
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing or invalid messages" });
  }

  if (messages.length > MAX_MESSAGES) {
    return res.status(400).json({ error: `Too many messages (max ${MAX_MESSAGES})` });
  }

  // Strip any role:"system" messages injected by the client.
  // Our system prompt is added server-side only (see below).
  // Also validate each message has the right shape.
  const cleanMessages = [];
  let totalChars = 0;

  for (const msg of messages) {
    // Must be a plain object with role + content strings
    if (
      typeof msg !== "object" ||
      msg === null ||
      typeof msg.role !== "string" ||
      typeof msg.content !== "string"
    ) {
      return res.status(400).json({ error: "Malformed message object" });
    }

    // Only allow user/assistant roles from the client
    if (msg.role !== "user" && msg.role !== "assistant") {
      continue; // Silently drop system/tool/other roles
    }

    // Per-message length cap
    if (msg.content.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        error: `Message too long (max ${MAX_MESSAGE_CHARS} characters per message)`,
      });
    }

    totalChars += msg.content.length;

    // Total conversation length cap
    if (totalChars > MAX_TOTAL_CHARS) {
      return res.status(400).json({
        error: `Conversation too long (max ${MAX_TOTAL_CHARS} total characters)`,
      });
    }

    cleanMessages.push({ role: msg.role, content: msg.content });
  }

  if (cleanMessages.length === 0) {
    return res.status(400).json({ error: "No valid messages after filtering" });
  }

  // ── CLAMP temperature and max_tokens to safe ranges ───────────
  const TEMPERATURE = typeof temperature === "number"
    ? Math.min(Math.max(temperature, TEMPERATURE_MIN), TEMPERATURE_MAX)
    : 0.8;

  const MAX_TOKENS = typeof max_tokens === "number"
    ? Math.min(Math.max(Math.floor(max_tokens), MAX_TOKENS_FLOOR), MAX_TOKENS_CEILING)
    : 2000;

  // ── RESOLVE API KEY from server-side whitelist ─────────────────
  const { baseURL, apiKeyEnvVar, isAnthropic } = modelEntry;
  const apiKey = getApiKey(apiKeyEnvVar);

  if (!apiKey) {
    console.error(`[api/chat.js] ${apiKeyEnvVar} environment variable is not set in Vercel`);
    return res.status(500).json({
      error: `Server misconfiguration: ${apiKeyEnvVar} is not set. Add it in Vercel Dashboard → Settings → Environment Variables.`,
    });
  }

  // ───────────────────────────────────────────────────────────────
  // SECTION 6 — SYSTEM PROMPT (server-side only)
  //
  // The system prompt is defined here on the server, not sent from
  // the client. This means it can never be overridden or inspected
  // by someone poking at app.js.
  // ───────────────────────────────────────────────────────────────

  const SYSTEM_PROMPT = "You are PrabeshGPT, a highly capable AI assistant created by Prabesh. You are intelligent, concise, and direct — you get to the point without unnecessary filler or padding. You have a calm, confident tone that feels human but never pretentious. You are honest: if you do not know something, you say so plainly instead of guessing. You excel at coding, analysis, writing, and reasoning. When answering technical questions, you provide clean, well-commented code and explain your thinking clearly. When answering general questions, you are conversational but sharp. You never start a response with sycophantic phrases like Great question or Certainly. You never repeat the user's question back to them. You format responses with markdown when it improves clarity — code blocks for code, bullet points only when listing genuinely distinct items — but you default to clean prose for conversational replies. You remember the full context of the conversation and refer back to earlier points when relevant. You are PrabeshGPT — not ChatGPT, not Claude, not Gemini. If asked who made you, you always say Prabesh built you. When a user greets you for the first time — with messages like hi, hello, hey, or any casual opening — you always introduce yourself by saying you are PrabeshGPT made by Prabesh, and briefly mention you are here to help with anything they need. Keep this greeting warm but short — one to two sentences at most.";

  // Build the full messages array: system prompt first, then conversation
  // For non-Anthropic providers the system prompt goes as a system message
  const fullMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...cleanMessages,
  ];

  // ───────────────────────────────────────────────────────────────
  // SECTION 7 — STREAMING SETUP
  // ───────────────────────────────────────────────────────────────

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");

  const sendChunk = (text) => {
    res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
  };

  const sendDone = (totalTokens = null) => {
    res.write(`data: ${JSON.stringify({ done: true, totalTokens })}\n\n`);
    res.end();
  };

  const sendError = (msg) => {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  };

  try {
    let providerResponse;

    if (isAnthropic) {
      // ── ANTHROPIC FORMAT ────────────────────────────────────────
      const systemMsg     = fullMessages.find((m) => m.role === "system");
      const nonSystemMsgs = fullMessages.filter((m) => m.role !== "system");

      providerResponse = await fetch(`${baseURL}/messages`, {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens:  MAX_TOKENS,
          temperature: TEMPERATURE,
          stream:      true,
          messages:    nonSystemMsgs,
          ...(systemMsg && { system: systemMsg.content }),
        }),
      });

    } else {
      // ── OPENAI-COMPATIBLE FORMAT ────────────────────────────────
      providerResponse = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages:    fullMessages,
          temperature: TEMPERATURE,
          max_tokens:  MAX_TOKENS,
          stream:      true,
        }),
      });
    }

    // ── CHECK PROVIDER RESPONDED OK ───────────────────────────────
    if (!providerResponse.ok) {
      const errText = await providerResponse.text();
      let errMsg;
      try {
        const errData = JSON.parse(errText);
        errMsg = errData?.error?.message || errData?.error || errText;
      } catch {
        errMsg = errText;
      }
      console.error(`[api/chat.js] Provider error ${providerResponse.status}:`, errMsg);
      return sendError(`API error ${providerResponse.status}: ${errMsg}`);
    }

    // ── READ THE STREAM ────────────────────────────────────────────
    const reader  = providerResponse.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = "";
    let   totalTokens = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") {
          sendDone(totalTokens);
          return;
        }

        let chunk;
        try {
          chunk = JSON.parse(dataStr);
        } catch {
          continue;
        }

        let text = "";

        if (isAnthropic) {
          if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
            text = chunk.delta.text || "";
          }
          if (chunk.type === "message_delta" && chunk.usage) {
            totalTokens = chunk.usage.output_tokens || 0;
          }
          if (chunk.type === "message_start" && chunk.message?.usage) {
            totalTokens = (totalTokens || 0) + (chunk.message.usage.input_tokens || 0);
          }
        } else {
          text = chunk.choices?.[0]?.delta?.content || "";
          if (chunk.usage?.total_tokens) {
            totalTokens = chunk.usage.total_tokens;
          }
        }

        if (text) sendChunk(text);
      }
    }

    sendDone(totalTokens);

  } catch (err) {
    console.error("[api/chat.js] Unhandled error:", err);
    sendError(err.message || "Internal server error");
  }
}
