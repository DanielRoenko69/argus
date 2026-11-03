/**
 * Credential-like values in a backend's `default_headers`.
 *
 * Admins sometimes put `Authorization`, `X-Api-Key` or similar into default
 * headers instead of the encrypted auth fields. Those values are encrypted at
 * rest, decrypted only when an outbound request is built, and always masked
 * in API responses. A masked value sent back by a client keeps the stored
 * secret instead of overwriting it with the mask.
 */

import { decrypt, encrypt } from '../lib/encryption.js';

export const SENSITIVE_HEADER_PATTERN = /(?:authorization|cookie|password|passphrase|session|jwt|token|secret|credential|api[-_]?key|private[-_]?key|access[-_]?key)/i;
export const REDACTED_HEADER_VALUE = '••••••••';

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(name);
}

function headerEntries(headers: unknown): Array<[string, string]> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return [];
  return Object.entries(headers as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
}

/** Response projection: sensitive header values are replaced by a fixed mask. */
export function redactHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headerEntries(headers)) {
    out[name] = isSensitiveHeaderName(name) && value ? REDACTED_HEADER_VALUE : value;
  }
  return out;
}

/**
 * Storage projection: sensitive values are encrypted; a masked value keeps the
 * existing stored value for the same header name (case-insensitive).
 */
export function protectHeadersForStorage(incoming: unknown, existing?: unknown): Record<string, string> {
  const previous = new Map(headerEntries(existing).map(([name, value]) => [name.toLowerCase(), value]));
  const out: Record<string, string> = {};
  for (const [name, value] of headerEntries(incoming)) {
    if (!isSensitiveHeaderName(name)) {
      out[name] = value;
      continue;
    }
    if (value === REDACTED_HEADER_VALUE) {
      const kept = previous.get(name.toLowerCase());
      if (kept !== undefined) out[name] = encrypt(decrypt(kept) ?? kept) ?? kept;
      continue;
    }
    out[name] = encrypt(value) ?? value;
  }
  return out;
}

/** Outbound projection: decrypt sensitive values (plaintext legacy rows pass through). */
export function resolveHeadersForUse(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headerEntries(headers)) {
    out[name] = isSensitiveHeaderName(name) ? (decrypt(value) ?? value) : value;
  }
  return out;
}
