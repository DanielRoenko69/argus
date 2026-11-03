import { decrypt } from '../../lib/encryption.js';

const HTTP_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

function readableStoredCredential(storedAuthValue: string | null | undefined): string | null {
  if (!storedAuthValue) return null;
  const decrypted = decrypt(storedAuthValue);
  // decrypt() deliberately returns the raw value on key failure so unrelated
  // callers keep running. Credential reuse must be stricter: forwarding that
  // ciphertext as a bearer/basic/header secret would be both wrong and unsafe.
  if (!decrypted || (storedAuthValue.startsWith('enc:v1:') && decrypted === storedAuthValue)) return null;
  return decrypted;
}

export function storedOpenApiCredentialReadable(
  storedAuthValue: string | null | undefined,
): boolean {
  return readableStoredCredential(storedAuthValue) !== null;
}

/**
 * Compare the header encoded in an existing backend credential without
 * exposing either the decrypted value or the parsed name to API callers.
 * Header field names are case-insensitive on the wire.
 */
export function storedOpenApiHeaderMatches(
  storedAuthValue: string | null | undefined,
  expectedHeaderName: string | null | undefined,
): boolean {
  if (typeof expectedHeaderName !== 'string'
    || !HTTP_HEADER_NAME.test(expectedHeaderName)) return false;

  // decrypt() passes legacy plaintext through unchanged, matching
  // buildAuthHeaders(), while unreadable ciphertext fails closed above.
  const authValue = readableStoredCredential(storedAuthValue);
  if (authValue === null) return false;
  const separator = authValue.indexOf(':');
  if (separator <= 0) return false;
  const storedHeaderName = authValue.slice(0, separator).trim();
  return HTTP_HEADER_NAME.test(storedHeaderName)
    && storedHeaderName.toLowerCase() === expectedHeaderName.toLowerCase();
}
