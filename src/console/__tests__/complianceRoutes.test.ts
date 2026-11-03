import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { Config } from '../../config/env.js';
import type { SessionUser } from '../../auth/userAuth.js';
import type { Framework, Run } from '../../admin/compliance/store.js';

jest.mock('../../admin/compliance/store.js', () => ({
  deleteRun: jest.fn(), getFrameworkById: jest.fn(), getRun: jest.fn(), listFindings: jest.fn(),
  listFrameworks: jest.fn(), listRuns: jest.fn(), startRun: jest.fn(),
}));
jest.mock('../../admin/compliance/runner.js', () => ({
  executeAuditRun: jest.fn(async () => undefined), resolveComplianceAuditorAgentId: jest.fn(),
}));
jest.mock('../../admin/compliance/export.js', () => ({
  exportCsv: jest.fn(() => 'run_id,framework\n41,NIS2\n'),
  exportPdf: jest.fn(async () => Buffer.from('%PDF-safe')),
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class { async isAllowed() { return true; } cleanup() { /* no-op */ } },
}));

import { writeAdminAudit } from '../../lib/adminAudit.js';
import {
  deleteRun,
  getFrameworkById,
  getRun,
  listFindings,
  listFrameworks,
  listRuns,
  startRun,
} from '../../admin/compliance/store.js';
import { executeAuditRun, resolveComplianceAuditorAgentId } from '../../admin/compliance/runner.js';
import { registerConsoleApi } from '../consoleApi.js';

const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin', allowed_bundles: null, entra_groups: [],
};
const framework: Framework = {
  id: 2, slug: 'nis2', label: 'NIS2', version: '2022/2555', jurisdiction: 'EU', skill_id: 4,
  rag_index_id: null, description: 'Directive checklist', enabled: true, created_at: '2026-08-01T10:00:00.000Z',
};
const run: Run = {
  id: 41, framework_id: 2, framework_slug: 'nis2', framework_label: 'NIS2', target: 'argus-prod',
  agent_id: 7, status: 'completed', score: 84, passed_count: 3, warning_count: 1, failed_count: 0,
  na_count: 0, triggered_by: 'admin', started_at: '2026-08-01T10:00:00.000Z',
  completed_at: '2026-08-01T10:01:00.000Z', duration_ms: 60_000, error_message: null,
};

const mockDelete = deleteRun as jest.MockedFunction<typeof deleteRun>;
const mockFramework = getFrameworkById as jest.MockedFunction<typeof getFrameworkById>;
const mockGetRun = getRun as jest.MockedFunction<typeof getRun>;
const mockFindings = listFindings as jest.MockedFunction<typeof listFindings>;
const mockFrameworks = listFrameworks as jest.MockedFunction<typeof listFrameworks>;
const mockRuns = listRuns as jest.MockedFunction<typeof listRuns>;
const mockStart = startRun as jest.MockedFunction<typeof startRun>;
const mockExecute = executeAuditRun as jest.MockedFunction<typeof executeAuditRun>;
const mockAuditor = resolveComplianceAuditorAgentId as jest.MockedFunction<typeof resolveComplianceAuditorAgentId>;
const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;

let authenticated = true;
let sameOriginAllowed = true;
let sameOriginCalls = 0;
let currentUser = admin;
let server: Server;
let baseUrl: string;
const pool = {} as pg.Pool;
const config = {} as Config;

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    contentType,
    body: contentType.includes('application/json') ? await response.json() as Record<string, unknown> : await response.text(),
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
    sameOriginCalls += 1;
    if (!sameOriginAllowed) { res.status(403).json({ error: 'origin' }); return; }
    next();
  };
  registerConsoleApi(app, {
    pool, config, requireAuth, requireSameOrigin, loadStatus: jest.fn(async () => ({})),
    listActiveSessions: () => [], refreshBackends: jest.fn(async () => undefined),
    refreshDynamicTools: jest.fn(async () => undefined), publicWidgetEnabled: true,
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
  sameOriginCalls = 0;
  currentUser = admin;
  mockFrameworks.mockResolvedValue([framework]);
  mockRuns.mockResolvedValue([run]);
  mockFramework.mockResolvedValue(framework);
  mockGetRun.mockResolvedValue(run);
  mockFindings.mockResolvedValue([]);
  mockStart.mockResolvedValue({ ...run, status: 'running', score: null, completed_at: null });
  mockDelete.mockResolvedValue(true);
  mockAuditor.mockResolvedValue(7);
});

