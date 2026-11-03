import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../fabricProfiles.js', () => ({
  applyFabricProfileAudited: jest.fn(),
  checkFabricProfileDriftAudited: jest.fn(),
  diffFabricProfileVersions: jest.fn(),
  exportFabricProfileAudited: jest.fn(),
  applyApprovedFabricProfileRestore: jest.fn(),
  decideFabricProfileRestore: jest.fn(),
  listFabricProfileSsoGroups: jest.fn(),
  listFabricProfiles: jest.fn(),
  listFabricProfileRestoreRequests: jest.fn(),
  listFabricProfileVersions: jest.fn(),
  planFabricProfileImportAudited: jest.fn(),
  requestFabricProfileRestore: jest.fn(),
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class { async isAllowed() { return true; } cleanup() { /* no-op */ } },
}));

import { writeAdminAudit } from '../../lib/adminAudit.js';
import {
  applyFabricProfileAudited,
  applyApprovedFabricProfileRestore,
  checkFabricProfileDriftAudited,
  decideFabricProfileRestore,
  diffFabricProfileVersions,
  exportFabricProfileAudited,
  listFabricProfileRestoreRequests,
  listFabricProfileSsoGroups,
  listFabricProfiles,
  listFabricProfileVersions,
  planFabricProfileImportAudited,
  requestFabricProfileRestore,
} from '../fabricProfiles.js';
import { registerConsoleApi } from '../consoleApi.js';

