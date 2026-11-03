import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import {
  createManagedApiKeyAudited,
  deleteManagedApiKeyAudited,
  rotateManagedApiKeyAudited,
  updateManagedApiKeyAudited,
  type ManagedApiKey,
} from '../apiKeyLifecycle.js';
import type { UserLifecycleAuditContext } from '../userLifecycle.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
const context: UserLifecycleAuditContext = {
  producerEventId: 'api-key-request-7',
  environment: 'test',
  actor: { type: 'human', id: '17', authMethod: 'session', effectiveRoles: ['platform_admin'] },
  requestId: 'request-7',
};

type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

function key(overrides: Partial<ManagedApiKey> = {}): ManagedApiKey {
  return {
    id: 7,
    key_prefix: 'ak_old12',
    label: 'deployment bot',
    allowed_bundles: [2],
    allowed_tools: ['github_*'],
    denied_tools: ['github_delete_*'],
    max_requests_per_minute: 60,
    scope: 'mcp',
    key_suffix: 'old4',
    enabled: true,
    acting_as_user_id: null,
    composite_id: null,
    expires_at: null,
    last_used_at: null,
    rotation_schedule: null,
    next_rotation_at: null,
    created_at: '2026-09-08T10:00:00.000Z',
    tenant_key: 'default',
    workspace_key: 'default',
    ...overrides,
  };
}

