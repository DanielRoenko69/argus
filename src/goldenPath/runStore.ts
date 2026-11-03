import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { canonicalAuditDigest, redactCanonicalAuditPayload } from '../audit/canonicalAuditRedaction.js';
import type { SessionUser } from '../auth/userAuth.js';
import { workflowTelemetryTraceId } from '../observability/telemetryStore.js';
import type { WorkflowStatus } from '../workflows/types.js';
import {
  GOLDEN_PATH_SCHEMA_VERSION,
  goldenPathPreflightSchema,
  goldenPathRunSchema,
  goldenPathRunStartReceiptSchema,
  type GoldenPathPreflight,
  type GoldenPathRun,
  type GoldenPathRunStartReceipt,
} from './contracts.js';

interface GoldenPathRunRow extends pg.QueryResultRow {
  id: string;
  workflow_id: number;
  workflow_execution_id: number | string | null;
  created_by_user_id: number | null;
  tenant_key: string;
  workspace_key: string;
  environment: string;
  mode: GoldenPathPreflight['mode'];
  write_mode: GoldenPathPreflight['policy']['writeMode'];
  status: string;
  idempotency_key_sha256: string;
  request_sha256: string;
  preflight: unknown;
  task_id: string;
  external_issue_id: string;
  runtime_task_id: string;
  error_code: string | null;
  error_message: string | null;
  started_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
  execution_status?: WorkflowStatus | null;
  execution_started_at?: string | Date | null;
  execution_updated_at?: string | Date | null;
  execution_completed_at?: string | Date | null;
  step_results?: Record<string, unknown> | null;
  waiting_approval_id?: number | string | null;
  waiting_step_id?: string | null;
  execution_error?: string | null;
  approval_status?: string | null;
  approval_id?: number | string | null;
  approval_requested_at?: string | Date | null;
  approval_decided_at?: string | Date | null;
  approval_decision_comment?: string | null;
  approval_decided_by_user_id?: number | null;
  approval_decided_by_username?: string | null;
  approval_tool_args_hash?: string | null;
  active_workflow_execution_id?: number | string | null;
  retry_of_execution_id?: number | string | null;
  retry_from_step_ids?: string[] | null;
  retry_chain?: unknown;
  audit_report_run_id?: string | null;
  evidence_status?: 'pending' | 'generating' | 'complete' | 'failed' | null;
  evidence_error?: string | null;
  report_status?: 'queued' | 'running' | 'completed' | 'failed' | null;
  report_pack_id?: string | null;
  report_pack_digest?: string | null;
  report_verification_state?: 'valid' | 'invalid' | null;
  report_gap_codes?: string[] | null;
}

export interface GoldenPathRunClaim {
  row: GoldenPathRunRow;
  created: boolean;
}

export class GoldenPathRunConflictError extends Error {
  readonly status = 409;
  readonly code = 'GOLDEN_PATH_IDEMPOTENCY_CONFLICT';
}

function digest(value: unknown): string {
  return canonicalAuditDigest(redactCanonicalAuditPayload(value));
}

function timestamp(value: string | Date | null | undefined, fallback?: string): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return new Date(value).toISOString();
  return fallback ?? null;
}

function repositoryOwnerAndName(repository: string): { repository_owner: string; repository_name: string } {
  const parts = repository.split('/').filter(Boolean);
  return {
    repository_owner: parts.slice(0, -1).join('/') || parts[0] || repository,
    repository_name: parts.at(-1) || repository,
  };
}

export function goldenPathWorkflowInputs(preflight: GoldenPathPreflight, runId: string): Record<string, unknown> {
  return {
    ...repositoryOwnerAndName(preflight.targets.git.repository),
    issue_number: preflight.targets.git.issueNumber,
    notification_channel: preflight.targets.notification.destination,
    write_mode: preflight.policy.writeMode,
    golden_path_run_id: runId,
  };
}

