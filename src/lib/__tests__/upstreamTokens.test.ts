import { randomBytes } from 'crypto';

// Set encryption key BEFORE importing upstreamTokens — encryption.ts reads
// DB_ENCRYPTION_KEY at module-eval-time on first call
process.env['DB_ENCRYPTION_KEY'] = randomBytes(32).toString('hex');

import { encryptToken, decryptToken, needsRefresh } from '../upstreamTokens.js';

describe('upstreamTokens — encryption', () => {
  it('round-trips a token', () => {
    const plain = 'ya29.a0AfH6SMBPzJqxg-secret-token-value';
    const enc = encryptToken(plain);
    expect(enc).not.toContain(plain);
    expect(decryptToken(enc)).toBe(plain);
  });

  it('returns undefined for null/empty', () => {
    expect(decryptToken(null)).toBeUndefined();
    expect(decryptToken('')).toBeUndefined();
    expect(decryptToken(undefined)).toBeUndefined();
  });

  it('throws on tampered ciphertext', () => {
    const enc = encryptToken('secret');
    // Tamper the last char
    const tampered = enc.slice(0, -2) + (enc.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('two encryptions of same value produce different ciphertext (IV randomness)', () => {
    const a = encryptToken('same-input');
    const b = encryptToken('same-input');
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe('same-input');
    expect(decryptToken(b)).toBe('same-input');
  });
});

describe('upstreamTokens — needsRefresh', () => {
  it('treats invalid expiry as needing refresh, never as a valid lease', () => {
    expect(needsRefresh(new Date(NaN))).toBe(true);
  });
  it('returns true when expires within 60s', () => {
    expect(needsRefresh(new Date(Date.now() + 30_000))).toBe(true);
  });

  it('returns false when expires in >60s', () => {
    expect(needsRefresh(new Date(Date.now() + 600_000))).toBe(false);
  });

  it('returns true when expires in the past', () => {
    expect(needsRefresh(new Date(Date.now() - 1000))).toBe(true);
  });

  it('exact boundary at 60s — returns false (>= cutoff)', () => {
    expect(needsRefresh(new Date(Date.now() + 60_001))).toBe(false);
  });
});
