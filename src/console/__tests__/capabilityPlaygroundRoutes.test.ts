import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../capabilityPlayground.js', () => ({
  CapabilityPlaygroundError: class CapabilityPlaygroundError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
  },
  runCapabilityPlayground: jest.fn(),
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class {
    async isAllowed() { return true; }
    cleanup() { /* no-op */ }
  },
}));

import { writeAdminAudit } from '../../lib/adminAudit.js';
import { runCapabilityPlayground } from '../capabilityPlayground.js';
import { registerConsoleApi } from '../consoleApi.js';

const mockRun = runCapabilityPlayground as jest.MockedFunction<typeof runCapabilityPlayground>;
const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;
const admin: SessionUser = {
  id: 7,
  username: 'admin',
  display_name: 'Admin',
  role: 'platform_admin',
  allowed_bundles: null,
  entra_groups: [],
};

let authenticated = true;
let sameOriginAllowed = true;
let currentUser: SessionUser = admin;
let sameOriginCalls = 0;
let server: Server;
let baseUrl: string;
const pool = {} as pg.Pool;

async function post(body: unknown) {
  const response = await fetch(`${baseUrl}/api/ui/mcp-fabric/capabilities/7/playground`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) {
      res.status(401).json({ error: 'auth' });
      return;
    }
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, res, next) => {
    sameOriginCalls += 1;
    if (!sameOriginAllowed) {
      res.status(403).json({ error: 'origin' });
      return;
    }
    next();
  };
  registerConsoleApi(app, {
    pool,
    requireAuth,
    requireSameOrigin,
    loadStatus: jest.fn(async () => ({})),
    listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined),
    refreshDynamicTools: jest.fn(async () => undefined),
  } as unknown as Parameters<typeof registerConsoleApi>[1]);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
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
  mockRun.mockResolvedValue({
    capability: { id: 'managed:7', name: 'pets__get', enabled: false, isWrite: false, riskLevel: 'low' },
    request: { method: 'GET', target: 'https://api.example.test/pets', headers: {}, body: null },
    executed: true,
    response: {
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      body: '{}',
      truncated: false,
      durationMs: 9,
      authentication: { backendId: 1, mode: 'service-account' },
    },
  });
  mockAudit.mockResolvedValue(73);
});

describe('Capability Playground console route', () => {
  it('enforces authentication before same-origin and service execution', async () => {
    authenticated = false;
    const response = await post({ parameters: {} });
    expect(response.status).toBe(401);
    expect(sameOriginCalls).toBe(0);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('enforces same-origin before platform-admin authorization', async () => {
    sameOriginAllowed = false;
    const response = await post({ parameters: {} });
    expect(response.status).toBe(403);
    expect(sameOriginCalls).toBe(1);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects authenticated users below platform_admin', async () => {
    currentUser = { ...admin, role: 'viewer' };
    const response = await post({ parameters: {} });
    expect(response.status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('passes the numeric route ID and writes metadata-only execution audit state', async () => {
    const request = { parameters: { petId: '42' }, execute: true };
    const response = await post(request);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ executed: true, auditId: 73 }));
    expect(mockRun).toHaveBeenCalledWith(pool, '7', request);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const auditAfterState = mockAudit.mock.calls[0]?.[7];
    expect(auditAfterState).toEqual({
      executed: true,
      write: false,
      status: 200,
      duration_ms: 9,
      truncated: false,
    });
    expect(JSON.stringify(auditAfterState)).not.toContain('petId');
    expect(JSON.stringify(auditAfterState)).not.toContain('https://');
  });
});