const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin', allowed_bundles: null, entra_groups: [],
};
const manifest = {
  apiVersion: 'fabric.argus.dev/v1alpha1' as const,
  kind: 'FabricProfile' as const,
  metadata: { name: 'platform-ops', label: 'Platform Ops', description: 'Shared baseline', version: '1.0.0' },
  spec: { connectors: [], bundles: [], access: null },
};
const profile = {
  id: 12,
  name: 'platform-ops',
  label: 'Platform Ops',
  description: 'Shared baseline',
  manifestVersion: '1.0.0',
  revision: 1,
  manifest,
  manifestDigest: 'a'.repeat(64),
  source: 'local' as const,
  installedBundleIds: [3],
  appliedMappings: {},
  createdBy: 'admin',
  updatedBy: 'admin',
  lastAppliedAt: null,
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:00:00.000Z',
};
const plan = {
  manifest,
  manifestDigest: 'a'.repeat(64),
  planToken: 'b'.repeat(64),
  actions: [],
  blockers: [],
  resolved: { backends: {}, skills: {}, directTools: {}, groups: {} },
};
const pool = {} as pg.Pool;
const refreshBackends = jest.fn(async () => undefined);
const mockList = listFabricProfiles as jest.MockedFunction<typeof listFabricProfiles>;
const mockExport = exportFabricProfileAudited as jest.MockedFunction<typeof exportFabricProfileAudited>;
const mockGroups = listFabricProfileSsoGroups as jest.MockedFunction<typeof listFabricProfileSsoGroups>;
const mockPlan = planFabricProfileImportAudited as jest.MockedFunction<typeof planFabricProfileImportAudited>;
const mockApply = applyFabricProfileAudited as jest.MockedFunction<typeof applyFabricProfileAudited>;
const mockDrift = checkFabricProfileDriftAudited as jest.MockedFunction<typeof checkFabricProfileDriftAudited>;
const mockVersions = listFabricProfileVersions as jest.MockedFunction<typeof listFabricProfileVersions>;
const mockDiff = diffFabricProfileVersions as jest.MockedFunction<typeof diffFabricProfileVersions>;
const mockListRestores = listFabricProfileRestoreRequests as jest.MockedFunction<typeof listFabricProfileRestoreRequests>;
const mockRequestRestore = requestFabricProfileRestore as jest.MockedFunction<typeof requestFabricProfileRestore>;
const mockDecideRestore = decideFabricProfileRestore as jest.MockedFunction<typeof decideFabricProfileRestore>;
const mockApplyRestore = applyApprovedFabricProfileRestore as jest.MockedFunction<typeof applyApprovedFabricProfileRestore>;
const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;
let currentUser = admin;
let sameOriginAllowed = true;
let server: Server;
let baseUrl: string;

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, res, next) => {
    if (!sameOriginAllowed) { res.status(403).json({ error: 'origin' }); return; }
    next();
  };
  registerConsoleApi(app, {
    pool, requireAuth, requireSameOrigin, loadStatus: jest.fn(async () => ({})), listActiveSessions: () => [],
    refreshBackends, refreshDynamicTools: jest.fn(async () => undefined), publicWidgetEnabled: true,
  } as unknown as Parameters<typeof registerConsoleApi>[1]);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  jest.clearAllMocks();
  currentUser = admin;
  sameOriginAllowed = true;
  mockList.mockResolvedValue([profile]);
  mockGroups.mockResolvedValue([{ name: 'engineering', memberCount: 2 }]);
  mockExport.mockResolvedValue({ profile, auditEvent: { eventId: 'event-export' } as never, replayed: false });
  mockPlan.mockResolvedValue({ plan, auditEvent: { eventId: 'event-preview' } as never, replayed: false });
  mockApply.mockResolvedValue({
    profile: { ...profile, source: 'imported' }, bundleIds: [3], compositeId: 9,
    groupBindings: [{ logicalName: 'developers', groupName: 'engineering', compositeId: 9 }],
    auditEvent: { eventId: 'event-apply' } as never, replayed: false,
  });
  mockDrift.mockResolvedValue({
    drift: {
      status: 'in_sync', checkedAt: '2026-09-13T10:01:00.000Z', profileId: 12, profileRevision: 1,
      manifestDigest: 'a'.repeat(64), counts: { total: 0, critical: 0, warning: 0 }, findings: [],
    },
    auditEvent: { eventId: 'event-drift' } as never,
    replayed: false,
  });
  mockVersions.mockResolvedValue([{
    id: 91, profileId: 12, revision: 1, manifestVersion: '1.0.0', manifest,
    manifestDigest: 'a'.repeat(64), source: 'local', installedBundleIds: [3], appliedMappings: {},
    changeKind: 'created', applied: false, createdBy: 'admin', createdAt: '2026-09-13T10:00:00.000Z',
  }]);
  mockDiff.mockResolvedValue({
    profileId: 12,
    from: { revision: 1, manifestVersion: '1.0.0', manifestDigest: 'a'.repeat(64), createdAt: '2026-09-13T10:00:00.000Z' },
    to: { revision: 2, manifestVersion: '1.1.0', manifestDigest: 'b'.repeat(64), createdAt: '2026-09-13T11:00:00.000Z' },
    counts: { total: 1, added: 0, removed: 0, changed: 1 },
    changes: [{ kind: 'changed', scope: 'metadata', resource: 'platform-ops', field: 'version', before: '1.0.0', after: '1.1.0' }],
    truncated: false,
  });
  const restoreRequest = {
    id: '4ed7e706-87f2-4b2d-8bb9-3784884bb9f2', profileId: 12, profileLabel: 'Platform Ops',
    targetRevision: 1, targetManifestDigest: 'a'.repeat(64), requestedFromRevision: 2,
    requestedFromManifestDigest: 'c'.repeat(64), mappings: {}, planToken: 'b'.repeat(64),
    planSnapshot: { actions: [], blockers: [] }, status: 'pending' as const, requestedBy: 7,
    requestedByUsername: 'admin', requestComment: 'Return to the reviewed baseline',
    requestedAt: '2026-09-13T12:00:00.000Z', decidedBy: null, decidedByUsername: null,
    decisionComment: null, decidedAt: null, appliedAt: null, updatedAt: '2026-09-13T12:00:00.000Z',
  };
  mockListRestores.mockResolvedValue([restoreRequest]);
  mockRequestRestore.mockResolvedValue(restoreRequest);
  mockDecideRestore.mockResolvedValue({ ...restoreRequest, status: 'approved', decidedBy: 8, decidedByUsername: 'reviewer', decisionComment: 'Reviewed and approved', decidedAt: '2026-09-13T12:05:00.000Z' });
  mockApplyRestore.mockResolvedValue({
    profile: { ...profile, revision: 3, source: 'imported' }, bundleIds: [3], compositeId: 9, groupBindings: [],
    restoreRequest: { ...restoreRequest, status: 'applied', decidedBy: 8, decidedByUsername: 'reviewer', decisionComment: 'Reviewed and approved', decidedAt: '2026-09-13T12:05:00.000Z', appliedAt: '2026-09-13T12:06:00.000Z' },
  });
});

