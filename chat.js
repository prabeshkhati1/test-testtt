// ═══════════════════════════════════════════════════════════════════
// api/chat.js — Vercel Serverless Function
//
// This is the ONLY file that ever touches API keys.
// The browser (app.js) sends messages and receives replies,
// but NEVER sees the actual keys — they live here, loaded from
// Vercel environment variables at runtime.
//
// HOW IT WORKS (simple overview):
//   1. Browser sends POST /api/chat with { model, messages, baseURL }
//   2. This function figures out which API key to use (by provider URL)
//   3. It forwards the request to the real AI provider (DeepSeek, OpenAI, etc.)
//   4. It streams the reply back to the browser in real-time
//   5. Browser shows tokens as they arrive instead of waiting for the full reply
// ═══════════════════════════════════════════════════════════════════


// ───────────────────────────────────────────────────────────────────
// SECTION 1 — API KEYS
//
// These are read from Vercel environment variables, NOT hardcoded.
// To set them: Vercel Dashboard → Your Project → Settings → Environment Variables
//   Add: DOUBLEWORD_KEY = sk-...
//   Add: FREEMODEL_KEY  = fe_oa_...
//   Add: CLIENT_SECRET  = any random string you choose (e.g. "myprivateapp42")
//
// The CLIENT_SECRET is like a password — app.js sends it with every
// request so random people on the internet can't use your /api/chat endpoint.
// ───────────────────────────────────────────────────────────────────

// process.env reads the variable you set in Vercel's dashboard
const DOUBLEWORD_KEY  = process.env.DOUBLEWORD_KEY;   // For DeepSeek, Gemma, Kimi models
const FREEMODEL_KEY   = process.env.FREEMODEL_KEY;    // For GPT-4o Mini and Claude models
const CLIENT_SECRET   = process.env.CLIENT_SECRET;    // Our shared secret for basic auth

// ───────────────────────────────────────────────────────────────────
// SECTION 2 — RATE LIMITING
//
// This is a simple in-memory rate limiter.
// It tracks how many requests each IP address has made in the last minute.
// If they go over the limit, we reject their request with a 429 error.
//
// ⚠️  NOTE: Because Vercel serverless functions can spin up multiple
// instances, this in-memory store is per-instance. In practice for a
// personal app this is totally fine — it still blocks burst abuse.
// ───────────────────────────────────────────────────────────────────

const rateLimitMap = new Map(); // Stores { count, windowStart } per IP

const RATE_LIMIT_MAX      = 20;    // Max requests allowed per window
const RATE_LIMIT_WINDOW   = 60000; // Time window in milliseconds (60 seconds)

/**
 * checkRateLimit(ip)
 * Returns true if the request should be BLOCKED (too many requests).
 * Returns false if the request is fine to proceed.
 */
function checkRateLimit(ip) {
  const now  = Date.now();
  const data = rateLimitMap.get(ip);

  if (!data || now - data.windowStart > RATE_LIMIT_WINDOW) {
    // Either first request from this IP, or window has expired — reset counter
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false; // Not rate limited
  }

  // IP has made requests before within the current window
  data.count += 1;
  rateLimitMap.set(ip, data);

  if (data.count > RATE_LIMIT_MAX) {
    return true; // Too many requests — block this one
  }

  return false; // Still within limit
}

// ───────────────────────────────────────────────────────────────────
// SECTION 3 — PROVIDER KEY RESOLVER
//
// Looks at the baseURL (e.g. "https://api.doubleword.ai/v1") and
// returns the right API key for that provider.
// ───────────────────────────────────────────────────────────────────

/**
 * resolveApiKey(baseURL)
 * Given a provider's base URL, return the correct API key.
 */
function resolveApiKey(baseURL = "") {
  if (baseURL.includes("freemodel.dev")) return FREEMODEL_KEY;  // GPT-4o Mini + Claude
  if (baseURL.includes("doubleword.ai")) return DOUBLEWORD_KEY; // DeepSeek, Gemma, Kimi
  return DOUBLEWORD_KEY; // Default fallback — update if you add a third provider
}

