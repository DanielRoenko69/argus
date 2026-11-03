import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../config/env.js';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import { redact } from '../lib/redaction.js';
import { isArgusObservabilityTool } from './observabilityTools.js';
import type { ToolParameter } from '../tools/dynamic/index.js';
import { executeTool, type ToolResult } from '../tools/toolRunner.js';
import {
  IncidentRemediationError,
  type IncidentRemediationRecord,
  type IncidentRemediationStore,
} from './incidentRemediations.js';
import {
  incidentRemediationChangePlanFromRow,
  incidentRemediationPostChangeMonitorFromRow,
  KUBERNETES_SCALE_ADAPTER,
  type IncidentRemediationChangePlan,
  type IncidentRemediationChangePlanRow,
  type IncidentRemediationPostChangeMonitor,
  type IncidentRemediationPostChangeMonitorRow,
} from './incidentRemediationPlans.js';
import { getLatestKubernetesCertification } from '../solutionPacks/kubernetesCertificationStore.js';
import {
  incidentRemediationAdapter,
  listIncidentRemediationAdapters,
  normalizeIncidentRemediationExecutionIntent,
  type IncidentRemediationAdapterControls,
  type IncidentRemediationExecutionIntent,
  type KubernetesRemediationTarget,
} from './incidentRemediationAdapters.js';
import {
  noOpIncidentRemediationAudit,
  unconfiguredIncidentRemediationAudit,
  type IncidentRemediationAuditEvent,
  type IncidentRemediationAuditWriter,
  type IncidentRemediationOperator,
} from './incidentRemediationAudit.js';

export type IncidentRemediationDryRunStatus = 'running' | 'passed' | 'failed';

export interface IncidentRemediationDryRun {
  id: number;
  remediationId: number;
  bundleId: number;
  toolName: string;
  arguments: Record<string, string | number | boolean>;
  status: IncidentRemediationDryRunStatus;
  executionTraceId: string;
  resultPreview: string | null;
  errorMessage: string | null;
  redactionSummary: Record<string, number>;
  startedBy: number | null;
  startedByUsername: string;
  startedAt: string;
  completedAt: string | null;
}

export interface IncidentRemediationExecutorParameter extends ToolParameter {
  suggestedValue?: string | number | boolean;
  valueSource: 'incident' | 'default' | null;
  locked: boolean;
}

export interface IncidentRemediationExecutorCandidate {
  bundleId: number;
  bundleName: string;
  bundleLabel: string;
  toolName: string;
  description: string;
  backend: string;
  category: string | null;
  executorKind: 'native_read' | 'dynamic_get';
  parameters: IncidentRemediationExecutorParameter[];
  suggestedArguments: Record<string, string | number | boolean>;
  missingRequiredArguments: string[];
}

export interface IncidentRemediationWriteAdapterCandidate {
  adapterKey: IncidentRemediationExecutionIntent['adapterKey'];
  label: string;
  description: string;
  controls: IncidentRemediationAdapterControls;
  status: 'ready' | 'unavailable';
  reason: string | null;
  bundleId: number | null;
  bundleLabel: string | null;
  writeBackendId: number | null;
  writeBackendName: string | null;
  writeToolName: string | null;
  target: {
    backendId: number;
    targetId: string;
    cluster: string;
    namespace: string;
    environment: string;
  } | null;
  workloadKinds: Array<'Deployment' | 'StatefulSet'>;
  replicas: { minimum: 1; maximum: 50 } | null;
  intent: IncidentRemediationExecutionIntent | null;
}

export interface IncidentRemediationReconciliationSummary {
  examined: number;
  recovered: number;
  failedClosed: number;
  deferred: number;
}

export interface IncidentRemediationReconciliationSummary {
  examined: number;
  recovered: number;
  failedClosed: number;
  deferred: number;
}

export interface IncidentRemediationChangePlanRequest {
  adapterKey: IncidentRemediationExecutionIntent['adapterKey'];
  incidentId: number;
  remediationId: number;
  expectedRemediationVersion: number;
  bundleId: number;
  writeToolName: string;
  workloadKind: 'Deployment' | 'StatefulSet';
  workloadName: string;
  desiredReplicas?: number;
  targetRevision?: number;
  operator: IncidentRemediationOperator & { id: number };
}

export interface IncidentRemediationExecutor {
  listCandidates(incidentId: number, remediationId: number): Promise<IncidentRemediationExecutorCandidate[]>;
  runDryRun(input: {
    incidentId: number;
    remediationId: number;
    expectedVersion: number;
    bundleId: number;
    toolName: string;
    arguments: Record<string, unknown>;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; dryRun: IncidentRemediationDryRun }>;
  listWriteAdapters(incidentId: number, remediationId: number): Promise<IncidentRemediationWriteAdapterCandidate[]>;
  createChangePlan(input: IncidentRemediationChangePlanRequest): Promise<{
    remediation: IncidentRemediationRecord;
    plan: IncidentRemediationChangePlan;
  }>;
  decideChangePlan(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    expectedPlanVersion: number;
    planHash: string;
    decision: 'approve' | 'reject';
    comment: string | null;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }>;
  executeChangePlan(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    expectedPlanVersion: number;
    planHash: string;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }>;
  monitorPostChange(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    monitorId: number;
    expectedMonitorVersion: number;
    rollbackHash: string;
    operator: IncidentRemediationOperator;
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }>;
  monitorDuePostChanges(limit?: number): Promise<number>;
  reconcileInterruptedOperations(limit?: number): Promise<IncidentRemediationReconciliationSummary>;
  decidePostChangeRollback(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    monitorId: number;
    expectedMonitorVersion: number;
    rollbackHash: string;
    decision: 'approve' | 'reject';
    comment: string | null;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }>;
  executePostChangeRollback(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    monitorId: number;
    expectedMonitorVersion: number;
    rollbackHash: string;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }>;
}

type RemediationContextRow = {
  status: string;
  version: number;
  root_trace_id: string | null;
  target_scope: Record<string, unknown> | null;
  execution_intent: Record<string, unknown> | null;
  aiops_bundle_ids: Array<number | string> | null;
  aiops_service: string | null;
  aiops_environment: string | null;
  triggered_at: string | Date;
};

type RemoteScaleToolRow = {
  bundle_id: number | string;
  bundle_label: string;
  backend_id: number | string;
  backend_name: string;
  backend_config: Record<string, unknown> | null;
  prefixed_name: string;
  tool_name: string;
  description: string;
  input_schema: Record<string, unknown> | null;
};

type ToolRow = {
  name: string;
  description: string;
  backend: string;
  category: string | null;
  tool_type: 'builtin' | 'dynamic';
  query_template: string | null;
  parameters: ToolParameter[] | string | null;
  is_write: boolean;
};

type DryRunRow = {
  id: number | string;
  remediation_id: number | string;
  bundle_id: number | string;
  tool_name: string;
  arguments: Record<string, string | number | boolean> | null;
  status: IncidentRemediationDryRunStatus;
  execution_trace_id: string;
  result_preview: string | null;
  error_message: string | null;
  redaction_summary: Record<string, number> | null;
  started_by: number | string | null;
  started_by_username: string;
  started_at: string | Date;
  completed_at: string | Date | null;
};

type InterruptedPlanRow = IncidentRemediationChangePlanRow & {
  incident_id: number | string;
  root_trace_id: string | null;
};

type InterruptedMonitorRow = IncidentRemediationPostChangeMonitorRow & {
  incident_id: number | string;
  root_trace_id: string | null;
  plan: IncidentRemediationChangePlanRow;
};

type ExecuteToolFn = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: { config: Config; pool: pg.Pool; allowedBundles?: number[] | null },
) => Promise<ToolResult>;

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapDryRun(row: DryRunRow): IncidentRemediationDryRun {
  return {
    id: Number(row.id),
    remediationId: Number(row.remediation_id),
    bundleId: Number(row.bundle_id),
    toolName: row.tool_name,
    arguments: row.arguments ?? {},
    status: row.status,
    executionTraceId: row.execution_trace_id,
    resultPreview: row.result_preview,
    errorMessage: row.error_message,
    redactionSummary: row.redaction_summary ?? {},
    startedBy: row.started_by == null ? null : Number(row.started_by),
    startedByUsername: row.started_by_username,
    startedAt: iso(row.started_at),
    completedAt: row.completed_at == null ? null : iso(row.completed_at),
  };
}

function parameters(value: ToolRow['parameters']): ToolParameter[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as ToolParameter[] : [];
  } catch {
    return [];
  }
}

function safeReadKind(tool: ToolRow): IncidentRemediationExecutorCandidate['executorKind'] | null {
  if (tool.is_write) return null;
  if (tool.tool_type === 'builtin') return isArgusObservabilityTool(tool.name) ? 'native_read' : null;
  return /^\s*(GET|HEAD)\s+/i.test(tool.query_template ?? '') ? 'dynamic_get' : null;
}

function scalarDefault(param: ToolParameter): string | number | boolean | undefined {
  if (param.default === undefined) return undefined;
  if (param.type === 'number') {
    const value = Number(param.default);
    return Number.isFinite(value) ? value : undefined;
  }
  if (param.type === 'boolean') {
    if (param.default === 'true') return true;
    if (param.default === 'false') return false;
    return undefined;
  }
  return String(param.default).slice(0, 2_000);
}

function contextSuggestion(
  name: string,
  paramType: ToolParameter['type'],
  context: RemediationContextRow,
): string | number | boolean | undefined {
  const triggered = new Date(context.triggered_at);
  const start = new Date(triggered.getTime() - 30 * 60_000);
  const end = new Date(triggered.getTime() + 15 * 60_000);
  const scope = context.target_scope ?? {};
  const stringValue = (() => {
    switch (name) {
      case 'trace_id':
      case 'current_trace_id':
      case 'root_trace_id': return context.root_trace_id ?? undefined;
      case 'service': return context.aiops_service ?? undefined;
      case 'environment': return context.aiops_environment ?? undefined;
      case 'namespace': return typeof scope['namespace'] === 'string' ? scope['namespace'] : undefined;
      case 'target_id': return typeof scope['targetId'] === 'string' ? scope['targetId'] : undefined;
      case 'start': return start.toISOString();
      case 'end': return end.toISOString();
      case 'start_micros': return String(start.getTime() * 1_000);
      case 'end_micros': return String(end.getTime() * 1_000);
      default: return undefined;
    }
  })();
  if (stringValue !== undefined && paramType === 'string') return stringValue;
  if (name === 'hours' && paramType === 'number') return 2;
  if (name === 'limit' && paramType === 'number') return 50;
  if (name === 'span_limit' && paramType === 'number') return 100;
  if (name === 'include_family' && paramType === 'boolean') return true;
  if (name === 'include_previews' && paramType === 'boolean') return false;
  return undefined;
}

function normalizeArguments(
  candidate: IncidentRemediationExecutorCandidate,
  supplied: Record<string, unknown>,
): Record<string, string | number | boolean> {
  if (Object.keys(supplied).length > 32) {
    throw new IncidentRemediationError(400, 'invalid_dry_run_arguments', 'dry-run arguments must contain at most 32 fields');
  }
  const allowed = new Map(candidate.parameters.map(param => [param.name, param]));
  const unknown = Object.keys(supplied).find(name => !allowed.has(name));
  if (unknown) throw new IncidentRemediationError(400, 'invalid_dry_run_arguments', `unknown tool argument '${unknown}'`);
  const result: Record<string, string | number | boolean> = { ...candidate.suggestedArguments };
  for (const [name, raw] of Object.entries(supplied)) {
    const param = allowed.get(name)!;
    if (param.locked && raw !== undefined && raw !== param.suggestedValue) {
      throw new IncidentRemediationError(400, 'incident_argument_locked', `tool argument '${name}' is bound to trusted incident context`);
    }
    if (raw === undefined || raw === null || raw === '') {
      if (!param.locked) delete result[name];
      continue;
    }
    if (param.type === 'string' && typeof raw === 'string' && raw.length <= 2_000) result[name] = raw;
    else if (param.type === 'number' && typeof raw === 'number' && Number.isFinite(raw)) result[name] = raw;
    else if (param.type === 'boolean' && typeof raw === 'boolean') result[name] = raw;
    else throw new IncidentRemediationError(400, 'invalid_dry_run_arguments', `tool argument '${name}' must be a ${param.type}`);
  }
  const missing = candidate.parameters.filter(param => param.required && result[param.name] === undefined).map(param => param.name);
  if (missing.length > 0) {
    throw new IncidentRemediationError(400, 'missing_dry_run_arguments', `required tool arguments are missing: ${missing.join(', ')}`);
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 8_192) {
    throw new IncidentRemediationError(400, 'invalid_dry_run_arguments', 'dry-run arguments exceed the 8 KiB limit');
  }
  return result;
}

