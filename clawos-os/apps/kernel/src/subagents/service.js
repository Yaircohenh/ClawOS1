/**
 * Subagent Service
 *
 * Manages ephemeral, delegated workers (SUBAGENT kind).
 *
 * DISTINCT from AGENT:
 *  - Subagents are short-lived and spawned for a specific task/step.
 *  - They CANNOT request approvals.
 *  - They CANNOT mint/request capability tokens.
 *  - They act only with a Delegation Capability Token (DCT) issued by the kernel
 *    at the request of their parent AGENT.
 */
import crypto from "node:crypto";

function subagentId() {
  return `sa_${crypto.randomBytes(12).toString("hex")}`;
}

export function spawnSubagent(db, {
  workspace_id,
  parent_agent_id,
  task_id,
  step_id = null,
  worker_type,
}) {
  const subagent_id = subagentId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO subagents (
      subagent_id, kind, parent_agent_id, workspace_id,
      task_id, step_id, worker_type, status, created_at
    ) VALUES (?, 'subagent', ?, ?, ?, ?, ?, 'created', ?)
  `).run(subagent_id, parent_agent_id, workspace_id, task_id, step_id, worker_type, now);

  return getSubagent(db, subagent_id);
}

export function getSubagent(db, subagent_id) {
  return db.prepare(`SELECT * FROM subagents WHERE subagent_id = ?`).get(subagent_id) ?? null;
}

/**
 * Asserts that a subagent_id exists, belongs to workspace, and is linked to an agent + task.
 * This enforces the invariant: subagents MUST be bound to an AGENT + task.
 */
export function assertSubagent(db, subagent_id, workspace_id) {
  const sa = getSubagent(db, subagent_id);
  if (!sa) {throw Object.assign(new Error(`subagent_not_found: ${subagent_id}`), { code: 404 });}
  if (sa.workspace_id !== workspace_id) {
    throw Object.assign(new Error("subagent_workspace_mismatch"), { code: 403 });
  }
  if (!sa.parent_agent_id || !sa.task_id) {
    throw Object.assign(new Error("subagent_missing_agent_or_task_binding"), { code: 422 });
  }
  return sa;
}

export function updateSubagentStatus(db, subagent_id, status) {
  const finished_at = ["finished", "failed"].includes(status)
    ? new Date().toISOString()
    : null;
  db.prepare(`
    UPDATE subagents SET status = ?, finished_at = ? WHERE subagent_id = ?
  `).run(status, finished_at, subagent_id);
}

export function getSubagentsByTask(db, task_id, workspace_id) {
  return db.prepare(`
    SELECT * FROM subagents WHERE task_id = ? AND workspace_id = ? ORDER BY created_at ASC
  `).all(task_id, workspace_id);
}
