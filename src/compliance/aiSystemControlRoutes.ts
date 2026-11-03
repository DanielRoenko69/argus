import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { evaluatePermission } from '../auth/effectiveAccess.js';
import { requirePermission, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import {
  resolveAuthorizedWorkspaceScope,
  type AuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import { getAiActControlCatalog } from './aiActControlCatalog.js';
import {
  aiSystemControlAssessmentInputSchema,
  getAiSystemControlLedger,
  recordAiSystemControlAssessment,
  type AiSystemControlContext,
} from './aiSystemControlLedger.js';
import { AiSystemRegistryError } from './aiSystemRegistry.js';

const uuid = z.string().uuid();
const controlId = z.string().trim().regex(/^AIA-[A-Z0-9-]+$/).max(100);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
type User = NonNullable<AuthenticatedRequest['user']>;

export interface AiSystemControlRouteDependencies {
  getCatalog: typeof getAiActControlCatalog;
  getLedger: typeof getAiSystemControlLedger;
  record: typeof recordAiSystemControlAssessment;
  now(): Date;
}

const DEFAULT_DEPENDENCIES: AiSystemControlRouteDependencies = {
  getCatalog: getAiActControlCatalog,
  getLedger: getAiSystemControlLedger,
  record: recordAiSystemControlAssessment,
  now: () => new Date(),
};

function header(req: Request, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  if (!IDEMPOTENCY_KEY.test(normalized)) throw new AiSystemRegistryError(`${name} header is invalid`);
  return normalized;
}

function requiredIdempotencyKey(req: Request): string {
  const value = header(req, 'idempotency-key');
  if (!value) throw new AiSystemRegistryError('Idempotency-Key header is required for control decisions', 400, 'AI_CONTROL_IDEMPOTENCY_REQUIRED');
  return value;
}

function context(
  req: Request,
  user: User,
  scope: AuthorizedWorkspaceScope,
  dependencies: AiSystemControlRouteDependencies,
  mfaMaxAgeSeconds: number,
): AiSystemControlContext {
  return {
    scope: { ...scope, environment: process.env['NODE_ENV'] || 'development' },
    actor: {
      type: 'human', id: String(user.id),
      ssoSubject: user.auth_method === 'oidc' && /^(?:entra|oidc):/.test(user.username) ? user.username : null,
      authMethod: user.auth_method ?? 'session', effectiveRoles: [user.role],
    },
    producerEventId: requiredIdempotencyKey(req),
    requestId: header(req, 'x-request-id') ?? randomUUID(),
    mfaVerifiedAt: user.mfa_verified_at ?? '', mfaMethod: user.mfa_method ?? '',
    mfaMaxAgeSeconds, now: dependencies.now,
  };
}

function routeError(res: Response, error: unknown): void {
  if (error instanceof WorkspaceScopeAccessError) {
    res.status(error.status).json({
      schemaVersion: 1,
      kind: 'ai-system-control-error',
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ schemaVersion: 1, kind: 'ai-system-control-error', error: { code: 'validation_failed', message: 'Control assessment validation failed', issueCodes: error.issues.slice(0, 64).map(issue => issue.path.join('.') || issue.code) } });
    return;
  }
  if (error instanceof AiSystemRegistryError) {
    res.status(error.status).json({ schemaVersion: 1, kind: 'ai-system-control-error', error: { code: error.code, message: error.message } });
    return;
  }
  logger.error({ err: error }, 'AI-system control request failed');
  res.status(500).json({ schemaVersion: 1, kind: 'ai-system-control-error', error: { code: 'AI_SYSTEM_CONTROL_FAILED', message: 'AI-system control request failed' } });
}

export function registerAiSystemControlRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  requireSameOrigin: RequestHandler,
  requireFreshMfa: RequestHandler,
  mfaMaxAgeSeconds: number,
  overrides: Partial<AiSystemControlRouteDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const canRead = requirePermission('compliance.read');
  const canManage = requirePermission('compliance.control_manage');

  app.get('/api/ui/compliance/ai-control-catalog', requireAuth, canRead, (_req, res) => {
    res.json({ schemaVersion: 1, kind: 'ai-act-control-catalog-response', catalog: dependencies.getCatalog() });
  });

  app.get('/api/ui/compliance/ai-systems/:aiSystemId/controls', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      res.json(await dependencies.getLedger(pool, scope, uuid.parse(req.params['aiSystemId']), { now: dependencies.now() }));
    } catch (error) {
      routeError(res, error);
    }
  });

  app.post('/api/ui/compliance/ai-systems/:aiSystemId/controls/:controlId/assessments', requireAuth, canManage, requireSameOrigin, requireFreshMfa, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const input = aiSystemControlAssessmentInputSchema.parse(req.body);
      if (input.status === 'exception' && !evaluatePermission({ role: user.role }, 'compliance.exception_manage').allowed) {
        throw new AiSystemRegistryError('Control exceptions require compliance.exception_manage', 403, 'AI_CONTROL_EXCEPTION_FORBIDDEN');
      }
      const result = await dependencies.record(
        pool,
        context(req, user, scope, dependencies, mfaMaxAgeSeconds),
        uuid.parse(req.params['aiSystemId']),
        controlId.parse(req.params['controlId']),
        input,
      );
      res.status(result.replayed ? 200 : 201).json({
        schemaVersion: 1, kind: 'ai-system-control-assessment-result',
        ledger: result.ledger, assessment: result.assessment,
        auditEventId: result.auditEvent.eventId, replayed: result.replayed,
      });
    } catch (error) {
      routeError(res, error);
    }
  });
}
