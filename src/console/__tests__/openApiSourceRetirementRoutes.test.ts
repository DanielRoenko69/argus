import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../actions/openapi/retirement.js', () => ({
  OpenApiSourceRetirementError: class OpenApiSourceRetirementError extends Error {
    constructor(message: string, readonly status = 400, readonly code = 'invalid_request') {
      super(message);
    }
  },
  previewOpenApiSourceRetirement: jest.fn(),
  retireOpenApiSource: jest.fn(),
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class {
    async isAllowed() { return true; }
    cleanup() { /* no-op */ }
  },
}));
jest.mock('../../lib/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  OpenApiSourceRetirementError,
  previewOpenApiSourceRetirement,
  retireOpenApiSource,
  type OpenApiSourceRetirementPreview,
  type OpenApiSourceRetirementResult,
} from '../../actions/openapi/retirement.js';
import { writeAdminAudit } from '../../lib/adminAudit.js';
import { registerConsoleApi } from '../consoleApi.js';

const mockPreview = previewOpenApiSourceRetirement as jest.MockedFunction<typeof previewOpenApiSourceRetirement>;
const mockRetire = retireOpenApiSource as jest.MockedFunction<typeof retireOpenApiSource>;
const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;

const admin: SessionUser = {
  id: 7,
  username: 'admin',
  display_name: 'Admin',
  role: 'platform_admin',
  allowed_bundles: null,
  entra_groups: [],
};
const preview: OpenApiSourceRetirementPreview = {
  source: {
    id: 4,
    name: 'Pets API',
    prefix: 'pets',
    revision: '12',
    manifestDigest: 'a'.repeat(64),
    operationCount: 2,
  },
  backend: { id: 17, name: 'pets', enabled: false },
  impact: {
    capabilities: [{
      id: 31,
      name: 'pets__getpets',
      isWrite: false,
      enabled: false,
      bundleIds: [8],
      workflowCount: 1,
    }],
    bundles: [{
      id: 8,
      name: 'pets',
      label: 'Pets',
      connectionAssigned: true,
      capabilityIds: [31],
      capabilityNames: ['pets__getpets'],
    }],
    workflows: [{ id: 44, name: 'Pet report', capabilityNames: ['pets__getpets'] }],
  },
  confirmation: {
    expectedPrefix: 'pets',
    expectedRevision: '12',
    expectedManifestDigest: 'a'.repeat(64),
    expectedImpactDigest: 'b'.repeat(64),
  },
};
const retirement: OpenApiSourceRetirementResult = {
  sourceId: 4,
  backendId: 17,
  prefix: 'pets',
  deletedCapabilities: [{ id: 31, name: 'pets__getpets' }],
  deletedCapabilityCount: 1,
  preservedBundleIds: [8],
  preservedWorkflowIds: [44],
  retiredAt: '2026-07-31T12:00:00.000Z',
};

let authenticated = true;
let sameOriginAllowed = true;
let currentUser = admin;
let sameOriginCalls = 0;
let server: Server;
let baseUrl: string;
const pool = {} as pg.Pool;
const refreshBackends = jest.fn(async () => undefined);
const refreshDynamicTools = jest.fn(async () => undefined);

async function request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
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
    sameOriginCalls++;
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
    refreshBackends,
    refreshDynamicTools,
  } as unknown as Parameters<typeof registerConsoleApi>[1]);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
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
  mockPreview.mockResolvedValue(preview);
  mockRetire.mockResolvedValue(retirement);
  refreshBackends.mockResolvedValue(undefined);
  refreshDynamicTools.mockResolvedValue(undefined);
});

