import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getSharedPool } from '../lib/sharedPool.js';
import { logger } from '../lib/logger.js';
import { redactJson } from '../lib/redaction.js';
import type { HistoricalTraceWindow } from './traceBaseline.js';
import {
  getNativeTelemetryContext,
  withNativeTelemetryContext,
  type NativeTelemetryContext,
} from './telemetryContext.js';

export { getNativeTelemetryContext, withNativeTelemetryContext } from './telemetryContext.js';
export type { NativeTelemetryContext } from './telemetryContext.js';

export type TelemetryStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type TelemetryTraceKind = 'agent' | 'workflow' | 'compliance' | 'evaluation' | 'unknown';
export type TelemetrySpanKind = 'llm' | 'tool' | 'rag' | 'workflow' | 'approval' | 'memory' | 'event' | 'unknown';

const TELEMETRY_SCOPE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function telemetryScopeKey(value: string | null | undefined): string {
  return value && TELEMETRY_SCOPE_KEY.test(value) ? value : 'default';
}

export interface TelemetryReadAccess {
  userId: number;
  observeAll: boolean;
  allowedBundleIds?: number[] | null;
  tenantKey?: string;
  workspaceKey?: string;
}

interface TelemetryScopeParameters {
  tenant: number;
  workspace: number;
}

function appendTelemetryScopeParameters(
  params: unknown[],
  input: Pick<TelemetryReadAccess, 'tenantKey' | 'workspaceKey'>,
): TelemetryScopeParameters | null {
  if (input.tenantKey == null && input.workspaceKey == null) return null;
  params.push(input.tenantKey ?? 'default');
  const tenant = params.length;
  params.push(input.workspaceKey ?? 'default');
  return { tenant, workspace: params.length };
}

function telemetryScopeCondition(alias: string, positions: TelemetryScopeParameters | null): string {
  if (!positions) return 'TRUE';
  const goldenValue = (column: 'tenant_key' | 'workspace_key') => `(
    SELECT golden.${column}
      FROM mcp_golden_path_runs golden
     WHERE golden.workflow_execution_id=${alias}.workflow_execution_id
     ORDER BY golden.started_at DESC, golden.id
     LIMIT 1
  )`;
  return `(
    COALESCE(
      NULLIF(${alias}.metadata->>'tenantKey', ''),
      NULLIF(${alias}.metadata->>'tenant_key', ''),
      ${goldenValue('tenant_key')},
      'default'
    ) = $${positions.tenant}
    AND COALESCE(
      NULLIF(${alias}.metadata->>'workspaceKey', ''),
      NULLIF(${alias}.metadata->>'workspace_key', ''),
      ${goldenValue('workspace_key')},
      'default'
    ) = $${positions.workspace}
  )`;
}

export interface TelemetryHandle {
  id: string;
  startedAt: number;
  rootTraceId: string;
  traceId?: string;
  name?: string;
  kind?: TelemetryTraceKind | TelemetrySpanKind;
  tenantKey?: string;
  workspaceKey?: string;
}

export interface StartTraceInput {
  id?: string;
  externalTraceId?: string | null;
  rootTraceId?: string | null;
  parentTraceId?: string | null;
  parentSpanId?: string | null;
  name: string;
  kind: TelemetryTraceKind;
  sessionId?: string | null;
  userId?: number | null;
  agentId?: number | null;
  workflowExecutionId?: number | null;
  tenantKey?: string;
  workspaceKey?: string;
  model?: string | null;
  provider?: string | null;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface FinishTelemetryInput {
  status: Exclude<TelemetryStatus, 'running'>;
  output?: unknown;
  error?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface StartSpanInput {
  traceId: string;
  parentSpanId?: string | null;
  name: string;
  kind: TelemetrySpanKind;
  model?: string | null;
  provider?: string | null;
  toolName?: string | null;
  tenantKey?: string;
  workspaceKey?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface TelemetryTraceRow {
  id: string;
  external_trace_id: string | null;
  root_trace_id: string;
  parent_trace_id: string | null;
  parent_span_id: string | null;
  name: string;
  kind: TelemetryTraceKind;
  status: TelemetryStatus;
  session_id: string | null;
  user_id: number | null;
  agent_id: number | null;
  workflow_execution_id: number | null;
  model: string | null;
  provider: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  input_preview: unknown;
  output_preview: unknown;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  metadata: Record<string, unknown>;
  agent_name?: string | null;
}

export interface TelemetrySpanRow {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  kind: TelemetrySpanKind;
  status: TelemetryStatus;
  model: string | null;
  provider: string | null;
  tool_name: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  input_preview: unknown;
  output_preview: unknown;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  metadata: Record<string, unknown>;
}

export interface TelemetryTraceFamilyRow extends TelemetryTraceRow {
  workflow_id: number | null;
  workflow_name: string | null;
}

export interface TelemetrySpanDetailRow extends TelemetrySpanRow {
  root_trace_id: string;
  parent_trace_id: string | null;
  trace_name: string;
  trace_kind: TelemetryTraceKind;
}

export interface TelemetryAnalytics {
  summary: {
    totalTraces: number;
    completedTraces: number;
    failedTraces: number;
    activeTraces: number;
    waitingTraces: number;
    successRate: number;
    errorRate: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    llmCalls: number;
    toolCalls: number;
  };
  timeline: Array<{
    bucket: string;
    count: number;
    completed: number;
    failed: number;
    costUsd: number;
    avgDurationMs: number;
  }>;
  models: Array<{
    provider: string;
    model: string;
    calls: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    avgDurationMs: number;
    p95DurationMs: number;
  }>;
  tools: Array<{
    tool: string;
    calls: number;
    failures: number;
    avgDurationMs: number;
    p95DurationMs: number;
  }>;
  agents: Array<{
    id: number | null;
    name: string;
    executions: number;
    failures: number;
    successRate: number;
    tokens: number;
    costUsd: number;
    p95DurationMs: number;
  }>;
  workflows: Array<{
    id: number | null;
    name: string;
    executions: number;
    failures: number;
    successRate: number;
    p95DurationMs: number;
  }>;
}

const SENSITIVE_KEY = /password|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cookie/i;
const MAX_PREVIEW_BYTES = 16_000;
let writeQueue: Promise<void> = Promise.resolve();

function redactKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactKeys);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactKeys(child);
    }
    return output;
  }
  return value;
}

