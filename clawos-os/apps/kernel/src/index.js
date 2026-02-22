import "dotenv/config";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { z } from "zod";
import crypto from "crypto";
import net from "node:net";
import { dispatch as orchestratorDispatch } from "./orchestrator/index.js";
import { logAudit } from "./orchestrator/logger.js";

// ── Agent / Subagent / Task infrastructure ────────────────────────────────────
import { createAgent, getAgent, assertAgent }                          from "./agents/service.js";
import { spawnSubagent, getSubagent, assertSubagent, updateSubagentStatus } from "./subagents/service.js";
import { createTask, getTask, updateTaskStatus }                       from "./tasks/service.js";
import { emitEvent, getEvents }                                        from "./events/service.js";
import { createArtifact, getArtifacts }                               from "./artifacts/service.js";
import { evaluateScope }                                               from "./policy/engine.js";
import { mintDCT, verifyDCT }                                         from "./tokens/delegation.js";
import { runWorker }                                                   from "./workers/runner.js";
import { verifyTask }                                                  from "./verify/service.js";

const PORT = Number(process.env.KERNEL_PORT || 18888);
const DB_PATH = process.env.DB_PATH || "./kernel.db";

const app = Fastify({ logger: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// --------------------
// DB schema (v0.1 security core)
// --------------------
db.exec(`
CREATE TABLE IF NOT EXISTS kernel_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_requests (
  action_request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  destination TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  result_json TEXT,
  approval_required INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decision_reason TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS tool_tokens (
  token_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  provider TEXT PRIMARY KEY,
  encrypted_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_tested_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_policies (
  action_type TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '*',
  mode TEXT NOT NULL DEFAULT 'ask',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (action_type, workspace_id)
);

-- ── Agent / Subagent / Task infrastructure (v2) ─────────────────────────────

-- AGENT: durable, user-facing actor with stable identity and authority
CREATE TABLE IF NOT EXISTS agents (
  agent_id          TEXT PRIMARY KEY,
  kind              TEXT NOT NULL DEFAULT 'agent',     -- always 'agent'
  workspace_id      TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'orchestrator',
  policy_profile_id TEXT,
  created_at        TEXT NOT NULL
);

-- SUBAGENT: ephemeral delegate, always bound to a parent agent + task
CREATE TABLE IF NOT EXISTS subagents (
  subagent_id      TEXT PRIMARY KEY,
  kind             TEXT NOT NULL DEFAULT 'subagent',   -- always 'subagent'
  parent_agent_id  TEXT NOT NULL,                      -- MUST reference an agent
  workspace_id     TEXT NOT NULL,
  task_id          TEXT NOT NULL,                      -- MUST reference a task
  step_id          TEXT,
  worker_type      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'created',    -- created/running/finished/failed
  created_at       TEXT NOT NULL,
  finished_at      TEXT
);

-- TASK: contract-first unit of work
CREATE TABLE IF NOT EXISTS tasks (
  task_id              TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  created_by_agent_id  TEXT NOT NULL,                  -- AGENT only
  title                TEXT NOT NULL,
  intent               TEXT NOT NULL DEFAULT '',
  contract_json        TEXT NOT NULL,                  -- { objective, scope, deliverables, acceptance_checks }
  plan_json            TEXT,                           -- { steps[], delegation_plan{} }
  status               TEXT NOT NULL DEFAULT 'queued', -- queued/running/blocked/needs_approval/failed/succeeded
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- DCT: Delegation Capability Token — the ONLY way subagents get authority
CREATE TABLE IF NOT EXISTS dct_tokens (
  token_id         TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  issued_to_kind   TEXT NOT NULL,   -- 'agent' | 'subagent'
  issued_to_id     TEXT NOT NULL,
  parent_agent_id  TEXT,            -- required when issued_to_kind='subagent'
  task_id          TEXT,
  scope_json       TEXT NOT NULL,   -- { allowed_tools[], operations[], resource_constraints{} }
  ttl_seconds      INTEGER NOT NULL DEFAULT 600,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  revoked          INTEGER NOT NULL DEFAULT 0
);

-- DCT Approval Requests — separate from action-request approvals
-- Only agents may request these; subagents cannot.
CREATE TABLE IF NOT EXISTS dct_approval_requests (
  dar_id                TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  requested_by_agent_id TEXT NOT NULL,
  issue_to_kind         TEXT NOT NULL,
  issue_to_id           TEXT NOT NULL,
  task_id               TEXT,
  scope_json            TEXT NOT NULL,
  ttl_seconds           INTEGER NOT NULL DEFAULT 600,
  risk_level            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',  -- pending/granted/denied
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  decided_at            TEXT
);

-- ARTIFACTS: verifiable outputs from agents/subagents
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id   TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  actor_kind    TEXT NOT NULL,    -- 'agent' | 'subagent' | 'system'
  actor_id      TEXT NOT NULL,
  type          TEXT NOT NULL,
  content       TEXT,
  uri           TEXT,
  metadata_json TEXT,
  created_at    TEXT NOT NULL
);

-- EVENTS: structured event stream per task
CREATE TABLE IF NOT EXISTS task_events (
  event_id      TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  actor_kind    TEXT NOT NULL,    -- 'agent' | 'subagent' | 'system'
  actor_id      TEXT NOT NULL,
  type          TEXT NOT NULL,
  ts            TEXT NOT NULL,
  data_json     TEXT NOT NULL
);
`);

// Seed default risk policies (auto for read actions, ask for write/side-effect actions)
{
  const defaults = [
    { action_type: "web_search",        mode: "auto" },
    { action_type: "read_file",         mode: "auto" },
    { action_type: "summarize_document",mode: "auto" },
    { action_type: "classify_intent",   mode: "auto" },
    { action_type: "interpret_result",  mode: "auto" },
    { action_type: "write_file",        mode: "ask"  },
    { action_type: "run_shell",         mode: "ask"  },
    { action_type: "send_email",        mode: "ask"  },
  ];
  const upsert = db.prepare(`
    INSERT INTO risk_policies (action_type, workspace_id, mode, updated_at)
    VALUES (?, '*', ?, ?)
    ON CONFLICT(action_type, workspace_id) DO NOTHING
  `);
  const now = new Date().toISOString();
  for (const { action_type, mode } of defaults) { upsert.run(action_type, mode, now); }
}

// Phase 3: delete expired tokens on every startup before accepting connections
{
  const { changes } = db
    .prepare(`DELETE FROM tool_tokens WHERE expires_at < ?`)
    .run(new Date().toISOString());
  if (changes > 0) {process.stdout.write(`[kernel] startup: removed ${changes} expired token(s)\n`);}
}

function nowIso() {
  return new Date().toISOString();
}
function id(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}
function createApproval({ workspace_id, action_request_id, requested_by = "local-dev", ttl_seconds = 600 }) {
  const approval_id = id("ap");
  const expires_at = new Date(Date.now() + ttl_seconds * 1000).toISOString();

  db.prepare(
    `INSERT INTO approvals (approval_id, workspace_id, status, action_request_id, requested_by, expires_at)
     VALUES (?, ?, 'pending', ?, ?, ?)`
  ).run(approval_id, workspace_id, action_request_id, requested_by, expires_at);

  return { approval_id, expires_at, status: "pending" };
}

function getKernelState(key) {
  const row = db.prepare(`SELECT value FROM kernel_state WHERE key=?`).get(key);
  return row?.value ?? null;
}
function setKernelState(key, value) {
  db.prepare(`INSERT INTO kernel_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(
    key,
    value
  );
}

// --------------------
// Connections — AES-256-GCM encryption helpers
// --------------------
function getConnectionsKey() {
  let keyHex = getKernelState("connections_key");
  if (!keyHex) {
    keyHex = crypto.randomBytes(32).toString("hex");
    setKernelState("connections_key", keyHex);
  }
  return Buffer.from(keyHex, "hex");
}

function encryptSecret(obj) {
  const key = getConnectionsKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [12 bytes iv][16 bytes tag][ciphertext]
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptConnectionSecret(encryptedB64) {
  const key = getConnectionsKey();
  const buf = Buffer.from(encryptedB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
}

function maskStr(s, prefixLen = 4, suffixLen = 4) {
  if (!s || s.length <= prefixLen + suffixLen) {return s ? "•••" : null;}
  return `${s.slice(0, prefixLen)}...${s.slice(-suffixLen)}`;
}

function testSmtp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) || 25, timeout: 5000 });
    let responded = false;
    socket.once("data", (data) => {
      responded = true;
      socket.destroy();
      const banner = data.toString();
      if (banner.startsWith("220")) {resolve(true);}
      else {reject(new Error(`Unexpected SMTP banner: ${banner.slice(0, 80).trim()}`));}
    });
    socket.once("error", reject);
    socket.once("timeout", () => { socket.destroy(); reject(new Error("SMTP connect timeout")); });
    // fallback if no data arrives
    socket.once("connect", () => {
      setTimeout(() => { if (!responded) { socket.destroy(); reject(new Error("SMTP no banner")); } }, 3000);
    });
  });
}

const PROVIDERS = {
  brave: {
    label: "Brave Search",
    fields: ["api_key"],
    mask: (s) => ({ api_key: maskStr(s.api_key) }),
    test: async (s) => {
      if (!s.api_key) {throw new Error("api_key is required");}
      const r = await fetch("https://api.search.brave.com/res/v1/web/search?q=test&count=1", {
        headers: { "Accept": "application/json", "X-Subscription-Token": s.api_key },
      });
      if (!r.ok) {throw new Error(`Brave API returned HTTP ${r.status}`);}
      return true;
    },
  },
  openai: {
    label: "OpenAI",
    fields: ["api_key"],
    mask: (s) => ({ api_key: maskStr(s.api_key, 7, 4) }),
    test: async (s) => {
      if (!s.api_key) {throw new Error("api_key is required");}
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${s.api_key}` },
      });
      if (!r.ok) {throw new Error(`OpenAI API returned HTTP ${r.status}`);}
      return true;
    },
  },
  anthropic: {
    label: "Anthropic",
    fields: ["api_key"],
    mask: (s) => ({ api_key: maskStr(s.api_key, 7, 4) }),
    test: async (s) => {
      if (!s.api_key) {throw new Error("api_key is required");}
      const r = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": s.api_key, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) {throw new Error(`Anthropic API returned HTTP ${r.status}`);}
      return true;
    },
  },
  xai: {
    label: "xAI (Grok)",
    fields: ["api_key"],
    mask: (s) => ({ api_key: maskStr(s.api_key, 7, 4) }),
    test: async (s) => {
      if (!s.api_key) {throw new Error("api_key is required");}
      const r = await fetch("https://api.x.ai/v1/models", {
        headers: { "Authorization": `Bearer ${s.api_key}` },
      });
      if (!r.ok) {throw new Error(`xAI API returned HTTP ${r.status}`);}
      return true;
    },
  },
  smtp: {
    label: "SMTP",
    fields: ["host", "port", "user", "password"],
    mask: (s) => ({ host: s.host || null, port: s.port || null, user: s.user || null, password: s.password ? "•••••••" : null }),
    test: async (s) => {
      if (!s.host) {throw new Error("host is required");}
      await testSmtp(s.host, Number(s.port) || 587);
      return true;
    },
  },
};

