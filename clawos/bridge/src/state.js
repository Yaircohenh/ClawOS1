/**
 * Bridge persistent state — thin JSON-backed store.
 *
 * Two maps persisted under BRIDGE_DATA_DIR (default: data/clawos/bridge/):
 *   workspaces.json   — sender (E.164 / JID) → kernel workspace_id
 *   approvals.json    — approval_id → { sender, workspace_id, action_request_id, created_at }
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve data dir: prefer env var, otherwise repo-root/data/clawos/bridge
const DATA_DIR =
  process.env.BRIDGE_DATA_DIR ?? join(__dirname, "..", "..", "..", "data", "clawos", "bridge");

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function load(file, fallback) {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, file), "utf8"));
  } catch {
    return fallback;
  }
}

function persist(file, data) {
  ensureDir();
  writeFileSync(join(DATA_DIR, file), JSON.stringify(data, null, 2), "utf8");
}

// ── Workspace mapping ─────────────────────────────────────────────────────────
let workspaces = load("workspaces.json", {});

export function getWorkspaceId(sender) {
  return workspaces[sender] ?? null;
}

export function saveWorkspaceId(sender, workspaceId) {
  workspaces[sender] = workspaceId;
  persist("workspaces.json", workspaces);
}

// ── Pending approvals (by approval_id — used by kernel API calls) ─────────────
let approvals = load("approvals.json", {});

export function savePendingApproval(approvalId, data) {
  approvals[approvalId] = { ...data, created_at: Date.now() };
  persist("approvals.json", approvals);
}

export function getPendingApproval(approvalId) {
  return approvals[approvalId] ?? null;
}

export function removePendingApproval(approvalId) {
  delete approvals[approvalId];
  persist("approvals.json", approvals);
}

// ── Agent registration (sender → boolean) ────────────────────────────────────
// Tracks whether a sender has been registered as a kernel AGENT.
// Avoids re-registering on every message (the kernel is idempotent, but it saves a round-trip).
let agents = load("agents.json", {});

export function isAgentRegistered(sender) {
  return agents[sender] === true;
}

export function setAgentRegistered(sender) {
  agents[sender] = true;
  persist("agents.json", agents);
}

export function clearAgentRegistered(sender) {
  delete agents[sender];
  persist("agents.json", agents);
}

export function clearWorkspaceId(sender) {
  delete workspaces[sender];
  persist("workspaces.json", workspaces);
}

// ── Per-sender latest-pending state (drives yes/no/more/edit UX) ──────────────
// Stored shape: {
//   approval_id, action_type, payload, workspace_id,
//   action_request_id, agent_id,
//   risk_level, reversible, description,
//   editing: boolean   ← true while awaiting the user's replacement input
// }
let senderPending = load("sender_pending.json", {});

export function setSenderPending(sender, data) {
  senderPending[sender] = { ...data };
  persist("sender_pending.json", senderPending);
}

export function getSenderPending(sender) {
  return senderPending[sender] ?? null;
}

export function clearSenderPending(sender) {
  delete senderPending[sender];
  persist("sender_pending.json", senderPending);
}
