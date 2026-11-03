import type { Express, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { evaluatePermission } from '../auth/effectiveAccess.js';
import { requirePermission, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import type { SessionUser } from '../auth/userAuth.js';
import { hasFreshMfaSession } from '../auth/userAuth.js';
import {
  auditScopesForUser,
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import {
  createAuditEvidencePack,
  recordAuditEvidencePackExport,
  type AuditEvidencePackInput,
  type AuditEvidencePackV1,
} from './evidencePack.js';
import {
  createAuditRetentionPolicy,
  placeAuditLegalHold,
  releaseAuditLegalHold,
  type AuditGovernanceMutationContext,
} from './retention.js';
import {
  createAuditRetentionPlan,
  decideAuditRetentionPlan,
  listAuditRetentionPlans,
  MAX_RETENTION_PLAN_EVENTS,
  type RetentionLifecycleContext,
} from './retentionLifecycle.js';
import {
  archiveAuditRetentionPlan,
  listAuditRetentionArchives,
  type RetentionArchiveContext,
} from './retentionArchiveService.js';
import {
  listAuditRetentionRestoreDrills,
  runAuditRetentionRestoreDrill,
  type RetentionRestoreDrillContext,
} from './retentionRestoreDrillService.js';
import {
  listAuditRetentionChainSegments,
  sealAuditRetentionChainSegment,
  type RetentionSegmentContext,
} from './retentionSegmentService.js';
import {
  AUDIT_RETENTION_VERIFIER_FILENAME,
  loadAuditRetentionVerifierSource,
} from './retentionVerifierAsset.js';
import type { ExternalEvidenceAnchorProvider } from './externalAnchorProvider.js';
import type { CanonicalAuditActor } from './canonicalAuditTypes.js';
import {
  createCanonicalAuditCheckpoint,
  loadLatestCanonicalAuditCheckpointEnvelope,
  verifyAuditCheckpointSignature,
  verifyCanonicalAuditCheckpoint,
  type AuditCheckpointEnvelope,
  type AuditCheckpointScope,
  type AuditCheckpointSigner,
  type AuditCheckpointVerification,
  type CanonicalAuditCheckpoint,
  type CreateAuditCheckpointOptions,
} from './checkpoints.js';
import { loadAuditEvidencePage, type AuditEvidencePageOptions } from './evidenceStore.js';
import type { AuditEvidencePage, AuditEvidenceQuery, AuditEvidenceScope } from './evidenceTypes.js';
import { AuditEvidenceValidationError, parseAuditEvidenceQuery } from './evidenceValidation.js';

export interface AuditEvidenceRouteOptions {
  enabled: boolean;
  requireSameOrigin?: RequestHandler;
  requireFreshMfa?: RequestHandler;
  mfaMaxAgeSeconds?: number;
  signer?: AuditCheckpointSigner | null;
  load?: (
    pool: pg.Pool,
    scopes: AuditEvidenceScope[],
    query: AuditEvidenceQuery,
    options: AuditEvidencePageOptions,
  ) => Promise<AuditEvidencePage>;
  resolveScopes?: (user: SessionUser, req?: Parameters<RequestHandler>[0]) => AuditEvidenceScope[];
  now?: () => Date;
  createCheckpoint?: (
    pool: pg.Pool,
    scope: AuditCheckpointScope,
    signer: AuditCheckpointSigner,
    options?: CreateAuditCheckpointOptions,
  ) => Promise<CanonicalAuditCheckpoint>;
  loadCheckpoint?: (pool: pg.Pool, scope: AuditCheckpointScope) => Promise<AuditCheckpointEnvelope | null>;
  verifyCheckpoint?: (pool: pg.Pool, checkpointId: string, checkedAt?: Date) => Promise<AuditCheckpointVerification>;
  createEvidencePack?: (pool: pg.Pool, input: AuditEvidencePackInput) => Promise<AuditEvidencePackV1>;
  recordEvidencePackExport?: typeof recordAuditEvidencePackExport;
  createRetentionPolicy?: typeof createAuditRetentionPolicy;
  placeLegalHold?: typeof placeAuditLegalHold;
  releaseLegalHold?: typeof releaseAuditLegalHold;
  createRetentionPlan?: typeof createAuditRetentionPlan;
  decideRetentionPlan?: typeof decideAuditRetentionPlan;
  listRetentionPlans?: typeof listAuditRetentionPlans;
  archiveRetentionPlan?: typeof archiveAuditRetentionPlan;
  listRetentionArchives?: typeof listAuditRetentionArchives;
  runRetentionRestoreDrill?: typeof runAuditRetentionRestoreDrill;
  listRetentionRestoreDrills?: typeof listAuditRetentionRestoreDrills;
  sealRetentionSegment?: typeof sealAuditRetentionChainSegment;
  listRetentionSegments?: typeof listAuditRetentionChainSegments;
  loadRetentionVerifier?: typeof loadAuditRetentionVerifierSource;
  externalArchiveProvider?: ExternalEvidenceAnchorProvider | null;
}

function defaultScopes(user: SessionUser, req?: Parameters<RequestHandler>[0]): AuditEvidenceScope[] {
  if (req?.header('x-argus-tenant-key') || req?.header('x-argus-workspace-key')) {
    return [resolveAuthorizedWorkspaceScope(req, user)];
  }
  return auditScopesForUser(user);
}

function rejectUnauthorizedScope(res: Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceScopeAccessError)) return false;
  res.status(error.status).json({ error: error.message, code: error.code });
  return true;
}

function environment(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/.test(normalized)) {
    throw new AuditEvidenceValidationError('environment is required and must be a valid identifier');
  }
  return normalized;
}