// --------------------
// Lock / Setup
// --------------------
app.post("/kernel/setup", async (req) => {
  const Schema = z.object({ recovery_phrase: z.string().min(8) });
  const body = Schema.parse(req.body ?? {});
  const existing = getKernelState("recovery_hash");
  if (!existing) {
    const h = crypto.createHash("sha256").update(body.recovery_phrase, "utf8").digest("hex");
    setKernelState("recovery_hash", h);
    setKernelState("locked", "false");
    return { ok: true, locked: false };
  }
  // idempotent
  return { ok: true, locked: getKernelState("locked") === "true" };
});

app.post("/kernel/unlock", async (req, reply) => {
  const Schema = z.object({ recovery_phrase: z.string().min(8) });
  const body = Schema.parse(req.body ?? {});
  const stored = getKernelState("recovery_hash");
  if (!stored) {
    reply.code(400);
    return { ok: false, error: "not_initialized" };
  }
  const h = crypto.createHash("sha256").update(body.recovery_phrase, "utf8").digest("hex");
  if (h !== stored) {
    reply.code(403);
    return { ok: false, error: "bad_recovery_phrase" };
  }
  setKernelState("locked", "false");
  return { ok: true, locked: false };
});

function assertUnlocked(reply) {
  if (getKernelState("locked") === "true") {
    reply.code(403);
    return false;
  }
  return true;
}

