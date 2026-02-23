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
  kernelConnections,
  registerAgent,
  kernelCreateTask,
  kernelSpawnSubagent,
  kernelRequestDCT,
  kernelGrantDCT,
  kernelDenyDCT,
  kernelRunSubagent,
  kernelResolveSession,
  kernelUpdateSession,
  kernelResolveObjective,
  kernelUpdateObjective,
  kernelAddToolEvidence,
  kernelCognitivePhase,
  kernelAddSessionTurn,
} from "./kernel.js";
import { extractPdfText } from "./pdf.js";
import {
  getWorkspaceId,
  saveWorkspaceId,
  clearWorkspaceId,
  isAgentRegistered,
  setAgentRegistered,
  clearAgentRegistered,
  getPendingApproval,
  removePendingApproval,
  getSenderPending,
  setSenderPending,
  clearSenderPending,
} from "./state.js";

const PORT = Number(process.env.BRIDGE_PORT ?? 18790);
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";
const BRIDGE_SEND_URL = process.env.BRIDGE_SEND_URL ?? "http://localhost:18791/send";
const DEBUG = process.env.DEBUG === "true";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

// ── Debug helpers ─────────────────────────────────────────────────────────────
/** Short random message ID for per-request correlation. */
function newMsgId() {
  return "msg_" + Math.random().toString(36).slice(2, 10);
}

/**
 * Build the [dbg …] footer appended to outbound messages when DEBUG=true.
 * Includes msg_id so the user can correlate a reply back to a log line.
 */
function dbgFooter(t) {
  if (!DEBUG || !t) {
    return "";
  }
  const ws = t.workspace_id ? t.workspace_id.slice(-8) : "?";
  const sess = t.session_id ? t.session_id.slice(-8) : "?";
  // Compact attempt summary: "xai:success" or "xai:policy_block,xai_retry:success"
  const attSummary =
    Array.isArray(t.provider_attempts) && t.provider_attempts.length
      ? t.provider_attempts.map((a) => `${a.provider}:${a.outcome}`).join(",")
      : null;
  return (
    `\n\n[dbg msg=${t.msg_id ?? "?"} ws=…${ws} sess=…${sess} ` +
    (t.intent ? `intent=${t.intent}(${t.intent_confidence?.toFixed(2) ?? "?"}) ` : "") +
    `route=${t.router_decision ?? "?"} ` +
    `provider=${t.provider ?? "?"} model=${t.model ?? "?"} ` +
    `found=${t.provider_found ?? "?"} fallback=${t.fallback_used ?? false} ` +
    `blocked=${t.policy_blocked ?? false}` +
    (attSummary ? ` attempts=${attSummary}` : "") +
    `]`
  );
}

// Regex: user message must match to allow web_search routing (strict gating).
const SEARCH_EXPLICIT_RE =
  /\b(search|find|look\s*up|google|research|browse|what\s+is|who\s+is|how\s+(do|does|to|come)|tell\s+me\s+about|explain|describe|latest|news|current|recent|price|when\s+(did|was|is|will)|where\s+(is|can)|why\s+(is|does|did)|information\s+about|meaning\s+of|definition\s+of|show\s+me|get\s+me)\b/i;

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

