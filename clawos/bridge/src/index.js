/**
 * ClawOS WhatsApp → Kernel Bridge
 *
 * Receives inbound WhatsApp messages from the OpenClaw messageSink tap,
 * submits action requests to the Kernel, and sends replies back via the
 * bridge send server running inside the OpenClaw process.
 *
 * Supported WhatsApp commands:
 *   !run <shell command>   — submit run_shell (requires approval)
 *   !approve <approval_id> — approve: issue cap token + execute
 *   !deny <approval_id>    — reject a pending kernel action
 *   <anything else>        — submitted as web_search { q: <text> }
 */
import Fastify from "fastify";
import {
  createWorkspace,
  submitActionRequest,
  approveActionRequest,
  denyActionRequest,
  issueToken,
  kernelHealth,
} from "./kernel.js";
import { extractPdfText } from "./pdf.js";
import {
  getWorkspaceId,
  saveWorkspaceId,
  savePendingApproval,
  getPendingApproval,
  removePendingApproval,
} from "./state.js";

const PORT = Number(process.env.BRIDGE_PORT ?? 18790);
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";
const BRIDGE_SEND_URL = process.env.BRIDGE_SEND_URL ?? "http://localhost:18791/send";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

// ── Authentication ────────────────────────────────────────────────────────────
app.addHook("onRequest", (req, reply, done) => {
  if (req.url === "/health") {
    done();
    return;
  }
  if (BRIDGE_SECRET && req.headers["x-bridge-secret"] !== BRIDGE_SECRET) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  done();
});

