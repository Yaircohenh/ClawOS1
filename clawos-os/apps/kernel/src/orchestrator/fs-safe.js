import fs from "node:fs/promises";
import path from "node:path";

export function getWorkspaceRoot(workspace_id) {
  // Kernel’s “workspace” storage can be simple/deterministic:
  // everything lives under data/openclaw/workspaces/<id>
  return path.resolve("data/openclaw/workspaces", workspace_id);
}

export function resolveInside(root, relPath) {
  const full = path.resolve(root, relPath);
  const rootNorm = root.endsWith(path.sep) ? root : root + path.sep;
  if (!full.startsWith(rootNorm)) {
    throw new Error("path escapes workspace root");
  }
  return full;
}

export async function readTextFile(root, relPath) {
  const full = resolveInside(root, relPath);
  return fs.readFile(full, "utf8");
}

export async function writeTextFile(root, relPath, content) {
  const full = resolveInside(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  return { bytes: Buffer.byteLength(content, "utf8"), path: full };
}
