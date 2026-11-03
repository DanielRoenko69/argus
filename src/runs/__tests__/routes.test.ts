import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { registerRunReadModelRoutes, type RunReadModelLoaders } from '../routes.js';
import type { RunSourceRecord } from '../types.js';

const source: RunSourceRecord = {
  id: '42', kind: 'workflow', title: 'Payments workflow', status: 'completed',
  startedAt: '2026-09-07T12:00:00.000Z', updatedAt: '2026-09-07T12:01:00.000Z', durationMs: 60_000,
  traceId: 'trace-42', rootTraceId: 'trace-42', parentTraceId: null,
  parentExecutionId: null, retryOfExecutionId: null, requestedParent: false, staleCandidate: false,
  attentionReason: null, currentPhase: null, resourceRefs: [], evidenceCompleteness: 'missing',
  href: '/runs/workflow/42',
};

let currentUser: SessionUser = {
  id: 7, username: 'viewer', display_name: 'Viewer', role: 'viewer', allowed_bundles: null, entra_groups: [],
};
let authenticated = true;
let server: Server;
let baseUrl: string;

const workflows = jest.fn<RunReadModelLoaders['workflows']>();
const telemetry = jest.fn<RunReadModelLoaders['telemetry']>();
const active = jest.fn<RunReadModelLoaders['active']>();

beforeAll(async () => {
  const app = express();
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) {
      res.status(401).json({ error: 'auth' });
      return;
    }
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  registerRunReadModelRoutes(
    app,
    {} as pg.Pool,
    requireAuth,
    () => [],
    { workflows, telemetry, active },
  );
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  currentUser = {
    id: 7, username: 'viewer', display_name: 'Viewer', role: 'viewer', allowed_bundles: null, entra_groups: [],
  };
  workflows.mockResolvedValue([source]);
  telemetry.mockResolvedValue({ records: [], sessionIds: new Set() });
  active.mockResolvedValue([]);
});

describe('GET /api/ui/runs/v2', () => {
  it('requires authentication and the named run permission', async () => {
    authenticated = false;
    expect((await fetch(`${baseUrl}/api/ui/runs/v2`)).status).toBe(401);
    authenticated = true;
    currentUser = { ...currentUser, role: 'chat_user' };
    expect((await fetch(`${baseUrl}/api/ui/runs/v2`)).status).toBe(403);
    expect(workflows).not.toHaveBeenCalled();
  });

  it('loads only actor-scoped sources for a viewer', async () => {
    const response = await fetch(`${baseUrl}/api/ui/runs/v2?view=root&limit=10`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ schemaVersion: 2, view: 'root', items: [{ id: '42' }] });
    expect(workflows).toHaveBeenCalledWith(
      expect.anything(),
      currentUser,
      false,
      { tenantKey: 'default', workspaceKey: 'default' },
      2160,
      expect.any(Date),
    );
  });

  it('enables workspace-wide authorized loading for an operator', async () => {
    currentUser = { ...currentUser, role: 'agent_operator' };
    const response = await fetch(`${baseUrl}/api/ui/runs/v2`);
    expect(response.status).toBe(200);
    expect(workflows).toHaveBeenCalledWith(
      expect.anything(),
      currentUser,
      true,
      { tenantKey: 'default', workspaceKey: 'default' },
      2160,
      expect.any(Date),
    );
  });

  it('loads a selected secondary membership and forwards one canonical scope to every loader', async () => {
    currentUser = {
      ...currentUser,
      workspace_scopes: [
        { tenantKey: 'default', workspaceKey: 'default', isDefault: true },
        { tenantKey: 'acme', workspaceKey: 'engineering', isDefault: false },
      ],
    };
    const headers = {
      'x-argus-tenant-key': 'acme',
      'x-argus-workspace-key': 'engineering',
    };
    const response = await fetch(`${baseUrl}/api/ui/runs/v2`, { headers });
    expect(response.status).toBe(200);
    const selected = { tenantKey: 'acme', workspaceKey: 'engineering' };
    expect(workflows).toHaveBeenCalledWith(expect.anything(), currentUser, false, selected, 2160, expect.any(Date));
    expect(telemetry).toHaveBeenCalledWith(expect.anything(), currentUser, false, selected, 2160, expect.any(Date));
    expect(active).toHaveBeenCalledWith(expect.anything(), currentUser, false, [], expect.any(Set), selected, expect.any(Date));
  });

  it('returns the same opaque 404 for foreign, partial and malformed selectors before loading data', async () => {
    currentUser = {
      ...currentUser,
      workspace_scopes: [{ tenantKey: 'acme', workspaceKey: 'engineering', isDefault: true }],
    };
    const invalidSelectors: Array<Record<string, string>> = [
      { 'x-argus-tenant-key': 'foreign', 'x-argus-workspace-key': 'engineering' },
      { 'x-argus-tenant-key': 'acme' },
      { 'x-argus-tenant-key': 'bad value', 'x-argus-workspace-key': 'engineering' },
    ];
    for (const headers of invalidSelectors) {
      const response = await fetch(`${baseUrl}/api/ui/runs/v2`, { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Workspace scope was not found.',
        code: 'WORKSPACE_SCOPE_NOT_FOUND',
      });
    }
    expect(workflows).not.toHaveBeenCalled();
    expect(telemetry).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
  });

  it('rejects malformed filters before executing source queries', async () => {
    const response = await fetch(`${baseUrl}/api/ui/runs/v2?tag=all`);
    expect(response.status).toBe(400);
    expect(workflows).not.toHaveBeenCalled();
  });
});
