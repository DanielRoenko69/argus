import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { evaluatePermission } from '../auth/effectiveAccess.js';
import type { ArgusPermission } from '../auth/permissions.js';
import { requirePermission, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import {
  resolveAuthorizedWorkspaceScope,
  type AuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import { listResourceTags } from '../tags/store.js';
import {
  aiActClassificationDecisionInputSchema,
  aiActCreateSystemInputSchema,
  aiActReleaseDecisionInputSchema,
  aiActRevisionDecisionInputSchema,
  type AiActRegistrationReadiness,
  type AiActSystemRevision,
} from './aiActContracts.js';
import {
  classifyAiSystemAudited,
  releaseAiSystemAudited,
  reviseAiSystemAudited,
  type AiSystemGovernanceContext,
  type AiSystemGovernanceResult,
} from './aiSystemGovernance.js';
import {
  AiSystemRegistryError,
  createAiSystemAudited,
  getAiSystemRevision,
  listAiSystems,
  type AiSystemRegistryListItem,
} from './aiSystemRegistry.js';
import { evaluateAiSystemRegistrationReadiness } from './aiSystemReadiness.js';
import {
  configureWorkflowAiSystemBindingAudited,
  getWorkflowAiSystemBinding,
} from './aiSystemWorkflowBinding.js';

type User = NonNullable<AuthenticatedRequest['user']>;
const aiSystemIdSchema = z.string().uuid();
const revisionSchema = z.coerce.number().int().positive();
const limitSchema = z.coerce.number().int().positive().max(200).default(100);
const workflowIdSchema = z.coerce.number().int().positive();
const workflowBindingInputSchema = z.object({
  governed: z.boolean(),
  aiSystemId: z.string().uuid().nullable(),
  aiSystemRevision: z.number().int().positive().nullable(),
}).strict().superRefine((value, context) => {
  if (value.governed !== (value.aiSystemId !== null && value.aiSystemRevision !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'governed requires an AI-system id and revision; ungoverned requires null values',
    });
  }
});
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface AiSystemRouteDependencies {
  list: typeof listAiSystems;
  getRevision: typeof getAiSystemRevision;
  create: typeof createAiSystemAudited;
  revise: typeof reviseAiSystemAudited;
  classify: typeof classifyAiSystemAudited;
  release: typeof releaseAiSystemAudited;
  listTags: typeof listResourceTags;
  evaluateReadiness: typeof evaluateAiSystemRegistrationReadiness;
  getWorkflowBinding: typeof getWorkflowAiSystemBinding;
  configureWorkflowBinding: typeof configureWorkflowAiSystemBindingAudited;
  now(): Date;
}

const DEFAULT_DEPENDENCIES: AiSystemRouteDependencies = {
  list: listAiSystems,
  getRevision: getAiSystemRevision,
  create: createAiSystemAudited,
  revise: reviseAiSystemAudited,
  classify: classifyAiSystemAudited,
  release: releaseAiSystemAudited,
  listTags: listResourceTags,
  evaluateReadiness: evaluateAiSystemRegistrationReadiness,
  getWorkflowBinding: getWorkflowAiSystemBinding,
  configureWorkflowBinding: configureWorkflowAiSystemBindingAudited,
  now: () => new Date(),
};

function requestHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !text.trim()) return null;
  const normalized = text.trim();
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AiSystemRegistryError(`${name} header is invalid`);
  }
  return normalized;
}

function requiredIdempotencyKey(req: Request): string {
  const value = requestHeader(req, 'idempotency-key');
  if (!value) {
    throw new AiSystemRegistryError(
      'Idempotency-Key header is required for AI-system governance decisions',
      400,
      'AI_SYSTEM_IDEMPOTENCY_REQUIRED',
    );
  }
  return value;
}

function hasPermission(user: User, permission: ArgusPermission): boolean {
  return evaluatePermission({ role: user.role }, permission).allowed;
}

