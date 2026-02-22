/**
 * Objectives service — CRUD + tool evidence + session turns
 *
 * Objectives bind a session to a concrete, bounded goal (e.g. "find 10 AI OS
 * names with available .ai domains").  Follow-up messages can continue an
 * in-progress objective instead of starting from scratch.
 */
import crypto from "node:crypto";

function nowIso() { return new Date().toISOString(); }
function uid(prefix) { return `${prefix}_${crypto.randomBytes(10).toString("hex")}`; }

// ── Objectives ────────────────────────────────────────────────────────────────

/**
 * Create a new objective and mark it as the session's active objective.
 */
export function createObjective(db, {
  session_id,
  workspace_id,
  agent_id,
  title = "",
  goal = "",
  constraints = {},
  required_deliverable = null,
}) {
  const objective_id = uid("obj");
  const now = nowIso();
  db.prepare(`
    INSERT INTO objectives
      (objective_id, session_id, workspace_id, agent_id, title, goal,
       constraints_json, required_deliverable_json, status,
       result_summary, last_tool_evidence_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', '', '[]', ?, ?)
  `).run(
    objective_id, session_id, workspace_id, agent_id,
    title, goal,
    JSON.stringify(constraints),
    JSON.stringify(required_deliverable),
    now, now,
  );
  // Pin as session's active objective
  db.prepare(`UPDATE sessions SET active_objective_id=? WHERE session_id=?`)
    .run(objective_id, session_id);
  return getObjective(db, objective_id);
}

export function getObjective(db, objective_id) {
  const row = db.prepare(`SELECT * FROM objectives WHERE objective_id=?`).get(objective_id);
  if (!row) {return null;}
  return {
    ...row,
    constraints: JSON.parse(row.constraints_json ?? "{}"),
    required_deliverable: JSON.parse(row.required_deliverable_json ?? "null"),
    last_tool_evidence: JSON.parse(row.last_tool_evidence_json ?? "[]"),
  };
}

/** Return the most-recent in_progress objective for this session, or null. */
export function getActiveObjective(db, session_id) {
  const row = db.prepare(`
    SELECT * FROM objectives
    WHERE session_id=? AND status='in_progress'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(session_id);
  if (!row) {return null;}
  return {
    ...row,
    constraints: JSON.parse(row.constraints_json ?? "{}"),
    required_deliverable: JSON.parse(row.required_deliverable_json ?? "null"),
    last_tool_evidence: JSON.parse(row.last_tool_evidence_json ?? "[]"),
  };
}

/** Update status and optional result summary. */
export function updateObjectiveStatus(db, objective_id, status, result_summary = "") {
  db.prepare(`
    UPDATE objectives
    SET status=?, result_summary=?, updated_at=?
    WHERE objective_id=?
  `).run(status, result_summary.slice(0, 2000), nowIso(), objective_id);
}

/** Refresh the required_deliverable spec (e.g. after LLM extraction). */
export function updateObjectiveDeliverable(db, objective_id, required_deliverable) {
  db.prepare(`
    UPDATE objectives
    SET required_deliverable_json=?, updated_at=?
    WHERE objective_id=?
  `).run(JSON.stringify(required_deliverable), nowIso(), objective_id);
}

export function listObjectives(db, session_id) {
  return db.prepare(`
    SELECT * FROM objectives WHERE session_id=? ORDER BY created_at DESC
  `).all(session_id).map(row => ({
    ...row,
    constraints: JSON.parse(row.constraints_json ?? "{}"),
    required_deliverable: JSON.parse(row.required_deliverable_json ?? "null"),
  }));
}

// ── Tool Evidence ─────────────────────────────────────────────────────────────

/**
 * Record a tool call that actually happened for this objective.
 * Called by the bridge after each successful subagent execution.
 */
export function addToolEvidence(db, {
  objective_id,
  session_id,
  action_type,
  query_text = "",
  result_summary = "",
}) {
  const evidence_id = uid("ev");
  db.prepare(`
    INSERT INTO tool_evidence
      (evidence_id, objective_id, session_id, action_type, query_text, result_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    evidence_id, objective_id, session_id,
    action_type,
    query_text.slice(0, 500),
    result_summary.slice(0, 1000),
    nowIso(),
  );
  // Denormalise latest evidence into the objective row for fast lookup
  const recent = getToolEvidence(db, objective_id).slice(-5);
  db.prepare(`UPDATE objectives SET last_tool_evidence_json=?, updated_at=? WHERE objective_id=?`)
    .run(JSON.stringify(recent), nowIso(), objective_id);
  return evidence_id;
}

export function getToolEvidence(db, objective_id) {
  return db.prepare(`
    SELECT * FROM tool_evidence WHERE objective_id=? ORDER BY created_at ASC
  `).all(objective_id);
}

// ── Session Turns (working memory) ───────────────────────────────────────────

/**
 * Append a turn after each assistant reply.  Automatically prunes to keep
 * only the most recent 20 turns per session (saves storage).
 */
export function addSessionTurn(db, {
  session_id,
  user_message,
  assistant_response,
  action_type = "",
  objective_id = null,
}) {
  const turn_id = uid("turn");
  db.prepare(`
    INSERT INTO session_turns
      (turn_id, session_id, user_message, assistant_response, action_type, objective_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    turn_id, session_id,
    user_message.slice(0, 1000),
    assistant_response.slice(0, 2000),
    action_type,
    objective_id,
    nowIso(),
  );
  // Prune old turns beyond 20
  db.prepare(`
    DELETE FROM session_turns
    WHERE session_id=? AND turn_id NOT IN (
      SELECT turn_id FROM session_turns WHERE session_id=? ORDER BY created_at DESC LIMIT 20
    )
  `).run(session_id, session_id);
  return turn_id;
}

/** Return the last `limit` turns for a session (newest last). */
export function getRecentTurns(db, session_id, limit = 3) {
  return db.prepare(`
    SELECT * FROM session_turns
    WHERE session_id=?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(session_id, limit).toReversed();
}