// ── WhatsApp reply helper ─────────────────────────────────────────────────────
async function sendWhatsApp(to, text) {
  const res = await fetch(BRIDGE_SEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(BRIDGE_SECRET ? { "x-bridge-secret": BRIDGE_SECRET } : {}),
    },
    body: JSON.stringify({ to, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
  }
}

// ── Workspace helper ──────────────────────────────────────────────────────────
async function ensureWorkspace(sender) {
  let wsId = getWorkspaceId(sender);
  if (!wsId) {
    wsId = await createWorkspace();
    saveWorkspaceId(sender, wsId);
    app.log.info({ sender, wsId }, "created workspace");
  }
  return wsId;
}

// ── Result formatter (shared by search + run) ─────────────────────────────────
function formatResult(exec) {
  const inner = exec?.result ?? exec ?? {};

  // Brave search results
  if (inner.mode === "brave" && Array.isArray(inner.results)) {
    const lines = inner.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet ?? ""}`.trim())
      .join("\n\n");
    return `Search: "${inner.query}"\n\n${lines}`;
  }

  // Shell output
  if (inner.output !== undefined) {
    const prefix = inner.ok === false ? "Exit " + inner.exit_code + "\n" : "";
    return prefix + inner.output;
  }

  // Document summary (Anthropic)
  if (inner.mode === "anthropic" && inner.summary) {
    return `*${inner.filename}* (${inner.page_count}p)\n\n${inner.summary}`;
  }

  // Document excerpt fallback
  if (inner.mode === "excerpt") {
    const note = inner.note ? `\n\n_${inner.note}_` : "";
    return `*${inner.filename}* (${inner.page_count}p) — first 3000 chars:\n\n${inner.excerpt}${note}`;
  }

  return (
    inner.note ??
    inner.text ??
    (inner.ok === false
      ? `Error: ${inner.message ?? JSON.stringify(inner)}`
      : JSON.stringify(inner))
  );
}

// ── !approve handler (full flow: approve → issue token → retry) ───────────────
async function handleApprove(sender, approvalId) {
  const pending = getPendingApproval(approvalId);
  if (!pending) {
    await sendWhatsApp(sender, `Unknown approval ID: ${approvalId}`);
    return;
  }
  try {
    // Step 1 — mark approved in kernel
    await approveActionRequest(approvalId);

    // Step 2 — issue capability token bound to this workspace + request
    const tokenRes = await issueToken(
      pending.workspace_id,
      pending.action_type,
      pending.action_request_id,
      approvalId,
    );

    // Step 3 — retry original action with the cap token (same request_id → idempotent)
    const result = await submitActionRequest(
      pending.workspace_id,
      pending.agent_id,
      pending.action_type,
      pending.payload,
      { requestId: pending.action_request_id, approvalToken: tokenRes.token },
    );

    removePendingApproval(approvalId);

    if (result.ok) {
      const reply = formatResult(result.exec);
      await sendWhatsApp(sender, `Approved. Result:\n\n${reply}`);
    } else {
      await sendWhatsApp(
        sender,
        `Approved but execution failed: ${result.error ?? JSON.stringify(result)}`,
      );
    }
    app.log.info({ sender, approvalId, action_type: pending.action_type }, "approved and executed");
  } catch (err) {
    await sendWhatsApp(sender, `Approval error: ${err.message}`);
    app.log.error({ err, sender, approvalId }, "handleApprove failed");
  }
}

// ── !deny handler ─────────────────────────────────────────────────────────────
async function handleDeny(sender, approvalId) {
  const pending = getPendingApproval(approvalId);
  if (!pending) {
    await sendWhatsApp(sender, `Unknown approval ID: ${approvalId}`);
    return;
  }
  try {
    await denyActionRequest(approvalId);
    removePendingApproval(approvalId);
    await sendWhatsApp(sender, `Denied: ${approvalId}`);
    app.log.info({ sender, approvalId }, "approval denied");
  } catch (err) {
    await sendWhatsApp(sender, `Deny error: ${err.message}`);
  }
}

// ── !run <command> handler ────────────────────────────────────────────────────
async function handleRun(sender, command, workspaceId) {
  const result = await submitActionRequest(workspaceId, sender, "run_shell", { command });

  if (result.approval_id) {
    const { approval_id, action_request_id } = result;
    savePendingApproval(approval_id, {
      sender,
      workspace_id: workspaceId,
      action_request_id,
      action_type: "run_shell",
      payload: { command },
      agent_id: sender,
    });
    await sendWhatsApp(
      sender,
      `Approval required to run:\n> ${command}\n\nID: ${approval_id}\n\nReply:\n!approve ${approval_id}`,
    );
    app.log.info({ sender, approval_id, command }, "run_shell approval required");
    return;
  }

  if (result.ok) {
    const reply = formatResult(result.exec);
    await sendWhatsApp(sender, reply);
    return;
  }

  await sendWhatsApp(sender, `Kernel error: ${result.error?.message ?? JSON.stringify(result)}`);
}

// ── PDF / document handler ────────────────────────────────────────────────────
async function handleDocument(sender, msg, workspaceId) {
  const mediaPath = msg.mediaPath;
  const filename = String(msg.filename ?? msg.mediaPath ?? "document.pdf")
    .split("/")
    .pop();

  await sendWhatsApp(sender, `Reading ${filename}…`);

  let text, pageCount;
  try {
    ({ text, pageCount } = await extractPdfText(mediaPath));
  } catch (err) {
    await sendWhatsApp(sender, `Could not read PDF: ${err.message}`);
    return;
  }

  const result = await submitActionRequest(workspaceId, sender, "summarize_document", {
    text,
    page_count: pageCount,
    filename,
  });

  if (result.ok) {
    await sendWhatsApp(sender, formatResult(result.exec ?? result));
    return;
  }

  await sendWhatsApp(sender, `Kernel error: ${result.error ?? JSON.stringify(result)}`);
}

// ── Normal message handler (web_search) ───────────────────────────────────────
async function handleMessage(sender, text, workspaceId) {
  const result = await submitActionRequest(workspaceId, sender, "web_search", { q: text });

  if (result.approval_id) {
    const { approval_id, action_request_id } = result;
    savePendingApproval(approval_id, {
      sender,
      workspace_id: workspaceId,
      action_request_id,
      action_type: "web_search",
      payload: { q: text },
      agent_id: sender,
    });
    await sendWhatsApp(
      sender,
      `Blocked. Approval needed: ${approval_id}\nReply: !approve ${approval_id}`,
    );
    app.log.info({ sender, approval_id }, "approval required");
    return;
  }

  if (result.ok) {
    await sendWhatsApp(sender, formatResult(result.exec));
    return;
  }

  await sendWhatsApp(
    sender,
    `Kernel error: ${result.error?.message ?? JSON.stringify(result.error ?? result)}`,
  );
}

// ── Inbound webhook ───────────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, reply) => {
  const msg = req.body ?? {};
  const text = String(msg.body ?? "").trim();
  const mediaPath = msg.mediaPath ? String(msg.mediaPath) : null;

  // DMs: prefer E.164; Groups: use senderJid; fallback to `from`.
  const sender = msg.senderE164 ?? msg.senderJid ?? msg.from;

  // A PDF message may have no body text — allow it through if mediaPath is set
  if ((!text && !mediaPath) || !sender) {
    return reply.code(400).send({ error: "empty body or missing sender" });
  }

  app.log.info(
    { sender, chatType: msg.chatType, bodyLen: text.length, hasMedia: Boolean(mediaPath) },
    "inbound",
  );

  // ── PDF / document ────────────────────────────────────────────────────────
  if (mediaPath && (mediaPath.endsWith(".pdf") || String(msg.mimeType ?? "").includes("pdf"))) {
    let wsId;
    try {
      wsId = await ensureWorkspace(sender);
    } catch (err) {
      await sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
      return reply.code(500).send({ error: "workspace_error" });
    }
    await handleDocument(sender, msg, wsId).catch((err) => {
      app.log.error({ err, sender, mediaPath }, "handleDocument failed");
      sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
    });
    return { ok: true };
  }

  // ── !approve <id> ─────────────────────────────────────────────────────────
  if (text.startsWith("!approve ")) {
    const approvalId = text.slice("!approve ".length).trim();
    await handleApprove(sender, approvalId).catch((err) =>
      app.log.error({ err, sender, approvalId }, "handleApprove failed"),
    );
    return { ok: true };
  }

  // ── !deny <id> ────────────────────────────────────────────────────────────
  if (text.startsWith("!deny ")) {
    const approvalId = text.slice("!deny ".length).trim();
    await handleDeny(sender, approvalId).catch((err) =>
      app.log.error({ err, sender, approvalId }, "handleDeny failed"),
    );
    return { ok: true };
  }

  // ── !run <command> ────────────────────────────────────────────────────────
  if (text.startsWith("!run ")) {
    const command = text.slice("!run ".length).trim();
    if (!command) {
      await sendWhatsApp(sender, "Usage: !run <shell command>").catch(() => {});
      return { ok: true };
    }
    let wsId;
    try {
      wsId = await ensureWorkspace(sender);
    } catch (err) {
      await sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
      return reply.code(500).send({ error: "workspace_error" });
    }
    await handleRun(sender, command, wsId).catch((err) => {
      app.log.error({ err, sender, command }, "handleRun failed");
      sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
    });
    return { ok: true };
  }

  // ── Normal message → web_search ───────────────────────────────────────────
  let wsId;
  try {
    wsId = await ensureWorkspace(sender);
  } catch (err) {
    app.log.error({ err, sender }, "ensureWorkspace failed");
    await sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
    return reply.code(500).send({ error: "workspace_error" });
  }

  try {
    await handleMessage(sender, text, wsId);
  } catch (err) {
    app.log.error({ err, sender, wsId }, "handleMessage failed");
    await sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
    return reply.code(500).send({ error: "action_failed" });
  }

  return { ok: true };
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", async () => {
  let kernelOk = false;
  let kernelDetail = null;
  try {
    const h = await kernelHealth();
    kernelOk = h.ok === true;
    kernelDetail = h;
  } catch (err) {
    kernelDetail = { error: err.message };
  }
  return {
    ok: true,
    service: "clawos-bridge",
    kernel: { ok: kernelOk, detail: kernelDetail },
    send_url: BRIDGE_SEND_URL,
  };
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