// --------------------
// Workspaces
// --------------------
app.post("/kernel/workspaces", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({ type: z.string().optional().default("default") });
  const body = Schema.parse(req.body ?? {});
  const workspace_id = id("ws");

  db.prepare(`INSERT INTO workspaces (workspace_id, type, created_at) VALUES (?, ?, ?)`).run(
    workspace_id,
    body.type,
    nowIso()
  );

  return { workspace_id };
});

app.get("/kernel/workspaces", async () => {
  const rows = db.prepare(`SELECT * FROM workspaces ORDER BY created_at DESC`).all();
  return { workspaces: rows };
});

// ---- Action Requests ----
app.post("/kernel/action_requests", async (req, reply) => {
  const Schema = z.object({
    workspace_id: z.string(),
    agent_id: z.string(),
    action_type: z.string(),
    destination: z.string().optional().nullable(),
    payload: z.any().optional().default({}),
    request_id: z.string().optional(),
    approval_token: z.string().optional(),
  });
  const body = Schema.parse(req.body ?? {});
  const action_request_id = body.request_id ?? id("ar");
  const requestStart = Date.now(); // Phase 3: audit log timing

  // Phase 3: workspace isolation — workspace_id must exist in DB
  // (prevents workspace_id path-injection into getWorkspaceRoot)
  const wsRow = db
    .prepare(`SELECT workspace_id FROM workspaces WHERE workspace_id=?`)
    .get(body.workspace_id);
  if (!wsRow) {
    reply.code(404);
    return { ok: false, error: "workspace_not_found" };
  }

  // Fix #5: payload immutability — same request_id + different payload → 409
  const incomingPayload = JSON.stringify(body.payload ?? {});
  const existingRow = db
    .prepare(`SELECT payload_json FROM action_requests WHERE action_request_id=?`)
    .get(action_request_id);

  if (existingRow) {
    if (existingRow.payload_json !== incomingPayload) {
      reply.code(409);
      return { ok: false, error: "conflict", message: "Same request_id submitted with different payload" };
    }
    // Same payload — idempotent retry, fall through to dispatch
  } else {
    db.prepare(`
      INSERT INTO action_requests (
        action_request_id, workspace_id, agent_id, action_type, destination,
        payload_json, created_at, status, approval_required, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL)
    `).run(
      action_request_id,
      body.workspace_id,
      body.agent_id,
      body.action_type,
      body.destination ?? null,
      incomingPayload,
      nowIso()
    );
  }

  // Fix #2: pass db so dispatch/isApproved can query tool_tokens
  const result = await orchestratorDispatch({
    request_id: action_request_id,
    workspace_id: body.workspace_id,
    agent_id: body.agent_id,
    action_type: body.action_type,
    destination: body.destination ?? null,
    payload: body.payload ?? {},
    approval_token: body.approval_token,
  }, { db });

  const status =
    
    result?.ok ? "completed" : (result?.approval_required ? "approval_required" : "failed");

  db.prepare(`
    UPDATE action_requests
    SET status = ?, approval_required = ?, result_json = ?
    WHERE action_request_id = ?
  `).run(
    status,
    result?.approval_required ? 1 : 0,
    JSON.stringify(result ?? {}),
    action_request_id
  );

  // Phase 3: structured audit log entry for every action request
  logAudit({
    action_request_id,
    workspace_id: body.workspace_id,
    agent_id: body.agent_id,
    action_type: body.action_type,
    status,
    ms: Date.now() - requestStart,
  });

  if (result?.approval_required) {
    // Fix #3: auto-create the approval record so the client gets approval_id immediately
    const approval = createApproval({
      workspace_id: body.workspace_id,
      action_request_id,
      requested_by: body.agent_id,
    });
    return reply.send({
      ...result,
      action_request_id,
      approval_id: approval.approval_id,
      approval_expires_at: approval.expires_at,
    });
  }
  return reply.send({
    ok: true,
    action_request_id,
    exec: result,
  });
});

app.get("/kernel/action_requests/:id", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({ id: z.string() });
  const params = Schema.parse(req.params ?? {});
  const row = db.prepare(`SELECT * FROM action_requests WHERE action_request_id=?`).get(params.id);
  if (!row) {
    reply.code(404);
    return { ok: false, error: "not_found" };
  }
  return {
    ...row,
    payload: JSON.parse(row.payload_json),
    result: row.result_json ? JSON.parse(row.result_json) : null
  };
});

