/**
 * Unit tests for the agent-rule CRUD helpers and fetchUserAgentPolicyData.
 * Uses a mock pool — no live DB required.
 *
 * Mirrors the style of existing tool-rule tests but tests the agent variants.
 */

import type pg from 'pg';

// ── Mock pool factory ─────────────────────────────────────────

type QueryResult = { rows: unknown[]; rowCount: number };

/**
 * Creates a mock pg.Pool whose query() call sequence can be scripted
 * by providing an ordered list of return values.
 */
function makeSequentialPool(responses: QueryResult[]): pg.Pool {
  let call = 0;
  const client = {
    query: jest.fn().mockImplementation(() => {
      const r = responses[call++] ?? { rows: [], rowCount: 0 };
      return Promise.resolve(r);
    }),
    release: jest.fn(),
  };
  return {
    query: jest.fn().mockImplementation(() => {
      const r = responses[call++] ?? { rows: [], rowCount: 0 };
      return Promise.resolve(r);
    }),
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as pg.Pool;
}

function makePool(rows: unknown[] = []): pg.Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    connect: jest.fn(),
  } as unknown as pg.Pool;
}

// ── Tests ─────────────────────────────────────────────────────

describe('getUserAgentRules', () => {
  it('returns mapped agent_id+effect rows for user', async () => {
    const dbRows = [
      { agent_id: 3, effect: 'allow' },
      { agent_id: 7, effect: 'deny' },
    ];
    const pool = makePool(dbRows);
    const { getUserAgentRules } = await import('../userPolicyStore.js');

    const result = await getUserAgentRules(pool, 42);
    expect(result).toEqual([
      { agent_id: 3, effect: 'allow' },
      { agent_id: 7, effect: 'deny' },
    ]);

    const call = (pool.query as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(call[1]).toContain(42); // userId bound
  });

  it('returns empty array when no rules exist', async () => {
    const pool = makePool([]);
    const { getUserAgentRules } = await import('../userPolicyStore.js');
    const result = await getUserAgentRules(pool, 1);
    expect(result).toEqual([]);
  });
});

describe('setUserAgentAllow', () => {
  it('executes BEGIN / DELETE allow-rows / INSERT new / COMMIT in a transaction', async () => {
    // Sequence: BEGIN, lock user, snapshot allows, DELETE, INSERT, INSERT, COMMIT
    const responses: QueryResult[] = [
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [{ id: 10 }], rowCount: 1 }, // target user
      { rows: [{ agent_id: 3 }], rowCount: 1 }, // before snapshot
      { rows: [], rowCount: 1 }, // DELETE
      { rows: [], rowCount: 1 }, // INSERT agent 5
      { rows: [], rowCount: 1 }, // INSERT agent 9
      { rows: [], rowCount: 0 }, // COMMIT
    ];
    const pool = makeSequentialPool(responses);
    const { setUserAgentAllow } = await import('../userPolicyStore.js');

    await setUserAgentAllow(pool, 10, [5, 9], 'admin');

    const client = await (pool.connect as jest.Mock).mock.results[0].value;
    const calls = (client.query as jest.Mock).mock.calls as [string, unknown[]][];
    expect(calls[0][0]).toMatch(/BEGIN/i);
    expect(calls[1][0]).toMatch(/mcp_users.*FOR UPDATE/i);
    expect(calls[2][0]).toMatch(/SELECT agent_id.*mcp_user_agent_rules/i);
    // DELETE only allow rows (deny rows untouched)
    expect(calls[3][0]).toMatch(/DELETE.*mcp_user_agent_rules/i);
    expect(calls[3][0]).toMatch(/effect.*=.*'allow'/i);
    // INSERTs
    expect(calls[4][0]).toMatch(/INSERT.*mcp_user_agent_rules/i);
    expect(calls[5][0]).toMatch(/INSERT.*mcp_user_agent_rules/i);
    expect(calls[6][0]).toMatch(/COMMIT/i);
  });

  it('rolls back on error', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error('db fail')), // DELETE fails
      release: jest.fn(),
    };
    const pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(),
    } as unknown as pg.Pool;

    const { setUserAgentAllow } = await import('../userPolicyStore.js');
    await expect(setUserAgentAllow(pool, 1, [5])).rejects.toThrow('db fail');

    // ROLLBACK must have been called
    const calls = (client.query as jest.Mock).mock.calls as [string][];
    expect(calls.some(c => /ROLLBACK/i.test(c[0]))).toBe(true);
  });
});

