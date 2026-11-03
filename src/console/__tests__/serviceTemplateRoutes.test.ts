import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../serviceTemplateCatalog.js', () => {
  class ServiceTemplateCatalogError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
  }
  return {
    ServiceTemplateCatalogError,
    getNativeServiceTemplateCatalog: jest.fn(),
    installNativeServiceTemplate: jest.fn(),
  };
});
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class { async isAllowed() { return true; } cleanup() { /* no-op */ } },
}));

import { writeAdminAudit } from '../../lib/adminAudit.js';
import {
  getNativeServiceTemplateCatalog,
  installNativeServiceTemplate,
  ServiceTemplateCatalogError,
} from '../serviceTemplateCatalog.js';
import { registerConsoleApi } from '../consoleApi.js';

const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin', allowed_bundles: null, entra_groups: [],
};
const catalog = {
  generatedAt: '2026-08-02T12:00:00.000Z',
  categories: [{ id: 'devops', label: 'DevOps', icon: '🔧', templateCount: 1 }],
  templates: [{
    id: 'github', name: 'GitHub', description: 'GitHub connector', icon: '🐙', category: 'devops',
    subcategory: null, tags: ['github'], backendType: 'http' as const, docsUrl: 'https://docs.github.com/en/rest',
    installable: true, unavailableReason: null,
    certification: { level: 'contract' as const, status: 'certified' as const, certifiedCount: 0, totalCount: 0 },
    fields: [], tools: [],
  }],
};
const installResult = {
  input: { templateId: 'github', prefix: 'github_prod', fields: { token: 'super-secret' }, bundleId: 4 },
  result: { backend: { id: 12, name: 'github_prod' }, tools: [{ id: 21, name: 'github_prod_list_repos' }] },
};
const pool = {} as pg.Pool;
const refreshBackends = jest.fn(async () => undefined);
const refreshDynamicTools = jest.fn(async () => undefined);
const mockCatalog = getNativeServiceTemplateCatalog as jest.MockedFunction<typeof getNativeServiceTemplateCatalog>;
const mockInstall = installNativeServiceTemplate as jest.MockedFunction<typeof installNativeServiceTemplate>;
const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;
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
  return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.json() as Record<string, unknown> };
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
    refreshBackends, refreshDynamicTools, publicWidgetEnabled: true,
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
  mockCatalog.mockReturnValue(catalog);
  mockInstall.mockResolvedValue(installResult);
});

describe('native service template routes', () => {
  it('returns uncached catalog metadata only to Platform Admins', async () => {
    const response = await request('/api/ui/mcp-fabric/templates');
    expect(response.status).toBe(200);
    expect(response.cacheControl).toBe('no-store');
    currentUser = { ...admin, role: 'viewer' };
    expect((await request('/api/ui/mcp-fabric/templates')).status).toBe(403);
  });

  it('protects installation with same-origin enforcement', async () => {
    sameOriginAllowed = false;
    expect((await request('/api/ui/mcp-fabric/templates/github/install', 'POST', {})).status).toBe(403);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('refreshes both runtimes and audits no submitted secret fields', async () => {
    const body = { prefix: 'github_prod', fields: { token: 'super-secret' }, bundleId: 4 };
    const response = await request('/api/ui/mcp-fabric/templates/github/install', 'POST', body);
    expect(response.status).toBe(201);
    expect(mockInstall).toHaveBeenCalledWith(pool, 'github', body);
    expect(refreshBackends).toHaveBeenCalled();
    expect(refreshDynamicTools).toHaveBeenCalled();
    const auditCall = mockAudit.mock.calls.at(-1);
    expect(auditCall?.[7]).toEqual({ template_id: 'github', backend_id: 12, bundle_id: 4, capability_count: 1 });
    expect(JSON.stringify([auditCall?.[6], auditCall?.[7]])).not.toContain('super-secret');
  });

  it('maps catalog validation errors without leaking submitted fields', async () => {
    mockInstall.mockRejectedValueOnce(new ServiceTemplateCatalogError('Template installation is blocked', 409));
    const response = await request('/api/ui/mcp-fabric/templates/postgresql/install', 'POST', { fields: { password: 'secret' } });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'Template installation is blocked' });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });
});
