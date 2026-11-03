import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { canonicalAuditDigest } from './canonicalAuditRedaction.js';
import { appendCanonicalAuditEvent } from './canonicalAuditStore.js';
import type { CanonicalAuditActor } from './canonicalAuditTypes.js';
import { createCanonicalAuditCheckpoint, type AuditCheckpointSigner } from './checkpoints.js';
import { createAuditEvidencePack, recordAuditEvidencePackExport, verifyAuditEvidencePack } from './evidencePack.js';
import {
  addAuditReportReviewRow, advanceAuditReportDefinition, completeAuditReportRun, createAuditReportRun,
  failAuditReportRun, getAuditReportRun, listDueAuditReportDefinitions, listQueuedAuditReportRuns,
  markAuditReportRunning, requeueStaleAuditReportRuns,
} from './reportStore.js';
import type { AuditReportDefinition, AuditReportFilters, AuditReportRun, AuditReportSummary } from './reportTypes.js';

export interface AuditReportServiceOptions { signer: AuditCheckpointSigner; now?: () => Date }

function summaryFor(run: AuditReportRun, events: NonNullable<AuditReportRun['evidencePack']>['events'], mappings: AuditReportSummary['controlCoverage'], gaps: string[]): AuditReportSummary {
  const actions = new Map<string, number>();
  const actors = new Set<string>();
  let successCount = 0, deniedCount = 0, failureCount = 0, criticalRiskCount = 0;
  for (const event of events) {
    actions.set(event.action, (actions.get(event.action) ?? 0) + 1);
    actors.add(`${event.actor.type}:${event.actor.id}`);
    if (event.outcome === 'success') successCount += 1;
    if (event.outcome === 'denied') deniedCount += 1;
    if (event.outcome === 'failure') failureCount += 1;
    if (event.risk === 'critical') criticalRiskCount += 1;
  }
  return {
    title: run.name, period: { from: run.periodFrom, to: run.periodTo }, eventCount: events.length,
    actorCount: actors.size, successCount, deniedCount, failureCount, criticalRiskCount,
    topActions: [...actions].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)).slice(0, 12),
    controlCoverage: mappings, gapCodes: gaps,
  };
}

