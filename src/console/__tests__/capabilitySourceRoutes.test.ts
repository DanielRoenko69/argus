import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../actions/openapi/lifecycle.js', () => ({
  CapabilitySourceError: class CapabilitySourceError extends Error {
    constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
  },
  checkCapabilitySource: jest.fn(),
  listCapabilitySources: jest.fn(),
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class {
    async isAllowed() { return true; }
    cleanup() { /* no-op */ }
  },
}));

import {
  CapabilitySourceError,
  checkCapabilitySource,
  listCapabilitySources,
} from '../../actions/openapi/lifecycle.js';
import { writeAdminAudit } from '../../lib/adminAudit.js';
import { registerConsoleApi } from '../consoleApi.js';

const mockCheck = checkCapabilitySource as jest.MockedFunction<typeof checkCapabilitySource>;
const mockList = listCapabilitySources as jest.MockedFunction<typeof listCapabilitySources>;
const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;
const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin',
  allowed_bundles: null, entra_groups: [],
};

let authenticated = true;
let sameOriginAllowed = true;
let currentUser = admin;
let sameOriginCalls = 0;
let server: Server;
let baseUrl: string;
const pool = {} as pg.Pool;

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
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
    sameOriginCalls++;
    if (!sameOriginAllowed) { res.status(403).json({ error: 'origin' }); return; }
    next();
  };
  registerConsoleApi(app, {
    pool, requireAuth, requireSameOrigin,
    loadStatus: jest.fn(async () => ({})), listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined), refreshDynamicTools: jest.fn(async () => undefined),
  } as unknown as Parameters<typeof registerConsoleApi>[1]);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  sameOriginAllowed = true;
  currentUser = admin;
  sameOriginCalls = 0;
  mockList.mockResolvedValue({ generatedAt: '2026-07-31T10:00:00.000Z', sources: [] });
  mockCheck.mockResolvedValue({
    source: { id: 4, name: 'Pets', prefix: 'pets', sourceKind: 'url' },
    checkedAt: '2026-07-31T10:00:00.000Z', status: 'drifted',
    baseline: { specDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) },
    observed: {
      specDigest: 'c'.repeat(64), manifestDigest: 'd'.repeat(64), title: 'Pets',
      openapiVersion: '3.0.3', baseUrl: 'https://api.example.test/v2',
      auth: { type: 'none', headerName: null },
    },
    diff: {
      added: [], changed: [], removed: [],
      baseUrl: { changed: true, before: 'https://api.example.test/v1', after: 'https://api.example.test/v2' },
      auth: { changed: false, before: { type: 'none', headerName: null }, after: { type: 'none', headerName: null } },
      summary: { added: 1, changed: 2, removed: 3, authChanged: false, baseUrlChanged: true },
    },
  });
});

describe('Capability Source console routes', () => {
  it('enforces authentication and same-origin on list/status', async () => {
    authenticated = false;
    expect((await request('/api/ui/mcp-fabric/capability-sources')).status).toBe(401);
    expect(sameOriginCalls).toBe(0);
    authenticated = true;
    sameOriginAllowed = false;
    expect((await request('/api/ui/mcp-fabric/capability-sources')).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('requires platform_admin and returns the source list contract', async () => {
    currentUser = { ...admin, role: 'viewer' };
    expect((await request('/api/ui/mcp-fabric/capability-sources')).status).toBe(403);
    currentUser = admin;
    const response = await request('/api/ui/mcp-fabric/capability-sources');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ generatedAt: '2026-07-31T10:00:00.000Z', sources: [] });
  });

  it('passes numeric ID/body and audits only safe drift metadata', async () => {
    const body = { specText: 'private spec contents' };
    const response = await request('/api/ui/mcp-fabric/capability-sources/4/check', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(mockCheck).toHaveBeenCalledWith(pool, '4', body);
    const auditState = mockAudit.mock.calls[0]?.[7];
    expect(auditState).toEqual(expect.objectContaining({
      status: 'drifted', added: 1, changed: 2, removed: 3, base_url_changed: true,
    }));
    expect(JSON.stringify(auditState)).not.toContain('private spec');
    expect(JSON.stringify(auditState)).not.toContain('https://');
  });

  it('returns safe known errors and generic internal failures', async () => {
    mockCheck.mockRejectedValueOnce(new CapabilitySourceError('Baseline erforderlich', 409, 'baseline_required'));
    const known = await request('/api/ui/mcp-fabric/capability-sources/4/check', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(known).toEqual({ status: 409, body: { error: 'Baseline erforderlich', code: 'baseline_required' } });

    mockCheck.mockRejectedValueOnce(Object.assign(new Error('postgres secret detail'), { code: '57P01' }));
    const internal = await request('/api/ui/mcp-fabric/capability-sources/4/check', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(internal).toEqual({
      status: 500,
      body: { error: 'Capability Source konnte nicht geprüft werden', code: 'internal_error' },
    });
  });
});
