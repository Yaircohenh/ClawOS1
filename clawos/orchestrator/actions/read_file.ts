import { ActionRequest, ActionResult } from "../types";

export async function readFileAction(req: ActionRequest): Promise<ActionResult> {
  return {
    status: "ok",
    request_id: req.request_id,
    action_type: req.action_type,
    dry_run: true,
    output: {
      message: "read_file stub",
    },
  };
}