describe('OpenAPI source retirement console routes', () => {
  it.each([
    ['preview', 'GET' as const, '/api/ui/mcp-fabric/capability-sources/4/retirement', undefined],
    ['retire', 'POST' as const, '/api/ui/mcp-fabric/capability-sources/4/retire', preview.confirmation],
  ])('enforces authentication, same-origin and platform admin for %s', async (_label, method, path, body) => {
    authenticated = false;
    expect((await request(path, method, body)).status).toBe(401);
    expect(sameOriginCalls).toBe(0);

    authenticated = true;
    sameOriginAllowed = false;
    expect((await request(path, method, body)).status).toBe(403);

    sameOriginAllowed = true;
    currentUser = { ...admin, role: 'viewer' };
    expect((await request(path, method, body)).status).toBe(403);
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockRetire).not.toHaveBeenCalled();
  });

  it('returns the retirement preview contract and delegates the string route ID', async () => {
    const response = await request('/api/ui/mcp-fabric/capability-sources/4/retirement');

    expect(response).toEqual({ status: 200, body: preview });
    expect(mockPreview).toHaveBeenCalledWith(pool, '4');
    expect(mockRetire).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('delegates confirmed retirement, refreshes runtimes and writes only safe audit metadata', async () => {
    const confirmation = { ...preview.confirmation };
    const response = await request('/api/ui/mcp-fabric/capability-sources/4/retire', 'POST', confirmation);

    expect(response).toEqual({ status: 200, body: { ...retirement, warnings: [] } });
    expect(mockRetire).toHaveBeenCalledWith(pool, '4', confirmation);
    expect(refreshBackends).toHaveBeenCalledTimes(1);
    expect(refreshDynamicTools).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0]?.slice(2, 7)).toEqual([
      'retired',
      'capability_source',
      '4',
      'pets',
      null,
    ]);
    const auditState = mockAudit.mock.calls[0]?.[7];
    expect(auditState).toEqual({
      backend_id: 17,
      deleted_capability_count: 1,
      deleted_capability_ids: [31],
      deleted_capability_names: ['pets__getpets'],
      preserved_bundle_ids: [8],
      preserved_workflow_ids: [44],
    });
    expect(JSON.stringify(auditState)).not.toContain(preview.confirmation.expectedManifestDigest);
    expect(JSON.stringify(auditState)).not.toMatch(/credential|auth_value|spec(?:Text|ification)/i);
  });

  it('returns known preview and retirement error status/code pairs', async () => {
    mockPreview.mockRejectedValueOnce(new OpenApiSourceRetirementError(
      'Capability Source wurde nicht gefunden',
      404,
      'not_found',
    ));
    const previewResponse = await request('/api/ui/mcp-fabric/capability-sources/99/retirement');
    expect(previewResponse).toEqual({
      status: 404,
      body: { error: 'Capability Source wurde nicht gefunden', code: 'not_found' },
    });

    mockRetire.mockRejectedValueOnce(new OpenApiSourceRetirementError(
      'Retirement-Impact wurde verändert',
      409,
      'impact_changed',
    ));
    const retireResponse = await request(
      '/api/ui/mcp-fabric/capability-sources/4/retire',
      'POST',
      preview.confirmation,
    );
    expect(retireResponse).toEqual({
      status: 409,
      body: { error: 'Retirement-Impact wurde verändert', code: 'impact_changed' },
    });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('masks unexpected preview and retirement failures', async () => {
    mockPreview.mockRejectedValueOnce(new Error('postgres credential=secret preview detail'));
    const previewResponse = await request('/api/ui/mcp-fabric/capability-sources/4/retirement');
    expect(previewResponse).toEqual({
      status: 500,
      body: { error: 'Retirement-Vorschau konnte nicht erstellt werden', code: 'internal_error' },
    });

    mockRetire.mockRejectedValueOnce(new Error('raw OpenAPI spec and token detail'));
    const retireResponse = await request(
      '/api/ui/mcp-fabric/capability-sources/4/retire',
      'POST',
      preview.confirmation,
    );
    expect(retireResponse).toEqual({
      status: 500,
      body: { error: 'Capability Source konnte nicht stillgelegt werden', code: 'internal_error' },
    });
    expect(JSON.stringify([previewResponse.body, retireResponse.body])).not.toMatch(/credential=|OpenAPI spec|token detail/);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('returns independent refresh warnings after a successful retirement', async () => {
    refreshBackends.mockRejectedValueOnce(new Error('backend refresh failed'));
    refreshDynamicTools.mockRejectedValueOnce(new Error('tool refresh failed'));

    const response = await request(
      '/api/ui/mcp-fabric/capability-sources/4/retire',
      'POST',
      preview.confirmation,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ...retirement,
      warnings: [
        'Connection cache could not be refreshed immediately',
        'Capability runtime catalog could not be refreshed immediately',
      ],
    });
    expect(refreshBackends).toHaveBeenCalledTimes(1);
    expect(refreshDynamicTools).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });
});
