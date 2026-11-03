import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import {
  aiOpsServiceProfileReadinessSchema,
  aiOpsServiceProfileResourceSchema,
} from '../aiopsServiceProfileContracts.js';
import {
  AiOpsServiceProfileError,
  type AiOpsServiceProfileRecord,
} from '../aiopsServiceProfiles.js';
import {
  registerAiOpsServiceProfileRoutes,
  type AiOpsServiceProfileRouteDependencies,
} from '../aiopsServiceProfileRoutes.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/aiops-service-profiles',
  name,
), 'utf8'));

const profileResource = aiOpsServiceProfileResourceSchema.parse(
  fixture('service-profile-active.v1.fixture.json'),
);
const profile: AiOpsServiceProfileRecord = {
  id: profileResource.id,
  status: profileResource.status,
  activeRevision: profileResource.activeRevision,
  latestRevision: profileResource.latestRevision,
  createdAt: profileResource.createdAt,
  updatedAt: profileResource.updatedAt,
};
const readiness = aiOpsServiceProfileReadinessSchema.parse(
  fixture('profile-readiness-partial.v1.fixture.json'),
);
const baseUser: SessionUser = {
  id: 17,
  username: 'alex',
  display_name: 'Alex',
  role: 'developer',
  allowed_bundles: null,
  entra_groups: [],
};

const auditEvent = { eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as never;
const list = jest.fn<AiOpsServiceProfileRouteDependencies['list']>();
const get = jest.fn<AiOpsServiceProfileRouteDependencies['get']>();
const listRevisions = jest.fn<AiOpsServiceProfileRouteDependencies['listRevisions']>();
const create = jest.fn<AiOpsServiceProfileRouteDependencies['create']>();
const revise = jest.fn<AiOpsServiceProfileRouteDependencies['revise']>();
const validate = jest.fn<AiOpsServiceProfileRouteDependencies['validate']>();
const activate = jest.fn<AiOpsServiceProfileRouteDependencies['activate']>();
const setStatus = jest.fn<AiOpsServiceProfileRouteDependencies['setStatus']>();
const clone = jest.fn<AiOpsServiceProfileRouteDependencies['clone']>();
const evaluateReadiness = jest.fn<AiOpsServiceProfileRouteDependencies['evaluateReadiness']>();
const evaluateGlobalReadiness = jest.fn<AiOpsServiceProfileRouteDependencies['evaluateGlobalReadiness']>();
const listTags = jest.fn<AiOpsServiceProfileRouteDependencies['listTags']>();
const preflightQuery = jest.fn<AiOpsServiceProfileRouteDependencies['preflightQuery']>();
const auditQueryPreflight = jest.fn<AiOpsServiceProfileRouteDependencies['auditQueryPreflight']>();
const startInvestigation = jest.fn<AiOpsServiceProfileRouteDependencies['startInvestigation']>();
const auditInvestigationStart = jest.fn<AiOpsServiceProfileRouteDependencies['auditInvestigationStart']>();

let currentUser = baseUser;
let authenticated = true;
let sameOrigin = true;
let server: Server;
let baseUrl: string;

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    if (!sameOrigin) {
      res.status(403).json({ error: 'origin' });
      return;
    }
    next();
  };
  registerAiOpsServiceProfileRoutes(app, {} as pg.Pool, requireAuth, requireSameOrigin, {
    list,
    get,
    listRevisions,
    create,
    revise,
    validate,
    activate,
    setStatus,
    clone,
    evaluateReadiness,
    evaluateGlobalReadiness,
    loadPackReadiness: () => ({ state: 'ready', version: '0.3.0' }),
    listTags,
    preflightQuery,
    auditQueryPreflight,
    startInvestigation,
    auditInvestigationStart,
  });
  await new Promise<void>(resolveListen => { server = app.listen(0, '127.0.0.1', () => resolveListen()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolveClose, reject) => {
  server.close(error => error ? reject(error) : resolveClose());
}));

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  sameOrigin = true;
  currentUser = baseUser;
  list.mockResolvedValue([profile]);
  get.mockResolvedValue(profile);
  listRevisions.mockResolvedValue([profile.latestRevision]);
  listTags.mockResolvedValue([{ id: '2', label: 'payments', color: null }]);
  evaluateReadiness.mockResolvedValue(readiness);
  evaluateGlobalReadiness.mockResolvedValue({
    schemaVersion: 1,
    kind: 'aiops-readiness',
    state: 'ready',
    presentation: 'connected_summary',
    generatedAt: '2026-09-08T12:00:00.000Z',
    pack: { state: 'ready', version: '0.3.0' },
    eligibleBundleCount: 1,
    availableLanes: ['logs'],
    primaryConnection: {
      bundleId: 11,
      bundleName: 'observe-prod',
      lanes: ['logs'],
      certifiedTargetCount: 0,
      checkedAt: '2026-09-08T12:00:00.000Z',
    },
    profiles: { active: 0, ready: 0, degraded: 0, blocked: 0 },
    issues: [],
    recoveryActions: [],
  });
  preflightQuery.mockResolvedValue({
    schemaVersion: 1,
    kind: 'aiops-evidence-query-preflight',
    lane: 'logs',
    bundleId: 11,
    queryId: 'checkout-errors',
    toolName: 'elastic_search',
    generatedAt: '2026-09-08T12:01:00.000Z',
    state: 'succeeded',
    executed: true,
    request: { arguments: { index: 'logs-checkout-*' } },
    response: { preview: '{"hits":[]}', matchedDocuments: 0, durationMs: 12, resultBytes: 11, truncated: false },
  });
  startInvestigation.mockResolvedValue({
    schemaVersion: 1,
    kind: 'aiops-service-profile-investigation-started',
    profile: { id: profile.id, revision: profile.latestRevision.revision, sha256: profile.latestRevision.sha256 },
    resolvedContextSha256: 'c'.repeat(64),
    execution: { bundleIds: [11], toolNames: ['elastic_search'], resourceScope: null, service: 'checkout-api', environment: 'production' },
    rootTraceId: '3d6b6613-61cb-4fb4-9d13-f29d00692ea4',
    task: { id: 'task-41' },
  });
  create.mockResolvedValue({ value: { ...profile, status: 'draft', activeRevision: null }, auditEvent, replayed: false });
  revise.mockResolvedValue({ value: profile, auditEvent, replayed: false });
  validate.mockResolvedValue({
    value: {
      id: 5,
      profileId: profile.id,
      revision: profile.latestRevision.revision,
      profileSha256: profile.latestRevision.sha256,
      status: 'warning',
      readiness,
      validatedBy: { id: 17, username: 'alex' },
      validatedAt: '2026-09-08T12:00:00.000Z',
    },
    auditEvent,
    replayed: false,
  });
  activate.mockResolvedValue({ value: profile, auditEvent, replayed: false });
  setStatus.mockResolvedValue({ value: { ...profile, status: 'paused' }, auditEvent, replayed: false });
  clone.mockResolvedValue({ value: { ...profile, id: 42, status: 'draft', activeRevision: null }, auditEvent, replayed: false });
});

