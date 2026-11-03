import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));
jest.mock('../../lib/encryption.js', () => ({
  encrypt: jest.fn((value: string | null) => value == null ? null : 'encrypted-policy-secret'),
  decrypt: jest.fn((value: string | null) => value),
}));
jest.mock('../../backends/customBackends.js', () => ({
  assertEgressAllowed: jest.fn(),
  assertSsrfSafe: jest.fn(),
  assertSsrfSafeResolved: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import {
  createToolFilterAudited,
  deleteToolFilterAudited,
  updateToolFilterAudited,
  type ToolFilterRow,
} from '../toolFilters.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

const row: ToolFilterRow = {
  id: 11,
  name: 'change_freeze',
  description: 'Internal release policy',
  webhook_url: 'https://policy.example.test/decide?token=do-not-audit',
  hmac_secret: 'encrypted-policy-secret',
  timeout_ms: 2500,
  tool_patterns: ['terraform_*'],
  enabled: true,
  on_timeout: 'deny',
  created_at: '2026-09-08T10:00:00.000Z',
  updated_at: '2026-09-08T10:00:00.000Z',
};
const context = {
  producerEventId: 'policy-create-11',
  environment: 'test',
  actor: {
    type: 'human' as const,
    id: '7',
    ssoSubject: null,
    authMethod: 'session',
    effectiveRoles: ['platform_admin'],
  },
  requestId: 'request-policy-11',
};

beforeEach(() => { jest.clearAllMocks(); });

describe('canonical external runtime policy mutations', () => {
  it('creates policy and evidence atomically without URL, description or HMAC material', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockResolvedValue({ rows: [row], rowCount: 1 }),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return {
        event: { ...emitted, producer, eventId: 'event-policy-11', action: emitted['action'] } as never,
        replayed: false,
        result,
      };
    });

    const result = await createToolFilterAudited(pool, {
      name: row.name,
      description: row.description,
      webhook_url: row.webhook_url,
      hmac_secret: 'plain-policy-secret',
      timeout_ms: row.timeout_ms,
      tool_patterns: row.tool_patterns,
      enabled: row.enabled,
      on_timeout: row.on_timeout,
    }, context);

    expect(result).toMatchObject({ value: row, replayed: false });
    expect(emitted).toMatchObject({
      action: 'risk_policy.external_filter.created',
      risk: 'high',
      resource: { type: 'runtime_policy', id: '11' },
      policy: { id: 'argus.external-tool-filter:11', decision: 'deny' },
      payload: {
        before: null,
        after: {
          name: 'change_freeze', hasHmacSecret: true, timeoutMs: 2500,
          toolPatterns: ['terraform_*'], enabled: true, onFailure: 'deny',
        },
        context: { secretMaterial: 'excluded' },
      },
    });
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain('plain-policy-secret');
    expect(serialized).not.toContain('encrypted-policy-secret');
    expect(serialized).not.toContain('do-not-audit');
    expect(serialized).not.toContain('Internal release policy');
  });

  it('locks before an update and preserves the before/after policy decision', async () => {
    const updated = { ...row, enabled: false, updated_at: '2026-09-08T11:00:00.000Z' };
    const client = {
      query: jest.fn<TestQuery>()
        .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return {
        event: { ...emitted, producer, eventId: 'event-policy-update', action: emitted['action'] } as never,
        replayed: false,
        result,
      };
    });

    const result = await updateToolFilterAudited(pool, 11, { enabled: false }, context);

    expect(result.value.enabled).toBe(false);
    expect(String(client.query.mock.calls[0]?.[0])).toMatch(/FOR UPDATE/);
    expect(emitted).toMatchObject({
      action: 'risk_policy.external_filter.updated',
      policy: { decision: 'disabled' },
      payload: { before: { enabled: true }, after: { enabled: false } },
    });
  });

  it('does not issue another delete on replay', async () => {
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    executeMock.mockResolvedValueOnce({
      event: {
        eventId: 'event-policy-delete', action: 'risk_policy.external_filter.deleted',
        resource: { type: 'runtime_policy', id: '11', revision: row.updated_at },
      } as never,
      replayed: true,
      result: null,
    });

    const result = await deleteToolFilterAudited(pool, 11, context);

    expect(result).toMatchObject({ value: null, replayed: true });
    expect(pool.query).not.toHaveBeenCalled();
  });
});
