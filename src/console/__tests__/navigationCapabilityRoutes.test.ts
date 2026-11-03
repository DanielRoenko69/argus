import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { Config } from '../../config/env.js';
import type { SessionUser } from '../../auth/userAuth.js';
import { registerConsoleApi } from '../consoleApi.js';

const developer: SessionUser = {
  id: 17,
  username: 'alex',
  display_name: 'Alex',
  role: 'developer',
  allowed_bundles: null,
  entra_groups: ['argus-developers'],
};

let authenticated = true;
let currentUser = developer;
let server: Server;
let baseUrl: string;

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
  registerConsoleApi(app, {
    pool: {} as pg.Pool,
    config: {
      solutionPackEndpoints: [
        { packId: 'argus.dev', endpoint: 'http://argus-dev:3001' },
        { packId: 'unrelated.pack', endpoint: 'http://other-pack:3002' },
      ],
    } as Config,
    requireAuth,
    requireSameOrigin: ((_req, _res, next) => next()) as RequestHandler,
    loadStatus: async () => ({}) as never,
    listActiveSessions: () => [],
    refreshBackends: async () => undefined,
    refreshDynamicTools: async () => undefined,
    publicWidgetEnabled: false,
  });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  authenticated = true;
  currentUser = developer;
});

describe('GET /api/ui/navigation-capabilities', () => {
  it('requires an authenticated session', async () => {
    authenticated = false;
    expect((await fetch(`${baseUrl}/api/ui/navigation-capabilities`)).status).toBe(401);
  });

  it('returns permission and module facts without leaking SSO group IDs', async () => {
    const response = await fetch(`${baseUrl}/api/ui/navigation-capabilities`);
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      schemaVersion: 1,
      actor: { id: 17, role: 'developer' },
      navigation: { canUseArgusDev: true, canBuildWorkflows: true, canAdminPlatform: false },
    });
    expect(body['permissions']).toEqual(expect.arrayContaining(['agents.run', 'workflows.manage']));
    expect(body['modules']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'argus.dev', installed: true, entitled: true, available: true }),
      expect.objectContaining({ id: 'argus.hermes', installed: false, available: false }),
    ]));
    expect(JSON.stringify(body)).not.toContain('argus-developers');
    expect(JSON.stringify(body)).not.toContain('unrelated.pack');
  });

  it('normalizes legacy admin permissions while retaining the raw actor role for diagnostics', async () => {
    currentUser = { ...developer, role: 'admin' };
    const response = await fetch(`${baseUrl}/api/ui/navigation-capabilities`);
    const body = await response.json() as { actor: { role: string }; navigation: { canAdminPlatform: boolean } };
    expect(response.status).toBe(200);
    expect(body.actor.role).toBe('admin');
    expect(body.navigation.canAdminPlatform).toBe(true);
  });
});
