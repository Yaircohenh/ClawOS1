import { ActionRequest, ActionResult } from "../types";

export async function sendEmail(req: ActionRequest): Promise<ActionResult> {
  return {
    status: "ok",
    request_id: req.request_id,
    action_type: req.action_type,
    dry_run: true,
    output: {
      mode: "dry_run",
      to: req.destination,
      payload: req.payload,
    },
  };
}
