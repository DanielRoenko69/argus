import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../solutionPacks/kubernetesCertificationStore.js', () => ({
  KubernetesCertificationError: class KubernetesCertificationError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
  },
  importKubernetesCertification: jest.fn(),
  listKubernetesCertificationHistory: jest.fn(),
  listLatestKubernetesCertifications: jest.fn(async () => []),
  loadKubernetesCertificationPolicy: jest.fn(() => ({ warningAgeHours: 120, maxAgeHours: 168, enforceAIOps: true })),
  normalizeKubernetesCertificationReport: jest.fn(),
  resolveKubernetesCertificationBackendId: jest.fn(),
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class {
    async isAllowed() { return true; }
    cleanup() { /* no-op */ }
  },
}));

import {
  importKubernetesCertification,
  listKubernetesCertificationHistory,
  normalizeKubernetesCertificationReport,
  resolveKubernetesCertificationBackendId,
  type KubernetesCertificationRecord,
} from '../../solutionPacks/kubernetesCertificationStore.js';
import { registerConsoleApi } from '../consoleApi.js';

const mockHistory = listKubernetesCertificationHistory as jest.MockedFunction<typeof listKubernetesCertificationHistory>;
const mockImport = importKubernetesCertification as jest.MockedFunction<typeof importKubernetesCertification>;
const mockNormalize = normalizeKubernetesCertificationReport as jest.MockedFunction<typeof normalizeKubernetesCertificationReport>;
const mockResolve = resolveKubernetesCertificationBackendId as jest.MockedFunction<typeof resolveKubernetesCertificationBackendId>;
const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin',
  allowed_bundles: null, entra_groups: [],
};
let currentUser = admin;
let automationState: Record<string, unknown> | null = null;
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.path === '/api/certifications/kubernetes' && automationState) {
      Object.assign(req as unknown as Record<string, unknown>, automationState);
    }
    next();
  });
  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  registerConsoleApi(app, {
    pool: {} as pg.Pool,
    requireAuth,
    requireSameOrigin: ((_req, _res, next) => next()) as RequestHandler,
    loadStatus: jest.fn(async () => ({})),
    listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined),
    refreshDynamicTools: jest.fn(async () => undefined),
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
  currentUser = admin;
  automationState = {
    apiKeyPrefix: 'ak_cron1',
    apiKeyScope: 'agents',
    allowedTools: ['system.kubernetes-certification.import'],
    deniedTools: null,
  };
  const certification: KubernetesCertificationRecord = {
    id: 41, backendId: 17, targetId: 'argus-aiops-kind', platform: 'kubernetes',
    profile: 'in-cluster-read-only', status: 'passed', contractSha256: 'a'.repeat(64),
    reportSha256: 'b'.repeat(64), checkCount: 25, passedCount: 25, failedCount: 0,
    failedChecks: [], generatedAt: '2026-08-11T22:00:00.000Z', importedAt: '2026-08-11T22:01:00.000Z',
    importedBy: 'admin', freshness: 'fresh', ageHours: 3, expiresAt: '2026-08-18T22:00:00.000Z',
  };
  mockHistory.mockResolvedValue([certification]);
  mockNormalize.mockReturnValue({
    apiVersion: 'certification.argus.eu/v1alpha1',
    kind: 'KubernetesConnectorCertificationReport',
    targetId: 'argus-aiops-kind',
    platform: 'kubernetes',
    profile: 'in-cluster-read-only',
    overall: 'passed',
    checks: [{ id: 'connector.ready', status: 'passed', detail: 'ready' }],
    generatedAt: '2026-08-11T22:00:00.000Z',
    contractSha256: 'a'.repeat(64),
  });
  mockResolve.mockResolvedValue(17);
  mockImport.mockResolvedValue(certification);
});

describe('Kubernetes certification console routes', () => {
  it('accepts renewal reports only from explicitly scoped automation keys', async () => {
    const report = { targetId: 'argus-aiops-kind' };
    const response = await fetch(`${baseUrl}/api/certifications/kubernetes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      certification: { backendId: 17, targetId: 'argus-aiops-kind', status: 'passed' },
    });
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), 'argus-aiops-kind');
    expect(mockImport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      backendId: 17,
      report,
      importedBy: 'automation:ak_cron1',
    }));
  });

  it('rejects missing and default-wide automation identities', async () => {
    automationState = null;
    const missing = await fetch(`${baseUrl}/api/certifications/kubernetes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report: {} }),
    });
    expect(missing.status).toBe(401);

    automationState = { apiKeyPrefix: 'ak_wide1', apiKeyScope: 'both', allowedTools: null, deniedTools: null };
    const unscoped = await fetch(`${baseUrl}/api/certifications/kubernetes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report: {} }),
    });
    expect(unscoped.status).toBe(403);

    automationState = { apiKeyPrefix: 'ak_wild1', apiKeyScope: 'agents', allowedTools: ['*'], deniedTools: null };
    const wildcard = await fetch(`${baseUrl}/api/certifications/kubernetes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report: {} }),
    });
    expect(wildcard.status).toBe(403);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('returns bounded history and the active policy to platform admins', async () => {
    const response = await fetch(`${baseUrl}/api/ui/mcp-fabric/kubernetes-certifications/17/argus-aiops-kind/history?limit=7`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      history: [{ targetId: 'argus-aiops-kind', freshness: 'fresh' }],
      policy: { warningAgeHours: 120, maxAgeHours: 168, enforceAIOps: true },
    });
    expect(mockHistory).toHaveBeenCalledWith(expect.anything(), {
      backendId: 17,
      targetId: 'argus-aiops-kind',
      limit: 7,
    });
  });

  it('does not expose certification history to non-admin users', async () => {
    currentUser = { ...admin, role: 'viewer' };
    const response = await fetch(`${baseUrl}/api/ui/mcp-fabric/kubernetes-certifications/17/argus-aiops-kind/history`);
    expect(response.status).toBe(403);
    expect(mockHistory).not.toHaveBeenCalled();
  });
});
