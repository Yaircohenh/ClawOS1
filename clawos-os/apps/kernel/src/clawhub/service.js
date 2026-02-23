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
