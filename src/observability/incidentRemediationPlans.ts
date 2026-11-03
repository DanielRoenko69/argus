export const KUBERNETES_SCALE_ADAPTER = 'kubernetes.scale.v1' as const;
export const KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_ADAPTER = 'kubernetes.deployment-revision-rollback.v1' as const;

export type IncidentRemediationChangePlanStatus =
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'verified'
  | 'failed'
  | 'rolled_back'
  | 'rollback_failed';

export interface IncidentRemediationChangePlanPreview {
  format: string;
  summary: string;
  lines: string[];
  rollbackSummary: string;
}

export type IncidentRemediationPostChangeMonitorStatus =
  | 'scheduled'
  | 'checking'
  | 'healthy'
  | 'regression_detected'
  | 'check_failed'
  | 'rollback_approved'
  | 'rollback_rejected'
  | 'rolling_back'
  | 'rolled_back'
  | 'rollback_failed';

export interface IncidentRemediationPostChangeMonitor {
  id: number;
  remediationId: number;
  planId: number;
  status: IncidentRemediationPostChangeMonitorStatus;
  version: number;
  rollbackHash: string;
  scheduledFor: string;
  observationTraceId: string | null;
  observedReplicas: number | null;
  observedState: Record<string, unknown> | null;
  observationResult: string | null;
  observationError: string | null;
  observedAt: string | null;
  decidedBy: number | null;
  decidedByUsername: string | null;
  decisionComment: string | null;
  decidedAt: string | null;
  rollbackTraceId: string | null;
  rollbackResult: string | null;
  rollbackError: string | null;
  rolledBackAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentRemediationChangePlan {
  id: number;
  remediationId: number;
  adapterKey: string;
  bundleId: number;
  writeBackendId: number;
  writeToolName: string;
  status: IncidentRemediationChangePlanStatus;
  version: number;
  planHash: string;
  targetScope: Record<string, unknown>;
  preview: IncidentRemediationChangePlanPreview;
  writeArguments: Record<string, unknown>;
  verifyArguments: Record<string, unknown>;
  rollbackArguments: Record<string, unknown>;
  adapterState: Record<string, unknown>;
  previousReplicas: number | null;
  desiredReplicas: number | null;
  createdBy: number | null;
  createdByUsername: string;
  approvedBy: number | null;
  approvedByUsername: string | null;
  approvalComment: string | null;
  approvedAt: string | null;
  executionTraceId: string | null;
  executionResult: string | null;
  executionError: string | null;
  executedAt: string | null;
  verificationTraceId: string | null;
  verificationResult: string | null;
  verificationError: string | null;
  verifiedAt: string | null;
  rollbackTraceId: string | null;
  rollbackResult: string | null;
  rollbackError: string | null;
  rolledBackAt: string | null;
  createdAt: string;
  updatedAt: string;
  postChangeMonitor: IncidentRemediationPostChangeMonitor | null;
}

export interface IncidentRemediationPostChangeMonitorRow {
  id: number | string;
  remediation_id: number | string;
  plan_id: number | string;
  status: IncidentRemediationPostChangeMonitorStatus;
  version: number | string;
  rollback_hash: string;
  scheduled_for: string | Date;
  observation_trace_id: string | null;
  observed_replicas: number | string | null;
  observed_state?: Record<string, unknown> | null;
  observation_result: string | null;
  observation_error: string | null;
  observed_at: string | Date | null;
  decided_by: number | string | null;
  decided_by_username: string | null;
  decision_comment: string | null;
  decided_at: string | Date | null;
  rollback_trace_id: string | null;
  rollback_result: string | null;
  rollback_error: string | null;
  rolled_back_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface IncidentRemediationChangePlanRow {
  id: number | string;
  remediation_id: number | string;
  adapter_key: string;
  bundle_id: number | string;
  write_backend_id: number | string;
  write_tool_name: string;
  status: IncidentRemediationChangePlanStatus;
  version: number | string;
  plan_hash: string;
  target_scope: Record<string, unknown>;
  preview: IncidentRemediationChangePlanPreview;
  write_arguments: Record<string, unknown>;
  verify_arguments: Record<string, unknown>;
  rollback_arguments: Record<string, unknown>;
  adapter_state?: Record<string, unknown> | null;
  previous_replicas: number | string | null;
  desired_replicas: number | string | null;
  created_by: number | string | null;
  created_by_username: string;
  approved_by: number | string | null;
  approved_by_username: string | null;
  approval_comment: string | null;
  approved_at: string | Date | null;
  execution_trace_id: string | null;
  execution_result: string | null;
  execution_error: string | null;
  executed_at: string | Date | null;
  verification_trace_id: string | null;
  verification_result: string | null;
  verification_error: string | null;
  verified_at: string | Date | null;
  rollback_trace_id: string | null;
  rollback_result: string | null;
  rollback_error: string | null;
  rolled_back_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function nullableIso(value: string | Date | null): string | null {
  return value == null ? null : iso(value);
}

function adapterState(row: IncidentRemediationChangePlanRow): Record<string, unknown> {
  if (row.adapter_state && typeof row.adapter_state === 'object' && !Array.isArray(row.adapter_state)) {
    return row.adapter_state;
  }
  if (row.adapter_key === KUBERNETES_SCALE_ADAPTER
    && row.previous_replicas != null && row.desired_replicas != null) {
    return {
      schemaVersion: 1,
      before: { replicas: Number(row.previous_replicas) },
      desired: { replicas: Number(row.desired_replicas) },
    };
  }
  return { schemaVersion: 0 };
}

export function incidentRemediationChangePlanFromRow(
  row: IncidentRemediationChangePlanRow,
  postChangeMonitor: IncidentRemediationPostChangeMonitor | null = null,
): IncidentRemediationChangePlan {
  return {
    id: Number(row.id),
    remediationId: Number(row.remediation_id),
    adapterKey: row.adapter_key,
    bundleId: Number(row.bundle_id),
    writeBackendId: Number(row.write_backend_id),
    writeToolName: row.write_tool_name,
    status: row.status,
    version: Number(row.version),
    planHash: row.plan_hash,
    targetScope: row.target_scope,
    preview: row.preview,
    writeArguments: row.write_arguments,
    verifyArguments: row.verify_arguments,
    rollbackArguments: row.rollback_arguments,
    adapterState: adapterState(row),
    previousReplicas: row.previous_replicas == null ? null : Number(row.previous_replicas),
    desiredReplicas: row.desired_replicas == null ? null : Number(row.desired_replicas),
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdByUsername: row.created_by_username,
    approvedBy: row.approved_by == null ? null : Number(row.approved_by),
    approvedByUsername: row.approved_by_username,
    approvalComment: row.approval_comment,
    approvedAt: nullableIso(row.approved_at),
    executionTraceId: row.execution_trace_id,
    executionResult: row.execution_result,
    executionError: row.execution_error,
    executedAt: nullableIso(row.executed_at),
    verificationTraceId: row.verification_trace_id,
    verificationResult: row.verification_result,
    verificationError: row.verification_error,
    verifiedAt: nullableIso(row.verified_at),
    rollbackTraceId: row.rollback_trace_id,
    rollbackResult: row.rollback_result,
    rollbackError: row.rollback_error,
    rolledBackAt: nullableIso(row.rolled_back_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    postChangeMonitor,
  };
}

export function incidentRemediationPostChangeMonitorFromRow(
  row: IncidentRemediationPostChangeMonitorRow,
): IncidentRemediationPostChangeMonitor {
  return {
    id: Number(row.id),
    remediationId: Number(row.remediation_id),
    planId: Number(row.plan_id),
    status: row.status,
    version: Number(row.version),
    rollbackHash: row.rollback_hash,
    scheduledFor: iso(row.scheduled_for),
    observationTraceId: row.observation_trace_id,
    observedReplicas: row.observed_replicas == null ? null : Number(row.observed_replicas),
    observedState: row.observed_state ?? (row.observed_replicas == null ? null : {
      schemaVersion: 1,
      observed: { replicas: Number(row.observed_replicas) },
    }),
    observationResult: row.observation_result,
    observationError: row.observation_error,
    observedAt: nullableIso(row.observed_at),
    decidedBy: row.decided_by == null ? null : Number(row.decided_by),
    decidedByUsername: row.decided_by_username,
    decisionComment: row.decision_comment,
    decidedAt: nullableIso(row.decided_at),
    rollbackTraceId: row.rollback_trace_id,
    rollbackResult: row.rollback_result,
    rollbackError: row.rollback_error,
    rolledBackAt: nullableIso(row.rolled_back_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
