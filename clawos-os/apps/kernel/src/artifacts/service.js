/**
 * Artifact Service
 *
 * Artifacts are the verifiable outputs of task work — created by agents or subagents.
 * They are the primary evidence used by acceptance checks in verify/service.js.
 * Raw secrets must NEVER appear in artifact content.
 */
import crypto from "node:crypto";

function artifactId() {
  return `art_${crypto.randomBytes(12).toString("hex")}`;
}

export function createArtifact(db, {
  task_id,
  workspace_id,
  actor_kind,    // "agent" | "subagent" | "system"
  actor_id,
  type,          // e.g. "worker_output", "text", "file", "json"
  content = null,
  uri = null,
  metadata = {},
}) {
  const artifact_id = artifactId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO artifacts (
      artifact_id, task_id, workspace_id, actor_kind, actor_id,
      type, content, uri, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact_id, task_id, workspace_id, actor_kind, actor_id,
    type, content, uri, JSON.stringify(metadata), now,
  );

  return { artifact_id, task_id, workspace_id, type, created_at: now };
}

export function getArtifacts(db, task_id, workspace_id) {
  return db.prepare(`
    SELECT * FROM artifacts
    WHERE task_id = ? AND workspace_id = ?
    ORDER BY created_at ASC
  `).all(task_id, workspace_id).map((r) => ({
    ...r,
    metadata: JSON.parse(r.metadata_json ?? "{}"),
  }));
}
