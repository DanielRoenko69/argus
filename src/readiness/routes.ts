import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { requirePermission, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { resolveAuthorizedWorkspaceScope, WorkspaceScopeAccessError } from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import { PlatformExecutionCertificateError, validatePlatformExecutionProof } from './executionCertificates.js';
import { importPlatformExecutionCertificate, listPlatformExecutionCertificates } from './executionCertificateStore.js';

export interface PlatformReadinessRouteDependencies {
  requireSameOrigin: RequestHandler;
  requireFreshMfa: RequestHandler;
  environment?: string;
  list?: typeof listPlatformExecutionCertificates;
  importProof?: typeof importPlatformExecutionCertificate;
}

export function registerPlatformReadinessRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  dependencies: PlatformReadinessRouteDependencies,
): void {
  const environment = dependencies.environment?.trim() || process.env.ARGUS_ENVIRONMENT?.trim() || 'local';

  app.get(
    '/api/ui/platform-readiness/certificates/v1',
    requireAuth,
    requirePermission('platform.admin'),
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = { ...resolveAuthorizedWorkspaceScope(req, user), environment };
        const certificates = await (dependencies.list ?? listPlatformExecutionCertificates)(pool, scope);
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({
          schemaVersion: 1,
          kind: 'platform-execution-certificate-catalog',
          profile: { id: 'pilot-demo', label: 'Pilot & live demo' },
          freshnessDays: 7,
          certificates,
          limitation: 'Operational Golden Path evidence; not an external legal or compliance certification.',
        });
      } catch (error) {
        if (error instanceof WorkspaceScopeAccessError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        logger.error({ err: error }, 'Platform execution proof catalog failed');
        res.status(500).json({ error: 'Execution proofs could not be loaded', code: 'PLATFORM_EXECUTION_PROOF_LIST_FAILED' });
      }
    },
  );

  app.post(
    '/api/ui/platform-readiness/certificates/v1',
    requireAuth,
    requirePermission('platform.admin'),
    dependencies.requireSameOrigin,
    dependencies.requireFreshMfa,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = { ...resolveAuthorizedWorkspaceScope(req, user), environment };
        const validated = validatePlatformExecutionProof(req.body);
        const result = await (dependencies.importProof ?? importPlatformExecutionCertificate)(pool, {
          scope,
          userId: user.id,
          username: user.username,
          actor: {
            type: 'human',
            id: String(user.id),
            authMethod: user.auth_method ?? 'local',
            effectiveRoles: [user.role],
          },
          requestId: req.header('x-request-id') ?? null,
        }, validated.report, validated.summary);
        res.status(result.replayed ? 200 : 201).json({
          certificate: result.certificate,
          auditEventId: result.auditEvent.eventId,
          replayed: result.replayed,
        });
      } catch (error) {
        if (error instanceof PlatformExecutionCertificateError || error instanceof WorkspaceScopeAccessError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        logger.error({ err: error }, 'Platform execution proof import failed');
        res.status(500).json({ error: 'Execution proof could not be imported', code: 'PLATFORM_EXECUTION_PROOF_IMPORT_FAILED' });
      }
    },
  );
}
