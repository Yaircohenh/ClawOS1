// ── ClawOS Kernel API client ───────────────────────────────────────────────────
// All requests go through the Fastify proxy: /api/* → /kernel/*

const BASE = "/api";

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  if (params) {Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));}
  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok) {throw new Error(json?.error ?? `GET ${path} failed (${res.status})`);}
  return json;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) {throw new Error(json?.error ?? `POST ${path} failed (${res.status})`);}
  return json;
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) {throw new Error(json?.error ?? `PUT ${path} failed (${res.status})`);}
  return json;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { method: "DELETE" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {throw new Error(json?.error ?? `DELETE ${path} failed (${res.status})`);}
  return json;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KernelHealth {
  ok: boolean;
  uptime_ms: number;
  db: string;
  version: string;
}

export interface Task {
  task_id: string;
  title: string;
  status: "queued" | "running" | "succeeded" | "failed";
  workspace_id: string;
  created_at: string;
}

export interface TaskDetail extends Task {
  contract_json: string;
  plan_json: string | null;
  contract?: {
    objective: string;
    scope?: { tools?: string[] };
    deliverables?: string[];
    acceptance_checks?: { type: string; count?: number }[];
  };
  artifacts?: Artifact[];
  subagents?: Subagent[];
}

export interface Subagent {
  subagent_id: string;
  worker_type: string;
  status: string;
  parent_agent_id: string;
  task_id: string;
  step_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface TaskEvent {
  event_id: string;
  workspace_id: string;
  task_id: string;
  actor_kind: string;
  actor_id: string;
  type: string;
  ts: string;
  data?: Record<string, unknown>;
}

export interface Artifact {
  artifact_id: string;
  task_id: string;
  workspace_id: string;
  actor_kind: string;
  actor_id: string;
  type: string;
  content?: string;
  created_at: string;
}

export interface Approval {
  approval_id: string;
  workspace_id: string;
  agent_id: string;
  action_request_id: string;
  action_type: string;
  payload: Record<string, unknown>;
  risk_level: string;
  reversible: boolean;
  description?: string;
  created_at: string;
}

export interface Connection {
  provider: string;
  status: "connected" | "error" | "unknown" | "missing";
  last_tested_at: string | null;
  fields?: Record<string, string>;
}

export interface RiskPolicy {
  action_type: string;
  mode: "auto" | "ask" | "block";
  risk_level: string;
  reversible: boolean;
  description: string;
  updated_at: string;
}

// ── API functions ─────────────────────────────────────────────────────────────

export const kernelApi = {
  health: () => get<KernelHealth>("/health"),

  // Tasks
  listTasks: (params?: { limit?: number; status?: string }) =>
    get<{ ok: boolean; tasks: Task[] }>("/tasks", params as Record<string, string | number>),
  getTask: (taskId: string) =>
    get<{ ok: boolean; task: TaskDetail; artifacts: Artifact[]; subagents: Subagent[] }>(
      `/tasks/${taskId}`
    ),
  getTaskEvents: (taskId: string) =>
    get<{ ok: boolean; events: TaskEvent[] }>(`/tasks/${taskId}/events`),

  // Events (global)
  listEvents: (params?: { limit?: number }) =>
    get<{ ok: boolean; events: TaskEvent[] }>("/events", params as Record<string, string | number>),

  // Approvals
  listApprovals: () => get<{ ok: boolean; approvals: Approval[] }>("/approvals"),
  approve: (approvalId: string) => post(`/approvals/${approvalId}/approve`),
  reject: (approvalId: string) => post(`/approvals/${approvalId}/reject`),

  // DCT approvals
  grantDCT: (darId: string) => post(`/dct_approvals/${darId}/grant`),
  denyDCT: (darId: string) => post(`/dct_approvals/${darId}/deny`),

  // Connections
  listConnections: () => get<{ ok: boolean; connections: Connection[] }>("/connections"),
  saveConnection: (provider: string, fields: Record<string, string>) =>
    put(`/connections/${provider}`, fields),
  testConnection: (provider: string) => post(`/connections/${provider}/test`),
  deleteConnection: (provider: string) => del(`/connections/${provider}`),

  // Risk policies
  listPolicies: () => get<{ ok: boolean; policies: RiskPolicy[] }>("/risk_policies"),
  setPolicy: (actionType: string, mode: "auto" | "ask" | "block") =>
    put(`/risk_policies/${actionType}`, { mode }),
};
