/**
 * ClaWHub marketplace API client.
 * Base URL: https://clawhub.ai/api/v1
 * All calls have a 10s timeout.
 */

const BASE_URL = process.env.CLAWHUB_API_URL || "https://clawhub.ai/api/v1";
const TIMEOUT_MS = 10_000;

async function hubFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) {
      throw new Error(`ClaWHub API returned HTTP ${res.status} for ${path}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function hubFetchText(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`ClaWHub API returned HTTP ${res.status} for ${path}`);
    }
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchSkills(q, limit = 20) {
  return hubFetch(`/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export async function exploreSkills(sort = "trending", limit = 24) {
  return hubFetch(`/skills?sort=${encodeURIComponent(sort)}&limit=${limit}`);
}

export async function getSkill(slug) {
  return hubFetch(`/skills/${encodeURIComponent(slug)}`);
}

export async function getSkillFile(slug, path = "SKILL.md") {
  return hubFetchText(`/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`);
}

/**
 * Parse SKILL.md for script paths under ~/.codex/skills/{slug}/scripts/
 * and download them to the local filesystem.
 * Non-fatal — logs and skips on any failure.
 */
export async function downloadSkillScripts(slug, skillMd) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");

  // Extract all unique script filenames referenced in the SKILL.md
  const re = new RegExp(`~/.codex/skills/${slug}/scripts/([\\w./-]+)`, "g");
  const found = new Set();
  let m;
  while ((m = re.exec(skillMd)) !== null) {
    found.add(m[1]); // e.g. "generate_image.py"
  }
  if (found.size === 0) {return;}

  const skillDir = join(homedir(), ".codex", "skills", slug, "scripts");
  await mkdir(skillDir, { recursive: true });

  for (const filename of found) {
    const dest = join(skillDir, String(filename));
    try {
      const content = await getSkillFile(slug, `scripts/${String(filename)}`);
      await writeFile(dest, content, { mode: 0o755 });
    } catch (e) {
      // Non-fatal: script may not exist on ClaWHub
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[clawhub] Could not download script for ${slug}:`, msg);
    }
  }
}
