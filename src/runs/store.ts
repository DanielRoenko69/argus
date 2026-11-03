import type pg from 'pg';
import type { ActiveSession } from '../agents/activeSessions.js';
import type { SessionUser } from '../auth/userAuth.js';
import type { AuthorizedWorkspaceScope } from '../auth/workspaceScope.js';
import { listTelemetryTraces, type TelemetryTraceRow } from '../observability/telemetryStore.js';
import { TAGGABLE_RESOURCE_TYPES, type ResourceRef, type TagRef } from '../tags/types.js';
import type { RunEvidenceCompleteness, RunSourceRecord, RunStatusV2 } from './types.js';

const SOURCE_LIMIT = 500;
const STALE_AFTER_MS = 30 * 60 * 1000;

interface WorkflowRunSourceRow {
  id: string;
  workflow_id: number;
  workflow_name: string;
  status: 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';
  started_at: string | Date;
  completed_at: string | Date | null;
  duration_ms: number | string | null;
  error_message: string | null;
  waiting_approval_id: number | string | null;
  waiting_step_id: string | null;
  resumed_at: string | Date | null;
  parent_execution_id: string | number | null;
  retry_of_execution_id: string | number | null;
  execution_snapshot: Record<string, unknown> | null;
  trace_id: string | null;
  root_trace_id: string | null;
  parent_trace_id: string | null;
  workflow_version: string | null;
  resource_tags: unknown;
}

interface ResourceTagRow {
  resource_id: string;
  id: string | number;
  label: string;
  color: string | null;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function optionalIso(value: string | Date | null): string | null {
  return value == null ? null : iso(value);
}

function positiveDuration(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function staleCandidate(status: RunStatusV2, updatedAt: string, now: Date): boolean {
  return status === 'running' && now.getTime() - Date.parse(updatedAt) >= STALE_AFTER_MS;
}

function tagsFromUnknown(value: unknown): TagRef[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const id = typeof row['id'] === 'string' || typeof row['id'] === 'number' ? String(row['id']) : '';
    const label = typeof row['label'] === 'string' ? row['label'].trim().slice(0, 128) : '';
    const color = typeof row['color'] === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(row['color'])
      ? row['color'].toLowerCase()
      : null;
    return id && label ? [{ id, label, color }] : [];
  });
}

function resourceRefsFromUnknown(value: unknown): ResourceRef[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const type = typeof row['type'] === 'string' && TAGGABLE_RESOURCE_TYPES.includes(row['type'] as never)
      ? row['type'] as ResourceRef['type']
      : null;
    const id = typeof row['id'] === 'string' || typeof row['id'] === 'number' ? String(row['id']) : '';
    const label = typeof row['label'] === 'string' ? row['label'].trim().slice(0, 256) : '';
    const capturedAt = typeof row['capturedAt'] === 'string' && Number.isFinite(Date.parse(row['capturedAt']))
      ? new Date(row['capturedAt']).toISOString()
      : '';
    if (!type || !id || !label || !capturedAt) return [];
    return [{
      type,
      id,
      label,
      href: typeof row['href'] === 'string' && row['href'].startsWith('/') ? row['href'].slice(0, 512) : null,
      version: typeof row['version'] === 'string' || typeof row['version'] === 'number' ? String(row['version']) : null,
      tags: tagsFromUnknown(row['tags']),
      capturedAt,
    }];
  });
}

function frozenRefs(snapshot: Record<string, unknown> | null | undefined): ResourceRef[] {
  return resourceRefsFromUnknown(snapshot?.['resourceRefs']);
}

function resourceEvidence(refs: ResourceRef[], fallback: ResourceRef[]): {
  refs: ResourceRef[];
  completeness: RunEvidenceCompleteness;
} {
  if (refs.length > 0) return { refs, completeness: 'frozen' };
  if (fallback.length > 0) return { refs: fallback, completeness: 'legacy_live_fallback' };
  return { refs: [], completeness: 'missing' };
}

