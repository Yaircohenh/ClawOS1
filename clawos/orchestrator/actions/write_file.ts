import { ActionRequest, ActionResult } from "../types";

export async function writeFileAction(req: ActionRequest): Promise<ActionResult> {
  return {
    status: "ok",
    request_id: req.request_id,
    action_type: req.action_type,
    dry_run: true,
    output: {
      message: "write_file stub",
    },
  };
}
