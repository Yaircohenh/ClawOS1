export type ActionType = "send_email" | "web_search" | "read_file" | "write_file" | "run_shell";

export type RiskLevel = "low" | "medium" | "high";

export type ActionRequest = {
  request_id: string;
  workspace_id: string;
  agent_id: string;
  action_type: ActionType;
  destination?: string;
  payload?: unknown;
  meta?: {
    dry_run?: boolean;
    approval_token?: string;
    operator_scopes?: string[];
  };
};

export type ActionResult =
  | {
      status: "ok";
      request_id: string;
      action_type: ActionType;
      dry_run: boolean;
      output?: unknown;
      logs_ref?: { path: string };
    }
  | {
      status: "approval_required";
      request_id: string;
      action_type: ActionType;
      reason: string;
      risk: RiskLevel;
      required_scope: "operator.approvals";
      approval_token_hint: string;
      logs_ref?: { path: string };
    }
  | {
      status: "error";
      request_id: string;
      action_type: ActionType;
      error: { code: string; message: string; details?: unknown };
      logs_ref?: { path: string };
    };
