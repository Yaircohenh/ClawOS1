import { ActionRequest, ActionResult } from "../types";

export async function runShell(req: ActionRequest): Promise<ActionResult> {
  return {
    status: "error",
    request_id: req.request_id,
    action_type: req.action_type,
    error: {
      code: "disabled",
      message: "run_shell disabled in Phase 2",
    },
  };
}