export function goldenPathTriggerEvidence(
  preflight: GoldenPathPreflight,
  runId: string,
  idempotencyKeySha256: string,
): {
  source: string;
  event_id: string;
  event_type: string;
  received_at: string;
  payload_sha256: string;
  event_id_source: string;
  path: string;
} {
  return {
    source: 'golden-path',
    event_id: `${preflight.scope.tenantKey}:${preflight.scope.workspaceKey}:${runId}`,
    event_type: `golden-path.${preflight.mode}.${preflight.policy.writeMode}`,
    received_at: new Date().toISOString(),
    payload_sha256: digest({ preflight, idempotencyKeySha256 }),
    event_id_source: 'core-generated-run-id',
    path: '/api/ui/golden-path/v1/runs',
  };
}

export async function claimGoldenPathRun(
  pool: pg.Pool,
  user: SessionUser,
  preflight: GoldenPathPreflight,
  rawIdempotencyKey: string,
): Promise<GoldenPathRunClaim> {
  const idempotencyKeySha256 = digest(rawIdempotencyKey);
  const requestSha256 = digest({
    mode: preflight.mode,
    writeMode: preflight.policy.writeMode,
    scope: preflight.scope,
    workflow: preflight.workflow,
    targets: preflight.targets,
  });
  const id = randomUUID();
  const taskId = `golden-task:${id}`;
  const externalIssueId = `${preflight.targets.git.provider}:${preflight.targets.git.repository}:${preflight.targets.git.issueNumber}`;
  const runtimeTaskId = `${preflight.runtime.selected}:${id}`;
  const inserted = await pool.query<GoldenPathRunRow>(
    `INSERT INTO mcp_golden_path_runs (
       id, workflow_id, created_by_user_id, tenant_key, workspace_key, environment,
       mode, write_mode, idempotency_key_sha256, request_sha256, preflight,
       task_id, external_issue_id, runtime_task_id
     ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
     ON CONFLICT (tenant_key, workspace_key, mode, idempotency_key_sha256) DO NOTHING
     RETURNING *`,
    [
      id,
      Number(preflight.workflow.id),
      user.id,
      preflight.scope.tenantKey,
      preflight.scope.workspaceKey,
      preflight.scope.environment,
      preflight.mode,
      preflight.policy.writeMode,
      idempotencyKeySha256,
      requestSha256,
      JSON.stringify(preflight),
      taskId,
      externalIssueId,
      runtimeTaskId,
    ],
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], created: true };

  const existing = await pool.query<GoldenPathRunRow>(
    `SELECT * FROM mcp_golden_path_runs
      WHERE tenant_key=$1 AND workspace_key=$2 AND mode=$3 AND idempotency_key_sha256=$4
      LIMIT 1`,
    [preflight.scope.tenantKey, preflight.scope.workspaceKey, preflight.mode, idempotencyKeySha256],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('idempotent Golden Path run could not be resolved');
  if (row.request_sha256 !== requestSha256) {
    throw new GoldenPathRunConflictError('The Idempotency-Key was already used for a different Golden Path request.');
  }
  return { row, created: false };
}

export async function attachGoldenPathExecution(
  pool: pg.Pool,
  runId: string,
  executionId: number,
): Promise<void> {
  await pool.query(
    `UPDATE mcp_golden_path_runs
        SET workflow_execution_id=$2, status='running', error_code=NULL, error_message=NULL
      WHERE id=$1::uuid AND workflow_execution_id IS NULL`,
    [runId, executionId],
  );
}

export async function failGoldenPathRun(
  pool: pg.Pool,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  await pool.query(
    `UPDATE mcp_golden_path_runs
        SET status='failed', completed_at=now(), error_code=$2, error_message=$3
      WHERE id=$1::uuid AND status IN ('starting', 'running')`,
    [runId, code.slice(0, 120), message.slice(0, 4_000)],
  );
}

