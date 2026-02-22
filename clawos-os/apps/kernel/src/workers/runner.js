/**
 * Worker Runner — Placeholder Subagent Execution Engine
 *
 * Each worker_type maps to a handler function.
 * In V2 these will dispatch to real processes, MCP tools, or external APIs.
 * For V1 they are well-structured placeholders that demonstrate the contract.
 *
 * Execution contract:
 *   1. Emit "worker.started"
 *   2. Run handler (may throw)
 *   3. Create artifact with output
 *   4. Emit "worker.completed" (or "worker.failed")
 *   5. Return { result, artifact_id }
 */
import { createArtifact } from "../artifacts/service.js";
import { emitEvent }      from "../events/service.js";

// ── Worker handler registry ────────────────────────────────────────────────────
const HANDLERS = {

  /** Generic / default — accepts any input, echoes a summary */
  default: async ({ subagent, input }) => ({
    output:  `Worker "${subagent.worker_type}" processed task step`,
    summary: `Handled ${Object.keys(input ?? {}).length} input key(s)`,
    input_echo: input,
  }),

  /** Research worker — would call web_search in production */
  web_researcher: async ({ input }) => ({
    output:  `Research completed for: ${input?.query ?? "(no query)"}`,
    sources: [],
    summary: `Found 0 sources (placeholder — wire to web_search in V2)`,
  }),

  /** Document processor — would parse/summarize in production */
  doc_processor: async ({ input }) => ({
    output:  `Document processed: ${input?.filename ?? "unknown"}`,
    page_count: input?.page_count ?? 0,
    summary: "Document analysis placeholder — wire to summarize_document in V2",
  }),

  /** Data extractor — would parse structured data in production */
  data_extractor: async ({ input }) => ({
    output:      `Extraction completed`,
    schema_used: input?.schema ?? "auto",
    fields:      { extracted_at: new Date().toISOString(), record_count: 0 },
  }),

  /** Shell executor — would call run_shell action in production */
  shell_executor: async ({ input }) => ({
    output:   `Shell execution placeholder`,
    command:  input?.command ?? "(none)",
    note:     "Wire to run_shell kernel action in V2 (requires HIGH-risk approval)",
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
      worker_type:     subagent.worker_type,
      token_id:        token.token_id,
      allowed_tools:   token.scope?.allowed_tools ?? [],
      input_keys:      Object.keys(input ?? {}),
    },
  });

  let result;
  try {
    result = await handler({ subagent, token, input: input ?? {} });
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