// ---- Approvals ----
app.post("/kernel/approvals", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    workspace_id: z.string(),
    action_request_id: z.string(),
    requested_by: z.string().default("openclaw"),
    ttl_seconds: z.number().int().positive().max(3600).default(600)
  });
  const body = Schema.parse(req.body ?? {});
  const approval_id = id("ap");
  const expires_at = new Date(Date.now() + body.ttl_seconds * 1000).toISOString();

  db.prepare(
    `INSERT INTO approvals (approval_id, workspace_id, status, action_request_id, requested_by, expires_at)
     VALUES (?, ?, 'pending', ?, ?, ?)`
  ).run(approval_id, body.workspace_id, body.action_request_id, body.requested_by, expires_at);

  return { approval_id, status: "pending", expires_at };
});

app.get("/kernel/approvals", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const rows = db.prepare(`SELECT * FROM approvals ORDER BY expires_at DESC`).all();
  return { approvals: rows };
});

app.post("/kernel/approvals/:id/approve", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({ id: z.string() });
  const params = Schema.parse(req.params ?? {});
  const row = db.prepare(`SELECT * FROM approvals WHERE approval_id=?`).get(params.id);
  if (!row) {
    reply.code(404);
    return { ok: false, error: "not_found" };
  }
  db.prepare(`UPDATE approvals SET status='approved', decision_reason=?, decided_at=? WHERE approval_id=?`).run(
    "ok",
    nowIso(),
    params.id
  );
  return { ok: true, status: "approved" };
});

app.post("/kernel/approvals/:id/reject", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({ id: z.string() });
  const params = Schema.parse(req.params ?? {});
  const row = db.prepare(`SELECT * FROM approvals WHERE approval_id=?`).get(params.id);
  if (!row) {
    reply.code(404);
    return { ok: false, error: "not_found" };
  }
  db.prepare(`UPDATE approvals SET status='rejected', decision_reason=?, decided_at=? WHERE approval_id=?`).run(
    "rejected",
    nowIso(),
    params.id
  );
  return { ok: true, status: "rejected" };
});

// ---- Tokens ----
app.post("/kernel/tokens/issue", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    workspace_id: z.string(),
    tool_name: z.string(),
    action_request_id: z.string(),
    approval_id: z.string().optional(),
    ttl_seconds: z.number().int().positive().max(600).default(600)
  });
  const body = Schema.parse(req.body ?? {});

  // v0.1: require an approval_id for issuing tokens tied to a request
  if (!body.approval_id) {
    return { ok: false, error: "approval_id_required_v0_1" };
  }

  // Fix #4: verify approval is approved and binds to this action_request_id + workspace
  const approvalRow = db
    .prepare(`SELECT * FROM approvals WHERE approval_id=?`)
    .get(body.approval_id);
  if (!approvalRow) {
    reply.code(404);
    return { ok: false, error: "approval_not_found" };
  }
  if (approvalRow.status !== "approved") {
    reply.code(403);
    return { ok: false, error: "approval_not_granted" };
  }
  if (approvalRow.action_request_id !== body.action_request_id) {
    reply.code(422);
    return { ok: false, error: "approval_action_request_id_mismatch" };
  }
  if (approvalRow.workspace_id !== body.workspace_id) {
    reply.code(422);
    return { ok: false, error: "approval_workspace_id_mismatch" };
  }

  const token_id = id("cap");
  const expires_at = new Date(Date.now() + body.ttl_seconds * 1000).toISOString();

  db.prepare(
    `INSERT INTO tool_tokens (token_id, workspace_id, tool_name, action_request_id, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(token_id, body.workspace_id, body.tool_name, body.action_request_id, expires_at);

  // Simple bearer: token_id + HMAC-ish signature (v0.1 lightweight)
  const sig = crypto
    .createHmac("sha256", getKernelState("recovery_hash") || "dev")
    .update(token_id, "utf8")
    .digest("base64url");

  const token = `${token_id}.${sig}`;
  return { ok: true, token, expires_at };
});

app.post("/kernel/tokens/verify", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    token: z.string(),
    tool_name: z.string()
  });
  const body = Schema.parse(req.body ?? {});

  const [token_id, sig] = body.token.split(".");
  if (!token_id || !sig) {
    reply.code(403);
    return { ok: false, error: "bad_token" };
  }

  const expected = crypto
    .createHmac("sha256", getKernelState("recovery_hash") || "dev")
    .update(token_id, "utf8")
    .digest("base64url");

  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    reply.code(403);
    return { ok: false, error: "bad_token" };
  }

  const row = db.prepare(`SELECT * FROM tool_tokens WHERE token_id=?`).get(token_id);
  if (!row || row.tool_name !== body.tool_name) {
    reply.code(403);
    return { ok: false, error: "bad_token" };
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    reply.code(403);
    return { ok: false, error: "expired" };
  }

  return { ok: true };
});

// --------------------
// Connections
// --------------------
app.get("/kernel/connections", async () => {
  const rows = db.prepare(`SELECT * FROM connections`).all();
  const connections = {};
  for (const [provider, def] of Object.entries(PROVIDERS)) {
    const row = rows.find((r) => r.provider === provider);
    if (!row) {
      connections[provider] = { status: "missing", label: def.label, fields: def.fields };
      continue;
    }
    let masked = {};
    try {
      masked = def.mask(decryptConnectionSecret(row.encrypted_json));
    } catch { /* corrupt entry — show empty masked */ }
    connections[provider] = {
      status: row.status,
      label: def.label,
      fields: def.fields,
      masked,
      last_tested_at: row.last_tested_at,
      last_error: row.last_error,
      updated_at: row.updated_at,
    };
  }
  return { ok: true, connections };
});

app.put("/kernel/connections/:provider", async (req, reply) => {
  const { provider } = req.params;
  const def = PROVIDERS[provider];
  if (!def) { reply.code(400); return { ok: false, error: "unknown_provider" }; }

  const body = req.body ?? {};
  const incoming = {};
  for (const field of def.fields) {
    if (body[field] !== undefined && body[field] !== "") {incoming[field] = String(body[field]);}
  }
  if (Object.keys(incoming).length === 0) {
    reply.code(400); return { ok: false, error: "no_fields_provided" };
  }

  // Merge with existing secrets (supports partial updates)
  const existingRow = db.prepare(`SELECT encrypted_json FROM connections WHERE provider=?`).get(provider);
  let existing = {};
  if (existingRow) {
    try { existing = decryptConnectionSecret(existingRow.encrypted_json); } catch { /* start fresh */ }
  }
  const merged = { ...existing, ...incoming };

  db.prepare(`
    INSERT INTO connections (provider, encrypted_json, status, updated_at)
    VALUES (?, ?, 'unknown', ?)
    ON CONFLICT(provider) DO UPDATE SET
      encrypted_json = excluded.encrypted_json,
      status = 'unknown',
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run(provider, encryptSecret(merged), nowIso());

  return { ok: true, provider };
});

