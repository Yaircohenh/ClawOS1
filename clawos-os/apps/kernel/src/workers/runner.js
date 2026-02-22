/**
 * Worker Runner — Subagent Execution Engine
 *
 * Maps worker_type → handler that calls the real kernel action via dispatch.
 * Workers run inside the kernel trust boundary; the DCT authorization has
 * already been verified at the API boundary, so dispatch is called with
 * scopes: ["operator.approvals"] to skip the second approval gate.
 *
 * Execution contract:
 *   1. Emit "worker.started"
 *   2. Run handler (may throw)
 *   3. Create artifact with output
 *   4. Emit "worker.completed" (or "worker.failed")
 *   5. Return { result, artifact_id }
 */
import crypto from "node:crypto";
import { dispatch }        from "../orchestrator/index.js";
import { createArtifact }  from "../artifacts/service.js";
import { emitEvent }       from "../events/service.js";

function reqId() {
  return `ar_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Dispatch a kernel action from inside a worker.
 * Uses operator.approvals scope since the DCT authorization is already verified.
 */
async function workerDispatch(db, subagent, action_type, payload) {
  const result = await dispatch({
    request_id:   reqId(),
    workspace_id: subagent.workspace_id,
    agent_id:     subagent.subagent_id,   // subagent is the actor
    action_type,
    payload,
    scopes:       ["operator.approvals"], // DCT already authorized at API boundary
  }, { db });

  if (!result.ok) {
    throw new Error(result.error ?? `${action_type} dispatch failed`);
  }
  return result.result;
}

// ── Worker handler registry ────────────────────────────────────────────────────
const HANDLERS = {

  /** Generic / default — echoes input, no side effects */
  default: async ({ subagent, input }) => ({
    output:     `Worker "${subagent.worker_type}" processed task step`,
    summary:    `Handled ${Object.keys(input ?? {}).length} input key(s)`,
    input_echo: input,
  }),

  /** Web researcher — calls web_search action */
  web_researcher: async ({ subagent, input, db }) => {
    const q = input?.query ?? input?.q ?? "";
    return workerDispatch(db, subagent, "web_search", { q });
  },

  /** File reader — calls read_file action */
  file_reader: async ({ subagent, input, db }) => {
    return workerDispatch(db, subagent, "read_file", { path: input?.path ?? "" });
  },

  /** File writer — calls write_file action */
  file_writer: async ({ subagent, input, db }) => {
    return workerDispatch(db, subagent, "write_file", {
      path:    input?.path    ?? "",
      content: input?.content ?? "",
    });
  },

  /** Shell executor — calls run_shell action (HIGH risk, requires DCT with run_shell scope) */
  shell_executor: async ({ subagent, input, db }) => {
    return workerDispatch(db, subagent, "run_shell", { command: input?.command ?? "" });
  },

  /** Document processor — calls summarize_document when text is available */
  doc_processor: async ({ subagent, input, db }) => {
    const text = input?.text ?? "";
    if (!text) {
      // No text content provided — return metadata placeholder
      return {
        output:     `Document registered: ${input?.filename ?? "document"}`,
        filename:   input?.filename   ?? "document",
        page_count: input?.page_count ?? 0,
        note:       "Provide input.text to enable full summarization via summarize_document",
      };
    }
    return workerDispatch(db, subagent, "summarize_document", {
      text,
      page_count: input?.page_count ?? 0,
      filename:   input?.filename   ?? "document",
    });
  },

  /** Data extractor — placeholder (no real action yet) */
  data_extractor: async ({ input }) => ({
    output:      "Extraction completed",
    schema_used: input?.schema ?? "auto",
    fields:      { extracted_at: new Date().toISOString(), record_count: 0 },
  }),

};

// ── Runner ────────────────────────────────────────────────────────────────────
export async function runWorker(db, { subagent, token, input }) {
  const handler = HANDLERS[subagent.worker_type] ?? HANDLERS.default;

  // Emit worker.started
  emitEvent(db, {
    workspace_id: subagent.workspace_id,
    task_id:      subagent.task_id,
    actor_kind:   "subagent",
    actor_id:     subagent.subagent_id,
    type:         "worker.started",
    data: {
      worker_type:   subagent.worker_type,
      token_id:      token.token_id,
      allowed_tools: token.scope?.allowed_tools ?? [],
      input_keys:    Object.keys(input ?? {}),
    },
  });

  let result;
  try {
    result = await handler({ subagent, token, input: input ?? {}, db });
  } catch (err) {
    emitEvent(db, {
      workspace_id: subagent.workspace_id,
      task_id:      subagent.task_id,
      actor_kind:   "subagent",
      actor_id:     subagent.subagent_id,
      type:         "worker.failed",
      data:         { error: err.message },
    });
    throw err;
  }

  // Create artifact for the task
  const artifact = createArtifact(db, {
    task_id:      subagent.task_id,
    workspace_id: subagent.workspace_id,
    actor_kind:   "subagent",
    actor_id:     subagent.subagent_id,
    type:         "worker_output",
    content:      JSON.stringify(result),
    metadata: {
      worker_type: subagent.worker_type,
      step_id:     subagent.step_id ?? null,
    },
  });

  // Emit worker.completed
  emitEvent(db, {
    workspace_id: subagent.workspace_id,
    task_id:      subagent.task_id,
    actor_kind:   "subagent",
    actor_id:     subagent.subagent_id,
    type:         "worker.completed",
    data:         { artifact_id: artifact.artifact_id, worker_type: subagent.worker_type },
  });

  return { result, artifact_id: artifact.artifact_id };
}
