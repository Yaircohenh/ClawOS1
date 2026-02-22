export const action = {
  name: "run_shell",
  writes: true, // dangerous
  async run(_req, _ctx) {
    // Phase 2.2: disabled by default
    throw new Error("run_shell is disabled by default");
  },
};
