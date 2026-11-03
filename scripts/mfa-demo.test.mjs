import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeBase32,
  generateTotp,
  LOCAL_MFA_ALEX,
  LOCAL_MFA_DEMO,
  LOCAL_MFA_DEVELOPER,
} from './lib/localMfaDemo.mjs';

test('decodes RFC 4648 base32 values', () => {
  assert.equal(decodeBase32('JBSWY3DP').toString('utf8'), 'Hello');
});

test('generates RFC 6238 compatible SHA-256 TOTP values', () => {
  // RFC 6238 SHA-256 test vector at T=1, truncated to six digits.
  assert.equal(generateTotp({
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
    algorithm: 'sha256',
    digits: 6,
    periodSeconds: 30,
    now: 59_000,
  }), '119246');
});

test('keeps demo identity credentials deterministic and isolated', () => {
  assert.equal(decodeBase32(LOCAL_MFA_DEMO.totpSecret).toString('utf8'), 'ARGUS-MFA-DEMO-KEY');
  assert.equal(decodeBase32(LOCAL_MFA_DEVELOPER.totpSecret).toString('utf8'), 'ARGUS-MFA-DEVELOPER');
  assert.equal(decodeBase32(LOCAL_MFA_ALEX.totpSecret).toString('utf8'), 'ARGUS-MFA-ALEX');
  assert.notEqual(LOCAL_MFA_DEMO.totpSecret, LOCAL_MFA_DEVELOPER.totpSecret);
  assert.notEqual(LOCAL_MFA_DEMO.totpSecret, LOCAL_MFA_ALEX.totpSecret);
});