function optionalBodyString(value: unknown, name: string, max: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new AuditEvidenceValidationError(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function requiredBodyString(value: unknown, name: string, max: number): string {
  const normalized = optionalBodyString(value, name, max);
  if (!normalized) throw new AuditEvidenceValidationError(`${name} is required`);
  return normalized;
}

function uuidBody(value: unknown, name: string): string {
  const normalized = requiredBodyString(value, name, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new AuditEvidenceValidationError(`${name} must be a UUID`);
  }
  return normalized;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value == null || value === '') return undefined;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new AuditEvidenceValidationError(`${name} must be a positive integer`);
  }
  return normalized;
}

function requestBody(req: Parameters<RequestHandler>[0]): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function idempotencyKey(req: Parameters<RequestHandler>[0]): string {
  const raw = req.header('Idempotency-Key');
  return requiredBodyString(raw, 'Idempotency-Key', 256);
}

function actorFor(user: SessionUser): CanonicalAuditActor {
  const sso = user.auth_method === 'oidc' || /^(?:oidc|entra)[:|]/i.test(user.username);
  return {
    type: 'human',
    id: String(user.id),
    ssoSubject: sso ? user.username : null,
    authMethod: sso ? 'oidc' : 'session',
    effectiveRoles: [user.role],
  };
}

function retentionContext(
  user: SessionUser,
  scope: AuditEvidenceScope,
  environmentName: string,
  producerEventId: string,
  now?: () => Date,
): RetentionLifecycleContext {
  return {
    scope: { ...scope, environment: environmentName }, actor: actorFor(user),
    mfaVerifiedAt: user.mfa_verified_at ?? '', mfaMethod: user.mfa_method ?? '',
    producerEventId, now,
  };
}

function governanceContext(
  user: SessionUser,
  scope: AuditEvidenceScope,
  environmentName: string,
  producerEventId: string,
  now?: () => Date,
): AuditGovernanceMutationContext {
  return {
    scope: { ...scope, environment: environmentName },
    actor: actorFor(user),
    producerEventId,
    now,
  };
}

