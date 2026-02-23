/**
 * ClaWHub Skills Marketplace — Fastify route handlers.
 * Registered by apps/kernel/src/index.js via registerClawhubRoutes(app, db).
 */

import { searchSkills, exploreSkills, getSkill as hubGetSkill, getSkillFile, downloadSkillScripts } from "./service.js";
import { vetSkillMd } from "./vetting.js";
import { buildSkill } from "./builder.js";
import { getKeyLinks, KEY_LINKS } from "./api_keys.js";
import { encryptSecret, decryptSecret } from "../orchestrator/connections.js";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Normalize a raw ClaWHub skill record (camelCase, nested stats) to our flat shape.
 * Works for both explore items and search results.
 */
function normalizeSkill(raw) {
  return {
    slug:         raw.slug,
    display_name: raw.displayName || raw.display_name || raw.slug,
    summary:      raw.summary || raw.description || "",
    version:      raw.version || raw.tags?.latest || raw.latestVersion?.version || "1.0.0",
    stars:        raw.stats?.stars,
    installs:     raw.stats?.installsCurrent ?? raw.stats?.installsAllTime,
    moderation:   raw.moderation ?? {},
  };
}

/**
 * Fetch the SKILL.md for a slug; returns empty string on any failure.
 */
async function fetchSkillMd(slug) {
  try {
    const text = await getSkillFile(slug, "SKILL.md");
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/**
 * Save a { envVar: value } map to skill_env_vars, skipping blank values.
 */
function _saveEnvVars(db, envVars) {
  for (const [envVar, value] of Object.entries(envVars ?? {})) {
    if (typeof value !== "string" || !value.trim()) {continue;}
    try {
      const encrypted = encryptSecret(db, { value: value.trim() });
      db.prepare(`
        INSERT INTO skill_env_vars (env_var, encrypted, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(env_var) DO UPDATE SET encrypted=excluded.encrypted, updated_at=excluded.updated_at
      `).run(envVar, encrypted, nowIso());
    } catch { /* non-fatal — key wasn't initialised yet */ }
  }
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
      // ClaWHub returns { items: [...] }
      const raw = data.items || data.skills || [];
      return { ok: true, skills: raw.map(normalizeSkill) };
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
      // ClaWHub returns { results: [...] }
      const raw = data.results || data.items || data.skills || [];
      return { ok: true, skills: raw.map(normalizeSkill) };
    } catch (e) {
      reply.code(502);
      return { ok: false, error: "clawhub_unavailable", message: e.message };
    }
  });

  // ── GET /kernel/clawhub/skill/:slug ────────────────────────────────────────
  app.get("/kernel/clawhub/skill/:slug", async (req, reply) => {
    try {
      const raw = await hubGetSkill(req.params.slug);
      // ClaWHub returns { skill: {slug, displayName, stats, ...}, latestVersion, owner, moderation }
      const inner      = raw.skill || raw;
      const moderation = raw.moderation ?? inner.moderation ?? {};

      const skillMd      = await fetchSkillMd(req.params.slug);
      const skill        = normalizeSkill({ ...inner, moderation });
      const vetting      = vetSkillMd(skillMd, moderation);
      const requiredKeys = getKeyLinks(skillMd);

      return { ok: true, skill, vetting, requiredKeys };
    } catch (e) {
      reply.code(502);
      return { ok: false, error: "clawhub_unavailable", message: e.message };
    }
  });

  // ── POST /kernel/clawhub/install ───────────────────────────────────────────
  app.post("/kernel/clawhub/install", async (req, reply) => {
    const { slug, acceptDisclaimer, envVars = {} } = req.body ?? {};
    if (!slug)             { reply.code(400); return { ok: false, error: "slug_required" }; }
    if (!acceptDisclaimer) { reply.code(400); return { ok: false, error: "must_accept_disclaimer" }; }

    try {
      const raw        = await hubGetSkill(slug);
      const inner      = raw.skill || raw;
      const moderation = raw.moderation ?? inner.moderation ?? {};
      const skillMd    = await fetchSkillMd(slug);
      const vetting    = vetSkillMd(skillMd, moderation);

      if (!vetting.safe) {
        reply.code(422);
        return { ok: false, error: "vetting_failed", issues: vetting.issues };
      }

      const skill = normalizeSkill({ ...inner, moderation });

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
        skill.display_name,
        skill.version,
        nowIso(),
        skillMd,
        JSON.stringify(vetting),
      );

      // Save any provided env vars to the global skill_env_vars store
      _saveEnvVars(db, envVars);

      // Download skill scripts to ~/.codex/skills/{slug}/scripts/ (non-fatal)
      downloadSkillScripts(slug, skillMd).catch((e) =>
        console.warn(`[clawhub] downloadSkillScripts failed for ${slug}:`, e.message),
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
  app.get("/kernel/clawhub/installed", async (req) => {
    const includeMd = req.query.include_md === "1";
    const cols = includeMd
      ? "slug, display_name, version, installed_at, enabled, source, build_prompt, skill_md"
      : "slug, display_name, version, installed_at, enabled, source, build_prompt";
    const rows = db.prepare(`SELECT ${cols} FROM installed_skills ORDER BY installed_at DESC`).all();
    return { ok: true, skills: rows };
  });

  // ── GET /kernel/clawhub/skill_env_export ───────────────────────────────────
  // Returns decrypted skill env vars for trusted local callers (bridge).
  // Never expose this to external networks.
  app.get("/kernel/clawhub/skill_env_export", async () => {
    const rows = db.prepare(`SELECT env_var, encrypted FROM skill_env_vars`).all();
    const env = {};
    for (const row of rows) {
      try {
        const plain = decryptSecret(db, row.encrypted);
        if (plain?.value) {env[row.env_var] = plain.value;}
      } catch { /* skip corrupted rows */ }
    }
    return { ok: true, env };
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

  // ── GET /kernel/clawhub/skill_keys ────────────────────────────────────────
  // Returns all env vars required by installed skills, with configured status.
  app.get("/kernel/clawhub/skill_keys", async () => {
    // Gather required vars from all installed skill_mds
    const skills = db.prepare(`SELECT slug, display_name, skill_md FROM installed_skills WHERE enabled=1`).all();
    const varMeta = new Map(); // envVar → { label, url, requiredBy: [] }
    for (const s of skills) {
      const links = getKeyLinks(s.skill_md || "");
      for (const lk of links) {
        if (!varMeta.has(lk.envVar)) {
          varMeta.set(lk.envVar, { label: lk.label, url: lk.url, requiredBy: [] });
        }
        varMeta.get(lk.envVar).requiredBy.push(s.display_name || s.slug);
      }
    }

    // Also include vars already stored but not required by any current skill
    const stored = db.prepare(`SELECT env_var, encrypted, updated_at FROM skill_env_vars`).all();
    for (const row of stored) {
      if (!varMeta.has(row.env_var)) {
        const known = KEY_LINKS[row.env_var];
        varMeta.set(row.env_var, {
          label: known?.label ?? "Skill API key",
          url:   known?.url   ?? "",
          requiredBy: [],
        });
      }
    }

    // Build response — mask stored values
    const storedMap = new Map(stored.map((r) => [r.env_var, r]));
    const keys = [...varMeta.entries()].map(([envVar, meta]) => {
      const row = storedMap.get(envVar);
      let maskedValue = null;
      if (row) {
        try {
          const plain = decryptSecret(db, row.encrypted);
          const v = plain?.value ?? "";
          maskedValue = v.length > 8 ? v.slice(0, 4) + "•".repeat(Math.min(v.length - 4, 12)) : "•".repeat(v.length);
        } catch { /* skip */ }
      }
      return {
        envVar,
        label:       meta.label,
        url:         meta.url,
        requiredBy:  meta.requiredBy,
        configured:  !!row,
        maskedValue,
        updatedAt:   row?.updated_at ?? null,
      };
    });

    return { ok: true, keys };
  });

  // ── PATCH /kernel/clawhub/skill_keys/:varName { value } ───────────────────
  app.patch("/kernel/clawhub/skill_keys/:varName", async (req, reply) => {
    const { varName } = req.params;
    const { value } = req.body ?? {};
    if (typeof value !== "string" || !value.trim()) {
      reply.code(400);
      return { ok: false, error: "value_required" };
    }
    try {
      const encrypted = encryptSecret(db, { value: value.trim() });
      db.prepare(`
        INSERT INTO skill_env_vars (env_var, encrypted, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(env_var) DO UPDATE SET encrypted=excluded.encrypted, updated_at=excluded.updated_at
      `).run(varName, encrypted, nowIso());
      return { ok: true, envVar: varName };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: "save_failed", message: e.message };
    }
  });

  // ── DELETE /kernel/clawhub/skill_keys/:varName ─────────────────────────────
  app.delete("/kernel/clawhub/skill_keys/:varName", async (req, reply) => {
    const { changes } = db.prepare(`DELETE FROM skill_env_vars WHERE env_var=?`).run(req.params.varName);
    if (changes === 0) { reply.code(404); return { ok: false, error: "not_found" }; }
    return { ok: true, envVar: req.params.varName };
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
