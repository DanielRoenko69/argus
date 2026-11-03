import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../observability/canaries.js', () => {
  class CanaryConfigurationError extends Error {}
  class CanaryRunConflictError extends Error {}
  return {
    CanaryConfigurationError,
    CanaryRunConflictError,
    getCanaryOperations: jest.fn(),
    loadCanaryConfig: jest.fn(),
    normalizeCanaryRunAgentIds: jest.fn((value: unknown) => value),
    runCanariesNow: jest.fn(),
    saveCanaryConfig: jest.fn(),
  };
});
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class { async isAllowed() { return true; } cleanup() { /* no-op */ } },
}));

import { writeAdminAudit } from '../../lib/adminAudit.js';
import {
  CanaryConfigurationError,
  CanaryRunConflictError,
  getCanaryOperations,
  loadCanaryConfig,
  runCanariesNow,
  saveCanaryConfig,
} from '../../observability/canaries.js';
import { registerConsoleApi } from '../consoleApi.js';

const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin', allowed_bundles: null, entra_groups: [],
};
const config = {
  enabled: true, intervalMinutes: 15, timeoutSeconds: 30, retentionDays: 30, agentIds: [4],
  source: 'database' as const, updatedAt: '2026-08-02T10:00:00.000Z', credentialConfigured: true, targetMode: 'selected' as const,
};
const operations = {
  generatedAt: '2026-08-02T12:00:00.000Z', config,
  state: { status: 'healthy' as const, totalTargets: 1, passingTargets: 1, failingTargets: 0, lastRunAt: '2026-08-02T11:59:00.000Z', nextRunAt: '2026-08-02T12:14:00.000Z', running: false },
  availableAgents: [{ id: 4, name: 'cluster-investigator', label: 'Cluster Investigator' }],
  canaries: [], history: [],
};

const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;
const mockGet = getCanaryOperations as jest.MockedFunction<typeof getCanaryOperations>;
const mockLoadConfig = loadCanaryConfig as jest.MockedFunction<typeof loadCanaryConfig>;
const mockRun = runCanariesNow as jest.MockedFunction<typeof runCanariesNow>;
const mockSave = saveCanaryConfig as jest.MockedFunction<typeof saveCanaryConfig>;
const pool = {} as pg.Pool;
let authenticated = true;
let sameOriginAllowed = true;
let currentUser = admin;
let server: Server;
let baseUrl: string;

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: await response.json() as Record<string, unknown>,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) { res.status(401).json({ error: 'auth' }); return; }
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, res, next) => {
    if (!sameOriginAllowed) { res.status(403).json({ error: 'origin' }); return; }
    next();
  };
  registerConsoleApi(app, {
    pool, requireAuth, requireSameOrigin, loadStatus: jest.fn(async () => ({})), listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined), refreshDynamicTools: jest.fn(async () => undefined), publicWidgetEnabled: true,
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
  sameOriginAllowed = true;
  currentUser = admin;
  mockGet.mockResolvedValue(operations);
  mockLoadConfig.mockResolvedValue(config);
  mockSave.mockResolvedValue(config);
  mockRun.mockResolvedValue([{ agentId: 4, agentName: 'Cluster Investigator', timestamp: '2026-08-02T12:00:00.000Z', status: 'ok', latencyMs: 240 }]);
});

describe('native Synthetic Canary routes', () => {
  it('returns uncached operations only to Platform Admins', async () => {
    const response = await request('/api/ui/observability/canaries');
    expect(response.status).toBe(200);
    expect(response.cacheControl).toBe('no-store');
    currentUser = { ...admin, role: 'viewer' };
    expect((await request('/api/ui/observability/canaries')).status).toBe(403);
  });

  it('protects configuration with same-origin and writes safe audit evidence', async () => {
    sameOriginAllowed = false;
    expect((await request('/api/ui/observability/canaries/config', 'PUT', config)).status).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();
    sameOriginAllowed = true;
    const response = await request('/api/ui/observability/canaries/config', 'PUT', config);
    expect(response.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith(pool, config, admin.id);
    const auditCall = mockAudit.mock.calls.at(-1);
    expect(JSON.stringify([auditCall?.[6], auditCall?.[7]])).not.toContain('api-key-secret');
  });

  it('runs selected targets and audits only a bounded result summary', async () => {
    const response = await request('/api/ui/observability/canaries/run', 'POST', { agentIds: [4] });
    expect(response.status).toBe(200);
    expect(mockRun).toHaveBeenCalledWith(pool, { source: 'manual', triggeredBy: 'admin', agentIds: [4] });
    expect(mockAudit).toHaveBeenCalledWith(
      pool, expect.anything(), 'executed', 'mcp_observability_canary_runs', 'manual', 'Synthetic Canary run', null,
      { agentIds: [4], total: 1, failed: 0 },
    );
  });

  it('maps invalid configuration and concurrent runs to safe client errors', async () => {
    mockSave.mockRejectedValueOnce(new CanaryConfigurationError('invalid interval'));
    expect((await request('/api/ui/observability/canaries/config', 'PUT', config)).status).toBe(400);
    mockRun.mockRejectedValueOnce(new CanaryRunConflictError('already active'));
    expect((await request('/api/ui/observability/canaries/run', 'POST', {})).status).toBe(409);
  });
});
