import Fastify from "fastify";

const app = Fastify({ logger: false });
const PORT = Number(process.env.UI_PORT || 18887);
const KERNEL_URL = process.env.KERNEL_URL || "http://localhost:18888";

// ── Proxy: forward /api/* → kernel ───────────────────────────────────────────
app.all("/api/*", async (req, reply) => {
  const kernelPath = req.url.replace(/^\/api/, "/kernel");
  const url = `${KERNEL_URL}${kernelPath}`;

  const init = {
    method: req.method,
    headers: { "content-type": "application/json" },
  };
  if (req.method !== "GET" && req.method !== "DELETE") {
    init.body = JSON.stringify(req.body ?? {});
  }

  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    reply.code(res.status).send(body);
  } catch (e) {
    reply.code(502).send({ ok: false, error: "kernel_unreachable", message: e.message });
  }
});

// ── Static pages ─────────────────────────────────────────────────────────────
app.get("/", async () => ({
  ok: true,
  service: "clawos-ui",
  pages: ["/connections", "/risk"],
}));

app.get("/connections", async (_req, reply) => {
  reply.type("text/html").send(CONNECTIONS_PAGE);
});

app.get("/risk", async (_req, reply) => {
  reply.type("text/html").send(RISK_PAGE);
});

// ── Shared CSS helpers ────────────────────────────────────────────────────────
const SHARED_STYLES = /* css */ `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #0f1117; color: #e0e0e0; min-height: 100vh; padding: 0 0 48px; }
  nav { background: #13161f; border-bottom: 1px solid #1e2130; padding: 0 24px;
        display: flex; align-items: center; gap: 24px; height: 52px; }
  .nav-brand { font-size: .95rem; font-weight: 700; color: #fff; letter-spacing: -.01em; margin-right: 8px; }
  .nav-link { font-size: .82rem; font-weight: 600; color: #666; text-decoration: none;
              padding: 6px 0; border-bottom: 2px solid transparent; transition: color .15s; }
  .nav-link:hover { color: #bbb; }
  .nav-link.active { color: #7c9cf0; border-bottom-color: #5c7be0; }
  .page { padding: 36px 24px 0; }
  h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 6px; color: #fff; }
  .subtitle { font-size: .84rem; color: #666; margin-bottom: 32px; line-height: 1.5; }
  .loading { text-align: center; color: #555; padding: 60px 0; }
  .error-banner { background: #3a1010; border: 1px solid #6a2020; color: #e05555;
                  border-radius: 8px; padding: 14px 16px; margin-bottom: 24px; font-size: .875rem; }
`;