function kubernetesScope(context: RemediationContextRow): Pick<KubernetesRemediationTarget, 'backendId' | 'targetId' | 'namespace'> | null {
  const scope = context.target_scope;
  if (!scope || scope['kind'] !== 'kubernetes'
    || !Number.isSafeInteger(scope['backendId']) || Number(scope['backendId']) <= 0
    || typeof scope['targetId'] !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(scope['targetId'])
    || typeof scope['namespace'] !== 'string' || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(scope['namespace'])) return null;
  return {
    backendId: Number(scope['backendId']),
    targetId: scope['targetId'],
    namespace: scope['namespace'],
  };
}

function configuredNamespaces(config: Record<string, unknown> | null): string[] {
  const values = config?.['execution_namespaces'];
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
}

function configuredRemediationSources(config: Record<string, unknown> | null): string[] {
  const values = config?.['remediation_source_bundles'];
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function planHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function resultText(result: ToolResult, max = 16_000): string {
  return redact(result.content.map(part => part.text).join('\n').slice(0, max), { forceEnabled: true }).text;
}

function adapterForPlan(plan: IncidentRemediationChangePlan) {
  const adapter = incidentRemediationAdapter(plan.adapterKey);
  if (!adapter) {
    throw new IncidentRemediationError(409, 'remediation_adapter_unsupported', `remediation adapter '${plan.adapterKey}' is not registered`);
  }
  return adapter;
}

function adapterStateForPlan(plan: IncidentRemediationChangePlan) {
  const adapter = adapterForPlan(plan);
  const state = adapter.normalizeState(plan.adapterState);
  if (!state) {
    throw new IncidentRemediationError(
      409,
      'remediation_adapter_state_invalid',
      `remediation adapter '${plan.adapterKey}' has invalid persisted state`,
    );
  }
  return { adapter, state };
}

function operatorName(operator: Pick<IncidentRemediationOperator, 'username'>): string {
  const username = operator.username.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!username) throw new IncidentRemediationError(400, 'invalid_operator', 'operator identity is required');
  return username;
}

