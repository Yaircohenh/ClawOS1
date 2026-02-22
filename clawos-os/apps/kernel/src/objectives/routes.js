/**
 * Objectives HTTP routes
 *
 * POST /kernel/objectives/resolve        — resolve or create an objective for a message
 * GET  /kernel/objectives/:id            — fetch objective by ID
 * PATCH /kernel/objectives/:id           — update status / result
 * POST /kernel/objectives/:id/evidence   — record tool evidence
 * GET  /kernel/objectives/:id/evidence   — list tool evidence
 * GET  /kernel/objectives?session_id=    — list objectives for session
 */
import { z } from "zod";
import {
  createObjective,
  getObjective,
  getActiveObjective,
  updateObjectiveStatus,
  updateObjectiveDeliverable,
  listObjectives,
  addToolEvidence,
  getToolEvidence,
  addSessionTurn,
  getRecentTurns,
} from "./service.js";
import { resolveFollowupHeuristic, extractObjective, resolveFollowup } from "../orchestrator/actions/cognitive_execute.js";

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('better-sqlite3').Database} db
 */
export function registerObjectiveRoutes(app, db) {

  // ── POST /kernel/objectives/resolve ─────────────────────────────────────────
  // Main entry point: given a session + user message, determine whether to
  // continue the active objective or create a new one.
  app.post("/kernel/objectives/resolve", async (req, reply) => {
    const Schema = z.object({
      workspace_id:     z.string().min(1),
      session_id:       z.string().min(1),
      agent_id:         z.string().min(1),
      user_message:     z.string().min(1),
      context_summary:  z.string().optional().default(""),
    });
    let body;
    try { body = Schema.parse(req.body ?? {}); }
    catch (e) { reply.code(400); return { ok: false, error: e.message }; }

    // Workspace guard
    const wsRow = db.prepare(`SELECT workspace_id FROM workspaces WHERE workspace_id=?`).get(body.workspace_id);
    if (!wsRow) { reply.code(404); return { ok: false, error: "workspace_not_found" }; }

    try {
      const active = getActiveObjective(db, body.session_id);

      // 1. Decide: continue or new?
      let decision, confidence, reason;
      const heuristic = resolveFollowupHeuristic(body.user_message, active);
      if (heuristic && heuristic.confidence >= 0.85) {
        ({ decision, confidence, reason } = heuristic);
      } else {
        // Fall back to LLM for ambiguous cases
        const llmResult = await resolveFollowup(db, { text: body.user_message, active_objective: active });
        ({ decision, confidence, reason } = llmResult);
      }

      let objective;
      if (decision === "continue" && active) {
        objective = active;
        app.log.info(
          { session_id: body.session_id, objective_id: active.objective_id, decision, reason, confidence },
          "objective: continue",
        );
      } else {
        // 2. Extract objective from user message
        const extracted = await extractObjective(db, { text: body.user_message });
        objective = createObjective(db, {
          session_id:           body.session_id,
          workspace_id:         body.workspace_id,
          agent_id:             body.agent_id,
          title:                extracted.title,
          goal:                 extracted.goal,
          constraints:          extracted.constraints,
          required_deliverable: extracted.required_deliverable,
        });
        app.log.info(
          { session_id: body.session_id, objective_id: objective.objective_id, decision: "new", reason },
          "objective: new",
        );
      }

      return {
        ok: true,
        decision: decision === "continue" && active ? "continue" : "new",
        reason,
        confidence,
        objective_id:          objective.objective_id,
        goal:                  objective.goal,
        required_deliverable:  objective.required_deliverable,
        title:                 objective.title,
      };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: e.message };
    }
  });

  // ── GET /kernel/objectives/:id ───────────────────────────────────────────────
  app.get("/kernel/objectives/:id", async (req, reply) => {
    const obj = getObjective(db, req.params.id);
    if (!obj) { reply.code(404); return { ok: false, error: "objective_not_found" }; }
    return { ok: true, objective: obj };
  });

  // ── PATCH /kernel/objectives/:id ─────────────────────────────────────────────
  app.patch("/kernel/objectives/:id", async (req, reply) => {
    const Schema = z.object({
      status:         z.enum(["in_progress", "completed", "failed"]).optional(),
      result_summary: z.string().optional().default(""),
      required_deliverable: z.any().optional(),
    });
    let body;
    try { body = Schema.parse(req.body ?? {}); }
    catch (e) { reply.code(400); return { ok: false, error: e.message }; }

    const obj = getObjective(db, req.params.id);
    if (!obj) { reply.code(404); return { ok: false, error: "objective_not_found" }; }

    if (body.status) {
      updateObjectiveStatus(db, req.params.id, body.status, body.result_summary);
    }
    if (body.required_deliverable !== undefined) {
      updateObjectiveDeliverable(db, req.params.id, body.required_deliverable);
    }

    return { ok: true, objective_id: req.params.id };
  });

  // ── POST /kernel/objectives/:id/evidence ─────────────────────────────────────
  app.post("/kernel/objectives/:id/evidence", async (req, reply) => {
    const Schema = z.object({
      session_id:     z.string().min(1),
      action_type:    z.string().min(1),
      query_text:     z.string().optional().default(""),
      result_summary: z.string().optional().default(""),
    });
    let body;
    try { body = Schema.parse(req.body ?? {}); }
    catch (e) { reply.code(400); return { ok: false, error: e.message }; }

    const obj = getObjective(db, req.params.id);
    if (!obj) { reply.code(404); return { ok: false, error: "objective_not_found" }; }

    const evidence_id = addToolEvidence(db, {
      objective_id:   req.params.id,
      session_id:     body.session_id,
      action_type:    body.action_type,
      query_text:     body.query_text,
      result_summary: body.result_summary,
    });
    return { ok: true, evidence_id };
  });

  // ── GET /kernel/objectives/:id/evidence ──────────────────────────────────────
  app.get("/kernel/objectives/:id/evidence", async (req, reply) => {
    const obj = getObjective(db, req.params.id);
    if (!obj) { reply.code(404); return { ok: false, error: "objective_not_found" }; }
    const evidence = getToolEvidence(db, req.params.id);
    return { ok: true, evidence };
  });

  // ── GET /kernel/objectives (list for session) ─────────────────────────────────
  app.get("/kernel/objectives", async (req, reply) => {
    const Schema = z.object({ session_id: z.string().min(1) });
    let query;
    try { query = Schema.parse(req.query ?? {}); }
    catch (e) { reply.code(400); return { ok: false, error: e.message }; }
    const objectives = listObjectives(db, query.session_id);
    return { ok: true, objectives };
  });

  // ── POST /kernel/objectives/:id/turns ────────────────────────────────────────
  app.post("/kernel/objectives/:id/turns", async (req, reply) => {
    const Schema = z.object({
      session_id:         z.string().min(1),
      user_message:       z.string().optional().default(""),
      assistant_response: z.string().optional().default(""),
      action_type:        z.string().optional().default(""),
    });
    let body;
    try { body = Schema.parse(req.body ?? {}); }
    catch (e) { reply.code(400); return { ok: false, error: e.message }; }

    const turn_id = addSessionTurn(db, {
      session_id:         body.session_id,
      user_message:       body.user_message,
      assistant_response: body.assistant_response,
      action_type:        body.action_type,
      objective_id:       req.params.id,
    });
    return { ok: true, turn_id };
  });

  // ── GET /kernel/sessions/:id/turns ───────────────────────────────────────────
  app.get("/kernel/sessions/:session_id/turns", async (req, _reply) => {
    const limit = Math.min(Number(req.query?.limit ?? 3), 10);
    const turns = getRecentTurns(db, req.params.session_id, limit);
    return { ok: true, turns };
  });
}
