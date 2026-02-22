import crypto from "node:crypto";
import { ActionRequest } from "./types";

const SECRET = process.env.OPENCLAW_APPROVAL_SECRET || "dev-secret";

export function requiresApproval(req: ActionRequest): boolean {
  return ["write_file", "send_email", "run_shell"].includes(req.action_type);
}

export function hasApproval(req: ActionRequest): boolean {
  if (req.meta?.operator_scopes?.includes("operator.approvals")) {
    return true;
  }

  const token = req.meta?.approval_token;
  if (!token) {
    return false;
  }

  const msg = `${req.request_id}:${req.action_type}`;
  const expected = crypto.createHmac("sha256", SECRET).update(msg).digest("hex");

  return token === expected;
}

export function approvalHint(req: ActionRequest) {
  return `HMAC_SHA256(secret, "${req.request_id}:${req.action_type}")`;
}