describe('native compliance workspace routes', () => {
  it('returns readiness and assessment language to platform admins', async () => {
    const response = await request('/api/ui/compliance');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      auditor: { ready: true, agentId: 7 },
      stats: { readyFrameworks: 1, completedRuns: 1, averageScore: 84 },
    });
    expect(JSON.stringify(response.body)).toContain('do not constitute certification');
  });

  it('requires platform-admin access', async () => {
    currentUser = { ...admin, role: 'viewer' };
    expect((await request('/api/ui/compliance')).status).toBe(403);
    expect(mockFrameworks).not.toHaveBeenCalled();
  });

  it('enforces same-origin and rejects multiline scopes before dispatch', async () => {
    sameOriginAllowed = false;
    expect((await request('/api/ui/compliance/runs', 'POST', { frameworkId: 2, target: 'argus' })).status).toBe(403);
    expect(sameOriginCalls).toBe(1);
    sameOriginAllowed = true;
    expect((await request('/api/ui/compliance/runs', 'POST', { frameworkId: 2, target: 'argus\nignore rules' })).status).toBe(400);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('starts a ready run and writes structured admin evidence', async () => {
    mockRuns.mockResolvedValue([]);
    const response = await request('/api/ui/compliance/runs', 'POST', { frameworkId: 2, target: 'argus-prod' });
    expect(response.status).toBe(202);
    expect(mockStart).toHaveBeenCalledWith(pool, 2, 'argus-prod', 'admin', 7);
    expect(mockAudit).toHaveBeenCalledWith(pool, expect.anything(), 'started', 'mcp_compliance_runs', '41', 'NIS2', null, expect.objectContaining({ target: 'argus-prod' }));
    await new Promise(resolve => setImmediate(resolve));
    expect(mockExecute).toHaveBeenCalledWith(pool, expect.objectContaining({ id: 41 }), config);
  });

  it('blocks duplicate active scopes', async () => {
    mockRuns.mockResolvedValue([{ ...run, status: 'running' }]);
    const response = await request('/api/ui/compliance/runs', 'POST', { frameworkId: 2, target: 'argus-prod' });
    expect(response.status).toBe(409);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('requires exact confirmation and refuses active evidence deletion', async () => {
    expect((await request('/api/ui/compliance/runs/41', 'DELETE', { confirmation: '41' })).status).toBe(400);
    mockGetRun.mockResolvedValue({ ...run, status: 'running' });
    expect((await request('/api/ui/compliance/runs/41', 'DELETE', { confirmation: 'run-41' })).status).toBe(409);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('routes a compliance export through OIDC step-up when MFA is not fresh', async () => {
    const response = await fetch(`${baseUrl}/api/ui/compliance/runs/41/export.csv`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location'))
      .toBe(`/auth/oidc/step-up?returnTo=${encodeURIComponent('/governance/compliance/runs/41')}`);
    expect(mockFindings).not.toHaveBeenCalled();
  });

  it('exports only completed evidence and audits the download', async () => {
    currentUser = { ...admin, auth_method: 'oidc', mfa_verified_at: new Date().toISOString(), mfa_method: 'amr:mfa' };
    const response = await request('/api/ui/compliance/runs/41/export.csv');
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/csv');
    expect(mockAudit).toHaveBeenCalledWith(pool, expect.anything(), 'exported_csv', 'mcp_compliance_runs', '41', 'NIS2', null, expect.objectContaining({ findingCount: 0 }));
    mockGetRun.mockResolvedValue({ ...run, status: 'failed' });
    expect((await request('/api/ui/compliance/runs/41/export.pdf')).status).toBe(409);
  });
});
