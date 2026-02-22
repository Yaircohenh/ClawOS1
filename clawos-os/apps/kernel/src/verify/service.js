/**
 * Verify Service — Verifiable Completion
 *
 * Runs acceptance checks defined in the task contract.
 * Only an AGENT may trigger verification.
 *
 * Supported check types:
 *   artifact_required   — at least one artifact of the given type must exist
 *   min_artifacts       — task must have >= N total artifacts
 *   subagents_finished  — all spawned subagents must be in 'finished' status
 *   no_failed_subagents — no subagent in 'failed' status
 *
 * Emits: "verify.passed" or "verify.failed" event.
 */
import { getArtifacts }      from "../artifacts/service.js";
import { getSubagentsByTask } from "../subagents/service.js";
import { emitEvent }          from "../events/service.js";

export async function verifyTask(db, task, requested_by_agent_id) {
  const contract = task.contract ?? {};
  const checks   = contract.acceptance_checks ?? [];
  const failures = [];

  const artifacts = getArtifacts(db, task.task_id, task.workspace_id);
  const subagents = getSubagentsByTask(db, task.task_id, task.workspace_id);

  for (const check of checks) {
    switch (check.type) {

      case "artifact_required": {
        const found = artifacts.some((a) => a.type === check.artifact_type);
        if (!found) {
          failures.push({
            check,
            reason: `Required artifact type "${check.artifact_type}" not found`,
          });
        }
        break;
      }

      case "min_artifacts": {
        const min = check.count ?? 1;
        if (artifacts.length < min) {
          failures.push({
            check,
            reason: `Need at least ${min} artifact(s), found ${artifacts.length}`,
          });
        }
        break;
      }

      case "subagents_finished": {
        const unfinished = subagents.filter((sa) => sa.status !== "finished");
        if (unfinished.length > 0) {
          failures.push({
            check,
            reason: `${unfinished.length} subagent(s) not finished: ${unfinished.map((sa) => sa.subagent_id).join(", ")}`,
          });
        }
        break;
      }

      case "no_failed_subagents": {
        const failed = subagents.filter((sa) => sa.status === "failed");
        if (failed.length > 0) {
          failures.push({
            check,
            reason: `${failed.length} subagent(s) failed: ${failed.map((sa) => sa.subagent_id).join(", ")}`,
          });
        }
        break;
      }

      default:
        // Unknown check type — skip with warning
        failures.push({ check, reason: `Unknown check type: ${check.type}` });
    }
  }

  const passed = failures.length === 0;

  emitEvent(db, {
    workspace_id: task.workspace_id,
    task_id:      task.task_id,
    actor_kind:   "agent",
    actor_id:     requested_by_agent_id,
    type:         passed ? "verify.passed" : "verify.failed",
    data:         { checks_run: checks.length, failures },
  });

  return {
    passed,
    checks_run: checks.length,
    artifacts_found: artifacts.length,
    subagents_total: subagents.length,
    failures,
  };
}
