import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../observability/serviceCatalog.js', () => ({
  listServiceCatalog: jest.fn(),
  refreshServiceCatalog: jest.fn(),
}));
jest.mock('../../observability/serviceTopology.js', () => ({
  getServiceTopology: jest.fn(),
}));
jest.mock('../../observability/incidentImpact.js', () => ({
  getIncidentImpact: jest.fn(),
}));
jest.mock('../../solutionPacks/bundleCapabilities.js', () => ({
  checkBundleCapabilities: jest.fn(),
  loadBundleCapabilities: jest.fn(async () => []),
}));
jest.mock('../../solutionPacks/executionTargets.js', () => ({
  executionTargetsFromBackend: jest.fn(() => []),
  mergeExecutionTargetConfig: jest.fn(),
  normalizeKubernetesExecutionTargetMutation: jest.fn(),
  resolveExecutionResourceScope: jest.fn(),
}));
jest.mock('../../solutionPacks/kubernetesCertificationStore.js', () => ({
  KubernetesCertificationError: class KubernetesCertificationError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
  },
  importKubernetesCertification: jest.fn(),
  listKubernetesCertificationHistory: jest.fn(),
  listLatestKubernetesCertifications: jest.fn(),
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

import { listServiceCatalog, refreshServiceCatalog } from '../../observability/serviceCatalog.js';
import { getServiceTopology } from '../../observability/serviceTopology.js';
import { getIncidentImpact } from '../../observability/incidentImpact.js';
import { checkBundleCapabilities } from '../../solutionPacks/bundleCapabilities.js';
import { resolveExecutionResourceScope } from '../../solutionPacks/executionTargets.js';
import { listLatestKubernetesCertifications } from '../../solutionPacks/kubernetesCertificationStore.js';
import { registerConsoleApi } from '../consoleApi.js';

const mockList = listServiceCatalog as jest.MockedFunction<typeof listServiceCatalog>;
const mockRefresh = refreshServiceCatalog as jest.MockedFunction<typeof refreshServiceCatalog>;
const mockCapabilities = checkBundleCapabilities as jest.MockedFunction<typeof checkBundleCapabilities>;
const mockResolve = resolveExecutionResourceScope as jest.MockedFunction<typeof resolveExecutionResourceScope>;
const mockCertifications = listLatestKubernetesCertifications as jest.MockedFunction<typeof listLatestKubernetesCertifications>;
const mockTopology = getServiceTopology as jest.MockedFunction<typeof getServiceTopology>;
const mockImpact = getIncidentImpact as jest.MockedFunction<typeof getIncidentImpact>;
const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin', allowed_bundles: null, entra_groups: [],
};
let currentUser = admin;
let server: Server;
let baseUrl = '';

const catalog = {
  generatedAt: '2026-08-12T18:00:00.000Z', entries: [],
  summary: { services: 0, current: 0, kubernetes: 0, opentelemetry: 0, logs: 0, configured: 0 },
};
const topology = {
  generatedAt: '2026-08-12T18:00:00.000Z', nodes: [], edges: [],
  summary: { clusters: 0, namespaces: 0, workloads: 0, services: 0, alerts: 0, firingAlerts: 0, traceServices: 0, logServices: 0, runtimeDependencies: 0, calls: 0, failures: 0 },
};
const freshCertification = {
  id: 1, backendId: 42, targetId: 'demo-kind', platform: 'kubernetes' as const, profile: 'in-cluster-read-only' as const,
  status: 'passed' as const, contractSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), checkCount: 2,
  passedCount: 2, failedCount: 0, failedChecks: [], generatedAt: '2026-08-12T18:00:00.000Z',
  importedAt: '2026-08-12T18:01:00.000Z', importedBy: 'test', freshness: 'fresh' as const, ageHours: 1,
  expiresAt: '2026-08-19T18:00:00.000Z',
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  registerConsoleApi(app, {
    pool: {} as pg.Pool,
    config: {} as never,
    requireAuth,
    requireSameOrigin: ((_req, _res, next) => next()) as RequestHandler,
    loadStatus: jest.fn(async () => ({})),
    listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined),
    refreshDynamicTools: jest.fn(async () => undefined),
    publicWidgetEnabled: false,
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
  mockList.mockResolvedValue(catalog);
  mockTopology.mockResolvedValue(topology);
  mockImpact.mockResolvedValue({
    incidentId: 81, generatedAt: '2026-08-12T18:00:00.000Z', available: true, reason: null,
    service: 'checkout-api', environment: 'demo', window: { minutesBefore: 60, minutesAfter: 30 },
    summary: { upstreamServices: 1, downstreamServices: 1, externalDependencies: 1, failingDependencies: 1, observedCalls: 4, observedFailures: 4 },
    impactedServices: [], dependencies: [], rootCauseCandidates: [],
  });
  mockRefresh.mockResolvedValue({ discovered: 4, dependencies: 1, sources: ['kubernetes', 'opentelemetry'], warnings: [] });
  mockCapabilities.mockResolvedValue({ ok: true, required: ['metrics', 'runtime'], provided: ['metrics', 'runtime'], missing: [], bundles: [] });
  mockResolve.mockResolvedValue({
    kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', cluster: 'argus-kind', namespace: 'argus-demo', environment: 'demo',
  });
  mockCertifications.mockResolvedValue([freshCertification]);
});

describe('observability service catalog routes', () => {
  it('returns the normalized catalog only to platform admins', async () => {
    const response = await fetch(`${baseUrl}/api/ui/observability/service-catalog`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(catalog);

    currentUser = { ...admin, role: 'viewer' };
    const forbidden = await fetch(`${baseUrl}/api/ui/observability/service-catalog`);
    expect(forbidden.status).toBe(403);
  });

  it('returns the evidence-backed service topology only to platform admins', async () => {
    const response = await fetch(`${baseUrl}/api/ui/observability/service-topology`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(topology);

    currentUser = { ...admin, role: 'viewer' };
    const forbidden = await fetch(`${baseUrl}/api/ui/observability/service-topology`);
    expect(forbidden.status).toBe(403);
  });

  it('returns incident-scoped dependency impact only to platform admins', async () => {
    const response = await fetch(`${baseUrl}/api/ui/observability/alerts/81/impact`);
    expect(response.status).toBe(200);
    expect(mockImpact).toHaveBeenCalledWith(expect.anything(), 81);

    currentUser = { ...admin, role: 'viewer' };
    const forbidden = await fetch(`${baseUrl}/api/ui/observability/alerts/81/impact`);
    expect(forbidden.status).toBe(403);
  });

  it('refreshes through the exact certified bundle and resource scope', async () => {
    const resourceScope = { kind: 'kubernetes' as const, backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' };
    const response = await fetch(`${baseUrl}/api/ui/observability/service-catalog/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bundleId: 28, resourceScope }),
    });
    expect(response.status).toBe(200);
    expect(mockCapabilities).toHaveBeenCalledWith(expect.anything(), [28], ['metrics', 'runtime']);
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), [28], resourceScope);
    expect(mockRefresh).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ bundleId: 28, scope: resourceScope }));
  });

  it('fails closed when the selected target certification is stale', async () => {
    mockCertifications.mockResolvedValue([{ ...freshCertification, freshness: 'stale' }]);
    const response = await fetch(`${baseUrl}/api/ui/observability/service-catalog/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundleId: 28, resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' } }),
    });
    expect(response.status).toBe(409);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
