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

describe('visual workflow child execution evidence', () => {
  it('groups every persisted retry attempt under its parent step and item', async () => {
    const parent = {
      id: 36, workflow_id: 167, status: 'completed', started_at: '2026-08-22T16:00:00.000Z',
      completed_at: '2026-08-22T16:00:01.000Z', duration_ms: 1_000,
      triggered_by: 'builder:Alex', input_args: {}, step_results: {}, error_message: null,
      waiting_approval_id: null, waiting_step_id: null, retry_of_execution_id: null,
      retry_from_step_ids: [], trigger_evidence: {}, trace_id: 'parent-trace', root_trace_id: 'parent-trace',
    };
    const pool = {
      async query(sql: string) {
        if (sql.includes('SELECT id FROM mcp_workflows')) return { rows: [{ id: 167 }] };
        if (sql.includes('WHERE execution.id = $1')) return { rows: [parent] };
        if (sql.includes('WHERE child.parent_execution_id = $1')) return { rows: [
          {
            id: '37', workflow_id: 166, status: 'failed', started_at: '2026-08-22T16:00:00.100Z',
            completed_at: '2026-08-22T16:00:00.300Z', error_message: 'temporary failure',
            parent_step_id: 'foreach', parent_item_index: 1, retry_of_execution_id: null,
            trace_id: 'failed-trace', root_trace_id: 'parent-trace',
          },
          {
            id: '40', workflow_id: 166, status: 'completed', started_at: '2026-08-22T16:01:00.000Z',
            completed_at: '2026-08-22T16:01:00.300Z', error_message: null,
            parent_step_id: 'foreach', parent_item_index: 1, retry_of_execution_id: '37',
            trace_id: 'recovered-trace', root_trace_id: 'parent-trace',
          },
        ] };
        return { rows: [] };
      },
    } as unknown as pg.Pool;

    const app = express();
    registerBuilderRoutes(app, pool, (req: Request, _res: Response, next: () => void) => {
      (req as Request & { user: unknown }).user = { id: 42, role: 'admin', allowed_bundles: null };
      next();
    });
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/workflows/167/runs/36`, {
      headers: { connection: 'close' },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      child_executions: Record<string, Array<Record<string, unknown>>>;
    };
    expect(body.child_executions['foreach']).toEqual([
      expect.objectContaining({ execution_id: 37, parent_item_index: 1, status: 'failed', retry_of_execution_id: null }),
      expect.objectContaining({ execution_id: 40, parent_item_index: 1, status: 'completed', retry_of_execution_id: 37 }),
    ]);
  });
});