function allowedActions(user: User, lifecycleState: AiActSystemRevision['lifecycleState']): string[] {
  const actions = ['read', 'view_control_gaps'];
  if (hasPermission(user, 'ai_system.manage') && !['released', 'retired'].includes(lifecycleState)) {
    actions.push('edit_draft');
  }
  if (hasPermission(user, 'ai_system.classify') && !['released', 'retired'].includes(lifecycleState)) {
    actions.push('classify', 'request_independent_review');
  }
  if (hasPermission(user, 'compliance.control_manage') && !['released', 'retired'].includes(lifecycleState)) {
    actions.push('assess_controls');
  }
  if (
    hasPermission(user, 'ai_system.release')
    && ['ready_for_independent_review', 'externally_assessed'].includes(lifecycleState)
  ) {
    actions.push('release');
  }
  if (hasPermission(user, 'ai_system.suspend') && lifecycleState === 'released') actions.push('suspend');
  return actions;
}

async function listResource(
  pool: pg.Pool,
  dependencies: AiSystemRouteDependencies,
  user: User,
  scope: AuthorizedWorkspaceScope,
  item: AiSystemRegistryListItem,
): Promise<AiSystemRegistryListItem & { tags: Awaited<ReturnType<typeof listResourceTags>>; allowedActions: string[] }> {
  return {
    ...item,
    tags: await dependencies.listTags(pool, 'ai_system', item.aiSystemId, scope.workspaceKey),
    allowedActions: allowedActions(user, item.lifecycleState),
  };
}

async function detailResource(
  pool: pg.Pool,
  dependencies: AiSystemRouteDependencies,
  user: User,
  scope: AuthorizedWorkspaceScope,
  revision: AiActSystemRevision,
): Promise<{
  revision: AiActSystemRevision;
  tags: Awaited<ReturnType<typeof listResourceTags>>;
  allowedActions: string[];
  readiness: AiActRegistrationReadiness;
}> {
  const actions = allowedActions(user, revision.lifecycleState);
  return {
    revision,
    tags: await dependencies.listTags(pool, 'ai_system', revision.aiSystemId, scope.workspaceKey),
    allowedActions: actions,
    readiness: dependencies.evaluateReadiness(revision, { now: dependencies.now(), allowedActions: actions }),
  };
}

