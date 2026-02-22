/**
 * Task Service — Contract-First Tasks
 *
 * Every task has a contract: { objective, scope, deliverables, acceptance_checks }.
 * Completion is verifiable: done only when acceptance_checks pass.
 * Only an AGENT may create a task.
 */
import crypto from "node:crypto";

function taskId() {
  return `task_${crypto.randomBytes(12).toString("hex")}`;
}

export function createTask(db, {
  workspace_id,
  created_by_agent_id,
  title,
  intent = "",
  contract,        // { objective, scope, deliverables, acceptance_checks }
  plan = null,     // { steps[], delegation_plan{} }
}) {
  const task_id = taskId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO tasks (
      task_id, workspace_id, created_by_agent_id, title, intent,
      contract_json, plan_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(
    task_id, workspace_id, created_by_agent_id, title, intent,
    JSON.stringify(contract ?? {}),
    plan ? JSON.stringify(plan) : null,
    now, now,
  );

  return getTask(db, task_id);
}

export function getTask(db, task_id) {
  const row = db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(task_id);
  if (!row) {return null;}
  return {
    ...row,
    contract: JSON.parse(row.contract_json ?? "{}"),
    plan:     row.plan_json ? JSON.parse(row.plan_json) : null,
  };
}

export function updateTaskStatus(db, task_id, status) {
  db.prepare(`
    UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?
  `).run(status, new Date().toISOString(), task_id);
}
