/**
 * Session CRUD — low-level DB operations.
 * All functions are synchronous (better-sqlite3).
 */
import crypto from "node:crypto";

function nowIso() { return new Date().toISOString(); }
function newId()  { return `sess_${crypto.randomBytes(12).toString("hex")}`; }

/**
 * Create a new active session.
 * @param {import('better-sqlite3').Database} db
 * @param {{ workspace_id: string; channel: string; remote_jid: string; active_agent_id?: string }} opts
 */
export function createSession(db, { workspace_id, channel, remote_jid, active_agent_id = null }) {
  const session_id = newId();
  const now = nowIso();
  db.prepare(`
    INSERT INTO sessions
      (session_id, workspace_id, channel, remote_jid, status, context_summary,
       active_agent_id, last_message_at, created_at, turn_count)
    VALUES (?, ?, ?, ?, 'active', '', ?, ?, ?, 0)
  `).run(session_id, workspace_id, channel, remote_jid, active_agent_id, now, now);
  return getSession(db, session_id);
}

/**
 * Fetch a session by ID. Returns null if not found.
 * @param {import('better-sqlite3').Database} db
 * @param {string} session_id
 */
export function getSession(db, session_id) {
  return db.prepare(`SELECT * FROM sessions WHERE session_id=?`).get(session_id) ?? null;
}

/**
 * Find the most recent active session for a (workspace, channel, jid) tuple.
 * Returns null if none exists.
 */
export function findActiveSession(db, { workspace_id, channel, remote_jid }) {
  return db.prepare(`
    SELECT * FROM sessions
    WHERE workspace_id=? AND channel=? AND remote_jid=? AND status='active'
    ORDER BY last_message_at DESC
    LIMIT 1
  `).get(workspace_id, channel, remote_jid) ?? null;
}

/**
 * Mark a session as closed.
 */
export function closeSession(db, session_id) {
  db.prepare(`
    UPDATE sessions SET status='closed', closed_at=? WHERE session_id=?
  `).run(nowIso(), session_id);
}

/**
 * Bump last_message_at and increment turn_count.
 */
export function touchSession(db, session_id) {
  db.prepare(`
    UPDATE sessions
    SET last_message_at=?, turn_count=turn_count+1
    WHERE session_id=?
  `).run(nowIso(), session_id);
}

/**
 * Replace the context summary for a session.
 */
export function updateContextSummary(db, session_id, context_summary) {
  db.prepare(`
    UPDATE sessions SET context_summary=? WHERE session_id=?
  `).run(String(context_summary).slice(0, 1200), session_id);
}

/**
 * List all sessions for a workspace (dashboard use).
 */
export function listSessions(db, workspace_id, limit = 50) {
  return db.prepare(`
    SELECT session_id, workspace_id, channel, remote_jid, status,
           turn_count, last_message_at, created_at
    FROM sessions
    WHERE workspace_id=?
    ORDER BY last_message_at DESC
    LIMIT ?
  `).all(workspace_id, limit);
}