export function goldenPathStartReceipt(row: GoldenPathRunRow, replayed: boolean): GoldenPathRunStartReceipt {
  const executionId = row.workflow_execution_id == null ? null : Number(row.workflow_execution_id);
  return goldenPathRunStartReceiptSchema.parse({
    schemaVersion: GOLDEN_PATH_SCHEMA_VERSION,
    kind: 'argus.golden-path-run-started',
    runId: row.id,
    workflowExecutionId: Number.isSafeInteger(executionId) && executionId! > 0 ? executionId : null,
    traceId: Number.isSafeInteger(executionId) && executionId! > 0 ? workflowTelemetryTraceId(executionId!) : null,
    status: row.status === 'failed' ? 'failed' : row.status === 'starting' ? 'starting' : 'running',
    replayed,
    href: `/api/ui/golden-path/v1/runs/${encodeURIComponent(row.id)}`,
  });
}

async function loadGoldenPathRunRow(
  pool: pg.Pool,
  runId: string,
  scope: GoldenPathPreflight['scope'],
): Promise<GoldenPathRunRow | null> {
  const result = await pool.query<GoldenPathRunRow>(
    `SELECT golden.*,
            execution.id AS active_workflow_execution_id,
            execution.status AS execution_status,
            execution.started_at AS execution_started_at,
            GREATEST(execution.started_at, execution.completed_at, execution.resumed_at) AS execution_updated_at,
            execution.completed_at AS execution_completed_at,
            execution.step_results,
            execution.waiting_approval_id,
            execution.waiting_step_id,
            execution.error_message AS execution_error,
            execution.retry_of_execution_id,
            execution.retry_from_step_ids,
            execution.retry_chain,
            approval.id AS approval_id,
            approval.status AS approval_status,
            approval.requested_at AS approval_requested_at,
            approval.decided_at AS approval_decided_at,
            approval.decision_comment AS approval_decision_comment,
            approval.decided_by_user_id AS approval_decided_by_user_id,
            approval.decided_by_username AS approval_decided_by_username,
            approval.tool_args_hash AS approval_tool_args_hash,
            report.status AS report_status,
            report.pack_id AS report_pack_id,
            report.pack_digest AS report_pack_digest,
            report.verification_state AS report_verification_state,
            report.gap_codes AS report_gap_codes
       FROM mcp_golden_path_runs golden
       LEFT JOIN LATERAL (
         WITH RECURSIVE executions AS (
           SELECT root.*, 0 AS retry_depth
             FROM mcp_workflow_executions root
            WHERE root.id=golden.workflow_execution_id
           UNION ALL
           SELECT child.*, parent.retry_depth + 1
             FROM mcp_workflow_executions child
             JOIN executions parent ON child.retry_of_execution_id=parent.id
         )
         SELECT latest.*,
                (
                  SELECT jsonb_agg(jsonb_build_object(
                    'id', item.id,
                    'status', item.status,
                    'stepResults', item.step_results,
                    'retryFromStepIds', item.retry_from_step_ids
                  ) ORDER BY item.retry_depth, item.id)
                    FROM executions item
                ) AS retry_chain
           FROM executions latest
          ORDER BY latest.retry_depth DESC, latest.id DESC
          LIMIT 1
       ) execution ON true
       LEFT JOIN LATERAL (
         WITH RECURSIVE lineage AS (
           SELECT active.id, active.retry_of_execution_id
             FROM mcp_workflow_executions active
            WHERE active.id=execution.id
           UNION ALL
           SELECT parent.id, parent.retry_of_execution_id
             FROM mcp_workflow_executions parent
             JOIN lineage child ON child.retry_of_execution_id=parent.id
         )
         SELECT runtime.*
           FROM mcp_runtime_approvals runtime
           JOIN lineage ON lineage.id=runtime.workflow_execution_id
          ORDER BY runtime.requested_at DESC, runtime.id DESC
          LIMIT 1
       ) approval ON true
       LEFT JOIN mcp_audit_report_runs report ON report.id=golden.audit_report_run_id
      WHERE golden.id=$1::uuid
        AND golden.tenant_key=$2 AND golden.workspace_key=$3 AND golden.environment=$4
      LIMIT 1`,
    [runId, scope.tenantKey, scope.workspaceKey, scope.environment],
  );
  return result.rows[0] ?? null;
}

interface ProjectedStepState {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  result: unknown;
  evidence: unknown;
}

