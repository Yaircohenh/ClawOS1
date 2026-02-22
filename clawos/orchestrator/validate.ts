import { ActionRequest, ActionType } from "./types";

const ACTION_TYPES: ActionType[] = new Set([
  "send_email",
  "web_search",
  "read_file",
  "write_file",
  "run_shell",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateActionRequest(raw: unknown): ActionRequest {
  if (!isRecord(raw)) {
    throw new Error("ActionRequest must be an object");
  }

  const request_id = typeof raw.request_id === "string" ? raw.request_id : "";
  const workspace_id = typeof raw.workspace_id === "string" ? raw.workspace_id : "";
  const agent_id = typeof raw.agent_id === "string" ? raw.agent_id : "";
  const action_type = raw.action_type as ActionType;

  if (!request_id) {
    throw new Error("Missing request_id");
  }
  if (!workspace_id) {
    throw new Error("Missing workspace_id");
  }
  if (!agent_id) {
    throw new Error("Missing agent_id");
  }
  if (!ACTION_TYPES.has(action_type)) {
    throw new Error(`Invalid action_type: ${String(raw.action_type)}`);
  }

  return {
    request_id,
    workspace_id,
    agent_id,
    action_type,
    destination: raw.destination,
    payload: raw.payload,
    meta: raw.meta,
  };
}
