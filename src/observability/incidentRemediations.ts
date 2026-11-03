import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { IncidentAiopsExecutionIntent, IncidentAiopsTaskRecord } from './incidentAiopsTasks.js';
import type { IncidentRemediationDryRun } from './incidentRemediationExecutor.js';
import {
  incidentRemediationChangePlanFromRow,
  incidentRemediationPostChangeMonitorFromRow,
  type IncidentRemediationChangePlan,
  type IncidentRemediationChangePlanRow,
  type IncidentRemediationPostChangeMonitor,
  type IncidentRemediationPostChangeMonitorRow,
} from './incidentRemediationPlans.js';

export type IncidentRemediationStatus = 'proposed' | 'approved' | 'rejected' | 'executed' | 'failed' | 'verified';
export type IncidentRemediationRisk = 'low' | 'medium' | 'high' | 'critical';
export type IncidentRemediationDecision = 'approve' | 'reject';
export type IncidentRemediationEventType = IncidentRemediationStatus
  | 'dry_run_started'
  | 'dry_run_passed'
  | 'dry_run_failed'
  | 'change_plan_created'
  | 'change_plan_approved'
  | 'change_plan_rejected'
  | 'execution_started'
  | 'execution_succeeded'
  | 'execution_failed'
  | 'verification_passed'
  | 'verification_failed'
  | 'rollback_succeeded'
  | 'rollback_failed'
  | 'post_change_monitor_scheduled'
  | 'post_change_monitor_started'
  | 'post_change_healthy'
  | 'post_change_regressed'
  | 'post_change_check_failed'
  | 'post_change_rollback_approved'
  | 'post_change_rollback_rejected'
  | 'post_change_rollback_started'
  | 'post_change_rollback_succeeded'
  | 'post_change_rollback_failed';

export interface IncidentRemediationEvent {
  id: number;
  type: IncidentRemediationEventType;
  actorUserId: number | null;
  actorUsername: string | null;
  comment: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface IncidentRemediationRecord {
  id: number;
  incidentId: number;
  taskLinkId: number;
  taskId: string;
  rootTraceId: string | null;
  sourceActionIndex: number;
  priority: 'now' | 'next' | 'later';
  action: string;
  rationale: string;
  requiresApproval: boolean;
  riskLevel: IncidentRemediationRisk;
  executionMode: 'proposal_only' | 'dry_run' | 'governed_write';
  executorBundleId: number | null;
  executorToolName: string | null;
  targetScope: Record<string, unknown> | null;
  executionIntent: IncidentAiopsExecutionIntent | null;
  status: IncidentRemediationStatus;
  version: number;
  createdBy: number | null;
  decidedBy: number | null;
  decidedByUsername: string | null;
  decisionComment: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: IncidentRemediationEvent[];
  dryRuns: IncidentRemediationDryRun[];
  changePlans: IncidentRemediationChangePlan[];
}

export interface IncidentRemediationStore {
  syncFromInvestigation(investigation: IncidentAiopsTaskRecord): Promise<number>;
  listForIncident(incidentId: number): Promise<IncidentRemediationRecord[]>;
  decide(input: {
    incidentId: number;
    remediationId: number;
    expectedVersion: number;
    decision: IncidentRemediationDecision;
    reviewer: { id: number; username: string };
    comment: string | null;
  }): Promise<IncidentRemediationRecord>;
}

export class IncidentRemediationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'IncidentRemediationError';
  }
}

