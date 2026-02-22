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
  pages: ["/connections"],
}));

app.get("/connections", async (_req, reply) => {
  reply.type("text/html").send(CONNECTIONS_PAGE);
});

// ── Connections HTML page ─────────────────────────────────────────────────────
const CONNECTIONS_PAGE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClawOS · Settings · Connections</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #0f1117; color: #e0e0e0; min-height: 100vh; padding: 32px 16px; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 8px; color: #fff; }
  .subtitle { font-size: .85rem; color: #888; margin-bottom: 32px; }
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
  .loading { text-align: center; color: #555; padding: 60px 0; }
  .error-banner { background: #3a1010; border: 1px solid #6a2020; color: #e05555;
                  border-radius: 8px; padding: 16px; margin-bottom: 24px; font-size: .875rem; }
</style>
</head>
<body>
<h1>Settings · Connections</h1>
<p class="subtitle">Manage API keys and service credentials. Secrets are encrypted at rest and never returned by GET requests.</p>
<div id="error-banner" class="error-banner" style="display:none"></div>
<div id="grid" class="grid"><p class="loading">Loading…</p></div>

<script>
const FIELD_LABELS = {
  api_key: "API Key", host: "SMTP Host", port: "Port",
  user: "Username / Email", password: "Password",
};
const PROVIDER_ICONS = {
  brave: "🦁", openai: "⬡", anthropic: "⚡", smtp: "✉",
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

  // Build field rows
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
    // Re-render card in missing state
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

// ── Start ─────────────────────────────────────────────────────────────────────
 app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { process.stderr.write(err.message + "\n"); process.exit(1); }
  process.stdout.write(`[ui] listening on http://0.0.0.0:${PORT}\n`);
});
