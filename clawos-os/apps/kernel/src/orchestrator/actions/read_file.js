import { getWorkspaceRoot, readTextFile } from "../fs-safe.js";

export const action = {
  name: "read_file",
  writes: false,
  risk_level: "low",
  reversible: true,
  description: "Read a file from the workspace",
  async run(req) {
    const p = req.payload?.path;
    if (!p) {throw new Error("payload.path is required");}
    const root = getWorkspaceRoot(req.workspace_id);
    const text = await readTextFile(root, p);
    return { ok: true, path: p, bytes: Buffer.byteLength(text, "utf8"), text };
  },
};
