import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  createExecution,
  deleteWorkflow,
  getWorkflow,
  loadWorkflows,
  updateWorkflow,
} from '../workflowStore.js';

type QueryResult = { rows: any[]; rowCount?: number };
type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

const scope = { tenantKey: 'tenant-a', workspaceKey: 'engineering' };

describe('workflow store tenant/workspace boundary', () => {
  it('puts list and direct reads behind the exact selected scope', async () => {
    const query = jest.fn<Query>().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as pg.Pool;

    await loadWorkflows(pool, [3, 7], scope);
    await getWorkflow(pool, 42, scope);

    expect(String(query.mock.calls[0]?.[0])).toMatch(/w\.tenant_key = \$1 AND w\.workspace_key = \$2/);
    expect(query.mock.calls[0]?.[1]).toEqual(['tenant-a', 'engineering', [3, 7]]);
    expect(String(query.mock.calls[1]?.[0])).toMatch(/w\.id = \$1 AND w\.tenant_key = \$2 AND w\.workspace_key = \$3/);
    expect(query.mock.calls[1]?.[1]).toEqual([42, 'tenant-a', 'engineering']);
  });

  it('copies only an owned workflow scope into a new execution', async () => {
    const query = jest.fn<Query>().mockResolvedValue({ rows: [{ id: 901 }] });
    const pool = { query } as unknown as pg.Pool;

    await expect(createExecution(pool, 42, 'alex', { issue: 17 }, {}, scope)).resolves.toBe(901);
    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toMatch(/SELECT id, 'running'/);
    expect(String(sql)).toMatch(/tenant_key = \$5 AND workspace_key = \$6/);
    expect(params).toEqual([42, 'alex', JSON.stringify({ issue: 17 }), '{}', 'tenant-a', 'engineering']);
  });

  it('does not mutate bundle links when the workflow id belongs to another scope', async () => {
    const clientQuery = jest.fn<Query>().mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (/UPDATE mcp_workflows/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [] };
    });
    const release = jest.fn();
    const pool = { connect: async () => ({ query: clientQuery, release }) } as unknown as pg.Pool;

    await expect(updateWorkflow(pool, 42, { description: 'foreign', bundle_ids: [9] }, scope)).resolves.toBeNull();
    expect(clientQuery.mock.calls.some(([sql]) => /DELETE FROM mcp_workflow_bundles/.test(String(sql)))).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalled();
  });

  it('makes delete ownership part of the SQL predicate', async () => {
    const query = jest.fn<Query>().mockResolvedValue({ rows: [], rowCount: 0 });
    const pool = { query } as unknown as pg.Pool;

    await expect(deleteWorkflow(pool, 42, scope)).resolves.toBe(false);
    expect(String(query.mock.calls[0]?.[0])).toMatch(/tenant_key = \$2 AND workspace_key = \$3/);
    expect(query.mock.calls[0]?.[1]).toEqual([42, 'tenant-a', 'engineering']);
  });
});
