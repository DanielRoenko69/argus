import type { Express, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { requirePermission, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import type { SessionUser } from '../auth/userAuth.js';
import { hasFreshMfaSession } from '../auth/userAuth.js';
import {
  resolveAuthorizedWorkspaceScope,
  type AuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import type { AuditCheckpointSigner } from './checkpoints.js';
import type { ExternalAnchorKind, ExternalEvidenceAnchorProvider } from './externalAnchorProvider.js';
import { anchorAuditEvidencePack, listExternalEvidenceAnchors } from './externalAnchorService.js';
import { auditReportArtifact, auditReportPdf } from './reportExport.js';
import { assertAuditReportTimezone } from './reportSchedule.js';
import {
  createAuditReportDefinition, disableAuditReportDefinition, getAuditReportDefinition, getAuditReportRun,
  listAuditReportDefinitions, listAuditReportRuns,
} from './reportStore.js';
import { createAndGenerateAuditReport, recordAuditReportArtifactExport, reviewAuditReport } from './reportService.js';
import type { AuditReportCadence, AuditReportFilters, AuditReportFormat, AuditReportType } from './reportTypes.js';

interface Options {
  enabled: boolean;
  signer: AuditCheckpointSigner | null;
  requireSameOrigin?: RequestHandler;
  requireFreshMfa?: RequestHandler;
  mfaMaxAgeSeconds?: number;
  externalAnchorProvider?: ExternalEvidenceAnchorProvider | null;
  now?: () => Date;
  resolveScope?: (req: Parameters<RequestHandler>[0], user: SessionUser) => AuthorizedWorkspaceScope;
  recordArtifactExport?: typeof recordAuditReportArtifactExport;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@|/-]{0,255}$/;
const REPORT_TYPES = new Set<AuditReportType>(['governance', 'compliance', 'run_evidence', 'incident']);
const CADENCES = new Set<AuditReportCadence>(['manual', 'daily', 'weekly', 'monthly']);
const FORMATS = new Set<AuditReportFormat>(['pdf', 'json', 'jsonl', 'csv']);

function rejectUnauthorizedScope(res: Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceScopeAccessError)) return false;
  res.status(error.status).json({ error: error.message, code: error.code });
  return true;
}
const ANCHOR_KINDS = new Set<ExternalAnchorKind>(['worm_object', 'qualified_timestamp', 'transparency_log']);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function body(req: Parameters<RequestHandler>[0]): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}
function text(value: unknown, name: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) throw new Error(`${name} is required and must be at most ${max} characters`);
  return normalized;
}
function identifier(value: unknown, name: string, fallback?: string): string {
  const normalized = typeof value === 'string' && value.trim() ? value.trim() : fallback ?? '';
  if (!IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}
function integer(value: unknown, name: string, min: number, max: number, fallback: number): number {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}
function date(value: unknown, name: string, fallback: Date): Date {
  const parsed = value == null || value === '' ? fallback : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return parsed;
}
function uuid(value: unknown): string {
  const normalized = String(value ?? '');
  if (!UUID.test(normalized)) throw new Error('id must be a UUID');
  return normalized;
}
function actor(user: SessionUser) {
  const sso = user.auth_method === 'oidc' || /^(?:oidc|entra)[:|]/i.test(user.username);
  return { type: 'human' as const, id: String(user.id), ssoSubject: sso ? user.username : null,
    authMethod: sso ? 'oidc' : 'session', effectiveRoles: [user.role] };
}
function idempotencyKey(req: Parameters<RequestHandler>[0]): string {
  const raw = req.headers['idempotency-key'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  if (!IDEMPOTENCY_KEY.test(value)) throw new Error('Idempotency-Key header is required and must be a stable identifier');
  return value;
}
function filters(value: unknown): AuditReportFilters {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result: AuditReportFilters = {};
  for (const [input, output] of [['actorId', 'actorId'], ['actor_id', 'actorId'], ['action', 'action'], ['resourceType', 'resourceType'], ['resource_type', 'resourceType'], ['resourceId', 'resourceId'], ['resource_id', 'resourceId']] as const) {
    if (source[input] != null && source[input] !== '') result[output] = identifier(source[input], input);
  }
  return result;
}
function unavailable(res: Parameters<RequestHandler>[1], options: Options): boolean {
  if (!options.enabled) { res.status(404).json({ error: 'Not found' }); return true; }
  return false;
}

export function registerAuditReportRoutes(app: Express, pool: pg.Pool, requireAuth: RequestHandler, options: Options): void {
  const sameOrigin = options.requireSameOrigin ?? ((_req, _res, next) => next());
  const freshMfa = options.requireFreshMfa ?? ((_req, res) => {
    res.status(503).json({ error: 'MFA step-up enforcement is not configured', code: 'MFA_STEP_UP_UNAVAILABLE' });
  });
  const now = options.now ?? (() => new Date());
  const mfaMaxAgeSeconds = options.mfaMaxAgeSeconds ?? 600;
  const scope = options.resolveScope ?? resolveAuthorizedWorkspaceScope;
  const recordArtifactExport = options.recordArtifactExport ?? recordAuditReportArtifactExport;
  app.get('/api/ui/audit/reports/v1', requireAuth, requirePermission('audit.read'), async (req, res) => {
    if (unavailable(res, options)) return;
    try {
      const user = (req as AuthenticatedRequest).user!;
      const authorized = scope(req, user);
      const [definitions, runs, counts] = await Promise.all([
        listAuditReportDefinitions(pool, authorized.workspaceKey, authorized.tenantKey),
        listAuditReportRuns(pool, authorized.workspaceKey, authorized.tenantKey),
        pool.query<{ events: string; checkpoints: string; environments: string[] }>(`SELECT (SELECT count(*) FROM mcp_canonical_audit_events WHERE workspace_key=$1 AND tenant_key=$2)::text AS events,(SELECT count(*) FROM mcp_canonical_audit_checkpoints WHERE workspace_key=$1 AND tenant_key=$2)::text AS checkpoints,COALESCE((SELECT array_agg(DISTINCT environment ORDER BY environment) FROM mcp_canonical_audit_events WHERE workspace_key=$1 AND tenant_key=$2),'{}'::text[]) AS environments`, [authorized.workspaceKey, authorized.tenantKey]),
      ]);
      const count = counts.rows[0] ?? { events: '0', checkpoints: '0', environments: [] };
      const anchors = await listExternalEvidenceAnchors(pool, runs.map(run => run.id));
      const anchorsByRun = new Map<string, typeof anchors>();
      for (const anchor of anchors) anchorsByRun.set(anchor.reportRunId, [...(anchorsByRun.get(anchor.reportRunId) ?? []), anchor]);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        readiness: { enabled: true, signingConfigured: Boolean(options.signer), canonicalEventCount: Number(count.events), checkpointCount: Number(count.checkpoints), environments: count.environments, ready: Boolean(options.signer) && Number(count.events) > 0 },
        exportSecurity: {
          requiresFreshMfa: true,
          satisfied: hasFreshMfaSession(user, mfaMaxAgeSeconds, now()),
          maxAgeSeconds: mfaMaxAgeSeconds,
          stepUpUrl: '/auth/oidc/step-up?returnTo=%2Fobserve%2Faudit%3Ftab%3Dreports',
        },
        externalAnchoring: {
          enabled: Boolean(options.externalAnchorProvider),
          provider: options.externalAnchorProvider?.name ?? null,
          supportedKinds: options.externalAnchorProvider?.supportedKinds ?? [],
          requiresFreshMfa: true,
        },
        definitions,
        runs: runs.map(run => ({ ...run, externalAnchors: anchorsByRun.get(run.id) ?? [] })),
      });
    } catch (error) { if (rejectUnauthorizedScope(res, error)) return; logger.error({ err: error }, 'Audit report catalog failed'); res.status(500).json({ error: 'Audit reports could not be loaded' }); }
  });

  app.post('/api/ui/audit/report-definitions/v1', requireAuth, requirePermission('audit.export'), sameOrigin, async (req, res) => {
    if (unavailable(res, options)) return;
    try {
      const user = (req as AuthenticatedRequest).user!; const input = body(req); const authorized = scope(req, user);
      const reportType = input['reportType'] ?? input['report_type'];
      const cadence = input['cadence'];
      if (!REPORT_TYPES.has(reportType as AuditReportType)) throw new Error('reportType is invalid');
      if (!CADENCES.has(cadence as AuditReportCadence)) throw new Error('cadence is invalid');
      const reportFormats = Array.isArray(input['formats']) ? [...new Set(input['formats'])] : ['pdf', 'json', 'csv'];
      if (reportFormats.length === 0 || reportFormats.some(format => !FORMATS.has(format as AuditReportFormat))) throw new Error('formats are invalid');
      const scheduleWeekday = cadence === 'weekly' ? integer(input['scheduleWeekday'] ?? input['schedule_weekday'], 'scheduleWeekday', 0, 6, 1) : null;
      const scheduleMonthday = cadence === 'monthly' ? integer(input['scheduleMonthday'] ?? input['schedule_monthday'], 'scheduleMonthday', 1, 28, 1) : null;
      const definition = await createAuditReportDefinition(pool, {
        ...authorized, environment: identifier(input['environment'], 'environment', 'production'), name: text(input['name'], 'name', 160),
        reportType: reportType as AuditReportType, cadence: cadence as AuditReportCadence,
        timezone: assertAuditReportTimezone(typeof input['timezone'] === 'string' ? input['timezone'] : 'Europe/Berlin'),
        scheduleHour: integer(input['scheduleHour'] ?? input['schedule_hour'], 'scheduleHour', 0, 23, 8), scheduleWeekday, scheduleMonthday,
        windowDays: integer(input['windowDays'] ?? input['window_days'], 'windowDays', 1, 366, 30), filters: filters(input['filters']),
        formats: reportFormats as AuditReportFormat[], createdBy: String(user.id), now: now(),
      });
      res.status(201).json({ definition });
    } catch (error) { if (rejectUnauthorizedScope(res, error)) return; res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid report definition' }); }
  });

  app.post('/api/ui/audit/report-definitions/v1/:id/disable', requireAuth, requirePermission('audit.export'), sameOrigin, async (req, res) => {
    if (unavailable(res, options)) return;
    try { const user = (req as AuthenticatedRequest).user!; const authorized = scope(req, user); const definition = await disableAuditReportDefinition(pool, uuid(req.params['id']), authorized.workspaceKey, authorized.tenantKey, now());
      if (!definition) { res.status(404).json({ error: 'Enabled report definition not found' }); return; } res.json({ definition });
    } catch (error) { if (rejectUnauthorizedScope(res, error)) return; res.status(400).json({ error: error instanceof Error ? error.message : 'Report schedule could not be disabled' }); }
  });

  const generate = async (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => {
    if (unavailable(res, options)) return;
    if (!options.signer) { res.status(503).json({ error: 'Audit signing is not configured', code: 'AUDIT_SIGNING_NOT_CONFIGURED' }); return; }
    try {
      const user = (req as AuthenticatedRequest).user!; const input = body(req); const authorized = scope(req, user);
      let definition = null;
      if (req.params['id']) definition = await getAuditReportDefinition(pool, uuid(req.params['id']), authorized.workspaceKey, authorized.tenantKey);
      if (req.params['id'] && (!definition || !definition.enabled)) { res.status(404).json({ error: 'Enabled report definition not found' }); return; }
      const periodTo = date(input['to'], 'to', now());
      const windowDays = definition?.windowDays ?? integer(input['windowDays'] ?? input['window_days'], 'windowDays', 1, 366, 30);
      const periodFrom = date(input['from'], 'from', new Date(periodTo.getTime() - windowDays * 86_400_000));
      if (periodFrom > periodTo) throw new Error('from must not be after to');
      const reportType = definition?.reportType ?? (input['reportType'] ?? input['report_type'] ?? 'governance');
      if (!REPORT_TYPES.has(reportType as AuditReportType)) throw new Error('reportType is invalid');
      const run = await createAndGenerateAuditReport(pool, {
        definitionId: definition?.id, ...authorized, environment: definition?.environment ?? identifier(input['environment'], 'environment', 'production'),
        reportType: reportType as AuditReportType, name: definition?.name ?? text(input['name'] ?? 'On-demand governance evidence', 'name', 160),
        triggerType: 'manual', requestedBy: String(user.id), periodFrom, periodTo, filters: definition?.filters ?? filters(input['filters']),
      }, { signer: options.signer, now });
      res.status(201).json({ run });
    } catch (error) { if (rejectUnauthorizedScope(res, error)) return; logger.error({ err: error }, 'Audit report generation failed'); res.status(422).json({ error: error instanceof Error ? error.message : 'Audit report generation failed' }); }
  };
  app.post('/api/ui/audit/report-runs/v1', requireAuth, requirePermission('audit.export'), sameOrigin, freshMfa, generate);
  app.post('/api/ui/audit/report-definitions/v1/:id/run', requireAuth, requirePermission('audit.export'), sameOrigin, freshMfa, generate);

  app.post('/api/ui/audit/report-runs/v1/:id/external-anchors', requireAuth, requirePermission('compliance.external_anchor'), sameOrigin, freshMfa, async (req, res) => {
    if (unavailable(res, options)) return;
    if (!options.externalAnchorProvider) { res.status(503).json({ error: 'External evidence anchoring is not configured', code: 'EXTERNAL_ANCHOR_NOT_CONFIGURED' }); return; }
    try {
      const input = body(req); const anchorKind = input['anchorKind'];
      if (!ANCHOR_KINDS.has(anchorKind as ExternalAnchorKind)) throw new Error('anchorKind is invalid');
      const user = (req as AuthenticatedRequest).user!; const authorized = scope(req, user);
      const report = await getAuditReportRun(pool, uuid(req.params['id']), authorized.workspaceKey, authorized.tenantKey);
      if (!report) { res.status(404).json({ error: 'Audit report not found' }); return; }
      const result = await anchorAuditEvidencePack(pool, {
        scope: { ...authorized, environment: report.environment }, actor: actor(user),
        producerEventId: idempotencyKey(req), requestId: String(req.headers['x-request-id'] ?? randomUUID()),
        mfaVerifiedAt: user.mfa_verified_at ?? '', mfaMethod: user.mfa_method ?? '',
        mfaMaxAgeSeconds, now,
      }, report.id, anchorKind as ExternalAnchorKind, options.externalAnchorProvider);
      res.status(result.replayed ? 200 : 201).json({ anchor: result.anchor, auditEventId: result.auditEvent.eventId, replayed: result.replayed });
    } catch (error) {
      if (rejectUnauthorizedScope(res, error)) return;
      logger.error({ err: error }, 'External Evidence Pack anchoring failed');
      res.status(422).json({ error: error instanceof Error ? error.message : 'External Evidence Pack anchoring failed', code: 'EXTERNAL_ANCHOR_FAILED' });
    }
  });

  app.get(['/api/ui/audit/report-runs/v1/:id/artifacts/:format', '/api/ui/audit/report-runs/v1/:id/artifacts/:format/content'], requireAuth, requirePermission('audit.export'), freshMfa, async (req, res) => {
    if (unavailable(res, options)) return;
    try {
      const format = String(req.params['format']); if (!FORMATS.has(format as AuditReportFormat)) throw new Error('format is invalid');
      const user = (req as AuthenticatedRequest).user!; const authorized = scope(req, user); const run = await getAuditReportRun(pool, uuid(req.params['id']), authorized.workspaceKey, authorized.tenantKey, true);
      if (!run) { res.status(404).json({ error: 'Audit report not found' }); return; }
      const filename = `argus-audit-report-${run.id}.${format}`;
      const contentType = format === 'pdf' ? 'application/pdf' : format === 'csv' ? 'text/csv; charset=utf-8' : format === 'jsonl' ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8';
      const artifact = format === 'pdf'
        ? await auditReportPdf(run)
        : Buffer.from(auditReportArtifact(run, format as Exclude<AuditReportFormat, 'pdf'>), 'utf8');
      const artifactDigest = createHash('sha256').update(artifact).digest();
      const artifactDigestHex = artifactDigest.toString('hex');
      // Fail closed: the human read is committed to the canonical audit chain
      // before a single byte of the artifact leaves Argus.
      let exportEventId: string;
      try {
        ({ eventId: exportEventId } = await recordArtifactExport(pool, run, {
          format, sha256: artifactDigestHex, bytes: artifact.length,
        }, actor(user), now()));
      } catch (auditError) {
        logger.error({ err: auditError, reportId: run.id }, 'Audit report artifact export could not be audited');
        res.status(503).json({ error: 'The export could not be recorded in the audit trail', code: 'AUDIT_EXPORT_NOT_RECORDED' });
        return;
      }
      const clientDelivery = req.path.endsWith('/content');
      const headers: Record<string, string> = {
        'Cache-Control': 'private, no-store',
        'Content-Type': clientDelivery ? 'application/vnd.argus.audit-artifact' : contentType,
        'Content-Length': String(artifact.length),
        'Content-Digest': `sha-256=:${artifactDigest.toString('base64')}:`,
        'ETag': `"${artifactDigestHex}"`,
        'X-Argus-Report-Id': run.id,
        'X-Argus-Evidence-Pack-Digest': run.packDigest ?? '',
        'X-Argus-Artifact-Filename': filename,
        'X-Argus-Artifact-Content-Type': contentType,
        'X-Argus-Audit-Event-Id': exportEventId,
      };
      if (!clientDelivery) headers['Content-Disposition'] = `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
      res.status(200).set(headers).send(artifact);
    } catch (error) { if (rejectUnauthorizedScope(res, error)) return; res.status(400).json({ error: error instanceof Error ? error.message : 'Report artifact could not be loaded' }); }
  });

  app.post('/api/ui/audit/report-runs/v1/:id/reviews', requireAuth, requirePermission('audit.export'), sameOrigin, async (req, res) => {
    if (unavailable(res, options)) return;
    try {
      const user = (req as AuthenticatedRequest).user!; const input = body(req); const decision = input['decision'];
      if (decision !== 'approved' && decision !== 'rejected') throw new Error('decision must be approved or rejected');
      const comment = text(input['comment'], 'comment', 4000); const authorized = scope(req, user);
      const run = await getAuditReportRun(pool, uuid(req.params['id']), authorized.workspaceKey, authorized.tenantKey);
      if (!run) { res.status(404).json({ error: 'Audit report not found' }); return; }
      const review = await reviewAuditReport(pool, run, decision, comment, actor(user), now()); res.status(201).json({ review });
    } catch (error) { if (rejectUnauthorizedScope(res, error)) return; res.status(400).json({ error: error instanceof Error ? error.message : 'Audit report review failed' }); }
  });
}
