/**
 * Delegation Capability Token (DCT) Service
 *
 * DCTs are the ONLY mechanism by which subagents are authorized to act.
 *
 * Key invariants enforced here:
 *  1. DCTs issued to subagents MUST include parent_agent_id.
 *  2. Subagent DCTs MUST be attenuated — scope ⊆ parent agent's scope.
 *  3. DCTs are HMAC-signed with the kernel's recovery_hash (same key as cap tokens).
 *  4. Expired or revoked DCTs are rejected at verification time.
 *
 * Token wire format: "<token_id>.<base64url-hmac>"
 */
import crypto from "node:crypto";

function dctId() {
  return `dct_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Mint a new Delegation Capability Token.
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.workspace_id
 * @param {"agent"|"subagent"} opts.issued_to_kind
 * @param {string} opts.issued_to_id
 * @param {string|null} opts.parent_agent_id  — required when issued_to_kind="subagent"
 * @param {string|null} opts.task_id
 * @param {object} opts.scope   { allowed_tools[], operations[], resource_constraints{} }
 * @param {number} opts.ttl_seconds
 * @param {string} opts.hmacKey  — kernel's recovery_hash value (hex string)
 */
export function mintDCT(db, {
  workspace_id,
  issued_to_kind,
  issued_to_id,
  parent_agent_id = null,
  task_id = null,
  scope,
  ttl_seconds = 600,
  hmacKey,
}) {
  if (issued_to_kind === "subagent" && !parent_agent_id) {
    throw new Error("parent_agent_id is required for subagent DCTs");
  }

  const token_id   = dctId();
  const now        = new Date().toISOString();
  const expires_at = new Date(Date.now() + ttl_seconds * 1000).toISOString();

  db.prepare(`
    INSERT INTO dct_tokens (
      token_id, workspace_id, issued_to_kind, issued_to_id,
      parent_agent_id, task_id, scope_json, ttl_seconds,
      expires_at, created_at, revoked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    token_id, workspace_id, issued_to_kind, issued_to_id,
    parent_agent_id, task_id, JSON.stringify(scope),
    ttl_seconds, expires_at, now,
  );

  const sig   = sign(token_id, hmacKey);
  const token = `${token_id}.${sig}`;

  return { token_id, token, expires_at, issued_to_kind, issued_to_id };
}

/**
 * Verify a DCT bearer token.
 * Returns the full token record (with parsed scope) or null if invalid/expired/revoked.
 */
export function verifyDCT(db, token, hmacKey) {
  const lastDot = token.lastIndexOf(".");
  if (lastDot < 1) {return null;}

  const token_id  = token.slice(0, lastDot);
  const sig       = token.slice(lastDot + 1);
  const expected  = sign(token_id, hmacKey);

  const a = Buffer.from(sig,      "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {return null;}

  const row = db.prepare(`SELECT * FROM dct_tokens WHERE token_id = ?`).get(token_id);
  if (!row)             {return null;}
  if (row.revoked)      {return null;}
  if (new Date(row.expires_at).getTime() < Date.now()) {return null;}

  return { ...row, scope: JSON.parse(row.scope_json ?? "{}") };
}

/** Look up a DCT by token_id (no signature check — internal use only). */
export function getDCT(db, token_id) {
  const row = db.prepare(`SELECT * FROM dct_tokens WHERE token_id = ?`).get(token_id);
  if (!row) {return null;}
  return { ...row, scope: JSON.parse(row.scope_json ?? "{}") };
}

export function revokeDCT(db, token_id) {
  db.prepare(`UPDATE dct_tokens SET revoked = 1 WHERE token_id = ?`).run(token_id);
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function sign(token_id, hmacKey) {
  return crypto
    .createHmac("sha256", hmacKey || "dev")
    .update(token_id, "utf8")
    .digest("base64url");
}
