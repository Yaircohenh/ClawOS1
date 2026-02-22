import fs from "node:fs";
import path from "node:path";

const LOG_PATH = path.resolve("data/openclaw/logs/orchestrator.log");

function ensureLogDir() {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true });}
}

export function logEvent(evt) {
  try {
    ensureLogDir();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...evt,
    });
    fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch {
    // never throw from logging
  }
}

export function getLogPath() {
  return LOG_PATH;
}

// Phase 3: structured audit log — one line per action request, final status only
const AUDIT_PATH = path.resolve("data/openclaw/logs/audit.log");

export function logAudit(evt) {
  try {
    ensureLogDir();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...evt,
    });
    fs.appendFileSync(AUDIT_PATH, line + "\n", "utf8");
  } catch {
    // never throw from logging
  }
}

export function getAuditPath() {
  return AUDIT_PATH;
}