export async function generateAuditReportRun(pool: pg.Pool, id: string, options: AuditReportServiceOptions): Promise<AuditReportRun> {
  const now = options.now ?? (() => new Date());
  const initial = await pool.query<Record<string, unknown>>(`SELECT * FROM mcp_audit_report_runs WHERE id=$1`, [id]);
  if (!initial.rows[0]) throw new Error('audit report run not found');
  const scope = { workspaceKey: String(initial.rows[0]['workspace_key']), tenantKey: String(initial.rows[0]['tenant_key']), environment: String(initial.rows[0]['environment']) };
  const claimed = await markAuditReportRunning(pool, id, now());
  if (!claimed) {
    const current = await getAuditReportRun(pool, id, scope.workspaceKey, scope.tenantKey);
    if (current?.status === 'completed') return current;
    throw new Error('audit report run is already being processed or is terminal');
  }
  try {
    await createCanonicalAuditCheckpoint(pool, scope, options.signer, { now });
    const pack = await createAuditEvidencePack(pool, {
      ...scope, from: new Date(initial.rows[0]['period_from'] as string).toISOString(), to: new Date(initial.rows[0]['period_to'] as string).toISOString(),
      ...((initial.rows[0]['filters'] ?? {}) as AuditReportFilters), generatedBy: { actorId: String(initial.rows[0]['requested_by']), authMethod: 'report-service' }, now,
    });
    const verification = verifyAuditEvidencePack(pack);
    if (verification.state !== 'valid') throw new Error(`generated evidence pack failed verification: ${verification.reasons.join(',')}`);
    const run = await getAuditReportRun(pool, id, scope.workspaceKey, scope.tenantKey);
    if (!run) throw new Error('audit report run disappeared');
    const gaps = pack.manifest.declaredGaps.map(gap => gap.code);
    const summary = summaryFor(run, pack.events, pack.manifest.controlMapping, gaps);
    await recordAuditEvidencePackExport(pool, pack, {
      type: 'system', id: 'audit-report-service', authMethod: 'internal', effectiveRoles: ['system'],
    }, `audit-report:${id}`);
    await completeAuditReportRun(pool, id, {
      checkpointId: pack.checkpoint.checkpointId, packId: pack.manifest.packId, packDigest: pack.packDigest,
      eventCount: pack.manifest.eventCount, chainEntryCount: pack.manifest.chainEntryCount, gapCodes: gaps,
      summary, evidencePack: pack, completedAt: now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown audit report generation failure';
    await failAuditReportRun(pool, id, 'AUDIT_REPORT_GENERATION_FAILED', message, now()).catch(() => undefined);
    throw error;
  }
  const completed = await getAuditReportRun(pool, id, scope.workspaceKey, scope.tenantKey);
  if (!completed) throw new Error('completed audit report could not be loaded');
  return completed;
}

export async function createAndGenerateAuditReport(pool: pg.Pool, input: {
  definitionId?: string | null; workspaceKey: string; tenantKey: string; environment: string; reportType: AuditReportRun['reportType'];
  name: string; triggerType: AuditReportRun['triggerType']; requestedBy: string; periodFrom: Date; periodTo: Date; filters?: AuditReportFilters;
}, options: AuditReportServiceOptions): Promise<AuditReportRun> {
  const queued = await createAuditReportRun(pool, { ...input, filters: input.filters ?? {} });
  return generateAuditReportRun(pool, queued.id, options);
}

export async function reviewAuditReport(pool: pg.Pool, run: AuditReportRun, decision: 'approved' | 'rejected', comment: string, actor: CanonicalAuditActor, now = new Date()) {
  if (run.status !== 'completed' || run.verificationState !== 'valid' || !run.packDigest) throw new Error('only a valid completed audit report can be reviewed');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await appendCanonicalAuditEvent(client, {
      producer: { name: 'audit.report.review', eventId: randomUUID() }, occurredAt: now,
      environment: run.environment, workspaceKey: run.workspaceKey, tenantKey: run.tenantKey, solution: 'argus.core', actor,
      action: `audit.report.${decision}`, outcome: 'success', risk: 'high',
      resource: { type: 'audit_report', id: run.id, revision: run.packDigest },
      policy: { id: 'argus.audit.report-review', version: '1', decision: 'allow' },
      payload: { after: { decision, commentDigest: canonicalAuditDigest(comment), reportPackDigest: run.packDigest } },
      retentionClass: 'business-audit-governance',
    });
    const review = await addAuditReportReviewRow(client, { id: randomUUID(), reportRunId: run.id, decision, actorId: actor.id,
      actorAuthMethod: actor.authMethod, commentDigest: canonicalAuditDigest(comment), occurredAt: now, auditEventId: event.eventId });
    await client.query('COMMIT');
    return review;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

/**
 * Canonical, user-attributed record of a report artifact leaving Argus.
 * Must be committed before the artifact is sent; callers fail closed when it
 * throws. Every download is its own event (no idempotent replay), so repeated
 * downloads stay individually visible in the audit trail.
 */
export async function recordAuditReportArtifactExport(
  pool: pg.Pool,
  run: AuditReportRun,
  artifact: { format: string; sha256: string; bytes: number },
  actor: CanonicalAuditActor,
  now = new Date(),
): Promise<{ eventId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await appendCanonicalAuditEvent(client, {
      producer: { name: 'audit.report.artifact_export', eventId: randomUUID() }, occurredAt: now,
      environment: run.environment, workspaceKey: run.workspaceKey, tenantKey: run.tenantKey, solution: 'argus.core', actor,
      action: 'audit.report.artifact_exported', outcome: 'success', risk: 'critical',
      resource: { type: 'audit_report', id: run.id, revision: run.packDigest },
      policy: { id: 'argus.audit.report-export', version: '1', decision: 'allow' },
      payload: { after: { format: artifact.format, artifactSha256: artifact.sha256, artifactBytes: artifact.bytes, reportPackDigest: run.packDigest } },
      retentionClass: 'business-audit-governance',
    });
    await client.query('COMMIT');
    return { eventId: event.eventId };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

export function startAuditReportWorker(pool: pg.Pool, options: AuditReportServiceOptions & { intervalSec: number }): { stop(): void } {
  let stopped = false, running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const requeued = await requeueStaleAuditReportRuns(pool, options.now?.() ?? new Date());
      if (requeued > 0) logger.warn({ requeued }, 'Recovered stale audit report runs');
      for (const runId of await listQueuedAuditReportRuns(pool)) {
        try { await generateAuditReportRun(pool, runId, options); }
        catch (error) {
          if (!(error instanceof Error && error.message.includes('already being processed'))) {
            logger.error({ err: error, auditReportRunId: runId }, 'Queued audit report failed');
          }
        }
      }
      const due = await listDueAuditReportDefinitions(pool, options.now?.() ?? new Date());
      for (const definition of due) {
        const periodTo = new Date(definition.nextRunAt ?? (options.now?.() ?? new Date()).toISOString());
        const periodFrom = new Date(periodTo.getTime() - definition.windowDays * 86_400_000);
        try {
          await createAndGenerateAuditReport(pool, { definitionId: definition.id, workspaceKey: definition.workspaceKey,
            tenantKey: definition.tenantKey, environment: definition.environment, reportType: definition.reportType, name: definition.name,
            triggerType: 'scheduled', requestedBy: 'audit-report-scheduler', periodFrom, periodTo, filters: definition.filters }, options);
        } catch (error) { logger.error({ err: error, auditReportDefinitionId: definition.id }, 'Scheduled audit report failed'); }
        await advanceAuditReportDefinition(pool, definition, options.now?.() ?? new Date());
      }
    } catch (error) { logger.error({ err: error }, 'Audit report scheduler tick failed'); } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), Math.max(15, options.intervalSec) * 1000);
  timer.unref();
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
