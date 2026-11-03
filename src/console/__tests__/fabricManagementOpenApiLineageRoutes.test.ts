import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../bundles/serviceBundles.js', () => ({
  deleteBundle: jest.fn(),
  getBundle: jest.fn(),
  getBundleBackends: jest.fn(),
  getBundleTools: jest.fn(),
  listBundles: jest.fn(async () => [{
    id: 3,
    name: 'catalog-team',
    label: 'Catalog team',
    description: 'Catalog access',
    icon: '◈',
    agent_role: null,
    system_prompt: null,
    backend_count: 1,
    tool_count: 2,
    composite_count: 0,
    created_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-31T10:00:00.000Z',
  }]),
}));
jest.mock('../../bundles/toolPolicies.js', () => ({
  loadAllowedToolNames: jest.fn(),
  listBundleToolPolicies: jest.fn(async () => []),
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

import { registerConsoleApi } from '../consoleApi.js';

const admin: SessionUser = {
  id: 7,
  username: 'admin',
  display_name: 'Admin',
  role: 'platform_admin',
  allowed_bundles: null,
  entra_groups: [],
};

const backend = {
  id: 17,
  name: 'catalog',
  description: 'Imported from OpenAPI',
  base_url: 'https://catalog.example/v1',
  backend_type: 'http',
  enabled: true,
  mcp_endpoint: null,
  auth_type: 'none',
  has_auth_value: false,
  health_path: '/health',
  default_headers: {},
  timeout_ms: 10_000,
  tls_skip_verify: false,
  auth_mode: 'service-account',
  oauth_authorize_url: null,
  oauth_token_url: null,
  oauth_client_id: null,
  has_oauth_client_secret: false,
  oauth_scopes: [],
  oauth_revoke_url: null,
  bundle_ids: [3],
  tool_count: 2,
  capability_source_id: 4,
  source_controlled: true,
  created_at: '2026-07-30T10:00:00.000Z',
  updated_at: '2026-07-31T10:00:00.000Z',
};

let server: Server;
let baseUrl: string;
let sourceControlled = true;
let capturedBackendSql = '';
let capturedWorkflowSql = '';

beforeAll(async () => {
  const pool = {
    query: jest.fn(async (rawSql: unknown) => {
      const sql = String(rawSql).replace(/\s+/g, ' ').trim();
      if (sql.includes('FROM mcp_backend_bundles') && sql.includes('GROUP BY bundle_id')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM mcp_bundle_skills') && sql.includes('GROUP BY bundle_id')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM mcp_workflow_bundles wb') && sql.includes('GROUP BY wb.bundle_id')) {
        capturedWorkflowSql = sql;
        return { rows: [{ bundle_id: 3, workflow_ids: [9, 11] }], rowCount: 1 };
      }
      if (sql.includes('FROM mcp_backends b') && sql.includes('LEFT JOIN mcp_capability_sources source')) {
        capturedBackendSql = sql;
        return {
          rows: [{
            ...backend,
            capability_source_id: sourceControlled ? backend.capability_source_id : null,
            source_controlled: sourceControlled,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM mcp_skills')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT DISTINCT ON (candidate.backend_id, candidate.name)')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected management test query: ${sql}`);
    }),
  } as unknown as pg.Pool;
  const app = express();
  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: SessionUser }).user = admin;
    next();
  };
  registerConsoleApi(app, {
    pool,
    requireAuth,
    requireSameOrigin: ((_req, _res, next) => next()) as RequestHandler,
    loadStatus: jest.fn(async () => ({ backends: [] })),
    listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined),
    refreshDynamicTools: jest.fn(async () => undefined),
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
  sourceControlled = true;
  capturedBackendSql = '';
  capturedWorkflowSql = '';
});

describe('MCP Fabric management OpenAPI lineage', () => {
  it('exposes the owning source for an OpenAPI-managed connection', async () => {
    const response = await fetch(`${baseUrl}/api/ui/mcp-fabric/manage`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      backends: Array<Record<string, unknown>>;
      bundles: Array<Record<string, unknown>>;
    };

    expect(body.backends).toEqual([
      expect.objectContaining({
        id: 17,
        name: 'catalog',
        managed: true,
        managedBy: 'openapi',
        sourceId: 4,
        workflowCount: 2,
      }),
    ]);
    expect(body.bundles).toEqual([
      expect.objectContaining({
        id: 3,
        workflowIds: [9, 11],
        workflowCount: 2,
      }),
    ]);
    expect(capturedBackendSql).toContain('LEFT JOIN mcp_capability_sources source ON source.backend_id = b.id');
    expect(capturedBackendSql).toContain("b.config->>'managed_by' = 'openapi'");
    expect(capturedWorkflowSql).toContain('JOIN mcp_workflows w ON w.id = wb.workflow_id');
  });

  it('keeps regular managed connections independently editable', async () => {
    sourceControlled = false;
    const response = await fetch(`${baseUrl}/api/ui/mcp-fabric/manage`);
    const body = await response.json() as { backends: Array<Record<string, unknown>> };

    expect(body.backends[0]).toEqual(expect.objectContaining({
      managed: true,
      managedBy: null,
      sourceId: null,
    }));
  });
});
