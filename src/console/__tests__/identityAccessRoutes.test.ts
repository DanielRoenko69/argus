import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class { async isAllowed() { return true; } cleanup() { /* no-op */ } },
}));

import { registerConsoleApi } from '../consoleApi.js';

const query = jest.fn(async (sql: string) => {
  if (sql.includes("backend.config ? 'sso_portal'")) return { rows: [
    {
      id: 11,
      name: 'gitea-local',
      bundle_ids: [2],
      sso_portal: {
        mode: 'shared_oidc',
        application: 'Gitea',
        label: 'Open repository with SSO',
        launch_url: 'http://localhost:3005/user/oauth2/argus-mfa-demo',
        provider_name: 'Argus MFA Demo',
        presentation_role: 'Source code and pull requests',
      },
    },
    {
      id: 12,
      name: 'gitea-secondary',
      bundle_ids: [2],
      sso_portal: {
      mode: 'shared_oidc',
      application: 'Gitea',
      label: 'Open repository with SSO',
      launch_url: 'http://localhost:3005/user/oauth2/argus-mfa-demo',
      provider_name: 'Argus MFA Demo',
      presentation_role: 'Source code and pull requests',
      },
    },
  ] };
  if (sql.includes("action = 'backend_sso_launched'")) return { rows: [
    { id: '91', object_id: '11', created_at: '2026-09-15T00:05:00.000Z' },
    { id: '92', object_id: '12', created_at: '2026-09-15T00:06:00.000Z' },
  ] };
  throw new Error(`Unexpected query: ${sql}`);
});
const pool = { query } as unknown as pg.Pool;
const oidcUser: SessionUser = {
  id: 7,
  username: 'oidc:alex',
  display_name: 'Alex',
  role: 'developer',
  allowed_bundles: [2],
  entra_groups: [],
  auth_method: 'oidc',
  mfa_verified_at: new Date().toISOString(),
  mfa_method: 'otp',
};
let authenticated = true;
let currentUser = oidcUser;
let server: Server;
let baseUrl: string;

async function request() {
  const response = await fetch(`${baseUrl}/api/ui/identity-access/workforce`);
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
  registerConsoleApi(app, {
    pool,
    requireAuth,
    requireSameOrigin: ((_req, _res, next) => next()) as RequestHandler,
    loadStatus: jest.fn(async () => ({})),
    listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined),
    refreshDynamicTools: jest.fn(async () => undefined),
    publicWidgetEnabled: true,
    config: {
      backendSsoEnabled: true,
      oidcSsoEnabled: true,
      entraSsoEnabled: false,
      oidcProviderName: 'Argus MFA Demo',
      oidcMfaMaxAgeSeconds: 900,
    },
  } as unknown as Parameters<typeof registerConsoleApi>[1]);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  authenticated = true;
  currentUser = oidcUser;
  query.mockClear();
});

describe('workforce identity access route', () => {
  it('returns a fast identity-scoped portal catalog with MFA and audit evidence', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.cacheControl).toContain('no-store');
    expect(response.body).toMatchObject({
      provider: { enabled: true, name: 'Argus MFA Demo' },
      session: { authMethod: 'oidc', mfaFresh: true, mfaMethod: 'otp' },
      entitlement: { enabled: true, name: 'Workforce SSO' },
      stats: { available: 1, ready: 1, launched: 1, configuredBackends: 2 },
      portals: [{
        backendId: 11,
        backendIds: [11, 12],
        backendNames: ['gitea-local', 'gitea-secondary'],
        connectionCount: 2,
        application: 'Gitea',
        state: 'ready',
        launchPath: '/api/ui/mcp-fabric/connections/11/sso-launch',
        lastLaunch: { auditId: 92, launchedAt: '2026-09-15T00:06:00.000Z' },
      }],
    });
  });

  it('filters portals outside the caller bundle scope and fails closed without auth', async () => {
    currentUser = { ...oidcUser, allowed_bundles: [99] };
    expect((await request()).body).toMatchObject({ stats: { available: 0 }, portals: [] });
    authenticated = false;
    expect((await request()).status).toBe(401);
  });
});
