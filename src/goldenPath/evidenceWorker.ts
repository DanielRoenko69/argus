import type pg from 'pg';
import { appendCanonicalAuditEvent } from '../audit/canonicalAuditStore.js';
import type { AuditCheckpointSigner } from '../audit/checkpoints.js';
import { generateAuditReportRun } from '../audit/reportService.js';
import { createAuditReportRun, getAuditReportRun } from '../audit/reportStore.js';
import { canonicalAuditDigest, redactCanonicalAuditPayload } from '../audit/canonicalAuditRedaction.js';
import { logger } from '../lib/logger.js';
import { workflowTelemetryTraceId } from '../observability/telemetryStore.js';

interface GoldenPathEvidenceCandidate extends pg.QueryResultRow {
  id: string;
  workflow_execution_id: number | string;
  created_by_user_id: number | null;
  tenant_key: string;
  workspace_key: string;
  environment: string;
  started_at: string | Date;
  audit_report_run_id: string | null;
  evidence_status: 'pending' | 'generating' | 'complete' | 'failed';
}

interface ActiveExecution extends pg.QueryResultRow {
  id: number | string;
  status: 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';
  started_at: string | Date;
  completed_at: string | Date | null;
  error_message: string | null;
  step_results: Record<string, unknown> | null;
  retry_of_execution_id: number | string | null;
  retry_depth: number | string;
  approval_id: number | string | null;
  approval_status: string | null;
}

export interface GoldenPathEvidenceWorkerOptions {
  signer: AuditCheckpointSigner;
  intervalSec?: number;
  now?: () => Date;
}

function digest(value: unknown): string {
  return canonicalAuditDigest(redactCanonicalAuditPayload(value));
}

async function listCandidates(pool: pg.Pool): Promise<GoldenPathEvidenceCandidate[]> {
  const result = await pool.query<GoldenPathEvidenceCandidate>(
    `SELECT id, workflow_execution_id, created_by_user_id, tenant_key, workspace_key,
            environment, started_at, audit_report_run_id, evidence_status
       FROM mcp_golden_path_runs
      WHERE workflow_execution_id IS NOT NULL
        AND (
          evidence_status IN ('pending', 'failed')
          OR (evidence_status='generating' AND evidence_updated_at < now() - interval '10 minutes')
        )
      ORDER BY started_at
      LIMIT 20`,
  );
  return result.rows;
}

async function loadActiveExecution(pool: pg.Pool, rootExecutionId: number): Promise<ActiveExecution | null> {
  const result = await pool.query<ActiveExecution>(
    `WITH RECURSIVE executions AS (
       SELECT root.*, 0 AS retry_depth
         FROM mcp_workflow_executions root
        WHERE root.id=$1
       UNION ALL
       SELECT child.*, parent.retry_depth + 1
         FROM mcp_workflow_executions child
         JOIN executions parent ON child.retry_of_execution_id=parent.id
     )
     SELECT latest.*,
            approval.id AS approval_id,
            approval.status AS approval_status
       FROM executions latest
       LEFT JOIN LATERAL (
         WITH RECURSIVE lineage AS (
           SELECT current.id, current.retry_of_execution_id
             FROM mcp_workflow_executions current
            WHERE current.id=latest.id
           UNION ALL
           SELECT parent.id, parent.retry_of_execution_id
             FROM mcp_workflow_executions parent
             JOIN lineage child ON child.retry_of_execution_id=parent.id
         )
         SELECT runtime.id, runtime.status
           FROM mcp_runtime_approvals runtime
           JOIN lineage ON lineage.id=runtime.workflow_execution_id
          ORDER BY runtime.requested_at DESC, runtime.id DESC
          LIMIT 1
       ) approval ON true
      ORDER BY latest.retry_depth DESC, latest.id DESC
      LIMIT 1`,
    [rootExecutionId],
  );
  return result.rows[0] ?? null;
}

function isTerminal(execution: ActiveExecution): boolean {
  return ['completed', 'failed', 'cancelled'].includes(execution.status);
}

