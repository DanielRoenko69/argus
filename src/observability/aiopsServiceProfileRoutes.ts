import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { evaluatePermission } from '../auth/effectiveAccess.js';
import type { ArgusPermission } from '../auth/permissions.js';
import {
  requirePermission,
  type AuthenticatedRequest,
} from '../auth/sessionMiddleware.js';
import { logger } from '../lib/logger.js';
import { writeAdminAudit } from '../lib/adminAudit.js';
import { listResourceTags } from '../tags/store.js';
import {
  evaluateAiOpsGlobalReadiness,
  type AiOpsPackReadinessSnapshot,
} from './aiopsGlobalReadiness.js';
import {
  aiOpsServiceProfileConfigSchema,
  aiOpsEvidenceQueryPreflightInputSchema,
  aiOpsServiceProfileInvestigationSignalSchema,
  type AiOpsEvidenceQueryPreflightInput,
  type AiOpsEvidenceQueryPreflightResult,
  type AiOpsServiceProfileConfig,
  type AiOpsServiceProfileReadiness,
  type AiOpsServiceProfileResource,
  type AiOpsServiceProfileInvestigationStarted,
} from './aiopsServiceProfileContracts.js';
import { AiOpsServiceProfileInvestigationError } from './aiopsServiceProfileInvestigations.js';
import { evaluateAiOpsServiceProfileReadiness } from './aiopsServiceProfileReadiness.js';
import {
  activateAiOpsServiceProfileAudited,
  AiOpsServiceProfileError,
  cloneAiOpsServiceProfileAudited,
  createAiOpsServiceProfileAudited,
  getAiOpsServiceProfile,
  listAiOpsServiceProfileRevisions,
  listAiOpsServiceProfiles,
  reviseAiOpsServiceProfileAudited,
  setAiOpsServiceProfileStatusAudited,
  toAiOpsServiceProfileResource,
  validateAiOpsServiceProfileAudited,
  type AiOpsProfileActorSnapshot,
  type AiOpsProfileAuditContext,
  type AiOpsProfileScope,
  type AiOpsServiceProfileRecord,
} from './aiopsServiceProfiles.js';

const positiveIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const createSchema = z.object({ config: aiOpsServiceProfileConfigSchema }).strict();
const reviseSchema = z.object({
  expectedLatestRevision: z.number().int().positive(),
  config: aiOpsServiceProfileConfigSchema,
}).strict();
const revisionActionSchema = z.object({
  revision: z.number().int().positive(),
  expectedLatestRevision: z.number().int().positive(),
}).strict();
const lifecycleSchema = z.object({ expectedLatestRevision: z.number().int().positive() }).strict();
const validateSchema = lifecycleSchema;
const cloneSchema = createSchema;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type ProfileAction = AiOpsServiceProfileResource['allowedActions'][number];
type User = NonNullable<AuthenticatedRequest['user']>;

export interface AiOpsServiceProfileRouteDependencies {
  list(pool: pg.Pool, scope?: AiOpsProfileScope): Promise<AiOpsServiceProfileRecord[]>;
  get(pool: pg.Pool, profileId: number, scope?: AiOpsProfileScope): Promise<AiOpsServiceProfileRecord>;
  listRevisions: typeof listAiOpsServiceProfileRevisions;
  create: typeof createAiOpsServiceProfileAudited;
  revise: typeof reviseAiOpsServiceProfileAudited;
  validate: typeof validateAiOpsServiceProfileAudited;
  activate: typeof activateAiOpsServiceProfileAudited;
  setStatus: typeof setAiOpsServiceProfileStatusAudited;
  clone: typeof cloneAiOpsServiceProfileAudited;
  evaluateReadiness(
    pool: pg.Pool,
    profile: AiOpsServiceProfileRecord,
  ): Promise<AiOpsServiceProfileReadiness>;
  evaluateGlobalReadiness: typeof evaluateAiOpsGlobalReadiness;
  loadPackReadiness(): AiOpsPackReadinessSnapshot;
  listTags: typeof listResourceTags;
  preflightQuery(
    pool: pg.Pool,
    input: AiOpsEvidenceQueryPreflightInput,
  ): Promise<AiOpsEvidenceQueryPreflightResult>;
  auditQueryPreflight(pool: pg.Pool, req: Request, result: AiOpsEvidenceQueryPreflightResult): void;
  startInvestigation(
    pool: pg.Pool,
    profileId: number,
    signal: unknown,
    principal: { kind: 'user'; id: string; allowedBundleIds: number[] | null },
  ): Promise<AiOpsServiceProfileInvestigationStarted>;
  auditInvestigationStart(
    pool: pg.Pool,
    req: Request,
    result: AiOpsServiceProfileInvestigationStarted,
    signalTitle: string,
  ): void;
}

