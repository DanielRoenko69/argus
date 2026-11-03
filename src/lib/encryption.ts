/**
 * AES-256-GCM field-level encryption for sensitive DB values.
 *
 * Key:    DB_ENCRYPTION_KEY env var — 64-char hex string (= 32 bytes)
 *         Generate with: openssl rand -hex 32
 *
 * Format: "enc:v1:<base64(iv[12] + ciphertext + tag[16])>"
 *
 * Key rotation (enterprise policy):
 *   1. Set OLD_DB_ENCRYPTION_KEY = current key
 *   2. Set DB_ENCRYPTION_KEY     = new key
 *   3. Call POST /api/admin/encryption/rotate (re-encrypts all DB values)
 *   4. Remove OLD_DB_ENCRYPTION_KEY
 *
 * During rotation: decrypt() tries new key first, falls back to old key.
 * Encrypt() always uses the current DB_ENCRYPTION_KEY.
 *
 * Backward-compatible:
 *   - No key set → values pass through unchanged (warn in production)
 *   - Plaintext values (no "enc:v1:" prefix) → passed through as-is
 *   - Already encrypted → not re-encrypted on write (idempotent)
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO    = 'aes-256-gcm';
const PREFIX  = 'enc:v1:';
const IV_LEN  = 12;
const TAG_LEN = 16;

function parseKey(envVar: string): Buffer | null {
  const raw = process.env[envVar] ?? '';
  if (!raw) return null;
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return createHash('sha256').update(raw).digest();
}

function tryDecrypt(buf: Buffer, key: Buffer): string | null {
  try {
    const iv         = buf.subarray(0, IV_LEN);
    const tag        = buf.subarray(buf.length - TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
    const decipher   = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

export function encrypt(value: string | null | undefined): string | null {
  if (value == null || value === '') return value ?? null;
  if (value.startsWith(PREFIX)) return value; // already encrypted — idempotent

  const key = parseKey('DB_ENCRYPTION_KEY');
  if (!key) {
    // L1 — In production hard-fail. Silent plaintext-fallback bedeutet Tokens,
    // Client-Secrets, etc. landen unverschlüsselt in der DB → Compliance-Violation.
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'DB_ENCRYPTION_KEY is required in production. Refusing to store sensitive value as plaintext.',
      );
    }
    return value; // dev only: plaintext passthrough
  }

  const iv         = randomBytes(IV_LEN);
  const cipher     = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag        = cipher.getAuthTag();

  return PREFIX + Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

export function decrypt(value: string | null | undefined): string | null {
  if (value == null || value === '') return value ?? null;
  if (!value.startsWith(PREFIX)) return value; // plaintext passthrough

  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');

  // Try current key first
  const currentKey = parseKey('DB_ENCRYPTION_KEY');
  if (currentKey) {
    const result = tryDecrypt(buf, currentKey);
    if (result !== null) return result;
  }

  // During key rotation: fall back to old key
  const oldKey = parseKey('OLD_DB_ENCRYPTION_KEY');
  if (oldKey) {
    const result = tryDecrypt(buf, oldKey);
    if (result !== null) return result;
  }

  // Both keys failed — return raw value so app doesn't hard-crash
  return value;
}

/** True if the value is encrypted with the current key (not old key or plaintext). */
export function isCurrentlyEncrypted(value: string | null | undefined): boolean {
  if (!value?.startsWith(PREFIX)) return false;
  const key = parseKey('DB_ENCRYPTION_KEY');
  if (!key) return false;
  const buf    = Buffer.from(value.slice(PREFIX.length), 'base64');
  return tryDecrypt(buf, key) !== null;
}