type RemediationRow = {
  id: number | string;
  incident_id: number | string;
  task_link_id: number | string;
  task_id: string;
  root_trace_id: string | null;
  source_action_index: number;
  priority: 'now' | 'next' | 'later';
  action: string;
  rationale: string;
  requires_approval: boolean;
  risk_level: IncidentRemediationRisk;
  execution_mode: 'proposal_only' | 'dry_run' | 'governed_write';
  executor_bundle_id: number | string | null;
  executor_tool_name: string | null;
  target_scope: Record<string, unknown> | null;
  execution_intent: IncidentAiopsExecutionIntent | null;
  status: IncidentRemediationStatus;
  version: number;
  created_by: number | string | null;
  decided_by: number | string | null;
  decided_by_username: string | null;
  decision_comment: string | null;
  decided_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type EventRow = {
  id: number | string;
  remediation_id: number | string;
  event_type: IncidentRemediationEventType;
  actor_user_id: number | string | null;
  actor_username: string | null;
  comment: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
};

type DryRunRow = {
  id: number | string;
  remediation_id: number | string;
  bundle_id: number | string;
  tool_name: string;
  arguments: Record<string, string | number | boolean> | null;
  status: IncidentRemediationDryRun['status'];
  execution_trace_id: string;
  result_preview: string | null;
  error_message: string | null;
  redaction_summary: Record<string, number> | null;
  started_by: number | string | null;
  started_by_username: string;
  started_at: string | Date;
  completed_at: string | Date | null;
};

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function nullableIso(value: string | Date | null): string | null {
  return value == null ? null : iso(value);
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function riskFor(priority: 'now' | 'next' | 'later', quality: string | null): IncidentRemediationRisk {
  if (quality !== 'reviewed' || priority === 'now') return 'high';
  return priority === 'next' ? 'medium' : 'low';
}

function fingerprint(input: {
  taskId: string;
  index: number;
  priority: string;
  action: string;
  rationale: string;
  requiresApproval: boolean;
  executionIntent: IncidentAiopsExecutionIntent | null;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function eventFromRow(row: EventRow): IncidentRemediationEvent {
  return {
    id: Number(row.id),
    type: row.event_type,
    actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id),
    actorUsername: row.actor_username,
    comment: row.comment,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

function dryRunFromRow(row: DryRunRow): IncidentRemediationDryRun {
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
    completedAt: nullableIso(row.completed_at),
  };
}

function recordFromRow(
  row: RemediationRow,
  events: IncidentRemediationEvent[] = [],
  dryRuns: IncidentRemediationDryRun[] = [],
  changePlans: IncidentRemediationChangePlan[] = [],
): IncidentRemediationRecord {
  return {
    id: Number(row.id),
    incidentId: Number(row.incident_id),
    taskLinkId: Number(row.task_link_id),
    taskId: row.task_id,
    rootTraceId: row.root_trace_id,
    sourceActionIndex: Number(row.source_action_index),
    priority: row.priority,
    action: row.action,
    rationale: row.rationale,
    requiresApproval: row.requires_approval,
    riskLevel: row.risk_level,
    executionMode: row.execution_mode,
    executorBundleId: row.executor_bundle_id == null ? null : Number(row.executor_bundle_id),
    executorToolName: row.executor_tool_name,
    targetScope: row.target_scope,
    executionIntent: row.execution_intent,
    status: row.status,
    version: Number(row.version),
    createdBy: row.created_by == null ? null : Number(row.created_by),
    decidedBy: row.decided_by == null ? null : Number(row.decided_by),
    decidedByUsername: row.decided_by_username,
    decisionComment: row.decision_comment,
    decidedAt: nullableIso(row.decided_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    events,
    dryRuns,
    changePlans,
  };
}

const SELECT_REMEDIATIONS = `
  SELECT remediation.*, task.task_id, task.root_trace_id
    FROM mcp_observability_incident_remediations remediation
    JOIN mcp_observability_incident_aiops_tasks task ON task.id=remediation.task_link_id`;

export class PostgresIncidentRemediationStore implements IncidentRemediationStore {
  constructor(private readonly pool: pg.Pool) {}

  async syncFromInvestigation(investigation: IncidentAiopsTaskRecord): Promise<number> {
    const actions = investigation.result?.recommendedActions ?? [];
    if (actions.length === 0) return 0;
    const client = await this.pool.connect();
    let created = 0;
    try {
      await client.query('BEGIN');
      for (const [index, raw] of actions.slice(0, 6).entries()) {
        const action = boundedText(raw.action, 800);
        const rationale = boundedText(raw.rationale, 800);
        if (!action || !rationale) continue;
        const sourceFingerprint = fingerprint({
          taskId: investigation.taskId,
          index,
          priority: raw.priority,
          action,
          rationale,
          requiresApproval: raw.requiresApproval,
          executionIntent: raw.executionIntent ?? null,
        });
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO mcp_observability_incident_remediations
            (incident_id, task_link_id, source_action_index, source_fingerprint,
             priority, action, rationale, requires_approval, risk_level,
             execution_mode, target_scope, execution_intent, created_by)
           SELECT task.incident_id, task.id, $2, $3, $4, $5, $6, $7, $8,
                  'proposal_only', task.execution_resource_scope, $10::jsonb, task.created_by
             FROM mcp_observability_incident_aiops_tasks task
            WHERE task.id=$1 AND task.incident_id=$9
           ON CONFLICT (task_link_id, source_action_index) DO NOTHING
           RETURNING id`,
          [
            investigation.id,
            index,
            sourceFingerprint,
            raw.priority,
            action,
            rationale,
            raw.requiresApproval,
            riskFor(raw.priority, investigation.quality),
            investigation.incidentId,
            raw.executionIntent == null ? null : JSON.stringify(raw.executionIntent),
          ],
        );
        const remediationId = inserted.rows[0]?.id;
        if (!remediationId) continue;
        await client.query(
          `INSERT INTO mcp_observability_incident_remediation_events
            (remediation_id, event_type, actor_user_id, actor_username, comment, metadata)
           VALUES ($1,'proposed',$2,'argus.aiops','Created from a Core-normalized reviewer recommendation.',
                   $3::jsonb)`,
          [
            remediationId,
            investigation.createdBy,
            JSON.stringify({ taskId: investigation.taskId, rootTraceId: investigation.rootTraceId, quality: investigation.quality }),
          ],
        );
        created++;
      }
      await client.query('COMMIT');
      return created;
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
  }

  async listForIncident(incidentId: number): Promise<IncidentRemediationRecord[]> {
    const { rows } = await this.pool.query<RemediationRow>(
      `${SELECT_REMEDIATIONS}
        WHERE remediation.incident_id=$1
        ORDER BY CASE remediation.priority WHEN 'now' THEN 0 WHEN 'next' THEN 1 ELSE 2 END,
                 remediation.created_at, remediation.id`,
      [incidentId],
    );
    if (rows.length === 0) return [];
    const ids = rows.map(row => Number(row.id));
    const eventRows = await this.pool.query<EventRow>(
      `SELECT * FROM mcp_observability_incident_remediation_events
        WHERE remediation_id=ANY($1::bigint[])
        ORDER BY created_at, id`,
      [ids],
    );
    const byProposal = new Map<number, IncidentRemediationEvent[]>();
    for (const row of eventRows.rows) {
      const id = Number(row.remediation_id);
      byProposal.set(id, [...(byProposal.get(id) ?? []), eventFromRow(row)]);
    }
    const dryRunRows = await this.pool.query<DryRunRow>(
      `SELECT * FROM mcp_observability_incident_remediation_dry_runs
        WHERE remediation_id=ANY($1::bigint[])
        ORDER BY started_at DESC, id DESC`,
      [ids],
    );
    const dryRunsByProposal = new Map<number, IncidentRemediationDryRun[]>();
    for (const row of dryRunRows.rows) {
      const id = Number(row.remediation_id);
      dryRunsByProposal.set(id, [...(dryRunsByProposal.get(id) ?? []), dryRunFromRow(row)]);
    }
    const planRows = await this.pool.query<IncidentRemediationChangePlanRow>(
      `SELECT * FROM mcp_observability_incident_remediation_change_plans
        WHERE remediation_id=ANY($1::bigint[])
        ORDER BY created_at DESC, id DESC`,
      [ids],
    );
    const planIds = planRows.rows.map(row => Number(row.id));
    const monitorRows = planIds.length === 0
      ? { rows: [] as IncidentRemediationPostChangeMonitorRow[] }
      : await this.pool.query<IncidentRemediationPostChangeMonitorRow>(
        `SELECT * FROM mcp_observability_incident_remediation_post_change_monitors
          WHERE plan_id=ANY($1::bigint[])`,
        [planIds],
      );
    const monitorByPlan = new Map<number, IncidentRemediationPostChangeMonitor>();
    for (const row of monitorRows.rows) {
      monitorByPlan.set(Number(row.plan_id), incidentRemediationPostChangeMonitorFromRow(row));
    }
    const plansByProposal = new Map<number, IncidentRemediationChangePlan[]>();
    for (const row of planRows.rows) {
      const id = Number(row.remediation_id);
      plansByProposal.set(id, [
        ...(plansByProposal.get(id) ?? []),
        incidentRemediationChangePlanFromRow(row, monitorByPlan.get(Number(row.id)) ?? null),
      ]);
    }
    return rows.map(row => recordFromRow(
      row,
      byProposal.get(Number(row.id)) ?? [],
      dryRunsByProposal.get(Number(row.id)) ?? [],
      plansByProposal.get(Number(row.id)) ?? [],
    ));
  }

  async decide(input: {
    incidentId: number;
    remediationId: number;
    expectedVersion: number;
    decision: IncidentRemediationDecision;
    reviewer: { id: number; username: string };
    comment: string | null;
  }): Promise<IncidentRemediationRecord> {
    const username = boundedText(input.reviewer.username, 200);
    const comment = input.comment == null ? null : boundedText(input.comment, 2_000);
    if (!username) throw new IncidentRemediationError(400, 'invalid_reviewer', 'reviewer identity is required');
    if (input.decision === 'reject' && (!comment || comment.length < 8)) {
      throw new IncidentRemediationError(400, 'rejection_comment_required', 'rejection comment must contain at least 8 characters');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ status: IncidentRemediationStatus; version: number }>(
        `SELECT status, version
           FROM mcp_observability_incident_remediations
          WHERE id=$1 AND incident_id=$2
          FOR UPDATE`,
        [input.remediationId, input.incidentId],
      );
      const proposal = current.rows[0];
      if (!proposal) throw new IncidentRemediationError(404, 'remediation_not_found', 'remediation proposal was not found for this incident');
      if (proposal.status !== 'proposed') {
        throw new IncidentRemediationError(409, 'remediation_already_decided', `remediation proposal is already ${proposal.status}`);
      }
      if (Number(proposal.version) !== input.expectedVersion) {
        throw new IncidentRemediationError(409, 'remediation_version_conflict', 'remediation proposal changed; refresh before deciding');
      }
      const status: IncidentRemediationStatus = input.decision === 'approve' ? 'approved' : 'rejected';
      const updated = await client.query<RemediationRow>(
        `UPDATE mcp_observability_incident_remediations remediation
            SET status=$3, version=version + 1, decided_by=$4,
                decided_by_username=$5, decision_comment=$6,
                decided_at=now(), updated_at=now()
          WHERE remediation.id=$1 AND remediation.incident_id=$2
          RETURNING remediation.*,
            (SELECT task_id FROM mcp_observability_incident_aiops_tasks WHERE id=remediation.task_link_id) AS task_id,
            (SELECT root_trace_id FROM mcp_observability_incident_aiops_tasks WHERE id=remediation.task_link_id) AS root_trace_id`,
        [input.remediationId, input.incidentId, status, input.reviewer.id, username, comment],
      );
      await client.query(
        `INSERT INTO mcp_observability_incident_remediation_events
          (remediation_id, event_type, actor_user_id, actor_username, comment, metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [input.remediationId, status, input.reviewer.id, username, comment, JSON.stringify({ previousStatus: 'proposed', previousVersion: input.expectedVersion })],
      );
      await client.query('COMMIT');
      const events = (await this.pool.query<EventRow>(
        `SELECT * FROM mcp_observability_incident_remediation_events
          WHERE remediation_id=$1 ORDER BY created_at, id`,
        [input.remediationId],
      )).rows.map(eventFromRow);
      return recordFromRow(updated.rows[0]!, events);
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
  }
}
