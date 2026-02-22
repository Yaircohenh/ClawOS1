/**
 * Event Service — Structured Event Stream per Task
 *
 * Every significant action emits a structured event with:
 *   actor_kind: "agent" | "subagent" | "system"
 *   actor_id:   agent_id or subagent_id
 *   type:       e.g. "task.created", "subagent.spawned", "worker.started", etc.
 */
import crypto from "node:crypto";

function eventId() {
  return `ev_${crypto.randomBytes(12).toString("hex")}`;
}

export function emitEvent(db, {
  workspace_id,
  task_id,
  actor_kind,   // "agent" | "subagent" | "system"
  actor_id,
  type,         // e.g. "task.created", "worker.started", "verify.passed"
  data = {},
}) {
  const event_id = eventId();
  const ts = new Date().toISOString();

  db.prepare(`
    INSERT INTO task_events (event_id, workspace_id, task_id, actor_kind, actor_id, type, ts, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(event_id, workspace_id, task_id, actor_kind, actor_id, type, ts, JSON.stringify(data));

  return { event_id, ts };
}

export function getEvents(db, task_id, workspace_id) {
  const rows = db.prepare(`
    SELECT * FROM task_events
    WHERE task_id = ? AND workspace_id = ?
    ORDER BY ts ASC
  `).all(task_id, workspace_id);

  return rows.map((r) => ({ ...r, data: JSON.parse(r.data_json ?? "{}") }));
}
