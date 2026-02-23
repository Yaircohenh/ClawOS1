/**
 * send_email — Send an email via a configured SMTP connection.
 *
 * Requires SMTP credentials stored in the connections table
 * (host, port, user, password — stored via PUT /kernel/connections/smtp).
 *
 * payload  : { to, subject, body }   ← from classify_intent / direct call
 * returns  : { ok, sent: { to, subject, body_preview } }
 *          | { ok: false, missing_connection: "smtp", error }
 */
import nodemailer from "nodemailer";
import { getSecret } from "../connections.js";

export const action = {
  name:        "send_email",
  writes:      true,
  risk_level:  "high",
  reversible:  false,
  description: "Send an email to a recipient",

  async run(req, ctx) {
    // Accept payload.to (from classify_intent) or legacy req.destination
    const to      = req.payload?.to ?? req.destination;
    const subject = req.payload?.subject ?? "";
    const body    = req.payload?.body    ?? "";

    if (!to)      { throw new Error("recipient email (payload.to) is required"); }
    if (!subject) { throw new Error("payload.subject is required"); }
    if (!body)    { throw new Error("payload.body is required"); }

    // ── Check SMTP configuration ─────────────────────────────────────────────
    const smtp = ctx?.db ? getSecret(ctx.db, "smtp") : null;

    if (!smtp?.host || !smtp?.user || !smtp?.password) {
      return {
        ok:                 false,
        missing_connection: "smtp",
        error:
          "SMTP not configured. Go to Settings → Connections → SMTP to add your " +
          "email server details (host, port, username, password).",
      };
    }

    const port   = Number(smtp.port) || 587;
    const secure = port === 465;

    // ── Send via nodemailer ──────────────────────────────────────────────────
    const transporter = nodemailer.createTransport({
      host:   smtp.host,
      port,
      secure,
      auth: {
        user: smtp.user,
        pass: smtp.password,
      },
      // Reasonable timeouts
      connectionTimeout: 10_000,
      greetingTimeout:    5_000,
      socketTimeout:     15_000,
    });

    const info = await transporter.sendMail({
      from:    smtp.user,
      to,
      subject,
      text:    body,
    });

    return {
      ok:   true,
      sent: {
        to,
        subject,
        body_preview:  body.slice(0, 120),
        message_id:    info.messageId ?? null,
      },
      note: `Email sent to ${to}`,
    };
  },
};