describe('AIOps service profile routes', () => {
  it('starts an investigation with only profile ID, signal and the authenticated principal', async () => {
    currentUser = { ...baseUser, allowed_bundles: [11, 18] };
    const response = await request(`/api/ui/observability/aiops/service-profiles/${profile.id}/investigations`, 'POST', {
      signal: { title: 'Checkout latency', summary: 'Latency increased.', keyword: 'deadline exceeded' },
    });

    expect(response).toMatchObject({ status: 202, body: { task: { id: 'task-41' } } });
    expect(startInvestigation).toHaveBeenCalledWith(expect.anything(), profile.id, {
      title: 'Checkout latency', summary: 'Latency increased.', severity: 'warning', keyword: 'deadline exceeded',
    }, { kind: 'user', id: '17', allowedBundleIds: [11, 18] });
    expect(auditInvestigationStart).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ rootTraceId: '3d6b6613-61cb-4fb4-9d13-f29d00692ea4' }),
      'Checkout latency',
    );
  });

  it('projects global readiness through the authorized bundle boundary', async () => {
    currentUser = { ...baseUser, allowed_bundles: [11] };
    const response = await request('/api/ui/observability/aiops/readiness');
    expect(response).toMatchObject({
      status: 200,
      body: { state: 'ready', presentation: 'connected_summary' },
    });
    expect(evaluateGlobalReadiness).toHaveBeenCalledWith(expect.anything(), {
      allowedBundleIds: [11],
      pack: { state: 'ready', version: '0.3.0' },
    });
  });

  it('returns shared tags and caller-specific actions', async () => {
    currentUser = { ...baseUser, role: 'viewer' };
    const response = await request('/api/ui/observability/aiops/service-profiles');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      kind: 'aiops-service-profile-list',
      profiles: [{ id: 41, tags: [{ label: 'payments', color: null }], allowedActions: ['read'] }],
    });
  });

  it('lets a developer create a draft but does not expose activation', async () => {
    const response = await request('/api/ui/observability/aiops/service-profiles', 'POST', {
      config: profile.latestRevision.config,
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      profile: {
        status: 'draft',
        allowedActions: expect.arrayContaining(['read', 'edit', 'validate', 'clone', 'archive']),
      },
      replayed: false,
    });
    expect((response.body['profile'] as { allowedActions: string[] }).allowedActions).not.toContain('activate');
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      profile.latestRevision.config,
      { id: 17, username: 'alex' },
      expect.objectContaining({ actor: expect.objectContaining({ id: '17' }) }),
    );
  });

  it('enforces activation as an operations permission', async () => {
    const body = { revision: 3, expectedLatestRevision: 3 };
    expect((await request('/api/ui/observability/aiops/service-profiles/41/activate', 'POST', body)).status)
      .toBe(403);

    currentUser = { ...baseUser, role: 'operations_admin' };
    expect((await request('/api/ui/observability/aiops/service-profiles/41/activate', 'POST', body)).status)
      .toBe(200);
    expect(activate).toHaveBeenCalledWith(expect.anything(), 41, 3, 3, expect.anything());
  });

  it('enforces the callers SSO bundle boundary on profile mutations and validation', async () => {
    currentUser = { ...baseUser, allowed_bundles: [99] };
    const createResponse = await request('/api/ui/observability/aiops/service-profiles', 'POST', {
      config: profile.latestRevision.config,
    });
    expect(createResponse).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden' } },
    });
    expect(create).not.toHaveBeenCalled();

    const validateResponse = await request('/api/ui/observability/aiops/service-profiles/41/validate', 'POST', {
      expectedLatestRevision: 3,
    });
    expect(validateResponse).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden' } },
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('preflights a bounded evidence query inside the callers bundle boundary', async () => {
    currentUser = { ...baseUser, allowed_bundles: [11] };
    const body = {
      bundleId: 11,
      lane: 'logs',
      query: {
        id: 'checkout-errors',
        toolName: 'elastic_search',
        template: '{"index":"logs-checkout-*","query":"${service.name}"}',
      },
      context: {
        serviceName: 'checkout-api',
        environment: 'production',
        windowStart: '2026-09-08T11:30:00.000Z',
        windowEnd: '2026-09-08T12:00:00.000Z',
      },
      execute: true,
    };
    const response = await request('/api/ui/observability/aiops/evidence-query-preflight', 'POST', body);

    expect(response).toMatchObject({ status: 200, body: { state: 'succeeded', toolName: 'elastic_search' } });
    expect(preflightQuery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bundleId: 11, execute: true }));
    expect(auditQueryPreflight).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ state: 'succeeded' }));

    currentUser = { ...baseUser, allowed_bundles: [99] };
    expect((await request('/api/ui/observability/aiops/evidence-query-preflight', 'POST', body)).status).toBe(403);
  });

  it('evaluates and persists readiness for the exact optimistic revision', async () => {
    const response = await request('/api/ui/observability/aiops/service-profiles/41/validate', 'POST', {
      expectedLatestRevision: 3,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      validation: { profileId: 41, status: 'warning' },
      readiness: { state: 'degraded' },
    });
    expect(evaluateReadiness).toHaveBeenCalledWith(expect.anything(), profile);
    expect(validate).toHaveBeenCalledWith(
      expect.anything(), readiness, { id: 17, username: 'alex' }, expect.anything(),
    );
  });

  it('rejects malformed and stale mutation requests before side effects', async () => {
    const malformed = await request('/api/ui/observability/aiops/service-profiles', 'POST', {
      config: profile.latestRevision.config,
      unexpected: true,
    });
    expect(malformed).toMatchObject({
      status: 400,
      body: { kind: 'aiops-service-profile-error', error: { code: 'validation_failed' } },
    });
    expect(create).not.toHaveBeenCalled();

    revise.mockRejectedValueOnce(new AiOpsServiceProfileError(
      409,
      'revision_conflict',
      'The AIOps service profile has a newer revision',
    ));
    const stale = await request('/api/ui/observability/aiops/service-profiles/41', 'PATCH', {
      expectedLatestRevision: 2,
      config: profile.latestRevision.config,
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { error: { code: 'revision_conflict' } },
    });
  });

  it('requires authentication and same-origin protection', async () => {
    authenticated = false;
    expect((await request('/api/ui/observability/aiops/service-profiles')).status).toBe(401);
    authenticated = true;
    sameOrigin = false;
    expect((await request('/api/ui/observability/aiops/service-profiles', 'POST', {
      config: profile.latestRevision.config,
    })).status).toBe(403);
  });
});
