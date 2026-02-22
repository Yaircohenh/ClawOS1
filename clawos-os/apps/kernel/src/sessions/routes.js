/**
 * Session HTTP routes — registered by apps/kernel/src/index.js.
 *
 * POST /kernel/sessions/resolve          — find or create a session for an inbound message
 * GET  /kernel/sessions/:session_id      — fetch a session by ID
 * PATCH /kernel/sessions/:session_id     — advance context (called after each turn)
 * POST /kernel/sessions/:session_id/close — forcefully close a session
 */
import { resolveSession }                               from "./resolver.js";
import { getSession, closeSession, updateContextSummary, listSessions } from "./service.js";
import { updateSummary }                                from "./summarizer.js";
import { z }                                            from "zod";

function nowIso() { return new Date().toISOString(); }

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('better-sqlite3').Database} db
 */
export function registerSessionRoutes(app, db) {

  // ── POST /kernel/sessions/resolve ─────────────────────────────────────────
  // Bridge calls this on every inbound message to get/create a session.
  // Returns { ok, session_id, decision, reason, session }
  app.post("/kernel/sessions/resolve", async (req, reply) => {
    const Schema = z.object({
      workspace_id: z.string().min(1),
      channel:      z.string().min(1).default("whatsapp"),
      remote_jid:   z.string().min(1),
      user_message: z.string().optional().default(""),
    });

    let body;
    try { body = Schema.parse(req.body ?? {}); }
    catch (e) { reply.code(400); return { ok: false, error: e.message }; }

    // Workspace must exist
    const wsRow = db.prepare(`SELECT workspace_id FROM workspaces WHERE workspace_id=?`).get(body.workspace_id);
    if (!wsRow) { reply.code(404); return { ok: false, error: "workspace_not_found" }; }

    try {
      const resultP = resolveSession(db, {
        workspace_id: body.workspace_id,
        channel:      body.channel,
        remote_jid:   body.remote_jid,
        user_message: body.user_message,
      });
      const result = await Promise.resolve(resultP);
      return { ok: true, ...result };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: e.message };
    }
  });

  // ── GET /kernel/sessions/:session_id ──────────────────────────────────────
  app.get("/kernel/sessions/:session_id", async (req, reply) => {
    const session = getSession(db, req.params.session_id);
    if (!session) { reply.code(404); return { ok: false, error: "session_not_found" }; }
    return { ok: true, session };
  });

  // ── PATCH /kernel/sessions/:session_id ────────────────────────────────────
  // Bridge calls this after each successful assistant response to advance
  // the turn count, last_message_at, and context_summary.
  app.patch("/kernel/sessions/:session_id", async (req, reply) => {
    const Schema = z.object({
      workspace_id:       z.string(),
      user_message:       z.string().optional().default(""),
      assistant_response: z.string().optional().default(""),
      action_type:        z.string().optional().default(""),
    });

    let body;
    try { body = Schema.parse(req.body ?? {}); }
    catch (e) { reply.code(400); return { ok: false, error: e.message }; }

    const session = getSession(db, req.params.session_id);
    if (!session) { reply.code(404); return { ok: false, error: "session_not_found" }; }
    if (session.workspace_id !== body.workspace_id) {
      reply.code(403); return { ok: false, error: "workspace_mismatch" };
    }

    // Update turn bookkeeping
    db.prepare(`
      UPDATE sessions
      SET last_message_at=?, turn_count=turn_count+1
      WHERE session_id=?
    `).run(nowIso(), session.session_id);

    // Update context summary (async, non-fatal)
    try {
      const newSummary = await updateSummary(db, {
        existing_summary:   session.context_summary,
        user_message:       body.user_message,
        assistant_response: body.assistant_response,
        action_type:        body.action_type,
      });
      updateContextSummary(db, session.session_id, newSummary);
    } catch { /* non-fatal — keep old summary */ }

    const updated = getSession(db, session.session_id);
    return { ok: true, session_id: session.session_id, context_summary: updated?.context_summary ?? "" };
  });

  // ── POST /kernel/sessions/:session_id/close ───────────────────────────────
  app.post("/kernel/sessions/:session_id/close", async (req, reply) => {
    const session = getSession(db, req.params.session_id);
    if (!session) { reply.code(404); return { ok: false, error: "session_not_found" }; }

    closeSession(db, session.session_id);
    return { ok: true, session_id: session.session_id };
  });

  // ── GET /kernel/sessions (list for workspace) ─────────────────────────────
  app.get("/kernel/sessions", async (req, reply) => {
    const Schema = z.object({
      workspace_id: z.string(),
      limit:        z.coerce.number().int().min(1).max(200).optional().default(50),
    });

    let query;
    try { query = Schema.parse(req.query ?? {}); }
    catch (e) { reply.code(400); return { ok: false, error: e.message }; }

    const sessions = listSessions(db, query.workspace_id, query.limit);
    return { ok: true, sessions };
  });
}
