import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requirePermission, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import {
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../auth/workspaceScope.js';
import type { CanonicalAuditActor } from '../audit/canonicalAuditTypes.js';
import { logger } from '../lib/logger.js';
import { aiActComplianceDossierGenerationInputSchema } from './aiActContracts.js';
import {
  generateAiComplianceDossierAudited,
  getAiComplianceDossier,
  listAiComplianceDossiers,
  loadAiComplianceDossierArtifact,
  recordAiComplianceDossierExport,
  type AiComplianceDossierArtifactFormat,
} from './aiComplianceDossier.js';
import { AiSystemRegistryError } from './aiSystemRegistry.js';

const uuidSchema = z.string().uuid();
const limitSchema = z.coerce.number().int().positive().max(200).default(100);
const artifactFormatSchema = z.enum(['manifest', 'json', 'pdf', 'signature']);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface AiComplianceDossierRouteDependencies {
  generate: typeof generateAiComplianceDossierAudited;
  get: typeof getAiComplianceDossier;
  list: typeof listAiComplianceDossiers;
  loadArtifact: typeof loadAiComplianceDossierArtifact;
  recordExport: typeof recordAiComplianceDossierExport;
  now(): Date;
  uuid(): string;
}

const DEFAULT_DEPENDENCIES: AiComplianceDossierRouteDependencies = {
  generate: generateAiComplianceDossierAudited,
  get: getAiComplianceDossier,
  list: listAiComplianceDossiers,
  loadArtifact: loadAiComplianceDossierArtifact,
  recordExport: recordAiComplianceDossierExport,
  now: () => new Date(),
  uuid: randomUUID,
};

function header(req: Request, name: string, required = false): string | null {
  const source = req.headers[name];
  const value = Array.isArray(source) ? source[0] : source;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if ((!normalized && required) || (normalized && !IDEMPOTENCY_KEY.test(normalized))) {
    throw new AiSystemRegistryError(
      required ? `${name} header is required and must be valid` : `${name} header is invalid`,
      400,
      'AI_DOSSIER_IDEMPOTENCY_REQUIRED',
    );
  }
  return normalized || null;
}

function actor(req: Request): CanonicalAuditActor {
  const user = (req as AuthenticatedRequest).user!;
  const oidc = user.auth_method === 'oidc' && /^(?:entra|oidc):/.test(user.username);
  return {
    type: 'human',
    id: String(user.id),
    ssoSubject: oidc ? user.username : null,
    authMethod: oidc ? 'oidc' : user.auth_method ?? 'session',
    effectiveRoles: [user.role],
  };
}

function routeError(res: Response, error: unknown): void {
  if (error instanceof WorkspaceScopeAccessError) {
    res.status(error.status).json({
      schemaVersion: 1,
      kind: 'ai-compliance-dossier-error',
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({
      schemaVersion: 1,
      kind: 'ai-compliance-dossier-error',
      error: { code: 'validation_failed', message: 'Compliance dossier request validation failed', issueCodes: error.issues.map(issue => issue.path.join('.') || issue.code) },
    });
    return;
  }
  if (error instanceof AiSystemRegistryError) {
    res.status(error.status).json({ schemaVersion: 1, kind: 'ai-compliance-dossier-error', error: { code: error.code, message: error.message } });
    return;
  }
  logger.error({ err: error }, 'AI compliance dossier request failed');
  res.status(500).json({ schemaVersion: 1, kind: 'ai-compliance-dossier-error', error: { code: 'AI_DOSSIER_FAILED', message: 'AI compliance dossier request failed' } });
}

function unavailableFreshMfa(_req: Request, res: Response): void {
  res.status(503).json({ error: 'Fresh MFA enforcement is not configured for compliance dossiers', code: 'AI_DOSSIER_MFA_UNAVAILABLE' });
}

export function registerAiComplianceDossierRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  requireSameOrigin: RequestHandler,
  requireFreshMfa: RequestHandler = unavailableFreshMfa,
  overrides: Partial<AiComplianceDossierRouteDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const canRead = requirePermission('compliance.read');
  const canGenerate = requirePermission('compliance.dossier_generate');
  const canExport = requirePermission('compliance.dossier_export');

  app.get('/api/ui/compliance/ai-systems/:aiSystemId/dossiers', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const dossiers = await dependencies.list(pool, scope, uuidSchema.parse(req.params['aiSystemId']), limitSchema.parse(req.query['limit']));
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ schemaVersion: 1, kind: 'ai-compliance-dossier-list', dossiers });
    } catch (error) { routeError(res, error); }
  });

  app.post('/api/ui/compliance/ai-systems/:aiSystemId/dossiers', requireAuth, canGenerate, requireSameOrigin, requireFreshMfa, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const authorized = resolveAuthorizedWorkspaceScope(req, user);
      const producerEventId = header(req, 'idempotency-key', true)!;
      const requestId = header(req, 'x-request-id');
      const result = await dependencies.generate(pool, {
        scope: { ...authorized, environment: process.env['NODE_ENV'] || 'development' },
        actor: actor(req),
        producerEventId,
        requestId,
        now: dependencies.now,
        uuid: dependencies.uuid,
      }, uuidSchema.parse(req.params['aiSystemId']), aiActComplianceDossierGenerationInputSchema.parse(req.body));
      res.status(result.replayed ? 200 : 201).json({
        schemaVersion: 1,
        kind: 'ai-compliance-dossier',
        dossier: result,
        auditEventId: result.auditEvent.eventId,
      });
    } catch (error) { routeError(res, error); }
  });

  app.get('/api/ui/compliance/dossiers/:dossierId', requireAuth, canRead, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const dossier = await dependencies.get(pool, scope, uuidSchema.parse(req.params['dossierId']));
      if (!dossier) { res.status(404).json({ error: 'Compliance dossier not found' }); return; }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ schemaVersion: 1, kind: 'ai-compliance-dossier', dossier });
    } catch (error) { routeError(res, error); }
  });

  app.get([
    '/api/ui/compliance/dossiers/:dossierId/artifacts/:format',
    '/api/ui/compliance/dossiers/:dossierId/artifacts/:format/content',
  ], requireAuth, canExport, requireFreshMfa, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const dossierId = uuidSchema.parse(req.params['dossierId']);
      const format = artifactFormatSchema.parse(req.params['format']) as AiComplianceDossierArtifactFormat;
      const artifact = await dependencies.loadArtifact(pool, scope, dossierId, format);
      if (!artifact) { res.status(404).json({ error: 'Compliance dossier not found' }); return; }
      const exportEvent = await dependencies.recordExport(
        pool,
        artifact.dossier,
        format,
        actor(req),
        header(req, 'idempotency-key') ?? `dossier-export-${dependencies.uuid()}`,
        dependencies.now(),
      );
      const digest = createHash('sha256').update(artifact.bytes).digest();
      const digestHex = digest.toString('hex');
      const clientDelivery = req.path.endsWith('/content');
      const headers: Record<string, string> = {
        'Cache-Control': 'private, no-store',
        'Content-Type': clientDelivery ? 'application/vnd.argus.ai-compliance-dossier-artifact' : artifact.mediaType,
        'Content-Length': String(artifact.bytes.length),
        'Content-Digest': `sha-256=:${digest.toString('base64')}:`,
        'ETag': `"${digestHex}"`,
        'X-Argus-Dossier-Id': dossierId,
        'X-Argus-Dossier-Digest': artifact.dossier.manifest.dossierSha256,
        'X-Argus-Audit-Event-Id': exportEvent.eventId,
        'X-Argus-Artifact-Filename': artifact.filename,
        'X-Argus-Artifact-Content-Type': artifact.mediaType,
      };
      if (!clientDelivery) headers['Content-Disposition'] = `attachment; filename="${artifact.filename}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`;
      res.status(200).set(headers).send(artifact.bytes);
    } catch (error) { routeError(res, error); }
  });
}
