import { afterEach, describe, expect, it } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import { registerBuilderRoutes } from '../builderRoutes.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

/**
 * Pool double that models one workflow bound to Bundle 9 and one run with
 * synthetic input arguments. The visibility query honours the Bundle filter.
 */
function poolFor(workflowBundles: number[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id FROM mcp_workflows')) {
        const callerBundles = (params[3] as number[] | undefined) ?? null;
        const visible = callerBundles === null
          || workflowBundles.length === 0
          || workflowBundles.some(id => callerBundles.includes(id));
        return { rows: visible ? [{ id: 167 }] : [] };
      }
      if (sql.includes('WHERE execution.id = $1')) {
        return { rows: [{
          id: 36, workflow_id: 167, status: 'completed', started_at: '2026-11-02T10:00:00.000Z',
          completed_at: null, duration_ms: 1, triggered_by: 'builder:other', input_args: { secret_input: 'synthetic' },
          step_results: { step: 'synthetic' }, error_message: null, waiting_approval_id: null, waiting_step_id: null,
          retry_of_execution_id: null, retry_from_step_ids: [], trigger_evidence: {}, trace_id: null, root_trace_id: null,
        }] };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

async function get(pool: pg.Pool, user: Record<string, unknown>, path: string) {
  const app = express();
  registerBuilderRoutes(app, pool, (req: Request, _res: Response, next: () => void) => {
    (req as Request & { user: unknown }).user = user;
    next();
  });
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed to bind');
  return fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { connection: 'close' } });
}

describe('workflow run detail Bundle visibility', () => {
  const outsider = { id: 5, username: 'outsider', role: 'developer', allowed_bundles: [2] };

  it('returns 404 on direct detail access when the list would hide the workflow', async () => {
    const { pool, calls } = poolFor([9]);
    const list = await get(pool, outsider, '/api/workflows/167/runs');
    expect(list.status).toBe(404);
    const detail = await get(pool, outsider, '/api/workflows/167/runs/36');
    expect(detail.status).toBe(404);
    expect(JSON.stringify(await detail.json())).not.toContain('synthetic');
    expect(calls.some(call => call.sql.includes('WHERE execution.id = $1'))).toBe(false);
  });

  it('still serves the detail to a caller who shares the workflow Bundle', async () => {
    const { pool, calls } = poolFor([9]);
    const member = { ...outsider, allowed_bundles: [9] };
    const detail = await get(pool, member, '/api/workflows/167/runs/36');
    expect(detail.status).toBe(200);
    const childQuery = calls.find(call => call.sql.includes('WHERE child.parent_execution_id = $1'));
    expect(childQuery?.sql).toContain('wb.workflow_id = child.workflow_id');
    expect(childQuery?.params).toEqual([36, 'default', 'default', [9]]);
  });
});
