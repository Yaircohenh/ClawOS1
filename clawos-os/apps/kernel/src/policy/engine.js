/**
 * Policy Engine — Risk-Adaptive Permissions
 *
 * Evaluates a requested scope and returns:
 *   { risk_level: "LOW"|"MEDIUM"|"HIGH", approval_required, blocked, blocked_tool? }
 *
 * Rules:
 *   HIGH  — destructive ops, shell exec, external communication, file deletion
 *   MEDIUM — writes/modifications within bounded resource
 *   LOW    — read-only, informational, bounded resource
 *
 * The kernel's risk_policies table is consulted per tool:
 *   mode=auto   → no approval needed (unless risk=HIGH)
 *   mode=ask    → approval_required
 *   mode=block  → blocked entirely
 *
 * Attenuation rule (for subagent tokens):
 *   Child scope MUST be a subset of parent scope.
 *   attenuateScope() enforces this by filtering to the intersection.
 */

const HIGH_TOOLS = new Set([
  "run_shell", "send_email", "delete_file",
]);
const MEDIUM_TOOLS = new Set([
  "write_file",
]);
// LOW_TOOLS: everything else (web_search, read_file, classify_intent, interpret_result, etc.)

const HIGH_OPS = new Set([
  "delete", "execute", "send", "transfer", "deploy", "drop",
]);
const MEDIUM_OPS = new Set([
  "write", "create", "modify", "update", "patch",
]);

/**
 * Evaluate the risk of a requested scope against the kernel's risk_policies table.
 * @param {object} scope   { allowed_tools[], operations[], resource_constraints{} }
 * @param {object} db      better-sqlite3 DB handle (optional — falls back to intrinsic rules)
 * @returns {{ risk_level, approval_required, blocked, blocked_tool? }}
 */
export function evaluateScope(scope, db) {
  const tools = scope.allowed_tools ?? [];
  const ops   = scope.operations   ?? [];

  // ── Intrinsic risk classification ──────────────────────────────────────────
  let risk_level = "LOW";

  if (
    tools.some((t) => HIGH_TOOLS.has(t)) ||
    ops.some((o) => HIGH_OPS.has(o))
  ) {
    risk_level = "HIGH";
  } else if (
    tools.some((t) => MEDIUM_TOOLS.has(t)) ||
    ops.some((o) => MEDIUM_OPS.has(o))
  ) {
    risk_level = "MEDIUM";
  }

  // HIGH risk always requires approval (regardless of DB policy)
  let approval_required = risk_level === "HIGH";

  // ── DB risk_policies override ───────────────────────────────────────────────
  if (db) {
    for (const tool of tools) {
      const row = db.prepare(
        `SELECT mode FROM risk_policies WHERE action_type = ? AND workspace_id = '*'`
      ).get(tool);

      if (row?.mode === "block") {
        return { risk_level, approval_required: true, blocked: true, blocked_tool: tool };
      }
      if (row?.mode === "ask") {
        approval_required = true;
      }
    }
  }

  return { risk_level, approval_required, blocked: false };
}

/**
 * Attenuate a requested scope to be a subset of the parent agent's allowed scope.
 * Used when minting DCTs for subagents — child can never have MORE power than parent.
 *
 * If parentScope is null/empty (agent has no explicit caps yet), pass-through (V1 shortcut).
 */
export function attenuateScope(parentScope, requestedScope) {
  if (!parentScope) {return requestedScope;} // V1: agents have implicit full scope

  const parentTools = new Set(parentScope.allowed_tools ?? []);
  const parentOps   = new Set(parentScope.operations   ?? []);

  return {
    allowed_tools: (requestedScope.allowed_tools ?? []).filter((t) => parentTools.has(t)),
    operations:    (requestedScope.operations    ?? []).filter((o) => parentOps.has(o)),
    resource_constraints: requestedScope.resource_constraints ?? {},
  };
}
