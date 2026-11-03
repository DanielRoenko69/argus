import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { AuthenticatedRequest } from '../../auth/sessionMiddleware.js';
import type { SessionUser } from '../../auth/userAuth.js';
import type { AuditCheckpointScope, AuditCheckpointSigner, CreateAuditCheckpointOptions } from '../checkpoints.js';
import type { AuditEvidencePackInput, AuditEvidencePackV1 } from '../evidencePack.js';
import type { CanonicalAuditActor } from '../canonicalAuditTypes.js';
import { registerAuditEvidenceRoutes } from '../evidenceRoutes.js';
import type { AuditEvidencePage } from '../evidenceTypes.js';

const page: AuditEvidencePage = {
  schemaVersion: 1,
  generatedAt: '2026-09-08T00:00:00.000Z',
  verification: {
    state: 'not_applicable', chainContinuity: 'not_evaluated_for_filtered_page',
    checkpointId: null, checkedAt: '2026-09-08T00:00:00.000Z',
  },
  coverage: {
    canonicalProducerFamilies: [
      'tags',
      'access.user_lifecycle',
      'access.api_key_lifecycle',
      'access.policy_management',
      'access.sso_identity',
      'approval.runtime',
      'approval.workflow',
      'risk_policy.external_filter',
    ],
    legacyGaps: [],
  },
  items: [],
  nextCursor: null,
  export: { allowed: false, state: 'not_authorized', formats: [], requiresStepUp: false },
};

const users: Record<string, SessionUser> = {
  developer: {
    id: 17, username: 'oidc:subject-17', display_name: 'Developer', role: 'developer',
    allowed_bundles: null, entra_groups: [],
  },
  viewer: {
    id: 18, username: 'viewer', display_name: 'Viewer', role: 'viewer',
    allowed_bundles: null, entra_groups: [],
  },
  operations_admin: {
    id: 19, username: 'ops', display_name: 'Operations admin', role: 'operations_admin',
    allowed_bundles: null, entra_groups: [],
  },
  platform_admin: {
    id: 20, username: 'oidc:platform-admin', display_name: 'Platform admin', role: 'platform_admin',
    allowed_bundles: null, entra_groups: [], auth_method: 'oidc',
    mfa_verified_at: '2026-09-08T11:59:00.000Z', mfa_method: 'webauthn',
  },
};

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function request(
  role: keyof typeof users,
  options: Parameters<typeof registerAuditEvidenceRoutes>[3],
  headers: Record<string, string> = {},
  user: SessionUser = users[role]!,
) {
  const app = express();
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).user = user;
    next();
  });
  registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), options);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return fetch(`http://127.0.0.1:${port}/api/ui/audit/evidence/v1?actor_id=17&limit=25`, { headers });
}

