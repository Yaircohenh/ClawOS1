/**
 * Session decision engine.
 *
 * resolveSession(db, opts) decides whether to CONTINUE an existing session or
 * CREATE a NEW one.  Four policies are checked in order:
 *
 *   1. EXPLICIT RESET  — user message matches a reset phrase  → NEW (closes old session)
 *   2. NO SESSION      — no active session found              → NEW
 *   3. CLOSED SESSION  — found but status != active           → NEW
 *   4. TIMEOUT         — now – last_message_at > 30 min       → NEW (closes old session)
 *   5. TOPIC DRIFT     — optional LLM classifier (feature flag) can also say NEW
 *   6. CONTINUE        — none of the above                    → CONTINUE
 *
 * Safe defaults: drift classifier is OFF by default; uncertain results → CONTINUE.
 */
import { createSession, findActiveSession, closeSession } from "./service.js";
import { classifyDrift } from "./drift_classifier.js";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Phrases that signal the user wants to start a fresh session. */
const RESET_PHRASES = [
  "new task",
  "start over",
  "reset",
  "forget that",
  "new project",
  "clear history",
  "start fresh",
  "new conversation",
];

function isResetPhrase(text) {
  if (!text) {return false;}
  const normalized = text.toLowerCase().trim();
  return RESET_PHRASES.some(
    (p) =>
      normalized === p ||
      normalized.startsWith(p + " ") ||
      normalized.endsWith(" " + p),
  );
}

/**
 * Resolve (or create) a session for an inbound message.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   workspace_id: string;
 *   channel: string;
 *   remote_jid: string;
 *   user_message?: string;
 * }} opts
 * @returns {{
 *   session_id: string;
 *   decision: "continue" | "new";
 *   reason: string;
 *   session: object;
 * }}
 */
export async function resolveSession(db, { workspace_id, channel, remote_jid, user_message = "" }) {
  const existing = findActiveSession(db, { workspace_id, channel, remote_jid });

  // ── 1. Explicit reset ──────────────────────────────────────────────────────
  if (existing && isResetPhrase(user_message)) {
    closeSession(db, existing.session_id);
    const session = createSession(db, { workspace_id, channel, remote_jid });
    return { session_id: session.session_id, decision: "new", reason: "explicit_reset", session };
  }

  // ── 2. No active session ───────────────────────────────────────────────────
  if (!existing) {
    const session = createSession(db, { workspace_id, channel, remote_jid });
    return { session_id: session.session_id, decision: "new", reason: "no_active_session", session };
  }

  // ── 3. Closed session (shouldn't normally appear via findActiveSession, but be safe) ──
  if (existing.status !== "active") {
    const session = createSession(db, { workspace_id, channel, remote_jid });
    return { session_id: session.session_id, decision: "new", reason: "closed_session", session };
  }

  // ── 4. Timeout ────────────────────────────────────────────────────────────
  const lastAt = new Date(existing.last_message_at).getTime();
  if (Date.now() - lastAt > TIMEOUT_MS) {
    closeSession(db, existing.session_id);
    const session = createSession(db, { workspace_id, channel, remote_jid });
    return { session_id: session.session_id, decision: "new", reason: "timeout", session };
  }

  // ── 5. Optional topic drift classifier ────────────────────────────────────
  // Only runs if ENABLE_SESSION_DRIFT_CLASSIFIER=true and has existing context
  if (existing.context_summary) {
    const drift = await classifyDrift(db, {
      context_summary: existing.context_summary,
      user_message,
    }).catch(() => ({ decision: "continue", reason: "drift_classifier_error" }));

    if (drift.decision === "new") {
      closeSession(db, existing.session_id);
      const session = createSession(db, { workspace_id, channel, remote_jid });
      return {
        session_id: session.session_id,
        decision: "new",
        reason: `topic_drift:${drift.reason ?? "classifier"}`,
        session,
      };
    }
  }

  // ── 6. Continue ───────────────────────────────────────────────────────────
  return {
    session_id: existing.session_id,
    decision: "continue",
    reason: "active",
    session: existing,
  };
}