function stepState(id: string, value: unknown): ProjectedStepState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    id,
    status: String(record['status'] ?? ''),
    startedAt: timestamp(record['started_at'] as string | undefined),
    completedAt: timestamp(record['completed_at'] as string | undefined),
    error: typeof record['error'] === 'string' ? record['error'] : null,
    result: record['result'],
    evidence: record['evidence'],
  };
}

function matchingStep(results: Record<string, unknown>, fragments: string[]): ReturnType<typeof stepState> {
  const entry = Object.entries(results).find(([id]) => fragments.some(fragment => id.toLowerCase().includes(fragment)));
  return entry ? stepState(entry[0], entry[1]) : null;
}

function retryExecutions(row: GoldenPathRunRow, results: Record<string, unknown>): Array<{
  stepResults: Record<string, unknown>;
  retryFromStepIds: string[] | null;
}> {
  if (Array.isArray(row.retry_chain)) {
    return row.retry_chain.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const rawResults = record['stepResults'];
      return [{
        stepResults: rawResults && typeof rawResults === 'object' && !Array.isArray(rawResults)
          ? rawResults as Record<string, unknown>
          : {},
        retryFromStepIds: Array.isArray(record['retryFromStepIds'])
          ? record['retryFromStepIds'].map(String)
          : null,
      }];
    });
  }
  return [{ stepResults: results, retryFromStepIds: row.retry_from_step_ids ?? null }];
}

function stepAttemptCount(
  chain: ReturnType<typeof retryExecutions>,
  fragments: string[],
): number {
  let attempts = 0;
  chain.forEach((execution, index) => {
    const match = matchingStep(execution.stepResults, fragments);
    if (!match || !['completed', 'failed', 'running', 'waiting'].includes(match.status)) return;
    if (index === 0 || execution.retryFromStepIds == null || execution.retryFromStepIds.includes(match.id)) {
      attempts += 1;
    }
  });
  return attempts;
}

function projectedState(step: ReturnType<typeof stepState>): GoldenPathRun['stages'][number]['state'] {
  if (!step) return 'pending';
  if (step.status === 'completed') return 'succeeded';
  if (step.status === 'failed') return 'failed';
  if (step.status === 'skipped') return 'skipped';
  if (step.status === 'waiting') return 'action_required';
  return 'running';
}

function stage(
  id: GoldenPathRun['stages'][number]['id'],
  label: string,
  state: GoldenPathRun['stages'][number]['state'],
  detail: string,
  refs: string[],
  startedAt: string | null,
  completedAt: string | null,
): GoldenPathRun['stages'][number] {
  return { id, label, state, detail, resourceRefIds: refs, startedAt, completedAt };
}

