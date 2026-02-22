/**
 * ClawOS WhatsApp → Kernel Bridge
 *
 * Receives inbound WhatsApp messages from the OpenClaw messageSink tap,
 * submits action requests to the Kernel, and sends replies back via the
 * bridge send server running inside the OpenClaw process.
 *
 * Supported WhatsApp commands:
 *   !approve <approval_id>  — approve a pending kernel action
 *   !deny <approval_id>     — reject a pending kernel action
 *   <anything else>         — submitted as web_search { q: <text> }
 */
import Fastify from "fastify";
import {
  createWorkspace,
  submitActionRequest,
  approveActionRequest,
  denyActionRequest,
  kernelHealth,
} from "./kernel.js";
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

// ── !approve handler ──────────────────────────────────────────────────────────
async function handleApprove(sender, approvalId) {
  const pending = getPendingApproval(approvalId);
  if (!pending) {
    await sendWhatsApp(sender, `Unknown approval: ${approvalId}`);
    return;
  }
  try {
    await approveActionRequest(approvalId);
    removePendingApproval(approvalId);
    await sendWhatsApp(sender, `Approved: ${approvalId}`);
    app.log.info({ sender, approvalId }, "approval granted");
  } catch (err) {
    await sendWhatsApp(sender, `Approval error: ${err.message}`);
  }
}

// ── !deny handler ─────────────────────────────────────────────────────────────
async function handleDeny(sender, approvalId) {
  const pending = getPendingApproval(approvalId);
  if (!pending) {
    await sendWhatsApp(sender, `Unknown approval: ${approvalId}`);
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

// ── Normal message handler ────────────────────────────────────────────────────
async function handleMessage(sender, text, workspaceId) {
  const result = await submitActionRequest(workspaceId, sender, "web_search", { q: text });

  if (result.approval_id) {
    // Kernel returned approval_required — store it and prompt the user.
    const { approval_id, action_request_id } = result;
    savePendingApproval(approval_id, { sender, workspace_id: workspaceId, action_request_id });
    await sendWhatsApp(
      sender,
      `Blocked. Approval needed: ${approval_id}\nReply: !approve ${approval_id}`,
    );
    app.log.info({ sender, approval_id }, "approval required");
    return;
  }

  if (result.ok) {
    // Kernel wraps the orchestrator result under exec.result.
    // exec shape: { ok, request_id, action_type, result: { ok, mode, query, note, ... }, ms }
    const exec = result.exec ?? {};
    const inner = exec.result ?? exec;
    const reply =
      inner.note ??
      inner.output ??
      inner.text ??
      (inner.ok === false
        ? `Error: ${inner.message ?? JSON.stringify(inner)}`
        : JSON.stringify(inner));
    await sendWhatsApp(sender, `${reply}`);
    return;
  }

  // Unexpected response shape — surface it.
  const errMsg = result.error?.message ?? JSON.stringify(result.error ?? result);
  await sendWhatsApp(sender, `Kernel error: ${errMsg}`);
}

// ── Inbound webhook ───────────────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, reply) => {
  const msg = req.body ?? {};
  const text = String(msg.body ?? "").trim();

  // Resolve the canonical sender identifier.
  // DMs: prefer E.164; Groups: use senderJid; fallback to the conversation `from`.
  const sender = msg.senderE164 ?? msg.senderJid ?? msg.from;

  if (!text || !sender) {
    return reply.code(400).send({ error: "empty body or missing sender" });
  }

  app.log.info({ sender, chatType: msg.chatType, bodyLen: text.length }, "inbound");

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