describe('getGroupAgentRules', () => {
  it('returns agent_id+effect rows for group', async () => {
    const dbRows = [{ agent_id: 2, effect: 'allow' }];
    const pool = makePool(dbRows);
    const { getGroupAgentRules } = await import('../userPolicyStore.js');

    const result = await getGroupAgentRules(pool, 'ops-team');
    expect(result).toEqual([{ agent_id: 2, effect: 'allow' }]);

    const call = (pool.query as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(call[1]).toContain('ops-team');
  });
});

describe('setGroupAgentAllow', () => {
  it('executes BEGIN / DELETE allow-rows / INSERT / COMMIT', async () => {
    const responses: QueryResult[] = [
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [{ agent_id: 3 }], rowCount: 1 }, // before snapshot
      { rows: [], rowCount: 1 }, // DELETE
      { rows: [], rowCount: 1 }, // INSERT
      { rows: [], rowCount: 0 }, // COMMIT
    ];
    const pool = makeSequentialPool(responses);
    const { setGroupAgentAllow } = await import('../userPolicyStore.js');

    await setGroupAgentAllow(pool, 'devs', [12]);

    const client = await (pool.connect as jest.Mock).mock.results[0].value;
    const calls = (client.query as jest.Mock).mock.calls as [string, unknown[]][];
    expect(calls[0][0]).toMatch(/BEGIN/i);
    expect(calls[1][0]).toMatch(/SELECT agent_id.*mcp_group_agent_rules/i);
    expect(calls[2][0]).toMatch(/DELETE.*mcp_group_agent_rules/i);
    expect(calls[2][0]).toMatch(/effect.*=.*'allow'/i);
    expect(calls[3][0]).toMatch(/INSERT.*mcp_group_agent_rules/i);
    expect(calls[4][0]).toMatch(/COMMIT/i);
  });
});

describe('fetchUserAgentPolicyData', () => {
  it('aggregates user+group allow/deny sets (non-expired)', async () => {
    // pool.query is called twice in parallel: user rules + group rules
    let callCount = 0;
    const pool = {
      query: jest.fn().mockImplementation((_sql: string, _params: unknown[]) => {
        callCount++;
        if (callCount === 1) {
          // user rules: one allow (not expired), one deny
          return Promise.resolve({
            rows: [
              { agent_id: 5, effect: 'allow' },
              { agent_id: 9, effect: 'deny' },
            ],
            rowCount: 2,
          });
        }
        // group rules: one allow
        return Promise.resolve({
          rows: [{ agent_id: 7, effect: 'allow' }],
          rowCount: 1,
        });
      }),
    } as unknown as pg.Pool;

    const { fetchUserAgentPolicyData } = await import('../userPolicyStore.js');
    const result = await fetchUserAgentPolicyData(pool, 1, ['ops-team']);

    expect(result.agentAllowIds).toEqual(new Set([5, 7]));
    expect(result.agentDenyIds).toEqual(new Set([9]));
  });

  it('uses sentinel for empty groups list (ANY() safety)', async () => {
    const pool = makePool([]);
    const { fetchUserAgentPolicyData } = await import('../userPolicyStore.js');
    await fetchUserAgentPolicyData(pool, 1, []);

    // Both queries should have been issued
    expect((pool.query as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty sets when no rules exist', async () => {
    const pool = makePool([]);
    const { fetchUserAgentPolicyData } = await import('../userPolicyStore.js');
    const result = await fetchUserAgentPolicyData(pool, 1, []);
    expect(result.agentAllowIds.size).toBe(0);
    expect(result.agentDenyIds.size).toBe(0);
  });
});
