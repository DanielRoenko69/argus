import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { registerGlobalSearchRoutes } from '../globalSearchRoutes.js';

const viewer: SessionUser = {
  id: 7, username: 'viewer', display_name: 'Viewer', role: 'viewer', allowed_bundles: [4], entra_groups: [],
  workspace_scopes: [
    { tenantKey: 'tenant-a', workspaceKey: 'engineering', isDefault: true },
    { tenantKey: 'tenant-b', workspaceKey: 'operations', isDefault: false },
  ],
};
const query = jest.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
const pool = { query } as unknown as pg.Pool;
let authenticated = true;
let currentUser = viewer;
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
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) { res.status(401).json({ error: 'auth' }); return; }
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  registerGlobalSearchRoutes(app, pool, requireAuth);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  currentUser = viewer;
});

describe('global search route', () => {
  it('returns a bounded resource projection for an authorized user', async () => {
    const result = await request('/api/ui/search/v1?q=planner&limit=3');
    expect(result.status).toBe(200);
    expect(result.cacheControl).toBe('private, no-store');
    expect(result.body).toMatchObject({ schemaVersion: 1, query: 'planner', results: [], truncated: false });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[0]?.[1]).toEqual(['planner', [4], 'tenant-a', 'engineering', 10]);
  });

  it('uses only a server-authorized selected workspace and rejects opaque probes', async () => {
    const selected = await request('/api/ui/search/v1?q=planner', {
      'x-argus-tenant-key': 'tenant-b',
      'x-argus-workspace-key': 'operations',
    });
    expect(selected.status).toBe(200);
    expect(query.mock.calls[0]?.[1]).toEqual(['planner', [4], 'tenant-b', 'operations', 16]);

    query.mockClear();
    const rejected = await request('/api/ui/search/v1?q=planner', {
      'x-argus-tenant-key': 'tenant-z',
      'x-argus-workspace-key': 'secret',
    });
    expect(rejected.status).toBe(404);
    expect(rejected.body).toMatchObject({ code: 'WORKSPACE_SCOPE_NOT_FOUND' });
    expect(query).not.toHaveBeenCalled();
  });

  it('validates input before touching the catalogs', async () => {
    const result = await request('/api/ui/search/v1?q=x');
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'QUERY_TOO_SHORT' });
    expect(query).not.toHaveBeenCalled();
  });

  it('requires authentication and the workspace search permission', async () => {
    authenticated = false;
    expect((await request('/api/ui/search/v1?q=agent')).status).toBe(401);
    authenticated = true;
    currentUser = { ...viewer, role: 'chat_user' };
    const denied = await request('/api/ui/search/v1?q=agent');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'WORKSPACE_SEARCH_FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });
});
