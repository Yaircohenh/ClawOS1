import { exec } from "node:child_process";

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 3000;

export const action = {
  name: "run_shell",
  writes: true, // requires approval + capability token
  risk_level: "high",
  reversible: false,
  description: "Run a shell command on the system",
  async run(req, _ctx) {
    const command = req.payload?.command ?? req.payload?.cmd ?? "";
    if (!command) { throw new Error("payload.command is required"); }

    // Caller may supply extra env vars (e.g. skill API keys) to inject
    const extraEnv = (req.payload?.env && typeof req.payload.env === "object")
      ? req.payload.env : {};

    const { stdout, stderr, code } = await new Promise((resolve) => {
      exec(command, { timeout: TIMEOUT_MS, shell: "/bin/sh", env: { ...process.env, ...extraEnv } }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout?.slice(0, MAX_OUTPUT) ?? "",
          stderr: stderr?.slice(0, MAX_OUTPUT) ?? "",
          code: err?.code ?? (err ? 1 : 0),
        });
      });
    });

    const output = [stdout, stderr].filter(Boolean).join("\n---stderr---\n").trim();
    return {
      ok: code === 0,
      exit_code: code,
      output: output || "(no output)",
      command,
    };
  },
};
