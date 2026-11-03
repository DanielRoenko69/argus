import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { createSession, getSession, hasFreshMfaSession } from '../userAuth.js';

function poolWith(rows: unknown[] = []) {
  return {
    query: jest.fn(async () => ({ rows, rowCount: rows.length })),
  } as unknown as pg.Pool;
}

describe('browser session authentication assurance', () => {
  it('stores local sessions without MFA evidence', async () => {
    const pool = poolWith();
    await createSession(pool, 17, 8, '127.0.0.1', 'test-agent');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('auth_method'),
      expect.arrayContaining([17, 8, '127.0.0.1', 'test-agent', 'local', null, null]),
    );
  });

  it('stores provider-verified OIDC assurance and normalizes it on lookup', async () => {
    const verifiedAt = '2026-09-10T12:00:00.000Z';
    const createPool = poolWith();
    await createSession(createPool, 17, 8, undefined, undefined, {
      authMethod: 'oidc', mfaVerifiedAt: verifiedAt, mfaMethod: 'amr:webauthn',
    });
    expect(createPool.query).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['oidc', verifiedAt, 'amr:webauthn']),
    );

    const readPool = poolWith([{
      id: 17,
      username: 'oidc:issuer:subject',
      display_name: 'Alex',
      role: 'platform_admin',
      allowed_bundles: null,
      entra_groups: null,
      auth_method: 'oidc',
      mfa_verified_at: new Date(verifiedAt),
      mfa_method: 'amr:webauthn',
      workspace_scopes: [
        { tenantKey: 'tenant-a', workspaceKey: 'workspace-a', isDefault: true },
      ],
    }]);
    await expect(getSession(readPool, 'session-id')).resolves.toMatchObject({
      auth_method: 'oidc', mfa_verified_at: verifiedAt, mfa_method: 'amr:webauthn', entra_groups: [],
      workspace_scopes: [{ tenantKey: 'tenant-a', workspaceKey: 'workspace-a', isDefault: true }],
    });
    expect(readPool.query).toHaveBeenCalledWith(expect.stringContaining('mcp_workspace_memberships'), ['session-id']);
  });

  it('rejects incomplete or local MFA assertions before touching the database', async () => {
    const pool = poolWith();
    await expect(createSession(pool, 17, 8, undefined, undefined, {
      authMethod: 'oidc', mfaVerifiedAt: '2026-09-10T12:00:00.000Z',
    })).rejects.toThrow('requires both');
    await expect(createSession(pool, 17, 8, undefined, undefined, {
      authMethod: 'local', mfaVerifiedAt: '2026-09-10T12:00:00.000Z', mfaMethod: 'header:mfa',
    })).rejects.toThrow('Only OIDC');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('treats stale, future, local and malformed assurance as not fresh', () => {
    const now = new Date('2026-09-10T12:10:00.000Z');
    expect(hasFreshMfaSession({
      auth_method: 'oidc', mfa_verified_at: '2026-09-10T12:09:30.000Z', mfa_method: 'amr:mfa',
    }, 600, now)).toBe(true);
    expect(hasFreshMfaSession({
      auth_method: 'oidc', mfa_verified_at: '2026-09-10T11:59:59.000Z', mfa_method: 'amr:mfa',
    }, 600, now)).toBe(false);
    expect(hasFreshMfaSession({
      auth_method: 'local', mfa_verified_at: '2026-09-10T12:09:30.000Z', mfa_method: 'header:mfa',
    }, 600, now)).toBe(false);
    expect(hasFreshMfaSession({
      auth_method: 'oidc', mfa_verified_at: 'not-a-date', mfa_method: 'amr:mfa',
    }, 600, now)).toBe(false);
  });
});
