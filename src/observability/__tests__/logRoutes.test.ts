import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { registerLogRoutes } from '../logRoutes.js';

const viewer: SessionUser = {
  id: 17,
  username: 'operator',
  display_name: 'Operator',
  role: 'agent_operator',
  allowed_bundles: [7],
  entra_groups: [],
  workspace_scopes: [
    { tenantKey: 'tenant-a', workspaceKey: 'engineering', isDefault: true },
    { tenantKey: 'tenant-b', workspaceKey: 'operations', isDefault: false },
  ],
};

const query = jest.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes("date_trunc('day'")) {
    return { rows: params?.[0] === 'tenant-a' ? [{ name: '2026-09-14', doc_count: '3' }] : [] };
  }
  if (sql.includes('FROM argus_logs log')) {
    return {
      rows: params?.[0] === 'tenant-a'
        ? [{ id: 1, message: 'tenant-a-only', level: 'info', data: {} }]
        : [],
    };
  }
  return { rows: [] };
});
const pool = { query } as unknown as pg.Pool;
let server: Server;
let baseUrl: string;

async function request(path: string, headers?: Record<string, string>) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: await response.json() as Record<string, unknown>,
  };
}

beforeAll(async () => {
  const app = express();
  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: SessionUser }).user = viewer;
    next();
  };
  registerLogRoutes(app, pool, requireAuth);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
beforeEach(() => { jest.clearAllMocks(); });

describe('workspace-scoped log routes', () => {
  it('scopes both day counts and free-text results to the selected workspace', async () => {
    const defaultIndices = await request('/api/logs/indices');
    expect(defaultIndices.status).toBe(200);
    expect(defaultIndices.cacheControl).toBe('private, no-store');
    expect(defaultIndices.body).toMatchObject({ indices: [{ name: '2026-09-14', doc_count: '3' }] });
    expect(query.mock.calls[0]?.[1]).toEqual(['tenant-a', 'engineering']);

    query.mockClear();
    const other = await request('/api/logs/search?q=tenant-a-only', {
      'x-argus-tenant-key': 'tenant-b',
      'x-argus-workspace-key': 'operations',
    });
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ hits: [], total: '0' });
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain('log.tenant_key = $1');
    expect(sql).toContain('log.workspace_key = $2');
    expect(params).toEqual(['tenant-b', 'operations', '%tenant-a-only%', 200]);
  });

  it('rejects an unassigned selector before querying counts or contents', async () => {
    const result = await request('/api/logs/search?q=secret', {
      'x-argus-tenant-key': 'tenant-z',
      'x-argus-workspace-key': 'private',
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ code: 'WORKSPACE_SCOPE_NOT_FOUND' });
    expect(query).not.toHaveBeenCalled();
  });
});
