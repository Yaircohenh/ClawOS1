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
const MAX_CHARS = 1000;

// ── Template fallback ─────────────────────────────────────────────────────────
function templateUpdate(existing, userMessage, assistantResponse, _actionType) {
  // Parse turn count from existing summary
  const turnsMatch = existing.match(/^TURNS:\s*(\d+)$/m);
  const prevTurns = parseInt(turnsMatch?.[1] ?? "0", 10);

  // Preserve existing GOAL or derive from latest user message
  const goalMatch = existing.match(/^GOAL:\s*(.+)$/m);
  const goal = goalMatch?.[1] ?? userMessage.slice(0, 150);

  // Preserve existing ENTITIES; add nothing (template can't extract reliably)
  const entitiesMatch = existing.match(/^ENTITIES:\s*(.*)$/m);
  const entities = entitiesMatch?.[1] ?? "";

  // Preserve existing DECISIONS
  const decisionsMatch = existing.match(/^DECISIONS:\s*(.*)$/m);
  const decisions = decisionsMatch?.[1] ?? "";

  // Derive PENDING from assistant response (very rough heuristic)
  const pending = assistantResponse.includes("?") ? "follow-up question pending" : "";

  return [
    `GOAL: ${goal.slice(0, 200)}`,
    `ENTITIES: ${entities.slice(0, 200)}`,
    `DECISIONS: ${decisions.slice(0, 200)}`,
    `PENDING: ${pending}`,
    `TURNS: ${prevTurns + 1}`,
  ]
    .join("\n")
    .slice(0, MAX_CHARS);
}

// ── LLM-based update ──────────────────────────────────────────────────────────
async function llmUpdate(apiKey, { existing, userMessage, assistantResponse, actionType }) {
  const prompt =
    `You are a session context tracker. Update the session summary with the latest turn.\n\n` +
    `CURRENT SUMMARY:\n${existing || "(empty)"}\n\n` +
    `LATEST TURN:\n` +
    `User: ${userMessage.slice(0, 400)}\n` +
    `Action: ${actionType}\n` +
    `Assistant: ${assistantResponse.slice(0, 400)}\n\n` +
    `Return ONLY a summary in this exact format (total ≤ 900 chars):\n` +
    `GOAL: <current objective in 1-2 sentences>\n` +
    `ENTITIES: <key names, files, URLs — comma separated, max 6 items>\n` +
    `DECISIONS: <choices made — comma separated, max 4 items>\n` +
    `PENDING: <unanswered questions or items awaiting action — comma separated>\n` +
    `TURNS: <total turn count as integer>`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 350,
      messages: [{ role: "user", content: prompt }],
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

  // Try Anthropic LLM first
  if (db) {
    const secrets = getSecret(db, "anthropic");
    if (secrets?.api_key) {
      try {
        return await llmUpdate(secrets.api_key, {
          existing,
          userMessage: userMsg,
          assistantResponse: asstResp,
          actionType: actType,
        });
      } catch {
        // Fall through to template
      }
    }
  }

  // Template fallback — always works
  return templateUpdate(existing, userMsg, asstResp, actType);
}
