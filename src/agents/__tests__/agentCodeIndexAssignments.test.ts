import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../identity/entra.js', () => ({ EntraSidecarClient: class {} }));
jest.mock('../../identity/blueprint.js', () => ({ resolveBlueprintId: () => null }));
jest.mock('../../lib/encryption.js', () => ({ encrypt: (value: unknown) => value }));
jest.mock('../../config/env.js', () => ({ loadConfig: () => ({ entraAgentRegistration: false }) }));
jest.mock('../../lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('Agent Graphify assignments', () => {
  it('replaces ready snapshot bindings atomically and preserves priority', async () => {
    const query = jest.fn(async (sqlValue: unknown, _parameters?: unknown[]) => ({
      rows: [],
      rowCount: String(sqlValue).includes('INSERT INTO mcp_agent_code_index_snapshots') ? 1 : 0,
    }));
    const release = jest.fn();
    const connect = jest.fn<() => Promise<{ query: typeof query; release: typeof release }>>()
      .mockResolvedValue({ query, release });
    const pool = { connect } as unknown as pg.Pool;
    const { setAgentCodeIndexes } = await import('../agentStore.js');

    await setAgentCodeIndexes(pool, 5, [91, 92]);

    expect(query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN',
      'DELETE FROM mcp_agent_code_index_snapshots WHERE agent_id=$1',
      expect.stringContaining('snapshot.status=\'ready\''),
      expect.stringContaining('snapshot.status=\'ready\''),
      'COMMIT',
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual([5, 91, 0]);
    expect(query.mock.calls[3]?.[1]).toEqual([5, 92, 1]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate snapshot assignments before opening a transaction', async () => {
    const connect = jest.fn();
    const pool = { connect } as unknown as pg.Pool;
    const { setAgentCodeIndexes } = await import('../agentStore.js');

    await expect(setAgentCodeIndexes(pool, 5, [91, 91])).rejects.toThrow('unique');
    expect(connect).not.toHaveBeenCalled();
  });
});
