import { createHmac } from 'node:crypto';

export const LOCAL_MFA_DEMO = Object.freeze({
  realm: 'argus-mfa-demo',
  clientId: 'argus-local-mfa',
  clientSecret: 'argus-local-mfa-client-secret',
  username: 'argus-mfa-admin',
  password: 'ArgusMfa42!',
  // Base32 encoding of the raw, disposable Keycloak credential value
  // `ARGUS-MFA-DEMO-KEY`.
  totpSecret: 'IFJEOVKTFVGUMQJNIRCU2TZNJNCVS',
  totpAlgorithm: 'sha256',
  totpDigits: 6,
  totpPeriodSeconds: 30,
});

export const LOCAL_MFA_DEVELOPER = Object.freeze({
  ...LOCAL_MFA_DEMO,
  username: 'argus-mfa-developer',
  totpSecret: 'IFJEOVKTFVGUMQJNIRCVMRKMJ5IEKUQ',
});

export const LOCAL_MFA_ALEX = Object.freeze({
  ...LOCAL_MFA_DEMO,
  username: 'alex',
  totpSecret: 'IFJEOVKTFVGUMQJNIFGEKWA',
});

export function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const rawCharacter of value.toUpperCase().replace(/=+$/g, '')) {
    const index = alphabet.indexOf(rawCharacter);
    if (index < 0) throw new Error('Invalid base32 TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp({
  secret = LOCAL_MFA_DEMO.totpSecret,
  algorithm = LOCAL_MFA_DEMO.totpAlgorithm,
  digits = LOCAL_MFA_DEMO.totpDigits,
  periodSeconds = LOCAL_MFA_DEMO.totpPeriodSeconds,
  now = Date.now(),
} = {}) {
  const counter = Math.floor(now / 1_000 / periodSeconds);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, decodeBase32(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Token is not a compact JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
