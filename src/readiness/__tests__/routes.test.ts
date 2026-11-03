import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { registerPlatformReadinessRoutes } from '../routes.js';

let user: SessionUser = { id: 1, username: 'alex', display_name: 'Alex', role: 'platform_admin', allowed_bundles: null, entra_groups: [] };
let authenticated = true;
let mfaFresh = true;
let server: Server;
let baseUrl: string;
const list = jest.fn<(...args: any[]) => Promise<any[]>>();
const importProof = jest.fn<(...args: any[]) => Promise<any>>();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) return void res.status(401).json({ error: 'auth' });
    (req as unknown as { user: SessionUser }).user = user;
    next();
  };
  registerPlatformReadinessRoutes(app, {} as pg.Pool, requireAuth, {
    environment: 'demo', list, importProof,
    requireSameOrigin: (_req, _res, next) => next(),
    requireFreshMfa: (_req, res, next) => mfaFresh ? next() : void res.status(428).json({ code: 'MFA_STEP_UP_REQUIRED' }),
  });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  authenticated = true;
  mfaFresh = true;
  user = { id: 1, username: 'alex', display_name: 'Alex', role: 'platform_admin', allowed_bundles: null, entra_groups: [] };
  list.mockReset();
  list.mockResolvedValue([]);
  importProof.mockReset();
});

describe('platform readiness execution proof routes', () => {
  it('returns only the authenticated workspace catalog to platform admins', async () => {
    user = { ...user, workspace_scopes: [{ tenantKey: 'tenant-a', workspaceKey: 'workspace-a', isDefault: true }] };
    const response = await fetch(`${baseUrl}/api/ui/platform-readiness/certificates/v1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'platform-execution-certificate-catalog', freshnessDays: 7, certificates: [] });
    expect(list).toHaveBeenCalledWith(expect.anything(), { tenantKey: 'tenant-a', workspaceKey: 'workspace-a', environment: 'demo' });
  });

  it('fails closed for non-admin and forged workspace selectors', async () => {
    user = { ...user, role: 'viewer' };
    expect((await fetch(`${baseUrl}/api/ui/platform-readiness/certificates/v1`)).status).toBe(403);
    user = { ...user, role: 'platform_admin', workspace_scopes: [{ tenantKey: 'tenant-a', workspaceKey: 'workspace-a', isDefault: true }] };
    const forged = await fetch(`${baseUrl}/api/ui/platform-readiness/certificates/v1`, { headers: { 'x-argus-tenant-key': 'tenant-b', 'x-argus-workspace-key': 'workspace-a' } });
    expect(forged.status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  it('requires fresh MFA before parsing or importing a proof', async () => {
    mfaFresh = false;
    const response = await fetch(`${baseUrl}/api/ui/platform-readiness/certificates/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report: {} }),
    });
    expect(response.status).toBe(428);
    expect(importProof).not.toHaveBeenCalled();
  });
});
