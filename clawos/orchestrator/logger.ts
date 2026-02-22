import fs from "node:fs";
import path from "node:path";

export const LOG_PATH = path.resolve(process.cwd(), "data/openclaw/logs/orchestrator.log");

function ensureDir(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

export function logEvent(event: Record<string, unknown>) {
  ensureDir(LOG_PATH);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  });
  fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
}