function mapWorkflowStatus(row: WorkflowRunSourceRow): RunStatusV2 {
  return row.status;
}

function workflowScope(user: SessionUser, observeAll: boolean, hours: number): { sql: string; params: unknown[] } {
  const params: unknown[] = [observeAll, user.id, user.username, hours];
  let sql = `
    AND ($1::boolean OR w.created_by=$2 OR e.triggered_by=$3 OR e.triggered_by=('builder:' || $3))
    AND e.started_at >= now() - interval '1 hour' * $4`;
  if (user.allowed_bundles != null) {
    params.push(user.allowed_bundles);
    sql += `
      AND (
        NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles visible_wb WHERE visible_wb.workflow_id=w.id)
        OR EXISTS (
          SELECT 1 FROM mcp_workflow_bundles visible_wb
           WHERE visible_wb.workflow_id=w.id AND visible_wb.bundle_id=ANY($${params.length}::int[])
        )
      )`;
  }
  return { sql, params };
}

export async function loadWorkflowRunSources(
  pool: pg.Pool,
  user: SessionUser,
  observeAll: boolean,
  selectedScope: AuthorizedWorkspaceScope,
  hours: number,
  now = new Date(),
): Promise<RunSourceRecord[]> {
  const visibility = workflowScope(user, observeAll, hours);
  const tenantParam = visibility.params.length + 1;
  const workspaceParam = visibility.params.length + 2;
  const limitParam = visibility.params.length + 3;
  const params = [
    ...visibility.params,
    selectedScope.tenantKey,
    selectedScope.workspaceKey,
    SOURCE_LIMIT,
  ];
  const { rows } = await pool.query<WorkflowRunSourceRow>(
    `SELECT e.id::text, e.workflow_id, w.name AS workflow_name, e.status,
            e.started_at, e.completed_at, e.duration_ms, e.error_message,
            e.waiting_approval_id, e.waiting_step_id, e.resumed_at,
            e.parent_execution_id::text, e.retry_of_execution_id::text,
            e.execution_snapshot,
            trace.id::text AS trace_id, trace.root_trace_id::text, trace.parent_trace_id::text,
            COALESCE(
              e.execution_snapshot->>'workflowVersion',
              (SELECT max(version)::text FROM mcp_workflow_versions version
                WHERE version.workflow_id=e.workflow_id AND version.saved_at <= e.started_at)
            ) AS workflow_version,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('id', tag.id::text, 'label', tag.label, 'color', tag.color)
                               ORDER BY lower(tag.label), tag.id)
                FROM mcp_resource_tag_assignments assignment
                JOIN mcp_workspace_tags tag
                  ON tag.workspace_key=assignment.workspace_key AND tag.id=assignment.tag_id
               WHERE assignment.workspace_key='default'
                 AND $${tenantParam}::text='default'
                 AND $${workspaceParam}::text='default'
                 AND assignment.resource_type='workflow'
                 AND assignment.resource_id=e.workflow_id::text
            ), '[]'::jsonb) AS resource_tags
       FROM mcp_workflow_executions e
       JOIN mcp_workflows w ON w.id=e.workflow_id
       LEFT JOIN LATERAL (
         SELECT golden.tenant_key, golden.workspace_key
           FROM mcp_golden_path_runs golden
          WHERE golden.workflow_execution_id=e.id
          ORDER BY golden.started_at DESC, golden.id
          LIMIT 1
       ) execution_scope ON true
       LEFT JOIN LATERAL (
         SELECT telemetry.id, telemetry.root_trace_id, telemetry.parent_trace_id
           FROM mcp_observability_traces telemetry
          WHERE telemetry.workflow_execution_id=e.id
          ORDER BY telemetry.started_at DESC, telemetry.id
          LIMIT 1
       ) trace ON true
      -- The execution's persisted scope (migration 251) is authoritative. A
      -- Golden Path row is only a consistency check: a disagreeing row hides
      -- the run instead of re-homing it into the selected workspace.
      WHERE e.tenant_key=$${tenantParam}
        AND e.workspace_key=$${workspaceParam}
        AND (execution_scope.tenant_key IS NULL
             OR (execution_scope.tenant_key=e.tenant_key AND execution_scope.workspace_key=e.workspace_key))
        ${visibility.sql}
      ORDER BY e.started_at DESC, e.id DESC
      LIMIT $${limitParam}`,
    params,
  );
  return rows.map(row => {
    const status = mapWorkflowStatus(row);
    const startedAt = iso(row.started_at);
    const updatedAt = optionalIso(row.completed_at) ?? optionalIso(row.resumed_at) ?? startedAt;
    const frozen = frozenRefs(row.execution_snapshot);
    const fallback: ResourceRef = {
      type: 'workflow',
      id: String(row.workflow_id),
      label: row.workflow_name.replaceAll('_', ' '),
      href: `/build/workflows/studio/${row.workflow_id}`,
      version: row.workflow_version,
      tags: tagsFromUnknown(row.resource_tags),
      capturedAt: startedAt,
    };
    const evidence = resourceEvidence(frozen, [fallback]);
    return {
      id: String(row.id),
      kind: 'workflow',
      title: row.workflow_name.replaceAll('_', ' '),
      status,
      startedAt,
      updatedAt,
      durationMs: positiveDuration(row.duration_ms),
      traceId: row.trace_id,
      rootTraceId: row.root_trace_id,
      parentTraceId: row.parent_trace_id,
      parentExecutionId: row.parent_execution_id == null ? null : String(row.parent_execution_id),
      retryOfExecutionId: row.retry_of_execution_id == null ? null : String(row.retry_of_execution_id),
      requestedParent: row.parent_execution_id != null || row.retry_of_execution_id != null || row.parent_trace_id != null
        || (row.trace_id != null && row.root_trace_id != null && row.trace_id !== row.root_trace_id),
      staleCandidate: staleCandidate(status, updatedAt, now),
      attentionReason: status === 'waiting_for_approval'
        ? `approval:${String(row.waiting_approval_id ?? 'pending')}`
        : status === 'failed' ? row.error_message?.slice(0, 256) ?? 'workflow_failed' : null,
      currentPhase: row.waiting_step_id,
      resourceRefs: evidence.refs,
      evidenceCompleteness: evidence.completeness,
      href: `/runs/workflow/${row.id}`,
    } satisfies RunSourceRecord;
  });
}

