import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import { createFirstUserAudited, type UserLifecycleAuditContext } from '../userLifecycle.js';
import type { User } from '../userAuth.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
const context: UserLifecycleAuditContext = {
  producerEventId: 'first-user-1',
  environment: 'test',
  actor: {
    type: 'system', id: 'argus.first-user-bootstrap', authMethod: 'unauthenticated-bootstrap', effectiveRoles: [],
  },
  requestId: 'request-1',
};
const created: User = {
  id: 1,
  username: 'alex',
  display_name: 'Alex',
  role: 'platform_admin',
  allowed_bundles: null,
  enabled: true,
  created_at: '2026-09-08T10:00:00.000Z',
  last_login: null,
};

type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

beforeEach(() => { jest.clearAllMocks(); });

describe('first-user bootstrap canonical mutation', () => {
  it('serializes the empty-table decision and emits critical evidence without credential material', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        if (/SELECT EXISTS/i.test(sql)) return Promise.resolve({ rows: [{ exists: false }], rowCount: 1 });
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

    const result = await createFirstUserAudited(pool, {
      username: 'alex', password: 'Bootstrap-Only-19!', displayName: 'Alex',
    }, context);

    expect(result).toMatchObject({ value: created, replayed: false });
    expect(executeMock).toHaveBeenCalledWith(
      pool,
      { name: 'access.first-user.bootstrap', eventId: 'first-user-1' },
      { environment: 'test', workspaceKey: 'default', tenantKey: 'default' },
      expect.any(Function),
      expect.any(Function),
    );
    expect(client.query.mock.calls.map(call => String(call[0]))).toEqual([
      'LOCK TABLE mcp_users IN SHARE ROW EXCLUSIVE MODE',
      'SELECT EXISTS (SELECT 1 FROM mcp_users) AS exists',
      expect.stringContaining('INSERT INTO mcp_users'),
    ]);
    expect(emitted).toMatchObject({
      action: 'access.first_user.bootstrapped',
      risk: 'critical',
      resource: { type: 'user', id: '1' },
      policy: { id: 'argus.access.first-user-bootstrap', version: '1', decision: 'allow' },
      payload: {
        before: null,
        after: { username: 'alex', role: 'platform_admin', enabled: true },
        context: {
          bootstrapMode: 'first_local_platform_admin',
          initiatorTrust: 'unauthenticated_registration',
        },
      },
    });
    expect(JSON.stringify(emitted)).not.toContain('Bootstrap-Only-19!');
    const insertParams = client.query.mock.calls[2]?.[1] ?? [];
    expect(insertParams[1]).not.toBe('Bootstrap-Only-19!');
  });

  it('fails closed when any user already exists after the table lock', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => Promise.resolve(
        /SELECT EXISTS/i.test(sql)
          ? { rows: [{ exists: true }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      )),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate) => {
      await mutate(client as unknown as pg.PoolClient);
      throw new Error('unreachable');
    });

    await expect(createFirstUserAudited(pool, {
      username: 'second', password: 'Bootstrap-Only-29!', displayName: 'Second',
    }, context)).rejects.toMatchObject({ status: 409, code: 'FIRST_USER_EXISTS' });
    expect(client.query.mock.calls.some(call => /INSERT INTO mcp_users/i.test(String(call[0])))).toBe(false);
  });

  it('reconstructs an idempotent replay without re-running bootstrap mutation', async () => {
    const query = jest.fn<TestQuery>().mockResolvedValue({ rows: [created], rowCount: 1 });
    const pool = { query } as unknown as pg.Pool;
    executeMock.mockResolvedValueOnce({
      event: { resource: { type: 'user', id: '1', revision: null } } as never,
      replayed: true,
      result: null,
    });

    const result = await createFirstUserAudited(pool, {
      username: 'ignored', password: 'Bootstrap-Only-39!', displayName: 'Ignored',
    }, context);

    expect(result).toMatchObject({ value: created, replayed: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain('WHERE id = $1');
  });
});