async function checkpointRequest(
  role: keyof typeof users,
  options: Parameters<typeof registerAuditEvidenceRoutes>[3],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).user = users[role];
    next();
  });
  registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), options);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return fetch(`http://127.0.0.1:${port}/api/ui/audit/checkpoints/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environment: 'production' }),
  });
}

describe('audit evidence routes', () => {
  let load: jest.Mock;

  beforeEach(() => {
    load = jest.fn(async () => page);
  });

  it('returns a private uncached page with server-resolved scope and export policy', async () => {
    const response = await request('operations_admin', {
      enabled: true,
      load: load as never,
      resolveScopes: () => [{ workspaceKey: 'workspace-1', tenantKey: 'tenant-1' }],
      now: () => new Date('2026-09-08T00:00:00.000Z'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(load).toHaveBeenCalledWith(
      expect.anything(),
      [{ workspaceKey: 'workspace-1', tenantKey: 'tenant-1' }],
      expect.objectContaining({ actorId: '17', limit: 25 }),
      { canExport: true, hasFreshMfa: false, now: new Date('2026-09-08T00:00:00.000Z') },
    );
  });

  it('fails closed behind the feature flag', async () => {
    const response = await request('developer', { enabled: false, load: load as never });
    expect(response.status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });

  it('enforces audit.read independently of feature visibility', async () => {
    const response = await request('viewer', { enabled: true, load: load as never });
    expect(response.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects malformed filters before querying the store', async () => {
    const app = express();
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.developer; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true, load: load as never,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/evidence/v1?tag=not-an-id`);
    expect(response.status).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });

  it('creates a checkpoint only for an export-authorized user and server-resolved scope', async () => {
    const sameOrigin = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const createCheckpoint = jest.fn(async (
      _pool: pg.Pool,
      scope: AuditCheckpointScope,
      _signer: AuditCheckpointSigner,
      _options?: CreateAuditCheckpointOptions,
    ) => ({
      checkpointId: '2649d858-3d64-465c-9cc4-87b8656a8630', schemaVersion: 1 as const,
      ...scope, lastSequence: 9, lastEventId: '2d0e96dc-ff2b-4366-9d53-3a3e88ec0073',
      lastEventHash: 'a'.repeat(64), previousCheckpointId: null, previousCheckpointDigest: '',
      createdAt: '2026-09-08T00:00:00.000Z', algorithm: 'Ed25519' as const,
      keyId: 'key-1', publicKeyFingerprint: 'b'.repeat(64), checkpointDigest: 'c'.repeat(64),
      signature: 'signature', replayed: false,
    }));
    const response = await checkpointRequest('operations_admin', {
      enabled: true,
      signer: { keyId: 'key-1' } as AuditCheckpointSigner,
      requireSameOrigin: sameOrigin as never,
      resolveScopes: () => [{ workspaceKey: 'workspace-1', tenantKey: 'tenant-1' }],
      createCheckpoint: createCheckpoint as never,
      now: () => new Date('2026-09-08T00:00:00.000Z'),
    });
    expect(response.status).toBe(201);
    expect(sameOrigin).toHaveBeenCalled();
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' },
      expect.objectContaining({ keyId: 'key-1' }),
      { now: expect.any(Function) },
    );
  });

  it('fails closed when checkpoint signing is not configured', async () => {
    const response = await checkpointRequest('operations_admin', { enabled: true, signer: null });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'AUDIT_SIGNING_NOT_CONFIGURED' });
  });

  it('does not let a developer create signed checkpoints', async () => {
    const createCheckpoint = jest.fn();
    const response = await checkpointRequest('developer', {
      enabled: true,
      signer: { keyId: 'key-1' } as AuditCheckpointSigner,
      createCheckpoint: createCheckpoint as never,
    });
    expect(response.status).toBe(403);
    expect(createCheckpoint).not.toHaveBeenCalled();
  });

  it('exports a generated evidence pack and records the privileged read before responding', async () => {
    const exported = {
      schemaVersion: 1,
      kind: 'argus.audit.evidence-pack',
      manifest: { packId: '6c6d9262-22b8-45b5-b2e3-bab7a8879010' },
      packDigest: 'a'.repeat(64),
    } as unknown as AuditEvidencePackV1;
    const createEvidencePack = jest.fn(async (_pool: pg.Pool, _input: AuditEvidencePackInput) => exported);
    const recordEvidencePackExport = jest.fn(async (
      _pool: pg.Pool,
      _pack: AuditEvidencePackV1,
      _actor: CanonicalAuditActor,
      _producerEventId: string,
    ) => ({ replayed: false, eventId: 'event-1' }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.operations_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true,
      requireFreshMfa: (_req, _res, next) => next(),
      resolveScopes: () => [{ workspaceKey: 'workspace-1', tenantKey: 'tenant-1' }],
      createEvidencePack: createEvidencePack as never,
      recordEvidencePackExport: recordEvidencePackExport as never,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/evidence-packs/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'export-request-1' },
      body: JSON.stringify({ environment: 'production', resource_type: 'workflow', resource_id: '161' }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('content-disposition')).toContain(exported.manifest.packId);
    expect(createEvidencePack).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production',
      resourceType: 'workflow', resourceId: '161',
    }));
    expect(recordEvidencePackExport).toHaveBeenCalledWith(
      expect.anything(), exported, expect.objectContaining({ id: '19' }), 'export-request-1',
    );
  });

  it('returns the same opaque not-found response for an unauthorized scope selector', async () => {
    const user: SessionUser = {
      ...users.operations_admin!,
      workspace_scopes: [{ tenantKey: 'tenant-a', workspaceKey: 'workspace-1', isDefault: true }],
    };
    const response = await request('operations_admin', { enabled: true, load: load as never }, {
      'x-argus-tenant-key': 'tenant-b',
      'x-argus-workspace-key': 'workspace-1',
    }, user);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Workspace scope was not found.',
      code: 'WORKSPACE_SCOPE_NOT_FOUND',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('enforces fresh MFA before an evidence pack is generated', async () => {
    const createEvidencePack = jest.fn();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.operations_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true,
      requireFreshMfa: (_req, res) => { res.status(428).json({ code: 'MFA_STEP_UP_REQUIRED' }); },
      resolveScopes: () => [{ workspaceKey: 'workspace-1', tenantKey: 'tenant-1' }],
      createEvidencePack: createEvidencePack as never,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/evidence-packs/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ environment: 'production' }),
    });
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ code: 'MFA_STEP_UP_REQUIRED' });
    expect(createEvidencePack).not.toHaveBeenCalled();
  });

  it('keeps audit-retention governance out of the developer role', async () => {
    const createRetentionPolicy = jest.fn();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.developer; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true,
      createRetentionPolicy: createRetentionPolicy as never,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/retention-policies/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'retention-1' },
      body: JSON.stringify({ environment: 'production', retention_class: 'standard', duration_days: 365, region: 'eu' }),
    });
    expect(response.status).toBe(403);
    expect(createRetentionPolicy).not.toHaveBeenCalled();
  });

  it('rejects malformed legal-hold UUIDs before invoking persistence', async () => {
    const placeLegalHold = jest.fn();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.operations_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true,
      placeLegalHold: placeLegalHold as never,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/legal-holds/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'hold-1' },
      body: JSON.stringify({ environment: 'production', hold_id: 'not-a-uuid', justification: 'legal basis' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'hold_id must be a UUID' });
    expect(placeLegalHold).not.toHaveBeenCalled();
  });

  it('rejects an inverted legal-hold sequence range before invoking persistence', async () => {
    const placeLegalHold = jest.fn();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.operations_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true,
      placeLegalHold: placeLegalHold as never,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/legal-holds/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'hold-range-1' },
      body: JSON.stringify({ environment: 'production', from_sequence: 9, through_sequence: 2, justification: 'legal basis' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'through_sequence must be null or at least from_sequence' });
    expect(placeLegalHold).not.toHaveBeenCalled();
  });

  it('creates only a signed dry-run retention plan behind named permission, same-origin and fresh MFA', async () => {
    const sameOrigin = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const freshMfa = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const createCheckpoint = jest.fn(async (..._args: unknown[]) => ({
      checkpointId: '10000000-0000-4000-8000-000000000001', checkpointDigest: 'c'.repeat(64),
      lastSequence: 12,
    }));
    const createRetentionPlan = jest.fn(async (..._args: unknown[]) => ({
      plan: { planId: '20000000-0000-4000-8000-000000000002', eligiblePrefixCount: 7, manifest: { purgeAllowed: false } },
      replayed: false, auditEvent: { eventId: 'event-1' },
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.platform_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true, signer: { keyId: 'key-1', publicKeyPem: 'public-key' } as AuditCheckpointSigner,
      requireSameOrigin: sameOrigin as never, requireFreshMfa: freshMfa as never,
      resolveScopes: () => [{ workspaceKey: 'workspace-1', tenantKey: 'tenant-1' }],
      createCheckpoint: createCheckpoint as never, createRetentionPlan: createRetentionPlan as never,
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/retention-plans/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'retention-plan-1' },
      body: JSON.stringify({ environment: 'production', batch_limit: 250 }),
    });
    expect(response.status).toBe(201);
    expect(sameOrigin).toHaveBeenCalled(); expect(freshMfa).toHaveBeenCalled();
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.anything(), { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' },
      expect.objectContaining({ keyId: 'key-1' }), { now: expect.any(Function) },
    );
    expect(createRetentionPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' },
        producerEventId: 'retention-plan-1', mfaMethod: 'webauthn',
      }),
      expect.objectContaining({ checkpoint: expect.objectContaining({ lastSequence: 12 }), publicKeyPem: 'public-key' }),
      250,
    );
  });

  it('does not evaluate retention candidates when fresh MFA fails', async () => {
    const createCheckpoint = jest.fn(); const createRetentionPlan = jest.fn();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.platform_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true, signer: { keyId: 'key-1' } as AuditCheckpointSigner,
      requireFreshMfa: (_req, res) => { res.status(428).json({ code: 'MFA_STEP_UP_REQUIRED' }); },
      createCheckpoint: createCheckpoint as never, createRetentionPlan: createRetentionPlan as never,
    });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/retention-plans/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'retention-plan-2' },
      body: JSON.stringify({ environment: 'production' }),
    });
    expect(response.status).toBe(428);
    expect(createCheckpoint).not.toHaveBeenCalled(); expect(createRetentionPlan).not.toHaveBeenCalled();
  });

  it('routes an approved plan through the configured WORM provider with fresh MFA', async () => {
    const sameOrigin = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const freshMfa = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const archiveRetentionPlan = jest.fn(async (..._args: unknown[]) => ({
      archive: { archiveId: '30000000-0000-4000-8000-000000000003', planId: '10000000-0000-4000-8000-000000000001' },
      replayed: false, auditEvent: { eventId: '40000000-0000-4000-8000-000000000004' },
    }));
    const provider = { name: 'customer-worm', supportedKinds: ['worm_object'], anchor: jest.fn() };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.platform_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true, requireSameOrigin: sameOrigin as never, requireFreshMfa: freshMfa as never,
      resolveScopes: () => [{ workspaceKey: 'workspace-1', tenantKey: 'tenant-1' }],
      archiveRetentionPlan: archiveRetentionPlan as never, externalArchiveProvider: provider as never,
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/retention-plans/v1/10000000-0000-4000-8000-000000000001/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'archive-request-1' },
      body: JSON.stringify({ environment: 'production', justification: 'Independent archive execution after approval.' }),
    });
    expect(response.status).toBe(201); expect(sameOrigin).toHaveBeenCalled(); expect(freshMfa).toHaveBeenCalled();
    expect(archiveRetentionPlan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' },
      producerEventId: 'archive-request-1', mfaMaxAgeSeconds: 600,
    }), '10000000-0000-4000-8000-000000000001', provider);
  });

  it('runs a full restore drill behind its dedicated permission, same-origin and fresh MFA', async () => {
    const sameOrigin = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const freshMfa = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const runRetentionRestoreDrill = jest.fn(async (..._args: unknown[]) => ({
      drill: { drillId: '30000000-0000-4000-8000-000000000003', archiveId: '10000000-0000-4000-8000-000000000001', verificationStatus: 'verified' },
      replayed: false, auditEvent: { eventId: '40000000-0000-4000-8000-000000000004' },
    }));
    const provider = {
      name: 'customer-worm', supportedKinds: ['worm_object'], anchor: jest.fn(),
      retrieveArchive: jest.fn(), verifyStoredReceipt: jest.fn(),
    };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.platform_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true, requireSameOrigin: sameOrigin as never, requireFreshMfa: freshMfa as never,
      resolveScopes: () => [{ workspaceKey: 'workspace-1', tenantKey: 'tenant-1' }],
      runRetentionRestoreDrill: runRetentionRestoreDrill as never, externalArchiveProvider: provider as never,
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/retention-archives/v1/10000000-0000-4000-8000-000000000001/restore-drills`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'restore-drill-request-1' },
      body: JSON.stringify({ environment: 'production', justification: 'Quarterly independent recovery test.' }),
    });
    expect(response.status).toBe(201); expect(sameOrigin).toHaveBeenCalled(); expect(freshMfa).toHaveBeenCalled();
    expect(runRetentionRestoreDrill).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' },
      producerEventId: 'restore-drill-request-1', mfaMaxAgeSeconds: 600,
    }), '10000000-0000-4000-8000-000000000001', provider);
  });

  it('downloads the dependency-free offline verifier as a protected audit export', async () => {
    const app = express();
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.platform_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true, loadRetentionVerifier: async () => Buffer.from('#!/usr/bin/env node\nVERIFIER_V1\n'),
    });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/retention-verifier/v1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('argus-audit-retention-verifier.mjs');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toContain('VERIFIER_V1');
  });

  it('seals a restored archive boundary behind same-origin and fresh MFA', async () => {
    const sameOrigin = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const freshMfa = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const sealRetentionSegment = jest.fn(async (..._args: unknown[]) => ({
      segment: { segmentId: '30000000-0000-4000-8000-000000000003', archiveId: '10000000-0000-4000-8000-000000000001', segmentOrdinal: 1 },
      replayed: false, auditEvent: { eventId: '40000000-0000-4000-8000-000000000004' },
    }));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).user = users.platform_admin; next(); });
    registerAuditEvidenceRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
      enabled: true, requireSameOrigin: sameOrigin as never, requireFreshMfa: freshMfa as never,
      resolveScopes: () => [{ workspaceKey: 'workspace-1', tenantKey: 'tenant-1' }], sealRetentionSegment: sealRetentionSegment as never,
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/retention-archives/v1/10000000-0000-4000-8000-000000000001/seal-segment`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'segment-seal-1' },
      body: JSON.stringify({ environment: 'production', justification: 'Verified independent restore before sealing.' }),
    });
    expect(response.status).toBe(201); expect(sameOrigin).toHaveBeenCalled(); expect(freshMfa).toHaveBeenCalled();
    expect(sealRetentionSegment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' }, producerEventId: 'segment-seal-1',
    }), '10000000-0000-4000-8000-000000000001');
  });
});