export async function loadGoldenPathRun(
  pool: pg.Pool,
  runId: string,
  scope: GoldenPathPreflight['scope'],
): Promise<GoldenPathRun | null> {
  const row = await loadGoldenPathRunRow(pool, runId, scope);
  if (!row) return null;
  const preflight = goldenPathPreflightSchema.parse(row.preflight);
  const startedAt = timestamp(row.execution_started_at, timestamp(row.started_at)!)!;
  const updatedAt = timestamp(row.execution_updated_at, timestamp(row.updated_at)!)!;
  const persistedCompletedAt = timestamp(row.completed_at) ?? undefined;
  const terminalAt = timestamp(row.execution_completed_at, persistedCompletedAt);
  const results = row.step_results ?? {};
  const chain = retryExecutions(row, results);
  const issueStep = matchingStep(results, ['read_issue', 'issue_ingest', 'ingest']);
  const contextStep = matchingStep(results, ['snapshot', 'repository_context', 'knowledge', 'graph']);
  const analysisStep = matchingStep(results, ['triage', 'analysis', 'analy', 'plan']);
  const commentStep = matchingStep(results, ['comment_issue', 'issue_comment', 'comment']);
  const labelStep = matchingStep(results, ['add_label', 'issue_label', 'label']);
  const notificationStep = matchingStep(results, ['notify', 'post_message', 'slack']);
  const externalSteps = [commentStep, labelStep, notificationStep];
  const executionStatus = row.execution_status ?? (row.status === 'failed' ? 'failed' : 'running');
  const rawApprovalId = row.waiting_approval_id ?? row.approval_id;
  const approvalId = rawApprovalId == null ? null : String(rawApprovalId);
  const approvalStatus = row.approval_status;
  const approvalRequestedAt = timestamp(row.approval_requested_at);
  const approvalDecidedAt = timestamp(row.approval_decided_at);
  const rejected = executionStatus === 'cancelled' && approvalStatus === 'rejected';
  const completed = executionStatus === 'completed';
  const waiting = executionStatus === 'waiting_for_approval';
  const failed = executionStatus === 'failed' || (executionStatus === 'cancelled' && !rejected) || row.status === 'failed';
  const signedEvidenceComplete = row.report_status === 'completed'
    && row.report_verification_state === 'valid'
    && Boolean(row.report_pack_id)
    && Boolean(row.report_pack_digest);
  const signedEvidenceHasGaps = (row.report_gap_codes?.length ?? 0) > 0;
  const status: GoldenPathRun['status'] = rejected
    ? 'rejected'
    : completed ? (signedEvidenceComplete && !signedEvidenceHasGaps ? 'completed' : 'completed_with_gaps')
      : waiting ? 'waiting_for_approval'
        : failed ? 'failed' : 'running';
  const activeExecutionId = row.active_workflow_execution_id ?? row.workflow_execution_id;
  const traceId = activeExecutionId == null
    ? `golden:${row.id}`
    : workflowTelemetryTraceId(Number(activeExecutionId));
  const issueHref = `${preflight.targets.git.baseUrlOrigin}/${preflight.targets.git.repository}/issues/${preflight.targets.git.issueNumber}`;
  const refs: GoldenPathRun['resourceRefs'] = [
    { refId: 'task', type: 'task', id: row.task_id, label: 'Golden Path task' },
    { refId: 'issue', type: 'issue', id: row.external_issue_id, label: `${preflight.targets.git.provider} issue #${preflight.targets.git.issueNumber}`, href: issueHref },
    { refId: 'workflow', type: 'workflow', id: preflight.workflow.id, label: `Workflow ${preflight.workflow.id} revision ${preflight.workflow.revision}`, href: `/build/workflows/studio/${encodeURIComponent(preflight.workflow.id)}`, sha256: preflight.workflow.sha256 },
    { refId: 'runtime-task', type: 'runtime_task', id: row.runtime_task_id, label: `${preflight.runtime.selected} runtime binding`, href: '/solutions/argus.dev' },
    { refId: 'trace', type: 'trace', id: traceId, label: 'Workflow trace', href: `/observe/logs?traceId=${encodeURIComponent(traceId)}` },
  ];
  if (approvalId) refs.push({
    refId: 'approval',
    type: 'approval',
    id: approvalId,
    label: 'External write approval',
    href: `/runs/approvals/${encodeURIComponent(approvalId)}`,
    ...(row.approval_tool_args_hash ? { sha256: row.approval_tool_args_hash } : {}),
  });
  if (row.audit_report_run_id) refs.push({
    refId: 'audit-report',
    type: 'audit_report',
    id: row.audit_report_run_id,
    label: 'Signed Golden Path run report',
    href: `/observe/audit?tab=reports&reportId=${encodeURIComponent(row.audit_report_run_id)}`,
    ...(row.report_pack_digest ? { sha256: row.report_pack_digest } : {}),
  });
  if (row.report_pack_id) refs.push({
    refId: 'evidence-pack',
    type: 'evidence_pack',
    id: row.report_pack_id,
    label: 'Offline-verifiable evidence pack',
    href: `/api/ui/audit/report-runs/v1/${encodeURIComponent(row.audit_report_run_id!)}/artifacts/json/content`,
    ...(row.report_pack_digest ? { sha256: row.report_pack_digest } : {}),
  });

  const approval: GoldenPathRun['approval'] = preflight.policy.writeMode === 'read_only'
    ? { id: null, state: 'not_required', planSha256: null, payloadSha256: null, targetSummary: 'Read-only analysis has no external write target.', requestedAt: null, decidedAt: null, decidedBy: null, rationale: null, allowedActions: [] }
    : approvalStatus === 'rejected'
      ? { id: approvalId, state: 'rejected', planSha256: preflight.policy.policySha256, payloadSha256: row.approval_tool_args_hash ?? null, targetSummary: `Write only to ${preflight.targets.git.repository}#${preflight.targets.git.issueNumber} and ${preflight.targets.notification.destination}.`, requestedAt: approvalRequestedAt, decidedAt: approvalDecidedAt, decidedBy: { actorType: 'user', actorId: String(row.approval_decided_by_user_id ?? row.approval_decided_by_username ?? 'unknown'), displayName: row.approval_decided_by_username ?? 'Authorized reviewer' }, rationale: row.approval_decision_comment ?? null, allowedActions: [] }
      : approvalStatus === 'approved' || approvalStatus === 'consumed'
        ? { id: approvalId, state: 'approved', planSha256: preflight.policy.policySha256, payloadSha256: row.approval_tool_args_hash ?? null, targetSummary: `Write only to ${preflight.targets.git.repository}#${preflight.targets.git.issueNumber} and ${preflight.targets.notification.destination}.`, requestedAt: approvalRequestedAt, decidedAt: approvalDecidedAt, decidedBy: { actorType: 'user', actorId: String(row.approval_decided_by_user_id ?? row.approval_decided_by_username ?? 'unknown'), displayName: row.approval_decided_by_username ?? 'Authorized reviewer' }, rationale: row.approval_decision_comment ?? null, allowedActions: [] }
        : approvalId && approvalRequestedAt
          ? { id: approvalId, state: 'pending', planSha256: preflight.policy.policySha256, payloadSha256: row.approval_tool_args_hash ?? null, targetSummary: `Write only to ${preflight.targets.git.repository}#${preflight.targets.git.issueNumber} and ${preflight.targets.notification.destination}.`, requestedAt: approvalRequestedAt, decidedAt: null, decidedBy: null, rationale: null, allowedActions: ['approve', 'reject'] }
          : { id: null, state: 'not_requested', planSha256: null, payloadSha256: null, targetSummary: 'The bounded write approval has not been requested yet.', requestedAt: null, decidedAt: null, decidedBy: null, rationale: null, allowedActions: [] };

  const approvalStageState: GoldenPathRun['stages'][number]['state'] = preflight.policy.writeMode === 'read_only'
    ? 'skipped'
    : approval.state === 'pending' ? 'action_required'
      : approval.state === 'approved' ? 'succeeded'
        : approval.state === 'rejected' ? 'failed' : 'pending';
  const evidenceTerminal = completed || rejected || failed;
  const externalState: GoldenPathRun['stages'][number]['state'] = preflight.policy.writeMode === 'read_only' || rejected
    ? 'skipped'
    : externalSteps.some(item => item?.status === 'failed') ? 'failed'
      : externalSteps.every(item => item?.status === 'completed') ? 'succeeded'
        : externalSteps.some(item => item && !['completed', 'skipped'].includes(item.status)) ? 'running'
          : 'pending';
  const externalStartedAt = externalSteps.flatMap(item => item?.startedAt ? [item.startedAt] : []).sort()[0] ?? null;
  const externalCompletedValues = externalSteps.flatMap(item => item?.completedAt ? [item.completedAt] : []).sort();
  const externalCompletedAt = externalState === 'succeeded'
    ? externalCompletedValues.at(-1) ?? updatedAt
    : null;
  const evidenceRefs = signedEvidenceComplete ? ['trace', 'audit-report', 'evidence-pack'] : ['trace'];
  const stages: GoldenPathRun['stages'] = [
    stage('preflight', 'Preflight', 'succeeded', 'The frozen server-side preflight authorized this run.', ['task', 'workflow'], timestamp(row.started_at)!, timestamp(row.started_at)!),
    stage('issue_ingestion', 'Issue ingestion', projectedState(issueStep), issueStep?.error ?? 'Reading and normalizing the configured issue.', ['issue'], issueStep?.startedAt ?? null, issueStep?.completedAt ?? null),
    stage('repository_context', 'Repository context', projectedState(contextStep), contextStep ? (contextStep.error ?? 'Repository context step recorded.') : 'No dedicated repository snapshot evidence is attached yet.', [], contextStep?.startedAt ?? null, contextStep?.completedAt ?? null),
    stage('dev_analysis', 'Dev analysis', projectedState(analysisStep), analysisStep?.error ?? `Analysis runs through the selected ${preflight.runtime.selected} binding.`, ['runtime-task', 'trace'], analysisStep?.startedAt ?? null, analysisStep?.completedAt ?? null),
    stage('policy_decision', 'Policy decision', waiting || completed || rejected || failed ? 'succeeded' : 'running', preflight.policy.writeMode === 'guarded' ? 'External writes remain bound to the governed approval policy.' : 'The run is restricted to read-only behavior.', approvalId ? ['approval'] : ['workflow'], startedAt, waiting || completed || rejected || failed ? (approvalRequestedAt ?? updatedAt) : null),
    stage('approval', 'Human approval', approvalStageState, approval.state === 'not_required' ? 'No approval is required for a read-only run.' : approval.state === 'not_requested' ? 'Approval will be created only when the workflow reaches the write boundary.' : `Approval is ${approval.state}.`, approvalId ? ['approval'] : [], approvalRequestedAt, approvalDecidedAt),
    stage(
      'external_action',
      'External action',
      externalState,
      rejected
        ? 'The reviewer rejected the bound plan; no external write was executed.'
        : externalSteps.find(item => item?.error)?.error
          ?? (preflight.policy.writeMode === 'read_only' ? 'No external writes are permitted.' : 'Bounded Git and Slack outcomes are tracked independently.'),
      externalSteps.some(Boolean) ? ['issue'] : [],
      externalStartedAt,
      externalCompletedAt,
    ),
    stage(
      'evidence',
      'Evidence',
      signedEvidenceComplete ? 'succeeded' : 'pending',
      signedEvidenceComplete
        ? 'The signed audit report and offline-verifiable Evidence Pack are attached.'
        : evidenceTerminal
          ? row.evidence_error ?? 'Signed run-evidence generation is pending.'
          : 'Final evidence awaits a terminal run state.',
      evidenceRefs,
      evidenceTerminal ? (terminalAt ?? updatedAt) : null,
      signedEvidenceComplete ? (terminalAt ?? updatedAt) : null,
    ),
  ];
  const outcomeSpecs = [
    { target: 'git' as const, operation: 'comment' as const, step: commentStep, fragments: ['comment_issue', 'issue_comment', 'comment'] },
    { target: 'git' as const, operation: 'add_label' as const, step: labelStep, fragments: ['add_label', 'issue_label', 'label'] },
    { target: 'slack' as const, operation: 'post_message' as const, step: notificationStep, fragments: ['notify', 'post_message', 'slack'] },
  ];
  const outcomes: GoldenPathRun['outcomes'] = preflight.policy.writeMode === 'read_only' ? [] : outcomeSpecs.map(spec => {
    const attempts = rejected ? 0 : stepAttemptCount(chain, spec.fragments);
    const succeeded = spec.step?.status === 'completed';
    const outcomeState: GoldenPathRun['outcomes'][number]['state'] = rejected
      ? 'skipped'
      : succeeded ? 'succeeded'
        : spec.step?.status === 'failed' ? 'failed' : 'pending';
    const receipt = succeeded ? digest({ stepId: spec.step!.id, result: spec.step!.result, evidence: spec.step!.evidence }) : null;
    return {
      target: spec.target,
      operation: spec.operation,
      state: outcomeState,
      attemptCount: outcomeState === 'pending' ? 0 : attempts,
      idempotencyKeySha256: digest({ runId: row.id, target: spec.target, operation: spec.operation }),
      providerReceiptSha256: receipt,
      verifiedAt: succeeded ? (spec.step?.completedAt ?? updatedAt) : null,
      retryable: outcomeState === 'failed',
      detail: rejected
        ? 'Not executed because the reviewer rejected the exact bound plan.'
        : succeeded
          ? 'The bounded provider operation completed; its redacted result and runtime evidence are sealed by digest.'
          : spec.step?.status === 'failed'
            ? (spec.step.error ?? 'External write failed and can be retried from its safe checkpoint.')
            : 'Provider operation is pending.',
    };
  });
  const evidenceGaps = signedEvidenceComplete
    ? (row.report_gap_codes ?? []).map(code => `Audit evidence declared gap: ${code}`)
    : [row.evidence_error ?? (row.report_status === 'failed'
      ? 'Signed run-evidence generation failed and is queued for retry.'
      : 'Signed Audit Report and Evidence Pack generation is pending.')];
  const evidence: GoldenPathRun['evidence'] = evidenceTerminal
    ? signedEvidenceComplete && evidenceGaps.length === 0
      ? { state: 'complete', offlineVerifiable: true, gaps: [], resourceRefIds: evidenceRefs }
      : { state: 'complete_with_gaps', offlineVerifiable: signedEvidenceComplete, gaps: evidenceGaps, resourceRefIds: evidenceRefs }
    : { state: 'pending', offlineVerifiable: false, gaps: [], resourceRefIds: ['trace'] };
  const allowedActions: GoldenPathRun['allowedActions'] = approval.state === 'pending'
    ? ['approve', 'reject', 'cancel', 'open_trace']
    : status === 'running' ? ['cancel', 'open_trace']
      : status === 'failed' ? ['retry', 'open_trace', ...(signedEvidenceComplete ? ['open_report', 'download_evidence'] as const : [])]
        : ['open_trace', ...(signedEvidenceComplete ? ['open_report', 'download_evidence'] as const : [])];

  return goldenPathRunSchema.parse({
    schemaVersion: GOLDEN_PATH_SCHEMA_VERSION,
    kind: 'argus.golden-path-run',
    mode: preflight.mode,
    status,
    title: `Triage ${preflight.targets.git.provider} issue #${preflight.targets.git.issueNumber}`,
    startedAt,
    updatedAt,
    completedAt: status === 'running' || status === 'waiting_for_approval' ? null : (terminalAt ?? updatedAt),
    scope: preflight.scope,
    workflow: preflight.workflow,
    runtime: preflight.runtime,
    policy: preflight.policy,
    correlation: { taskId: row.task_id, externalIssueId: row.external_issue_id, runId: String(activeExecutionId ?? row.id), traceId, runtimeTaskId: row.runtime_task_id },
    stages,
    approval,
    outcomes,
    evidence,
    resourceRefs: refs,
    allowedActions,
  });
}