const DEFAULT_DEPENDENCIES: AiOpsServiceProfileRouteDependencies = {
  list: listAiOpsServiceProfiles,
  get: getAiOpsServiceProfile,
  listRevisions: listAiOpsServiceProfileRevisions,
  create: createAiOpsServiceProfileAudited,
  revise: reviseAiOpsServiceProfileAudited,
  validate: validateAiOpsServiceProfileAudited,
  activate: activateAiOpsServiceProfileAudited,
  setStatus: setAiOpsServiceProfileStatusAudited,
  clone: cloneAiOpsServiceProfileAudited,
  evaluateReadiness: evaluateAiOpsServiceProfileReadiness,
  evaluateGlobalReadiness: evaluateAiOpsGlobalReadiness,
  loadPackReadiness: () => ({ state: 'offline', version: null }),
  listTags: listResourceTags,
  preflightQuery: async () => {
    throw new AiOpsServiceProfileError(409, 'validation_required', 'AIOps evidence query preflight is unavailable');
  },
  auditQueryPreflight: (pool, req, result) => writeAdminAudit(
    pool,
    req,
    result.executed ? 'executed' : 'previewed',
    'aiops_evidence_query_preflight',
    result.queryId,
    result.toolName,
    null,
    {
      bundle_id: result.bundleId,
      lane: result.lane,
      executed: result.executed,
      state: result.state,
      duration_ms: result.response?.durationMs ?? null,
      result_bytes: result.response?.resultBytes ?? null,
      truncated: result.response?.truncated ?? null,
    },
  ),
  startInvestigation: async () => {
    throw new AiOpsServiceProfileInvestigationError(503, 'pack_contract_missing', 'Profile-backed AIOps investigations are unavailable');
  },
  auditInvestigationStart: (pool, req, result, signalTitle) => writeAdminAudit(
    pool,
    req,
    'started',
    'aiops_service_profile_investigation',
    result.task['id'] ? String(result.task['id']) : result.rootTraceId,
    signalTitle,
    null,
    {
      profile_id: result.profile.id,
      profile_revision: result.profile.revision,
      profile_sha256: result.profile.sha256,
      resolved_context_sha256: result.resolvedContextSha256,
      root_trace_id: result.rootTraceId,
    },
  ),
};

function requestHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !text.trim()) return null;
  const normalized = text.trim();
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AiOpsServiceProfileError(400, 'invalid_profile', `${name} header is invalid`);
  }
  return normalized;
}

function auditContext(req: Request, user: User): AiOpsProfileAuditContext {
  const idempotencyKey = requestHeader(req, 'idempotency-key');
  const requestId = requestHeader(req, 'x-request-id');
  return {
    producerEventId: idempotencyKey ?? requestId ?? randomUUID(),
    environment: process.env['NODE_ENV'] || 'development',
    actor: {
      type: 'human',
      id: String(user.id),
      ssoSubject: /^(?:entra|oidc):/.test(user.username) ? user.username : null,
      authMethod: /^(?:entra|oidc):/.test(user.username) ? 'oidc' : 'session',
      effectiveRoles: [user.role],
    },
    requestId,
  };
}

function assertAuthorizedBundles(user: User, config: AiOpsServiceProfileConfig): void {
  assertAuthorizedBundleIds(user, config.evidencePolicy.lanes.map(lane => lane.bundleId));
}

function assertAuthorizedBundleIds(user: User, bundleIds: number[]): void {
  if (user.allowed_bundles === null) return;
  const allowed = new Set(user.allowed_bundles);
  const denied = [...new Set(bundleIds.filter(bundleId => !allowed.has(bundleId)))];
  if (denied.length > 0) {
    throw new AiOpsServiceProfileError(
      403,
      'forbidden',
      `The caller is not authorized for AIOps evidence bundle(s): ${denied.join(', ')}`,
    );
  }
}

function actorSnapshot(user: User): AiOpsProfileActorSnapshot {
  return { id: user.id, username: user.username.slice(0, 160) };
}

function allowed(user: User, permission: ArgusPermission): boolean {
  return evaluatePermission({ role: user.role }, permission).allowed;
}

function allowedActions(user: User, profile: AiOpsServiceProfileRecord): ProfileAction[] {
  const actions: ProfileAction[] = ['read'];
  if (allowed(user, 'aiops.service_profile.write')) {
    actions.push('clone');
    if (profile.status !== 'archived') actions.push('edit', 'validate', 'archive');
  }
  if (allowed(user, 'aiops.service_profile.activate') && profile.status !== 'archived') {
    if (profile.status === 'active') actions.push('pause');
    else actions.push('activate');
  }
  if (allowed(user, 'aiops.investigation.run') && profile.status === 'active') actions.push('investigate');
  return actions;
}