// Reset stale workspace state and re-bootstrap (called on workspace_not_found).
async function resetAndEnsureAgent(sender) {
  app.log.warn({ sender }, "stale workspace — resetting and recreating");
  clearWorkspaceId(sender);
  clearAgentRegistered(sender);
  const wsId = await createWorkspace();
  saveWorkspaceId(sender, wsId);
  await registerAgent(wsId, sender, "orchestrator");
  setAgentRegistered(sender);
  app.log.info({ sender, wsId }, "recreated workspace + agent");
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
  send_email: {
    worker: "email_sender",
    scope: { allowed_tools: ["send_email"], operations: ["write"] },
    description: "Send an email via your configured email account",
    reversible: false,
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
    case "send_email":
      return { to: params?.to ?? "", subject: params?.subject ?? "", body: params?.body ?? "" };
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
  objectiveId = null,
  objectiveGoal = "",
  trace = null,
) {
  const meta = ACTION_META[actionType] ?? ACTION_META.web_search;
  const input = buildWorkerInput(actionType, params);
  const title = `${actionType}: ${originalQuery?.slice(0, 60) ?? actionType}`;

  // Build task objective — include cognitive objective goal + session context
  const taskObjective = [
    objectiveGoal || originalQuery || actionType,
    contextSummary ? `--- Session context ---\n${contextSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // 1. Create contract-first task
  let taskRes;
  try {
    taskRes = await kernelCreateTask(
      workspaceId,
      sender,
      title,
      {
        objective: taskObjective,
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
      payload: params,
      scope: meta.scope,
      original_query: originalQuery,
      agent_id: sender,
      risk_level: dctRes.risk_level,
      description: meta.description,
      reversible: meta.reversible,
      editing: false,
      // Session + cognitive context — preserved through the approval round-trip
      session_id: sessionId,
      context_summary: contextSummary,
      objective_id: objectiveId,
      objective_goal: objectiveGoal,
    };
    setSenderPending(sender, pendingData);
    await sendWhatsApp(sender, buildApprovalMessage(pendingData));
    app.log.info(
      {
        sender,
        dar_id: dctRes.dar_id,
        actionType,
        session_id: sessionId,
        objective_id: objectiveId,
      },
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
    objectiveId,
    trace,
  );
}

/**
 * Execute a subagent and send the validated, truth-checked result to the user.
 * Shared by the auto path and the post-approval path.
 *
 * Cognitive pipeline added here:
 *   1. Record real tool evidence in kernel (for tool-truth gate)
 *   2. Prettify raw output
 *   3. Enforce tool-truth (strip false claims if no evidence)
 *   4. Validate deliverable (count + format check)
 *   5. Auto-repair once if deliverable incomplete
 *   6. Send final output
 *   7. Update session context + turns
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
  objectiveId = null,
  trace = null,
) {
  let runRes;
  try {
    runRes = await kernelRunSubagent(subagentId, workspaceId, token, input);
  } catch (err) {
    app.log.error({ err, sender, subagentId }, "kernelRunSubagent failed");
    await sendWhatsApp(sender, `Bridge error: ${err.message}`);
    return;
  }

  if (!runRes.ok) {
    await sendWhatsApp(sender, `Kernel error: ${runRes.error ?? JSON.stringify(runRes)}`);
    return;
  }

  // ── Provider failure gate: no silent fallback ──────────────────────────────
  // web_search returns mode="manual_research" when no Brave key is configured
  // or the provider call fails.  Surface this as an explicit error.
  if (actionType === "web_search" && runRes.result?.mode === "manual_research") {
    const note = runRes.result.note ?? "Add a Brave API key in Settings → Connections.";
    app.log.error({ sender, note }, "web_search: provider unavailable (manual_research)");
    if (trace) {
      trace.provider = "none";
      trace.fallback_used = true;
    }
    await sendWhatsApp(sender, `Web search unavailable — no search provider configured.\n${note}`);
    return;
  }

  // send_email: surface missing SMTP config as a helpful guide rather than a generic error
  if (actionType === "send_email" && runRes.result?.missing_connection === "smtp") {
    const msg =
      runRes.result.error ??
      "SMTP not configured. Go to Settings → Connections → SMTP to add your email server details.";
    app.log.warn({ sender }, "send_email: SMTP not configured");
    await sendWhatsApp(sender, msg + dbgFooter(trace));
    return;
  }

  // ── Populate trace with provider / model ──────────────────────────────────
  if (trace) {
    trace.provider = runRes.result?.mode ?? runRes.result?.provider ?? "unknown";
    trace.model = runRes.result?.model ?? null;
    trace.tools = actionType;
  }

  // ── 1. Record tool evidence ────────────────────────────────────────────────
  if (objectiveId && sessionId) {
    const queryText = input?.query ?? input?.command ?? input?.q ?? originalQuery ?? "";
    const resultSummary = String(runRes.result?.output ?? runRes.result?.note ?? "").slice(0, 500);
    kernelAddToolEvidence(objectiveId, sessionId, {
      action_type: actionType,
      query_text: queryText,
      result_summary: resultSummary,
    }).catch((err) =>
      app.log.warn({ err, objective_id: objectiveId }, "evidence record failed — non-fatal"),
    );
  }

  // ── 2. Prettify raw output ─────────────────────────────────────────────────
  const raw = formatResult(runRes.result ?? runRes);
  let friendly = await prettify(sender, workspaceId, actionType, raw, originalQuery ?? "");

  // ── 3. Tool-truth enforcement ──────────────────────────────────────────────
  let toolTruthPassed = true;
  let toolRepairTriggered = false;
  if (objectiveId) {
    try {
      const truthRes = await kernelCognitivePhase(workspaceId, sender, "enforce_tool_truth", {
        output: friendly,
        objective_id: objectiveId,
      });
      if (truthRes.ok && truthRes.exec?.result) {
        const tr = truthRes.exec.result;
        toolTruthPassed = tr.passed;
        toolRepairTriggered = tr.tool_repair_triggered ?? false;
        if (!tr.passed && tr.sanitized_output) {
          friendly = tr.sanitized_output;
        }
        app.log.info(
          {
            sender,
            objective_id: objectiveId,
            tool_truth_check: tr.passed ? "pass" : "fail",
            claims_found: tr.claims_found,
            tool_repair_triggered: toolRepairTriggered,
          },
          "cognitive: tool_truth_check",
        );
      }
    } catch (err) {
      app.log.warn({ err }, "tool_truth enforcement failed — non-fatal");
    }
  }

  // ── 4+5. Deliverable validation + auto-repair ──────────────────────────────
  let deliverableCheck = "skip";
  let repairAttempts = 0;
  if (objectiveId) {
    try {
      const valRes = await kernelCognitivePhase(workspaceId, sender, "validate_deliverable", {
        output: friendly,
        objective_id: objectiveId,
      });
      if (valRes.ok && valRes.exec?.result) {
        const vr = valRes.exec.result;
        deliverableCheck = vr.passed ? "pass" : "fail";
        app.log.info(
          {
            sender,
            objective_id: objectiveId,
            deliverable_check: deliverableCheck,
            item_count: vr.item_count,
            required_count: vr.required_count,
            failures: vr.failures,
          },
          "cognitive: deliverable_check",
        );

        // Auto-repair once if validation failed
        if (!vr.passed && vr.required_count > 0) {
          repairAttempts = 1;
          const repairRes = await kernelCognitivePhase(workspaceId, sender, "repair_deliverable", {
            original_output: friendly,
            objective_id: objectiveId,
            tool_capabilities: { web_search: actionType === "web_search" },
          });
          if (repairRes.ok && repairRes.exec?.result?.ok && repairRes.exec.result.repaired_output) {
            friendly = repairRes.exec.result.repaired_output;
            deliverableCheck = "repaired";
            app.log.info(
              { sender, objective_id: objectiveId, repair_attempts: repairAttempts },
              "cognitive: deliverable_repaired",
            );
          } else {
            // Repair also failed — append structured failure note
            friendly += `\n\n_(Deliverable incomplete — objective still in progress.)_`;
            deliverableCheck = "fail_unrepaired";
          }
        }

        // Mark objective complete if deliverable passed
        if (deliverableCheck === "pass" || deliverableCheck === "repaired") {
          kernelUpdateObjective(objectiveId, {
            status: "completed",
            result_summary: friendly.slice(0, 500),
          }).catch(() => {});
        }
      }
    } catch (err) {
      app.log.warn({ err }, "deliverable validation failed — non-fatal");
    }
  }

  // ── 6. Send final output ───────────────────────────────────────────────────
  await sendWhatsApp(sender, friendly + dbgFooter(trace));
  app.log.info(
    {
      sender,
      subagent_id: subagentId,
      actionType,
      session_id: sessionId,
      objective_id: objectiveId,
      tool_truth_check: toolTruthPassed ? "pass" : "fail",
      deliverable_check: deliverableCheck,
      repair_attempts: repairAttempts,
      tool_repair_triggered: toolRepairTriggered,
    },
    "subagent executed",
  );

  // ── 7. Update session context + turns ─────────────────────────────────────
  if (sessionId) {
    kernelUpdateSession(sessionId, workspaceId, originalQuery ?? "", friendly, actionType).catch(
      (err) =>
        app.log.warn({ err, session_id: sessionId }, "session context update failed — non-fatal"),
    );
  }
  if (objectiveId && sessionId) {
    void kernelAddSessionTurn(objectiveId, sessionId, {
      user_message: originalQuery ?? "",
      assistant_response: friendly,
      action_type: actionType,
    });
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
      sp.objective_id ?? null,
    );
    app.log.info(
      {
        sender,
        dar_id: sp.dar_id,
        action_type: sp.action_type,
        session_id: sp.session_id ?? null,
        objective_id: sp.objective_id ?? null,
      },
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

  // Preserve session + cognitive context through the edit round-trip
  const sessionId = sp.session_id ?? null;
  const contextSummary = sp.context_summary ?? "";
  const objectiveId = sp.objective_id ?? null;
  const objectiveGoal = sp.objective_goal ?? "";

  if (sp.approval_id) {
    removePendingApproval(sp.approval_id);
  }
  clearSenderPending(sender);

  if (sp.action_type === "run_shell") {
    await routeViaAgent(
      sender,
      wsId,
      "run_shell",
      { command: text },
      text,
      sessionId,
      contextSummary,
      objectiveId,
      objectiveGoal,
    );
  } else {
    await routeMessage(sender, text, wsId, sessionId, contextSummary, objectiveId, objectiveGoal);
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
  objectiveId = null,
  objectiveGoal = "",
  trace = null,
) {
  await routeViaAgent(
    sender,
    workspaceId,
    "run_shell",
    { command },
    originalQuery,
    sessionId,
    contextSummary,
    objectiveId,
    objectiveGoal,
    trace,
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
  objectiveId = null,
  objectiveGoal = "",
  trace = null,
) {
  await routeViaAgent(
    sender,
    workspaceId,
    "web_search",
    { q: query },
    originalQuery,
    sessionId,
    contextSummary,
    objectiveId,
    objectiveGoal,
    trace,
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
  objectiveId = null,
  objectiveGoal = "",
  trace = null,
) {
  await routeViaAgent(
    sender,
    workspaceId,
    actionType,
    params,
    originalQuery,
    sessionId,
    contextSummary,
    objectiveId,
    objectiveGoal,
    trace,
  );
}

// ── Default chat LLM handler ──────────────────────────────────────────────────
// Called for all messages that don't match a specific tool intent.
// Submits chat_llm directly to the kernel (no task/subagent/DCT overhead).
async function handleChatLLM(
  sender,
  text,
  workspaceId,
  sessionId = null,
  contextSummary = "",
  objectiveId = null,
  trace = null,
) {
  let res;
  try {
    res = await submitActionRequest(workspaceId, sender, "chat_llm", {
      message: text,
      ...(contextSummary ? { context_summary: contextSummary } : {}),
    });
  } catch (err) {
    app.log.error({ err, sender }, "chat_llm: kernel request failed");
    await sendWhatsApp(sender, `Chat error: ${err.message}`);
    return;
  }

  if (!res.ok) {
    const errMsg = res.error ?? JSON.stringify(res);
    app.log.error({ sender, err: errMsg }, "chat_llm: kernel error");
    await sendWhatsApp(sender, `Chat error: ${errMsg}`);
    return;
  }

  const result = res.exec?.result ?? {};
  const reply = result.reply;

  if (!reply) {
    const errMsg =
      result.error ??
      "No LLM provider configured. Add an xAI or Anthropic API key in Settings → Connections.";
    const providerState = result.provider ?? "none";
    app.log.error(
      {
        sender,
        provider_state: providerState,
        policy_blocked: result.policy_blocked ?? false,
        configured: result.configured ?? [],
        provider_attempts: result.provider_attempts ?? [],
        errMsg,
      },
      "chat_llm: no reply",
    );
    if (trace) {
      trace.provider = providerState;
      trace.provider_found = false;
      trace.fallback_used = result.fallback_used ?? false;
      trace.policy_blocked = result.policy_blocked ?? false;
      trace.provider_attempts = result.provider_attempts ?? [];
    }
    await sendWhatsApp(sender, errMsg + dbgFooter(trace));
    return;
  }

  if (trace) {
    trace.router_decision = "chat_llm";
    trace.provider = result.provider ?? "unknown";
    trace.provider_found = true;
    trace.model = result.model ?? null;
    trace.tools = "chat_llm";
    trace.fallback_used = result.fallback_used ?? false;
    trace.policy_blocked = result.policy_blocked ?? false;
    trace.provider_attempts = result.provider_attempts ?? [];
  }

  app.log.info(
    {
      sender,
      provider: result.provider,
      model: result.model,
      reply_len: reply.length,
      fallback_used: result.fallback_used ?? false,
      policy_blocked: result.policy_blocked ?? false,
      provider_attempts: result.provider_attempts ?? [],
    },
    "chat_llm response",
  );

  await sendWhatsApp(sender, reply + dbgFooter(trace));

  // Update session context + turns
  if (sessionId) {
    kernelUpdateSession(sessionId, workspaceId, text, reply, "chat_llm").catch((err) =>
      app.log.warn({ err, session_id: sessionId }, "session update failed — non-fatal"),
    );
  }
  if (objectiveId && sessionId) {
    void kernelAddSessionTurn(objectiveId, sessionId, {
      user_message: text,
      assistant_response: reply,
      action_type: "chat_llm",
    });
  }
}

// ── Email handler — capability check + agent route ────────────────────────────
/**
 * Pre-flight check: query kernel connections to verify SMTP is configured.
 * If not → send a friendly setup guide. If yes → route through agent/DCT path.
 *
 * The approval gate (risk_level=high) is enforced by the DCT request, so the
 * user will still need to confirm before the email is actually sent.
 */
async function handleSendEmail(
  sender,
  params,
  workspaceId,
  originalQuery,
  sessionId = null,
  contextSummary = "",
  objectiveId = null,
  objectiveGoal = "",
  trace = null,
) {
  if (trace) {
    trace.router_decision = "send_email";
    trace.tools_planned = "send_email";
  }

  // ── Capability check: SMTP must be configured ──────────────────────────────
  try {
    const conns = await kernelConnections();
    const smtpStatus = conns?.connections?.smtp?.status ?? "disconnected";
    if (smtpStatus !== "connected") {
      const msg =
        "*Email not configured*\n\n" +
        "To send emails I need your SMTP settings. " +
        "Go to *Settings → Connections → SMTP* and add:\n" +
        "• Host (e.g. smtp.gmail.com)\n" +
        "• Port (587 for TLS, 465 for SSL)\n" +
        "• Username (your email address)\n" +
        "• Password (or App Password for Gmail)\n\n" +
        "_Once configured, send the same email request again._";
      if (trace) {
        trace.provider = "none";
        trace.provider_found = false;
      }
      await sendWhatsApp(sender, msg + dbgFooter(trace));
      return;
    }
  } catch (err) {
    app.log.warn({ err }, "kernelConnections check failed — proceeding with send_email attempt");
  }

  // SMTP is configured — route through agent/subagent/DCT (will trigger approval)
  await handleDirectAction(
    sender,
    "send_email",
    params,
    workspaceId,
    originalQuery,
    sessionId,
    contextSummary,
    objectiveId,
    objectiveGoal,
    trace,
  );
}

// ── NL Router: classify → dispatch ───────────────────────────────────────────
// Confidence thresholds — conservative to avoid accidental shell execution
const CONFIDENCE = { run_shell: 0.7, write_file: 0.75, read_file: 0.7, send_email: 0.75 };

async function routeMessage(
  sender,
  text,
  workspaceId,
  sessionId = null,
  contextSummary = "",
  objectiveId = null,
  objectiveGoal = "",
  trace = null,
) {
  if (trace) {
    trace.agent_id = sender;
  }

  // Build classify payload with session + objective context for pronoun resolution
  const classifyPayload = { text };
  const cogContext = [
    objectiveGoal ? `Objective: ${objectiveGoal}` : "",
    contextSummary ? `Session context: ${contextSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (cogContext) {
    classifyPayload.context_summary = cogContext;
  }

  let classified = null;
  try {
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
          objective_id: objectiveId,
        },
        "classified",
      );
      if (trace) {
        trace.intent = classified.action_type;
        trace.intent_confidence = classified.confidence;
        trace.router_decision = classified.action_type;
        trace.reason = classified.reasoning ?? classified.mode ?? null;
        trace.tools_planned = classified.action_type;
      }
    }
  } catch (err) {
    // Do NOT silently fall back — surface the classify failure
    app.log.error({ err, sender }, "classify_intent failed");
    if (trace) {
      trace.router_decision = "classify_failed";
      trace.fallback_used = true;
    }
    await sendWhatsApp(
      sender,
      `Could not classify your request: ${err.message}.\nPlease try rephrasing or check your API key in Settings → Connections.`,
    );
    return;
  }

  if (classified) {
    const { action_type, params, confidence } = classified;

    if (action_type === "run_shell" && confidence >= CONFIDENCE.run_shell) {
      const command = params?.command ?? text;
      await handleRun(
        sender,
        command,
        workspaceId,
        text,
        sessionId,
        contextSummary,
        objectiveId,
        objectiveGoal,
        trace,
      );
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
        objectiveId,
        objectiveGoal,
        trace,
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
        objectiveId,
        objectiveGoal,
        trace,
      );
      return;
    }

    // web_search: strict gating — only proceed if user explicitly asked to search
    if (action_type === "web_search" && SEARCH_EXPLICIT_RE.test(text)) {
      const query = params?.q ?? text;
      await handleWebSearch(
        sender,
        query,
        workspaceId,
        text,
        sessionId,
        contextSummary,
        objectiveId,
        objectiveGoal,
        trace,
      );
      return;
    }

    if (action_type === "send_email" && confidence >= CONFIDENCE.send_email) {
      await handleSendEmail(
        sender,
        params,
        workspaceId,
        text,
        sessionId,
        contextSummary,
        objectiveId,
        objectiveGoal,
        trace,
      );
      return;
    }

    // No specific tool intent — route to chat LLM (default conversational path)
    if (trace) {
      trace.router_decision = "chat_llm";
      trace.fallback_used = false;
    }
    await handleChatLLM(sender, text, workspaceId, sessionId, contextSummary, objectiveId, trace);
    return;
  }

  // classify_intent returned no result (empty exec) — treat as conversational
  if (trace) {
    trace.router_decision = "chat_llm";
    trace.fallback_used = false;
  }
  await handleChatLLM(sender, text, workspaceId, sessionId, contextSummary, objectiveId, trace);
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
  // Wrapped in a one-shot retry: if any kernel call returns workspace_not_found
  // the stale workspace is cleared and the whole routing block runs again with
  // a fresh workspace.  This makes kernel DB resets transparent to the user.
  const isStaleWorkspace = (err) =>
    err?.message?.includes("workspace_not_found") ||
    err?.message?.includes("agent_not_found") ||
    err?.message?.includes("agent_workspace_mismatch");

  // Per-request debug trace — populated as routing proceeds, emitted at end.
  const trace = {
    msg_id: newMsgId(),
    workspace_id: null,
    remoteJid: sender,
    session_id: null,
    objective_id: null,
    intent: null, // classify_intent result (before routing decision)
    intent_confidence: null, // classify_intent confidence score
    router_decision: null,
    reason: null,
    provider: null,
    provider_found: null, // true = provider had a key and replied; false = failed or missing
    policy_blocked: false,
    provider_attempts: [],
    model: null,
    tools: null,
    fallback_used: false,
    agent_id: sender,
  };

  const runRouting = async () => {
    const wsId = await ensureWorkspace(sender);
    trace.workspace_id = wsId;

    // ── Resolve (or create) session for this sender ─────────────────────────
    let sessionId = null;
    let contextSummary = "";
    try {
      const sessionRes = await kernelResolveSession(wsId, "whatsapp", sender, text);
      sessionId = sessionRes.session_id ?? null;
      contextSummary = sessionRes.session?.context_summary ?? "";
      trace.session_id = sessionId;
      app.log.info(
        { sender, session_id: sessionId, decision: sessionRes.decision, reason: sessionRes.reason },
        "session resolved",
      );
      if (sessionRes.decision === "new" && sessionRes.reason === "explicit_reset") {
        clearSenderPending(sender);
        await sendWhatsApp(sender, "Starting fresh. How can I help you?");
        return;
      }
    } catch (err) {
      if (isStaleWorkspace(err)) {
        throw err;
      } // bubble up for retry
      app.log.warn({ err, sender }, "kernelResolveSession failed — continuing without session");
    }

    // ── Resolve (or continue) cognitive objective ──────────────────────────
    let objectiveId = null;
    let objectiveGoal = "";
    if (sessionId) {
      try {
        const objRes = await kernelResolveObjective(wsId, sender, sessionId, text);
        if (objRes.ok) {
          objectiveId = objRes.objective_id ?? null;
          objectiveGoal = objRes.goal ?? "";
          trace.objective_id = objectiveId;
          app.log.info(
            {
              sender,
              session_id: sessionId,
              objective_id: objectiveId,
              obj_decision: objRes.decision,
              obj_reason: objRes.reason,
            },
            "objective resolved",
          );
        }
      } catch (err) {
        if (isStaleWorkspace(err)) {
          throw err;
        }
        app.log.warn(
          { err, sender },
          "kernelResolveObjective failed — continuing without objective",
        );
      }
    }

    await routeMessage(
      sender,
      text,
      wsId,
      sessionId,
      contextSummary,
      objectiveId,
      objectiveGoal,
      trace,
    );
  };

  try {
    await runRouting();
  } catch (err) {
    if (isStaleWorkspace(err)) {
      app.log.warn(
        { sender, err: err.message },
        "stale workspace mid-routing — resetting and retrying",
      );
      try {
        await resetAndEnsureAgent(sender);
        await runRouting();
      } catch (retryErr) {
        app.log.error({ retryErr, sender }, "routing retry failed");
        await sendWhatsApp(sender, `Bridge error: ${retryErr.message}`).catch(() => {});
        return reply.code(500).send({ error: "route_failed" });
      }
    } else {
      app.log.error({ err, sender }, "routeMessage failed");
      await sendWhatsApp(sender, `Bridge error: ${err.message}`).catch(() => {});
      return reply.code(500).send({ error: "route_failed" });
    }
  }

  // ── Structured trace log — emitted for EVERY inbound message (not DEBUG-only)
  // One line per message; all routing decisions, provider info, session IDs.
  app.log.info(
    {
      msg_id: trace.msg_id,
      workspace_id: trace.workspace_id,
      remoteJid: trace.remoteJid,
      session_id: trace.session_id,
      objective_id: trace.objective_id,
      intent: trace.intent,
      intent_confidence: trace.intent_confidence,
      router_decision: trace.router_decision,
      provider: trace.provider,
      provider_found: trace.provider_found,
      policy_blocked: trace.policy_blocked ?? false,
      fallback_used: trace.fallback_used,
      provider_attempts: trace.provider_attempts ?? [],
      model: trace.model,
      tools_planned: trace.tools_planned ?? trace.router_decision,
    },
    "msg_trace",
  );

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
