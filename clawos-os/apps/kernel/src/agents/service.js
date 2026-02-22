/**
 * Agent Service
 *
 * Manages durable, user-facing actors (AGENT kind).
 * Agents have stable identity, can own workspaces, create tasks,
 * request approvals, and mint/request capability tokens.
 *
 * DISTINCT from SUBAGENT — agents are long-lived; subagents are ephemeral delegates.
 */

export function createAgent(db, { workspace_id, agent_id, role = "orchestrator", policy_profile_id = null }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (agent_id, kind, workspace_id, role, policy_profile_id, created_at)
    VALUES (?, 'agent', ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      workspace_id     = excluded.workspace_id,
      role             = excluded.role,
      policy_profile_id = excluded.policy_profile_id
  `).run(agent_id, workspace_id, role, policy_profile_id, now);

  return getAgent(db, agent_id);
}

export function getAgent(db, agent_id) {
  return db.prepare(`SELECT * FROM agents WHERE agent_id = ?`).get(agent_id) ?? null;
}

/**
 * Asserts that an agent_id exists and belongs to the given workspace.
 * Throws on failure — routes can catch and return 403/404.
 */
export function assertAgent(db, agent_id, workspace_id) {
  const agent = getAgent(db, agent_id);
  if (!agent) {throw Object.assign(new Error(`agent_not_found: ${agent_id}`), { code: 404 });}
  if (agent.workspace_id !== workspace_id) {
    throw Object.assign(new Error("agent_workspace_mismatch"), { code: 403 });
  }
  return agent;
}