// ── Connections HTML page ─────────────────────────────────────────────────────
const CONNECTIONS_PAGE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClawOS · Settings · Connections</title>
<style>
  ${SHARED_STYLES}
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 20px; }
  .card { background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 12px;
          padding: 24px; display: flex; flex-direction: column; gap: 16px; }
  .card-header { display: flex; align-items: center; justify-content: space-between; }
  .card-title { font-size: 1rem; font-weight: 600; color: #fff; }
  .badge { font-size: .7rem; font-weight: 700; padding: 3px 9px; border-radius: 99px;
           text-transform: uppercase; letter-spacing: .04em; }
  .badge-connected { background: #0d3320; color: #4caf8b; border: 1px solid #1e6645; }
  .badge-error     { background: #3a1010; color: #e05555; border: 1px solid #6a2020; }
  .badge-unknown   { background: #1f2030; color: #888;    border: 1px solid #333;   }
  .badge-missing   { background: #1f2030; color: #888;    border: 1px solid #333;   }
  .fields { display: flex; flex-direction: column; gap: 10px; }
  .field-row label { display: block; font-size: .75rem; color: #888; margin-bottom: 4px; }
  .field-row input {
    width: 100%; padding: 8px 12px; border-radius: 7px;
    border: 1px solid #2e3140; background: #12141e; color: #e0e0e0;
    font-size: .875rem; outline: none;
  }
  .field-row input:focus { border-color: #5c6bc0; }
  .masked { font-family: monospace; font-size: .8rem; color: #7c9cbf;
            padding: 6px 10px; background: #0d1018; border-radius: 6px; margin-top: 2px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { padding: 8px 16px; border-radius: 7px; border: none; font-size: .82rem;
         font-weight: 600; cursor: pointer; transition: opacity .15s; }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn-save       { background: #3a4bcc; color: #fff; }
  .btn-test       { background: #1e3a2a; color: #4caf8b; border: 1px solid #2d5c40; }
  .btn-disconnect { background: #2a1212; color: #e05555; border: 1px solid #5c2020; }
  .btn:not(:disabled):hover { opacity: .85; }
  .status-msg { font-size: .78rem; min-height: 18px; color: #888; }
  .status-msg.ok  { color: #4caf8b; }
  .status-msg.err { color: #e05555; }
  .last-tested { font-size: .72rem; color: #555; }
</style>
</head>
<body>
<nav>
  <span class="nav-brand">ClawOS</span>
  <a href="/connections" class="nav-link active">Connections</a>
  <a href="/risk" class="nav-link">Risk Policies</a>
</nav>
<div class="page">
<h1>Connections</h1>
<p class="subtitle">Manage API keys and service credentials. Secrets are encrypted at rest and never returned by GET requests.</p>
<div id="error-banner" class="error-banner" style="display:none"></div>
<div id="grid" class="grid"><p class="loading">Loading…</p></div>
</div>

<script>
const FIELD_LABELS = {
  api_key: "API Key", host: "SMTP Host", port: "Port",
  user: "Username / Email", password: "Password",
};
const PROVIDER_ICONS = {
  brave: "🦁", openai: "⬡", anthropic: "⚡", xai: "𝕏", smtp: "✉",
};

async function api(method, path, body) {
  const opts = { method, headers: { "content-type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch("/api/connections" + path, opts);
  return r.json();
}

async function loadAll() {
  const data = await api("GET", "");
  if (!data.ok) {
    document.getElementById("error-banner").textContent =
      "Could not reach kernel: " + (data.message || data.error);
    document.getElementById("error-banner").style.display = "";
    document.getElementById("grid").innerHTML = "";
    return;
  }
  document.getElementById("error-banner").style.display = "none";
  document.getElementById("grid").innerHTML = "";
  for (const [provider, info] of Object.entries(data.connections)) {
    renderCard(provider, info);
  }
}

function renderCard(provider, info) {
  const grid = document.getElementById("grid");
  const card = document.createElement("div");
  card.className = "card";
  card.id = "card-" + provider;

  const icon = PROVIDER_ICONS[provider] || "🔌";
  const badgeCls = "badge badge-" + (info.status || "missing");
  const lastTested = info.last_tested_at
    ? '<span class="last-tested">Tested ' + new Date(info.last_tested_at).toLocaleString() + "</span>"
    : "";
  const lastError = info.last_error
    ? '<div class="status-msg err">' + escHtml(info.last_error) + "</div>"
    : "";

  const masked = info.masked || {};
  const fieldsHtml = (info.fields || []).map((f) => {
    const mv = masked[f];
    const maskedDisplay = mv ? '<div class="masked">' + escHtml(mv) + "</div>" : "";
    return \`<div class="field-row">
      <label>\${FIELD_LABELS[f] || f}</label>
      \${maskedDisplay}
      <input type="password" id="input-\${provider}-\${f}" placeholder="\${mv ? "Update…" : "Enter " + (FIELD_LABELS[f] || f)}" autocomplete="new-password">
    </div>\`;
  }).join("");

  card.innerHTML = \`
    <div class="card-header">
      <span class="card-title">\${icon} \${escHtml(info.label || provider)}</span>
      <span class="\${badgeCls}" id="badge-\${provider}">\${info.status || "missing"}</span>
    </div>
    <div class="fields">\${fieldsHtml}</div>
    <div class="actions">
      <button class="btn btn-save"    onclick="saveProvider('\${provider}')">Save</button>
      <button class="btn btn-test"    onclick="testProvider('\${provider}')" \${info.status === "missing" ? "disabled" : ""} id="btn-test-\${provider}">Test</button>
      <button class="btn btn-disconnect" onclick="disconnectProvider('\${provider}')" \${info.status === "missing" ? "disabled" : ""} id="btn-disc-\${provider}">Disconnect</button>
    </div>
    <div class="status-msg" id="msg-\${provider}"></div>
    \${lastError}
    \${lastTested}
  \`;
  grid.appendChild(card);
}

function setMsg(provider, text, cls) {
  const el = document.getElementById("msg-" + provider);
  if (!el) return;
  el.textContent = text;
  el.className = "status-msg" + (cls ? " " + cls : "");
}

function setBadge(provider, status) {
  const el = document.getElementById("badge-" + provider);
  if (!el) return;
  el.textContent = status;
  el.className = "badge badge-" + status;
}

async function saveProvider(provider) {
  const card = document.getElementById("card-" + provider);
  const inputs = card.querySelectorAll("input[type=password]");
  const body = {};
  inputs.forEach((inp) => {
    const field = inp.id.replace("input-" + provider + "-", "");
    if (inp.value.trim()) body[field] = inp.value.trim();
  });
  if (Object.keys(body).length === 0) {
    setMsg(provider, "Enter at least one field to save.", "err"); return;
  }
  setMsg(provider, "Saving…");
  const res = await api("PUT", "/" + provider, body);
  if (res.ok) {
    setMsg(provider, "Saved.", "ok");
    setBadge(provider, "unknown");
    inputs.forEach((i) => { i.value = ""; });
    const testBtn = document.getElementById("btn-test-" + provider);
    const discBtn = document.getElementById("btn-disc-" + provider);
    if (testBtn) testBtn.disabled = false;
    if (discBtn) discBtn.disabled = false;
  } else {
    setMsg(provider, "Error: " + (res.error || JSON.stringify(res)), "err");
  }
}

async function testProvider(provider) {
  setMsg(provider, "Testing…");
  const res = await api("POST", "/" + provider + "/test");
  if (res.ok) {
    setMsg(provider, "Connected ✓", "ok");
    setBadge(provider, "connected");
  } else {
    setMsg(provider, "Failed: " + (res.error || "unknown error"), "err");
    setBadge(provider, "error");
  }
}

async function disconnectProvider(provider) {
  if (!confirm("Remove " + provider + " credentials?")) return;
  setMsg(provider, "Removing…");
  const res = await api("DELETE", "/" + provider);
  if (res.ok) {
    const card = document.getElementById("card-" + provider);
    if (card) card.remove();
    renderCard(provider, { status: "missing", label: provider, fields: [], masked: {} });
    setMsg(provider, "Disconnected.", "ok");
  } else {
    setMsg(provider, "Error: " + (res.error || "unknown"), "err");
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

loadAll();
</script>
</body>
</html>`;

// ── Risk Policies HTML page ───────────────────────────────────────────────────
const RISK_PAGE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClawOS · Settings · Risk Policies</title>
<style>
  ${SHARED_STYLES}

  /* ── Layout ── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 16px;
  }

  /* ── Card ── */
  .card {
    background: #1a1d27;
    border: 1px solid #2a2d3a;
    border-radius: 12px;
    padding: 20px 22px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    transition: border-color .2s;
  }
  .card.saving { border-color: #3a4bcc; }
  .card.saved  { border-color: #1e6645; }
  .card.error  { border-color: #6a2020; }

  /* ── Card header ── */
  .card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .card-title-row { display: flex; align-items: center; gap: 10px; }
  .card-icon { font-size: 1.25rem; line-height: 1; }
  .card-title { font-size: 1rem; font-weight: 700; color: #fff; }
  .card-desc { font-size: .8rem; color: #666; line-height: 1.45; margin-top: 1px; }

  /* ── Risk badge ── */
  .risk-badge {
    font-size: .65rem; font-weight: 800; letter-spacing: .06em;
    text-transform: uppercase; padding: 3px 8px; border-radius: 99px;
    white-space: nowrap; flex-shrink: 0;
  }
  .risk-low    { background: #0d2e1a; color: #4caf8b; border: 1px solid #1e6645; }
  .risk-medium { background: #2e2010; color: #cc9c40; border: 1px solid #6e4e10; }
  .risk-high   { background: #3a1010; color: #e05555; border: 1px solid #6a2020; }

  /* ── Meta row ── */
  .meta-row { display: flex; align-items: center; gap: 16px; }
  .meta-item { font-size: .75rem; color: #666; display: flex; align-items: center; gap: 5px; }
  .meta-item .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .dot-green { background: #4caf8b; }
  .dot-red   { background: #e05555; }

  /* ── Mode toggle (segmented control) ── */
  .mode-toggle {
    display: flex;
    border-radius: 9px;
    overflow: hidden;
    border: 1px solid #2a2d3a;
    background: #12141e;
  }
  .mode-btn {
    flex: 1; padding: 9px 4px; border: none; background: transparent;
    color: #555; font-size: .78rem; font-weight: 700; cursor: pointer;
    transition: background .15s, color .15s;
    letter-spacing: .02em; text-transform: uppercase;
  }
  .mode-btn:not(:last-child) { border-right: 1px solid #2a2d3a; }
  .mode-btn:hover:not(.active-auto):not(.active-ask):not(.active-block) {
    background: #1e2130; color: #aaa;
  }
  .mode-btn.active-auto  { background: #0d2e1a; color: #4caf8b; }
  .mode-btn.active-ask   { background: #151e35; color: #6a9cf0; }
  .mode-btn.active-block { background: #3a1010; color: #e05555; }

  /* ── Mode descriptions ── */
  .mode-hint {
    font-size: .74rem; color: #555; min-height: 16px;
    transition: color .2s;
  }
  .hint-auto  { color: #3a7a5a; }
  .hint-ask   { color: #3a5490; }
  .hint-block { color: #7a3030; }

  /* ── Status line ── */
  .status-line { font-size: .74rem; min-height: 16px; color: transparent; transition: color .3s; }
  .status-line.ok  { color: #4caf8b; }
  .status-line.err { color: #e05555; }
  .status-line.saving { color: #6a9cf0; }

  /* ── Legend ── */
  .legend {
    background: #13161f; border: 1px solid #1e2130;
    border-radius: 10px; padding: 16px 20px; margin-bottom: 28px;
    display: flex; gap: 32px; flex-wrap: wrap;
  }
  .legend-item { display: flex; align-items: center; gap: 10px; }
  .legend-swatch {
    width: 36px; height: 22px; border-radius: 5px;
    font-size: .65rem; font-weight: 800; letter-spacing: .04em;
    display: flex; align-items: center; justify-content: center;
    text-transform: uppercase;
  }
  .swatch-auto  { background: #0d2e1a; color: #4caf8b; border: 1px solid #1e6645; }
  .swatch-ask   { background: #151e35; color: #6a9cf0; border: 1px solid #2a3a70; }
  .swatch-block { background: #3a1010; color: #e05555; border: 1px solid #6a2020; }
  .legend-text strong { display: block; font-size: .8rem; color: #ccc; font-weight: 600; }
  .legend-text span   { font-size: .74rem; color: #555; }

  /* ── Updated timestamp ── */
  .updated-at { font-size: .7rem; color: #3a3e50; }
</style>
</head>
<body>
<nav>
  <span class="nav-brand">ClawOS</span>
  <a href="/connections" class="nav-link">Connections</a>
  <a href="/risk" class="nav-link active">Risk Policies</a>
</nav>
<div class="page">
<h1>Risk Policies</h1>
<p class="subtitle">
  Control how each action behaves when triggered from WhatsApp.<br>
  Changes take effect immediately — no restart required.
</p>

<div id="error-banner" class="error-banner" style="display:none"></div>

<div class="legend">
  <div class="legend-item">
    <div class="legend-swatch swatch-auto">auto</div>
    <div class="legend-text">
      <strong>Auto</strong>
      <span>Runs immediately — no approval needed</span>
    </div>
  </div>
  <div class="legend-item">
    <div class="legend-swatch swatch-ask">ask</div>
    <div class="legend-text">
      <strong>Ask</strong>
      <span>Sends approval request — reply yes / no</span>
    </div>
  </div>
  <div class="legend-item">
    <div class="legend-swatch swatch-block">block</div>
    <div class="legend-text">
      <strong>Block</strong>
      <span>Always rejected — never executed</span>
    </div>
  </div>
</div>

<div id="grid" class="grid"><p class="loading">Loading…</p></div>
</div>

<script>
// Known action metadata (mirrors kernel action definitions)
const ACTIONS = {
  web_search: {
    label: "Web Search",
    icon: "🔍",
    description: "Search the web for information",
    risk_level: "low",
    reversible: true,
  },
  read_file: {
    label: "Read File",
    icon: "📄",
    description: "Read a file from the workspace",
    risk_level: "low",
    reversible: true,
  },
  summarize_document: {
    label: "Summarize Document",
    icon: "📋",
    description: "Read and summarize a PDF or document",
    risk_level: "low",
    reversible: true,
  },
  write_file: {
    label: "Write File",
    icon: "✏️",
    description: "Create or overwrite a file in the workspace",
    risk_level: "medium",
    reversible: true,
  },
  run_shell: {
    label: "Run Shell",
    icon: "⚡",
    description: "Execute a shell command on the system",
    risk_level: "high",
    reversible: false,
  },
  send_email: {
    label: "Send Email",
    icon: "✉️",
    description: "Send an email to a recipient",
    risk_level: "high",
    reversible: false,
  },
};

// Preferred display order
const ACTION_ORDER = [
  "web_search", "read_file", "summarize_document",
  "write_file", "run_shell", "send_email",
];

const MODE_HINTS = {
  auto:  "Runs immediately without asking",
  ask:   "Sends a WhatsApp approval request first",
  block: "Always rejected — will never be executed",
};

function escHtml(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function apiGet(path) {
  const r = await fetch("/api" + path);
  return r.json();
}

async function apiPut(path, body) {
  const r = await fetch("/api" + path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function loadPolicies() {
  const data = await apiGet("/risk_policies");
  if (!data.ok) {
    document.getElementById("error-banner").textContent =
      "Could not reach kernel: " + (data.message || data.error);
    document.getElementById("error-banner").style.display = "";
    document.getElementById("grid").innerHTML = "";
    return;
  }
  document.getElementById("error-banner").style.display = "none";
  document.getElementById("grid").innerHTML = "";

  // Build a map of action_type → mode (global '*' policies)
  const modeMap = {};
  for (const p of data.policies ?? []) {
    if (p.workspace_id === "*") modeMap[p.action_type] = p;
  }

  // Render cards in preferred order, then any extras
  const rendered = new Set();
  for (const actionType of ACTION_ORDER) {
    rendered.add(actionType);
    renderCard(actionType, modeMap[actionType] ?? null);
  }
  // Any extra actions not in the known list
  for (const p of data.policies ?? []) {
    if (!rendered.has(p.action_type) && p.workspace_id === "*") {
      rendered.add(p.action_type);
      renderCard(p.action_type, p);
    }
  }
}

function renderCard(actionType, policy) {
  const grid = document.getElementById("grid");
  const info = ACTIONS[actionType] ?? {
    label: actionType,
    icon: "🔧",
    description: "",
    risk_level: "low",
    reversible: true,
  };
  const mode = policy?.mode ?? "ask";
  const updatedAt = policy?.updated_at
    ? "Last changed " + new Date(policy.updated_at).toLocaleString()
    : "";

  const riskClass = "risk-" + (info.risk_level || "low");
  const riskLabel = { low: "Low risk", medium: "Medium risk", high: "High risk" }[info.risk_level] || info.risk_level;
  const reversibleDot = info.reversible ? "dot-green" : "dot-red";
  const reversibleLabel = info.reversible ? "Reversible" : "Permanent";

  const card = document.createElement("div");
  card.className = "card";
  card.id = "card-" + actionType;
  card.innerHTML = \`
    <div class="card-header">
      <div>
        <div class="card-title-row">
          <span class="card-icon">\${info.icon}</span>
          <span class="card-title">\${escHtml(info.label)}</span>
        </div>
        <div class="card-desc">\${escHtml(info.description)}</div>
      </div>
      <span class="risk-badge \${riskClass}">\${riskLabel}</span>
    </div>

    <div class="meta-row">
      <div class="meta-item">
        <span class="dot \${reversibleDot}"></span>
        \${reversibleLabel}
      </div>
    </div>

    <div class="mode-toggle" role="group" aria-label="Mode for \${escHtml(info.label)}">
      <button class="mode-btn" id="btn-\${actionType}-auto"  onclick="setMode('\${actionType}','auto')">Auto</button>
      <button class="mode-btn" id="btn-\${actionType}-ask"   onclick="setMode('\${actionType}','ask')">Ask</button>
      <button class="mode-btn" id="btn-\${actionType}-block" onclick="setMode('\${actionType}','block')">Block</button>
    </div>

    <div class="mode-hint" id="hint-\${actionType}"></div>
    <div class="status-line" id="status-\${actionType}"></div>
    \${updatedAt ? \`<div class="updated-at">\${escHtml(updatedAt)}</div>\` : ""}
  \`;
  grid.appendChild(card);

  // Apply initial mode
  applyModeUI(actionType, mode, false);
}

function applyModeUI(actionType, mode, animated) {
  const modes = ["auto", "ask", "block"];
  for (const m of modes) {
    const btn = document.getElementById("btn-" + actionType + "-" + m);
    if (!btn) continue;
    btn.className = "mode-btn" + (m === mode ? " active-" + m : "");
  }
  const hint = document.getElementById("hint-" + actionType);
  if (hint) {
    hint.textContent = MODE_HINTS[mode] ?? "";
    hint.className = "mode-hint" + (animated ? " hint-" + mode : "");
  }
}

async function setMode(actionType, mode) {
  // Optimistic UI update
  applyModeUI(actionType, mode, true);
  setStatus(actionType, "Saving…", "saving");

  const card = document.getElementById("card-" + actionType);
  if (card) card.className = "card saving";

  const res = await apiPut("/risk_policies/" + actionType, { mode });

  if (res.ok) {
    setStatus(actionType, "Saved ✓", "ok");
    if (card) card.className = "card saved";
    setTimeout(() => {
      setStatus(actionType, "", "");
      if (card) card.className = "card";
    }, 2000);
  } else {
    setStatus(actionType, "Error: " + (res.error || "unknown"), "err");
    if (card) card.className = "card error";
  }
}

function setStatus(actionType, text, cls) {
  const el = document.getElementById("status-" + actionType);
  if (!el) return;
  el.textContent = text;
  el.className = "status-line" + (cls ? " " + cls : "");
}

loadPolicies();
</script>
</body>
</html>`;

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { process.stderr.write(err.message + "\n"); process.exit(1); }
  process.stdout.write(`[ui] listening on http://0.0.0.0:${PORT}\n`);
});