describe('MCP Fabric profile routes', () => {
  it('lists profiles only for policy administrators', async () => {
    const listed = await request('/api/ui/mcp-fabric/profiles');
    expect(listed.status).toBe(200);
    expect(listed.body.groups).toEqual([{ name: 'engineering', memberCount: 2 }]);
    currentUser = { ...admin, role: 'viewer' };
    expect((await request('/api/ui/mcp-fabric/profiles')).status).toBe(403);
  });

  it('exports a secret-free snapshot and records only its digest and ids', async () => {
    const response = await request('/api/ui/mcp-fabric/profiles/export', 'POST', {
      name: 'platform-ops', label: 'Platform Ops', description: 'Shared baseline', version: '1.0.0', bundleIds: [3], createComposite: true,
      groupBindings: [{ logicalName: 'developers', required: true }],
    });
    expect(response.status).toBe(201);
    expect(mockExport).toHaveBeenCalledWith(pool, expect.objectContaining({
      bundleIds: [3], groupBindings: [{ logicalName: 'developers', required: true }], actor: 'admin',
      audit: expect.objectContaining({ actor: expect.objectContaining({ id: '7' }) }),
    }));
    expect(mockAudit.mock.calls.at(-1)?.[7]).toEqual(expect.objectContaining({ manifest_digest: 'a'.repeat(64), bundle_ids: [3] }));
  });

  it('requires same-origin preview and applies only the submitted plan token', async () => {
    sameOriginAllowed = false;
    expect((await request('/api/ui/mcp-fabric/profiles/import/preview', 'POST', { manifest })).status).toBe(403);
    expect(mockPlan).not.toHaveBeenCalled();
    sameOriginAllowed = true;
    const mappings = { groups: { developers: 'engineering' } };
    expect((await request('/api/ui/mcp-fabric/profiles/import/preview', 'POST', { manifest, mappings })).status).toBe(200);
    const result = await request('/api/ui/mcp-fabric/profiles/import/apply', 'POST', { manifest, mappings, planToken: 'b'.repeat(64) });
    expect(result.status).toBe(200);
    expect(mockApply).toHaveBeenCalledWith(pool, expect.objectContaining({
      planToken: 'b'.repeat(64), actor: 'admin', mappings,
    }));
    expect(refreshBackends).toHaveBeenCalled();
  });

  it('checks drift on demand without slowing the profile list', async () => {
    expect(mockDrift).not.toHaveBeenCalled();
    const result = await request('/api/ui/mcp-fabric/profiles/12/drift/check', 'POST');
    expect(result.status).toBe(200);
    expect(result.body.drift).toEqual(expect.objectContaining({ status: 'in_sync', profileId: 12 }));
    expect(mockDrift).toHaveBeenCalledWith(pool, 12, expect.objectContaining({
      actor: expect.objectContaining({ id: '7' }),
    }));
  });

  it('returns immutable revision history and a bounded server-side diff', async () => {
    const history = await request('/api/ui/mcp-fabric/profiles/12/versions');
    expect(history.status).toBe(200);
    expect(history.body.versions).toEqual([expect.objectContaining({ revision: 1, changeKind: 'created' })]);
    expect(mockVersions).toHaveBeenCalledWith(pool, 12);

    const compared = await request('/api/ui/mcp-fabric/profiles/12/versions/diff?from=1&to=2');
    expect(compared.status).toBe(200);
    expect(compared.body.diff).toEqual(expect.objectContaining({ counts: expect.objectContaining({ total: 1 }) }));
    expect(mockDiff).toHaveBeenCalledWith(pool, 12, 1, 2);
  });

  it('runs restore through request, independent decision and explicit apply endpoints', async () => {
    expect((await request('/api/ui/mcp-fabric/profiles/restores?profileId=12')).status).toBe(200);
    expect(mockListRestores).toHaveBeenCalledWith(pool, 12);

    const requested = await request('/api/ui/mcp-fabric/profiles/12/restores', 'POST', {
      targetRevision: 1, mappings: {}, planToken: 'b'.repeat(64), comment: 'Return to baseline',
    });
    expect(requested.status).toBe(201);
    expect(mockRequestRestore).toHaveBeenCalledWith(pool, expect.objectContaining({
      profileId: 12, targetRevision: 1, requestedBy: 7, requestedByUsername: 'admin', planToken: 'b'.repeat(64),
    }));

    currentUser = { ...admin, id: 8, username: 'reviewer' };
    const approved = await request('/api/ui/mcp-fabric/profiles/restores/4ed7e706-87f2-4b2d-8bb9-3784884bb9f2/decision', 'POST', {
      decision: 'approved', comment: 'Reviewed and approved',
    });
    expect(approved.status).toBe(200);
    expect(mockDecideRestore).toHaveBeenCalledWith(pool, expect.objectContaining({ actorId: 8, decision: 'approved' }));

    const applied = await request('/api/ui/mcp-fabric/profiles/restores/4ed7e706-87f2-4b2d-8bb9-3784884bb9f2/apply', 'POST');
    expect(applied.status).toBe(200);
    expect(mockApplyRestore).toHaveBeenCalledWith(pool, expect.objectContaining({ actor: 'reviewer' }));
    expect(refreshBackends).toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(pool, expect.anything(), 'restore_applied', 'mcp_fabric_profiles', '12', 'Platform Ops', null, expect.objectContaining({ new_head_revision: 3 }));
  });
});
