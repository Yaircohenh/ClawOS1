/**
 * ClaWHub Skills Marketplace — Fastify route handlers.
 * Registered by apps/kernel/src/index.js via registerClawhubRoutes(app, db).
 */

import { searchSkills, exploreSkills, getSkill as hubGetSkill } from "./service.js";
import { vetSkillMd } from "./vetting.js";
import { buildSkill } from "./builder.js";
import { getKeyLinks } from "./api_keys.js";

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('better-sqlite3').Database} db
 */
export function registerClawhubRoutes(app, db) {

  // ── GET /kernel/clawhub/explore?sort=trending&limit=24 ─────────────────────
  app.get("/kernel/clawhub/explore", async (req, reply) => {
    const sort  = req.query.sort  || "trending";
    const limit = Math.min(Number(req.query.limit) || 24, 100);
    try {
      const data = await exploreSkills(sort, limit);
      return { ok: true, ...data };
    } catch (e) {
      reply.code(502);
      return { ok: false, error: "clawhub_unavailable", message: e.message };
    }
  });

  // ── GET /kernel/clawhub/search?q=...&limit=20 ──────────────────────────────
  app.get("/kernel/clawhub/search", async (req, reply) => {
    const q     = (req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    if (!q) { reply.code(400); return { ok: false, error: "q_required" }; }
    try {
      const data = await searchSkills(q, limit);
      return { ok: true, ...data };
    } catch (e) {
      reply.code(502);
      return { ok: false, error: "clawhub_unavailable", message: e.message };
    }
  });

  // ── GET /kernel/clawhub/skill/:slug ────────────────────────────────────────
  app.get("/kernel/clawhub/skill/:slug", async (req, reply) => {
    try {
      const skill   = await hubGetSkill(req.params.slug);
      const skillMd = skill.skill_md || "";
      const vetting     = vetSkillMd(skillMd, skill.moderation ?? {});
      const requiredKeys = getKeyLinks(skillMd);
      return { ok: true, skill, vetting, requiredKeys };
    } catch (e) {
      reply.code(502);
      return { ok: false, error: "clawhub_unavailable", message: e.message };
    }
  });

  // ── POST /kernel/clawhub/install ───────────────────────────────────────────
  app.post("/kernel/clawhub/install", async (req, reply) => {
    const { slug, acceptDisclaimer } = req.body ?? {};
    if (!slug)             { reply.code(400); return { ok: false, error: "slug_required" }; }
    if (!acceptDisclaimer) { reply.code(400); return { ok: false, error: "must_accept_disclaimer" }; }

    try {
      const skill   = await hubGetSkill(slug);
      const skillMd = skill.skill_md || "";
      const vetting = vetSkillMd(skillMd, skill.moderation ?? {});

      if (!vetting.safe) {
        reply.code(422);
        return { ok: false, error: "vetting_failed", issues: vetting.issues };
      }

      db.prepare(`
        INSERT INTO installed_skills (slug, display_name, version, installed_at, skill_md, vetting_json, enabled, source)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'clawhub')
        ON CONFLICT(slug) DO UPDATE SET
          display_name = excluded.display_name,
          version      = excluded.version,
          installed_at = excluded.installed_at,
          skill_md     = excluded.skill_md,
          vetting_json = excluded.vetting_json,
          enabled      = 1,
          source       = 'clawhub'
      `).run(
        slug,
        skill.display_name || skill.name || slug,
        skill.version || "1.0.0",
        nowIso(),
        skillMd,
        JSON.stringify(vetting),
      );

      return { ok: true, slug };
    } catch (e) {
      reply.code(502);
      return { ok: false, error: "install_failed", message: e.message };
    }
  });

  // ── DELETE /kernel/clawhub/install/:slug ───────────────────────────────────
  app.delete("/kernel/clawhub/install/:slug", async (req, reply) => {
    const { changes } = db.prepare(`DELETE FROM installed_skills WHERE slug=?`).run(req.params.slug);
    if (changes === 0) { reply.code(404); return { ok: false, error: "not_found" }; }
    return { ok: true, slug: req.params.slug };
  });

  // ── GET /kernel/clawhub/installed ──────────────────────────────────────────
  app.get("/kernel/clawhub/installed", async () => {
    const rows = db.prepare(`
      SELECT slug, display_name, version, installed_at, enabled, source, build_prompt
      FROM installed_skills ORDER BY installed_at DESC
    `).all();
    return { ok: true, skills: rows };
  });

  // ── PATCH /kernel/clawhub/installed/:slug { enabled: bool } ────────────────
  app.patch("/kernel/clawhub/installed/:slug", async (req, reply) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      reply.code(400);
      return { ok: false, error: "enabled_boolean_required" };
    }
    const { changes } = db.prepare(`UPDATE installed_skills SET enabled=? WHERE slug=?`)
      .run(enabled ? 1 : 0, req.params.slug);
    if (changes === 0) { reply.code(404); return { ok: false, error: "not_found" }; }
    return { ok: true, slug: req.params.slug, enabled };
  });

  // ── POST /kernel/clawhub/build { description } ─────────────────────────────
  app.post("/kernel/clawhub/build", async (req, reply) => {
    const { description } = req.body ?? {};
    if (!description || !description.trim()) {
      reply.code(400);
      return { ok: false, error: "description_required" };
    }
    try {
      const result = await buildSkill(description.trim(), db);
      return { ok: true, ...result };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: "build_failed", message: e.message };
    }
  });

  // ── POST /kernel/clawhub/activate — save a built skill to installed_skills ─
  app.post("/kernel/clawhub/activate", async (req, reply) => {
    const { slug, displayName, skillMd, description } = req.body ?? {};
    if (!slug || !skillMd) {
      reply.code(400);
      return { ok: false, error: "slug_and_skillMd_required" };
    }

    const vetting = vetSkillMd(skillMd, {});

    db.prepare(`
      INSERT INTO installed_skills (slug, display_name, version, installed_at, skill_md, vetting_json, enabled, source, build_prompt)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'built', ?)
      ON CONFLICT(slug) DO UPDATE SET
        display_name = excluded.display_name,
        installed_at = excluded.installed_at,
        skill_md     = excluded.skill_md,
        vetting_json = excluded.vetting_json,
        enabled      = 1,
        source       = 'built',
        build_prompt = excluded.build_prompt
    `).run(
      slug,
      displayName || slug,
      "1.0.0",
      nowIso(),
      skillMd,
      JSON.stringify(vetting),
      description || null,
    );

    return { ok: true, slug };
  });
}