// ───────────────────────────────────────────────────────────────────
// SECTION 4 — MAIN HANDLER
//
// Vercel calls this function whenever someone POSTs to /api/chat.
// It validates the request, then calls the AI provider and streams
// the response back.
// ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {

  // ── Only accept POST requests ──────────────────────────────────
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── BASIC AUTH CHECK ───────────────────────────────────────────
  // Check the x-client-secret header matches our CLIENT_SECRET env var.
  // This prevents strangers from using your /api/chat endpoint.
  //
  // app.js sends this header with every request.
  // If CLIENT_SECRET isn't set in Vercel, we skip this check (dev mode).
  if (CLIENT_SECRET && req.headers["x-client-secret"] !== CLIENT_SECRET) {
    console.warn("[api/chat.js] Rejected request — bad or missing x-client-secret");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── RATE LIMIT CHECK ───────────────────────────────────────────
  // Get the requester's IP from headers (Vercel sets x-forwarded-for)
  // and check if they've made too many requests recently.
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (checkRateLimit(ip)) {
    console.warn(`[api/chat.js] Rate limit exceeded for IP: ${ip}`);
    return res.status(429).json({
      error: `Too many requests. You can send up to ${RATE_LIMIT_MAX} messages per minute. Please wait a moment.`
    });
  }

  // ── EXTRACT REQUEST BODY ───────────────────────────────────────
  // Pull out everything the browser sent us.
  // Note: we intentionally do NOT accept an apiKey from the browser.
  const { model, messages, baseURL, temperature, max_tokens } = req.body;

  // ── VALIDATE INPUTS ────────────────────────────────────────────
  if (!model) {
    return res.status(400).json({ error: "Missing model" });
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing or invalid messages" });
  }
  if (!baseURL) {
    return res.status(400).json({ error: "Missing baseURL" });
  }

  // ── RESOLVE API KEY ────────────────────────────────────────────
  const apiKey = resolveApiKey(baseURL);

  // Guard: if the env var isn't set, fail with a clear error message
  if (!apiKey) {
    const which = baseURL.includes("freemodel.dev") ? "FREEMODEL_KEY" : "DOUBLEWORD_KEY";
    console.error(`[api/chat.js] ${which} environment variable is not set in Vercel`);
    return res.status(500).json({
      error: `Server misconfiguration: ${which} is not set. Go to Vercel Dashboard → Settings → Environment Variables and add it.`,
    });
  }

  // ── DEFAULTS FOR OPTIONAL PARAMS ──────────────────────────────
  const TEMPERATURE = typeof temperature === "number" ? temperature : 0.7;
  const MAX_TOKENS  = typeof max_tokens  === "number" ? max_tokens  : 1024;

  // ── DETECT PROVIDER FORMAT ─────────────────────────────────────
  // cc.freemodel.dev uses Anthropic's native API format (different headers + body)
  // Everything else uses OpenAI-compatible format (DeepSeek, GPT, Gemma, Kimi)
  const isAnthropic = baseURL.includes("cc.freemodel.dev");

  // ───────────────────────────────────────────────────────────────
  // SECTION 5 — STREAMING SETUP
  //
  // Instead of waiting for the full reply and sending it all at once,
  // we stream tokens as they come in. This makes the UI feel much
  // faster and more responsive — you see words appearing in real-time.
  //
  // We use Server-Sent Events (SSE) format, which is what OpenAI and
  // Anthropic both use for streaming. Each chunk looks like:
  //   data: {"choices":[{"delta":{"content":"Hello"}}]}
  //
  // The browser reads these chunks and appends text progressively.
  // ───────────────────────────────────────────────────────────────

  // Tell the browser: this is a streaming SSE response, keep connection open
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");

  // Helper: send one SSE chunk to the browser
  // Format: "data: <json>\n\n"
  const sendChunk = (text) => {
    res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
  };

  // Helper: tell the browser the stream is done
  const sendDone = (totalTokens = null) => {
    res.write(`data: ${JSON.stringify({ done: true, totalTokens })}\n\n`);
    res.end();
  };

  // Helper: send an error through the stream (so the browser can display it)
  const sendError = (msg) => {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  };

  try {
    let providerResponse; // The raw fetch response from the AI provider

    if (isAnthropic) {
      // ── ANTHROPIC FORMAT (Claude models via cc.freemodel.dev) ──
      // Anthropic separates the system prompt as a top-level field,
      // and uses x-api-key instead of Authorization: Bearer.

      const systemMsg     = messages.find((m) => m.role === "system");    // Extract system prompt
      const nonSystemMsgs = messages.filter((m) => m.role !== "system");  // Everything else

      providerResponse = await fetch(`${baseURL}/messages`, {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         apiKey,          // Uses FREEMODEL_KEY
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens:  MAX_TOKENS,
          temperature: TEMPERATURE,
          stream:      true,                    // ← Enable streaming
          messages:    nonSystemMsgs,
          ...(systemMsg && { system: systemMsg.content }), // Only add if we have a system prompt
        }),
      });

    } else {
      // ── OPENAI-COMPATIBLE FORMAT (DeepSeek, GPT, Gemma, Kimi) ──
      // These all use the same OpenAI-style API — just Authorization: Bearer.

      providerResponse = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${apiKey}`, // Uses DOUBLEWORD_KEY or FREEMODEL_KEY
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: TEMPERATURE,
          max_tokens:  MAX_TOKENS,
          stream:      true,                   // ← Enable streaming
        }),
      });
    }

    // ── CHECK PROVIDER RESPONDED OK ───────────────────────────────
    if (!providerResponse.ok) {
      // Provider returned an error — read it and forward to the browser
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
    // The provider sends a stream of SSE chunks.
    // We read them line by line, extract the text content, and forward
    // each piece to the browser immediately.

    const reader  = providerResponse.body.getReader();     // Raw stream reader
    const decoder = new TextDecoder();                     // Converts bytes to text
    let   buffer  = "";                                    // Accumulates partial lines
    let   totalTokens = null;                              // Will be set when stream ends

    while (true) {
      const { done, value } = await reader.read(); // Read next chunk of bytes

      if (done) break; // Stream ended — exit the loop

      // Decode bytes to text and add to our buffer
      buffer += decoder.decode(value, { stream: true });

      // Split buffer into individual lines
      // SSE format sends lines ending in \n, events separated by \n\n
      const lines = buffer.split("\n");

      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines (SSE uses blank lines as event separators)
        if (!trimmed) continue;

        // SSE lines start with "data: " — strip that prefix
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();

        // "[DONE]" is the standard signal that the stream has ended
        if (dataStr === "[DONE]") {
          sendDone(totalTokens);
          return;
        }

        // Parse the JSON chunk
        let chunk;
        try {
          chunk = JSON.parse(dataStr);
        } catch {
          continue; // Skip any malformed lines
        }

        // ── Extract text content from the chunk ──────────────────
        // OpenAI format:  chunk.choices[0].delta.content
        // Anthropic format: chunk.delta.text  (when type is "content_block_delta")
        let text = "";

        if (isAnthropic) {
          // Anthropic streaming events have different types
          if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
            text = chunk.delta.text || "";
          }
          // Anthropic sends usage in the "message_delta" event at the end
          if (chunk.type === "message_delta" && chunk.usage) {
            totalTokens = (chunk.usage.output_tokens || 0);
          }
          // Anthropic also sends input token count in message_start
          if (chunk.type === "message_start" && chunk.message?.usage) {
            totalTokens = (totalTokens || 0) + (chunk.message.usage.input_tokens || 0);
          }
        } else {
          // OpenAI-compatible: text lives in choices[0].delta.content
          text = chunk.choices?.[0]?.delta?.content || "";

          // Some providers include usage info in the final chunk
          if (chunk.usage?.total_tokens) {
            totalTokens = chunk.usage.total_tokens;
          }
        }

        // If we got text, send it to the browser immediately
        if (text) {
          sendChunk(text);
        }
      }
    }

    // Stream ended normally (no [DONE] marker sent — happens with some providers)
    sendDone(totalTokens);

  } catch (err) {
    // Something unexpected went wrong (network error, etc.)
    console.error("[api/chat.js] Unhandled error:", err);
    sendError(err.message || "Internal server error");
  }
}