export class PostgresIncidentRemediationExecutor implements IncidentRemediationExecutor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
    private readonly remediationStore: IncidentRemediationStore,
    private readonly execute: ExecuteToolFn = executeTool,
    private readonly writeAudit: IncidentRemediationAuditWriter = process.env['NODE_ENV'] === 'test'
      ? noOpIncidentRemediationAudit
      : unconfiguredIncidentRemediationAudit,
  ) {}

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    // Several unit-test pools intentionally expose only query(). A real pg.Pool
    // always exposes connect(), so production transitions always use BEGIN/COMMIT.
    if (typeof (this.pool as unknown as { connect?: unknown }).connect !== 'function') {
      return work(this.pool as unknown as pg.PoolClient);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
  }

  private async audit(client: pg.PoolClient, event: IncidentRemediationAuditEvent): Promise<void> {
    await this.writeAudit(client, event);
  }

  private async context(incidentId: number, remediationId: number): Promise<RemediationContextRow> {
    const result = await this.pool.query<RemediationContextRow>(
      `SELECT remediation.status, remediation.version, remediation.target_scope, remediation.execution_intent,
              task.root_trace_id, task.execution_bundle_ids AS aiops_bundle_ids,
              task.execution_service AS aiops_service,
              task.execution_environment AS aiops_environment, incident.triggered_at
         FROM mcp_observability_incident_remediations remediation
         JOIN mcp_observability_incident_aiops_tasks task ON task.id=remediation.task_link_id
         JOIN mcp_observability_alert_incidents incident ON incident.id=remediation.incident_id
        WHERE remediation.id=$1 AND remediation.incident_id=$2`,
      [remediationId, incidentId],
    );
    if (!result.rows[0]) {
      throw new IncidentRemediationError(404, 'remediation_not_found', 'remediation proposal was not found for this incident');
    }
    return result.rows[0];
  }

  private async reload(incidentId: number, remediationId: number): Promise<IncidentRemediationRecord> {
    const remediation = (await this.remediationStore.listForIncident(incidentId))
      .find(item => item.id === remediationId);
    if (!remediation) {
      throw new IncidentRemediationError(503, 'remediation_persistence_failed', 'remediation could not be reloaded');
    }
    return remediation;
  }

  private async loadPlan(
    incidentId: number,
    remediationId: number,
    planId: number,
  ): Promise<IncidentRemediationChangePlan> {
    const result = await this.pool.query<IncidentRemediationChangePlanRow>(
      `SELECT plan.*
         FROM mcp_observability_incident_remediation_change_plans plan
         JOIN mcp_observability_incident_remediations remediation ON remediation.id=plan.remediation_id
        WHERE plan.id=$1 AND plan.remediation_id=$2 AND remediation.incident_id=$3`,
      [planId, remediationId, incidentId],
    );
    if (!result.rows[0]) throw new IncidentRemediationError(404, 'change_plan_not_found', 'change plan was not found');
    return incidentRemediationChangePlanFromRow(result.rows[0]);
  }

  private async loadMonitor(
    incidentId: number,
    remediationId: number,
    planId: number,
    monitorId: number,
  ): Promise<IncidentRemediationPostChangeMonitor> {
    const result = await this.pool.query<IncidentRemediationPostChangeMonitorRow>(
      `SELECT monitor.*
         FROM mcp_observability_incident_remediation_post_change_monitors monitor
         JOIN mcp_observability_incident_remediation_change_plans plan ON plan.id=monitor.plan_id
         JOIN mcp_observability_incident_remediations remediation ON remediation.id=monitor.remediation_id
        WHERE monitor.id=$1 AND monitor.plan_id=$2 AND monitor.remediation_id=$3
          AND remediation.incident_id=$4`,
      [monitorId, planId, remediationId, incidentId],
    );
    if (!result.rows[0]) throw new IncidentRemediationError(404, 'post_change_monitor_not_found', 'post-change monitor was not found');
    return incidentRemediationPostChangeMonitorFromRow(result.rows[0]);
  }

  private async reloadResult(
    incidentId: number,
    remediationId: number,
    planId: number,
  ): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }> {
    const remediation = await this.reload(incidentId, remediationId);
    const plan = remediation.changePlans.find(item => item.id === planId);
    if (!plan) throw new IncidentRemediationError(503, 'change_plan_persistence_failed', 'change plan could not be reloaded');
    return { remediation, plan };
  }

  private async schedulePostChangeMonitor(
    plan: IncidentRemediationChangePlan,
    operator: IncidentRemediationOperator,
    binding: { incidentId: number; rootTraceId: string | null },
  ): Promise<boolean> {
    const delaySec = Number.isSafeInteger(this.config.aiopsPostChangeMonitorDelaySec)
      ? this.config.aiopsPostChangeMonitorDelaySec : 300;
    const { state } = adapterStateForPlan(plan);
    const rollbackHash = planHash({
      kind: 'post_change_rollback.v1',
      planHash: plan.planHash,
      rollbackArguments: plan.rollbackArguments,
      restoreState: state.before,
    });
    const verifiedAtMs = plan.verifiedAt == null ? Date.now() : Date.parse(plan.verifiedAt);
    const dueAtMs = Number.isFinite(verifiedAtMs) ? verifiedAtMs + delaySec * 1_000 : Date.now() + delaySec * 1_000;
    const scheduledFor = new Date(Math.max(Date.now(), dueAtMs));
    return this.transaction(async client => {
      const monitor = await client.query<IncidentRemediationPostChangeMonitorRow>(
        `INSERT INTO mcp_observability_incident_remediation_post_change_monitors
          (remediation_id,plan_id,rollback_hash,scheduled_for)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (plan_id) DO NOTHING
         RETURNING *`,
        [plan.remediationId, plan.id, rollbackHash, scheduledFor],
      );
      const created = monitor.rows[0];
      if (!created) return false;
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,'post_change_monitor_scheduled',$2,$3,'Delayed post-change verification scheduled.',$4::jsonb)`,
        [plan.remediationId, operator.id, operatorName(operator), JSON.stringify({
          planId: plan.id,
          monitorId: Number(created.id),
          rollbackHash,
          scheduledFor: scheduledFor.toISOString(),
        })],
      );
      await this.audit(client, {
        eventKey: `monitor-${Number(created.id)}-scheduled`,
        action: 'aiops.remediation.monitor.scheduled', outcome: 'success', risk: 'medium',
        incidentId: binding.incidentId, remediationId: plan.remediationId, planId: plan.id,
        monitorId: Number(created.id), resourceType: 'aiops-post-change-monitor',
        resourceId: String(created.id), resourceRevision: String(created.version),
        planHash: plan.planHash, rollbackHash, rootTraceId: binding.rootTraceId,
        after: { monitorStatus: created.status, monitorVersion: Number(created.version) },
        context: { scheduledFor: scheduledFor.toISOString() },
        operator,
      });
      return true;
    });
  }

  private async repairMissingPostChangeMonitors(limit: number): Promise<number> {
    const missing = await this.pool.query<IncidentRemediationChangePlanRow & {
      incident_id: number | string;
      root_trace_id: string | null;
    }>(
      `SELECT plan.*, remediation.incident_id, task.root_trace_id
         FROM mcp_observability_incident_remediation_change_plans plan
         JOIN mcp_observability_incident_remediations remediation ON remediation.id=plan.remediation_id
         JOIN mcp_observability_incident_aiops_tasks task ON task.id=remediation.task_link_id
         LEFT JOIN mcp_observability_incident_remediation_post_change_monitors monitor ON monitor.plan_id=plan.id
        WHERE plan.status='verified' AND remediation.status='verified' AND monitor.id IS NULL
        ORDER BY plan.verified_at, plan.id
        LIMIT $1`,
      [limit],
    );
    let created = 0;
    for (const row of missing.rows) {
      try {
        if (await this.schedulePostChangeMonitor(
          incidentRemediationChangePlanFromRow(row),
          { id: null, username: 'argus.core' },
          { incidentId: Number(row.incident_id), rootTraceId: row.root_trace_id },
        )) created++;
      } catch {
        // A later reconciliation pass retries transient persistence failures.
      }
    }
    return created;
  }

  private reconciliationStaleSeconds(): number {
    const configured = Number((this.config as Partial<Config>).aiopsRemediationReconcileStaleSec);
    return Number.isFinite(configured) ? Math.max(30, Math.min(86_400, configured)) : 120;
  }

  private async reconcileExecutingPlan(row: InterruptedPlanRow): Promise<'recovered' | 'failedClosed' | 'deferred'> {
    const plan = incidentRemediationChangePlanFromRow(row);
    let adapterState: ReturnType<typeof adapterStateForPlan>;
    try {
      adapterState = adapterStateForPlan(plan);
    } catch {
      return 'deferred';
    }
    let observation: ToolResult;
    try {
      observation = await this.execute(plan.writeToolName, plan.verifyArguments, {
        config: this.config,
        pool: this.pool,
        allowedBundles: [plan.bundleId],
      });
    } catch (cause) {
      observation = {
        content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Reconciliation read failed' }],
        isError: true,
      };
    }
    if (observation.isError) return 'deferred';
    const observedState = adapterState.adapter.observedState(observation);
    if (observedState == null) return 'deferred';

    const desiredObserved = adapterState.adapter.matchesDesiredState(adapterState.state, observedState);
    const beforeObserved = adapterState.adapter.matchesBeforeState(adapterState.state, observedState);
    const resolution = desiredObserved ? 'desired_state_observed'
      : beforeObserved ? 'pre_change_state_observed' : 'ambiguous_provider_state';
    const nextStatus = desiredObserved ? 'verified' : 'failed';
    const verificationTraceId = plan.verificationTraceId ?? randomUUID();
    const preview = resultText(observation);
    const failure = desiredObserved ? null
      : beforeObserved
        ? 'Interrupted execution did not leave the approved desired state; the provider currently matches the pre-change state.'
        : 'Interrupted execution left an unexpected provider state; manual inspection is required.';
    const operator: IncidentRemediationOperator = { id: null, username: 'argus.core.reconciler' };
    let finalized: IncidentRemediationChangePlanRow | null = null;

    await this.transaction(async client => {
      const updated = await client.query<IncidentRemediationChangePlanRow>(
        `UPDATE mcp_observability_incident_remediation_change_plans
            SET status=$2, version=version + 1, execution_result=COALESCE(execution_result,$3),
                execution_error=$4, executed_at=COALESCE(executed_at,now()),
                verification_trace_id=COALESCE(verification_trace_id,$5), verification_result=$6,
                verification_error=$4, verified_at=now(), updated_at=now()
          WHERE id=$1 AND status='executing' AND execution_trace_id IS NOT DISTINCT FROM $7
          RETURNING *`,
        [plan.id, nextStatus, desiredObserved ? 'Provider mutation recovered from durable execution claim.' : null,
          failure, verificationTraceId, preview.slice(0, 16_000), plan.executionTraceId],
      );
      finalized = updated.rows[0] ?? null;
      if (!finalized) return;
      await client.query(
        `UPDATE mcp_observability_incident_remediations
            SET status=$2, execution_mode='governed_write', version=version + 1, updated_at=now()
          WHERE id=$1 AND incident_id=$3`,
        [plan.remediationId, desiredObserved ? 'verified' : 'failed', Number(row.incident_id)],
      );
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,$2,NULL,$3,$4,$5::jsonb)`,
        [plan.remediationId, desiredObserved ? 'verification_passed' : 'execution_failed', operator.username,
          desiredObserved
            ? 'Interrupted provider execution reconciled from the observed desired state.'
            : 'Interrupted provider execution failed closed after state reconciliation.',
          JSON.stringify({ planId: plan.id, executionTraceId: plan.executionTraceId, verificationTraceId, resolution, observedState })],
      );
      await this.audit(client, {
        eventKey: `execution-reconciled-${resolution}`,
        action: 'aiops.remediation.execution.reconciled',
        outcome: desiredObserved ? 'success' : 'failure',
        risk: desiredObserved ? 'high' : 'critical',
        incidentId: Number(row.incident_id), remediationId: plan.remediationId, planId: plan.id,
        resourceType: 'aiops-change-plan', resourceId: String(plan.id),
        resourceRevision: String(finalized.version), planHash: plan.planHash,
        rootTraceId: row.root_trace_id, traceId: verificationTraceId,
        approvalId: `change-plan:${plan.id}:${plan.planHash}`,
        before: { planStatus: 'executing', planVersion: plan.version },
        after: { planStatus: nextStatus, planVersion: Number(finalized.version) },
        context: { reconciliation: true, resolution, observedReplicas: adapterState.adapter.legacyObservedReplicas(observedState) },
        operator,
      });
    });

    if (!finalized) return 'deferred';
    if (desiredObserved) {
      try {
        await this.schedulePostChangeMonitor(
          incidentRemediationChangePlanFromRow(finalized),
          operator,
          { incidentId: Number(row.incident_id), rootTraceId: row.root_trace_id },
        );
      } catch {
        // The normal missing-monitor repair pass remains the durable fallback.
      }
      return 'recovered';
    }
    return 'failedClosed';
  }

  private async reconcileCheckingMonitor(row: InterruptedMonitorRow): Promise<'recovered' | 'failedClosed' | 'deferred'> {
    const plan = incidentRemediationChangePlanFromRow(row.plan);
    let adapterState: ReturnType<typeof adapterStateForPlan>;
    try {
      adapterState = adapterStateForPlan(plan);
    } catch {
      return 'deferred';
    }
    let observation: ToolResult;
    try {
      observation = await this.execute(plan.writeToolName, plan.verifyArguments, {
        config: this.config, pool: this.pool, allowedBundles: [plan.bundleId],
      });
    } catch (cause) {
      observation = {
        content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Post-change reconciliation read failed' }],
        isError: true,
      };
    }
    const preview = resultText(observation);
    const observedState = observation.isError ? null : adapterState.adapter.observedState(observation);
    const status = observation.isError || observedState == null ? 'check_failed' as const
      : adapterState.adapter.matchesDesiredState(adapterState.state, observedState)
        ? 'healthy' as const : 'regression_detected' as const;
    const eventType = status === 'healthy' ? 'post_change_healthy'
      : status === 'regression_detected' ? 'post_change_regressed' : 'post_change_check_failed';
    const error = status === 'check_failed'
      ? (preview.replace(/\s+/g, ' ').trim().slice(0, 1_000) || 'Provider state could not be read during reconciliation.')
      : status === 'regression_detected'
        ? `Expected ${adapterState.adapter.describeExpectedState(adapterState.state, 'desired')} but observed state did not match.`
        : null;
    const operator: IncidentRemediationOperator = { id: null, username: 'argus.core.reconciler' };
    let updated = false;

    await this.transaction(async client => {
      const finalized = await client.query<IncidentRemediationPostChangeMonitorRow>(
        `UPDATE mcp_observability_incident_remediation_post_change_monitors
            SET status=$2, version=version + 1, observed_replicas=$3, observed_state=$4::jsonb,
                observation_result=$5, observation_error=$6, observed_at=now(), updated_at=now()
          WHERE id=$1 AND status='checking' AND observation_trace_id IS NOT DISTINCT FROM $7
          RETURNING *`,
        [Number(row.id), status, adapterState.adapter.legacyObservedReplicas(observedState),
          observedState == null ? null : JSON.stringify(observedState), preview.slice(0, 16_000), error,
          row.observation_trace_id],
      );
      const completed = finalized.rows[0];
      if (!completed) return;
      updated = true;
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,$2,NULL,$3,$4,$5::jsonb)`,
        [Number(row.remediation_id), eventType, operator.username,
          status === 'healthy' ? 'Interrupted post-change check reconciled as healthy.'
            : status === 'regression_detected' ? 'Interrupted post-change check reconciled with regression.'
              : 'Interrupted post-change check failed closed during reconciliation.',
          JSON.stringify({ planId: Number(row.plan_id), monitorId: Number(row.id), reconciliation: true, observedState })],
      );
      await this.audit(client, {
        eventKey: `monitor-${Number(row.id)}-reconciled-${status}`,
        action: 'aiops.remediation.monitor.reconciled',
        outcome: status === 'healthy' ? 'success' : 'failure',
        risk: status === 'regression_detected' ? 'high' : 'medium',
        incidentId: Number(row.incident_id), remediationId: Number(row.remediation_id),
        planId: Number(row.plan_id), monitorId: Number(row.id),
        resourceType: 'aiops-post-change-monitor', resourceId: String(row.id),
        resourceRevision: String(completed.version), planHash: plan.planHash,
        rollbackHash: row.rollback_hash, rootTraceId: row.root_trace_id,
        traceId: row.observation_trace_id,
        before: { monitorStatus: 'checking', monitorVersion: Number(row.version) },
        after: { monitorStatus: status, monitorVersion: Number(completed.version) },
        context: { reconciliation: true, observedReplicas: adapterState.adapter.legacyObservedReplicas(observedState) },
        operator,
      });
    });
    if (!updated) return 'deferred';
    return status === 'healthy' ? 'recovered' : 'failedClosed';
  }

  private async reconcileRollingBackMonitor(row: InterruptedMonitorRow): Promise<'recovered' | 'failedClosed' | 'deferred'> {
    const plan = incidentRemediationChangePlanFromRow(row.plan);
    let adapterState: ReturnType<typeof adapterStateForPlan>;
    try {
      adapterState = adapterStateForPlan(plan);
    } catch {
      return 'deferred';
    }
    let observation: ToolResult;
    try {
      observation = await this.execute(plan.writeToolName, plan.verifyArguments, {
        config: this.config, pool: this.pool, allowedBundles: [plan.bundleId],
      });
    } catch (cause) {
      observation = {
        content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Rollback reconciliation read failed' }],
        isError: true,
      };
    }
    if (observation.isError) return 'deferred';
    const observedState = adapterState.adapter.observedState(observation);
    if (observedState == null) return 'deferred';
    const rolledBack = adapterState.adapter.matchesBeforeState(adapterState.state, observedState);
    const nextStatus = rolledBack ? 'rolled_back' : 'rollback_failed';
    const resolution = rolledBack ? 'pre_change_state_observed' : 'rollback_state_not_observed';
    const preview = resultText(observation);
    const error = rolledBack ? null
      : `Expected rollback state ${adapterState.adapter.describeExpectedState(adapterState.state, 'before')}; manual intervention is required.`;
    const operator: IncidentRemediationOperator = { id: null, username: 'argus.core.reconciler' };
    let updated = false;

    await this.transaction(async client => {
      const finalized = await client.query<IncidentRemediationPostChangeMonitorRow>(
        `UPDATE mcp_observability_incident_remediation_post_change_monitors
            SET status=$2, version=version + 1, rollback_result=$3, rollback_error=$4,
                rolled_back_at=now(), updated_at=now()
          WHERE id=$1 AND status='rolling_back' AND rollback_trace_id IS NOT DISTINCT FROM $5
          RETURNING *`,
        [Number(row.id), nextStatus, preview.slice(0, 16_000), error, row.rollback_trace_id],
      );
      const completed = finalized.rows[0];
      if (!completed) return;
      updated = true;
      await client.query(
        `UPDATE mcp_observability_incident_remediation_change_plans
            SET status=$2, version=version + 1, rollback_trace_id=$3,
                rollback_result=$4, rollback_error=$5, rolled_back_at=now(), updated_at=now()
          WHERE id=$1 AND status='verified'`,
        [plan.id, nextStatus, row.rollback_trace_id, preview.slice(0, 16_000), error],
      );
      await client.query(
        `UPDATE mcp_observability_incident_remediations
            SET status='failed', version=version + 1, updated_at=now()
          WHERE id=$1 AND incident_id=$2`,
        [plan.remediationId, Number(row.incident_id)],
      );
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,$2,NULL,$3,$4,$5::jsonb)`,
        [plan.remediationId, rolledBack ? 'post_change_rollback_succeeded' : 'post_change_rollback_failed',
          operator.username,
          rolledBack ? 'Interrupted rollback reconciled from the observed pre-change state.'
            : 'Interrupted rollback failed closed because the pre-change state was not observed.',
          JSON.stringify({ planId: plan.id, monitorId: Number(row.id), reconciliation: true, resolution, observedState })],
      );
      await this.audit(client, {
        eventKey: `monitor-${Number(row.id)}-rollback-reconciled-${nextStatus}`,
        action: 'aiops.remediation.post-change-rollback.reconciled',
        outcome: rolledBack ? 'success' : 'failure', risk: 'critical',
        incidentId: Number(row.incident_id), remediationId: plan.remediationId,
        planId: plan.id, monitorId: Number(row.id),
        resourceType: 'aiops-post-change-monitor', resourceId: String(row.id),
        resourceRevision: String(completed.version), planHash: plan.planHash,
        rollbackHash: row.rollback_hash, rootTraceId: row.root_trace_id,
        traceId: row.rollback_trace_id,
        approvalId: `post-change-rollback:${Number(row.id)}:${row.rollback_hash}`,
        before: { monitorStatus: 'rolling_back', monitorVersion: Number(row.version) },
        after: { monitorStatus: nextStatus, monitorVersion: Number(completed.version) },
        context: { reconciliation: true, resolution },
        operator,
      });
    });
    if (!updated) return 'deferred';
    return rolledBack ? 'recovered' : 'failedClosed';
  }

  async reconcileInterruptedOperations(limit = 10): Promise<IncidentRemediationReconciliationSummary> {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 10;
    const staleSeconds = this.reconciliationStaleSeconds();
    const plans = await this.pool.query<InterruptedPlanRow>(
      `SELECT plan.*, remediation.incident_id, task.root_trace_id
         FROM mcp_observability_incident_remediation_change_plans plan
         JOIN mcp_observability_incident_remediations remediation ON remediation.id=plan.remediation_id
         JOIN mcp_observability_incident_aiops_tasks task ON task.id=remediation.task_link_id
        WHERE plan.status='executing'
          AND plan.updated_at <= now() - ($1 * interval '1 second')
        ORDER BY plan.updated_at, plan.id
        LIMIT $2`,
      [staleSeconds, boundedLimit],
    );
    const monitors = await this.pool.query<InterruptedMonitorRow>(
      `SELECT monitor.*, remediation.incident_id, task.root_trace_id, to_jsonb(plan) AS plan
         FROM mcp_observability_incident_remediation_post_change_monitors monitor
         JOIN mcp_observability_incident_remediation_change_plans plan ON plan.id=monitor.plan_id
         JOIN mcp_observability_incident_remediations remediation ON remediation.id=monitor.remediation_id
         JOIN mcp_observability_incident_aiops_tasks task ON task.id=remediation.task_link_id
        WHERE monitor.status IN ('checking','rolling_back')
          AND monitor.updated_at <= now() - ($1 * interval '1 second')
        ORDER BY monitor.updated_at, monitor.id
        LIMIT $2`,
      [staleSeconds, boundedLimit],
    );
    const summary: IncidentRemediationReconciliationSummary = {
      examined: 0, recovered: 0, failedClosed: 0, deferred: 0,
    };
    const record = (result: 'recovered' | 'failedClosed' | 'deferred') => {
      summary.examined++;
      if (result === 'recovered') summary.recovered++;
      else if (result === 'failedClosed') summary.failedClosed++;
      else summary.deferred++;
    };
    for (const row of plans.rows) record(await this.reconcileExecutingPlan(row));
    for (const row of monitors.rows) {
      record(row.status === 'checking'
        ? await this.reconcileCheckingMonitor(row)
        : await this.reconcileRollingBackMonitor(row));
    }
    return summary;
  }

  async listWriteAdapters(
    incidentId: number,
    remediationId: number,
  ): Promise<IncidentRemediationWriteAdapterCandidate[]> {
    const context = await this.context(incidentId, remediationId);
    const intent = normalizeIncidentRemediationExecutionIntent(context.execution_intent);
    const adapters = intent
      ? [incidentRemediationAdapter(intent.adapterKey)!]
      : listIncidentRemediationAdapters();
    const unavailable = (
      adapter: (typeof adapters)[number],
      reason: string,
    ): IncidentRemediationWriteAdapterCandidate => ({
      adapterKey: adapter.key,
      label: adapter.label,
      description: adapter.description,
      controls: adapter.controls,
      status: 'unavailable',
      reason,
      bundleId: null,
      bundleLabel: null,
      writeBackendId: null,
      writeBackendName: null,
      writeToolName: null,
      target: null,
      workloadKinds: adapter.workloadKinds,
      replicas: adapter.replicaRange,
      intent: null,
    });
    if (!['approved', 'verified'].includes(context.status)) {
      return adapters.map(adapter => unavailable(adapter, 'Approve the remediation proposal before preparing a provider change.'));
    }
    if (!intent) {
      return adapters.map(adapter => unavailable(adapter, 'This recommendation contains no explicit registered Kubernetes write intent. Diagnostic recommendations remain read-only.'));
    }
    const adapter = incidentRemediationAdapter(intent.adapterKey)!;
    const scope = kubernetesScope(context);
    if (!scope) return [unavailable(adapter, 'This incident is not bound to an exact Kubernetes target and namespace.')];
    const latestDryRun = await this.pool.query<{ status: string }>(
      `SELECT status FROM mcp_observability_incident_remediation_dry_runs
        WHERE remediation_id=$1 ORDER BY started_at DESC, id DESC LIMIT 1`,
      [remediationId],
    );
    if (latestDryRun.rows[0]?.status !== 'passed') {
      return [unavailable(adapter, 'Run a successful read-only evidence validation before preparing a provider change.')];
    }
    const certification = await getLatestKubernetesCertification(this.pool, {
      backendId: scope.backendId,
      targetId: scope.targetId,
    });
    if (!certification || certification.status !== 'passed' || certification.freshness === 'stale') {
      return [unavailable(adapter, 'The incident Kubernetes evidence connector needs a current passing certification.')];
    }
    const source = await this.pool.query<{ config: Record<string, unknown> | null }>(
      'SELECT config FROM mcp_backends WHERE id=$1 AND enabled=true',
      [scope.backendId],
    );
    const sourceConfig = source.rows[0]?.config ?? null;
    const cluster = typeof sourceConfig?.['cluster'] === 'string' ? sourceConfig['cluster'] : scope.targetId;
    const environment = context.aiops_environment
      ?? (typeof sourceConfig?.['environment'] === 'string' ? sourceConfig['environment'] : 'production');
    const bundleIds = [...new Set((context.aiops_bundle_ids ?? []).map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0))];
    if (bundleIds.length === 0) return [unavailable(adapter, 'The incident does not carry an MCP bundle execution boundary.')];
    const sourceBundles = await this.pool.query<{ name: string }>(
      'SELECT name FROM mcp_service_bundles WHERE id=ANY($1::int[]) ORDER BY id',
      [bundleIds],
    );
    const sourceBundleNames = new Set(sourceBundles.rows.map(row => row.name));
    if (sourceBundleNames.size === 0) return [unavailable(adapter, 'The incident MCP bundle boundary no longer exists.')];
    const rows = await this.pool.query<RemoteScaleToolRow>(
      `SELECT membership.bundle_id, bundle.label AS bundle_label,
              backend.id AS backend_id, backend.name AS backend_name, backend.config AS backend_config,
              remote.prefixed_name, remote.tool_name, remote.description, remote.input_schema
         FROM mcp_remote_tools remote
         JOIN mcp_backends backend ON backend.id=remote.backend_id AND backend.enabled=true
         JOIN mcp_registry_entries registry
           ON registry.backend_id=backend.id AND registry.trust_status='trusted'
         JOIN mcp_backend_bundles membership ON membership.backend_id=backend.id
         JOIN mcp_service_bundles bundle ON bundle.id=membership.bundle_id
         JOIN mcp_bundle_backend_tool_policies policy
           ON policy.backend_id=backend.id AND policy.bundle_id=membership.bundle_id
         WHERE remote.tool_name=$1
           AND policy.mode='selected'
           AND remote.prefixed_name=ANY(policy.allowed_tool_names)
         ORDER BY membership.bundle_id, backend.id, remote.prefixed_name`,
      [adapter.remoteToolName],
    );
    const candidates = rows.rows.filter(row => {
      const config = row.backend_config ?? {};
      return config['governed_write'] === true
        && config['remediation_target_id'] === scope.targetId
        && configuredRemediationSources(config).some(name => sourceBundleNames.has(name))
        && configuredNamespaces(config).includes(scope.namespace)
        && adapter.supportsToolSchema(row.input_schema);
    });
    if (candidates.length === 0) {
      return [unavailable(adapter, `No trusted, isolated Kubernetes ${adapter.remoteToolName} adapter is linked to the incident evidence bundle for this target.`)];
    }
    return candidates.map(row => ({
      adapterKey: adapter.key,
      label: adapter.label,
      description: adapter.description,
      controls: adapter.controls,
      status: 'ready',
      reason: null,
      bundleId: Number(row.bundle_id),
      bundleLabel: row.bundle_label,
      writeBackendId: Number(row.backend_id),
      writeBackendName: row.backend_name,
      writeToolName: row.prefixed_name,
      target: { ...scope, cluster, environment },
      workloadKinds: adapter.workloadKinds,
      replicas: adapter.replicaRange,
      intent,
    }));
  }

  async listCandidates(incidentId: number, remediationId: number): Promise<IncidentRemediationExecutorCandidate[]> {
    const context = await this.context(incidentId, remediationId);
    if (context.status !== 'approved') return [];
    const bundleIds = [...new Set((context.aiops_bundle_ids ?? [])
      .map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0))];
    const candidates: IncidentRemediationExecutorCandidate[] = [];
    for (const bundleId of bundleIds) {
      const allowed = await loadAllowedToolNames(this.pool, [bundleId], { includeUnscoped: false });
      if (allowed.size === 0) continue;
      const bundle = await this.pool.query<{ name: string; label: string }>(
        'SELECT name, label FROM mcp_service_bundles WHERE id=$1',
        [bundleId],
      );
      if (!bundle.rows[0]) continue;
      const tools = await this.pool.query<ToolRow>(
        `SELECT name, description, backend, category, tool_type, query_template, parameters, is_write
           FROM mcp_tools
          WHERE enabled=true AND name=ANY($1::text[])
          ORDER BY category NULLS LAST, name`,
        [[...allowed]],
      );
      for (const tool of tools.rows) {
        const executorKind = safeReadKind(tool);
        if (!executorKind) continue;
        const mapped = parameters(tool.parameters).slice(0, 32).map(param => {
          const incidentValue = contextSuggestion(param.name, param.type, context);
          const defaultValue = incidentValue === undefined ? scalarDefault(param) : undefined;
          return {
            ...param,
            ...(incidentValue !== undefined ? { suggestedValue: incidentValue } : {}),
            ...(incidentValue === undefined && defaultValue !== undefined ? { suggestedValue: defaultValue } : {}),
            valueSource: incidentValue !== undefined ? 'incident' as const : defaultValue !== undefined ? 'default' as const : null,
            locked: incidentValue !== undefined,
          };
        });
        const suggestedArguments = Object.fromEntries(mapped
          .filter(param => param.suggestedValue !== undefined)
          .map(param => [param.name, param.suggestedValue!])) as Record<string, string | number | boolean>;
        candidates.push({
          bundleId,
          bundleName: bundle.rows[0].name,
          bundleLabel: bundle.rows[0].label,
          toolName: tool.name,
          description: tool.description,
          backend: tool.backend,
          category: tool.category,
          executorKind,
          parameters: mapped,
          suggestedArguments,
          missingRequiredArguments: mapped.filter(param => param.required && param.suggestedValue === undefined).map(param => param.name),
        });
      }
    }
    return candidates;
  }

  async runDryRun(input: {
    incidentId: number;
    remediationId: number;
    expectedVersion: number;
    bundleId: number;
    toolName: string;
    arguments: Record<string, unknown>;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; dryRun: IncidentRemediationDryRun }> {
    const username = input.operator.username.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!username) throw new IncidentRemediationError(400, 'invalid_operator', 'operator identity is required');
    const candidate = (await this.listCandidates(input.incidentId, input.remediationId))
      .find(item => item.bundleId === input.bundleId && item.toolName === input.toolName);
    if (!candidate) {
      throw new IncidentRemediationError(409, 'dry_run_executor_not_allowed', 'selected tool is not an eligible read-only executor in the incident bundle');
    }
    const lifecycleContext = await this.context(input.incidentId, input.remediationId);
    const args = normalizeArguments(candidate, input.arguments);
    const executionTraceId = randomUUID();
    const client = await this.pool.connect();
    let attempt: DryRunRow;
    let result: ToolResult;
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ status: string; version: number }>(
        `SELECT status, version FROM mcp_observability_incident_remediations
          WHERE id=$1 AND incident_id=$2 FOR UPDATE`,
        [input.remediationId, input.incidentId],
      );
      const remediation = locked.rows[0];
      if (!remediation) throw new IncidentRemediationError(404, 'remediation_not_found', 'remediation proposal was not found for this incident');
      if (remediation.status !== 'approved') {
        throw new IncidentRemediationError(409, 'remediation_not_approved', 'only an approved remediation proposal can run evidence validation');
      }
      if (Number(remediation.version) !== input.expectedVersion) {
        throw new IncidentRemediationError(409, 'remediation_version_conflict', 'remediation proposal changed; refresh before running validation');
      }
      const toolCheck = await client.query<ToolRow & { bundle_allowed: boolean }>(
        `SELECT tool.name, tool.description, tool.backend, tool.category, tool.tool_type,
                tool.query_template, tool.parameters, tool.is_write,
                (
                  EXISTS (
                    SELECT 1 FROM mcp_tool_bundles direct
                     WHERE direct.tool_id=tool.id AND direct.bundle_id=$2
                  )
                  OR EXISTS (
                    SELECT 1
                      FROM mcp_backends backend
                      JOIN mcp_backend_bundles membership
                        ON membership.backend_id=backend.id AND membership.bundle_id=$2
                      LEFT JOIN mcp_bundle_backend_tool_policies policy
                        ON policy.backend_id=backend.id AND policy.bundle_id=membership.bundle_id
                     WHERE (tool.backend=backend.name OR tool.backend='custom:' || backend.name)
                       AND backend.enabled=true
                       AND (policy.mode IS NULL OR policy.mode='all' OR tool.name=ANY(policy.allowed_tool_names))
                  )
                ) AS bundle_allowed
           FROM mcp_tools tool
          WHERE tool.name=$1 AND tool.enabled=true
          FOR SHARE OF tool`,
        [input.toolName, input.bundleId],
      );
      const lockedTool = toolCheck.rows[0];
      if (!lockedTool?.bundle_allowed || safeReadKind(lockedTool) !== candidate.executorKind) {
        throw new IncidentRemediationError(409, 'dry_run_executor_changed', 'selected tool or bundle policy changed; refresh the executor catalog');
      }
      const inserted = await client.query<DryRunRow>(
        `INSERT INTO mcp_observability_incident_remediation_dry_runs
          (remediation_id,bundle_id,tool_name,arguments,status,execution_trace_id,started_by,started_by_username)
         VALUES ($1,$2,$3,$4::jsonb,'running',$5,$6,$7)
         RETURNING *`,
        [input.remediationId, input.bundleId, input.toolName, JSON.stringify(args), executionTraceId, input.operator.id, username],
      );
      attempt = inserted.rows[0]!;
      await client.query(
        `UPDATE mcp_observability_incident_remediations
            SET execution_mode='dry_run', executor_bundle_id=$3, executor_tool_name=$4,
                version=version + 1, updated_at=now()
          WHERE id=$1 AND incident_id=$2`,
        [input.remediationId, input.incidentId, input.bundleId, input.toolName],
      );
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,'dry_run_started',$2,$3,'Read-only evidence validation started.',$4::jsonb)`,
        [input.remediationId, input.operator.id, username, JSON.stringify({ dryRunId: Number(attempt.id), executionTraceId, bundleId: input.bundleId, toolName: input.toolName })],
      );
      await this.audit(client, {
        eventKey: `dry-run-${Number(attempt.id)}-started`,
        action: 'aiops.remediation.dry-run.started', outcome: 'success', risk: 'low',
        incidentId: input.incidentId, remediationId: input.remediationId,
        resourceType: 'aiops-remediation', resourceId: String(input.remediationId),
        resourceRevision: String(Number(remediation.version) + 1),
        rootTraceId: lifecycleContext.root_trace_id, traceId: executionTraceId,
        before: { remediationStatus: remediation.status, remediationVersion: Number(remediation.version) },
        after: { dryRunStatus: 'running' },
        context: { dryRunId: Number(attempt.id), bundleId: input.bundleId, toolName: input.toolName },
        operator: input.operator,
      });
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }

    try {
      result = await this.execute(input.toolName, args, {
        config: this.config,
        pool: this.pool,
        allowedBundles: [input.bundleId],
      });
    } catch (cause) {
      result = { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Tool execution failed' }], isError: true };
    }

    const rawPreview = result.content.map(part => part.text).join('\n').slice(0, 16_000);
    const redacted = redact(rawPreview, { forceEnabled: true });
    const status: IncidentRemediationDryRunStatus = result.isError ? 'failed' : 'passed';
    const errorMessage = status === 'failed'
      ? (redacted.text.replace(/\s+/g, ' ').trim().slice(0, 1_000) || 'Read-only tool returned an error.')
      : null;
    const finalized = await this.transaction(async transactionClient => {
      const updated = await transactionClient.query<DryRunRow>(
        `UPDATE mcp_observability_incident_remediation_dry_runs
            SET status=$2, result_preview=$3, error_message=$4,
                redaction_summary=$5::jsonb, completed_at=now()
          WHERE id=$1 AND status='running'
          RETURNING *`,
        [Number(attempt.id), status, redacted.text.slice(0, 16_000), errorMessage, JSON.stringify(redacted.found)],
      );
      const completed = updated.rows[0];
      if (!completed) throw new IncidentRemediationError(409, 'dry_run_finalize_conflict', 'dry-run result could not be finalized');
      await transactionClient.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          input.remediationId,
          status === 'passed' ? 'dry_run_passed' : 'dry_run_failed',
          input.operator.id,
          username,
          status === 'passed' ? 'Read-only evidence validation passed.' : 'Read-only evidence validation failed.',
          JSON.stringify({ dryRunId: Number(attempt.id), executionTraceId, bundleId: input.bundleId, toolName: input.toolName }),
        ],
      );
      await this.audit(transactionClient, {
        eventKey: `dry-run-${Number(attempt.id)}-${status}`,
        action: status === 'passed' ? 'aiops.remediation.dry-run.passed' : 'aiops.remediation.dry-run.failed',
        outcome: status === 'passed' ? 'success' : 'failure', risk: 'low',
        incidentId: input.incidentId, remediationId: input.remediationId,
        resourceType: 'aiops-remediation', resourceId: String(input.remediationId),
        resourceRevision: String(input.expectedVersion + 1),
        rootTraceId: lifecycleContext.root_trace_id, traceId: executionTraceId,
        after: { dryRunStatus: status },
        context: { dryRunId: Number(attempt.id), bundleId: input.bundleId, toolName: input.toolName },
        operator: input.operator,
      });
      return updated;
    });
    const remediation = (await this.remediationStore.listForIncident(input.incidentId))
      .find(item => item.id === input.remediationId);
    if (!remediation || !finalized.rows[0]) {
      throw new IncidentRemediationError(503, 'dry_run_persistence_failed', 'dry-run evidence could not be reloaded');
    }
    return { remediation, dryRun: mapDryRun(finalized.rows[0]) };
  }

  async createChangePlan(input: IncidentRemediationChangePlanRequest): Promise<{
    remediation: IncidentRemediationRecord;
    plan: IncidentRemediationChangePlan;
  }> {
    const adapter = incidentRemediationAdapter(input.adapterKey);
    if (!adapter) {
      throw new IncidentRemediationError(
        400,
        'remediation_adapter_unsupported',
        `remediation adapter '${String(input.adapterKey)}' is not registered`,
      );
    }
    return this.createKubernetesPlan(input);
  }

  async createKubernetesScalePlan(input: {
    incidentId: number;
    remediationId: number;
    expectedRemediationVersion: number;
    bundleId: number;
    writeToolName: string;
    workloadKind: 'Deployment' | 'StatefulSet';
    workloadName: string;
    desiredReplicas: number;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }> {
    return this.createKubernetesPlan({ ...input, adapterKey: KUBERNETES_SCALE_ADAPTER });
  }

  async createKubernetesPlan(input: IncidentRemediationChangePlanRequest): Promise<{
    remediation: IncidentRemediationRecord;
    plan: IncidentRemediationChangePlan;
  }> {
    const adapter = incidentRemediationAdapter(input.adapterKey);
    if (!adapter) {
      throw new IncidentRemediationError(400, 'remediation_adapter_unsupported', 'the requested remediation adapter is not registered');
    }
    const username = operatorName(input.operator);
    const lifecycleContext = await this.context(input.incidentId, input.remediationId);
    const requestedIntent = adapter.normalizeIntent({
      adapterKey: adapter.key,
      workloadKind: input.workloadKind,
      workloadName: input.workloadName,
      desiredReplicas: input.desiredReplicas,
      targetRevision: input.targetRevision,
    });
    if (!requestedIntent) {
      throw new IncidentRemediationError(400, 'invalid_kubernetes_remediation_intent', 'the requested workload change does not satisfy the registered adapter contract');
    }
    const candidate = (await this.listWriteAdapters(input.incidentId, input.remediationId)).find(item =>
      item.adapterKey === adapter.key && item.status === 'ready'
      && item.bundleId === input.bundleId && item.writeToolName === input.writeToolName);
    if (!candidate || !candidate.target || candidate.writeBackendId == null) {
      throw new IncidentRemediationError(409, 'write_adapter_unavailable', 'selected Kubernetes write adapter is not currently eligible');
    }
    if (!candidate.intent || JSON.stringify(requestedIntent) !== JSON.stringify(candidate.intent)) {
      throw new IncidentRemediationError(409, 'remediation_intent_mismatch', 'the requested change does not match the approved recommendation intent');
    }
    const currentArguments = adapter.readArguments(requestedIntent, candidate.target);
    const currentResult = await this.execute(input.writeToolName, currentArguments, {
      config: this.config,
      pool: this.pool,
      allowedBundles: [input.bundleId],
    });
    const prepared = currentResult.isError ? null : adapter.preparePlan({
      intent: requestedIntent,
      target: candidate.target,
      currentResult,
    });
    if (!prepared) {
      throw new IncidentRemediationError(502, 'kubernetes_state_unreadable', 'the write connector could not provide the bounded current and target state required by this adapter');
    }
    if (prepared.noop) {
      throw new IncidentRemediationError(409, 'kubernetes_change_noop', 'the workload already matches the requested target state');
    }
    const { targetScope, preview, writeArguments, verifyArguments, rollbackArguments, adapterState } = prepared;
    const immutablePayload = {
      adapterKey: adapter.key,
      bundleId: input.bundleId,
      writeBackendId: candidate.writeBackendId,
      writeToolName: input.writeToolName,
      targetScope,
      preview,
      writeArguments,
      verifyArguments,
      rollbackArguments,
      adapterState,
      previousReplicas: prepared.previousReplicas,
      desiredReplicas: prepared.desiredReplicas,
    };
    const hash = planHash(immutablePayload);
    const client = await this.pool.connect();
    let row: IncidentRemediationChangePlanRow;
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ status: string; version: number }>(
        `SELECT status, version FROM mcp_observability_incident_remediations
          WHERE id=$1 AND incident_id=$2 FOR UPDATE`,
        [input.remediationId, input.incidentId],
      );
      const remediation = locked.rows[0];
      if (!remediation) throw new IncidentRemediationError(404, 'remediation_not_found', 'remediation proposal was not found');
      if (remediation.status !== 'approved') throw new IncidentRemediationError(409, 'remediation_not_approved', 'remediation proposal is not approved');
      if (Number(remediation.version) !== input.expectedRemediationVersion) {
        throw new IncidentRemediationError(409, 'remediation_version_conflict', 'remediation changed; refresh before preparing a plan');
      }
      const dryRun = await client.query<{ status: string }>(
        `SELECT status FROM mcp_observability_incident_remediation_dry_runs
          WHERE remediation_id=$1 ORDER BY started_at DESC, id DESC LIMIT 1 FOR SHARE`,
        [input.remediationId],
      );
      if (dryRun.rows[0]?.status !== 'passed') {
        throw new IncidentRemediationError(409, 'dry_run_required', 'a passing read-only validation is required');
      }
      const inserted = await client.query<IncidentRemediationChangePlanRow>(
        `INSERT INTO mcp_observability_incident_remediation_change_plans
          (remediation_id,adapter_key,bundle_id,write_backend_id,write_tool_name,plan_hash,
           target_scope,preview,write_arguments,verify_arguments,rollback_arguments,
           adapter_state,previous_replicas,desired_replicas,created_by,created_by_username)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
         RETURNING *`,
        [input.remediationId, adapter.key, input.bundleId, candidate.writeBackendId,
          input.writeToolName, hash, JSON.stringify(targetScope), JSON.stringify(preview),
          JSON.stringify(writeArguments), JSON.stringify(verifyArguments), JSON.stringify(rollbackArguments),
          JSON.stringify(adapterState), prepared.previousReplicas, prepared.desiredReplicas, input.operator.id, username],
      );
      row = inserted.rows[0]!;
      await client.query(
        `UPDATE mcp_observability_incident_remediations
            SET execution_mode='governed_write', executor_bundle_id=$3, executor_tool_name=$4,
                version=version + 1, updated_at=now()
          WHERE id=$1 AND incident_id=$2`,
        [input.remediationId, input.incidentId, input.bundleId, input.writeToolName],
      );
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,'change_plan_created',$2,$3,$4,$5::jsonb)`,
        [input.remediationId, input.operator.id, username, `Immutable ${adapter.label} preview created.`,
          JSON.stringify({ planId: Number(row.id), planHash: hash, adapterKey: adapter.key })],
      );
      await this.audit(client, {
        eventKey: 'change-plan-created',
        action: 'aiops.remediation.plan.created',
        outcome: 'success',
        risk: 'medium',
        incidentId: input.incidentId,
        remediationId: input.remediationId,
        planId: Number(row.id),
        resourceType: 'aiops-change-plan',
        resourceId: String(row.id),
        resourceRevision: String(row.version),
        planHash: hash,
        rootTraceId: lifecycleContext.root_trace_id,
        policy: { id: 'aiops.remediation.governed-write', version: 'v1', decision: 'prepared' },
        before: { remediationStatus: remediation.status, remediationVersion: Number(remediation.version) },
        after: { planStatus: row.status, planVersion: Number(row.version) },
        context: { adapterKey: adapter.key, bundleId: input.bundleId, writeBackendId: candidate.writeBackendId },
        operator: input.operator,
      });
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
    return { remediation: await this.reload(input.incidentId, input.remediationId), plan: incidentRemediationChangePlanFromRow(row!) };
  }

  async decideChangePlan(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    expectedPlanVersion: number;
    planHash: string;
    decision: 'approve' | 'reject';
    comment: string | null;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }> {
    const username = operatorName(input.operator);
    const comment = input.comment?.replace(/\s+/g, ' ').trim().slice(0, 2_000) || null;
    if (input.decision === 'reject' && (!comment || comment.length < 8)) {
      throw new IncidentRemediationError(400, 'rejection_comment_required', 'rejection comment must contain at least 8 characters');
    }
    if (!/^[a-f0-9]{64}$/.test(input.planHash)) throw new IncidentRemediationError(400, 'invalid_plan_hash', 'plan hash is invalid');
    const lifecycleContext = await this.context(input.incidentId, input.remediationId);
    const client = await this.pool.connect();
    let row: IncidentRemediationChangePlanRow;
    try {
      await client.query('BEGIN');
      const current = await client.query<IncidentRemediationChangePlanRow>(
        `SELECT plan.* FROM mcp_observability_incident_remediation_change_plans plan
          JOIN mcp_observability_incident_remediations remediation ON remediation.id=plan.remediation_id
         WHERE plan.id=$1 AND plan.remediation_id=$2 AND remediation.incident_id=$3 FOR UPDATE OF plan`,
        [input.planId, input.remediationId, input.incidentId],
      );
      const plan = current.rows[0];
      if (!plan) throw new IncidentRemediationError(404, 'change_plan_not_found', 'change plan was not found');
      if (plan.status !== 'awaiting_approval') throw new IncidentRemediationError(409, 'change_plan_already_decided', `change plan is already ${plan.status}`);
      if (Number(plan.version) !== input.expectedPlanVersion || plan.plan_hash !== input.planHash) {
        throw new IncidentRemediationError(409, 'change_plan_conflict', 'change plan version or hash changed; refresh before deciding');
      }
      if (input.decision === 'approve'
        && plan.target_scope['environment'] === 'production'
        && plan.created_by != null && Number(plan.created_by) === input.operator.id) {
        throw new IncidentRemediationError(409, 'production_separation_of_duties', 'production change plans require approval by a different operator');
      }
      const status = input.decision === 'approve' ? 'approved' : 'rejected';
      const updated = await client.query<IncidentRemediationChangePlanRow>(
        `UPDATE mcp_observability_incident_remediation_change_plans
            SET status=$2, version=version + 1, approved_by=$3, approved_by_username=$4,
                approval_comment=$5, approved_at=now(), updated_at=now()
          WHERE id=$1 RETURNING *`,
        [input.planId, status, input.operator.id, username, comment],
      );
      row = updated.rows[0]!;
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [input.remediationId, input.decision === 'approve' ? 'change_plan_approved' : 'change_plan_rejected',
          input.operator.id, username, comment, JSON.stringify({ planId: input.planId, planHash: input.planHash })],
      );
      await this.audit(client, {
        eventKey: `change-plan-${input.decision}`,
        action: input.decision === 'approve'
          ? 'aiops.remediation.plan.approved'
          : 'aiops.remediation.plan.rejected',
        outcome: input.decision === 'approve' ? 'success' : 'denied',
        risk: 'high',
        incidentId: input.incidentId,
        remediationId: input.remediationId,
        planId: input.planId,
        resourceType: 'aiops-change-plan',
        resourceId: String(input.planId),
        resourceRevision: String(row.version),
        planHash: input.planHash,
        rootTraceId: lifecycleContext.root_trace_id,
        policy: {
          id: 'aiops.remediation.human-approval',
          version: 'v1',
          decision: input.decision,
        },
        approvalId: `change-plan:${input.planId}:${input.planHash}`,
        before: { planStatus: plan.status, planVersion: Number(plan.version) },
        after: { planStatus: row.status, planVersion: Number(row.version) },
        operator: input.operator,
      });
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
    return { remediation: await this.reload(input.incidentId, input.remediationId), plan: incidentRemediationChangePlanFromRow(row!) };
  }

  async executeChangePlan(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    expectedPlanVersion: number;
    planHash: string;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }> {
    const username = operatorName(input.operator);
    const before = await this.loadPlan(input.incidentId, input.remediationId, input.planId);
    const { adapter, state } = adapterStateForPlan(before);
    if (before.status !== 'approved' || before.version !== input.expectedPlanVersion || before.planHash !== input.planHash) {
      throw new IncidentRemediationError(409, 'change_plan_conflict', 'only the exact approved plan version and hash can execute');
    }
    const candidate = (await this.listWriteAdapters(input.incidentId, input.remediationId)).find(item =>
      item.adapterKey === before.adapterKey && item.status === 'ready' && item.bundleId === before.bundleId
      && item.writeBackendId === before.writeBackendId && item.writeToolName === before.writeToolName);
    if (!candidate) throw new IncidentRemediationError(409, 'write_adapter_changed', 'write connector, schema, certification or bundle policy changed; execution is blocked');
    const lifecycleContext = await this.context(input.incidentId, input.remediationId);
    const executionTraceId = randomUUID();
    await this.transaction(async client => {
      const started = await client.query<IncidentRemediationChangePlanRow>(
        `UPDATE mcp_observability_incident_remediation_change_plans
            SET status='executing', version=version + 1, execution_trace_id=$2, updated_at=now()
          WHERE id=$1 AND status='approved' AND version=$3 AND plan_hash=$4
          RETURNING *`,
        [input.planId, executionTraceId, input.expectedPlanVersion, input.planHash],
      );
      if (!started.rows[0]) throw new IncidentRemediationError(409, 'change_plan_conflict', 'change plan was claimed by another execution');
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,'execution_started',$2,$3,'Approved change-plan execution started.',$4::jsonb)`,
        [input.remediationId, input.operator.id, username, JSON.stringify({ planId: input.planId, planHash: input.planHash, executionTraceId })],
      );
      await this.audit(client, {
        eventKey: 'execution-started',
        action: 'aiops.remediation.execution.started',
        outcome: 'success',
        risk: 'high',
        incidentId: input.incidentId,
        remediationId: input.remediationId,
        planId: input.planId,
        resourceType: 'aiops-change-plan',
        resourceId: String(input.planId),
        resourceRevision: String(started.rows[0].version),
        planHash: input.planHash,
        rootTraceId: lifecycleContext.root_trace_id,
        traceId: executionTraceId,
        policy: { id: 'aiops.remediation.human-approval', version: 'v1', decision: 'approved' },
        approvalId: `change-plan:${input.planId}:${input.planHash}`,
        before: { planStatus: before.status, planVersion: before.version },
        after: { planStatus: 'executing', planVersion: Number(started.rows[0].version) },
        operator: input.operator,
      });
    });
    let writeResult: ToolResult;
    try {
      writeResult = await this.execute(before.writeToolName, before.writeArguments, {
        config: this.config, pool: this.pool, allowedBundles: [before.bundleId],
      });
    } catch (cause) {
      writeResult = { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Write tool failed' }], isError: true };
    }
    const writeText = resultText(writeResult);
    const verificationTraceId = randomUUID();
    let verifyResult: ToolResult;
    try {
      verifyResult = await this.execute(before.writeToolName, before.verifyArguments, {
        config: this.config, pool: this.pool, allowedBundles: [before.bundleId],
      });
    } catch (cause) {
      verifyResult = { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Verification failed' }], isError: true };
    }
    const observedState = verifyResult.isError ? null : adapter.observedState(verifyResult);
    const observed = adapter.legacyObservedReplicas(observedState);
    const verified = !writeResult.isError && observedState != null
      && adapter.matchesDesiredState(state, observedState);
    if (verified) {
      const verifyText = resultText(verifyResult);
      const row = await this.transaction(async client => {
        const updated = await client.query<IncidentRemediationChangePlanRow>(
          `UPDATE mcp_observability_incident_remediation_change_plans
              SET status='verified', version=version + 1, execution_result=$2, execution_error=NULL,
                  executed_at=now(), verification_trace_id=$3, verification_result=$4,
                  verification_error=NULL, verified_at=now(), updated_at=now()
            WHERE id=$1 AND status='executing' RETURNING *`,
          [input.planId, writeText.slice(0, 16_000), verificationTraceId, verifyText.slice(0, 16_000)],
        );
        const finalized = updated.rows[0];
        if (!finalized) throw new IncidentRemediationError(409, 'change_plan_finalize_conflict', 'change plan could not be finalized');
        await client.query(
          `UPDATE mcp_observability_incident_remediations
              SET status='verified', execution_mode='governed_write', version=version + 1, updated_at=now()
            WHERE id=$1 AND incident_id=$2`,
          [input.remediationId, input.incidentId],
        );
        await client.query(
          `INSERT INTO mcp_observability_incident_remediation_events
            (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
           VALUES
            ($1,'execution_succeeded',$2,$3,'Provider mutation returned successfully.',$4::jsonb),
            ($1,'verification_passed',$2,$3,'Approved desired provider state verified.',$5::jsonb),
            ($1,'verified',$2,$3,'Governed remediation completed and verified.',$5::jsonb)`,
          [input.remediationId, input.operator.id, username,
            JSON.stringify({ planId: input.planId, executionTraceId }),
            JSON.stringify({ planId: input.planId, verificationTraceId, observedState })],
        );
        await this.audit(client, {
          eventKey: 'execution-succeeded', action: 'aiops.remediation.execution.succeeded',
          outcome: 'success', risk: 'high', incidentId: input.incidentId, remediationId: input.remediationId,
          planId: input.planId, resourceType: 'aiops-change-plan', resourceId: String(input.planId),
          resourceRevision: String(finalized.version), planHash: input.planHash,
          rootTraceId: lifecycleContext.root_trace_id, traceId: executionTraceId,
          approvalId: `change-plan:${input.planId}:${input.planHash}`,
          after: { executionStatus: 'succeeded', planStatus: 'verified' },
          operator: input.operator,
        });
        await this.audit(client, {
          eventKey: 'verification-passed', action: 'aiops.remediation.verification.passed',
          outcome: 'success', risk: 'high', incidentId: input.incidentId, remediationId: input.remediationId,
          planId: input.planId, resourceType: 'aiops-change-plan', resourceId: String(input.planId),
          resourceRevision: String(finalized.version), planHash: input.planHash,
          rootTraceId: lifecycleContext.root_trace_id, traceId: verificationTraceId,
          after: { verificationStatus: 'passed', planStatus: 'verified' },
          operator: input.operator,
        });
        return finalized;
      });
      if (!row) throw new IncidentRemediationError(409, 'change_plan_finalize_conflict', 'change plan could not be finalized');
      try {
        await this.schedulePostChangeMonitor(
          incidentRemediationChangePlanFromRow(row),
          input.operator,
          { incidentId: input.incidentId, rootTraceId: lifecycleContext.root_trace_id },
        );
      } catch {
        // The background reconciliation pass repairs a missing monitor without
        // changing the already verified provider mutation outcome.
      }
      return { remediation: await this.reload(input.incidentId, input.remediationId), plan: incidentRemediationChangePlanFromRow(row) };
    }

    const verifyText = resultText(verifyResult);
    await this.transaction(async client => {
      const failedAction = writeResult.isError
        ? 'aiops.remediation.execution.failed'
        : 'aiops.remediation.verification.failed';
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [input.remediationId, writeResult.isError ? 'execution_failed' : 'verification_failed', input.operator.id, username,
          writeResult.isError ? 'Provider mutation returned an error; approved rollback started.' : 'Desired state was not observed; approved rollback started.',
          JSON.stringify({ planId: input.planId, executionTraceId, verificationTraceId, observedState })],
      );
      await this.audit(client, {
        eventKey: writeResult.isError ? 'execution-failed' : 'verification-failed',
        action: failedAction, outcome: 'failure', risk: 'critical',
        incidentId: input.incidentId, remediationId: input.remediationId, planId: input.planId,
        resourceType: 'aiops-change-plan', resourceId: String(input.planId),
        resourceRevision: String(Number(input.expectedPlanVersion) + 1), planHash: input.planHash,
        rootTraceId: lifecycleContext.root_trace_id,
        traceId: writeResult.isError ? executionTraceId : verificationTraceId,
        approvalId: `change-plan:${input.planId}:${input.planHash}`,
        after: { executionStatus: writeResult.isError ? 'failed' : 'succeeded', verificationStatus: 'failed' },
        operator: input.operator,
      });
    });
    const rollbackTraceId = randomUUID();
    let rollbackResult: ToolResult;
    try {
      rollbackResult = await this.execute(before.writeToolName, before.rollbackArguments, {
        config: this.config, pool: this.pool, allowedBundles: [before.bundleId],
      });
    } catch (cause) {
      rollbackResult = { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Rollback failed' }], isError: true };
    }
    let rollbackObservedState = null as ReturnType<typeof adapter.observedState>;
    if (!rollbackResult.isError) {
      try {
        const rollbackVerify = await this.execute(before.writeToolName, before.verifyArguments, {
          config: this.config, pool: this.pool, allowedBundles: [before.bundleId],
        });
        rollbackObservedState = rollbackVerify.isError ? null : adapter.observedState(rollbackVerify);
      } catch { rollbackObservedState = null; }
    }
    const rolledBack = !rollbackResult.isError && rollbackObservedState != null
      && adapter.matchesBeforeState(state, rollbackObservedState);
    const rollbackText = resultText(rollbackResult);
    const failure = writeResult.isError ? writeText : (verifyResult.isError ? verifyText
      : `Expected ${adapter.describeExpectedState(state, 'desired')}; observed state did not match.`);
    const row = await this.transaction(async client => {
      const updated = await client.query<IncidentRemediationChangePlanRow>(
      `UPDATE mcp_observability_incident_remediation_change_plans
          SET status=$2, version=version + 1, execution_result=$3, execution_error=$4,
              executed_at=now(), verification_trace_id=$5, verification_result=$6,
              verification_error=$7, verified_at=now(), rollback_trace_id=$8,
              rollback_result=$9, rollback_error=$10, rolled_back_at=now(), updated_at=now()
        WHERE id=$1 AND status='executing' RETURNING *`,
      [input.planId, rolledBack ? 'rolled_back' : 'rollback_failed', writeText.slice(0, 16_000),
        writeResult.isError ? failure.slice(0, 1_000) : null, verificationTraceId, verifyText.slice(0, 16_000),
        verified ? null : failure.slice(0, 1_000), rollbackTraceId, rollbackText.slice(0, 16_000),
        rolledBack ? null : `Previous state (${adapter.describeExpectedState(state, 'before')}) could not be verified after rollback.`],
    );
      const finalized = updated.rows[0];
      if (!finalized) throw new IncidentRemediationError(409, 'change_plan_finalize_conflict', 'change plan could not be finalized');
      await client.query(
      `UPDATE mcp_observability_incident_remediations
          SET status='failed', execution_mode='governed_write', version=version + 1, updated_at=now()
        WHERE id=$1 AND incident_id=$2`,
      [input.remediationId, input.incidentId],
    );
      await client.query(
      `INSERT INTO mcp_observability_incident_remediation_events
        (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
       VALUES
        ($1,$2,$3,$4,$5,$6::jsonb),
        ($1,'failed',$3,$4,'Governed remediation did not reach the approved desired state.',$6::jsonb)`,
      [input.remediationId, rolledBack ? 'rollback_succeeded' : 'rollback_failed', input.operator.id, username,
        rolledBack ? 'Previous provider state restored and verified.' : 'Rollback could not be verified; manual intervention is required.',
        JSON.stringify({
          planId: input.planId,
          rollbackTraceId,
          observedState: rollbackObservedState,
        })],
    );
      await this.audit(client, {
        eventKey: rolledBack ? 'rollback-succeeded' : 'rollback-failed',
        action: rolledBack ? 'aiops.remediation.rollback.succeeded' : 'aiops.remediation.rollback.failed',
        outcome: rolledBack ? 'success' : 'failure', risk: 'critical',
        incidentId: input.incidentId, remediationId: input.remediationId, planId: input.planId,
        resourceType: 'aiops-change-plan', resourceId: String(input.planId),
        resourceRevision: String(finalized.version), planHash: input.planHash,
        rootTraceId: lifecycleContext.root_trace_id, traceId: rollbackTraceId,
        approvalId: `change-plan:${input.planId}:${input.planHash}`,
        after: { rollbackStatus: rolledBack ? 'verified' : 'failed', planStatus: finalized.status },
        operator: input.operator,
      });
      return finalized;
    });
    return { remediation: await this.reload(input.incidentId, input.remediationId), plan: incidentRemediationChangePlanFromRow(row) };
  }

  async monitorPostChange(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    monitorId: number;
    expectedMonitorVersion: number;
    rollbackHash: string;
    operator: IncidentRemediationOperator;
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }> {
    const username = operatorName(input.operator);
    if (!/^[a-f0-9]{64}$/.test(input.rollbackHash)) {
      throw new IncidentRemediationError(400, 'invalid_rollback_hash', 'rollback hash is invalid');
    }
    const plan = await this.loadPlan(input.incidentId, input.remediationId, input.planId);
    const { adapter, state } = adapterStateForPlan(plan);
    const monitor = await this.loadMonitor(input.incidentId, input.remediationId, input.planId, input.monitorId);
    if (plan.status !== 'verified') {
      throw new IncidentRemediationError(409, 'post_change_plan_not_verified', 'only a verified change plan can be monitored');
    }
    if (!['scheduled', 'healthy', 'check_failed'].includes(monitor.status)
      || monitor.version !== input.expectedMonitorVersion
      || monitor.rollbackHash !== input.rollbackHash) {
      throw new IncidentRemediationError(409, 'post_change_monitor_conflict', 'post-change monitor state, version or rollback hash changed');
    }
    const candidate = (await this.listWriteAdapters(input.incidentId, input.remediationId)).find(item =>
      item.adapterKey === plan.adapterKey && item.status === 'ready' && item.bundleId === plan.bundleId
      && item.writeBackendId === plan.writeBackendId && item.writeToolName === plan.writeToolName);
    if (!candidate) {
      throw new IncidentRemediationError(409, 'post_change_adapter_changed', 'write connector, certification or bundle policy changed; monitoring is blocked');
    }
    const lifecycleContext = await this.context(input.incidentId, input.remediationId);
    const observationTraceId = randomUUID();
    await this.transaction(async client => {
      const claimed = await client.query<IncidentRemediationPostChangeMonitorRow>(
        `UPDATE mcp_observability_incident_remediation_post_change_monitors
            SET status='checking', version=version + 1, observation_trace_id=$2,
                observation_error=NULL, updated_at=now()
          WHERE id=$1 AND version=$3 AND rollback_hash=$4
            AND status=ANY($5::varchar[])
          RETURNING *`,
        [input.monitorId, observationTraceId, input.expectedMonitorVersion, input.rollbackHash,
          ['scheduled', 'healthy', 'check_failed']],
      );
      const started = claimed.rows[0];
      if (!started) {
        throw new IncidentRemediationError(409, 'post_change_monitor_conflict', 'post-change monitor was claimed by another check');
      }
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,'post_change_monitor_started',$2,$3,'Post-change desired-state check started.',$4::jsonb)`,
        [input.remediationId, input.operator.id, username, JSON.stringify({
          planId: input.planId, monitorId: input.monitorId, observationTraceId,
        })],
      );
      await this.audit(client, {
        eventKey: `monitor-${input.monitorId}-started`,
        action: 'aiops.remediation.monitor.started', outcome: 'success', risk: 'medium',
        incidentId: input.incidentId, remediationId: input.remediationId, planId: input.planId,
        monitorId: input.monitorId, resourceType: 'aiops-post-change-monitor',
        resourceId: String(input.monitorId), resourceRevision: String(started.version),
        planHash: plan.planHash, rollbackHash: input.rollbackHash,
        rootTraceId: lifecycleContext.root_trace_id, traceId: observationTraceId,
        before: { monitorStatus: monitor.status, monitorVersion: monitor.version },
        after: { monitorStatus: 'checking', monitorVersion: Number(started.version) },
        operator: input.operator,
      });
    });
    let result: ToolResult;
    try {
      result = await this.execute(plan.writeToolName, plan.verifyArguments, {
        config: this.config, pool: this.pool, allowedBundles: [plan.bundleId],
      });
    } catch (cause) {
      result = { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Post-change verification failed' }], isError: true };
    }
    const resultPreview = resultText(result);
    const observedState = result.isError ? null : adapter.observedState(result);
    const observed = adapter.legacyObservedReplicas(observedState);
    const status = result.isError || observedState == null
      ? 'check_failed' as const
      : adapter.matchesDesiredState(state, observedState) ? 'healthy' as const : 'regression_detected' as const;
    const error = status === 'check_failed'
      ? (resultPreview.replace(/\s+/g, ' ').trim().slice(0, 1_000) || 'Post-change provider state could not be read.')
      : status === 'regression_detected'
        ? `Expected ${adapter.describeExpectedState(state, 'desired')} but observed state did not match.`
        : null;
    const eventType = status === 'healthy' ? 'post_change_healthy'
      : status === 'regression_detected' ? 'post_change_regressed' : 'post_change_check_failed';
    await this.transaction(async client => {
      const finalized = await client.query<IncidentRemediationPostChangeMonitorRow>(
        `UPDATE mcp_observability_incident_remediation_post_change_monitors
            SET status=$2, version=version + 1, observed_replicas=$3, observed_state=$4::jsonb,
                observation_result=$5, observation_error=$6, observed_at=now(), updated_at=now()
          WHERE id=$1 AND status='checking' AND observation_trace_id=$7
          RETURNING *`,
        [input.monitorId, status, observed, observedState == null ? null : JSON.stringify(observedState),
          resultPreview.slice(0, 16_000), error, observationTraceId],
      );
      const completed = finalized.rows[0];
      if (!completed) {
        throw new IncidentRemediationError(409, 'post_change_monitor_finalize_conflict', 'post-change result could not be finalized');
      }
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [input.remediationId, eventType, input.operator.id, username,
          status === 'healthy' ? 'Post-change desired state remains healthy.'
            : status === 'regression_detected' ? 'Post-change drift detected; rollback requires approval.'
              : 'Post-change check failed without authorizing a rollback.',
          JSON.stringify({ planId: input.planId, monitorId: input.monitorId, observationTraceId, observedState })],
      );
      await this.audit(client, {
        eventKey: `monitor-${input.monitorId}-${status}`,
        action: status === 'healthy' ? 'aiops.remediation.monitor.healthy'
          : status === 'regression_detected' ? 'aiops.remediation.monitor.regressed'
            : 'aiops.remediation.monitor.check-failed',
        outcome: status === 'healthy' ? 'success' : 'failure',
        risk: status === 'regression_detected' ? 'high' : 'medium',
        incidentId: input.incidentId, remediationId: input.remediationId, planId: input.planId,
        monitorId: input.monitorId, resourceType: 'aiops-post-change-monitor',
        resourceId: String(input.monitorId), resourceRevision: String(completed.version),
        planHash: plan.planHash, rollbackHash: input.rollbackHash,
        rootTraceId: lifecycleContext.root_trace_id, traceId: observationTraceId,
        after: { monitorStatus: status, monitorVersion: Number(completed.version) },
        context: { observedReplicas: observed },
        operator: input.operator,
      });
    });
    return this.reloadResult(input.incidentId, input.remediationId, input.planId);
  }

  async monitorDuePostChanges(limit = 10): Promise<number> {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 10;
    await this.repairMissingPostChangeMonitors(boundedLimit);
    const due = await this.pool.query<{
      id: number | string;
      remediation_id: number | string;
      plan_id: number | string;
      incident_id: number | string;
      version: number | string;
      rollback_hash: string;
    }>(
      `SELECT monitor.id, monitor.remediation_id, monitor.plan_id, remediation.incident_id,
              monitor.version, monitor.rollback_hash
         FROM mcp_observability_incident_remediation_post_change_monitors monitor
         JOIN mcp_observability_incident_remediations remediation ON remediation.id=monitor.remediation_id
        WHERE monitor.status='scheduled' AND monitor.scheduled_for <= now()
        ORDER BY monitor.scheduled_for, monitor.id
        LIMIT $1`,
      [boundedLimit],
    );
    let completed = 0;
    for (const row of due.rows) {
      try {
        await this.monitorPostChange({
          incidentId: Number(row.incident_id), remediationId: Number(row.remediation_id),
          planId: Number(row.plan_id), monitorId: Number(row.id),
          expectedMonitorVersion: Number(row.version), rollbackHash: row.rollback_hash,
          operator: { id: null, username: 'argus.core' },
        });
        completed++;
      } catch (cause) {
        if (cause instanceof IncidentRemediationError && cause.code === 'post_change_monitor_conflict') continue;
        // Leave an unclaimed scheduled monitor eligible for a later retry when
        // certification, connector availability, or bundle policy recovers.
        continue;
      }
    }
    return completed;
  }

  async decidePostChangeRollback(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    monitorId: number;
    expectedMonitorVersion: number;
    rollbackHash: string;
    decision: 'approve' | 'reject';
    comment: string | null;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }> {
    const username = operatorName(input.operator);
    const comment = input.comment?.replace(/\s+/g, ' ').trim().slice(0, 2_000) || null;
    if (!/^[a-f0-9]{64}$/.test(input.rollbackHash)) throw new IncidentRemediationError(400, 'invalid_rollback_hash', 'rollback hash is invalid');
    if (input.decision === 'reject' && (!comment || comment.length < 8)) {
      throw new IncidentRemediationError(400, 'rejection_comment_required', 'rejection comment must contain at least 8 characters');
    }
    const plan = await this.loadPlan(input.incidentId, input.remediationId, input.planId);
    if (plan.status !== 'verified') {
      throw new IncidentRemediationError(409, 'post_change_plan_not_verified', 'only a verified change plan can authorize rollback');
    }
    if (input.decision === 'approve' && plan.targetScope['environment'] === 'production'
      && plan.createdBy != null && plan.createdBy === input.operator.id) {
      throw new IncidentRemediationError(409, 'production_separation_of_duties', 'production rollback requires approval by a different operator');
    }
    const lifecycleContext = await this.context(input.incidentId, input.remediationId);
    const status = input.decision === 'approve' ? 'rollback_approved' : 'rollback_rejected';
    await this.transaction(async client => {
      const updated = await client.query<IncidentRemediationPostChangeMonitorRow>(
        `UPDATE mcp_observability_incident_remediation_post_change_monitors
            SET status=$2, version=version + 1, decided_by=$3, decided_by_username=$4,
                decision_comment=$5, decided_at=now(), updated_at=now()
          WHERE id=$1 AND plan_id=$6 AND remediation_id=$7
            AND status='regression_detected' AND version=$8 AND rollback_hash=$9
          RETURNING *`,
        [input.monitorId, status, input.operator.id, username, comment, input.planId,
          input.remediationId, input.expectedMonitorVersion, input.rollbackHash],
      );
      const decided = updated.rows[0];
      if (!decided) throw new IncidentRemediationError(409, 'post_change_rollback_conflict', 'rollback proposal state, version or hash changed');
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [input.remediationId, input.decision === 'approve' ? 'post_change_rollback_approved' : 'post_change_rollback_rejected',
          input.operator.id, username, comment, JSON.stringify({
            planId: input.planId, monitorId: input.monitorId, rollbackHash: input.rollbackHash,
          })],
      );
      await this.audit(client, {
        eventKey: `monitor-${input.monitorId}-rollback-${input.decision}`,
        action: input.decision === 'approve'
          ? 'aiops.remediation.post-change-rollback.approved'
          : 'aiops.remediation.post-change-rollback.rejected',
        outcome: input.decision === 'approve' ? 'success' : 'denied', risk: 'critical',
        incidentId: input.incidentId, remediationId: input.remediationId, planId: input.planId,
        monitorId: input.monitorId, resourceType: 'aiops-post-change-monitor',
        resourceId: String(input.monitorId), resourceRevision: String(decided.version),
        planHash: plan.planHash, rollbackHash: input.rollbackHash,
        rootTraceId: lifecycleContext.root_trace_id,
        policy: { id: 'aiops.remediation.post-change-rollback-approval', version: 'v1', decision: input.decision },
        approvalId: `post-change-rollback:${input.monitorId}:${input.rollbackHash}`,
        before: { monitorStatus: 'regression_detected', monitorVersion: input.expectedMonitorVersion },
        after: { monitorStatus: status, monitorVersion: Number(decided.version) },
        operator: input.operator,
      });
    });
    return this.reloadResult(input.incidentId, input.remediationId, input.planId);
  }

  async executePostChangeRollback(input: {
    incidentId: number;
    remediationId: number;
    planId: number;
    monitorId: number;
    expectedMonitorVersion: number;
    rollbackHash: string;
    operator: IncidentRemediationOperator & { id: number };
  }): Promise<{ remediation: IncidentRemediationRecord; plan: IncidentRemediationChangePlan }> {
    const username = operatorName(input.operator);
    if (!/^[a-f0-9]{64}$/.test(input.rollbackHash)) throw new IncidentRemediationError(400, 'invalid_rollback_hash', 'rollback hash is invalid');
    const plan = await this.loadPlan(input.incidentId, input.remediationId, input.planId);
    const { adapter, state } = adapterStateForPlan(plan);
    const monitor = await this.loadMonitor(input.incidentId, input.remediationId, input.planId, input.monitorId);
    if (plan.status !== 'verified' || monitor.status !== 'rollback_approved'
      || monitor.version !== input.expectedMonitorVersion || monitor.rollbackHash !== input.rollbackHash) {
      throw new IncidentRemediationError(409, 'post_change_rollback_conflict', 'only the exact approved rollback version and hash can execute');
    }
    const candidate = (await this.listWriteAdapters(input.incidentId, input.remediationId)).find(item =>
      item.adapterKey === plan.adapterKey && item.status === 'ready' && item.bundleId === plan.bundleId
      && item.writeBackendId === plan.writeBackendId && item.writeToolName === plan.writeToolName);
    if (!candidate) throw new IncidentRemediationError(409, 'post_change_adapter_changed', 'write connector, certification or bundle policy changed; rollback is blocked');
    const lifecycleContext = await this.context(input.incidentId, input.remediationId);
    const rollbackTraceId = randomUUID();
    await this.transaction(async client => {
      const claimed = await client.query<IncidentRemediationPostChangeMonitorRow>(
        `UPDATE mcp_observability_incident_remediation_post_change_monitors
            SET status='rolling_back', version=version + 1, rollback_trace_id=$2, updated_at=now()
          WHERE id=$1 AND status='rollback_approved' AND version=$3 AND rollback_hash=$4
          RETURNING *`,
        [input.monitorId, rollbackTraceId, input.expectedMonitorVersion, input.rollbackHash],
      );
      const started = claimed.rows[0];
      if (!started) throw new IncidentRemediationError(409, 'post_change_rollback_conflict', 'rollback was claimed by another execution');
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,'post_change_rollback_started',$2,$3,'Approved post-change rollback started.',$4::jsonb)`,
        [input.remediationId, input.operator.id, username, JSON.stringify({
          planId: input.planId, monitorId: input.monitorId, rollbackHash: input.rollbackHash, rollbackTraceId,
        })],
      );
      await this.audit(client, {
        eventKey: `monitor-${input.monitorId}-rollback-started`,
        action: 'aiops.remediation.post-change-rollback.started', outcome: 'success', risk: 'critical',
        incidentId: input.incidentId, remediationId: input.remediationId, planId: input.planId,
        monitorId: input.monitorId, resourceType: 'aiops-post-change-monitor',
        resourceId: String(input.monitorId), resourceRevision: String(started.version),
        planHash: plan.planHash, rollbackHash: input.rollbackHash,
        rootTraceId: lifecycleContext.root_trace_id, traceId: rollbackTraceId,
        policy: { id: 'aiops.remediation.post-change-rollback-approval', version: 'v1', decision: 'approved' },
        approvalId: `post-change-rollback:${input.monitorId}:${input.rollbackHash}`,
        before: { monitorStatus: monitor.status, monitorVersion: monitor.version },
        after: { monitorStatus: 'rolling_back', monitorVersion: Number(started.version) },
        operator: input.operator,
      });
    });
    let rollbackResult: ToolResult;
    try {
      rollbackResult = await this.execute(plan.writeToolName, plan.rollbackArguments, {
        config: this.config, pool: this.pool, allowedBundles: [plan.bundleId],
      });
    } catch (cause) {
      rollbackResult = { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Post-change rollback failed' }], isError: true };
    }
    let observedState = null as ReturnType<typeof adapter.observedState>;
    if (!rollbackResult.isError) {
      try {
        const verifyResult = await this.execute(plan.writeToolName, plan.verifyArguments, {
          config: this.config, pool: this.pool, allowedBundles: [plan.bundleId],
        });
        observedState = verifyResult.isError ? null : adapter.observedState(verifyResult);
      } catch { observedState = null; }
    }
    const rolledBack = !rollbackResult.isError && observedState != null
      && adapter.matchesBeforeState(state, observedState);
    const rollbackText = resultText(rollbackResult);
    const rollbackError = rolledBack ? null
      : `Expected rollback state ${adapter.describeExpectedState(state, 'before')}; observed state did not match.`;
    await this.transaction(async client => {
      const finalized = await client.query<IncidentRemediationPostChangeMonitorRow>(
        `UPDATE mcp_observability_incident_remediation_post_change_monitors
            SET status=$2, version=version + 1, rollback_result=$3, rollback_error=$4,
                rolled_back_at=now(), updated_at=now()
          WHERE id=$1 AND status='rolling_back' AND rollback_trace_id=$5
          RETURNING *`,
        [input.monitorId, rolledBack ? 'rolled_back' : 'rollback_failed', rollbackText.slice(0, 16_000), rollbackError, rollbackTraceId],
      );
      const completed = finalized.rows[0];
      if (!completed) throw new IncidentRemediationError(409, 'post_change_rollback_finalize_conflict', 'rollback result could not be finalized');
      await client.query(
        `UPDATE mcp_observability_incident_remediation_change_plans
            SET status=$2, version=version + 1, rollback_trace_id=$3, rollback_result=$4,
                rollback_error=$5, rolled_back_at=now(), updated_at=now()
          WHERE id=$1 AND status='verified'`,
        [input.planId, rolledBack ? 'rolled_back' : 'rollback_failed', rollbackTraceId,
          rollbackText.slice(0, 16_000), rollbackError],
      );
      await client.query(
        `UPDATE mcp_observability_incident_remediations
            SET status='failed', version=version + 1, updated_at=now()
          WHERE id=$1 AND incident_id=$2`,
        [input.remediationId, input.incidentId],
      );
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id,event_type,actor_user_id,actor_username,comment,metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [input.remediationId, rolledBack ? 'post_change_rollback_succeeded' : 'post_change_rollback_failed', input.operator.id, username,
          rolledBack ? 'Post-change regression rollback completed and verified.' : 'Post-change rollback could not be verified; manual intervention is required.',
          JSON.stringify({
            planId: input.planId,
            monitorId: input.monitorId,
            rollbackTraceId,
            observedState,
          })],
      );
      await this.audit(client, {
        eventKey: `monitor-${input.monitorId}-rollback-${rolledBack ? 'succeeded' : 'failed'}`,
        action: rolledBack
          ? 'aiops.remediation.post-change-rollback.succeeded'
          : 'aiops.remediation.post-change-rollback.failed',
        outcome: rolledBack ? 'success' : 'failure', risk: 'critical',
        incidentId: input.incidentId, remediationId: input.remediationId, planId: input.planId,
        monitorId: input.monitorId, resourceType: 'aiops-post-change-monitor',
        resourceId: String(input.monitorId), resourceRevision: String(completed.version),
        planHash: plan.planHash, rollbackHash: input.rollbackHash,
        rootTraceId: lifecycleContext.root_trace_id, traceId: rollbackTraceId,
        approvalId: `post-change-rollback:${input.monitorId}:${input.rollbackHash}`,
        after: { rollbackStatus: rolledBack ? 'verified' : 'failed', monitorStatus: completed.status },
        operator: input.operator,
      });
    });
    return this.reloadResult(input.incidentId, input.remediationId, input.planId);
  }
}
