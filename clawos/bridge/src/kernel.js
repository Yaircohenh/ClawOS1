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
