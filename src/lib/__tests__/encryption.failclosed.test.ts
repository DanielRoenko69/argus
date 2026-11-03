/**
 * Verifies L1 — encrypt() must fail-closed in production when DB_ENCRYPTION_KEY
 * is unset. Silent plaintext-fallback would be a compliance violation.
 */

describe('encryption — fail-closed in production', () => {
  const origKey  = process.env['DB_ENCRYPTION_KEY'];
  const origNode = process.env['NODE_ENV'];

  afterEach(() => {
    if (origKey === undefined) delete process.env['DB_ENCRYPTION_KEY'];
    else process.env['DB_ENCRYPTION_KEY'] = origKey;
    if (origNode === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = origNode;
    jest.resetModules();
  });

  it('throws in NODE_ENV=production when DB_ENCRYPTION_KEY missing', async () => {
    delete process.env['DB_ENCRYPTION_KEY'];
    process.env['NODE_ENV'] = 'production';
    const { encrypt } = await import('../encryption.js');
    expect(() => encrypt('sensitive-token')).toThrow(/DB_ENCRYPTION_KEY is required in production/);
  });

  it('passes through plaintext in non-production when key missing (dev-only)', async () => {
    delete process.env['DB_ENCRYPTION_KEY'];
    process.env['NODE_ENV'] = 'development';
    const { encrypt } = await import('../encryption.js');
    expect(encrypt('plain-dev-token')).toBe('plain-dev-token');
  });

  it('does not throw on null/empty/undefined input even without key', async () => {
    delete process.env['DB_ENCRYPTION_KEY'];
    process.env['NODE_ENV'] = 'production';
    const { encrypt } = await import('../encryption.js');
    // Existing behavior: empty-input passes through unchanged, no throw
    expect(() => encrypt(null)).not.toThrow();
    expect(() => encrypt('')).not.toThrow();
    expect(() => encrypt(undefined)).not.toThrow();
    expect(encrypt(null)).toBeNull();
    expect(encrypt(undefined)).toBeNull();
  });
});
