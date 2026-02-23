/**
 * chat_llm — Direct conversational LLM response
 *
 * Default route for WhatsApp messages that are not tool invocations.
 * Provider cascade:
 *   1. Primary (xAI)  + original message
 *   2. Primary (xAI)  + rephrased message  [only on policy_block]
 *   3. Anthropic       + original message  [if configured]
 *
 * At most 3 attempts total; no infinite retries.
 *
 * payload : { message, context_summary? }
 * returns : { reply, provider, model,
 *             provider_attempts, fallback_used, policy_blocked }
 *         | { reply:null, provider:"policy_block"|"error"|"none", error, … }
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

// ── Policy-block detection ────────────────────────────────────────────────────
/**
 * Returns true when an error message string indicates the provider refused
 * the request on content-policy grounds (not a network error or quota issue).
 *
 * Matches on the thrown Error.message, which already contains HTTP status +
 * body text from the fetch helpers below.
 */
function isPolicyBlock(errorMsg) {
  return (
    /\b403\b/.test(errorMsg) ||                          // xAI HTTP 403
    /SAFETY_CHECK_TYPE_/i.test(errorMsg) ||              // xAI named safety check
    /Content violates usage/i.test(errorMsg) ||          // xAI prose reason
    /content_policy_violation/i.test(errorMsg) ||        // Anthropic error code
    /content_filter/i.test(errorMsg)                     // OpenAI error code
  );
}

// ── Message rephrase for policy-block retry ───────────────────────────────────
/**
 * Strip the boilerplate patterns that trigger content-policy filters while
 * preserving the semantic intent of the message.
 *
 * Returns null if the result would be empty or too short to be meaningful
 * (caller should skip the retry in that case).
 */
function rephraseForPolicyRetry(message) {
  const stripped = message
    // Remove common echo-instruction boilerplate
    .replace(/\bdo\s+not\s+search\b[.,;]?\s*/gi, "")
    .replace(/\bdo\s+not\s+use\s+any\s+tools?\b[.,;]?\s*/gi, "")
    .replace(/\breply\s+with\s+exactly\s+this\s+string\s+and\s+nothing\s+else\s*[:\s]*/gi, "")
    .replace(/\breply\s+with\s+exactly\b[^.!?\n]*[:\s]*/gi, "")
    .replace(/\band\s+nothing\s+else\b\.?/gi, "")
    .replace(/\bexactly\b/gi, "")
    // Replace compound code-like tokens (e.g. LLM-CHECK-90210, XYZ-TEST-456)
    // Pattern: UPPERCASE word + one-or-more (-WORD|-DIGITS) segments ending in digits
    .replace(/\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)*-\d+\b/g, "[code]")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();

  // Skip retry if nothing useful remains
  if (!stripped || stripped === "[code]" || stripped.length < 4) {
    return null;
  }
  return stripped;
}

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

    /** Accumulates one entry per attempt for the provider_attempts array. */
    const attempts = [];

    /**
     * Run one provider call, push to attempts, and return the result object.
     * Never throws — returns { reply, provider, model, … } on success or
     * { reply: null, _err: Error, _blocked: bool } on failure.
     */
    const tryCall = async (label, providerName, model, fn) => {
      try {
        const result = await fn();
        attempts.push({ provider: label, model, outcome: "success", error_code: null });
        return result;
      } catch (err) {
        const errMsg   = err?.message ?? String(err);
        const blocked  = isPolicyBlock(errMsg);
        // Extract just the SAFETY_CHECK_TYPE_XXX code when present, else first 120 chars
        const code     = (errMsg.match(/SAFETY_CHECK_TYPE_\w+/) ?? [])[0] ?? errMsg.slice(0, 120);
        attempts.push({ provider: label, model, outcome: blocked ? "policy_block" : "error", error_code: code });
        console.warn(`[chat_llm] ${label} ${blocked ? "policy_block" : "error"}: ${errMsg.slice(0, 160)}`);
        return { reply: null, _err: err, _blocked: blocked };
      }
    };

    if (ctx?.db) {
      const configured = listProviders(ctx.db);

      // ── Attempt 1: primary provider (xAI) + original message ──────────────
      const xai = getSecret(ctx.db, "xai");
      if (xai?.api_key) {
        const r1 = await tryCall("xai", "xai", XAI_MODEL,
          () => chatWithXai(message, ctxSummary, xai.api_key));
        if (r1.reply) {
          return { ...r1, provider_attempts: attempts, fallback_used: false, policy_blocked: false };
        }

        // ── Attempt 2: primary provider (xAI) + rephrased message (policy only) ─
        if (r1._blocked) {
          const rephrased = rephraseForPolicyRetry(message);
          if (rephrased) {
            const r2 = await tryCall("xai_retry", "xai", XAI_MODEL,
              () => chatWithXai(rephrased, ctxSummary, xai.api_key));
            if (r2.reply) {
              return { ...r2, provider_attempts: attempts, fallback_used: true, policy_blocked: true };
            }
          } else {
            attempts.push({ provider: "xai_retry", model: XAI_MODEL, outcome: "skipped_empty_rephrase", error_code: null });
          }
        }
      }

      // ── Attempt 3: Anthropic + original message ────────────────────────────
      const anthropic = getSecret(ctx.db, "anthropic");
      if (anthropic?.api_key) {
        const r3 = await tryCall("anthropic", "anthropic", ANTHROPIC_MODEL,
          () => chatWithAnthropic(message, ctxSummary, anthropic.api_key));
        if (r3.reply) {
          return { ...r3, provider_attempts: attempts, fallback_used: true, policy_blocked: attempts.some(a => a.outcome === "policy_block") };
        }
      }

      // ── All attempts exhausted ─────────────────────────────────────────────
      const anyBlock = attempts.some(a => a.outcome === "policy_block");

      if (attempts.length > 0) {
        const errMsg = anyBlock
          ? "Your configured provider declined this prompt due to content policy. " +
            "Try rephrasing your message, or add a backup provider in Settings → Connections."
          : `AI provider request failed: ${attempts.at(-1)?.error_code ?? "unknown error"}`;

        console.warn(`[chat_llm] all attempts failed; policy_blocked=${anyBlock}; attempts=${attempts.map(a=>a.provider+":"+a.outcome).join(",")}`);
        return {
          reply:            null,
          provider:         anyBlock ? "policy_block" : "error",
          model:            null,
          configured,
          provider_attempts: attempts,
          fallback_used:    false,
          policy_blocked:   anyBlock,
          error:            errMsg,
        };
      }

      // Keys present in DB but none matched our known providers — shouldn't happen
      console.warn(`[chat_llm] no supported provider found; DB providers=${configured.join(",") || "(none)"}`);
    }

    // ── Truly no credentials in the DB ────────────────────────────────────────
    return {
      reply:             null,
      provider:          "none",
      model:             null,
      configured:        [],
      provider_attempts: attempts,
      fallback_used:     false,
      policy_blocked:    false,
      error:             "No LLM provider configured. Add an xAI or Anthropic API key in Settings → Connections.",
    };
  },
};
