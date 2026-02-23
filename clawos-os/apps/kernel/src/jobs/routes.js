/**
 * Job REST routes.
 *
 * POST /kernel/jobs                 — create a queued job
 * GET  /kernel/jobs/:job_id         — get job status + result
 * PATCH /kernel/jobs/:job_id        — update progress / result / status (bridge callbacks)
 * GET  /kernel/jobs?workspace_id=&remote_jid=  — list jobs for a sender
 */
import { createJob, getJob, updateJob, listJobs } from "./service.js";

export function registerJobRoutes(app, db) {

  // ── POST /kernel/jobs ──────────────────────────────────────────────────────
  app.post("/kernel/jobs", async (req, reply) => {
    const { workspace_id, remote_jid, objective, plan } = req.body ?? {};
    if (!workspace_id || !remote_jid || !objective) {
      return reply.code(400).send({ error: "workspace_id, remote_jid, objective required" });
    }
    const job = createJob(db, { workspace_id, remote_jid, objective, plan_json: plan ?? [] });
    return { ok: true, ...job };
  });

  // ── GET /kernel/jobs/:job_id ───────────────────────────────────────────────
  app.get("/kernel/jobs/:job_id", async (req, reply) => {
    const { workspace_id } = req.query ?? {};
    const job = getJob(db, req.params.job_id);
    if (!job) {return reply.code(404).send({ error: "job_not_found" });}
    if (workspace_id && job.workspace_id !== workspace_id) {
      return reply.code(403).send({ error: "workspace_mismatch" });
    }
    return { ok: true, job };
  });

  // ── PATCH /kernel/jobs/:job_id ─────────────────────────────────────────────
  app.patch("/kernel/jobs/:job_id", async (req, reply) => {
    const { status, progress, result, error, workspace_id } = req.body ?? {};
    const job = getJob(db, req.params.job_id);
    if (!job) {return reply.code(404).send({ error: "job_not_found" });}
    if (workspace_id && job.workspace_id !== workspace_id) {
      return reply.code(403).send({ error: "workspace_mismatch" });
    }
    updateJob(db, req.params.job_id, { status, progress, result, error });
    return { ok: true };
  });

  // ── GET /kernel/jobs ───────────────────────────────────────────────────────
  app.get("/kernel/jobs", async (req, reply) => {
    const { workspace_id, remote_jid, limit } = req.query ?? {};
    if (!workspace_id || !remote_jid) {
      return reply.code(400).send({ error: "workspace_id and remote_jid required" });
    }
    const jobs = listJobs(db, workspace_id, remote_jid, { limit: Number(limit ?? 20) });
    return { ok: true, jobs };
  });
}