app.post("/kernel/connections/:provider/test", async (req, reply) => {
  const { provider } = req.params;
  const def = PROVIDERS[provider];
  if (!def) { reply.code(400); return { ok: false, error: "unknown_provider" }; }

  const row = db.prepare(`SELECT encrypted_json FROM connections WHERE provider=?`).get(provider);
  if (!row) { reply.code(404); return { ok: false, error: "not_configured" }; }

  let secrets;
  try { secrets = decryptConnectionSecret(row.encrypted_json); }
  catch { reply.code(500); return { ok: false, error: "decrypt_failed" }; }

  let testOk = false;
  let errorMsg = null;
  try {
    await def.test(secrets);
    testOk = true;
  } catch (e) {
    errorMsg = e.message;
  }

  const now = nowIso();
  db.prepare(`UPDATE connections SET status=?, last_tested_at=?, last_error=? WHERE provider=?`)
    .run(testOk ? "connected" : "error", now, errorMsg, provider);

  return { ok: testOk, provider, tested_at: now, ...(errorMsg ? { error: errorMsg } : {}) };
});

app.delete("/kernel/connections/:provider", async (req, reply) => {
  const { provider } = req.params;
  if (!PROVIDERS[provider]) { reply.code(400); return { ok: false, error: "unknown_provider" }; }

  const { changes } = db.prepare(`DELETE FROM connections WHERE provider=?`).run(provider);
  if (changes === 0) { reply.code(404); return { ok: false, error: "not_found" }; }

  return { ok: true, provider };
});

// --------------------
// Risk Policies
// --------------------
app.get("/kernel/risk_policies", async () => {
  const rows = db.prepare(`SELECT * FROM risk_policies ORDER BY action_type, workspace_id`).all();
  return { ok: true, policies: rows };
});

app.put("/kernel/risk_policies/:action_type", async (req, _reply) => {
  const Schema = z.object({
    mode: z.enum(["auto", "ask", "block"]),
    workspace_id: z.string().optional().default("*"),
  });
  const { action_type } = req.params;
  const body = Schema.parse(req.body ?? {});
  db.prepare(`
    INSERT INTO risk_policies (action_type, workspace_id, mode, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(action_type, workspace_id) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at
  `).run(action_type, body.workspace_id, body.mode, nowIso());
  return { ok: true, action_type, workspace_id: body.workspace_id, mode: body.mode };
});

// ============================================================================
// AGENTS — POST /kernel/agents  &  GET /kernel/agents/:agent_id
// Only agents can create tasks, request approvals, and mint delegation tokens.
// ============================================================================

app.post("/kernel/agents", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    workspace_id:     z.string(),
    agent_id:         z.string().min(1),
    role:             z.string().optional().default("orchestrator"),
    policy_profile_id: z.string().optional().nullable(),
  });
  const body = Schema.parse(req.body ?? {});

  // Workspace must exist
  const wsRow = db.prepare(`SELECT workspace_id FROM workspaces WHERE workspace_id=?`).get(body.workspace_id);
  if (!wsRow) { reply.code(404); return { ok: false, error: "workspace_not_found" }; }

  const agent = createAgent(db, body);

  emitEvent(db, {
    workspace_id: body.workspace_id,
    task_id:      "system",
    actor_kind:   "system",
    actor_id:     "kernel",
    type:         "agent.registered",
    data:         { agent_id: body.agent_id, role: body.role },
  });

  return { ok: true, agent };
});

app.get("/kernel/agents/:agent_id", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}
  const agent = getAgent(db, req.params.agent_id);
  if (!agent) { reply.code(404); return { ok: false, error: "agent_not_found" }; }
  return { ok: true, agent };
});

// ============================================================================
// TASKS — POST /kernel/tasks  &  GET /kernel/tasks/:task_id
// Contract-first: every task has objective, scope, deliverables, acceptance_checks.
// Only AGENT may create a task.
// ============================================================================

app.post("/kernel/tasks", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    workspace_id:         z.string(),
    created_by_agent_id:  z.string(),
    title:                z.string().min(1),
    intent:               z.string().optional().default(""),
    contract: z.object({
      objective:        z.string().optional().default(""),
      scope:            z.any().optional().default({}),
      deliverables:     z.array(z.string()).optional().default([]),
      acceptance_checks: z.array(z.any()).optional().default([]),
    }).optional().default({}),
    plan: z.any().optional().nullable(),
  });
  const body = Schema.parse(req.body ?? {});

  // Validate AGENT identity
  try {
    assertAgent(db, body.created_by_agent_id, body.workspace_id);
  } catch (err) {
    reply.code(err.code ?? 403);
    return { ok: false, error: err.message };
  }

  const task = createTask(db, body);

  emitEvent(db, {
    workspace_id: body.workspace_id,
    task_id:      task.task_id,
    actor_kind:   "agent",
    actor_id:     body.created_by_agent_id,
    type:         "task.created",
    data:         { title: body.title, contract: body.contract },
  });

  return { ok: true, task_id: task.task_id, task };
});