async function loadAgentTagMap(
  pool: pg.Pool,
  agentIds: number[],
  selectedScope: AuthorizedWorkspaceScope,
): Promise<Map<string, TagRef[]>> {
  // Tags do not have a tenant column yet. Exposing workspace-only matches in
  // another tenant would turn a same-named workspace into a metadata oracle.
  if (selectedScope.tenantKey !== 'default' || selectedScope.workspaceKey !== 'default') return new Map();
  const unique = [...new Set(agentIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (unique.length === 0) return new Map();
  const { rows } = await pool.query<ResourceTagRow>(
    `SELECT assignment.resource_id, tag.id, tag.label, tag.color
       FROM mcp_resource_tag_assignments assignment
       JOIN mcp_workspace_tags tag
         ON tag.workspace_key=assignment.workspace_key AND tag.id=assignment.tag_id
      WHERE assignment.workspace_key='default'
        AND assignment.resource_type='agent'
        AND assignment.resource_id=ANY($1::text[])
      ORDER BY assignment.resource_id, lower(tag.label), tag.id`,
    [unique.map(String)],
  );
  const map = new Map<string, TagRef[]>();
  for (const row of rows) {
    const current = map.get(row.resource_id) ?? [];
    current.push({ id: String(row.id), label: row.label, color: row.color });
    map.set(row.resource_id, current);
  }
  return map;
}

function telemetryStatus(trace: TelemetryTraceRow): RunStatusV2 {
  if (trace.status !== 'waiting') return trace.status;
  const reason = String(trace.metadata?.['waiting_reason'] ?? trace.metadata?.['termination'] ?? '').toLowerCase();
  return reason.includes('approval') || trace.metadata?.['approval_id'] != null
    ? 'waiting_for_approval'
    : 'waiting_for_external';
}

function telemetryCurrentPhase(trace: TelemetryTraceRow): string | null {
  for (const key of ['current_phase', 'workflow_step_id', 'agent_role', 'agent_mode']) {
    const value = trace.metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128);
  }
  return null;
}

function telemetryAttention(trace: TelemetryTraceRow, status: RunStatusV2): string | null {
  if (status === 'waiting_for_approval') return 'approval_required';
  if (status === 'waiting_for_external') {
    const reason = trace.metadata?.['waiting_reason'];
    return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 256) : 'external_wait';
  }
  if (status === 'failed') return trace.error_message?.slice(0, 256) ?? 'run_failed';
  return null;
}

