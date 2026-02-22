import "dotenv/config";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { z } from "zod";
import crypto from "crypto";
import net from "node:net";
import { dispatch as orchestratorDispatch } from "./orchestrator/index.js";
import { logAudit } from "./orchestrator/logger.js";

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
`);

// Seed default risk policies (auto for read actions, ask for write/side-effect actions)
{
  const defaults = [
    { action_type: "web_search",        mode: "auto" },
    { action_type: "read_file",         mode: "auto" },
    { action_type: "summarize_document",mode: "auto" },
    { action_type: "classify_intent",   mode: "auto" },
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