app.get("/kernel/tasks/:task_id", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({ workspace_id: z.string() });
  const query = Schema.parse(req.query ?? {});

  const task = getTask(db, req.params.task_id);
  if (!task) { reply.code(404); return { ok: false, error: "task_not_found" }; }
  if (task.workspace_id !== query.workspace_id) { reply.code(403); return { ok: false, error: "workspace_mismatch" }; }

  const artifacts = getArtifacts(db, task.task_id, task.workspace_id);
  const subagents = db.prepare(`SELECT * FROM subagents WHERE task_id=? AND workspace_id=?`)
    .all(task.task_id, task.workspace_id);

  return { ok: true, task, artifacts, subagents };
});

// ── Task Artifacts ────────────────────────────────────────────────────────────

app.post("/kernel/tasks/:task_id/artifacts", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    workspace_id: z.string(),
    actor_kind:   z.enum(["agent", "subagent", "system"]),
    actor_id:     z.string(),
    type:         z.string().min(1),
    content:      z.string().optional().nullable(),
    uri:          z.string().optional().nullable(),
    metadata:     z.any().optional().default({}),
  });
  const body = Schema.parse(req.body ?? {});

  const task = getTask(db, req.params.task_id);
  if (!task) { reply.code(404); return { ok: false, error: "task_not_found" }; }
  if (task.workspace_id !== body.workspace_id) { reply.code(403); return { ok: false, error: "workspace_mismatch" }; }

  const artifact = createArtifact(db, { task_id: req.params.task_id, ...body });

  emitEvent(db, {
    workspace_id: body.workspace_id,
    task_id:      req.params.task_id,
    actor_kind:   body.actor_kind,
    actor_id:     body.actor_id,
    type:         "artifact.created",
    data:         { artifact_id: artifact.artifact_id, type: body.type },
  });

  return { ok: true, artifact };
});

// ── Task Verify ───────────────────────────────────────────────────────────────

app.post("/kernel/tasks/:task_id/verify", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    workspace_id:         z.string(),
    requested_by_agent_id: z.string(),
  });
  const body = Schema.parse(req.body ?? {});

  // AGENT only — subagents cannot trigger verification
  try {
    assertAgent(db, body.requested_by_agent_id, body.workspace_id);
  } catch (err) {
    reply.code(err.code ?? 403);
    return { ok: false, error: err.message };
  }

  const task = getTask(db, req.params.task_id);
  if (!task) { reply.code(404); return { ok: false, error: "task_not_found" }; }
  if (task.workspace_id !== body.workspace_id) { reply.code(403); return { ok: false, error: "workspace_mismatch" }; }

  const result = await verifyTask(db, task, body.requested_by_agent_id);

  if (result.passed) {
    updateTaskStatus(db, task.task_id, "succeeded");
  }

  return { ok: true, ...result };
});

// ── Task Events ───────────────────────────────────────────────────────────────

app.get("/kernel/tasks/:task_id/events", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({ workspace_id: z.string() });
  const query = Schema.parse(req.query ?? {});

  const task = getTask(db, req.params.task_id);
  if (!task) { reply.code(404); return { ok: false, error: "task_not_found" }; }
  if (task.workspace_id !== query.workspace_id) { reply.code(403); return { ok: false, error: "workspace_mismatch" }; }

  const events = getEvents(db, req.params.task_id, query.workspace_id);
  return { ok: true, task_id: req.params.task_id, event_count: events.length, events };
});

// ── Task List (dashboard) ─────────────────────────────────────────────────────

app.get("/kernel/tasks", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    status: z.string().optional(),
    limit:  z.coerce.number().int().min(1).max(500).optional().default(50),
  });
  const query = Schema.parse(req.query ?? {});

  let stmt;
  if (query.status) {
    stmt = db.prepare(
      `SELECT task_id, title, status, workspace_id, created_at
         FROM tasks WHERE status=? ORDER BY created_at DESC LIMIT ?`
    ).all(query.status, query.limit);
  } else {
    stmt = db.prepare(
      `SELECT task_id, title, status, workspace_id, created_at
         FROM tasks ORDER BY created_at DESC LIMIT ?`
    ).all(query.limit);
  }

  return { ok: true, tasks: stmt };
});

// ── Global Events List (dashboard / logs) ─────────────────────────────────────

app.get("/kernel/events", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional().default(50),
    task_id: z.string().optional(),
  });
  const query = Schema.parse(req.query ?? {});

  let rows;
  if (query.task_id) {
    rows = db.prepare(
      `SELECT event_id, workspace_id, task_id, actor_kind, actor_id, type, ts, data_json
         FROM task_events WHERE task_id=? ORDER BY ts DESC LIMIT ?`
    ).all(query.task_id, query.limit);
  } else {
    rows = db.prepare(
      `SELECT event_id, workspace_id, task_id, actor_kind, actor_id, type, ts, data_json
         FROM task_events ORDER BY ts DESC LIMIT ?`
    ).all(query.limit);
  }

  const events = rows.map(r => ({
    ...r,
    data: r.data_json ? JSON.parse(r.data_json) : null,
    data_json: undefined,
  }));

  return { ok: true, events };
});

// ============================================================================
// SUBAGENTS — POST /kernel/subagents  &  GET & /run
// Subagents are ephemeral workers. They CANNOT request approvals or mint tokens.
// They act only via a DCT issued by the kernel at the parent agent's request.
// ============================================================================

