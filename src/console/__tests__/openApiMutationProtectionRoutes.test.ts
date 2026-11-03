import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../lib/adminAudit.js', () => ({
  writeAdminAudit: jest.fn(),
}));
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

import { registerConsoleApi } from '../consoleApi.js';

const adminUser: SessionUser = {
  id: 7,
  username: 'platform-admin',
  display_name: 'Platform Admin',
  role: 'platform_admin',
  allowed_bundles: null,
  entra_groups: [],
};

const openApiCapability = {
  id: 11,
  name: 'pets__getpets',
  description: 'GET pets',
  backend: 'custom:pets',
  query_template: 'GET /pets',
  parameters: [],
  category: 'openapi:pets',
  enabled: true,
  tool_type: 'dynamic',
  is_write: false,
  risk_level: 'low',
  required_auth_mode: 'service-account',
  bundle_ids: [],
  workflow_count: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const openApiBackend = {
  id: 17,
  name: 'pets',
  description: 'Imported from OpenAPI',
  base_url: 'https://api.example.test/v1',
  auth_type: 'none',
  auth_value: null,
  health_path: '/health',
  default_headers: {},
  timeout_ms: 10_000,
  tls_skip_verify: false,
  enabled: true,
  backend_type: 'http',
  mcp_endpoint: null,
  auth_mode: 'service-account',
  oauth_authorize_url: null,
  oauth_token_url: null,
  oauth_client_id: null,
  oauth_client_secret: null,
  oauth_scopes: null,
  oauth_revoke_url: null,
  config: { managed_by: 'openapi' },
  bundle_id: null,
  bundle_ids: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

let server: Server;
let baseUrl: string;
let capturedSql: string[];
let sourceControlled: boolean;
let capabilityCategory: string;
let client: pg.PoolClient;
let refreshBackends: jest.Mock;
let refreshDynamicTools: jest.Mock;

function normalizedSql(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

function capabilityMutation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: openApiCapability.name,
    description: 'Changed outside the importer',
    backend: openApiCapability.backend,
    queryTemplate: 'GET /pets',
    parameters: [],
    category: 'manual',
    enabled: true,
    bundleIds: [],
    allowUnscoped: true,
    riskLevel: 'low',
    requiredAuthMode: 'service-account',
    ...overrides,
  };
}

function connectionMutation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'http',
    description: 'Imported connection',
    baseUrl: openApiBackend.base_url,
    authType: openApiBackend.auth_type,
    enabled: true,
    bundleIds: [],
    ...overrides,
  };
}

