/**
 * Shared helper for reading provider secrets from the kernel DB.
 * Used by action handlers that need API credentials.
 *
 * The key used for decryption lives in kernel_state.connections_key and is
 * managed exclusively by the kernel — never exposed to callers of this module.
 */
import crypto from "node:crypto";

function getKey(db) {
  const row = db.prepare(`SELECT value FROM kernel_state WHERE key='connections_key'`).get();
  if (!row) {return null;}
  return Buffer.from(row.value, "hex");
}

/**
 * Decrypt a raw encrypted_json blob from the connections table.
 * Returns the parsed secrets object, or throws if the key is missing / AEAD fails.
 */
export function decryptSecret(db, encryptedB64) {
  const key = getKey(db);
  if (!key) {throw new Error("connections_key not initialised");}
  const buf = Buffer.from(encryptedB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
  );
}

/**
 * Convenience wrapper: look up a provider row and return decrypted secrets.
 * Returns null if the provider is not configured or decryption fails.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} provider  e.g. "brave", "openai"
 * @returns {Record<string,string> | null}
 */
export function getSecret(db, provider) {
  const row = db.prepare(`SELECT encrypted_json FROM connections WHERE provider=?`).get(provider);
  if (!row) {return null;}
  try {
    return decryptSecret(db, row.encrypted_json);
  } catch {
    return null;
  }
}