app.post("/kernel/subagents", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    workspace_id:    z.string(),
    parent_agent_id: z.string(),
    task_id:         z.string(),
    step_id:         z.string().optional().nullable(),
    worker_type:     z.string().min(1),
  });
  const body = Schema.parse(req.body ?? {});

  // AGENT identity required — only agents can spawn subagents
  try {
    assertAgent(db, body.parent_agent_id, body.workspace_id);
  } catch (err) {
    reply.code(err.code ?? 403);
    return { ok: false, error: err.message };
  }

  // Task must exist in same workspace
  const task = getTask(db, body.task_id);
  if (!task) { reply.code(404); return { ok: false, error: "task_not_found" }; }
  if (task.workspace_id !== body.workspace_id) { reply.code(403); return { ok: false, error: "task_workspace_mismatch" }; }

  const subagent = spawnSubagent(db, body);

  emitEvent(db, {
    workspace_id: body.workspace_id,
    task_id:      body.task_id,
    actor_kind:   "agent",
    actor_id:     body.parent_agent_id,
    type:         "subagent.spawned",
    data:         { subagent_id: subagent.subagent_id, worker_type: body.worker_type },
  });

  return { ok: true, subagent_id: subagent.subagent_id, subagent };
});

app.get("/kernel/subagents/:subagent_id", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({ workspace_id: z.string() });
  const query = Schema.parse(req.query ?? {});

  const sa = getSubagent(db, req.params.subagent_id);
  if (!sa) { reply.code(404); return { ok: false, error: "subagent_not_found" }; }
  if (sa.workspace_id !== query.workspace_id) { reply.code(403); return { ok: false, error: "workspace_mismatch" }; }

  return { ok: true, subagent: sa };
});

/**
 * POST /kernel/subagents/:subagent_id/run
 *
 * Subagent execution endpoint.
 * The caller (typically the orchestrator on behalf of the subagent) provides:
 *   - workspace_id
 *   - token: the DCT bearer token issued to this subagent
 *   - input: the worker's input payload
 *
 * Kernel enforces:
 *   1. Subagent exists and belongs to workspace
 *   2. DCT is valid (signature, expiry, not revoked)
 *   3. DCT is issued TO this subagent (not another)
 *   4. Subagent is in 'created' or 'running' state
 */
app.post("/kernel/subagents/:subagent_id/run", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    workspace_id: z.string(),
    token:        z.string(),   // DCT bearer token
    input:        z.any().optional().default({}),
  });
  const body = Schema.parse(req.body ?? {});

  // 1. Validate subagent
  let sa;
  try {
    sa = assertSubagent(db, req.params.subagent_id, body.workspace_id);
  } catch (err) {
    reply.code(err.code ?? 403);
    return { ok: false, error: err.message };
  }

  // 2. Verify DCT
  const hmacKey = getKernelState("recovery_hash") ?? "dev";
  const dct = verifyDCT(db, body.token, hmacKey);
  if (!dct) {
    reply.code(403);
    return { ok: false, error: "invalid_or_expired_token" };
  }

  // 3. Token must be issued to THIS subagent
  if (dct.issued_to_kind !== "subagent" || dct.issued_to_id !== req.params.subagent_id) {
    reply.code(403);
    return { ok: false, error: "token_not_bound_to_this_subagent" };
  }

  // 4. Subagent must be in a runnable state
  if (!["created", "running"].includes(sa.status)) {
    reply.code(409);
    return { ok: false, error: `subagent_already_${sa.status}` };
  }

  updateSubagentStatus(db, req.params.subagent_id, "running");

  try {
    const { result, artifact_id } = await runWorker(db, {
      subagent: sa,
      token:    dct,
      input:    body.input,
    });

    updateSubagentStatus(db, req.params.subagent_id, "finished");

    return { ok: true, subagent_id: req.params.subagent_id, artifact_id, result };
  } catch (err) {
    updateSubagentStatus(db, req.params.subagent_id, "failed");
    reply.code(500);
    return { ok: false, error: err.message };
  }
});

// ============================================================================
// DELEGATION TOKENS — POST /kernel/tokens/request
//
// AGENT requests a DCT for itself or a subagent it owns.
// Policy engine evaluates risk and determines if approval is needed.
// Subagents CANNOT call this endpoint.
// ============================================================================

