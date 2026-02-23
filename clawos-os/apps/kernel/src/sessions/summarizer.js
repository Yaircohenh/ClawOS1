/**
 * Context summarizer — keeps a compact, structured session context.
 *
 * After each turn, updateSummary() produces a new context_summary string
 * (≤ 1000 chars) with this deterministic format:
 *
 *   GOAL: <current user objective>
 *   ENTITIES: <key names, files, URLs — comma separated>
 *   DECISIONS: <choices made this session — comma separated>
 *   PENDING: <unanswered questions or pending items>
 *   TURNS: <N>
 *
 * Uses Claude Haiku if an Anthropic key is configured; falls back to
 * a lightweight template extractor otherwise.
 */
import { getSecret } from "../orchestrator/connections.js";

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const XAI_MODEL       = "grok-3-mini";
const MAX_CHARS = 1000;

// ── Template fallback ─────────────────────────────────────────────────────────
function templateUpdate(existing, userMessage, assistantResponse, _actionType) {
  // Parse turn count from existing summary
  const turnsMatch = existing.match(/^TURNS:\s*(\d+)$/m);
  const prevTurns = parseInt(turnsMatch?.[1] ?? "0", 10);

  // Build a compact narrative of this turn so follow-ups have real content
  const userSnippet  = userMessage.slice(0, 150);
  const replySnippet = assistantResponse.slice(0, 250);

  // Preserve existing history, prepend latest turn
  const existingHistory = existing.replace(/^TURNS:\s*\d+\n?/m, "").trim();
  const thisExchange    = `[Turn ${prevTurns + 1}] User: ${userSnippet}\nAssistant: ${replySnippet}`;

  const combined = existingHistory
    ? `${existingHistory}\n\n${thisExchange}`
    : thisExchange;

  return [
    combined.slice(0, MAX_CHARS - 20),
    `\nTURNS: ${prevTurns + 1}`,
  ].join("").slice(0, MAX_CHARS);
}

// ── Shared summary prompt ──────────────────────────────────────────────────────
function buildSummaryPrompt(existing, userMessage, assistantResponse, actionType) {
  return (
    `You are a session context tracker. Update the session summary with the latest turn.\n\n` +
    `CURRENT SUMMARY:\n${existing || "(empty)"}\n\n` +
    `LATEST TURN:\n` +
    `User: ${userMessage.slice(0, 400)}\n` +
    `Action: ${actionType}\n` +
    `Assistant: ${assistantResponse.slice(0, 400)}\n\n` +
    `Write a SHORT plain-text summary (≤ 900 chars) of what was discussed so far. ` +
    `Include the key facts from the assistant's response so follow-up questions have context. ` +
    `Do NOT output JSON or structured fields. End with "TURNS: <integer>".`
  );
}

// ── xAI (Grok) summarizer ──────────────────────────────────────────────────────
async function xaiUpdate(apiKey, { existing, userMessage, assistantResponse, actionType }) {
  const prompt = buildSummaryPrompt(existing, userMessage, assistantResponse, actionType);

  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:       XAI_MODEL,
      max_tokens:  350,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!r.ok) { throw new Error(`xAI returned HTTP ${r.status}`); }
  const data = await r.json();
  return (data.choices?.[0]?.message?.content ?? "").trim().slice(0, MAX_CHARS);
}

// ── Anthropic (Claude Haiku) summarizer ───────────────────────────────────────
async function llmUpdate(apiKey, { existing, userMessage, assistantResponse, actionType }) {
  const prompt = buildSummaryPrompt(existing, userMessage, assistantResponse, actionType);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":       "application/json",
      "x-api-key":          apiKey,
      "anthropic-version":  "2023-06-01",
    },
    body: JSON.stringify({
      model:      ANTHROPIC_MODEL,
      max_tokens: 350,
      messages:   [{ role: "user", content: prompt }],
    }),
  });

  if (!r.ok) {
    throw new Error(`Anthropic returned HTTP ${r.status}`);
  }

  const data = await r.json();
  return (data.content?.[0]?.text ?? "").trim().slice(0, MAX_CHARS);
}

/**
 * Produce an updated context_summary for the session.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   existing_summary: string;
 *   user_message: string;
 *   assistant_response: string;
 *   action_type: string;
 * }} opts
 * @returns {Promise<string>}
 */
export async function updateSummary(db, { existing_summary, user_message, assistant_response, action_type }) {
  const existing = String(existing_summary ?? "");
  const userMsg  = String(user_message ?? "").slice(0, 600);
  const asstResp = String(assistant_response ?? "").slice(0, 600);
  const actType  = String(action_type ?? "");

  if (db) {
    // Try xAI (Grok) first — preferred when configured
    const xaiSecrets = getSecret(db, "xai");
    if (xaiSecrets?.api_key) {
      try {
        return await xaiUpdate(xaiSecrets.api_key, {
          existing, userMessage: userMsg, assistantResponse: asstResp, actionType: actType,
        });
      } catch { /* fall through */ }
    }

    // Try Anthropic second
    const anthropicSecrets = getSecret(db, "anthropic");
    if (anthropicSecrets?.api_key) {
      try {
        return await llmUpdate(anthropicSecrets.api_key, {
          existing, userMessage: userMsg, assistantResponse: asstResp, actionType: actType,
        });
      } catch { /* fall through */ }
    }
  }

  // Template fallback — always works
  return templateUpdate(existing, userMsg, asstResp, actType);
}
