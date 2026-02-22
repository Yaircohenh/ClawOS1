/**
 * Static security analysis for skill SKILL.md files.
 * vetSkillMd(rawSkillMd, moderation?) → { safe, score, issues: [{level, message}] }
 */

const CRITICAL_PATTERNS = [
  { regex: /curl[^|]+\|[^|]*(?:bash|sh|zsh)/i,           message: "Pipes curl output directly into a shell" },
  { regex: /wget[^|]+\|[^|]*(?:bash|sh|zsh)/i,           message: "Pipes wget output directly into a shell" },
  { regex: /base64.*(?:--decode|-d).*\|.*(?:bash|sh)/i,  message: "Decodes base64 and pipes to shell" },
  { regex: /\/dev\/tcp\//,                                message: "Uses /dev/tcp (potential reverse shell)" },
  { regex: /\bnc\b.*-[el].*\d+/i,                        message: "Netcat in listen/execute mode (possible reverse shell)" },
  { regex: /eval\s*\(/i,                                  message: "Uses eval() which can execute arbitrary code" },
];

const SAFE_INSTALL_HOSTS = new Set([
  "npmjs.com", "registry.npmjs.org",
  "brew.sh",
  "github.com", "raw.githubusercontent.com",
  "pypi.org", "files.pythonhosted.org",
  "golang.org", "pkg.go.dev",
]);

const KNOWN_SAFE_ENV_VARS = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
  "GITHUB_TOKEN", "NOTION_API_KEY", "DISCORD_WEBHOOK_URL",
  "SLACK_BOT_TOKEN", "STRIPE_API_KEY", "SENDGRID_API_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
]);

/**
 * @param {string} rawSkillMd
 * @param {{ isMalwareBlocked?: boolean; isSuspicious?: boolean }} [moderation]
 * @returns {{ safe: boolean; score: number; issues: { level: string; message: string }[] }}
 */
export function vetSkillMd(rawSkillMd, moderation = {}) {
  const issues = [];

  // ── CRITICAL checks ──────────────────────────────────────────────────────
  for (const { regex, message } of CRITICAL_PATTERNS) {
    if (regex.test(rawSkillMd)) {
      issues.push({ level: "critical", message });
    }
  }

  if (moderation.isMalwareBlocked === true) {
    issues.push({ level: "critical", message: "Flagged as malware by ClaWHub moderation" });
  }

  // ── WARNING checks ───────────────────────────────────────────────────────
  // Check install URLs for non-allowlisted hosts
  const urlMatches = rawSkillMd.match(/https?:\/\/[^\s"'`)]+/gi) ?? [];
  const warnedHosts = new Set();
  for (const urlStr of urlMatches) {
    try {
      const { hostname } = new URL(urlStr);
      const base = hostname.replace(/^www\./, "");
      const isAllowed =
        SAFE_INSTALL_HOSTS.has(base) ||
        [...SAFE_INSTALL_HOSTS].some((h) => base.endsWith("." + h));
      if (!isAllowed && !warnedHosts.has(hostname)) {
        warnedHosts.add(hostname);
        issues.push({ level: "warning", message: `Install URL from non-allowlisted host: ${hostname}` });
      }
    } catch { /* malformed URL — skip */ }
  }

  if (moderation.isSuspicious === true) {
    issues.push({ level: "warning", message: "Flagged as suspicious by ClaWHub moderation" });
  }

  // Check for env vars that look sensitive but aren't in the known-safe list
  const envMatches = rawSkillMd.match(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g) ?? [];
  const warnedVars = new Set();
  for (const m of envMatches) {
    const varName = m.replace(/^\$\{?/, "").replace(/\}$/, "");
    if (
      /SECRET|PRIVATE|PASSWORD|TOKEN/.test(varName) &&
      !KNOWN_SAFE_ENV_VARS.has(varName) &&
      !warnedVars.has(varName)
    ) {
      warnedVars.add(varName);
      issues.push({ level: "warning", message: `Unknown sensitive env var: ${varName}` });
    }
  }

  // ── INFO checks ──────────────────────────────────────────────────────────
  if (!/^homepage:/im.test(rawSkillMd)) {
    issues.push({ level: "info", message: "No homepage listed" });
  }
  if (!/^version:/im.test(rawSkillMd)) {
    issues.push({ level: "info", message: "No version pinned" });
  }

  const hasCritical = issues.some((i) => i.level === "critical");
  const warningCount = issues.filter((i) => i.level === "warning").length;
  const score = hasCritical ? 0 : Math.max(0, 100 - warningCount * 20);

  return { safe: !hasCritical, score, issues };
}
