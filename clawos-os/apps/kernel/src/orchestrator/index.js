import crypto from "node:crypto";
import { logEvent } from "./logger.js";
import { validateActionRequest } from "./schema.js";

import { action as sendEmail } from "./actions/send_email.js";
import { action as webSearch } from "./actions/web_search.js";
import { action as readFile } from "./actions/read_file.js";
import { action as writeFile } from "./actions/write_file.js";
import { action as runShell } from "./actions/run_shell.js";
import { action as summarizeDocument } from "./actions/summarize_document.js";
import { action as classifyIntent } from "./actions/classify_intent.js";

const registry = new Map([
  ["send_email", sendEmail],
  ["web_search", webSearch],
  ["read_file", readFile],
  ["write_file", writeFile],
  ["run_shell", runShell],
  ["summarize_document", summarizeDocument],
  ["classify_intent", classifyIntent],
]);

// Fix #1+2: verify DB-issued cap tokens; db is passed in from the kernel route
function isApproved(req, db) {
  const scopes = Array.isArray(req.scopes) ? req.scopes : [];
  if (scopes.includes("operator.approvals")) {return true;}

  const token = req.approval_token;
  if (!token) {return false;}

  // Token format: "token_id.sig"
  const lastDot = token.lastIndexOf(".");
  if (lastDot < 1) {return false;}
  const token_id = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!token_id || !sig) {return false;}

  if (!db) {return false;}

  // Retrieve HMAC key (recovery_hash) from kernel_state
  const keyRow = db.prepare(`SELECT value FROM kernel_state WHERE key=?`).get("recovery_hash");
  if (!keyRow) {return false;}

  // Verify HMAC signature
  const expected = crypto
    .createHmac("sha256", keyRow.value)
    .update(token_id, "utf8")
    .digest("base64url");

  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {return false;}

  // Look up the token record
  const tokenRow = db.prepare(`SELECT * FROM tool_tokens WHERE token_id=?`).get(token_id);
  if (!tokenRow) {return false;}

  // Verify expiry
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) {return false;}

  // Verify workspace binding
  if (tokenRow.workspace_id !== req.workspace_id) {return false;}

  // Verify action_request_id binding (Fix #4)
  if (tokenRow.action_request_id !== req.request_id) {return false;}

  // Verify tool_name matches action_type
  if (tokenRow.tool_name !== req.action_type) {return false;}

  return true;
}

/** Resolve the risk policy mode for this action_type from the DB. */
function resolvePolicy(action, req, db) {
  if (db) {
    // Workspace-specific policy takes precedence over wildcard
    const wsRow = db.prepare(
      `SELECT mode FROM risk_policies WHERE action_type=? AND workspace_id=?`
    ).get(req.action_type, req.workspace_id);
    if (wsRow) {return wsRow.mode;}

    const globalRow = db.prepare(
      `SELECT mode FROM risk_policies WHERE action_type=? AND workspace_id='*'`
    ).get(req.action_type);
    if (globalRow) {return globalRow.mode;}
  }
  // Fallback: reads = auto, writes = ask
  return action.writes ? "ask" : "auto";
}

// Fix #2: accept { db } so isApproved() can query tool_tokens
export async function dispatch(raw, { db } = {}) {
  const started = Date.now();

  const v = validateActionRequest(raw);
  if (!v.ok) {
    logEvent({ kind: "rejected", error: v.error });
    return { ok: false, error: v.error, code: "bad_request" };
  }

  const req = v.value;
  const action = registry.get(req.action_type);

  logEvent({
    kind: "received",
    request_id: req.request_id,
    workspace_id: req.workspace_id,
    agent_id: req.agent_id,
    action_type: req.action_type,
  });

  if (!action) {
    const err = `unknown action_type: ${req.action_type}`;
    logEvent({ kind: "failed", request_id: req.request_id, error: err });
    return { ok: false, error: err, code: "unknown_action" };
  }

  // ── Risk policy gate ──────────────────────────────────────────────────────
  const policyMode = resolvePolicy(action, req, db);

  if (policyMode === "block") {
    const res = {
      ok: false,
      code: "blocked",
      blocked: true,
      request_id: req.request_id,
      action_type: req.action_type,
      message: `Action "${req.action_type}" is blocked by policy.`,
    };
    logEvent({ kind: "blocked", request_id: req.request_id, action_type: req.action_type });
    return res;
  }

  // For "ask" mode: require a verified cap token (or operator scope)
  if (policyMode === "ask" && !isApproved(req, db)) {
    const res = {
      ok: false,
      code: "approval_required",
      approval_required: true,
      request_id: req.request_id,
      action_type: req.action_type,
      risk_level: action.risk_level ?? (action.writes ? "high" : "low"),
      reversible: action.reversible ?? !action.writes,
      description: action.description ?? action.name,
      message: "This action requires approval. Reply: yes / no / more / edit",
    };
    logEvent({
      kind: "approval_required",
      request_id: req.request_id,
      action_type: req.action_type,
    });
    return res;
  }
  // policyMode === "auto" → fall through and execute without approval

  try {
    const out = await action.run(req, { started_at: started, db });
    const ms = Date.now() - started;
    logEvent({
      kind: "completed",
      request_id: req.request_id,
      action_type: req.action_type,
      ms,
    });
    return { ok: true, request_id: req.request_id, action_type: req.action_type, result: out, ms };
  } catch (e) {
    const ms = Date.now() - started;
    const msg = e?.message || String(e);
    logEvent({ kind: "failed", request_id: req.request_id, action_type: req.action_type, ms, error: msg });
    return { ok: false, request_id: req.request_id, action_type: req.action_type, error: msg, ms };
  }
}
