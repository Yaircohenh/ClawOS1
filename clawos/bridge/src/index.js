/**
 * ClawOS WhatsApp → Kernel Bridge
 *
 * Receives inbound WhatsApp messages from the OpenClaw messageSink tap,
 * submits action requests to the Kernel, and sends replies back via the
 * bridge send server running inside the OpenClaw process.
 *
 * Approval UX (natural language — no IDs needed):
 *   yes          — approve the latest pending action
 *   no           — deny the latest pending action
 *   more         — get a detailed explanation of what will happen
 *   edit         — enter edit mode: next message replaces the pending input
 *
 *   <anything>   — classified by Claude Haiku → routed to the best action
 *                  (web_search, run_shell, write_file, read_file)
 *                  Falls back to keyword heuristics when no Anthropic key.
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
  getSenderPending,
  setSenderPending,
  clearSenderPending,
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

// ── LLM-powered result prettifier ────────────────────────────────────────────
// Calls interpret_result on the kernel to get a friendly WhatsApp-formatted
// reply. Falls back to formatResult() if interpret_result is unavailable.
async function prettify(sender, wsId, actionType, rawOutput, originalQuery) {
  try {
    const cls = await submitActionRequest(wsId, sender, "interpret_result", {
      action_type: actionType,
      original_query: originalQuery,
      raw_output: rawOutput,
    });
    if (cls.ok && cls.exec?.result?.formatted) {
      return cls.exec.result.formatted;
    }
  } catch {
    // Fall through to raw output
  }
  return rawOutput;
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

// ── Approval message builder ───────────────────────────────────────────────────
function buildApprovalMessage(pending) {
  const { action_type, payload, description, risk_level, reversible } = pending;

  const riskLabel =
    {
      low: "Low",
      medium: "Medium",
      high: "High",
      critical: "Critical",
    }[risk_level] ??
    risk_level ??
    "Unknown";

  const reversibleLabel = reversible ? "Yes — action can be undone" : "No — permanent side-effects";

  let detailLine = "";
  if (action_type === "run_shell") {
    detailLine = `Command: \`${payload?.command ?? ""}\`\n`;
  } else if (action_type === "web_search") {
    detailLine = `Query: "${payload?.q ?? ""}"\n`;
  } else if (action_type === "write_file") {
    detailLine = `File: ${payload?.path ?? ""}\n`;
  } else if (action_type === "send_email") {
    detailLine = `To: ${pending.agent_id ?? ""} | Subject: ${payload?.subject ?? ""}\n`;
  }

  return (
    `*Approval needed*\n` +
    `Action: ${description ?? action_type}\n` +
    detailLine +
    `Risk: ${riskLabel} | Reversible: ${reversibleLabel}\n\n` +
    `Reply: *yes* · *no* · *more* · *edit*`
  );
}

// ── Detailed "more" message builder ───────────────────────────────────────────
function buildMoreMessage(pending) {
  const { action_type, payload, description, risk_level, reversible } = pending;

  const riskExplain =
    {
      low: "This action is read-only and cannot change any data.",
      medium: "This action modifies data but the change is reversible.",
      high: "This action has significant side-effects that may be hard to undo.",
      critical: "This action is potentially destructive — proceed with extreme caution.",
    }[risk_level] ?? "Risk level unknown.";

  let payloadDetail = "";
  if (action_type === "run_shell") {
    payloadDetail = `Shell command to execute:\n\`\`\`\n${payload?.command ?? ""}\n\`\`\``;
  } else if (action_type === "web_search") {
    payloadDetail = `Search query: "${payload?.q ?? ""}"`;
  } else if (action_type === "write_file") {
    const preview = String(payload?.content ?? "").slice(0, 200);
    payloadDetail = `File: ${payload?.path ?? ""}\nContent preview:\n${preview}${(payload?.content?.length ?? 0) > 200 ? "…" : ""}`;
  } else if (action_type === "send_email") {
    payloadDetail = `To: ${payload?.to ?? ""}\nSubject: ${payload?.subject ?? ""}\nBody preview: ${String(payload?.body ?? "").slice(0, 150)}`;
  } else {
    payloadDetail = JSON.stringify(payload ?? {}, null, 2);
  }

  return (
    `*Details: ${description ?? action_type}*\n\n` +
    `${payloadDetail}\n\n` +
    `Risk level: ${risk_level ?? "unknown"}\n` +
    `${riskExplain}\n` +
    `Reversible: ${reversible ? "yes" : "no"}\n\n` +
    `Reply: *yes* · *no* · *edit*`
  );
}

// ── Register a pending approval in both maps ───────────────────────────────────
function registerPending(sender, approvalId, data) {
  savePendingApproval(approvalId, data);
  setSenderPending(sender, { ...data, approval_id: approvalId, editing: false });
}

// ── Clear a pending approval from both maps ────────────────────────────────────
function clearPending(sender, approvalId) {
  removePendingApproval(approvalId);
  clearSenderPending(sender);
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

    clearPending(sender, approvalId);

    if (result.ok) {
      const raw = formatResult(result.exec);
      const friendly = await prettify(
        sender,
        pending.workspace_id,
        pending.action_type,
        raw,
        pending.original_query ?? "",
      );
      await sendWhatsApp(sender, friendly);
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
    clearPending(sender, approvalId);
    await sendWhatsApp(sender, `Cancelled.`);
    app.log.info({ sender, approvalId }, "approval denied");
  } catch (err) {
    await sendWhatsApp(sender, `Deny error: ${err.message}`);
  }
}

// ── "yes" — approve sender's latest pending ───────────────────────────────────
async function handleYes(sender) {
  const sp = getSenderPending(sender);
  if (!sp) {
    await sendWhatsApp(sender, "No pending action to approve.");
    return;
  }
  await handleApprove(sender, sp.approval_id);
}

// ── "no" — deny sender's latest pending ──────────────────────────────────────
async function handleNo(sender) {
  const sp = getSenderPending(sender);
  if (!sp) {
    await sendWhatsApp(sender, "No pending action to cancel.");
    return;
  }
  await handleDeny(sender, sp.approval_id);
}

// ── "more" — show detailed explanation of latest pending ─────────────────────
async function handleMore(sender) {
  const sp = getSenderPending(sender);
  if (!sp) {
    await sendWhatsApp(sender, "No pending action.");
    return;
  }
  await sendWhatsApp(sender, buildMoreMessage(sp));
}

// ── "edit" — enter editing mode, ask user for replacement ────────────────────
async function handleEdit(sender) {
  const sp = getSenderPending(sender);
  if (!sp) {
    await sendWhatsApp(sender, "No pending action to edit.");
    return;
  }

  let editPrompt = "";
  if (sp.action_type === "run_shell") {
    editPrompt = `Current command:\n\`${sp.payload?.command ?? ""}\`\n\nSend the updated command (or *no* to cancel):`;
  } else if (sp.action_type === "web_search") {
    editPrompt = `Current query: "${sp.payload?.q ?? ""}"\n\nSend the updated search query (or *no* to cancel):`;
  } else if (sp.action_type === "write_file") {
    editPrompt = `Editing write to: ${sp.payload?.path ?? ""}\n\nSend the new file content (or *no* to cancel):`;
  } else {
    editPrompt = "Send the updated input (or *no* to cancel):";
  }

  setSenderPending(sender, { ...sp, editing: true });
  await sendWhatsApp(sender, editPrompt);
}

// ── Handle "editing" response — user sent the replacement ────────────────────
async function handleEditInput(sender, text, wsId) {
  const sp = getSenderPending(sender);
  if (!sp) {
    // Editing state expired — treat as new message
    await routeMessage(sender, text, wsId);
    return;
  }

  // Cancel the old pending (orphan it in the kernel — it'll expire)
  removePendingApproval(sp.approval_id);
  clearSenderPending(sender);

  if (sp.action_type === "run_shell") {
    // User edited a shell command — use the raw text as-is (no re-classification)
    await handleRun(sender, text, wsId);
  } else {
    // For all other types re-route through classify so the edited text is
    // dispatched to the best action (user may have pivoted from search to a command)
    await routeMessage(sender, text, wsId);
  }
}

// ── !run <command> handler ────────────────────────────────────────────────────
async function handleRun(sender, command, workspaceId, originalQuery = command) {
  const result = await submitActionRequest(workspaceId, sender, "run_shell", { command });

  if (result.approval_id) {
    const { approval_id, action_request_id } = result;
    const pendingData = {
      sender,
      workspace_id: workspaceId,
      action_request_id,
      action_type: "run_shell",
      payload: { command },
      agent_id: sender,
      original_query: originalQuery,
      risk_level: result.risk_level ?? "high",
      reversible: result.reversible ?? false,
      description: result.description ?? "Run a shell command on the system",
    };
    registerPending(sender, approval_id, pendingData);
    await sendWhatsApp(sender, buildApprovalMessage(pendingData));
    app.log.info({ sender, approval_id, command }, "run_shell approval required");
    return;
  }

  if (result.ok) {
    const raw = formatResult(result.exec);
    const friendly = await prettify(sender, workspaceId, "run_shell", raw, originalQuery);
    await sendWhatsApp(sender, friendly);
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

// ── Web search handler (direct, no classification) ────────────────────────────
async function handleWebSearch(sender, query, workspaceId, originalQuery = query) {
  const result = await submitActionRequest(workspaceId, sender, "web_search", { q: query });

  if (result.approval_id) {
    const { approval_id, action_request_id } = result;
    const pendingData = {
      sender,
      workspace_id: workspaceId,
      action_request_id,
      action_type: "web_search",
      payload: { q: query },
      agent_id: sender,
      original_query: originalQuery,
      risk_level: result.risk_level ?? "low",
      reversible: result.reversible ?? true,
      description: result.description ?? "Search the web for information",
    };
    registerPending(sender, approval_id, pendingData);
    await sendWhatsApp(sender, buildApprovalMessage(pendingData));
    app.log.info({ sender, approval_id }, "web_search approval required");
    return;
  }

  if (result.ok) {
    const raw = formatResult(result.exec);
    const friendly = await prettify(sender, workspaceId, "web_search", raw, originalQuery);
    await sendWhatsApp(sender, friendly);
    return;
  }

  await sendWhatsApp(
    sender,
    `Kernel error: ${result.error?.message ?? JSON.stringify(result.error ?? result)}`,
  );
}

// ── Generic action handler (write_file, read_file, etc.) ─────────────────────
async function handleDirectAction(sender, actionType, params, workspaceId, originalQuery = "") {
  const result = await submitActionRequest(workspaceId, sender, actionType, params);

  if (result.approval_id) {
    const { approval_id, action_request_id } = result;
    const pendingData = {
      sender,
      workspace_id: workspaceId,
      action_request_id,
      action_type: actionType,
      payload: params,
      agent_id: sender,
      original_query: originalQuery,
      risk_level: result.risk_level ?? "medium",
      reversible: result.reversible ?? true,
      description: result.description ?? actionType,
    };
    registerPending(sender, approval_id, pendingData);
    await sendWhatsApp(sender, buildApprovalMessage(pendingData));
    app.log.info({ sender, approval_id, actionType }, "action approval required");
    return;
  }

  if (result.ok) {
    const raw = formatResult(result.exec ?? result);
    const friendly = await prettify(sender, workspaceId, actionType, raw, originalQuery);
    await sendWhatsApp(sender, friendly);
    return;
  }

  await sendWhatsApp(
    sender,
    `Kernel error: ${result.error?.message ?? JSON.stringify(result.error ?? result)}`,
  );
}

// ── NL Router: classify → dispatch ───────────────────────────────────────────
// Confidence thresholds — conservative to avoid accidental shell execution
const CONFIDENCE = { run_shell: 0.7, write_file: 0.75, read_file: 0.7 };

async function routeMessage(sender, text, workspaceId) {
  // Classify intent via kernel action (uses Claude Haiku, falls back to heuristics)
  let classified = null;
  try {
    const cls = await submitActionRequest(workspaceId, sender, "classify_intent", { text });
    if (cls.ok && cls.exec?.result) {
      classified = cls.exec.result;
      app.log.info(
        {
          sender,
          action_type: classified.action_type,
          confidence: classified.confidence,
          mode: classified.mode,
        },
        "classified",
      );
    }
  } catch (err) {
    app.log.warn({ err, sender }, "classify_intent failed — falling back to web_search");
  }

  if (classified) {
    const { action_type, params, confidence } = classified;

    if (action_type === "run_shell" && confidence >= CONFIDENCE.run_shell) {
      const command = params?.command ?? text;
      await handleRun(sender, command, workspaceId, text);
      return;
    }

    if (action_type === "write_file" && confidence >= CONFIDENCE.write_file) {
      await handleDirectAction(sender, "write_file", params, workspaceId, text);
      return;
    }

    if (action_type === "read_file" && confidence >= CONFIDENCE.read_file) {
      await handleDirectAction(sender, "read_file", params, workspaceId, text);
      return;
    }

    // web_search, none, or below-threshold confidence → web_search fallback
    const query = params?.q ?? text;
    await handleWebSearch(sender, query, workspaceId, text);
    return;
  }

  // Classification unavailable — fall back to web_search
  await handleWebSearch(sender, text, workspaceId, text);
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

  // ── Check if sender is in "editing" state ─────────────────────────────────
  const senderState = getSenderPending(sender);
  if (senderState?.editing) {
    // "no" cancels editing too
    const normalized = text.toLowerCase().trim();
    if (normalized === "no") {
      await handleNo(sender).catch((err) =>
        app.log.error({ err, sender }, "handleNo (from edit) failed"),
      );
      return { ok: true };
    }
    let wsId;
    try {
      wsId = await ensureWorkspace(sender);
    } catch (err) {
      await sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
      return reply.code(500).send({ error: "workspace_error" });
    }
    await handleEditInput(sender, text, wsId).catch((err) => {
      app.log.error({ err, sender }, "handleEditInput failed");
      sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
    });
    return { ok: true };
  }

  // ── Natural-language approval keywords ───────────────────────────────────
  const normalized = text.toLowerCase().trim();

  if (normalized === "yes" || normalized === "y") {
    await handleYes(sender).catch((err) => app.log.error({ err, sender }, "handleYes failed"));
    return { ok: true };
  }

  if (normalized === "no" || normalized === "n") {
    await handleNo(sender).catch((err) => app.log.error({ err, sender }, "handleNo failed"));
    return { ok: true };
  }

  if (normalized === "more" || normalized === "more info" || normalized === "more information") {
    await handleMore(sender).catch((err) => app.log.error({ err, sender }, "handleMore failed"));
    return { ok: true };
  }

  if (normalized === "edit") {
    await handleEdit(sender).catch((err) => app.log.error({ err, sender }, "handleEdit failed"));
    return { ok: true };
  }

  // ── Route message through intent classifier ───────────────────────────────
  let wsId;
  try {
    wsId = await ensureWorkspace(sender);
  } catch (err) {
    app.log.error({ err, sender }, "ensureWorkspace failed");
    await sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
    return reply.code(500).send({ error: "workspace_error" });
  }

  try {
    await routeMessage(sender, text, wsId);
  } catch (err) {
    app.log.error({ err, sender, wsId }, "routeMessage failed");
    await sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
    return reply.code(500).send({ error: "route_failed" });
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
