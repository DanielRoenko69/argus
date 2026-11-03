import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import {
  AccessPolicyError,
  addGroupToolRuleAudited,
  deleteUserToolRuleAudited,
  setGroupCompositesAudited,
  setUserAgentAllowAudited,
  type AccessPolicyAuditContext,
} from '../userPolicyStore.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
const context: AccessPolicyAuditContext = {
  producerEventId: 'policy-request-7',
  environment: 'test',
  actor: { type: 'human', id: '17', authMethod: 'session', effectiveRoles: ['platform_admin'] },
  requestId: 'request-7',
};

type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

function poolWithClient(client: { query: jest.MockedFunction<TestQuery> }): pg.Pool {
  return {
    connect: jest.fn<() => Promise<typeof client>>().mockResolvedValue(client),
    query: jest.fn<TestQuery>(),
  } as unknown as pg.Pool;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('canonical access policy mutations', () => {
  it('atomically replaces a user allow-list, preserves deny rows and emits bounded evidence', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        if (/FROM mcp_users/i.test(sql)) return Promise.resolve({ rows: [{ id: 10 }], rowCount: 1 });
        if (/SELECT agent_id FROM mcp_user_agent_rules/i.test(sql)) {
          return Promise.resolve({ rows: [{ agent_id: 7 }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }),
    };
    const pool = poolWithClient(client);
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, producer, scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return {
        event: { resource: (emitted['resource'] as object) } as never,
        replayed: false,
        result,
      };
    });

    const result = await setUserAgentAllowAudited(pool, 10, [9, 5, 9], 'admin:alex', context);

    expect(result.value).toEqual([5, 9]);
    expect(executeMock).toHaveBeenCalledWith(
      pool,
      { name: 'access.policies.user-agent-allow.replace', eventId: 'policy-request-7' },
      { environment: 'test', workspaceKey: 'default', tenantKey: 'default' },
      expect.any(Function),
      expect.any(Function),
    );
    expect(emitted).toMatchObject({
      action: 'access.user_agent_allow.replaced',
      risk: 'critical',
      resource: { type: 'user_access_policy', id: '10' },
      policy: { id: 'argus.access.policy-management', version: '1', decision: 'allow' },
      payload: {
        before: { agentIds: [7] },
        after: { agentIds: [5, 9] },
        context: { denyRulesPreserved: true },
      },
    });
    const deleteSql = client.query.mock.calls
      .map(call => String(call[0]))
      .find(sql => /DELETE FROM mcp_user_agent_rules/i.test(sql));
    expect(deleteSql).toMatch(/effect = 'allow'/i);
  });

  it('normalizes group identity and composite IDs before committing evidence', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        if (/SELECT composite_id/i.test(sql)) {
          return Promise.resolve({ rows: [{ composite_id: 2 }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }),
    };
    const pool = poolWithClient(client);
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { resource: emitted['resource'] } as never, replayed: false, result };
    });

    const result = await setGroupCompositesAudited(pool, '  engineering  ', [8, 3, 8], context);

    expect(result.value).toEqual([3, 8]);
    expect(emitted).toMatchObject({
      action: 'access.group_composites.replaced',
      resource: { type: 'group_access_policy', id: 'engineering' },
      payload: { before: { compositeIds: [2] }, after: { compositeIds: [3, 8] } },
    });
  });

  it('reconstructs a created rule ID from canonical evidence without repeating the mutation', async () => {
    const pool = poolWithClient({ query: jest.fn<TestQuery>() });
    executeMock.mockResolvedValueOnce({
      event: { resource: { type: 'group_tool_rule', id: '77', revision: null } } as never,
      replayed: true,
      result: null,
    });

    const result = await addGroupToolRuleAudited(
      pool, 'engineering', { tool_pattern: 'github_*', effect: 'allow' }, context,
    );

    expect(result).toMatchObject({ value: 77, replayed: true });
    expect((pool.connect as jest.Mock)).not.toHaveBeenCalled();
  });

  it('fails closed when a deleted user tool rule does not exist', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    const pool = poolWithClient(client);
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate) => {
      await mutate(client as unknown as pg.PoolClient);
      throw new Error('unreachable');
    });

    await expect(deleteUserToolRuleAudited(pool, 404, context)).rejects.toMatchObject({
      name: 'AccessPolicyError', status: 404, code: 'USER_TOOL_RULE_NOT_FOUND',
    } satisfies Partial<AccessPolicyError>);
  });
});
