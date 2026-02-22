/**
 * Topic-drift classifier — optional session continuity gate.
 *
 * Feature flag: set ENABLE_SESSION_DRIFT_CLASSIFIER=true to enable.
 * Safe default: CONTINUE (returns "continue" when disabled or uncertain).
 *
 * When enabled, uses Claude Haiku to decide whether the new user message
 * is a CONTINUATION of the current session goal or a completely new topic.
 * Only returns "new" if confidence ≥ 0.80 — errs strongly on the side
 * of continuing the session.
 */
import { getSecret } from "../orchestrator/connections.js";

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const NEW_CONFIDENCE_THRESHOLD = 0.80;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ context_summary: string; user_message: string }} opts
 * @returns {Promise<{ decision: "continue" | "new"; confidence: number; reason: string }>}
 */
export async function classifyDrift(db, { context_summary, user_message }) {
  // Fast path — feature flag off
  if (process.env.ENABLE_SESSION_DRIFT_CLASSIFIER !== "true") {
    return { decision: "continue", confidence: 1.0, reason: "classifier_disabled" };
  }

  // No existing context — cannot meaningfully classify
  if (!context_summary || !context_summary.trim()) {
    return { decision: "continue", confidence: 1.0, reason: "no_existing_context" };
  }

  // No API key — safe default
  const secrets = db ? getSecret(db, "anthropic") : null;
  if (!secrets?.api_key) {
    return { decision: "continue", confidence: 1.0, reason: "no_api_key" };
  }

  const prompt =
    `You are a session-continuity classifier.\n\n` +
    `CURRENT SESSION CONTEXT:\n${context_summary.slice(0, 800)}\n\n` +
    `NEW USER MESSAGE:\n${(user_message ?? "").slice(0, 300)}\n\n` +
    `Is this message a continuation of the existing session, or a completely new/unrelated topic?\n` +
    `Respond with ONLY a JSON object:\n` +
    `{"decision":"continue"|"new","confidence":0.0-1.0,"reason":"one short sentence"}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": secrets.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 128,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!r.ok) {
      return { decision: "continue", confidence: 1.0, reason: `api_error_${r.status}` };
    }

    const data = await r.json();
    const raw  = (data.content?.[0]?.text ?? "").replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
    const parsed = JSON.parse(raw);

    const decision   = parsed.decision   === "new" ? "new" : "continue";
    const confidence = Number(parsed.confidence ?? 0);
    const reason     = String(parsed.reason ?? "");

    // Only switch to new session when classifier is confident
    if (decision === "new" && confidence >= NEW_CONFIDENCE_THRESHOLD) {
      return { decision: "new", confidence, reason };
    }

    return { decision: "continue", confidence, reason: reason || "below_threshold" };
  } catch {
    // Any failure → safe default
    return { decision: "continue", confidence: 1.0, reason: "parse_error" };
  }
}
