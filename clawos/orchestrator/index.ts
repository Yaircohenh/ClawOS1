import { requiresApproval, hasApproval, approvalHint } from "./approval";
import { logEvent, LOG_PATH } from "./logger";
import { registry } from "./registry";
import { validateActionRequest } from "./validate";

export async function dispatch(raw: unknown): Promise<unknown> {
  const req = validateActionRequest(raw);

  logEvent({
    kind: "received",
    request_id: req.request_id,
    action_type: req.action_type,
  });

  if (requiresApproval(req) && !hasApproval(req)) {
    return {
      status: "approval_required",
      request_id: req.request_id,
      action_type: req.action_type,
      reason: "Approval required",
      approval_token_hint: approvalHint(req),
      logs_ref: { path: LOG_PATH },
    };
  }

  const handler = registry[req.action_type];
  if (!handler) {
    return {
      status: "error",
      error: { code: "no_handler", message: "No handler found" },
    };
  }

  const result = await handler(req);

  logEvent({
    kind: "completed",
    request_id: req.request_id,
    action_type: req.action_type,
    status: result.status,
  });

  return { ...result, logs_ref: { path: LOG_PATH } };
}
