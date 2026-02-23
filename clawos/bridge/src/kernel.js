/**
 * Thin HTTP client for the ClawOS Kernel (port 18888).
 *
 * All functions throw on non-2xx responses so callers can catch and surface
 * the error to the WhatsApp sender.
 */

const KERNEL_URL = process.env.KERNEL_URL ?? "http://localhost:18888";

async function post(path, body) {
  const res = await fetch(`${KERNEL_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Kernel POST ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function patch(path, body) {
  const res = await fetch(`${KERNEL_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Kernel PATCH ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function get(path) {
  const res = await fetch(`${KERNEL_URL}${path}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Kernel GET ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Create a new kernel workspace.
 * Returns workspace_id string.
 */
export async function createWorkspace() {
  const data = await post("/kernel/workspaces", { type: "whatsapp" });
  if (!data.workspace_id) {
    throw new Error(`createWorkspace: unexpected response ${JSON.stringify(data)}`);
  }
  return data.workspace_id;
}

/**
 * Submit an action request to the kernel.
 *
 * Returns the full kernel response:
 *   success          → { ok: true, action_request_id, exec: { ... } }
 *   approval needed  → { approval_required: true, action_request_id, approval_id, approval_expires_at, ... }
 *
 * @param {string}  workspaceId
 * @param {string}  agentId
 * @param {string}  actionType
 * @param {object}  payload
 * @param {{ requestId?: string, approvalToken?: string }} [opts]
 */
export async function submitActionRequest(workspaceId, agentId, actionType, payload, opts = {}) {
  return post("/kernel/action_requests", {
    workspace_id: workspaceId,
    agent_id: agentId,
    action_type: actionType,
    payload,
    ...(opts.requestId ? { request_id: opts.requestId } : {}),
    ...(opts.approvalToken ? { approval_token: opts.approvalToken } : {}),
  });
}

/**
 * Approve a pending approval by ID.
 * Returns { ok: true, status: "approved" }.
 */
export async function approveActionRequest(approvalId) {
  return post(`/kernel/approvals/${approvalId}/approve`, {});
}

/**
 * Reject a pending approval by ID.
 * Returns { ok: true, status: "rejected" }.
 */
export async function denyActionRequest(approvalId) {
  return post(`/kernel/approvals/${approvalId}/reject`, {});
}

/**
 * Issue a capability token after an approval has been granted.
 * Returns { ok: true, token, expires_at }.
 *
 * @param {string} workspaceId
 * @param {string} toolName        — must match action_type (e.g. "run_shell")
 * @param {string} actionRequestId
 * @param {string} approvalId
 */
export async function issueToken(workspaceId, toolName, actionRequestId, approvalId) {
  return post("/kernel/tokens/issue", {
    workspace_id: workspaceId,
    tool_name: toolName,
    action_request_id: actionRequestId,
    approval_id: approvalId,
  });
}

/**
 * Health check — returns kernel status.
 */
export async function kernelHealth() {
  return get("/kernel/health");
}

/**
 * Get all configured connections and their status.
 * Returns { connections: { smtp: { status, ... }, xai: { status, ... }, ... } }
 */
export async function kernelConnections() {
  return get("/kernel/connections");
}

// ── Agent / Task / Subagent / DCT API ────────────────────────────────────────

/**
 * Register (or idempotently upsert) an AGENT.
 * agent_id = sender's E.164/JID — the WhatsApp number IS the agent identity.
 */
export async function registerAgent(workspaceId, agentId, role = "orchestrator") {
  return post("/kernel/agents", {
    workspace_id: workspaceId,
    agent_id: agentId,
    role,
  });
}

/**
 * Create a contract-first task. Only AGENT may create tasks.
 * contract: { objective, scope, deliverables, acceptance_checks }
 * plan:     { steps, delegation_plan }  (optional)
 */
export async function kernelCreateTask(workspaceId, agentId, title, contract, plan = null) {
  return post("/kernel/tasks", {
    workspace_id: workspaceId,
    created_by_agent_id: agentId,
    title,
    contract,
    ...(plan ? { plan } : {}),
  });
}

/**
 * Spawn an ephemeral subagent under a task. Only AGENT may spawn subagents.
 */
export async function kernelSpawnSubagent(
  workspaceId,
  parentAgentId,
  taskId,
  workerType,
  stepId = null,
) {
  return post("/kernel/subagents", {
    workspace_id: workspaceId,
    parent_agent_id: parentAgentId,
    task_id: taskId,
    worker_type: workerType,
    ...(stepId ? { step_id: stepId } : {}),
  });
}

/**
 * Request a Delegation Capability Token (DCT) for an agent or subagent.
 * Only AGENT may request tokens.
 *
 * Returns:
 *   { ok: true, token, token_id, expires_at, risk_level }  — token minted
 *   { ok: false, needs_approval: true, dar_id, risk_level } — approval required first
 *   { ok: false, error: "scope_blocked_by_policy" }          — blocked
 *
 * @param {string} darId  — DCT approval request ID; provide on retry after approval
 */
export async function kernelRequestDCT(
  workspaceId,
  agentId,
  issueTo,
  scope,
  taskId,
  ttlSeconds = 600,
  darId = null,
) {
  return post("/kernel/tokens/request", {
    workspace_id: workspaceId,
    requested_by_agent_id: agentId,
    issue_to: issueTo, // { kind: "agent"|"subagent", id: "..." }
    scope, // { allowed_tools[], operations[], resource_constraints{} }
    task_id: taskId,
    ttl_seconds: ttlSeconds,
    ...(darId ? { dar_id: darId } : {}),
  });
}

/**
 * Grant a pending DCT approval request.
 */
export async function kernelGrantDCT(darId) {
  return post(`/kernel/dct_approvals/${darId}/grant`, {});
}

/**
 * Deny a pending DCT approval request.
 */
export async function kernelDenyDCT(darId) {
  return post(`/kernel/dct_approvals/${darId}/deny`, {});
}

// ── Session API ───────────────────────────────────────────────────────────────

/**
 * Resolve (or create) a session for an inbound message.
 *
 * Returns:
 *   { ok: true, session_id, decision: "continue"|"new", reason, session: { context_summary, ... } }
 *
 * @param {string} workspaceId
 * @param {string} channel        e.g. "whatsapp"
 * @param {string} remoteJid      sender E.164 / JID
 * @param {string} userMessage    the raw inbound text (used for reset detection + drift)
 */
export async function kernelResolveSession(workspaceId, channel, remoteJid, userMessage) {
  return post("/kernel/sessions/resolve", {
    workspace_id: workspaceId,
    channel,
    remote_jid: remoteJid,
    user_message: userMessage,
  });
}

/**
 * Advance a session after a turn: increments turn_count, updates last_message_at,
 * and triggers context_summary regeneration in the kernel.
 *
 * Non-fatal if the call fails — the bridge logs a warning and continues.
 *
 * @param {string} sessionId
 * @param {string} workspaceId
 * @param {string} userMessage
 * @param {string} assistantResponse  prettified text that was sent to the user
 * @param {string} actionType         e.g. "web_search"
 */
export async function kernelUpdateSession(
  sessionId,
  workspaceId,
  userMessage,
  assistantResponse,
  actionType,
) {
  return patch(`/kernel/sessions/${sessionId}`, {
    workspace_id: workspaceId,
    user_message: userMessage,
    assistant_response: assistantResponse,
    action_type: actionType,
  });
}

/**
 * Execute a subagent worker with a DCT bearer token.
 * Returns { ok: true, subagent_id, artifact_id, result }.
 */
export async function kernelRunSubagent(subagentId, workspaceId, token, input) {
  return post(`/kernel/subagents/${subagentId}/run`, {
    workspace_id: workspaceId,
    token,
    input,
  });
}

// ── Cognitive Objective API ────────────────────────────────────────────────────

/**
 * Resolve or create a cognitive objective for an inbound message.
 * Returns { ok, decision, reason, confidence, objective_id, goal, required_deliverable, title }.
 */
export async function kernelResolveObjective(workspaceId, agentId, sessionId, userMessage) {
  return post("/kernel/objectives/resolve", {
    workspace_id: workspaceId,
    agent_id: agentId,
    session_id: sessionId,
    user_message: userMessage,
  });
}

/**
 * Update objective status / result after delivery.
 * status: "completed" | "failed" | "in_progress"
 */
export async function kernelUpdateObjective(objectiveId, { status, result_summary = "" }) {
  return patch(`/kernel/objectives/${objectiveId}`, { status, result_summary });
}

/**
 * Record a real tool call as evidence for an objective.
 * Prevents false tool claims in the response.
 */
export async function kernelAddToolEvidence(
  objectiveId,
  sessionId,
  { action_type, query_text, result_summary },
) {
  return post(`/kernel/objectives/${objectiveId}/evidence`, {
    session_id: sessionId,
    action_type,
    query_text: query_text ?? "",
    result_summary: result_summary ?? "",
  });
}

/**
 * Run a cognitive_execute phase on the kernel.
 * phase: "validate_deliverable" | "enforce_tool_truth" | "repair_deliverable"
 */
export async function kernelCognitivePhase(workspaceId, agentId, phase, payload) {
  return post("/kernel/action_requests", {
    workspace_id: workspaceId,
    agent_id: agentId,
    action_type: "cognitive_execute",
    payload: { phase, ...payload },
  });
}

/**
 * Call plan_message to extract a plan from a user message.
 * Returns { steps: PlanStep[], mode: 'llm'|'fallback' }
 */
export async function kernelPlanMessage(workspaceId, agentId, text, contextSummary = "") {
  return post("/kernel/action_requests", {
    workspace_id: workspaceId,
    agent_id: agentId,
    action_type: "plan_message",
    payload: {
      text,
      ...(contextSummary ? { context_summary: contextSummary } : {}),
    },
  });
}

// ── Job API ────────────────────────────────────────────────────────────────────

/**
 * Create a background job.
 * Returns { ok, job_id, status, created_at }
 */
export async function kernelCreateJob(workspaceId, remoteJid, objective, plan = []) {
  return post("/kernel/jobs", {
    workspace_id: workspaceId,
    remote_jid: remoteJid,
    objective,
    plan,
  });
}

/**
 * Get job status + result.
 * Returns { ok, job: { job_id, status, progress, result, error, ... } }
 */
export async function kernelGetJob(jobId, workspaceId) {
  return get(`/kernel/jobs/${jobId}?workspace_id=${encodeURIComponent(workspaceId)}`);
}

/**
 * Update job progress / result / status (called by bridge job runner).
 */
export async function kernelUpdateJob(jobId, workspaceId, updates) {
  return patch(`/kernel/jobs/${jobId}`, { workspace_id: workspaceId, ...updates });
}

/**
 * List jobs for a sender.
 */
export async function kernelListJobs(workspaceId, remoteJid) {
  return get(
    `/kernel/jobs?workspace_id=${encodeURIComponent(workspaceId)}&remote_jid=${encodeURIComponent(remoteJid)}`,
  );
}

/**
 * Append a turn to a session's working-memory store (last-3 turns).
 */
export async function kernelAddSessionTurn(
  objectiveId,
  sessionId,
  { user_message, assistant_response, action_type },
) {
  return post(`/kernel/objectives/${objectiveId}/turns`, {
    session_id: sessionId,
    user_message: user_message ?? "",
    assistant_response: assistant_response ?? "",
    action_type: action_type ?? "",
  }).catch(() => {}); // non-fatal
}