async function request(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const query = jest.fn(async (queryText: unknown, values?: unknown[]) => {
    const sql = normalizedSql(queryText);
    capturedSql.push(sql);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: null };
    if (sql === 'SELECT name FROM mcp_backends WHERE id = $1') {
      return { rows: [{ name: openApiBackend.name }], rowCount: 1 };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    if (sql.includes('FROM mcp_capability_sources source')) {
      return { rows: sourceControlled ? [{ id: 31 }] : [], rowCount: sourceControlled ? 1 : 0 };
    }
    if (sql.includes('FROM mcp_backends backend') && sql.includes('FOR UPDATE OF backend')) {
      return { rows: [{ ...openApiBackend }], rowCount: 1 };
    }
    if (sql.includes('FROM mcp_backend_bundles') && sql.includes('FOR UPDATE')) {
      return {
        rows: openApiBackend.bundle_ids.map(bundle_id => ({ bundle_id })),
        rowCount: openApiBackend.bundle_ids.length,
      };
    }
    if (sql.includes('FROM mcp_tools tool') && sql.includes('FOR UPDATE')) {
      return { rows: [{ ...openApiCapability, category: capabilityCategory }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE mcp_tools SET enabled')) {
      return { rows: [{ updated_at: '2026-02-01T00:00:00.000Z' }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE mcp_backends')) {
      return {
        rows: [{
          ...openApiBackend,
          description: values?.[0],
          base_url: values?.[1],
          auth_type: values?.[2],
          enabled: values?.[9],
          updated_at: '2026-02-01T00:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('DELETE FROM mcp_tool_bundles') || sql.startsWith('DELETE FROM mcp_backend_bundles')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('DELETE FROM mcp_tools')) return { rows: [], rowCount: 2 };
    if (sql.startsWith('DELETE FROM mcp_backends')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected test query: ${sql}`);
  });
  client = { query, release: jest.fn() } as unknown as pg.PoolClient;
  const pool = {
    connect: jest.fn(async () => client),
    query: jest.fn(async (queryText: unknown) => {
      const sql = normalizedSql(queryText);
      if (sql.includes('FROM mcp_tools tool') && sql.includes('LEFT JOIN mcp_backends backend')) {
        return { rows: [{ ...openApiCapability, backend_id: 17, backend_label: 'pets' }], rowCount: 1 };
      }
      if (sql.includes('FROM mcp_remote_tools remote')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM mcp_service_bundles')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM mcp_backends ORDER BY name')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as pg.Pool;
  refreshBackends = jest.fn(async () => undefined);
  refreshDynamicTools = jest.fn(async () => undefined);

  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: SessionUser }).user = adminUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, _res, next) => next();
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
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  capturedSql = [];
  sourceControlled = true;
  capabilityCategory = openApiCapability.category;
  jest.clearAllMocks();
});

describe('OpenAPI capability mutation protection', () => {
  it('marks generated catalog entries non-editable while leaving them available', async () => {
    const response = await request('/api/ui/mcp-fabric/capabilities', 'GET');

    expect(response.status).toBe(200);
    const capabilities = response.body.capabilities as Array<Record<string, unknown>>;
    expect(capabilities).toEqual([
      expect.objectContaining({ name: openApiCapability.name, editable: false, managedBy: 'openapi' }),
    ]);
  });

  it('rejects generic PUT after locking the generated capability row', async () => {
    const response = await request('/api/ui/mcp-fabric/capabilities/11', 'PUT', capabilityMutation());

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/OpenAPI-importierte/);
    expect(capturedSql.some(sql => sql.includes('FROM mcp_tools tool') && sql.includes('FOR UPDATE'))).toBe(true);
    expect(capturedSql.some(sql => sql.startsWith('UPDATE mcp_tools SET description'))).toBe(false);
    expect(capturedSql).toContain('ROLLBACK');
  });

  it('rejects generic DELETE after locking the generated capability row', async () => {
    const response = await request('/api/ui/mcp-fabric/capabilities/11', 'DELETE', {
      confirmName: openApiCapability.name,
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/OpenAPI-importierte/);
    expect(capturedSql.some(sql => sql.includes('FROM mcp_tools tool') && sql.includes('FOR UPDATE'))).toBe(true);
    expect(capturedSql.some(sql => sql.startsWith('DELETE FROM mcp_tools'))).toBe(false);
    expect(capturedSql).toContain('ROLLBACK');
  });

  it('continues to allow the dedicated enabled-state toggle', async () => {
    const response = await request('/api/ui/mcp-fabric/capabilities/11/state', 'PATCH', { enabled: false });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, enabled: false });
    expect(capturedSql.some(sql => sql.startsWith('UPDATE mcp_tools SET enabled'))).toBe(true);
    expect(capturedSql).toContain('COMMIT');
    expect(refreshDynamicTools).toHaveBeenCalledTimes(1);
  });

  it('reserves the OpenAPI category namespace on generic create', async () => {
    const response = await request(
      '/api/ui/mcp-fabric/capabilities',
      'POST',
      capabilityMutation({ name: 'spoofed_tool', category: 'openapi:spoofed' }),
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/OpenAPI-Kategorie/);
    expect(capturedSql.some(sql => sql.startsWith('INSERT INTO mcp_tools'))).toBe(false);
    expect(capturedSql).toContain('ROLLBACK');
  });

  it('reserves the OpenAPI category namespace on a generic category change', async () => {
    capabilityCategory = 'manual';
    const response = await request(
      '/api/ui/mcp-fabric/capabilities/11',
      'PUT',
      capabilityMutation({ category: 'openapi:spoofed' }),
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/OpenAPI-Kategorie/);
    expect(capturedSql.some(sql => sql.includes('FROM mcp_tools tool') && sql.includes('FOR UPDATE'))).toBe(true);
    expect(capturedSql.some(sql => sql.startsWith('UPDATE mcp_tools SET description'))).toBe(false);
    expect(capturedSql).toContain('ROLLBACK');
  });
});

describe('OpenAPI connection core protection', () => {
  it.each([
    ['base URL', { baseUrl: 'https://other.example.test/v1' }],
    ['auth type', { authType: 'bearer' }],
    ['explicit credential', { authValue: 'replacement-token' }],
  ])('rejects a source-controlled %s change', async (_label, overrides) => {
    const response = await request(
      '/api/ui/mcp-fabric/connections/17',
      'PUT',
      connectionMutation(overrides),
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/OpenAPI-verwalteten/);
    const advisoryIndex = capturedSql.findIndex(sql => sql.includes('pg_advisory_xact_lock'));
    const backendLockIndex = capturedSql.findIndex(sql => sql.includes('FROM mcp_backends backend') && sql.includes('FOR UPDATE OF backend'));
    const sourceLockIndex = capturedSql.findIndex(sql => sql.includes('FROM mcp_capability_sources source') && sql.includes('FOR UPDATE'));
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(backendLockIndex).toBeGreaterThan(advisoryIndex);
    expect(sourceLockIndex).toBeGreaterThan(backendLockIndex);
    expect(capturedSql.some(sql => sql.startsWith('UPDATE mcp_backends'))).toBe(false);
    expect(capturedSql).toContain('ROLLBACK');
  });

  it('allows non-core state edits while retaining the locked source-owned core', async () => {
    const response = await request(
      '/api/ui/mcp-fabric/connections/17',
      'PUT',
      connectionMutation({ description: 'Temporarily disabled', enabled: false }),
    );

    expect(response.status).toBe(200);
    expect(response.body.connection).toMatchObject({ id: 17, name: 'pets', enabled: false });
    expect(capturedSql.some(sql => sql.startsWith('UPDATE mcp_backends'))).toBe(true);
    expect(capturedSql).toContain('COMMIT');
    expect(refreshBackends).toHaveBeenCalledTimes(1);
  });

  it('rejects bundle-boundary edits outside the Capability Studio', async () => {
    const response = await request(
      '/api/ui/mcp-fabric/connections/17',
      'PUT',
      connectionMutation({ bundleIds: [4] }),
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/Bundle-Grenzen/);
    expect(response.body.href).toBe('/mcp-fabric/capabilities');
    expect(capturedSql.some(sql => sql.startsWith('UPDATE mcp_backends'))).toBe(false);
    expect(capturedSql).toContain('ROLLBACK');
  });

  it('rejects generic source-controlled deletion under the importer lock order', async () => {
    const response = await request('/api/ui/mcp-fabric/connections/17', 'DELETE', {});

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/Capability Studio/);
    expect(response.body.href).toBe('/mcp-fabric/capabilities');
    const advisoryIndex = capturedSql.findIndex(sql => sql.includes('pg_advisory_xact_lock'));
    const backendLockIndex = capturedSql.findIndex(sql => sql.includes('FROM mcp_backends backend') && sql.includes('FOR UPDATE OF backend'));
    const sourceLockIndex = capturedSql.findIndex(sql => sql.includes('FROM mcp_capability_sources source') && sql.includes('FOR UPDATE'));
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(backendLockIndex).toBeGreaterThan(advisoryIndex);
    expect(sourceLockIndex).toBeGreaterThan(backendLockIndex);
    expect(capturedSql.some(sql => sql.startsWith('DELETE FROM mcp_tools'))).toBe(false);
    expect(capturedSql.some(sql => sql.startsWith('DELETE FROM mcp_backends'))).toBe(false);
    expect(capturedSql).toContain('ROLLBACK');
  });
});