async function appendTerminalEvent(
  pool: pg.Pool,
  candidate: GoldenPathEvidenceCandidate,
  execution: ActiveExecution,
  now: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rejected = execution.status === 'cancelled' && execution.approval_status === 'rejected';
    await appendCanonicalAuditEvent(client, {
      producer: {
        name: 'golden-path.evidence',
        eventId: `terminal:${candidate.id}:${execution.id}`,
      },
      occurredAt: execution.completed_at ?? now,
      environment: candidate.environment,
      workspaceKey: candidate.workspace_key,
      tenantKey: candidate.tenant_key,
      solution: 'argus.core',
      actor: {
        type: 'system',
        id: 'golden-path-evidence-worker',
        authMethod: 'internal',
        effectiveRoles: ['system'],
      },
      action: rejected
        ? 'golden_path.run.rejected'
        : execution.status === 'completed'
          ? 'golden_path.run.completed'
          : execution.status === 'cancelled'
            ? 'golden_path.run.cancelled'
            : 'golden_path.run.failed',
      outcome: rejected
        ? 'denied'
        : execution.status === 'completed'
          ? 'success'
          : execution.status === 'cancelled' ? 'cancelled' : 'failure',
      risk: execution.status === 'completed' ? 'medium' : 'high',
      resource: {
        type: 'golden_path_run',
        id: candidate.id,
        revision: digest({ executionId: execution.id, steps: execution.step_results }),
      },
      policy: {
        id: 'argus.golden-path.v1',
        version: '1',
        decision: rejected ? 'deny' : 'allow',
      },
      approvalId: execution.approval_id == null ? null : String(execution.approval_id),
      correlation: {
        rootRunId: String(execution.id),
        traceId: workflowTelemetryTraceId(Number(execution.id)),
      },
      payload: {
        after: {
          goldenPathRunId: candidate.id,
          workflowExecutionId: Number(execution.id),
          retryOfExecutionId: execution.retry_of_execution_id == null ? null : Number(execution.retry_of_execution_id),
          retryDepth: Number(execution.retry_depth),
          terminalStatus: execution.status,
          stepResultSha256: digest(execution.step_results ?? {}),
          errorSha256: execution.error_message ? digest(execution.error_message) : null,
        },
      },
      retentionClass: 'business-audit-governance',
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeEvidence(
  pool: pg.Pool,
  candidate: GoldenPathEvidenceCandidate,
  execution: ActiveExecution,
  reportId: string,
  gapCodes: string[],
): Promise<void> {
  const rejected = execution.status === 'cancelled' && execution.approval_status === 'rejected';
  const projectedStatus = rejected
    ? 'rejected'
    : execution.status === 'completed'
      ? (gapCodes.length > 0 ? 'completed_with_gaps' : 'completed')
      : 'failed';
  await pool.query(
    `UPDATE mcp_golden_path_runs
        SET audit_report_run_id=$2::uuid,
            evidence_status='complete', evidence_error=NULL, evidence_updated_at=now(),
            status=$3, completed_at=COALESCE($4::timestamptz, now())
      WHERE id=$1::uuid`,
    [candidate.id, reportId, projectedStatus, execution.completed_at],
  );
}

export async function generateGoldenPathEvidenceForRun(
  pool: pg.Pool,
  candidate: GoldenPathEvidenceCandidate,
  execution: ActiveExecution,
  options: GoldenPathEvidenceWorkerOptions,
): Promise<boolean> {
  if (!isTerminal(execution)) return false;
  const claim = await pool.query(
    `UPDATE mcp_golden_path_runs
        SET evidence_status='generating', evidence_error=NULL,
            evidence_attempt_count=evidence_attempt_count+1, evidence_updated_at=now()
      WHERE id=$1::uuid
        AND (
          evidence_status IN ('pending', 'failed')
          OR (evidence_status='generating' AND evidence_updated_at < now() - interval '10 minutes')
        )
      RETURNING id`,
    [candidate.id],
  );
  if ((claim.rowCount ?? 0) !== 1) return false;

  const now = options.now?.() ?? new Date();
  try {
    await appendTerminalEvent(pool, candidate, execution, now);
    let report = candidate.audit_report_run_id
      ? await getAuditReportRun(pool, candidate.audit_report_run_id, candidate.workspace_key, candidate.tenant_key)
      : null;
    if (report?.status === 'completed' && report.verificationState === 'valid') {
      await finalizeEvidence(pool, candidate, execution, report.id, report.gapCodes);
      return true;
    }
    if (!report || report.status === 'failed') {
      report = await createAuditReportRun(pool, {
        workspaceKey: candidate.workspace_key,
        tenantKey: candidate.tenant_key,
        environment: candidate.environment,
        reportType: 'run_evidence',
        name: `Golden Path ${candidate.id}`,
        triggerType: 'event',
        requestedBy: `golden-path:${candidate.created_by_user_id ?? 'service'}`,
        periodFrom: new Date(new Date(candidate.started_at).getTime() - 1_000),
        periodTo: new Date(now.getTime() + 1_000),
        filters: { resourceType: 'golden_path_run', resourceId: candidate.id },
      });
      await pool.query(
        `UPDATE mcp_golden_path_runs
            SET audit_report_run_id=$2::uuid, evidence_updated_at=now()
          WHERE id=$1::uuid`,
        [candidate.id, report.id],
      );
    }
    if (report.status === 'running') return false;
    const completed = await generateAuditReportRun(pool, report.id, {
      signer: options.signer,
      ...(options.now ? { now: options.now } : {}),
    });
    await finalizeEvidence(pool, candidate, execution, completed.id, completed.gapCodes);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE mcp_golden_path_runs
          SET evidence_status='failed', evidence_error=$2, evidence_updated_at=now()
        WHERE id=$1::uuid`,
      [candidate.id, message.slice(0, 4_000)],
    ).catch(() => undefined);
    throw error;
  }
}

export function startGoldenPathEvidenceWorker(
  pool: pg.Pool,
  options: GoldenPathEvidenceWorkerOptions,
): { stop(): void; tick(): Promise<void> } {
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      for (const candidate of await listCandidates(pool)) {
        try {
          const execution = await loadActiveExecution(pool, Number(candidate.workflow_execution_id));
          if (execution) await generateGoldenPathEvidenceForRun(pool, candidate, execution, options);
        } catch (error) {
          logger.error({ err: error, goldenPathRunId: candidate.id }, 'Golden Path evidence generation failed');
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), Math.max(2, options.intervalSec ?? 5) * 1_000);
  timer.unref();
  void tick();
  return {
    stop: () => { stopped = true; clearInterval(timer); },
    tick,
  };
}
