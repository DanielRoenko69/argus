import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary } from '../audit/canonicalAuditTypes.js';
import type { AuthorizedWorkspaceScope } from '../auth/workspaceScope.js';
import {
  PlatformExecutionCertificateError,
  projectPlatformExecutionCertificate,
  type PlatformExecutionCertificate,
  type PlatformExecutionProofSummary,
} from './executionCertificates.js';

type CertificateRow = {
  id: string;
  workspace_key: string;
  tenant_key: string;
  environment: string;
  profile_id: string;
  generated_at: string | Date;
  recorded_at: string | Date;
  recorded_by_username: string;
  passed: boolean;
  dev_passed: boolean;
  aiops_passed: boolean;
  evidence: unknown;
};

export interface ImportPlatformExecutionCertificateContext {
  scope: AuthorizedWorkspaceScope & { environment: string };
  actor: CanonicalAuditActor;
  userId: number;
  username: string;
  requestId?: string | null;
}

function selectColumns(): string {
  return `id, workspace_key, tenant_key, environment, profile_id, generated_at, recorded_at,
          recorded_by_username, passed, dev_passed, aiops_passed, evidence`;
}

export async function listPlatformExecutionCertificates(
  pool: pg.Pool,
  scope: AuthorizedWorkspaceScope & { environment: string },
  limit = 20,
): Promise<PlatformExecutionCertificate[]> {
  const result = await pool.query<CertificateRow>(
    `SELECT ${selectColumns()}
       FROM mcp_platform_execution_certificates
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND profile_id='pilot-demo'
      ORDER BY generated_at DESC, recorded_at DESC
      LIMIT $4`,
    [scope.workspaceKey, scope.tenantKey, scope.environment, Math.min(Math.max(limit, 1), 100)],
  );
  return result.rows.map(projectPlatformExecutionCertificate);
}

async function loadByDigest(
  queryable: Pick<pg.Pool, 'query'> | pg.PoolClient,
  scope: AuthorizedWorkspaceScope & { environment: string },
  payloadSha256: string,
): Promise<PlatformExecutionCertificate | null> {
  const result = await queryable.query<CertificateRow>(
    `SELECT ${selectColumns()}
       FROM mcp_platform_execution_certificates
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3
        AND profile_id='pilot-demo' AND payload_sha256=$4`,
    [scope.workspaceKey, scope.tenantKey, scope.environment, payloadSha256],
  );
  return result.rows[0] ? projectPlatformExecutionCertificate(result.rows[0]) : null;
}

export async function importPlatformExecutionCertificate(
  pool: pg.Pool,
  context: ImportPlatformExecutionCertificateContext,
  report: Record<string, unknown>,
  summary: PlatformExecutionProofSummary,
): Promise<{ certificate: PlatformExecutionCertificate; auditEvent: CanonicalAuditEventSummary; replayed: boolean }> {
  const producer = {
    name: 'argus.platform-readiness.execution-proof',
    eventId: summary.payloadSha256,
  };
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    producer,
    context.scope,
    async client => {
      const inserted = await client.query<CertificateRow>(
        `INSERT INTO mcp_platform_execution_certificates
           (workspace_key, tenant_key, environment, profile_id, source_schema, source_mode,
            generated_at, recorded_by_user_id, recorded_by_username, payload_sha256,
            passed, dev_passed, aiops_passed, dev_task_id, dev_root_trace_id,
            aiops_task_id, aiops_root_trace_id, evidence)
         VALUES ($1,$2,$3,'pilot-demo',$4,$5,$6,$7,$8,$9,true,true,true,$10,$11,$12,$13,$14::jsonb)
         RETURNING ${selectColumns()}`,
        [
          context.scope.workspaceKey,
          context.scope.tenantKey,
          context.scope.environment,
          summary.sourceSchema,
          summary.sourceMode,
          summary.generatedAt,
          context.userId,
          context.username,
          summary.payloadSha256,
          summary.dev.taskId,
          summary.dev.rootTraceId,
          summary.aiops.taskId,
          summary.aiops.rootTraceId,
          JSON.stringify(report),
        ],
      );
      return projectPlatformExecutionCertificate(inserted.rows[0]!);
    },
    certificate => ({
      occurredAt: new Date(),
      ...context.scope,
      solution: 'argus.core',
      actor: context.actor,
      action: 'platform_readiness.execution_proof_imported',
      outcome: 'success',
      risk: 'medium',
      resource: { type: 'platform_execution_certificate', id: certificate.id, revision: certificate.payloadSha256 },
      policy: { id: 'argus.platform-readiness.pilot-demo', version: '1', decision: 'accepted' },
      correlation: {
        rootRunId: certificate.dev.rootTraceId,
        traceId: certificate.aiops.rootTraceId,
        requestId: context.requestId ?? summary.payloadSha256,
      },
      payload: {
        after: {
          profileId: certificate.profileId,
          generatedAt: certificate.generatedAt,
          payloadSha256: certificate.payloadSha256,
          sourceMode: certificate.sourceMode,
          dev: { taskId: certificate.dev.taskId, passed: true },
          aiops: { taskId: certificate.aiops.taskId, passed: true },
        },
      },
      retentionClass: 'business-audit-ai-system',
    }),
  );

  const certificate = outcome.result ?? await loadByDigest(pool, context.scope, summary.payloadSha256);
  if (!certificate) {
    throw new PlatformExecutionCertificateError(
      'Imported execution proof could not be reloaded',
      500,
      'PLATFORM_EXECUTION_PROOF_RELOAD_FAILED',
    );
  }
  return { certificate, auditEvent: outcome.event, replayed: outcome.replayed };
}