app.post("/kernel/tokens/request", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const Schema = z.object({
    workspace_id:         z.string(),
    requested_by_agent_id: z.string(),
    issue_to: z.object({
      kind: z.enum(["agent", "subagent"]),
      id:   z.string(),
    }),
    task_id:    z.string().optional().nullable(),
    scope: z.object({
      allowed_tools:        z.array(z.string()).optional().default([]),
      operations:           z.array(z.string()).optional().default([]),
      resource_constraints: z.any().optional().default({}),
    }),
    ttl_seconds: z.number().int().positive().max(3600).optional().default(600),
    dar_id:      z.string().optional().nullable(),  // DCT approval request ID (on retry)
  });
  const body = Schema.parse(req.body ?? {});

  // ── 1. Validate requesting AGENT ──────────────────────────────────────────
  try {
    assertAgent(db, body.requested_by_agent_id, body.workspace_id);
  } catch (err) {
    reply.code(err.code ?? 403);
    return { ok: false, error: err.message };
  }

  // ── 2. Validate issue_to target ───────────────────────────────────────────
  if (body.issue_to.kind === "subagent") {
    let sa;
    try {
      sa = assertSubagent(db, body.issue_to.id, body.workspace_id);
    } catch (err) {
      reply.code(err.code ?? 404);
      return { ok: false, error: err.message };
    }
    // Subagent must belong to the requesting agent
    if (sa.parent_agent_id !== body.requested_by_agent_id) {
      reply.code(403);
      return { ok: false, error: "subagent_not_owned_by_requesting_agent" };
    }
  } else if (body.issue_to.kind === "agent") {
    // Agents can only request tokens for themselves (V1)
    if (body.issue_to.id !== body.requested_by_agent_id) {
      reply.code(403);
      return { ok: false, error: "agents_may_only_request_tokens_for_themselves_v1" };
    }
  }

  // ── 3. Evaluate risk + policy ─────────────────────────────────────────────
  const policyResult = evaluateScope(body.scope, db);

  if (policyResult.blocked) {
    return {
      ok:           false,
      error:        "scope_blocked_by_policy",
      blocked_tool: policyResult.blocked_tool,
      risk_level:   policyResult.risk_level,
    };
  }

  // ── 4. Approval gate ──────────────────────────────────────────────────────
  if (policyResult.approval_required) {
    // If a dar_id is provided, validate the approval was granted
    if (body.dar_id) {
      const dar = db.prepare(`SELECT * FROM dct_approval_requests WHERE dar_id=?`).get(body.dar_id);
      if (!dar) {
        reply.code(404);
        return { ok: false, error: "dct_approval_not_found" };
      }
      if (dar.status !== "granted") {
        reply.code(403);
        return { ok: false, error: `dct_approval_${dar.status}`, dar_id: body.dar_id };
      }
      if (new Date(dar.expires_at).getTime() < Date.now()) {
        reply.code(403);
        return { ok: false, error: "dct_approval_expired", dar_id: body.dar_id };
      }
      // Validate the approval binds to the same agent + scope target
      if (dar.requested_by_agent_id !== body.requested_by_agent_id) {
        reply.code(403);
        return { ok: false, error: "dct_approval_agent_mismatch" };
      }
      // Approval validated — fall through to mint
    } else {
      // No approval yet — create one and ask the user
      const dar_id     = `dar_${crypto.randomBytes(12).toString("hex")}`;
      const now        = new Date().toISOString();
      const expires_at = new Date(Date.now() + body.ttl_seconds * 1000).toISOString();

      db.prepare(`
        INSERT INTO dct_approval_requests (
          dar_id, workspace_id, requested_by_agent_id, issue_to_kind, issue_to_id,
          task_id, scope_json, ttl_seconds, risk_level, status, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        dar_id, body.workspace_id, body.requested_by_agent_id,
        body.issue_to.kind, body.issue_to.id,
        body.task_id ?? null, JSON.stringify(body.scope),
        body.ttl_seconds, policyResult.risk_level,
        expires_at, now,
      );

      return {
        ok:            false,
        needs_approval: true,
        dar_id,
        risk_level:    policyResult.risk_level,
        scope:         body.scope,
        message:       "Approval required. Grant via POST /kernel/dct_approvals/:dar_id/grant then retry with dar_id.",
      };
    }
  }

  // ── 5. Mint DCT ───────────────────────────────────────────────────────────
  const hmacKey = getKernelState("recovery_hash") ?? "dev";
  const dct = mintDCT(db, {
    workspace_id:    body.workspace_id,
    issued_to_kind:  body.issue_to.kind,
    issued_to_id:    body.issue_to.id,
    parent_agent_id: body.issue_to.kind === "subagent" ? body.requested_by_agent_id : null,
    task_id:         body.task_id ?? null,
    scope:           body.scope,
    ttl_seconds:     body.ttl_seconds,
    hmacKey,
  });

  // Emit token.issued event
  if (body.task_id) {
    emitEvent(db, {
      workspace_id: body.workspace_id,
      task_id:      body.task_id,
      actor_kind:   "system",
      actor_id:     "kernel",
      type:         "token.issued",
      data: {
        token_id:       dct.token_id,
        issued_to_kind: body.issue_to.kind,
        issued_to_id:   body.issue_to.id,
        risk_level:     policyResult.risk_level,
        scope:          body.scope,
      },
    });
  }

  return {
    ok:             true,
    token_id:       dct.token_id,
    token:          dct.token,
    expires_at:     dct.expires_at,
    issued_to_kind: body.issue_to.kind,
    issued_to_id:   body.issue_to.id,
    risk_level:     policyResult.risk_level,
  };
});

// ── DCT Approval grant/deny ───────────────────────────────────────────────────

app.post("/kernel/dct_approvals/:dar_id/grant", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const dar = db.prepare(`SELECT * FROM dct_approval_requests WHERE dar_id=?`).get(req.params.dar_id);
  if (!dar) { reply.code(404); return { ok: false, error: "dct_approval_not_found" }; }
  if (dar.status !== "pending") { reply.code(409); return { ok: false, error: `already_${dar.status}` }; }

  db.prepare(`UPDATE dct_approval_requests SET status='granted', decided_at=? WHERE dar_id=?`)
    .run(new Date().toISOString(), req.params.dar_id);

  return { ok: true, dar_id: req.params.dar_id, status: "granted" };
});

app.post("/kernel/dct_approvals/:dar_id/deny", async (req, reply) => {
  if (!assertUnlocked(reply)) {return { ok: false, error: "kernel_locked" };}

  const dar = db.prepare(`SELECT * FROM dct_approval_requests WHERE dar_id=?`).get(req.params.dar_id);
  if (!dar) { reply.code(404); return { ok: false, error: "dct_approval_not_found" }; }
  if (dar.status !== "pending") { reply.code(409); return { ok: false, error: `already_${dar.status}` }; }

  db.prepare(`UPDATE dct_approval_requests SET status='denied', decided_at=? WHERE dar_id=?`)
    .run(new Date().toISOString(), req.params.dar_id);

  return { ok: true, dar_id: req.params.dar_id, status: "denied" };
});

// --------------------
// Phase 3: health endpoint
// --------------------
app.get("/kernel/health", async () => {
  let dbStatus = "ok";
  try {
    db.prepare(`SELECT 1`).get();
  } catch {
    dbStatus = "error";
  }
  return {
    ok: true,
    uptime_ms: Math.round(process.uptime() * 1000),
    db: dbStatus,
    version: "0.1.0",
  };
});

// --------------------
void app.listen({ port: PORT, host: "0.0.0.0" });