export function sanitizeTelemetryValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const safe = redactJson(redactKeys(value)).value;
  let serialized: string;
  try { serialized = JSON.stringify(safe); }
  catch { serialized = JSON.stringify(String(safe)); }
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PREVIEW_BYTES) return safe;
  return { truncated: true, preview: serialized.slice(0, MAX_PREVIEW_BYTES), originalBytes: Buffer.byteLength(serialized, 'utf8') };
}

function errorMessage(error: unknown): string | null {
  if (error == null) return null;
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

function enqueue(label: string, operation: (pool: pg.Pool) => Promise<unknown>): void {
  const pool = getSharedPool();
  if (!pool) return;
  writeQueue = writeQueue
    .then(async () => { await operation(pool); })
    .catch(error => { logger.warn({ err: error, telemetryOperation: label }, 'Native telemetry write failed'); });
}

export async function flushTelemetryWrites(): Promise<void> {
  await writeQueue;
}

/** Stable UUID so approval resumes append to the original workflow trace. */
export function workflowTelemetryTraceId(executionId: number): string {
  const hex = createHash('sha256').update(`argus:workflow:${executionId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16] ?? '0', 16) % 4] ?? '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function startTelemetryTrace(input: StartTraceInput): TelemetryHandle {
  const id = input.id ?? randomUUID();
  const ambient = getNativeTelemetryContext();
  const rootTraceId = input.rootTraceId ?? ambient?.rootTraceId ?? id;
  const parentTraceId = input.parentTraceId === undefined
    ? ambient?.traceId ?? null
    : input.parentTraceId;
  const parentSpanId = input.parentSpanId === undefined
    ? ambient?.spanId ?? null
    : input.parentSpanId;
  const userId = input.userId === undefined ? ambient?.userId ?? null : input.userId;
  const agentId = input.agentId === undefined ? ambient?.agentId ?? null : input.agentId;
  const workflowExecutionId = input.workflowExecutionId === undefined
    ? ambient?.workflowExecutionId ?? null
    : input.workflowExecutionId;
  const tenantKey = telemetryScopeKey(input.tenantKey ?? ambient?.tenantKey);
  const workspaceKey = telemetryScopeKey(input.workspaceKey ?? ambient?.workspaceKey);
  const handle: TelemetryHandle = {
    id,
    startedAt: Date.now(),
    rootTraceId,
    traceId: id,
    name: input.name,
    kind: input.kind,
    tenantKey,
    workspaceKey,
  };
  enqueue('trace.start', pool => pool.query(
    `INSERT INTO mcp_observability_traces
      (id, external_trace_id, root_trace_id, parent_trace_id, parent_span_id,
       name, kind, status, session_id, user_id, agent_id, workflow_execution_id,
       model, provider, started_at, input_preview, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET status='running', ended_at=NULL, duration_ms=NULL,
           output_preview=NULL, error_message=NULL,
           metadata=mcp_observability_traces.metadata || EXCLUDED.metadata,
           updated_at=now()`,
    [
      handle.id, input.externalTraceId ?? null, rootTraceId, parentTraceId, parentSpanId,
      input.name, input.kind, input.sessionId ?? null, userId,
      agentId, workflowExecutionId, input.model ?? null,
      input.provider ?? null, new Date(handle.startedAt), JSON.stringify(sanitizeTelemetryValue(input.input)),
      JSON.stringify(sanitizeTelemetryValue({ ...(input.metadata ?? {}), tenantKey, workspaceKey })),
    ],
  ));
  logger.info({
    rootTraceId,
    traceId: handle.id,
    telemetryKind: input.kind,
    telemetryName: input.name,
    status: 'running',
    agentId: agentId ?? undefined,
    workflowExecutionId: workflowExecutionId ?? undefined,
    tenantKey,
    workspaceKey,
  }, 'Telemetry trace started');
  return handle;
}

export function finishTelemetryTrace(handle: TelemetryHandle, input: FinishTelemetryInput): void {
  const endedAt = Date.now();
  enqueue('trace.finish', pool => pool.query(
    `UPDATE mcp_observability_traces
        SET status=$2, ended_at=$3,
            duration_ms=(EXTRACT(EPOCH FROM ($3::timestamptz - started_at)) * 1000)::bigint,
            output_preview=$4::jsonb,
            error_message=$5, input_tokens=$6, output_tokens=$7, total_cost_usd=$8,
            metadata=metadata || $9::jsonb, updated_at=now()
      WHERE id=$1`,
    [
      handle.id, input.status, new Date(endedAt),
      JSON.stringify(sanitizeTelemetryValue(input.output)), errorMessage(input.error),
      Math.max(0, input.inputTokens ?? 0), Math.max(0, input.outputTokens ?? 0),
      Math.max(0, input.totalCostUsd ?? 0), JSON.stringify(sanitizeTelemetryValue(input.metadata ?? {})),
    ],
  ));
  const fields = {
    rootTraceId: handle.rootTraceId,
    traceId: handle.id,
    telemetryKind: handle.kind ?? 'unknown',
    telemetryName: handle.name ?? 'trace',
    status: input.status,
    durationMs: Math.max(0, endedAt - handle.startedAt),
    inputTokens: Math.max(0, input.inputTokens ?? 0),
    outputTokens: Math.max(0, input.outputTokens ?? 0),
    termination: input.metadata?.['termination'],
    error: errorMessage(input.error),
    tenantKey: handle.tenantKey,
    workspaceKey: handle.workspaceKey,
  };
  if (input.status === 'failed') logger.warn(fields, 'Telemetry trace failed');
  else logger.info(fields, 'Telemetry trace finished');
}

export function startTelemetrySpan(input: StartSpanInput): TelemetryHandle {
  const ambient = getNativeTelemetryContext();
  const tenantKey = telemetryScopeKey(input.tenantKey ?? ambient?.tenantKey);
  const workspaceKey = telemetryScopeKey(input.workspaceKey ?? ambient?.workspaceKey);
  const handle: TelemetryHandle = {
    id: randomUUID(),
    startedAt: Date.now(),
    rootTraceId: ambient?.rootTraceId ?? input.traceId,
    traceId: input.traceId,
    name: input.name,
    kind: input.kind,
    tenantKey,
    workspaceKey,
  };
  enqueue('span.start', pool => pool.query(
    `INSERT INTO mcp_observability_spans
      (id, trace_id, parent_span_id, name, kind, status, model, provider, tool_name,
       started_at, input_preview, metadata)
     VALUES ($1,$2,$3,$4,$5,'running',$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
    [
      handle.id, input.traceId, input.parentSpanId ?? null, input.name, input.kind,
      input.model ?? null, input.provider ?? null, input.toolName ?? null,
      new Date(handle.startedAt), JSON.stringify(sanitizeTelemetryValue(input.input)),
      JSON.stringify(sanitizeTelemetryValue({ ...(input.metadata ?? {}), tenantKey, workspaceKey })),
    ],
  ));
  return handle;
}

export function finishTelemetrySpan(handle: TelemetryHandle, input: FinishTelemetryInput): void {
  const endedAt = Date.now();
  enqueue('span.finish', pool => pool.query(
    `UPDATE mcp_observability_spans
        SET status=$2, ended_at=$3, duration_ms=$4, output_preview=$5::jsonb,
            error_message=$6, input_tokens=$7, output_tokens=$8, total_cost_usd=$9,
            metadata=metadata || $10::jsonb, updated_at=now()
      WHERE id=$1`,
    [
      handle.id, input.status, new Date(endedAt), Math.max(0, endedAt - handle.startedAt),
      JSON.stringify(sanitizeTelemetryValue(input.output)), errorMessage(input.error),
      Math.max(0, input.inputTokens ?? 0), Math.max(0, input.outputTokens ?? 0),
      Math.max(0, input.totalCostUsd ?? 0), JSON.stringify(sanitizeTelemetryValue(input.metadata ?? {})),
    ],
  ));
  const fields = {
    rootTraceId: handle.rootTraceId,
    traceId: handle.traceId,
    spanId: handle.id,
    telemetryKind: handle.kind ?? 'unknown',
    telemetryName: handle.name ?? 'span',
    status: input.status,
    durationMs: Math.max(0, endedAt - handle.startedAt),
    inputTokens: Math.max(0, input.inputTokens ?? 0),
    outputTokens: Math.max(0, input.outputTokens ?? 0),
    termination: input.metadata?.['termination'],
    error: errorMessage(input.error),
    tenantKey: handle.tenantKey,
    workspaceKey: handle.workspaceKey,
  };
  if (input.status === 'failed') logger.warn(fields, 'Telemetry span failed');
  else logger.info(fields, 'Telemetry span finished');
}

export async function listTelemetryTraces(
  pool: pg.Pool,
  input: TelemetryReadAccess & {
    userId: number;
    observeAll: boolean;
    allowedBundleIds?: number[] | null;
    hours?: number;
    limit?: number;
    status?: string;
    kind?: string;
    qualityCandidates?: boolean;
  },
): Promise<TelemetryTraceRow[]> {
  const params: unknown[] = [input.userId, input.observeAll];
  const conditions = ['($2::boolean OR trace.user_id = $1)'];
  if (input.allowedBundleIds != null) {
    params.push(input.allowedBundleIds);
    conditions.push(`(
      (
        trace.agent_id IS NULL
        OR agent.bundle_ids IS NULL
        OR cardinality(agent.bundle_ids) = 0
        OR agent.bundle_ids && $${params.length}::int[]
      )
      AND (
        trace.workflow_execution_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM mcp_workflow_bundles scoped_wb
           WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
        )
        OR EXISTS (
          SELECT 1 FROM mcp_workflow_bundles scoped_wb
           WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
             AND scoped_wb.bundle_id = ANY($${params.length}::int[])
        )
      )
    )`);
  }
  if (input.hours != null) { params.push(Math.max(1, Math.min(input.hours, 24 * 90))); conditions.push(`trace.started_at >= now() - interval '1 hour' * $${params.length}`); }
  if (input.status) { params.push(input.status); conditions.push(`trace.status = $${params.length}`); }
  if (input.kind) { params.push(input.kind); conditions.push(`trace.kind = $${params.length}`); }
  if (input.qualityCandidates) conditions.push(`(trace.status='failed'
    OR EXISTS (SELECT 1 FROM mcp_observability_feedback f WHERE f.trace_id=trace.id AND f.active AND f.source='human'
      AND (f.sentiment IN ('negative','mixed') OR f.tags && ARRAY['needs-review','hallucination','unsafe','incomplete']))
    OR EXISTS (SELECT 1 FROM mcp_evaluation_results r WHERE r.trace_id=trace.id AND r.status IN ('failed','error')))`);
  conditions.push(telemetryScopeCondition('trace', appendTelemetryScopeParameters(params, input)));
  params.push(Math.max(1, Math.min(input.limit ?? 100, 500)));
  const { rows } = await pool.query<TelemetryTraceRow>(
    `SELECT trace.*, agent.name AS agent_name
       FROM mcp_observability_traces trace
       LEFT JOIN mcp_agents agent ON agent.id = trace.agent_id
       LEFT JOIN mcp_workflow_executions workflow_execution ON workflow_execution.id = trace.workflow_execution_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY trace.started_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function getTelemetryTrace(
  pool: pg.Pool,
  traceIdOrSessionId: string,
  input: TelemetryReadAccess,
): Promise<{ trace: TelemetryTraceRow; spans: TelemetrySpanRow[] } | null> {
  const params: unknown[] = [traceIdOrSessionId, input.userId, input.observeAll];
  const bundleCondition = input.allowedBundleIds == null
    ? 'TRUE'
    : `(
        (
          trace.agent_id IS NULL
          OR agent.bundle_ids IS NULL
          OR cardinality(agent.bundle_ids) = 0
          OR agent.bundle_ids && $4::int[]
        )
        AND (
          trace.workflow_execution_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM mcp_workflow_bundles scoped_wb
             WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
          )
          OR EXISTS (
            SELECT 1 FROM mcp_workflow_bundles scoped_wb
             WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
               AND scoped_wb.bundle_id = ANY($4::int[])
          )
        )
      )`;
  if (input.allowedBundleIds != null) params.push(input.allowedBundleIds);
  const scopeCondition = telemetryScopeCondition('trace', appendTelemetryScopeParameters(params, input));
  const { rows } = await pool.query<TelemetryTraceRow>(
    `SELECT trace.*, agent.name AS agent_name
       FROM mcp_observability_traces trace
       LEFT JOIN mcp_agents agent ON agent.id = trace.agent_id
       LEFT JOIN mcp_workflow_executions workflow_execution ON workflow_execution.id = trace.workflow_execution_id
      WHERE (trace.id::text = $1 OR trace.session_id = $1)
        AND ($3::boolean OR trace.user_id = $2)
        AND ${bundleCondition}
        AND ${scopeCondition}
      ORDER BY trace.started_at DESC
      LIMIT 1`,
    params,
  );
  const trace = rows[0];
  if (!trace) return null;
  const spans = await pool.query<TelemetrySpanRow>(
    'SELECT * FROM mcp_observability_spans WHERE trace_id=$1 ORDER BY started_at, id',
    [trace.id],
  );
  return { trace, spans: spans.rows };
}

export async function getTelemetrySpan(
  pool: pg.Pool,
  spanId: string,
  input: TelemetryReadAccess,
): Promise<TelemetrySpanDetailRow | null> {
  const params: unknown[] = [spanId, input.userId, input.observeAll];
  const bundleCondition = input.allowedBundleIds == null
    ? 'TRUE'
    : `(
        (
          trace.agent_id IS NULL
          OR agent.bundle_ids IS NULL
          OR cardinality(agent.bundle_ids) = 0
          OR agent.bundle_ids && $4::int[]
        )
        AND (
          trace.workflow_execution_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM mcp_workflow_bundles scoped_wb
             WHERE scoped_wb.workflow_id=workflow_execution.workflow_id
          )
          OR EXISTS (
            SELECT 1 FROM mcp_workflow_bundles scoped_wb
             WHERE scoped_wb.workflow_id=workflow_execution.workflow_id
               AND scoped_wb.bundle_id=ANY($4::int[])
          )
        )
      )`;
  if (input.allowedBundleIds != null) params.push(input.allowedBundleIds);
  const scopeCondition = telemetryScopeCondition('trace', appendTelemetryScopeParameters(params, input));
  const result = await pool.query<TelemetrySpanDetailRow>(
    `SELECT span.*, trace.root_trace_id, trace.parent_trace_id,
            trace.name AS trace_name, trace.kind AS trace_kind
       FROM mcp_observability_spans span
       JOIN mcp_observability_traces trace ON trace.id=span.trace_id
       LEFT JOIN mcp_agents agent ON agent.id=trace.agent_id
       LEFT JOIN mcp_workflow_executions workflow_execution
         ON workflow_execution.id=trace.workflow_execution_id
      WHERE span.id=$1::uuid
        AND ($3::boolean OR trace.user_id=$2 OR EXISTS (
          SELECT 1 FROM mcp_observability_traces family_root
           WHERE family_root.id=trace.root_trace_id AND family_root.user_id=$2
        ))
        AND ${bundleCondition}
        AND ${scopeCondition}
      LIMIT 1`,
    params,
  );
  return result.rows[0] ?? null;
}

/**
 * Return every visible execution participating in one distributed native
 * trace. The anchor trace is permission-checked separately by the caller; the
 * query still applies ownership and bundle scope to every returned child.
 */
export async function listTelemetryTraceFamily(
  pool: pg.Pool,
  rootTraceId: string,
  input: TelemetryReadAccess,
): Promise<{
  traces: TelemetryTraceFamilyRow[];
  spans: TelemetrySpanRow[];
  truncated: boolean;
  spansTruncated: boolean;
}> {
  const params: unknown[] = [rootTraceId, input.userId, input.observeAll];
  const conditions = [
    'trace.root_trace_id = $1',
    `($3::boolean OR trace.user_id = $2 OR EXISTS (
      SELECT 1 FROM mcp_observability_traces family_root
       WHERE family_root.id = $1 AND family_root.user_id = $2
    ))`,
  ];
  if (input.allowedBundleIds != null) {
    params.push(input.allowedBundleIds);
    conditions.push(`(
      (
        trace.agent_id IS NULL
        OR agent.bundle_ids IS NULL
        OR cardinality(agent.bundle_ids) = 0
        OR agent.bundle_ids && $${params.length}::int[]
      )
      AND (
        trace.workflow_execution_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM mcp_workflow_bundles scoped_wb
           WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
        )
        OR EXISTS (
          SELECT 1 FROM mcp_workflow_bundles scoped_wb
           WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
             AND scoped_wb.bundle_id = ANY($${params.length}::int[])
        )
      )
    )`);
  }
  conditions.push(telemetryScopeCondition('trace', appendTelemetryScopeParameters(params, input)));
  const result = await pool.query<TelemetryTraceFamilyRow>(
    `SELECT trace.*, agent.name AS agent_name,
            workflow_execution.workflow_id,
            workflow.name AS workflow_name
       FROM mcp_observability_traces trace
       LEFT JOIN mcp_agents agent ON agent.id=trace.agent_id
       LEFT JOIN mcp_workflow_executions workflow_execution
         ON workflow_execution.id=trace.workflow_execution_id
       LEFT JOIN mcp_workflows workflow ON workflow.id=workflow_execution.workflow_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY trace.started_at, trace.id
      LIMIT 251`,
    params,
  );
  const traces = result.rows.slice(0, 250);
  if (traces.length === 0) {
    return { traces, spans: [], truncated: result.rows.length > 250, spansTruncated: false };
  }
  const spanResult = await pool.query<TelemetrySpanRow>(
    `SELECT span.*
       FROM mcp_observability_spans span
      WHERE span.trace_id = ANY($1::uuid[])
      ORDER BY span.started_at, span.id
      LIMIT 2001`,
    [traces.map(trace => trace.id)],
  );
  return {
    traces,
    spans: spanResult.rows.slice(0, 2000),
    truncated: result.rows.length > 250,
    spansTruncated: spanResult.rows.length > 2000,
  };
}

/**
 * Find the most recent successful root execution of the same workflow or
 * agent definition. The candidate is scoped exactly like native trace reads,
 * so a comparison can never reveal a run outside the caller's ownership or
 * assigned backend bundles.
 */
export async function findPreviousComparableTelemetryTrace(
  pool: pg.Pool,
  currentRootTraceId: string,
  input: TelemetryReadAccess,
): Promise<TelemetryTraceFamilyRow | null> {
  const params: unknown[] = [currentRootTraceId, input.userId, input.observeAll];
  const bundleCondition = input.allowedBundleIds == null
    ? 'TRUE'
    : `(
        (
          trace.agent_id IS NULL
          OR agent.bundle_ids IS NULL
          OR cardinality(agent.bundle_ids) = 0
          OR agent.bundle_ids && $4::int[]
        )
        AND (
          trace.workflow_execution_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM mcp_workflow_bundles scoped_wb
             WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
          )
          OR EXISTS (
            SELECT 1 FROM mcp_workflow_bundles scoped_wb
             WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
               AND scoped_wb.bundle_id = ANY($4::int[])
          )
        )
      )`;
  if (input.allowedBundleIds != null) params.push(input.allowedBundleIds);
  const scopeParameters = appendTelemetryScopeParameters(params, input);
  const currentScopeCondition = telemetryScopeCondition('current_trace', scopeParameters);
  const candidateScopeCondition = telemetryScopeCondition('trace', scopeParameters);
  const result = await pool.query<TelemetryTraceFamilyRow>(
    `WITH current_root AS (
       SELECT current_trace.*,
              current_execution.workflow_id AS definition_workflow_id
         FROM mcp_observability_traces current_trace
         LEFT JOIN mcp_workflow_executions current_execution
           ON current_execution.id = current_trace.workflow_execution_id
        WHERE current_trace.id = $1::uuid
          AND ${currentScopeCondition}
        LIMIT 1
     )
     SELECT trace.*, agent.name AS agent_name,
            workflow_execution.workflow_id,
            workflow.name AS workflow_name
       FROM current_root
       JOIN mcp_observability_traces trace ON trace.id = trace.root_trace_id
       LEFT JOIN mcp_agents agent ON agent.id = trace.agent_id
       LEFT JOIN mcp_workflow_executions workflow_execution
         ON workflow_execution.id = trace.workflow_execution_id
       LEFT JOIN mcp_workflows workflow ON workflow.id = workflow_execution.workflow_id
      WHERE trace.id <> current_root.id
        AND trace.started_at < current_root.started_at
        AND trace.status = 'completed'
        AND trace.kind = current_root.kind
        AND ($3::boolean OR trace.user_id = $2)
        AND ${bundleCondition}
        AND ${candidateScopeCondition}
        AND (
          (
            current_root.kind = 'workflow'
            AND (
              (current_root.definition_workflow_id IS NOT NULL
               AND workflow_execution.workflow_id = current_root.definition_workflow_id)
              OR (current_root.definition_workflow_id IS NULL AND trace.name = current_root.name)
            )
          )
          OR (
            current_root.kind = 'agent'
            AND (
              (current_root.agent_id IS NOT NULL AND trace.agent_id = current_root.agent_id)
              OR (current_root.agent_id IS NULL AND trace.name = current_root.name)
            )
          )
        )
      ORDER BY trace.started_at DESC, trace.id DESC
      LIMIT 1`,
    params,
  );
  return result.rows[0] ?? null;
}

interface HistoricalTraceBaselineRow {
  sample_count_7d: string;
  terminal_count_7d: string;
  median_duration_ms_7d: number | string | null;
  p95_duration_ms_7d: number | string | null;
  median_cost_usd_7d: number | string | null;
  p95_cost_usd_7d: number | string | null;
  success_rate_7d: number | string | null;
  sample_count_30d: string;
  terminal_count_30d: string;
  median_duration_ms_30d: number | string | null;
  p95_duration_ms_30d: number | string | null;
  median_cost_usd_30d: number | string | null;
  p95_cost_usd_30d: number | string | null;
  success_rate_30d: number | string | null;
}

/**
 * Aggregate successful comparable root executions into 7- and 30-day
 * performance windows. Family cost prefers span-level attribution and falls
 * back to child/root trace cost when a provider did not emit costed spans.
 */
export async function getTelemetryTraceHistoricalBaseline(
  pool: pg.Pool,
  currentRootTraceId: string,
  input: TelemetryReadAccess,
): Promise<HistoricalTraceWindow[]> {
  const params: unknown[] = [currentRootTraceId, input.userId, input.observeAll];
  const bundleCondition = input.allowedBundleIds == null
    ? 'TRUE'
    : `(
        (
          trace.agent_id IS NULL
          OR agent.bundle_ids IS NULL
          OR cardinality(agent.bundle_ids) = 0
          OR agent.bundle_ids && $4::int[]
        )
        AND (
          trace.workflow_execution_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM mcp_workflow_bundles scoped_wb
             WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
          )
          OR EXISTS (
            SELECT 1 FROM mcp_workflow_bundles scoped_wb
             WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
               AND scoped_wb.bundle_id = ANY($4::int[])
          )
        )
      )`;
  if (input.allowedBundleIds != null) params.push(input.allowedBundleIds);
  const scopeParameters = appendTelemetryScopeParameters(params, input);
  const currentScopeCondition = telemetryScopeCondition('current_trace', scopeParameters);
  const candidateScopeCondition = telemetryScopeCondition('trace', scopeParameters);
  const result = await pool.query<HistoricalTraceBaselineRow>(
    `WITH current_root AS (
       SELECT current_trace.*,
              current_execution.workflow_id AS definition_workflow_id
         FROM mcp_observability_traces current_trace
         LEFT JOIN mcp_workflow_executions current_execution
           ON current_execution.id = current_trace.workflow_execution_id
        WHERE current_trace.id = $1::uuid
          AND ${currentScopeCondition}
        LIMIT 1
     ), comparable AS (
       SELECT trace.started_at, trace.status, trace.duration_ms,
              current_root.started_at AS current_started_at,
              COALESCE(
                NULLIF((
                  SELECT sum(family_span.total_cost_usd)
                    FROM mcp_observability_traces family_trace
                    JOIN mcp_observability_spans family_span ON family_span.trace_id = family_trace.id
                   WHERE family_trace.root_trace_id = trace.id
                ), 0),
                NULLIF((
                  SELECT sum(family_trace.total_cost_usd)
                    FROM mcp_observability_traces family_trace
                   WHERE family_trace.root_trace_id = trace.id AND family_trace.id <> trace.id
                ), 0),
                trace.total_cost_usd
              ) AS family_cost_usd
         FROM current_root
         JOIN mcp_observability_traces trace ON trace.id = trace.root_trace_id
         LEFT JOIN mcp_agents agent ON agent.id = trace.agent_id
         LEFT JOIN mcp_workflow_executions workflow_execution
           ON workflow_execution.id = trace.workflow_execution_id
        WHERE trace.id <> current_root.id
          AND trace.started_at < current_root.started_at
          AND trace.started_at >= current_root.started_at - interval '30 days'
          AND trace.status IN ('completed', 'failed')
          AND trace.kind = current_root.kind
          AND ($3::boolean OR trace.user_id = $2)
          AND ${bundleCondition}
          AND ${candidateScopeCondition}
          AND (
            (current_root.kind = 'workflow' AND (
              (current_root.definition_workflow_id IS NOT NULL
               AND workflow_execution.workflow_id = current_root.definition_workflow_id)
              OR (current_root.definition_workflow_id IS NULL AND trace.name = current_root.name)
            ))
            OR (current_root.kind = 'agent' AND (
              (current_root.agent_id IS NOT NULL AND trace.agent_id = current_root.agent_id)
              OR (current_root.agent_id IS NULL AND trace.name = current_root.name)
            ))
          )
     )
     SELECT
       count(*) FILTER (WHERE status='completed' AND duration_ms IS NOT NULL
         AND started_at >= current_started_at - interval '7 days')::text AS sample_count_7d,
       count(*) FILTER (WHERE started_at >= current_started_at - interval '7 days')::text AS terminal_count_7d,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms)
         FILTER (WHERE status='completed' AND duration_ms IS NOT NULL
           AND started_at >= current_started_at - interval '7 days') AS median_duration_ms_7d,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
         FILTER (WHERE status='completed' AND duration_ms IS NOT NULL
           AND started_at >= current_started_at - interval '7 days') AS p95_duration_ms_7d,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY family_cost_usd)
         FILTER (WHERE status='completed' AND started_at >= current_started_at - interval '7 days') AS median_cost_usd_7d,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY family_cost_usd)
         FILTER (WHERE status='completed' AND started_at >= current_started_at - interval '7 days') AS p95_cost_usd_7d,
       100.0 * count(*) FILTER (WHERE status='completed' AND started_at >= current_started_at - interval '7 days')
         / NULLIF(count(*) FILTER (WHERE started_at >= current_started_at - interval '7 days'), 0) AS success_rate_7d,
       count(*) FILTER (WHERE status='completed' AND duration_ms IS NOT NULL)::text AS sample_count_30d,
       count(*)::text AS terminal_count_30d,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms)
         FILTER (WHERE status='completed' AND duration_ms IS NOT NULL) AS median_duration_ms_30d,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
         FILTER (WHERE status='completed' AND duration_ms IS NOT NULL) AS p95_duration_ms_30d,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY family_cost_usd)
         FILTER (WHERE status='completed') AS median_cost_usd_30d,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY family_cost_usd)
         FILTER (WHERE status='completed') AS p95_cost_usd_30d,
       100.0 * count(*) FILTER (WHERE status='completed') / NULLIF(count(*), 0) AS success_rate_30d
      FROM comparable`,
    params,
  );
  const row = result.rows[0];
  if (!row) return [];
  const window = (days: 7 | 30): HistoricalTraceWindow => ({
    days,
    sampleCount: Number(days === 7 ? row.sample_count_7d : row.sample_count_30d),
    terminalCount: Number(days === 7 ? row.terminal_count_7d : row.terminal_count_30d),
    medianDurationMs: Number(days === 7 ? row.median_duration_ms_7d ?? 0 : row.median_duration_ms_30d ?? 0),
    p95DurationMs: Number(days === 7 ? row.p95_duration_ms_7d ?? 0 : row.p95_duration_ms_30d ?? 0),
    medianCostUsd: Number(days === 7 ? row.median_cost_usd_7d ?? 0 : row.median_cost_usd_30d ?? 0),
    p95CostUsd: Number(days === 7 ? row.p95_cost_usd_7d ?? 0 : row.p95_cost_usd_30d ?? 0),
    successRate: Number(days === 7 ? row.success_rate_7d ?? 0 : row.success_rate_30d ?? 0),
  });
  return [window(7), window(30)];
}

export async function getTelemetryAnalytics(
  pool: pg.Pool,
  input: TelemetryReadAccess & { hours?: number },
): Promise<TelemetryAnalytics> {
  const hours = Math.max(1, Math.min(input.hours ?? 24, 24 * 90));
  const params: unknown[] = [input.userId, hours, input.observeAll];
  const ownership = '($3::boolean OR trace.user_id = $1)';
  let bundleScope = 'TRUE';
  if (input.allowedBundleIds != null) {
    params.push(input.allowedBundleIds);
    bundleScope = `(
      (
        trace.agent_id IS NULL
        OR agent.bundle_ids IS NULL
        OR cardinality(agent.bundle_ids) = 0
        OR agent.bundle_ids && $4::int[]
      )
      AND (
        trace.workflow_execution_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM mcp_workflow_bundles scoped_wb
           WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
        )
        OR EXISTS (
          SELECT 1 FROM mcp_workflow_bundles scoped_wb
           WHERE scoped_wb.workflow_id = workflow_execution.workflow_id
             AND scoped_wb.bundle_id = ANY($4::int[])
        )
      )
    )`;
  }
  const scopeCondition = telemetryScopeCondition('trace', appendTelemetryScopeParameters(params, input));

  const { rows } = await pool.query<{ analytics: TelemetryAnalytics }>(
    `WITH visible_traces AS MATERIALIZED (
       SELECT trace.*, agent.name AS agent_name,
              workflow_execution.workflow_id,
              workflow.name AS workflow_name
         FROM mcp_observability_traces trace
         LEFT JOIN mcp_agents agent ON agent.id = trace.agent_id
         LEFT JOIN mcp_workflow_executions workflow_execution
           ON workflow_execution.id = trace.workflow_execution_id
         LEFT JOIN mcp_workflows workflow ON workflow.id = workflow_execution.workflow_id
        WHERE ${ownership}
          AND trace.started_at >= now() - interval '1 hour' * $2
          AND ${bundleScope}
          AND ${scopeCondition}
     ), visible_spans AS MATERIALIZED (
       SELECT span.*
         FROM mcp_observability_spans span
         JOIN visible_traces trace ON trace.id = span.trace_id
     )
     SELECT json_build_object(
       'summary', (
         SELECT json_build_object(
           'totalTraces', count(*)::int,
           'completedTraces', count(*) FILTER (WHERE status='completed')::int,
           'failedTraces', count(*) FILTER (WHERE status='failed')::int,
           'activeTraces', count(*) FILTER (WHERE status='running')::int,
           'waitingTraces', count(*) FILTER (WHERE status='waiting')::int,
           'successRate', COALESCE(
             100.0 * count(*) FILTER (WHERE status='completed')
             / NULLIF(count(*) FILTER (WHERE status IN ('completed','failed')), 0), 0),
           'errorRate', COALESCE(
             100.0 * count(*) FILTER (WHERE status='failed')
             / NULLIF(count(*) FILTER (WHERE status IN ('completed','failed')), 0), 0),
           'avgDurationMs', COALESCE(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0),
           'p50DurationMs', COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0),
           'p95DurationMs', COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0),
           'totalInputTokens', COALESCE(sum(input_tokens), 0),
           'totalOutputTokens', COALESCE(sum(output_tokens), 0),
           'totalCostUsd', COALESCE(sum(total_cost_usd), 0),
           'llmCalls', (SELECT count(*)::int FROM visible_spans WHERE kind='llm'),
           'toolCalls', (SELECT count(*)::int FROM visible_spans WHERE kind='tool')
         ) FROM visible_traces
       ),
       'timeline', COALESCE((
         SELECT json_agg(row_to_json(points) ORDER BY points.bucket)
           FROM (
             SELECT CASE WHEN $2 <= 48
                       THEN date_trunc('hour', started_at)
                       ELSE date_trunc('day', started_at)
                    END AS bucket,
                    count(*)::int AS count,
                    count(*) FILTER (WHERE status='completed')::int AS completed,
                    count(*) FILTER (WHERE status='failed')::int AS failed,
                    COALESCE(sum(total_cost_usd), 0) AS "costUsd",
                    COALESCE(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS "avgDurationMs"
               FROM visible_traces
              GROUP BY 1
           ) points
       ), '[]'::json),
       'models', COALESCE((
         SELECT json_agg(row_to_json(models) ORDER BY models."costUsd" DESC, models.calls DESC)
           FROM (
             SELECT COALESCE(provider, 'unknown') AS provider,
                    COALESCE(model, 'unknown') AS model,
                    count(*)::int AS calls,
                    count(*) FILTER (WHERE status='failed')::int AS failures,
                    COALESCE(sum(input_tokens), 0) AS "inputTokens",
                    COALESCE(sum(output_tokens), 0) AS "outputTokens",
                    COALESCE(sum(total_cost_usd), 0) AS "costUsd",
                    COALESCE(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS "avgDurationMs",
                    COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS "p95DurationMs"
               FROM visible_spans
              WHERE kind='llm'
              GROUP BY provider, model
              LIMIT 12
           ) models
       ), '[]'::json),
       'tools', COALESCE((
         SELECT json_agg(row_to_json(tools) ORDER BY tools.calls DESC)
           FROM (
             SELECT COALESCE(tool_name, name) AS tool,
                    count(*)::int AS calls,
                    count(*) FILTER (WHERE status='failed')::int AS failures,
                    COALESCE(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS "avgDurationMs",
                    COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS "p95DurationMs"
               FROM visible_spans
              WHERE kind='tool'
              GROUP BY COALESCE(tool_name, name)
              ORDER BY count(*) DESC
              LIMIT 10
           ) tools
       ), '[]'::json),
       'agents', COALESCE((
         SELECT json_agg(row_to_json(agents) ORDER BY agents.executions DESC)
           FROM (
             SELECT agent_id AS id,
                    COALESCE(agent_name, metadata->>'agent_name', name) AS name,
                    count(*)::int AS executions,
                    count(*) FILTER (WHERE status='failed')::int AS failures,
                    COALESCE(100.0 * count(*) FILTER (WHERE status='completed')
                      / NULLIF(count(*) FILTER (WHERE status IN ('completed','failed')), 0), 0) AS "successRate",
                    COALESCE(sum(input_tokens + output_tokens), 0) AS tokens,
                    COALESCE(sum(total_cost_usd), 0) AS "costUsd",
                    COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS "p95DurationMs"
               FROM visible_traces
              WHERE kind='agent'
              GROUP BY agent_id, COALESCE(agent_name, metadata->>'agent_name', name)
              ORDER BY count(*) DESC
              LIMIT 10
           ) agents
       ), '[]'::json),
       'workflows', COALESCE((
         SELECT json_agg(row_to_json(workflows) ORDER BY workflows.executions DESC)
           FROM (
             SELECT workflow_id AS id,
                    COALESCE(workflow_name, metadata->>'workflow_name', name) AS name,
                    count(*)::int AS executions,
                    count(*) FILTER (WHERE status='failed')::int AS failures,
                    COALESCE(100.0 * count(*) FILTER (WHERE status='completed')
                      / NULLIF(count(*) FILTER (WHERE status IN ('completed','failed')), 0), 0) AS "successRate",
                    COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS "p95DurationMs"
               FROM visible_traces
              WHERE kind='workflow'
              GROUP BY workflow_id, COALESCE(workflow_name, metadata->>'workflow_name', name)
              ORDER BY count(*) DESC
              LIMIT 10
           ) workflows
       ), '[]'::json)
     ) AS analytics`,
    params,
  );
  return rows[0]!.analytics;
}