function poolWithClient(client: { query: jest.MockedFunction<TestQuery> }): pg.Pool {
  return {
    connect: jest.fn<() => Promise<typeof client>>().mockResolvedValue(client),
    query: jest.fn<TestQuery>(),
  } as unknown as pg.Pool;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('canonical API key lifecycle mutations', () => {
  it('creates the credential and emits only safe metadata in the canonical event', async () => {
    const fullKey = 'ak_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const created = key({ key_prefix: fullKey.slice(0, 8), key_suffix: fullKey.slice(-4) });
    const client = { query: jest.fn<TestQuery>().mockResolvedValue({ rows: [created], rowCount: 1 }) };
    const pool = poolWithClient(client);
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, producer, scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { resource: emitted['resource'] } as never, replayed: false, result };
    });

    const result = await createManagedApiKeyAudited(pool, {
      label: 'deployment bot', scope: 'mcp', allowedBundles: [2],
    }, context, () => fullKey);

    expect(result).toMatchObject({ value: created, apiKey: fullKey, replayed: false });
    expect(executeMock).toHaveBeenCalledWith(
      pool,
      { name: 'access.api-keys.create', eventId: 'api-key-request-7' },
      { environment: 'test', workspaceKey: 'default', tenantKey: 'default' },
      expect.any(Function),
      expect.any(Function),
    );
    expect(emitted).toMatchObject({
      action: 'access.api_key.created',
      risk: 'critical',
      resource: { type: 'api_key', id: '7' },
      policy: { id: 'argus.access.api-key-lifecycle', version: '1', decision: 'allow' },
      payload: {
        before: null,
        after: { keyPrefix: fullKey.slice(0, 8), keySuffix: fullKey.slice(-4), scope: 'mcp' },
        context: { plaintextHandling: 'returned_once_and_excluded' },
      },
    });
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain(fullKey);
    expect(serialized).not.toContain('"key_hash"');
    expect(emitted).not.toHaveProperty('api_key');
    const [insertSql, insertParams] = client.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(insertSql).toContain('tenant_key, workspace_key');
    expect(insertParams.slice(-2)).toEqual(['default', 'default']);
  });

  it('binds a new credential to the server-selected non-default workspace', async () => {
    const scopedContext: UserLifecycleAuditContext = {
      ...context,
      producerEventId: 'api-key-request-scoped',
      tenantKey: 'acme',
      workspaceKey: 'payments',
    };
    const created = key({ tenant_key: 'acme', workspace_key: 'payments' });
    const client = { query: jest.fn<TestQuery>().mockResolvedValue({ rows: [created], rowCount: 1 }) };
    const pool = poolWithClient(client);
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      return { event: eventFor(result) as never, replayed: false, result };
    });

    await createManagedApiKeyAudited(pool, { label: 'payments bot', scope: 'mcp' }, scopedContext);

    const [sql, params] = client.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('tenant_key, workspace_key');
    expect(params.slice(-2)).toEqual(['acme', 'payments']);
  });

  it('does not mint or return another secret when a create request is replayed', async () => {
    const pool = poolWithClient({ query: jest.fn<TestQuery>() });
    const createKey = jest.fn(() => 'ak_must_not_be_created');
    executeMock.mockResolvedValueOnce({
      event: { eventId: 'event-7', resource: { type: 'api_key', id: '7', revision: null } } as never,
      replayed: true,
      result: null,
    });

    const result = await createManagedApiKeyAudited(pool, { label: 'bot', scope: 'mcp' }, context, createKey);

    expect(result).toMatchObject({ value: null, apiKey: null, replayed: true });
    expect(createKey).not.toHaveBeenCalled();
    expect((pool.connect as jest.Mock)).not.toHaveBeenCalled();
  });

  it('updates policy metadata with before/after evidence and reconstructs safe replays', async () => {
    const before = key();
    const updated = key({ label: 'renamed bot', enabled: false, allowed_bundles: [3, 4] });
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => Promise.resolve(
        /UPDATE mcp_api_keys/i.test(sql)
          ? { rows: [updated], rowCount: 1 }
          : { rows: [before], rowCount: 1 },
      )),
    };
    const pool = poolWithClient(client);
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { resource: emitted['resource'] } as never, replayed: false, result };
    });

    const result = await updateManagedApiKeyAudited(pool, 7, {
      label: 'renamed bot', scope: 'mcp', enabled: false, allowedBundles: [3, 4],
    }, context);

    expect(result.value).toEqual(updated);
    expect(emitted).toMatchObject({
      action: 'access.api_key.updated',
      payload: {
        before: { label: 'deployment bot', enabled: true, allowedBundles: [2] },
        after: { label: 'renamed bot', enabled: false, allowedBundles: [3, 4] },
      },
    });

    executeMock.mockResolvedValueOnce({
      event: { resource: { type: 'api_key', id: '7', revision: null } } as never,
      replayed: true,
      result: null,
    });
    (pool.query as unknown as jest.MockedFunction<TestQuery>).mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
    const replay = await updateManagedApiKeyAudited(pool, 7, {
      label: 'renamed bot', scope: 'mcp', enabled: false, allowedBundles: [3, 4],
    }, context);
    expect(replay).toMatchObject({ value: updated, replayed: true, apiKey: null });
  });

  it('rotates in the audited transaction without placing either plaintext key in evidence', async () => {
    const fullKey = 'ak_abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const before = key();
    const rotated = key({ key_prefix: fullKey.slice(0, 8), key_suffix: fullKey.slice(-4) });
    let selectCount = 0;
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string, params?: unknown[]) => {
        if (/WITH previous/i.test(sql)) {
          return Promise.resolve({ rows: [{
            id: 7,
            label: before.label,
            key_prefix: params?.[1],
            key_suffix: params?.[3],
            previous_key_prefix: before.key_prefix,
          }], rowCount: 1 });
        }
        selectCount += 1;
        return Promise.resolve({ rows: [selectCount === 1 ? before : rotated], rowCount: 1 });
      }),
    };
    const pool = poolWithClient(client);
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { resource: emitted['resource'] } as never, replayed: false, result };
    });

    const result = await rotateManagedApiKeyAudited(pool, 7, context, () => fullKey);

    expect(result).toMatchObject({ value: rotated, apiKey: fullKey, before, replayed: false });
    expect(emitted).toMatchObject({
      action: 'access.api_key.rotated',
      payload: {
        before: { keyPrefix: before.key_prefix },
        after: { keyPrefix: rotated.key_prefix },
        context: { plaintextHandling: 'returned_once_and_excluded' },
      },
    });
    expect(JSON.stringify(emitted)).not.toContain(fullKey);
  });

  it('deletes under lock and treats an idempotent replay as already revoked', async () => {
    const before = key();
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => Promise.resolve(
        /SELECT/i.test(sql) ? { rows: [before], rowCount: 1 } : { rows: [], rowCount: 1 },
      )),
    };
    const pool = poolWithClient(client);
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { resource: emitted['resource'] } as never, replayed: false, result };
    });

    const result = await deleteManagedApiKeyAudited(pool, 7, context);

    expect(result).toMatchObject({ value: null, before, replayed: false });
    expect(emitted).toMatchObject({
      action: 'access.api_key.deleted',
      payload: { before: { label: 'deployment bot', keyPrefix: 'ak_old12' }, after: null },
    });

    executeMock.mockResolvedValueOnce({
      event: { resource: { type: 'api_key', id: '7', revision: null } } as never,
      replayed: true,
      result: null,
    });
    await expect(deleteManagedApiKeyAudited(pool, 7, context)).resolves.toMatchObject({
      value: null, before: null, replayed: true,
    });
  });
});
