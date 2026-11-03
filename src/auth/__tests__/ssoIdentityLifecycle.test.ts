import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import {
  buildSsoIdentityAuditContext,
  linkSsoIdentityAudited,
  SsoIdentityLifecycleError,
  ssoGroupSnapshot,
  syncSsoIdentityAudited,
  type SsoIdentityUser,
} from '../ssoIdentityLifecycle.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

const identity = {
  username: 'oidc:issuer:subject-1',
  displayName: 'Alex',
  groups: ['group-b', 'group-a', 'group-a'],
  provider: 'generic',
  mapping: {
    effectiveRole: 'developer' as const,
    matched: [{ group: 'group-a', role: 'developer' as const }],
    usedDefault: false,
  },
};
const context = {
  producerEventId: 'oidc-callback:event-1',
  environment: 'test',
  requestId: 'oidc-request-1',
};
const created: SsoIdentityUser = {
  id: 41,
  username: identity.username,
  display_name: identity.displayName,
  role: 'developer',
  allowed_bundles: null,
  enabled: true,
  created_at: '2026-09-08T10:00:00.000Z',
  last_login: '2026-09-08T10:00:00.000Z',
  entra_groups: ['group-a', 'group-b'],
};

beforeEach(() => { jest.clearAllMocks(); });

describe('canonical SSO identity synchronization', () => {
  it('derives a stable producer key without retaining signed OIDC state', () => {
    const state = 'signed.state.with-sensitive-nonce';
    const expectedDigest = createHash('sha256').update(state).digest('hex');
    const built = buildSsoIdentityAuditContext(state, { environment: 'test' });

    expect(built).toEqual({
      environment: 'test',
      producerEventId: `oidc-callback:${expectedDigest}`,
      requestId: `oidc-callback:${expectedDigest}`,
    });
    expect(JSON.stringify(built)).not.toContain(state);
  });

  it('normalizes group snapshots before hashing', () => {
    expect(ssoGroupSnapshot(['b', 'a', 'a'])).toEqual(ssoGroupSnapshot(['a', 'b']));
  });

  it('provisions a verified SSO user and emits bounded mapping evidence', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        if (/WHERE username=\$1 FOR UPDATE/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
        if (/INSERT INTO mcp_users/i.test(sql)) return Promise.resolve({ rows: [created], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, producer, scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { resource: emitted['resource'] } as never, replayed: false, result };
    });

    const result = await syncSsoIdentityAudited(pool, identity, context);

    expect(result).toMatchObject({ value: created, before: null, replayed: false });
    expect(executeMock).toHaveBeenCalledWith(
      pool,
      { name: 'access.sso-identity.sync', eventId: context.producerEventId },
      { environment: 'test', workspaceKey: 'default', tenantKey: 'default' },
      expect.any(Function),
      expect.any(Function),
    );
    expect(emitted).toMatchObject({
      action: 'access.sso_identity.provisioned',
      risk: 'critical',
      actor: {
        id: '41', ssoSubject: identity.username, authMethod: 'oidc', effectiveRoles: ['developer'],
      },
      policy: { id: 'argus.access.sso-role-mapping', version: '1', decision: 'mapped' },
      payload: {
        before: null,
        after: { role: 'developer', enabled: true, groupSnapshot: { count: 2 } },
        context: {
          provider: 'generic', identitySource: 'verified_oidc_claims', rawClaims: 'excluded',
          mapping: {
            decision: 'mapped', effectiveRole: 'developer',
            matchedMappings: [{ groupDigest: expect.stringMatching(/^[a-f0-9]{64}$/), role: 'developer' }],
          },
        },
      },
    });
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain('group-a');
    expect(serialized).not.toContain('group-b');
    expect(serialized).not.toContain('signed.state');
  });

  it('synchronizes an existing account and rejects disabled identities before update', async () => {
    const previous = { ...created, role: 'viewer', entra_groups: ['old-group'] };
    const activeClient = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        if (/WHERE username=\$1 FOR UPDATE/i.test(sql)) return Promise.resolve({ rows: [previous], rowCount: 1 });
        if (/UPDATE mcp_users/i.test(sql)) return Promise.resolve({ rows: [created], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(activeClient as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { resource: emitted['resource'] } as never, replayed: false, result };
    });
    await syncSsoIdentityAudited(pool, identity, context);
    expect(emitted).toMatchObject({
      action: 'access.sso_identity.synchronized',
      payload: { before: { role: 'viewer' }, after: { role: 'developer' } },
    });

    const disabledClient = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => Promise.resolve(
        /WHERE username=\$1 FOR UPDATE/i.test(sql)
          ? { rows: [{ ...previous, enabled: false }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      )),
    };
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate) => {
      await mutate(disabledClient as unknown as pg.PoolClient);
      throw new Error('unreachable');
    });
    await expect(syncSsoIdentityAudited(pool, identity, context)).rejects.toEqual(
      new SsoIdentityLifecycleError('The SSO account is disabled.', 403, 'SSO_ACCOUNT_DISABLED'),
    );
    expect(disabledClient.query.mock.calls.some(call => /UPDATE mcp_users/i.test(String(call[0])))).toBe(false);
  });

  it('reconstructs replay responses without repeating the identity mutation', async () => {
    const query = jest.fn<TestQuery>().mockResolvedValue({ rows: [created], rowCount: 1 });
    const pool = { query } as unknown as pg.Pool;
    executeMock.mockResolvedValueOnce({
      event: { resource: { type: 'user', id: '41', revision: null } } as never,
      replayed: true,
      result: null,
    });

    const result = await syncSsoIdentityAudited(pool, identity, context);

    expect(result).toMatchObject({ value: created, before: null, replayed: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain('WHERE id=$1');
  });

  it('links a local user in place and invalidates local password access', async () => {
    const local: SsoIdentityUser = {
      ...created,
      id: 7,
      username: 'Alex',
      display_name: 'Alex',
      role: 'platform_admin',
      allowed_bundles: [2, 3],
      entra_groups: [],
    };
    const linked: SsoIdentityUser = { ...created, id: 7, allowed_bundles: [2, 3] };
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        if (/WHERE id=\$1 FOR UPDATE/i.test(sql)) return Promise.resolve({ rows: [local], rowCount: 1 });
        if (/WHERE username=\$1 AND id<>\$2 FOR UPDATE/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
        if (/UPDATE mcp_users/i.test(sql)) return Promise.resolve({ rows: [linked], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, producer, scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { resource: emitted['resource'] } as never, replayed: false, result };
    });

    const result = await linkSsoIdentityAudited(pool, 7, identity, context);

    expect(result.value).toMatchObject({ id: 7, username: identity.username, allowed_bundles: [2, 3] });
    const update = client.query.mock.calls.find(call => /UPDATE mcp_users/i.test(String(call[0])));
    expect(String(update?.[0])).toContain("password_hash='oidc-sso:no-password'");
    expect(emitted).toMatchObject({
      action: 'access.sso_identity.linked',
      risk: 'critical',
      policy: { id: 'argus.access.sso-account-link', decision: 'verified_mfa_link' },
      resource: { type: 'user', id: '7' },
      payload: { context: { localPassword: 'invalidated', rawClaims: 'excluded' } },
    });
  });

  it('refuses to merge an SSO identity already owned by another Argus user', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        if (/WHERE id=\$1 FOR UPDATE/i.test(sql)) return Promise.resolve({ rows: [{ ...created, id: 7, username: 'Alex' }], rowCount: 1 });
        if (/WHERE username=\$1 AND id<>\$2 FOR UPDATE/i.test(sql)) return Promise.resolve({ rows: [{ id: 99 }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate) => {
      await mutate(client as unknown as pg.PoolClient);
      throw new Error('unreachable');
    });

    await expect(linkSsoIdentityAudited(pool, 7, identity, context)).rejects.toMatchObject({
      status: 409,
      code: 'SSO_IDENTITY_CONFLICT',
    });
    expect(client.query.mock.calls.some(call => /UPDATE mcp_users/i.test(String(call[0])))).toBe(false);
  });
});
