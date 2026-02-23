/**
 * chat_llm — Direct conversational LLM response
 *
 * Default route for WhatsApp messages that are not tool invocations.
 * Calls xAI (Grok) or Anthropic directly to produce a conversational reply.
 *
 * payload: { message, context_summary? }
 * returns: { reply, provider, model }
 *        | { reply: null, provider: "error",  error: "<provider error detail>" }
 *        | { reply: null, provider: "none",   error: "No LLM provider configured…" }
 */
import { getSecret, listProviders } from "../connections.js";

const XAI_MODEL       = "grok-3-mini";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a helpful personal AI assistant communicating via WhatsApp.
Respond naturally and helpfully to the user's message.

RULES:
1. Be concise and conversational — this is WhatsApp, not a document
2. Follow the user's explicit formatting or content instructions exactly
3. If the user asks you to reply with a specific string, output that string and nothing else
4. Use *bold* sparingly, only for key terms
5. Never start with "Sure!", "Certainly!", or "Of course!"
6. Keep replies under 300 words unless the content genuinely requires more`;

// ── xAI (Grok) chat ────────────────────────────────────────────────────────────
async function chatWithXai(message, contextSummary, apiKey) {
  const messages = [];
  if (contextSummary) {
    messages.push({ role: "user",      content: `Conversation context:\n${contextSummary}` });
    messages.push({ role: "assistant", content: "Understood, I have the context." });
  }
  messages.push({ role: "user", content: message });

  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:       XAI_MODEL,
      max_tokens:  1024,
      temperature: 0.7,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    }),
  });

  if (!r.ok) {
    // Read body so callers can surface the real rejection reason (e.g. safety policy)
    let errBody = "";
    try { errBody = await r.text(); } catch { /* ignore */ }
    throw new Error(`xAI ${r.status}: ${errBody.slice(0, 300)}`);
  }
  const data  = await r.json();
  const reply = data.choices?.[0]?.message?.content ?? "";
  if (!reply)  { throw new Error("xAI returned empty reply"); }
  return { reply, provider: "xai", model: XAI_MODEL };
}

// ── Anthropic (Claude Haiku) chat ─────────────────────────────────────────────
async function chatWithAnthropic(message, contextSummary, apiKey) {
  const userContent = contextSummary
    ? `Conversation context:\n${contextSummary}\n\n${message}`
    : message;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":       "application/json",
      "x-api-key":          apiKey,
      "anthropic-version":  "2023-06-01",
    },
    body: JSON.stringify({
      model:      ANTHROPIC_MODEL,
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userContent }],
    }),
  });

  if (!r.ok) {
    let errBody = "";
    try { errBody = await r.text(); } catch { /* ignore */ }
    throw new Error(`Anthropic ${r.status}: ${errBody.slice(0, 300)}`);
  }
  const data  = await r.json();
  const reply = data.content?.[0]?.text ?? "";
  if (!reply)  { throw new Error("Anthropic returned empty reply"); }
  return { reply, provider: "anthropic", model: ANTHROPIC_MODEL };
}

// ── Action definition ──────────────────────────────────────────────────────────
export const action = {
  name:        "chat_llm",
  writes:      false,
  risk_level:  "low",
  reversible:  true,
  description: "Direct conversational LLM response — default route for non-tool messages",

  async run(req, ctx) {
    const { message, context_summary } = req.payload ?? {};
    if (!message || typeof message !== "string") {
      throw new Error("payload.message (string) is required");
    }
    const ctxSummary = context_summary ?? null;

    // ── Provider lookup with observability ────────────────────────────────────
    let lastError  = null;  // set when a provider IS configured but throws
    let configured = [];    // provider names that have keys

    if (ctx?.db) {
      configured = listProviders(ctx.db);

      // Try xAI (Grok) first — preferred when configured
      const xai = getSecret(ctx.db, "xai");
      if (xai?.api_key) {
        try {
          return await chatWithXai(message, ctxSummary, xai.api_key);
        } catch (err) {
          lastError = err;
          console.warn(`[chat_llm] xAI failed: ${err.message}`);
        }
      }

      // Try Anthropic second
      const anthropic = getSecret(ctx.db, "anthropic");
      if (anthropic?.api_key) {
        try {
          return await chatWithAnthropic(message, ctxSummary, anthropic.api_key);
        } catch (err) {
          lastError = err;
          console.warn(`[chat_llm] Anthropic failed: ${err.message}`);
        }
      }
    }

    // ── Error reporting ────────────────────────────────────────────────────────
    // Distinguish "provider configured but rejected the request" from
    // "no provider credentials exist at all" — these must not show the same message.
    if (lastError) {
      // At least one provider had a key but the request failed (e.g. xAI 403 safety filter)
      console.warn(`[chat_llm] all providers failed; configured=${configured.join(",")}`);
      return {
        reply:    null,
        provider: "error",
        model:    null,
        configured,
        error:    `AI provider request failed: ${lastError.message}`,
      };
    }

    // Truly no credentials in the DB
    console.warn(`[chat_llm] no provider configured; DB providers=${configured.join(",") || "(none)"}`);
    return {
      reply:    null,
      provider: "none",
      model:    null,
      configured,
      error:    "No LLM provider configured. Add an xAI or Anthropic API key in Settings → Connections.",
    };
  },
};