export function registerAuditEvidenceRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  options: AuditEvidenceRouteOptions,
): void {
  const load = options.load ?? loadAuditEvidencePage;
  const resolveScopes = options.resolveScopes ?? defaultScopes;
  const sameOrigin = options.requireSameOrigin ?? ((_req, _res, next) => next());
  const freshMfa = options.requireFreshMfa ?? ((_req, res) => {
    res.status(503).json({ error: 'MFA step-up enforcement is not configured', code: 'MFA_STEP_UP_UNAVAILABLE' });
  });
  const mfaMaxAgeSeconds = options.mfaMaxAgeSeconds ?? 600;
  const createCheckpoint = options.createCheckpoint ?? createCanonicalAuditCheckpoint;
  const loadCheckpoint = options.loadCheckpoint ?? loadLatestCanonicalAuditCheckpointEnvelope;
  const verifyCheckpoint = options.verifyCheckpoint ?? verifyCanonicalAuditCheckpoint;
  const createPack = options.createEvidencePack ?? createAuditEvidencePack;
  const recordPackExport = options.recordEvidencePackExport ?? recordAuditEvidencePackExport;
  const createRetention = options.createRetentionPolicy ?? createAuditRetentionPolicy;
  const placeHold = options.placeLegalHold ?? placeAuditLegalHold;
  const releaseHold = options.releaseLegalHold ?? releaseAuditLegalHold;
  const createLifecyclePlan = options.createRetentionPlan ?? createAuditRetentionPlan;
  const decideLifecyclePlan = options.decideRetentionPlan ?? decideAuditRetentionPlan;
  const listLifecyclePlans = options.listRetentionPlans ?? listAuditRetentionPlans;
  const archiveLifecyclePlan = options.archiveRetentionPlan ?? archiveAuditRetentionPlan;
  const listLifecycleArchives = options.listRetentionArchives ?? listAuditRetentionArchives;
  const runRestoreDrill = options.runRetentionRestoreDrill ?? runAuditRetentionRestoreDrill;
  const listRestoreDrills = options.listRetentionRestoreDrills ?? listAuditRetentionRestoreDrills;
  const sealRetentionSegment = options.sealRetentionSegment ?? sealAuditRetentionChainSegment;
  const listRetentionSegments = options.listRetentionSegments ?? listAuditRetentionChainSegments;
  const loadRetentionVerifier = options.loadRetentionVerifier ?? loadAuditRetentionVerifierSource;
  app.get(
    '/api/ui/audit/evidence/v1',
    requireAuth,
    requirePermission('audit.read'),
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const query = parseAuditEvidenceQuery(req.query as Record<string, unknown>);
        const now = options.now?.() ?? new Date();
        const page = await load(pool, resolveScopes(user, req), query, {
          canExport: evaluatePermission({ role: user.role }, 'audit.export').allowed,
          hasFreshMfa: hasFreshMfaSession(user, mfaMaxAgeSeconds, now),
          now,
        });
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(page);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Canonical audit evidence request failed');
        res.status(500).json({ error: 'Audit evidence could not be loaded' });
      }
    },
  );

  app.get(
    '/api/ui/audit/checkpoints/v1/latest',
    requireAuth,
    requirePermission('audit.read'),
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const scope = { ...scopes[0]!, environment: environment(req.query['environment']) };
        const envelope = await loadCheckpoint(pool, scope);
        res.setHeader('Cache-Control', 'private, no-store');
        if (!envelope) {
          res.status(404).json({ error: 'No signed checkpoint exists for this scope' });
          return;
        }
        res.json({
          checkpoint: envelope.checkpoint,
          signatureState: verifyAuditCheckpointSignature(envelope.checkpoint, envelope.publicKeyPem) ? 'valid' : 'invalid',
        });
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Canonical audit checkpoint read failed');
        res.status(500).json({ error: 'Audit checkpoint could not be loaded' });
      }
    },
  );

  app.post(
    '/api/ui/audit/checkpoints/v1',
    requireAuth,
    requirePermission('audit.export'),
    sameOrigin,
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (!options.signer) {
        res.status(503).json({
          error: 'Audit checkpoint signing is not configured',
          code: 'AUDIT_SIGNING_NOT_CONFIGURED',
        });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? req.body as Record<string, unknown>
          : {};
        const scope = { ...scopes[0]!, environment: environment(body['environment']) };
        const checkpoint = await createCheckpoint(pool, scope, options.signer, { now: options.now });
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(checkpoint.replayed ? 200 : 201).json({ checkpoint });
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Canonical audit checkpoint creation failed');
        res.status(500).json({ error: 'Audit checkpoint could not be created' });
      }
    },
  );

  app.post(
    '/api/ui/audit/checkpoints/v1/:checkpointId/verify',
    requireAuth,
    requirePermission('audit.export'),
    sameOrigin,
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      try {
        const rawCheckpointId = req.params['checkpointId'];
        const result = await verifyCheckpoint(
          pool,
          typeof rawCheckpointId === 'string' ? rawCheckpointId : '',
          options.now?.(),
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.state === 'not_found' ? 404 : result.state === 'invalid' ? 409 : 200).json(result);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        logger.error({ err: error }, 'Canonical audit checkpoint verification failed');
        res.status(400).json({ error: error instanceof Error ? error.message : 'Audit checkpoint verification failed' });
      }
    },
  );

  app.get(
    '/api/ui/audit/retention-verifier/v1',
    requireAuth,
    requirePermission('audit.export'),
    async (_req, res) => {
      if (!options.enabled) { res.status(404).json({ error: 'Not found' }); return; }
      try {
        const source = await loadRetentionVerifier();
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${AUDIT_RETENTION_VERIFIER_FILENAME}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.status(200).send(source);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        logger.error({ err: error }, 'Offline audit retention verifier could not be loaded');
        res.status(500).json({ error: 'Offline audit retention verifier is unavailable' });
      }
    },
  );

  app.get(
    '/api/ui/audit/retention-plans/v1',
    requireAuth,
    requirePermission('audit.retention_manage'),
    async (req, res) => {
      if (!options.enabled) { res.status(404).json({ error: 'Not found' }); return; }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const environmentName = environment(req.query['environment']);
        const plans = await listLifecyclePlans(pool, { ...scopes[0]!, environment: environmentName }, 25);
        const archives = await listLifecycleArchives(pool, plans.map(plan => plan.planId));
        const restoreDrills = await listRestoreDrills(pool, archives.map(archive => archive.archiveId));
        const segments = await listRetentionSegments(pool, archives.map(archive => archive.archiveId));
        const restoreDrillsByArchive = new Map<string, typeof restoreDrills>();
        for (const drill of restoreDrills) {
          const current = restoreDrillsByArchive.get(drill.archiveId) ?? [];
          current.push(drill);
          restoreDrillsByArchive.set(drill.archiveId, current);
        }
        const archivesByPlan = new Map(archives.map(archive => [archive.planId, archive]));
        const segmentsByArchive = new Map(segments.map(segment => [segment.archiveId, segment]));
        const now = options.now?.() ?? new Date();
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({
          schemaVersion: 1,
          readiness: {
            mode: 'archive_first', purgeEnabled: false, signerConfigured: Boolean(options.signer),
            requiresFreshMfa: true, requiresIndependentApproval: true, requiresExternalArchiveAnchor: true,
            externalArchiveConfigured: Boolean(options.externalArchiveProvider?.supportedKinds.includes('worm_object')),
            externalArchiveProvider: options.externalArchiveProvider?.name ?? null,
            restoreDrillConfigured: Boolean(options.externalArchiveProvider?.retrieveArchive && options.externalArchiveProvider?.verifyStoredReceipt),
            offlineVerifierAvailable: true, segmentSealingEnabled: true,
          },
          operationSecurity: {
            requiresFreshMfa: true,
            satisfied: hasFreshMfaSession(user, mfaMaxAgeSeconds, now),
            maxAgeSeconds: mfaMaxAgeSeconds,
            stepUpUrl: '/auth/oidc/step-up?returnTo=%2Fobserve%2Faudit%3Ftab%3Dretention',
          },
          plans: plans.map(plan => ({
            ...plan,
            manifest: { ...plan.manifest, eligibleEvents: [] },
            manifestEventsIncluded: false,
            archive: (() => {
              const archive = archivesByPlan.get(plan.planId);
              return archive ? {
                ...archive,
                restoreDrills: restoreDrillsByArchive.get(archive.archiveId) ?? [],
                segment: segmentsByArchive.get(archive.archiveId) ?? null,
              } : null;
            })(),
          })),
        });
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) { res.status(400).json({ error: error.message }); return; }
        logger.error({ err: error }, 'Audit retention plans could not be loaded');
        res.status(500).json({ error: 'Audit retention plans could not be loaded' });
      }
    },
  );

  app.post(
    '/api/ui/audit/retention-plans/v1',
    requireAuth,
    requirePermission('retention.execute'),
    sameOrigin,
    freshMfa,
    async (req, res) => {
      if (!options.enabled) { res.status(404).json({ error: 'Not found' }); return; }
      if (!options.signer) {
        res.status(503).json({ error: 'Audit checkpoint signing is required before retention planning', code: 'AUDIT_SIGNING_NOT_CONFIGURED' });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = requestBody(req);
        const environmentName = environment(body['environment']);
        const rawLimit = body['batch_limit'] ?? MAX_RETENTION_PLAN_EVENTS;
        const batchLimit = Number(rawLimit);
        if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_RETENTION_PLAN_EVENTS) {
          throw new AuditEvidenceValidationError(`batch_limit must be between 1 and ${MAX_RETENTION_PLAN_EVENTS}`);
        }
        const checkpoint = await createCheckpoint(
          pool, { ...scopes[0]!, environment: environmentName }, options.signer, { now: options.now },
        );
        const result = await createLifecyclePlan(
          pool,
          retentionContext(user, scopes[0]!, environmentName, idempotencyKey(req), options.now),
          { checkpoint, publicKeyPem: options.signer.publicKeyPem },
          batchLimit,
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) { res.status(400).json({ error: error.message }); return; }
        logger.error({ err: error }, 'Audit retention dry-run plan failed');
        res.status(422).json({ error: error instanceof Error ? error.message : 'Audit retention plan failed' });
      }
    },
  );

  app.post(
    '/api/ui/audit/retention-plans/v1/:planId/decisions',
    requireAuth,
    requirePermission('retention.execute'),
    sameOrigin,
    freshMfa,
    async (req, res) => {
      if (!options.enabled) { res.status(404).json({ error: 'Not found' }); return; }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = requestBody(req);
        const environmentName = environment(body['environment']);
        const decision = body['decision'];
        if (decision !== 'approved' && decision !== 'rejected') throw new AuditEvidenceValidationError('decision must be approved or rejected');
        const result = await decideLifecyclePlan(
          pool,
          retentionContext(user, scopes[0]!, environmentName, idempotencyKey(req), options.now),
          uuidBody(req.params['planId'], 'plan_id'), decision,
          requiredBodyString(body['justification'], 'justification', 4096),
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) { res.status(400).json({ error: error.message }); return; }
        logger.error({ err: error }, 'Audit retention plan decision failed');
        res.status(422).json({ error: error instanceof Error ? error.message : 'Audit retention decision failed' });
      }
    },
  );

  app.post(
    '/api/ui/audit/retention-plans/v1/:planId/archive',
    requireAuth,
    requirePermission('retention.execute'),
    sameOrigin,
    freshMfa,
    async (req, res) => {
      if (!options.enabled) { res.status(404).json({ error: 'Not found' }); return; }
      if (!options.externalArchiveProvider || !options.externalArchiveProvider.supportedKinds.includes('worm_object')) {
        res.status(503).json({ error: 'External WORM archival is not configured', code: 'EXTERNAL_WORM_ARCHIVE_NOT_CONFIGURED' });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = requestBody(req);
        const environmentName = environment(body['environment']);
        const archiveContext: RetentionArchiveContext = {
          scope: { ...scopes[0]!, environment: environmentName },
          actor: actorFor(user), producerEventId: idempotencyKey(req),
          requestId: req.header('x-request-id') ?? null,
          justification: requiredBodyString(body['justification'], 'justification', 4096),
          mfaVerifiedAt: user.mfa_verified_at ?? '', mfaMethod: user.mfa_method ?? '',
          mfaMaxAgeSeconds, now: options.now,
        };
        const result = await archiveLifecyclePlan(
          pool, archiveContext, uuidBody(req.params['planId'], 'plan_id'), options.externalArchiveProvider,
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) { res.status(400).json({ error: error.message }); return; }
        logger.error({ err: error }, 'Audit retention WORM archival failed');
        res.status(422).json({ error: error instanceof Error ? error.message : 'Audit retention archival failed' });
      }
    },
  );

  app.post(
    '/api/ui/audit/retention-archives/v1/:archiveId/restore-drills',
    requireAuth,
    requirePermission('restore_drill.execute'),
    sameOrigin,
    freshMfa,
    async (req, res) => {
      if (!options.enabled) { res.status(404).json({ error: 'Not found' }); return; }
      if (!options.externalArchiveProvider?.retrieveArchive || !options.externalArchiveProvider.verifyStoredReceipt) {
        res.status(503).json({ error: 'Verified archive retrieval is not configured', code: 'RETENTION_RESTORE_DRILL_NOT_CONFIGURED' });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = requestBody(req);
        const environmentName = environment(body['environment']);
        const restoreContext: RetentionRestoreDrillContext = {
          scope: { ...scopes[0]!, environment: environmentName }, actor: actorFor(user),
          producerEventId: idempotencyKey(req), requestId: req.header('x-request-id') ?? null,
          justification: requiredBodyString(body['justification'], 'justification', 4096),
          mfaVerifiedAt: user.mfa_verified_at ?? '', mfaMethod: user.mfa_method ?? '',
          mfaMaxAgeSeconds, now: options.now,
        };
        const result = await runRestoreDrill(
          pool, restoreContext, uuidBody(req.params['archiveId'], 'archive_id'), options.externalArchiveProvider,
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) { res.status(400).json({ error: error.message }); return; }
        logger.error({ err: error }, 'Audit retention restore drill failed');
        res.status(422).json({ error: error instanceof Error ? error.message : 'Audit retention restore drill failed' });
      }
    },
  );

  app.post(
    '/api/ui/audit/retention-archives/v1/:archiveId/seal-segment',
    requireAuth,
    requirePermission('retention.execute'),
    sameOrigin,
    freshMfa,
    async (req, res) => {
      if (!options.enabled) { res.status(404).json({ error: 'Not found' }); return; }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = requestBody(req);
        const environmentName = environment(body['environment']);
        const segmentContext: RetentionSegmentContext = {
          scope: { ...scopes[0]!, environment: environmentName }, actor: actorFor(user),
          producerEventId: idempotencyKey(req), requestId: req.header('x-request-id') ?? null,
          justification: requiredBodyString(body['justification'], 'justification', 4096),
          mfaVerifiedAt: user.mfa_verified_at ?? '', mfaMethod: user.mfa_method ?? '',
          mfaMaxAgeSeconds, now: options.now,
        };
        const result = await sealRetentionSegment(
          pool, segmentContext, uuidBody(req.params['archiveId'], 'archive_id'),
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) { res.status(400).json({ error: error.message }); return; }
        logger.error({ err: error }, 'Audit retention chain segment sealing failed');
        res.status(422).json({ error: error instanceof Error ? error.message : 'Audit retention chain segment sealing failed' });
      }
    },
  );

  app.post(
    '/api/ui/audit/evidence-packs/v1',
    requireAuth,
    requirePermission('audit.export'),
    sameOrigin,
    freshMfa,
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = requestBody(req);
        const pack = await createPack(pool, {
          ...scopes[0]!,
          environment: environment(body['environment']),
          from: optionalBodyString(body['from'], 'from', 64),
          to: optionalBodyString(body['to'], 'to', 64),
          actorId: optionalBodyString(body['actor_id'], 'actor_id', 256),
          action: optionalBodyString(body['action'], 'action', 128),
          resourceType: optionalBodyString(body['resource_type'], 'resource_type', 64),
          resourceId: optionalBodyString(body['resource_id'], 'resource_id', 256),
          generatedBy: { actorId: String(user.id), authMethod: actorFor(user).authMethod },
          now: options.now,
        });
        const recorded = await recordPackExport(pool, pack, actorFor(user), idempotencyKey(req));
        if (recorded.replayed) {
          res.status(409).json({
            error: 'This evidence export idempotency key was already used',
            code: 'AUDIT_EVIDENCE_EXPORT_REPLAY',
            auditEventId: recorded.eventId,
          });
          return;
        }
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="argus-audit-evidence-${pack.manifest.packId}.json"`);
        res.status(201).send(JSON.stringify(pack));
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Canonical audit evidence-pack export failed');
        res.status(500).json({ error: 'Audit evidence pack could not be exported' });
      }
    },
  );

  app.post(
    '/api/ui/audit/retention-policies/v1',
    requireAuth,
    requirePermission('audit.retention_manage'),
    sameOrigin,
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = requestBody(req);
        const environmentName = environment(body['environment']);
        const rawDuration = body['duration_days'];
        if (rawDuration !== null
          && (!Number.isSafeInteger(rawDuration) || Number(rawDuration) < 1 || Number(rawDuration) > 36500)) {
          throw new AuditEvidenceValidationError('duration_days must be null or an integer between 1 and 36500');
        }
        const result = await createRetention(pool, governanceContext(
          user, scopes[0]!, environmentName, idempotencyKey(req), options.now,
        ), {
          retentionClass: requiredBodyString(body['retention_class'], 'retention_class', 64),
          durationDays: rawDuration === null ? null : Number(rawDuration),
          region: requiredBodyString(body['region'], 'region', 64),
          effectiveFrom: optionalBodyString(body['effective_from'], 'effective_from', 64) ?? undefined,
        });
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Canonical audit retention policy creation failed');
        res.status(500).json({ error: 'Audit retention policy could not be created' });
      }
    },
  );

  app.post(
    '/api/ui/audit/legal-holds/v1',
    requireAuth,
    requirePermission('audit.legal_hold_manage'),
    sameOrigin,
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = requestBody(req);
        const environmentName = environment(body['environment']);
        const fromSequence = optionalPositiveInteger(body['from_sequence'], 'from_sequence');
        const throughSequence = body['through_sequence'] == null
          ? null
          : optionalPositiveInteger(body['through_sequence'], 'through_sequence');
        if (throughSequence != null && throughSequence < (fromSequence ?? 1)) {
          throw new AuditEvidenceValidationError('through_sequence must be null or at least from_sequence');
        }
        const result = await placeHold(pool, governanceContext(
          user, scopes[0]!, environmentName, idempotencyKey(req), options.now,
        ), {
          holdId: body['hold_id'] == null || body['hold_id'] === ''
            ? undefined
            : uuidBody(body['hold_id'], 'hold_id'),
          fromSequence,
          throughSequence,
          resourceType: optionalBodyString(body['resource_type'], 'resource_type', 64),
          resourceId: optionalBodyString(body['resource_id'], 'resource_id', 256),
          justification: requiredBodyString(body['justification'], 'justification', 4096),
        });
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Canonical audit legal hold placement failed');
        res.status(500).json({ error: 'Audit legal hold could not be placed' });
      }
    },
  );

  app.post(
    '/api/ui/audit/legal-holds/v1/:holdId/release',
    requireAuth,
    requirePermission('audit.legal_hold_manage'),
    sameOrigin,
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scopes = resolveScopes(user, req);
        if (scopes.length !== 1) throw new Error('exactly one authorized audit scope is required');
        const body = requestBody(req);
        const environmentName = environment(body['environment']);
        const rawHoldId = req.params['holdId'];
        const result = await releaseHold(pool, governanceContext(
          user, scopes[0]!, environmentName, idempotencyKey(req), options.now,
        ), {
          holdId: uuidBody(typeof rawHoldId === 'string' ? rawHoldId : '', 'hold_id'),
          justification: requiredBodyString(body['justification'], 'justification', 4096),
        });
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        if (rejectUnauthorizedScope(res, error)) return;
        if (error instanceof AuditEvidenceValidationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Canonical audit legal hold release failed');
        res.status(500).json({ error: 'Audit legal hold could not be released' });
      }
    },
  );
}
