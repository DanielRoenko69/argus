import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { executeArgusCodeIntelligenceTool, isArgusCodeIntelligenceTool } from '../tools.js';

describe('native code intelligence MCP tools', () => {
  it('recognizes only the governed native tool catalog', () => {
    expect(isArgusCodeIntelligenceTool('argus_code_search')).toBe(true);
    expect(isArgusCodeIntelligenceTool('argus_code_request_reindex')).toBe(true);
    expect(isArgusCodeIntelligenceTool('argus_code_drop_index')).toBe(false);
  });

  it('lists only indexes visible through the supplied bundle boundary', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{
      id: 4, repository_key: 'argus/sample', branch_name: 'main', commit_sha: 'a'.repeat(40),
      provider: 'graphify', parser_version: '0.9.32', status: 'ready', file_count: 2,
      symbol_count: 5, edge_count: 3, document_count: 6,
      created_at: '2026-08-14T10:00:00.000Z', finished_at: '2026-08-14T10:00:01.000Z',
    }] }));
    const pool = { query } as unknown as pg.Pool;

    const result = await executeArgusCodeIntelligenceTool(pool, 'argus_code_index_status', {}, [12]);
    const value = JSON.parse(result.content[0]!.text) as { indexes: Array<{ snapshotId: number }> };

    expect(value.indexes[0]!.snapshotId).toBe(4);
    expect(query.mock.calls[0]![1]).toEqual([[12], null, null, null, 20]);
    expect(query.mock.calls[0]![0]).toMatch(/scope\.bundle_id=ANY/);
  });

  it('returns a safe validation error instead of querying an invalid snapshot', async () => {
    const pool = { query: jest.fn() } as unknown as pg.Pool;
    const result = await executeArgusCodeIntelligenceTool(
      pool, 'argus_code_search', { snapshot_id: -1, query: 'x' }, [12],
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid arguments/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('fails closed when reindex is called outside an exact signed Dev workspace', async () => {
    const pool = { query: jest.fn() } as unknown as pg.Pool;
    const result = await executeArgusCodeIntelligenceTool(
      pool, 'argus_code_request_reindex', {}, [12],
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/exact signed Dev workspace/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
