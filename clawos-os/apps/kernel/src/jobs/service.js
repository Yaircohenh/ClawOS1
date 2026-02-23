/**
 * Jobs service — CRUD for background long-running tasks.
 *
 * A job represents a long-running user request (e.g. "search 10 homes in Austin")
 * that should NOT block the main WhatsApp reply.  The bridge spawns a job,
 * immediately replies with a job_id, and later posts progress + result back.
 */
import crypto from "node:crypto";

function jobId() {
  return `job_${crypto.randomBytes(10).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

/**
 * Create a new queued job.
 *
 * @param {object} db
 * @param {{ workspace_id, remote_jid, objective, plan_json? }} opts
 * @returns {{ job_id, status, created_at }}
 */
export function createJob(db, { workspace_id, remote_jid, objective, plan_json = [] }) {
  const job_id    = jobId();
  const ts        = now();
  const planStr   = JSON.stringify(plan_json);

  db.prepare(`
    INSERT INTO jobs (job_id, workspace_id, remote_jid, objective, status,
                      progress, result, error, plan_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', '', '', '', ?, ?, ?)
  `).run(job_id, workspace_id, remote_jid, objective, planStr, ts, ts);

  return { job_id, status: "queued", created_at: ts };
}

/**
 * Get a job by ID.
 */
export function getJob(db, job_id) {
  const row = db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(job_id);
  if (!row) {return null;}
  return { ...row, plan: JSON.parse(row.plan_json ?? "[]") };
}

/**
 * Update a job's status and optional progress/result/error.
 */
export function updateJob(db, job_id, { status, progress, result, error } = {}) {
  const fields  = [];
  const values  = [];

  if (status   !== undefined) { fields.push("status = ?");   values.push(status); }
  if (progress !== undefined) { fields.push("progress = ?"); values.push(String(progress)); }
  if (result   !== undefined) { fields.push("result = ?");   values.push(String(result)); }
  if (error    !== undefined) { fields.push("error = ?");    values.push(String(error)); }

  if (fields.length === 0) {return;}

  fields.push("updated_at = ?");
  values.push(now());
  values.push(job_id);

  db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE job_id = ?`).run(...values);
}

/**
 * List recent jobs for a workspace/jid.
 */
export function listJobs(db, workspace_id, remote_jid, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT * FROM jobs
    WHERE workspace_id = ? AND remote_jid = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(workspace_id, remote_jid, limit).map(row => ({
    ...row,
    plan: JSON.parse(row.plan_json ?? "[]"),
  }));
}
