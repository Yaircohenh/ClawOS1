import { getWorkspaceRoot, writeTextFile } from "../fs-safe.js";

export const action = {
  name: "write_file",
  writes: true,
  risk_level: "medium",
  reversible: true,
  description: "Write or overwrite a file in the workspace",
  async run(req) {
    const p = req.payload?.path;
    const content = req.payload?.content;
    if (!p) {throw new Error("payload.path is required");}
    if (typeof content !== "string") {throw new Error("payload.content must be string");}
    const root = getWorkspaceRoot(req.workspace_id);
    const out = await writeTextFile(root, p, content);
    return { ok: true, path: p, bytes: out.bytes };
  },
};
