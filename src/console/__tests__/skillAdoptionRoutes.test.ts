import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../skillAdoption.js', () => ({
  loadSkillAdoption: jest.fn(),
  normalizeSkillAdoptionDays: jest.fn((value: unknown) => {
    if (value == null || value === '') return 30;
    if (!/^\d{1,2}$/.test(String(value)) || Number(value) < 1 || Number(value) > 90) {
      throw new Error('Adoption window must be a whole number from 1 to 90 days');
    }
    return Number(value);
  }),
}));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class { async isAllowed() { return true; } cleanup() { /* no-op */ } },
}));

import { loadSkillAdoption } from '../skillAdoption.js';
import { registerConsoleApi } from '../consoleApi.js';

const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin', allowed_bundles: null, entra_groups: [],
};
const response = {
  generatedAt: '2026-08-02T15:00:00.000Z', windowDays: 30,
  kpis: {
    activeConsumers1d: 1, activeConsumers7d: 2, activeConsumers30d: 3,
    totalSkills: 4, activeSkills: 2, adoptionRate: 50, totalUses: 20,
    averageUsesPerConsumer: 10, p50Ms: 12, p95Ms: 38, errorCount: 0, errorRate: 0,
  },
  bySkill: [], consumers: [{ id: 'runtime-0123abcd', skillFetches: 20, distinctSkills: 2 }],
  timeSeries: [], stale: [], trending: [], heatmap: [],
};

const mockLoad = loadSkillAdoption as jest.MockedFunction<typeof loadSkillAdoption>;
const pool = {} as pg.Pool;
let authenticated = true;
let currentUser = admin;
let server: Server;
let baseUrl: string;

async function request(path: string) {
  const httpResponse = await fetch(`${baseUrl}${path}`);
  return {
    status: httpResponse.status,
    cacheControl: httpResponse.headers.get('cache-control'),
    body: await httpResponse.json() as Record<string, unknown>,
  };
}

beforeAll(async () => {
  const app = express();
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) { res.status(401).json({ error: 'auth' }); return; }
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, _res, next) => next();
  registerConsoleApi(app, {
    pool, requireAuth, requireSameOrigin,
    loadStatus: jest.fn(async () => ({})), listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined), refreshDynamicTools: jest.fn(async () => undefined),
    publicWidgetEnabled: true,
  } as unknown as Parameters<typeof registerConsoleApi>[1]);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  currentUser = admin;
  mockLoad.mockResolvedValue(response);
});

describe('native skill adoption route', () => {
  it('returns no-store analytics to platform administrators', async () => {
    const result = await request('/api/ui/skills/adoption?days=30');
    expect(result.status).toBe(200);
    expect(result.cacheControl).toBe('no-store');
    expect(result.body).toMatchObject({ windowDays: 30, consumers: [{ id: 'runtime-0123abcd' }] });
    expect(mockLoad).toHaveBeenCalledWith(pool, 30);
  });

  it('rejects malformed windows before querying analytics', async () => {
    expect((await request('/api/ui/skills/adoption?days=30days')).status).toBe(400);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('requires authentication and platform-admin access', async () => {
    authenticated = false;
    expect((await request('/api/ui/skills/adoption')).status).toBe(401);
    authenticated = true;
    currentUser = { ...admin, role: 'viewer' };
    expect((await request('/api/ui/skills/adoption')).status).toBe(403);
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
