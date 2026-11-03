import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import {
  REDACTED_HEADER_VALUE,
  protectHeadersForStorage,
  redactHeaders,
  resolveHeadersForUse,
} from '../headerSecrets.js';
import { buildAuthHeaders, type CustomBackendRow } from '../customBackends.js';

const previousKey = process.env['DB_ENCRYPTION_KEY'];

describe('backend default_headers secrets', () => {
  beforeAll(() => {
    process.env['DB_ENCRYPTION_KEY'] = randomBytes(32).toString('hex');
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env['DB_ENCRYPTION_KEY'];
    else process.env['DB_ENCRYPTION_KEY'] = previousKey;
  });

  it('masks credential-like headers in responses but keeps ordinary headers readable', () => {
    expect(redactHeaders({ Authorization: 'Bearer live-secret', 'X-Api-Key': 'k', Accept: 'application/json' }))
      .toEqual({ Authorization: REDACTED_HEADER_VALUE, 'X-Api-Key': REDACTED_HEADER_VALUE, Accept: 'application/json' });
    expect(redactHeaders(null)).toEqual({});
  });

  it('encrypts sensitive values at rest and decrypts them only for outbound use', () => {
    const stored = protectHeadersForStorage({ Authorization: 'Bearer live-secret', Accept: 'json' });
    expect(stored['Authorization']).not.toContain('live-secret');
    expect(stored['Accept']).toBe('json');
    expect(resolveHeadersForUse(stored)).toEqual({ Authorization: 'Bearer live-secret', Accept: 'json' });
  });

  it('keeps the stored secret when a client sends the mask back on update', () => {
    const stored = protectHeadersForStorage({ Authorization: 'Bearer live-secret' });
    const updated = protectHeadersForStorage({ authorization: REDACTED_HEADER_VALUE, Accept: 'json' }, stored);
    expect(resolveHeadersForUse(updated)).toEqual({ authorization: 'Bearer live-secret', Accept: 'json' });
    // A mask without a previous value is dropped rather than stored as a credential.
    expect(protectHeadersForStorage({ 'X-Token': REDACTED_HEADER_VALUE })).toEqual({});
  });

  it('builds outbound auth headers from encrypted and legacy plaintext rows', () => {
    const base = { auth_type: 'none', auth_value: null } as unknown as CustomBackendRow;
    const encrypted = buildAuthHeaders({ ...base, default_headers: protectHeadersForStorage({ 'X-Api-Key': 'k1' }) });
    expect(encrypted['X-Api-Key']).toBe('k1');
    const legacy = buildAuthHeaders({ ...base, default_headers: { 'X-Api-Key': 'plain' } });
    expect(legacy['X-Api-Key']).toBe('plain');
  });
});