function agentFallbackRef(
  id: number | null,
  label: string,
  tags: Map<string, TagRef[]>,
  capturedAt: string,
): ResourceRef[] {
  if (id == null) return [];
  return [{
    type: 'agent',
    id: String(id),
    label,
    href: `/build/agents/${id}`,
    version: null,
    tags: tags.get(String(id)) ?? [],
    capturedAt,
  }];
}

function visualWorkflowId(metadata: Record<string, unknown>): number | null {
  const workflowId = typeof metadata['workflow_id'] === 'string' ? metadata['workflow_id'] : '';
  const workflowType = typeof metadata['workflow_type'] === 'string' ? metadata['workflow_type'] : '';
  const raw = /^visual-([1-9]\d*)(?:-|$)/.exec(workflowId)?.[1]
    ?? /^visual_workflow_([1-9]\d*)$/.exec(workflowType)?.[1];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function loadTelemetryRunSources(
  pool: pg.Pool,
  user: SessionUser,
  observeAll: boolean,
  selectedScope: AuthorizedWorkspaceScope,
  hours: number,
  now = new Date(),
): Promise<{ records: RunSourceRecord[]; sessionIds: Set<string> }> {
  const traces = (await listTelemetryTraces(pool, {
    userId: user.id,
    observeAll,
    allowedBundleIds: user.allowed_bundles,
    tenantKey: selectedScope.tenantKey,
    workspaceKey: selectedScope.workspaceKey,
    hours,
    limit: SOURCE_LIMIT,
  })).filter(trace => trace.kind === 'agent' || (trace.kind === 'workflow' && trace.workflow_execution_id == null));
  const agentTags = await loadAgentTagMap(
    pool,
    traces.flatMap(trace => trace.agent_id == null ? [] : [trace.agent_id]),
    selectedScope,
  );
  const sessionIds = new Set(traces.flatMap(trace => trace.session_id ? [trace.session_id] : []));
  const records = traces.map(trace => {
    const status = telemetryStatus(trace);
    const startedAt = iso(trace.started_at);
    const updatedAt = optionalIso(trace.ended_at) ?? startedAt;
    const metadataRefs = resourceRefsFromUnknown(trace.metadata?.['resourceRefs'] ?? trace.metadata?.['resource_refs']);
    const label = trace.agent_name
      || (typeof trace.metadata?.['agent_name'] === 'string' ? trace.metadata['agent_name'] : null)
      || trace.name.replaceAll('.', ' ');
    const visualId = trace.kind === 'workflow' ? visualWorkflowId(trace.metadata ?? {}) : null;
    const fallback = trace.kind === 'agent'
      ? agentFallbackRef(trace.agent_id, label, agentTags, startedAt)
      : visualId == null ? [] : [{
        type: 'workflow' as const,
        id: String(visualId),
        label,
        href: `/build/workflows/studio/${visualId}`,
        version: null,
        tags: [],
        capturedAt: startedAt,
      }];
    const evidence = resourceEvidence(metadataRefs, fallback);
    return {
      id: trace.id,
      kind: trace.kind === 'workflow' ? 'workflow' : 'agent',
      title: label,
      status,
      startedAt,
      updatedAt,
      durationMs: positiveDuration(trace.duration_ms),
      traceId: trace.id,
      rootTraceId: trace.root_trace_id,
      parentTraceId: trace.parent_trace_id,
      parentExecutionId: null,
      retryOfExecutionId: null,
      requestedParent: trace.parent_trace_id != null || trace.root_trace_id !== trace.id,
      staleCandidate: staleCandidate(status, updatedAt, now),
      attentionReason: telemetryAttention(trace, status),
      currentPhase: telemetryCurrentPhase(trace),
      resourceRefs: evidence.refs,
      evidenceCompleteness: evidence.completeness,
      href: `/runs/${trace.kind === 'workflow' ? 'workflow' : 'agent'}/${encodeURIComponent(trace.id)}`,
    } satisfies RunSourceRecord;
  });
  return { records, sessionIds };
}

async function allowedActiveAgentIds(pool: pg.Pool, user: SessionUser, sessions: ActiveSession[]): Promise<Set<number>> {
  const ids = [...new Set(sessions.map(session => session.agentId))];
  if (user.allowed_bundles == null) return new Set(ids);
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM mcp_agents
      WHERE id=ANY($1::int[])
        AND (bundle_ids IS NULL OR cardinality(bundle_ids)=0 OR bundle_ids && $2::int[])`,
    [ids, user.allowed_bundles],
  );
  return new Set(rows.map(row => Number(row.id)));
}

export async function loadActiveRunSources(
  pool: pg.Pool,
  user: SessionUser,
  observeAll: boolean,
  sessions: ActiveSession[],
  persistedSessionIds: Set<string>,
  selectedScope: AuthorizedWorkspaceScope,
  now = new Date(),
): Promise<RunSourceRecord[]> {
  const scoped = sessions.filter(session => !persistedSessionIds.has(session.sessionId))
    .filter(session => observeAll || session.callingUserId === user.id)
    .filter(session => (session.tenantKey ?? 'default') === selectedScope.tenantKey
      && (session.workspaceKey ?? 'default') === selectedScope.workspaceKey);
  const allowedIds = await allowedActiveAgentIds(pool, user, scoped);
  const visible = scoped.filter(session => allowedIds.has(session.agentId));
  const agentTags = await loadAgentTagMap(pool, visible.map(session => session.agentId), selectedScope);
  return visible.map(session => {
    const status: RunStatusV2 = session.status === 'error'
      ? 'failed'
      : session.status === 'done' ? 'completed' : 'running';
    const startedAt = new Date(session.startedAt).toISOString();
    const updatedAt = new Date(session.lastActivityAt).toISOString();
    const fallback = agentFallbackRef(session.agentId, session.agentName, agentTags, startedAt);
    return {
      id: session.sessionId,
      kind: 'agent',
      title: session.agentName,
      status,
      startedAt,
      updatedAt,
      durationMs: Math.max(0, session.lastActivityAt - session.startedAt),
      traceId: null,
      rootTraceId: null,
      parentTraceId: null,
      parentExecutionId: null,
      retryOfExecutionId: null,
      requestedParent: false,
      staleCandidate: staleCandidate(status, updatedAt, now),
      attentionReason: session.errorMessage?.slice(0, 256) ?? null,
      currentPhase: session.status,
      resourceRefs: fallback,
      evidenceCompleteness: fallback.length > 0 ? 'legacy_live_fallback' : 'missing',
      href: `/runs/agent/${encodeURIComponent(session.sessionId)}`,
    };
  });
}