function routeError(res: Response, error: unknown): void {
  if (error instanceof WorkspaceScopeAccessError) {
    res.status(error.status).json({
      schemaVersion: 1,
      kind: 'ai-system-registry-error',
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({
      schemaVersion: 1,
      kind: 'ai-system-registry-error',
      error: {
        code: 'validation_failed',
        message: 'AI-system registry request validation failed',
        issueCodes: error.issues.slice(0, 64).map(issue => issue.path.join('.') || issue.code),
      },
    });
    return;
  }
  if (error instanceof AiSystemRegistryError) {
    res.status(error.status).json({
      schemaVersion: 1,
      kind: 'ai-system-registry-error',
      error: { code: error.code, message: error.message },
    });
    return;
  }
  logger.error({ err: error }, 'AI-system registry request failed');
  res.status(500).json({
    schemaVersion: 1,
    kind: 'ai-system-registry-error',
    error: { code: 'AI_SYSTEM_REGISTRY_FAILED', message: 'AI-system registry request failed' },
  });
}

function pathAiSystemId(req: Request): string {
  const value = req.params['aiSystemId'];
  return aiSystemIdSchema.parse(Array.isArray(value) ? value[0] : value);
}

export interface AiSystemRouteSecurityOptions {
  requireFreshMfa?: RequestHandler;
  mfaMaxAgeSeconds?: number;
}

function unavailableFreshMfa(_req: Request, res: Response): void {
  res.status(503).json({
    error: 'Fresh MFA enforcement is not configured for AI-system governance',
    code: 'AI_SYSTEM_MFA_UNAVAILABLE',
  });
}

function governanceContext(
  req: Request,
  user: User,
  scope: AuthorizedWorkspaceScope,
  dependencies: AiSystemRouteDependencies,
  security: AiSystemRouteSecurityOptions,
): AiSystemGovernanceContext {
  const requestId = requestHeader(req, 'x-request-id');
  return {
    scope: { ...scope, environment: process.env['NODE_ENV'] || 'development' },
    actor: {
      type: 'human',
      id: String(user.id),
      ssoSubject: user.auth_method === 'oidc' && /^(?:entra|oidc):/.test(user.username)
        ? user.username
        : null,
      authMethod: user.auth_method ?? 'session',
      effectiveRoles: [user.role],
    },
    producerEventId: requiredIdempotencyKey(req),
    requestId,
    mfaVerifiedAt: user.mfa_verified_at ?? '',
    mfaMethod: user.mfa_method ?? '',
    mfaMaxAgeSeconds: security.mfaMaxAgeSeconds ?? 600,
    now: dependencies.now,
  };
}

async function sendGovernanceResult(
  res: Response,
  pool: pg.Pool,
  dependencies: AiSystemRouteDependencies,
  user: User,
  scope: AuthorizedWorkspaceScope,
  result: AiSystemGovernanceResult,
): Promise<void> {
  res.status(result.replayed ? 200 : 201).json({
    schemaVersion: 1,
    kind: 'ai-system-registry-detail',
    aiSystem: await detailResource(pool, dependencies, user, scope, result.value),
    decisionId: result.decisionId,
    auditEventId: result.auditEvent.eventId,
    replayed: result.replayed,
  });
}

export function registerAiSystemRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  requireSameOrigin: RequestHandler,
  overrides: Partial<AiSystemRouteDependencies> = {},
  security: AiSystemRouteSecurityOptions = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const freshMfa = security.requireFreshMfa ?? unavailableFreshMfa;
  const canRead = requirePermission('ai_system.read');
  const canCreate = requirePermission('ai_system.create');
  const canManage = requirePermission('ai_system.manage');
  const canClassify = requirePermission('ai_system.classify');
  const canRelease = requirePermission('ai_system.release');

  app.get('/api/ui/compliance/ai-systems', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const items = await dependencies.list(pool, scope, limitSchema.parse(req.query['limit']));
      res.json({
        schemaVersion: 1,
        kind: 'ai-system-registry-list',
        aiSystems: await Promise.all(items.map(item => listResource(pool, dependencies, user, scope, item))),
        claimBoundary: 'Registry state and evidence readiness are operational records, not a legal conformity certification.',
      });
    } catch (error) {
      routeError(res, error);
    }
  });

  app.post('/api/ui/compliance/ai-systems', requireAuth, canCreate, requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const body = aiActCreateSystemInputSchema.parse(req.body);
      const idempotencyKey = requestHeader(req, 'idempotency-key');
      const requestId = requestHeader(req, 'x-request-id');
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const result = await dependencies.create(pool, {
        scope: { ...scope, environment: process.env['NODE_ENV'] || 'development' },
        actor: {
          type: 'human',
          id: String(user.id),
          ssoSubject: /^(?:entra|oidc):/.test(user.username) ? user.username : null,
          authMethod: /^(?:entra|oidc):/.test(user.username) ? 'oidc' : 'session',
          effectiveRoles: [user.role],
        },
        producerEventId: idempotencyKey ?? requestId ?? randomUUID(),
        requestId,
        now: dependencies.now,
      }, body);
      res.status(result.replayed ? 200 : 201).json({
        schemaVersion: 1,
        kind: 'ai-system-registry-detail',
        aiSystem: await detailResource(pool, dependencies, user, scope, result.value),
        auditEventId: result.auditEvent.eventId,
        replayed: result.replayed,
      });
    } catch (error) {
      routeError(res, error);
    }
  });

  app.get('/api/ui/compliance/ai-systems/:aiSystemId', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const queryRevision = req.query['revision'];
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const revision = await dependencies.getRevision(
        pool,
        scope,
        pathAiSystemId(req),
        queryRevision === undefined ? undefined : revisionSchema.parse(queryRevision),
      );
      res.json({
        schemaVersion: 1,
        kind: 'ai-system-registry-detail',
        aiSystem: await detailResource(pool, dependencies, user, scope, revision),
      });
    } catch (error) {
      routeError(res, error);
    }
  });

  app.get('/api/ui/compliance/ai-systems/:aiSystemId/readiness', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const revision = await dependencies.getRevision(pool, scope, pathAiSystemId(req));
      res.json(dependencies.evaluateReadiness(revision, {
        now: dependencies.now(),
        allowedActions: allowedActions(user, revision.lifecycleState),
      }));
    } catch (error) {
      routeError(res, error);
    }
  });

  app.post(
    '/api/ui/compliance/ai-systems/:aiSystemId/revisions',
    requireAuth,
    canManage,
    requireSameOrigin,
    freshMfa,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const result = await dependencies.revise(
          pool,
          governanceContext(req, user, scope, dependencies, security),
          pathAiSystemId(req),
          aiActRevisionDecisionInputSchema.parse(req.body),
        );
        await sendGovernanceResult(res, pool, dependencies, user, scope, result);
      } catch (error) {
        routeError(res, error);
      }
    },
  );

  app.post(
    '/api/ui/compliance/ai-systems/:aiSystemId/classifications',
    requireAuth,
    canClassify,
    requireSameOrigin,
    freshMfa,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const result = await dependencies.classify(
          pool,
          governanceContext(req, user, scope, dependencies, security),
          pathAiSystemId(req),
          aiActClassificationDecisionInputSchema.parse(req.body),
        );
        await sendGovernanceResult(res, pool, dependencies, user, scope, result);
      } catch (error) {
        routeError(res, error);
      }
    },
  );

  app.post(
    '/api/ui/compliance/ai-systems/:aiSystemId/release',
    requireAuth,
    canRelease,
    requireSameOrigin,
    freshMfa,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const result = await dependencies.release(
          pool,
          governanceContext(req, user, scope, dependencies, security),
          pathAiSystemId(req),
          aiActReleaseDecisionInputSchema.parse(req.body),
        );
        await sendGovernanceResult(res, pool, dependencies, user, scope, result);
      } catch (error) {
        routeError(res, error);
      }
    },
  );

  app.get('/api/ui/compliance/workflows/:workflowId/ai-system-binding', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      if (scope.tenantKey !== 'default' || scope.workspaceKey !== 'default') {
        throw new WorkspaceScopeAccessError('Workspace scope was not found.');
      }
      const workflowId = workflowIdSchema.parse(req.params['workflowId']);
      res.json({
        schemaVersion: 1,
        kind: 'workflow-ai-system-binding',
        binding: await dependencies.getWorkflowBinding(pool, workflowId),
      });
    } catch (error) {
      routeError(res, error);
    }
  });

  app.put(
    '/api/ui/compliance/workflows/:workflowId/ai-system-binding',
    requireAuth,
    canManage,
    requireSameOrigin,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        if (scope.tenantKey !== 'default' || scope.workspaceKey !== 'default') {
          throw new WorkspaceScopeAccessError('Workspace scope was not found.');
        }
        const workflowId = workflowIdSchema.parse(req.params['workflowId']);
        const input = workflowBindingInputSchema.parse(req.body);
        const idempotencyKey = requestHeader(req, 'idempotency-key');
        const requestId = requestHeader(req, 'x-request-id');
        const result = await dependencies.configureWorkflowBinding(pool, {
          scope: { ...scope, environment: process.env['NODE_ENV'] || 'development' },
          actor: {
            type: 'human',
            id: String(user.id),
            ssoSubject: /^(?:entra|oidc):/.test(user.username) ? user.username : null,
            authMethod: /^(?:entra|oidc):/.test(user.username) ? 'oidc' : 'session',
            effectiveRoles: [user.role],
          },
          producerEventId: idempotencyKey ?? requestId ?? randomUUID(),
          requestId,
          now: dependencies.now,
        }, { workflowId, ...input });
        res.status(result.replayed ? 200 : 201).json({
          schemaVersion: 1,
          kind: 'workflow-ai-system-binding',
          binding: result.value,
          auditEventId: result.auditEvent.eventId,
          replayed: result.replayed,
        });
      } catch (error) {
        routeError(res, error);
      }
    },
  );
}
