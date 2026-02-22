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
  registerAgent,
  kernelCreateTask,
  kernelSpawnSubagent,
  kernelRequestDCT,
  kernelGrantDCT,
  kernelDenyDCT,
  kernelRunSubagent,
  kernelResolveSession,
  kernelUpdateSession,
} from "./kernel.js";
import { extractPdfText } from "./pdf.js";
import {
  getWorkspaceId,
  saveWorkspaceId,
  isAgentRegistered,
  setAgentRegistered,
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

// ── Workspace + Agent bootstrap ───────────────────────────────────────────────
// Creates workspace on first message and registers the sender as an AGENT.
// The sender's E.164/JID IS their agent_id — the WhatsApp number is the identity.
async function ensureAgent(sender) {
  let wsId = getWorkspaceId(sender);
  if (!wsId) {
    wsId = await createWorkspace();
    saveWorkspaceId(sender, wsId);
    app.log.info({ sender, wsId }, "created workspace");
  }
  if (!isAgentRegistered(sender)) {
    await registerAgent(wsId, sender, "orchestrator");
    setAgentRegistered(sender);
    app.log.info({ sender, wsId }, "registered agent");
  }
  return wsId;
}

// Keep alias for callers that use the old name
const ensureWorkspace = ensureAgent;

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

// ── Agent-architecture metadata ───────────────────────────────────────────────
// Maps kernel action_type → worker_type, DCT scope, description, reversibility.
const ACTION_META = {
  run_shell: {
    worker: "shell_executor",
    scope: { allowed_tools: ["run_shell"], operations: ["execute"] },
    description: "Run a shell command on the system",
    reversible: false,
  },
  web_search: {
    worker: "web_researcher",
    scope: { allowed_tools: ["web_search"], operations: ["read"] },
    description: "Search the web for information",
    reversible: true,
  },
  write_file: {
    worker: "file_writer",
    scope: { allowed_tools: ["write_file"], operations: ["write"] },
    description: "Write a file in the workspace",
    reversible: true,
  },
  read_file: {
    worker: "file_reader",
    scope: { allowed_tools: ["read_file"], operations: ["read"] },
    description: "Read a file in the workspace",
    reversible: true,
  },
};

/** Map action params to the shape the worker handler expects. */
function buildWorkerInput(actionType, params) {
  switch (actionType) {
    case "run_shell":
      return { command: params?.command ?? "" };
    case "web_search":
      return { query: params?.q ?? "" };
    case "write_file":
      return { path: params?.path ?? "", content: params?.content ?? "" };
    case "read_file":
      return { path: params?.path ?? "" };
    default:
      return params ?? {};
  }
}

/**
 * Core agent execution path — used for ALL user-facing actions.
 *
 * Flow:
 *   AGENT creates TASK  →  spawns SUBAGENT  →  requests DCT
 *   → if approval needed: store pending + ask user (yes/no/more/edit)
 *   → if auto:            run subagent immediately → prettify → reply
 */
async function routeViaAgent(
  sender,
  workspaceId,
  actionType,
  params,
  originalQuery,
  sessionId = null,
  contextSummary = "",
) {
  const meta = ACTION_META[actionType] ?? ACTION_META.web_search;
  const input = buildWorkerInput(actionType, params);
  const title = `${actionType}: ${originalQuery?.slice(0, 60) ?? actionType}`;

  // Build task objective — include session context so the worker has prior turn info
  const objective = contextSummary
    ? `${originalQuery ?? actionType}\n\n--- Session context ---\n${contextSummary}`
    : (originalQuery ?? actionType);

  // 1. Create contract-first task
  let taskRes;
  try {
    taskRes = await kernelCreateTask(
      workspaceId,
      sender,
      title,
      {
        objective,
        scope: { tools: meta.scope.allowed_tools },
        deliverables: ["result"],
        acceptance_checks: [{ type: "min_artifacts", count: 1 }],
      },
      { steps: [{ id: "s1", worker_type: meta.worker }], delegation_plan: { s1: meta.worker } },
    );
  } catch (err) {
    app.log.error({ err, sender }, "kernelCreateTask failed");
    await sendWhatsApp(sender, `Bridge error: ${err.message}`);
    return;
  }
  const taskId = taskRes.task_id;

  // 2. Spawn subagent
  let saRes;
  try {
    saRes = await kernelSpawnSubagent(workspaceId, sender, taskId, meta.worker, "s1");
  } catch (err) {
    app.log.error({ err, sender, taskId }, "kernelSpawnSubagent failed");
    await sendWhatsApp(sender, `Bridge error: ${err.message}`);
    return;
  }
  const subagentId = saRes.subagent_id;

  // 3. Request Delegation Capability Token
  let dctRes;
  try {
    dctRes = await kernelRequestDCT(
      workspaceId,
      sender,
      { kind: "subagent", id: subagentId },
      meta.scope,
      taskId,
      600,
    );
  } catch (err) {
    app.log.error({ err, sender, subagentId }, "kernelRequestDCT failed");
    await sendWhatsApp(sender, `Bridge error: ${err.message}`);
    return;
  }

  // 3a. Blocked by policy
  if (dctRes.error === "scope_blocked_by_policy") {
    await sendWhatsApp(sender, `Action blocked by policy: ${dctRes.blocked_tool ?? actionType}`);
    return;
  }

  // 3b. Approval required — store DCT pending and ask user
  if (dctRes.needs_approval) {
    const pendingData = {
      pending_type: "dct_approval",
      dar_id: dctRes.dar_id,
      subagent_id: subagentId,
      task_id: taskId,
      workspace_id: workspaceId,
      action_type: actionType,
      payload: params, // kept for buildApprovalMessage / buildMoreMessage compat
      scope: meta.scope,
      original_query: originalQuery,
      agent_id: sender,
      risk_level: dctRes.risk_level,
      description: meta.description,
      reversible: meta.reversible,
      editing: false,
      // Session context — preserved through the approval round-trip
      session_id: sessionId,
      context_summary: contextSummary,
    };
    setSenderPending(sender, pendingData);
    await sendWhatsApp(sender, buildApprovalMessage(pendingData));
    app.log.info(
      { sender, dar_id: dctRes.dar_id, actionType, session_id: sessionId },
      "dct_approval required",
    );
    return;
  }

  // 3c. Token minted immediately (auto policy)
  await _executeSubagent(
    sender,
    workspaceId,
    subagentId,
    dctRes.token,
    actionType,
    input,
    originalQuery,
    sessionId,
  );
}

/**
 * Execute a subagent and send the prettified result to the user.
 * Shared by the auto path and the post-approval path.
 */
async function _executeSubagent(
  sender,
  workspaceId,
  subagentId,
  token,
  actionType,
  input,
  originalQuery,
  sessionId = null,
) {
  let runRes;
  try {
    runRes = await kernelRunSubagent(subagentId, workspaceId, token, input);
  } catch (err) {
    app.log.error({ err, sender, subagentId }, "kernelRunSubagent failed");
    await sendWhatsApp(sender, `Bridge error: ${err.message}`);
    return;
  }

  if (runRes.ok) {
    // result is the dispatch output from the worker; formatResult handles all known shapes
    const raw = formatResult(runRes.result ?? runRes);
    const friendly = await prettify(sender, workspaceId, actionType, raw, originalQuery ?? "");
    await sendWhatsApp(sender, friendly);
    app.log.info(
      { sender, subagent_id: subagentId, actionType, session_id: sessionId },
      "subagent executed",
    );

    // Advance session context — non-fatal, fire-and-forget
    if (sessionId) {
      kernelUpdateSession(sessionId, workspaceId, originalQuery ?? "", friendly, actionType).catch(
        (err) =>
          app.log.warn({ err, session_id: sessionId }, "session context update failed — non-fatal"),
      );
    }
  } else {
    await sendWhatsApp(sender, `Kernel error: ${runRes.error ?? JSON.stringify(runRes)}`);
  }
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

// ── DCT approval path (new agent architecture) ────────────────────────────────
async function handleDCTApprove(sender, sp) {
  try {
    // 1. Grant the DCT approval request
    await kernelGrantDCT(sp.dar_id);

    // 2. Re-request DCT now that approval is granted
    const dctRes = await kernelRequestDCT(
      sp.workspace_id,
      sender,
      { kind: "subagent", id: sp.subagent_id },
      sp.scope,
      sp.task_id,
      600,
      sp.dar_id,
    );

    if (!dctRes.ok) {
      await sendWhatsApp(sender, `Token request failed: ${dctRes.error ?? JSON.stringify(dctRes)}`);
      return;
    }

    clearSenderPending(sender);

    // 3. Run the subagent with the freshly minted DCT
    const input = buildWorkerInput(sp.action_type, sp.payload);
    await _executeSubagent(
      sender,
      sp.workspace_id,
      sp.subagent_id,
      dctRes.token,
      sp.action_type,
      input,
      sp.original_query,
      sp.session_id ?? null,
    );
    app.log.info(
      { sender, dar_id: sp.dar_id, action_type: sp.action_type, session_id: sp.session_id ?? null },
      "dct approved and executed",
    );
  } catch (err) {
    await sendWhatsApp(sender, `Approval error: ${err.message}`);
    app.log.error({ err, sender }, "handleDCTApprove failed");
  }
}

async function handleDCTDeny(sender, sp) {
  try {
    await kernelDenyDCT(sp.dar_id);
    clearSenderPending(sender);
    await sendWhatsApp(sender, "Cancelled.");
    app.log.info({ sender, dar_id: sp.dar_id }, "dct denied");
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
  if (sp.pending_type === "dct_approval") {
    await handleDCTApprove(sender, sp);
  } else {
    // Legacy action-request approval path
    await handleApprove(sender, sp.approval_id);
  }
}

// ── "no" — deny sender's latest pending ──────────────────────────────────────
async function handleNo(sender) {
  const sp = getSenderPending(sender);
  if (!sp) {
    await sendWhatsApp(sender, "No pending action to cancel.");
    return;
  }
  if (sp.pending_type === "dct_approval") {
    await handleDCTDeny(sender, sp);
  } else {
    // Legacy action-request denial path
    await handleDeny(sender, sp.approval_id);
  }
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
    // Editing state expired — treat as new message (no session context available)
    await routeMessage(sender, text, wsId);
    return;
  }

  // Preserve session context through the edit round-trip
  const sessionId = sp.session_id ?? null;
  const contextSummary = sp.context_summary ?? "";

  // Discard the old pending.
  // For DCT-pending: the old subagent/task stay in DB as orphaned (they'll never run).
  // For legacy pending: orphan the action request.
  if (sp.approval_id) {
    removePendingApproval(sp.approval_id);
  }
  clearSenderPending(sender);

  if (sp.action_type === "run_shell") {
    // Shell edit: use the new text as-is (no re-classification — user knows what they want)
    await routeViaAgent(
      sender,
      wsId,
      "run_shell",
      { command: text },
      text,
      sessionId,
      contextSummary,
    );
  } else {
    // All other edits: re-classify (user may have pivoted intent)
    await routeMessage(sender, text, wsId, sessionId, contextSummary);
  }
}

// ── Shell command handler — routes through agent architecture ─────────────────
async function handleRun(
  sender,
  command,
  workspaceId,
  originalQuery = command,
  sessionId = null,
  contextSummary = "",
) {
  await routeViaAgent(
    sender,
    workspaceId,
    "run_shell",
    { command },
    originalQuery,
    sessionId,
    contextSummary,
  );
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

// ── Web search handler — routes through agent architecture ────────────────────
async function handleWebSearch(
  sender,
  query,
  workspaceId,
  originalQuery = query,
  sessionId = null,
  contextSummary = "",
) {
  await routeViaAgent(
    sender,
    workspaceId,
    "web_search",
    { q: query },
    originalQuery,
    sessionId,
    contextSummary,
  );
}

// ── Generic action handler — routes through agent architecture ────────────────
async function handleDirectAction(
  sender,
  actionType,
  params,
  workspaceId,
  originalQuery = "",
  sessionId = null,
  contextSummary = "",
) {
  await routeViaAgent(
    sender,
    workspaceId,
    actionType,
    params,
    originalQuery,
    sessionId,
    contextSummary,
  );
}

// ── NL Router: classify → dispatch ───────────────────────────────────────────
// Confidence thresholds — conservative to avoid accidental shell execution
const CONFIDENCE = { run_shell: 0.7, write_file: 0.75, read_file: 0.7 };

async function routeMessage(sender, text, workspaceId, sessionId = null, contextSummary = "") {
  // Classify intent via kernel action (uses Claude Haiku, falls back to heuristics)
  // Pass session context so the classifier can resolve pronouns / topic references.
  let classified = null;
  try {
    const classifyPayload = { text };
    if (contextSummary) {
      classifyPayload.context_summary = contextSummary;
    }
    const cls = await submitActionRequest(workspaceId, sender, "classify_intent", classifyPayload);
    if (cls.ok && cls.exec?.result) {
      classified = cls.exec.result;
      app.log.info(
        {
          sender,
          action_type: classified.action_type,
          confidence: classified.confidence,
          mode: classified.mode,
          session_id: sessionId,
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
      await handleRun(sender, command, workspaceId, text, sessionId, contextSummary);
      return;
    }

    if (action_type === "write_file" && confidence >= CONFIDENCE.write_file) {
      await handleDirectAction(
        sender,
        "write_file",
        params,
        workspaceId,
        text,
        sessionId,
        contextSummary,
      );
      return;
    }

    if (action_type === "read_file" && confidence >= CONFIDENCE.read_file) {
      await handleDirectAction(
        sender,
        "read_file",
        params,
        workspaceId,
        text,
        sessionId,
        contextSummary,
      );
      return;
    }

    // web_search, none, or below-threshold confidence → web_search fallback
    const query = params?.q ?? text;
    await handleWebSearch(sender, query, workspaceId, text, sessionId, contextSummary);
    return;
  }

  // Classification unavailable — fall back to web_search
  await handleWebSearch(sender, text, workspaceId, text, sessionId, contextSummary);
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

  // ── Resolve (or create) session for this sender ───────────────────────────
  let sessionId = null;
  let contextSummary = "";
  try {
    const sessionRes = await kernelResolveSession(wsId, "whatsapp", sender, text);
    sessionId = sessionRes.session_id ?? null;
    contextSummary = sessionRes.session?.context_summary ?? "";
    app.log.info(
      { sender, session_id: sessionId, decision: sessionRes.decision, reason: sessionRes.reason },
      "session resolved",
    );
    // Explicit reset: acknowledge, clear any stale pending, skip normal routing
    if (sessionRes.decision === "new" && sessionRes.reason === "explicit_reset") {
      clearSenderPending(sender);
      await sendWhatsApp(sender, "Starting fresh. How can I help you?");
      return { ok: true };
    }
  } catch (err) {
    app.log.warn({ err, sender }, "kernelResolveSession failed — continuing without session");
  }

  try {
    await routeMessage(sender, text, wsId, sessionId, contextSummary);
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
