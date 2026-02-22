export const action = {
  name: "send_email",
  writes: true, // yes: outbound side-effect
  async run(req, _ctx) {
    const dryRun = !!req.meta?.dry_run;

    const to = req.destination;
    const subject = req.payload?.subject || "";
    const body = req.payload?.body || "";

    if (!to) {throw new Error("destination email is required");}
    if (!subject) {throw new Error("payload.subject is required");}
    if (!body) {throw new Error("payload.body is required");}

    if (!dryRun) {
      // Phase 2.2: still dry-run; real integration later.
      // We keep it blocked unless dry_run=true.
      throw new Error("send_email is dry-run only (set meta.dry_run=true)");
    }

    return {
      ok: true,
      dry_run: true,
      would_send: { to, subject, body_preview: body.slice(0, 120) },
      note: "Dry-run only. Wire actual email tool next slice.",
    };
  },
};