async function resource(
  pool: pg.Pool,
  dependencies: AiOpsServiceProfileRouteDependencies,
  user: User,
  profile: AiOpsServiceProfileRecord,
): Promise<AiOpsServiceProfileResource> {
  const tags = await dependencies.listTags(pool, 'aiops_service_profile', String(profile.id));
  return toAiOpsServiceProfileResource(profile, { tags, allowedActions: allowedActions(user, profile) });
}

function profileError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      schemaVersion: 1,
      kind: 'aiops-service-profile-error',
      error: {
        code: 'validation_failed',
        message: 'AIOps service profile request validation failed',
        issueCodes: error.issues.slice(0, 64).map(issue => issue.path.join('.') || issue.code),
      },
    });
    return;
  }
  if (error instanceof AiOpsServiceProfileError) {
    const code = error.code === 'not_found'
      ? 'not_found'
      : error.code === 'forbidden'
        ? 'forbidden'
      : error.code === 'revision_conflict' || error.code === 'identity_conflict'
        ? 'revision_conflict'
        : error.code === 'validation_required'
          ? 'profile_blocked'
          : 'validation_failed';
    res.status(error.status).json({
      schemaVersion: 1,
      kind: 'aiops-service-profile-error',
      error: { code, message: error.message },
    });
    return;
  }
  if (error instanceof AiOpsServiceProfileInvestigationError) {
    res.status(error.status).json({
      schemaVersion: 1,
      kind: 'aiops-service-profile-error',
      error: {
        code: error.code === 'profile_not_active' || error.code === 'profile_blocked'
          ? 'profile_blocked'
          : 'validation_failed',
        message: error.message,
        ...(error.issueCodes.length > 0 ? { issueCodes: error.issueCodes } : {}),
      },
    });
    return;
  }
  logger.error({ err: error }, 'AIOps service profile request failed');
  res.status(500).json({
    schemaVersion: 1,
    kind: 'aiops-service-profile-error',
    error: { code: 'profile_blocked', message: 'AIOps service profile request failed' },
  });
}

function profileId(req: Request): number {
  const value = req.params['profileId'];
  return positiveIdSchema.parse(Array.isArray(value) ? value[0] : value);
}

export function registerAiOpsServiceProfileRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  requireSameOrigin: RequestHandler,
  overrides: Partial<AiOpsServiceProfileRouteDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const canRead = requirePermission('aiops.service_profile.read');
  const canWrite = requirePermission('aiops.service_profile.write');
  const canActivate = requirePermission('aiops.service_profile.activate');
  const canInvestigate = requirePermission('aiops.investigation.run');

  app.post('/api/ui/observability/aiops/evidence-query-preflight', requireAuth, canWrite, requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const body = aiOpsEvidenceQueryPreflightInputSchema.parse(req.body);
      assertAuthorizedBundleIds(user, [body.bundleId]);
      const result = await dependencies.preflightQuery(pool, body);
      dependencies.auditQueryPreflight(pool, req, result);
      res.json(result);
    } catch (error) {
      profileError(res, error);
    }
  });

  app.get('/api/ui/observability/aiops/readiness', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      res.json(await dependencies.evaluateGlobalReadiness(pool, {
        allowedBundleIds: user.allowed_bundles,
        pack: dependencies.loadPackReadiness(),
      }));
    } catch (error) {
      profileError(res, error);
    }
  });

  app.get('/api/ui/observability/aiops/service-profiles', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const profiles = await dependencies.list(pool);
      res.json({
        schemaVersion: 1,
        kind: 'aiops-service-profile-list',
        profiles: await Promise.all(profiles.map(profile => resource(pool, dependencies, user, profile))),
      });
    } catch (error) {
      profileError(res, error);
    }
  });

  app.post('/api/ui/observability/aiops/service-profiles', requireAuth, canWrite, requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const body = createSchema.parse(req.body);
      assertAuthorizedBundles(user, body.config);
      const result = await dependencies.create(pool, body.config, actorSnapshot(user), auditContext(req, user));
      res.status(result.replayed ? 200 : 201).json({
        schemaVersion: 1,
        profile: await resource(pool, dependencies, user, result.value),
        auditEventId: result.auditEvent.eventId,
        replayed: result.replayed,
      });
    } catch (error) {
      profileError(res, error);
    }
  });

  app.get('/api/ui/observability/aiops/service-profiles/:profileId', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const profile = await dependencies.get(pool, profileId(req));
      res.json({ schemaVersion: 1, profile: await resource(pool, dependencies, user, profile) });
    } catch (error) {
      profileError(res, error);
    }
  });

  app.patch('/api/ui/observability/aiops/service-profiles/:profileId', requireAuth, canWrite, requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const body = reviseSchema.parse(req.body);
      assertAuthorizedBundles(user, body.config);
      const result = await dependencies.revise(
        pool,
        profileId(req),
        body.expectedLatestRevision,
        body.config,
        actorSnapshot(user),
        auditContext(req, user),
      );
      res.json({
        schemaVersion: 1,
        profile: await resource(pool, dependencies, user, result.value),
        auditEventId: result.auditEvent.eventId,
        replayed: result.replayed,
      });
    } catch (error) {
      profileError(res, error);
    }
  });

  app.get('/api/ui/observability/aiops/service-profiles/:profileId/revisions', requireAuth, canRead, async (req, res) => {
    try {
      res.json({
        schemaVersion: 1,
        profileId: profileId(req),
        revisions: await dependencies.listRevisions(pool, profileId(req)),
      });
    } catch (error) {
      profileError(res, error);
    }
  });

  app.get('/api/ui/observability/aiops/service-profiles/:profileId/readiness', requireAuth, canRead, async (req, res) => {
    try {
      const profile = await dependencies.get(pool, profileId(req));
      res.json(await dependencies.evaluateReadiness(pool, profile));
    } catch (error) {
      profileError(res, error);
    }
  });

  app.post('/api/ui/observability/aiops/service-profiles/:profileId/investigations', requireAuth, canInvestigate, requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const body = z.object({ signal: aiOpsServiceProfileInvestigationSignalSchema }).strict().parse(req.body);
      const result = await dependencies.startInvestigation(pool, profileId(req), body.signal, {
        kind: 'user',
        id: String(user.id),
        allowedBundleIds: user.allowed_bundles,
      });
      dependencies.auditInvestigationStart(pool, req, result, body.signal.title);
      res.status(202).json(result);
    } catch (error) {
      profileError(res, error);
    }
  });

  app.post('/api/ui/observability/aiops/service-profiles/:profileId/validate', requireAuth, canWrite, requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const id = profileId(req);
      const body = validateSchema.parse(req.body);
      const profile = await dependencies.get(pool, id);
      assertAuthorizedBundles(user, profile.latestRevision.config);
      if (profile.latestRevision.revision !== body.expectedLatestRevision) {
        throw new AiOpsServiceProfileError(409, 'revision_conflict', 'The AIOps service profile has a newer revision');
      }
      const readiness = await dependencies.evaluateReadiness(pool, profile);
      const result = await dependencies.validate(
        pool,
        readiness,
        actorSnapshot(user),
        auditContext(req, user),
      );
      res.json({
        schemaVersion: 1,
        validation: result.value,
        readiness,
        auditEventId: result.auditEvent.eventId,
        replayed: result.replayed,
      });
    } catch (error) {
      profileError(res, error);
    }
  });

  app.post('/api/ui/observability/aiops/service-profiles/:profileId/activate', requireAuth, canActivate, requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const body = revisionActionSchema.parse(req.body);
      const profile = await dependencies.get(pool, profileId(req));
      assertAuthorizedBundles(user, profile.latestRevision.config);
      const result = await dependencies.activate(
        pool,
        profileId(req),
        body.revision,
        body.expectedLatestRevision,
        auditContext(req, user),
      );
      res.json({
        schemaVersion: 1,
        profile: await resource(pool, dependencies, user, result.value),
        auditEventId: result.auditEvent.eventId,
        replayed: result.replayed,
      });
    } catch (error) {
      profileError(res, error);
    }
  });

  for (const status of ['paused', 'archived'] as const) {
    const route = status === 'paused' ? 'pause' : 'archive';
    const guard = status === 'paused' ? canActivate : canWrite;
    app.post(`/api/ui/observability/aiops/service-profiles/:profileId/${route}`, requireAuth, guard, requireSameOrigin, async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const body = lifecycleSchema.parse(req.body);
        const profile = await dependencies.get(pool, profileId(req));
        assertAuthorizedBundles(user, profile.latestRevision.config);
        const result = await dependencies.setStatus(
          pool,
          profileId(req),
          status,
          body.expectedLatestRevision,
          auditContext(req, user),
        );
        res.json({
          schemaVersion: 1,
          profile: await resource(pool, dependencies, user, result.value),
          auditEventId: result.auditEvent.eventId,
          replayed: result.replayed,
        });
      } catch (error) {
        profileError(res, error);
      }
    });
  }

  app.post('/api/ui/observability/aiops/service-profiles/:profileId/clone', requireAuth, canWrite, requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const body = cloneSchema.parse(req.body);
      assertAuthorizedBundles(user, body.config);
      const result = await dependencies.clone(
        pool,
        profileId(req),
        body.config,
        actorSnapshot(user),
        auditContext(req, user),
      );
      res.status(result.replayed ? 200 : 201).json({
        schemaVersion: 1,
        profile: await resource(pool, dependencies, user, result.value),
        auditEventId: result.auditEvent.eventId,
        replayed: result.replayed,
      });
    } catch (error) {
      profileError(res, error);
    }
  });
}
