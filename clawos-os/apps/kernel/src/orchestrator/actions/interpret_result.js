/**
 * interpret_result — Format raw action output into a friendly WhatsApp message
 *
 * Takes the raw output from any kernel action (shell stdout, search results,
 * file content, etc.) and uses an LLM to produce a concise, conversational
 * reply suitable for WhatsApp.
 *
 * Falls back to raw text when no LLM is available.
 *
 * payload: { action_type, original_query, raw_output }
 * returns: { formatted }
 */
import { getSecret } from "../connections.js";

const XAI_MODEL = "grok-3-mini";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a helpful personal assistant communicating via WhatsApp.
The user sent a command or question and the system ran it. Format the result into a friendly reply.

RULES:
1. Be concise and conversational — not robotic or overly formal
2. Keep responses under 300 words unless the content truly requires more
3. Use WhatsApp formatting only: *bold* for headings, plain text elsewhere
4. For shell output: summarize the key information clearly — never dump raw output
5. For search results: extract the most relevant facts and present them naturally as prose
6. For file reads/writes: briefly describe what was done
7. Suggest a natural next step when it's obvious
8. Never start with "Sure!", "Certainly!", or "Of course!"
9. If there was an error: explain it simply and suggest what to try instead
10. Numbers and data: present them cleanly (e.g. "171 GB used of 228 GB total")

OUTPUT FORMAT: Always write natural conversational prose. NEVER output JSON, YAML, code blocks, or any structured data format — even if the user asked for a list of items. Use numbered or bulleted plain text lists at most.

The user's original request is provided for context so you can tailor the reply.`;

// ── xAI (Grok) formatter ───────────────────────────────────────────────────────
async function formatWithXai(actionType, originalQuery, rawOutput, apiKey) {
  const userMsg =
    `Action type: ${actionType}\n` +
    `User asked: ${originalQuery}\n\n` +
    `Result:\n${rawOutput}`;

  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      max_tokens: 500,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    }),
  });

  if (!r.ok) {throw new Error(`xAI returned HTTP ${r.status}`);}
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? rawOutput;
}

// ── Anthropic (Claude Haiku) formatter ────────────────────────────────────────
async function formatWithAnthropic(actionType, originalQuery, rawOutput, apiKey) {
  const userMsg =
    `Action type: ${actionType}\n` +
    `User asked: ${originalQuery}\n\n` +
    `Result:\n${rawOutput}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!r.ok) {throw new Error(`Anthropic returned HTTP ${r.status}`);}
  const data = await r.json();
  return data.content?.[0]?.text ?? rawOutput;
}

// ── Action definition ──────────────────────────────────────────────────────────
export const action = {
  name: "interpret_result",
  writes: false,
  risk_level: "low",
  reversible: true,
  description: "Format raw action output into a friendly WhatsApp response",

  async run(req, ctx) {
    const { action_type, original_query, raw_output } = req.payload ?? {};

    if (typeof raw_output !== "string") {
      throw new Error("payload.raw_output (string) is required");
    }

    const atype = String(action_type ?? "unknown");
    const query = String(original_query ?? "");

    if (ctx?.db) {
      // Try xAI (Grok) first — preferred when configured
      const xai = getSecret(ctx.db, "xai");
      if (xai?.api_key) {
        try {
          const formatted = await formatWithXai(atype, query, raw_output, xai.api_key);
          return { formatted, provider: "xai" };
        } catch {
          // Fall through to Anthropic
        }
      }

      // Try Anthropic (Claude Haiku) second
      const anthropic = getSecret(ctx.db, "anthropic");
      if (anthropic?.api_key) {
        try {
          const formatted = await formatWithAnthropic(atype, query, raw_output, anthropic.api_key);
          return { formatted, provider: "anthropic" };
        } catch {
          // Fall through to passthrough
        }
      }
    }

    // No LLM available — return raw output as-is
    return { formatted: raw_output, provider: "passthrough" };
  },
};