/**
 * A retry creates a new immutable execution and keeps the prior run/report as evidence.
 * Reset only the Golden Path projection so the new terminal attempt receives a fresh report.
 */
export async function markGoldenPathRetryStarted(pool: pg.Pool, sourceExecutionId: number): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `WITH RECURSIVE lineage AS (
       SELECT current.id, current.retry_of_execution_id
         FROM mcp_workflow_executions current
        WHERE current.id=$1
       UNION ALL
       SELECT parent.id, parent.retry_of_execution_id
         FROM mcp_workflow_executions parent
         JOIN lineage child ON child.retry_of_execution_id=parent.id
     )
     UPDATE mcp_golden_path_runs golden
        SET status='running', completed_at=NULL, audit_report_run_id=NULL,
            evidence_status='pending', evidence_error=NULL, evidence_updated_at=now()
      WHERE golden.workflow_execution_id IN (SELECT id FROM lineage)
      RETURNING golden.id`,
    [sourceExecutionId],
  );
  return result.rows[0]?.id ?? null;
}

export async function reloadGoldenPathRunRow(pool: pg.Pool, runId: string): Promise<GoldenPathRunRow> {
  const result = await pool.query<GoldenPathRunRow>('SELECT * FROM mcp_golden_path_runs WHERE id=$1::uuid', [runId]);
  const row = result.rows[0];
  if (!row) throw new Error(`Golden Path run '${runId}' disappeared after creation`);
  return row;
}
