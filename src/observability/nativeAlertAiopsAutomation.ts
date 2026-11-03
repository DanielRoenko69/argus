import type pg from 'pg';
import { A2aClientError, type A2aGateway, type A2aTask } from '../a2a/client.js';
import { logger } from '../lib/logger.js';
import type { ExecutionResourceScopeRequest } from '../solutionPacks/executionTargets.js';
import {
  incidentAiopsSnapshotFromTask,
  type IncidentAiopsTaskStore,
} from './incidentAiopsTasks.js';
import {
  incidentImpactLabels,
  PostgresIncidentImpactReader,
  type IncidentImpactReader,
} from './incidentImpact.js';
import {
  AiOpsServiceProfileInvestigationError,
  type AiOpsInvestigationPrincipal,
} from './aiopsServiceProfileInvestigations.js';
import type {
  AiOpsServiceProfileInvestigationSignal,
  AiOpsServiceProfileInvestigationStarted,
} from './aiopsServiceProfileContracts.js';

type Queryable = Pick<pg.Pool, 'query'>;

export type NativeAlertAiopsDispatchStatus =
  | 'pending'
  | 'dispatching'
  | 'started'
  | 'blocked'
  | 'failed'
  | 'skipped';

export interface NativeAlertAiopsDispatchRecord {
  id: number;
  incidentId: number;
  ruleId: number;
  status: NativeAlertAiopsDispatchStatus;
  bundleIds: number[];
  resourceScope: ExecutionResourceScopeRequest | null;
  service: string;
  environment: string;
  serviceProfile: { id: number; revision: number; sha256: string } | null;
  attemptCount: number;
  availableAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
  taskLinkId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeAlertAiopsAutomationReader {
  getForIncident(incidentId: number): Promise<NativeAlertAiopsDispatchRecord | null>;
}

type DispatchRow = {
  id: number | string;
  incident_id: number | string;
  rule_id: number | string;
  status: NativeAlertAiopsDispatchStatus;
  bundle_ids: number[];
  resource_scope: unknown;
  service: string;
  environment: string;
  service_profile_id: number | string | null;
  service_profile_revision: number | string | null;
  service_profile_sha256: string | null;
  attempt_count: number;
  available_at: string | Date;
  last_attempt_at: string | Date | null;
  last_error: string | null;
  task_link_id: number | string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type ClaimedDispatchRow = DispatchRow & {
  incident_state: 'firing' | 'recovered';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  triggered_at: string | Date;
  rule_name: string;
  rule_auto_enabled: boolean;
  rule_enabled: boolean;
  rule_archived: boolean;
  window_minutes: number;
  rule_source_kind: 'native' | 'provider';
  provider: string | null;
  provider_monitor_ref: string | null;
  provider_fingerprint: string | null;
  correlation_group_id: number | string | null;
  correlation_key: string | null;
  correlation_signal_count: number | string | null;
  correlation_window_minutes: number | string | null;
};

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function resourceScope(value: unknown): ExecutionResourceScopeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('stored AIOps resource scope is invalid');
  const scope = value as Record<string, unknown>;
  if (scope['kind'] !== 'kubernetes'
    || !Number.isSafeInteger(scope['backendId']) || Number(scope['backendId']) <= 0
    || typeof scope['targetId'] !== 'string'
    || typeof scope['namespace'] !== 'string') {
    throw new Error('stored AIOps resource scope is invalid');
  }
  return {
    kind: 'kubernetes',
    backendId: Number(scope['backendId']),
    targetId: scope['targetId'],
    namespace: scope['namespace'],
  };
}

function optionalResourceScope(value: unknown): ExecutionResourceScopeRequest | null {
  return value == null ? null : resourceScope(value);
}

function mapDispatch(row: DispatchRow): NativeAlertAiopsDispatchRecord {
  return {
    id: Number(row.id),
    incidentId: Number(row.incident_id),
    ruleId: Number(row.rule_id),
    status: row.status,
    bundleIds: row.bundle_ids ?? [],
    resourceScope: optionalResourceScope(row.resource_scope),
    service: row.service,
    environment: row.environment,
    serviceProfile: row.service_profile_id == null ? null : {
      id: Number(row.service_profile_id),
      revision: Number(row.service_profile_revision),
      sha256: row.service_profile_sha256!,
    },
    attemptCount: Number(row.attempt_count),
    availableAt: iso(row.available_at),
    lastAttemptAt: row.last_attempt_at ? iso(row.last_attempt_at) : null,
    lastError: row.last_error,
    taskLinkId: row.task_link_id == null ? null : Number(row.task_link_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function boundedError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 1000) || 'AIOps dispatch failed';
}

function correlationLabels(row: ClaimedDispatchRow): Record<string, string> {
  if (row.correlation_group_id == null) return {};
  return {
    'argus.core.correlation.schema': '1',
    'argus.core.correlation.group_id': String(row.correlation_group_id),
    'argus.core.correlation.key': row.correlation_key ?? '',
    'argus.core.correlation.signal_count': String(row.correlation_signal_count ?? 1),
    'argus.core.correlation.window_minutes': String(row.correlation_window_minutes ?? row.window_minutes),
    'argus.core.correlation.primary_incident_id': String(row.incident_id),
  };
}

export class NativeAlertAiopsDispatcher {
  private running = false;

  constructor(
    private readonly pool: Queryable,
    private readonly a2a: A2aGateway,
    private readonly tasks: IncidentAiopsTaskStore,
    private readonly maxConcurrent = Math.max(1, Math.min(20, Number(process.env['NATIVE_ALERT_AIOPS_MAX_CONCURRENT'] ?? 3))),
    private readonly impactReader: IncidentImpactReader = new PostgresIncidentImpactReader(pool),
    private readonly startProfileInvestigation?: (
      profileId: number,
      signal: AiOpsServiceProfileInvestigationSignal,
      principal: AiOpsInvestigationPrincipal,
      expectedActiveProfile: { revision: number; sha256: string },
    ) => Promise<AiOpsServiceProfileInvestigationStarted>,
  ) {}

  async getForIncident(incidentId: number): Promise<NativeAlertAiopsDispatchRecord | null> {
    const { rows } = await this.pool.query<DispatchRow>(
      `SELECT dispatch.*
         FROM mcp_observability_incident_aiops_dispatches dispatch
        WHERE dispatch.incident_id=COALESCE((
          SELECT alert_group.primary_incident_id
            FROM mcp_observability_alert_incident_group_members membership
            JOIN mcp_observability_alert_incident_groups alert_group ON alert_group.id=membership.group_id
           WHERE membership.incident_id=$1
        ), $1)
        ORDER BY dispatch.id DESC
        LIMIT 1`,
      [incidentId],
    );
    return rows[0] ? mapDispatch(rows[0]) : null;
  }

  private async enqueueEligible(): Promise<number> {
    const result = await this.pool.query(
      `WITH profile_matches AS (
         SELECT incident.id AS incident_id, rule.id AS rule_id,
                profile.id AS service_profile_id,
                revision.revision AS service_profile_revision,
                revision.profile_sha256::text AS service_profile_sha256,
                revision.profile_json,
                incident.triggered_at,
                count(*) OVER (PARTITION BY incident.id) AS profile_match_count
           FROM mcp_observability_alert_incidents incident
           JOIN mcp_observability_alert_rules rule ON rule.id=incident.rule_id
           LEFT JOIN mcp_observability_alert_incident_group_members correlation_member
             ON correlation_member.incident_id=incident.id
           LEFT JOIN mcp_observability_alert_incident_groups correlation_group
             ON correlation_group.id=correlation_member.group_id
           JOIN mcp_observability_aiops_service_profiles profile
             ON profile.status='active'
            AND profile.workspace_key='default'
            AND profile.tenant_key='default'
           JOIN mcp_observability_aiops_service_profile_revisions revision
             ON revision.profile_id=profile.id
            AND revision.revision=profile.active_revision
          WHERE COALESCE(correlation_group.state, incident.state)='firing'
            AND (correlation_member.incident_id IS NULL OR correlation_member.role='primary')
            AND rule.archived_at IS NULL
            AND rule.enabled
            AND COALESCE((revision.profile_json #>> '{detection,autoInvestigate}')::boolean, false)
            AND (
              EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(
                    COALESCE(revision.profile_json #> '{detection,nativeAlertRuleIds}', '[]'::jsonb)
                  ) alert_rule_id
                 WHERE alert_rule_id::bigint=rule.id
              )
              OR (
                rule.source_kind='provider'
                AND rule.provider_service_profile_id=profile.id
                AND rule.provider_service_profile_revision=revision.revision
                AND rule.provider_service_profile_sha256=revision.profile_sha256
                AND EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements_text(
                      COALESCE(revision.profile_json #> '{detection,providerMonitorRefs}', '[]'::jsonb)
                    ) monitor_ref
                   WHERE monitor_ref.value=rule.provider_monitor_ref
                      OR monitor_ref.value=rule.provider || ':' || rule.provider_monitor_ref
                )
              )
            )
       ), unique_profile_matches AS (
         SELECT matched.*,
                row_number() OVER (
                  PARTITION BY matched.service_profile_id
                  ORDER BY EXISTS (
                    SELECT 1 FROM mcp_observability_incident_aiops_dispatches queued
                     WHERE queued.incident_id=matched.incident_id
                  ), matched.triggered_at, matched.incident_id
                ) AS profile_queue_rank
           FROM profile_matches matched
          WHERE matched.profile_match_count=1
       ), candidates AS (
         SELECT matched.incident_id, matched.rule_id,
                ARRAY(
                  SELECT DISTINCT (lane->>'bundleId')::bigint
                    FROM jsonb_array_elements(matched.profile_json #> '{evidencePolicy,lanes}') lane
                   WHERE lane->>'requirement' <> 'disabled'
                   ORDER BY (lane->>'bundleId')::bigint
                ) AS bundle_ids,
                matched.profile_json #> '{selectors,runtime}' AS resource_scope,
                matched.profile_json #>> '{service,serviceName}' AS service,
                matched.profile_json #>> '{service,environment}' AS environment,
                matched.service_profile_id, matched.service_profile_revision,
                matched.service_profile_sha256,
                GREATEST(
                  now(),
                  COALESCE((
                    SELECT max(GREATEST(
                      previous.created_at,
                      previous.available_at,
                      COALESCE(previous.last_attempt_at, previous.created_at)
                    )) + make_interval(
                      mins => GREATEST(1, LEAST(10080, (matched.profile_json #>> '{detection,cooldownMinutes}')::int))
                    )
                      FROM mcp_observability_incident_aiops_dispatches previous
                     WHERE previous.service_profile_id=matched.service_profile_id
                       AND previous.status IN ('pending', 'dispatching', 'started')
                  ), now())
                ) AS available_at
           FROM unique_profile_matches matched
          WHERE matched.profile_queue_rank=1
         UNION ALL
         SELECT incident.id, rule.id, rule.aiops_bundle_ids, rule.aiops_resource_scope,
                rule.aiops_service, rule.aiops_environment, NULL, NULL, NULL, now()
           FROM mcp_observability_alert_incidents incident
           JOIN mcp_observability_alert_rules rule ON rule.id=incident.rule_id
           LEFT JOIN mcp_observability_alert_incident_group_members correlation_member
             ON correlation_member.incident_id=incident.id
           LEFT JOIN mcp_observability_alert_incident_groups correlation_group
             ON correlation_group.id=correlation_member.group_id
          WHERE COALESCE(correlation_group.state, incident.state)='firing'
            AND (correlation_member.incident_id IS NULL OR correlation_member.role='primary')
            AND rule.archived_at IS NULL
            AND rule.enabled
            AND rule.aiops_auto_investigate
            AND cardinality(rule.aiops_bundle_ids) > 0
            AND rule.aiops_resource_scope IS NOT NULL
            AND rule.aiops_service IS NOT NULL
            AND rule.aiops_environment IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM profile_matches matched WHERE matched.incident_id=incident.id)
       )
       INSERT INTO mcp_observability_incident_aiops_dispatches
         (incident_id, rule_id, bundle_ids, resource_scope, service, environment,
          service_profile_id, service_profile_revision, service_profile_sha256, available_at)
       SELECT incident_id, rule_id, bundle_ids, resource_scope, service, environment,
              service_profile_id, service_profile_revision, service_profile_sha256, available_at
         FROM candidates
        WHERE cardinality(bundle_ids) > 0
       ON CONFLICT (incident_id) DO NOTHING`,
    );
    return result.rowCount ?? 0;
  }

  private async refreshActiveTasks(): Promise<number> {
    const active = await this.tasks.listActive(100);
    await Promise.all(active.map(async record => {
      try {
        const task = await this.a2a.getTask(record.packId, record.agentId, record.taskId);
        await this.tasks.update(record.id, incidentAiopsSnapshotFromTask(task, record.rootTraceId));
      } catch (error) {
        logger.debug({ err: error, taskId: record.taskId }, 'AIOps automation task refresh deferred');
      }
    }));
    return (await this.tasks.listActive(100)).length;
  }

  private async claimNext(): Promise<ClaimedDispatchRow | null> {
    const { rows } = await this.pool.query<ClaimedDispatchRow>(
      `WITH candidate AS (
         SELECT dispatch.id
           FROM mcp_observability_incident_aiops_dispatches dispatch
          WHERE ((
              dispatch.status='pending' AND dispatch.available_at <= now()
            ) OR (
              dispatch.status='dispatching' AND dispatch.updated_at < now() - interval '5 minutes'
            ))
          AND dispatch.attempt_count < 3
          ORDER BY dispatch.available_at, dispatch.id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       ), claimed AS (
         UPDATE mcp_observability_incident_aiops_dispatches dispatch
            SET status='dispatching', attempt_count=dispatch.attempt_count+1,
                last_attempt_at=now(), last_error=NULL, updated_at=now()
           FROM candidate
          WHERE dispatch.id=candidate.id
          RETURNING dispatch.*
       )
       SELECT claimed.*, COALESCE(correlation_group.state, incident.state) AS incident_state, incident.severity,
              incident.message, incident.triggered_at, rule.name AS rule_name,
              rule.aiops_auto_investigate AS rule_auto_enabled, rule.enabled AS rule_enabled,
              rule.archived_at IS NOT NULL AS rule_archived, rule.window_minutes,
              rule.source_kind AS rule_source_kind, rule.provider,
              rule.provider_monitor_ref, rule.provider_fingerprint,
              correlation_group.id AS correlation_group_id,
              correlation_group.correlation_key,
              correlation_group.signal_count AS correlation_signal_count,
              correlation_group.correlation_window_minutes
         FROM claimed
         JOIN mcp_observability_alert_incidents incident ON incident.id=claimed.incident_id
         JOIN mcp_observability_alert_rules rule ON rule.id=claimed.rule_id
         LEFT JOIN mcp_observability_alert_incident_group_members correlation_member
           ON correlation_member.incident_id=incident.id
         LEFT JOIN mcp_observability_alert_incident_groups correlation_group
           ON correlation_group.id=correlation_member.group_id`,
    );
    return rows[0] ?? null;
  }

  private async mark(
    id: number,
    status: NativeAlertAiopsDispatchStatus,
    input: { error?: string | null; taskLinkId?: number | null; retryMinutes?: number } = {},
  ): Promise<void> {
    await this.pool.query(
      `UPDATE mcp_observability_incident_aiops_dispatches
          SET status=$2, last_error=$3, task_link_id=COALESCE($4, task_link_id),
              available_at=CASE WHEN $5::int IS NULL THEN available_at ELSE now()+($5::text || ' minutes')::interval END,
              updated_at=now()
        WHERE id=$1`,
      [id, status, input.error ?? null, input.taskLinkId ?? null, input.retryMinutes ?? null],
    );
  }

  private async dispatch(row: ClaimedDispatchRow): Promise<'started' | 'blocked' | 'failed' | 'skipped'> {
    const id = Number(row.id);
    const incidentId = Number(row.incident_id);
    const profileBacked = row.service_profile_id != null;
    const automationEnabled = profileBacked ? row.rule_enabled && !row.rule_archived : row.rule_auto_enabled;
    if (!automationEnabled || row.incident_state !== 'firing') {
      await this.mark(id, 'skipped', { error: automationEnabled ? 'Incident recovered before dispatch' : 'Automation disabled before dispatch' });
      return 'skipped';
    }
    const existing = await this.tasks.list(incidentId, 1);
    if (existing.length > 0) {
      await this.mark(id, 'skipped', { error: 'Incident already has an AIOps investigation', taskLinkId: existing[0]!.id });
      return 'skipped';
    }
    try {
      const bundleIds = [...new Set((row.bundle_ids ?? []).map(Number).filter(value => Number.isSafeInteger(value) && value > 0))];
      if (bundleIds.length === 0) throw new A2aClientError(409, 'bundle_required', 'AIOps automation has no valid MCP bundle');
      let impactLabels: Record<string, string>;
      try {
        impactLabels = incidentImpactLabels(await this.impactReader.getForIncident(incidentId));
      } catch (error) {
        impactLabels = incidentImpactLabels(null);
        logger.warn({ incidentId, err: boundedError(error) }, 'Native alert impact enrichment unavailable');
      }
      if (profileBacked) {
        if (!this.startProfileInvestigation) {
          throw new AiOpsServiceProfileInvestigationError(503, 'pack_contract_missing', 'Profile-backed native alert dispatch is not configured');
        }
        const expectedActiveProfile = {
          revision: Number(row.service_profile_revision),
          sha256: row.service_profile_sha256!,
        };
        const result = await this.startProfileInvestigation(
          Number(row.service_profile_id),
          {
            title: row.rule_name,
            summary: row.message,
            severity: row.severity,
            startedAt: iso(row.triggered_at),
            alertSource: row.rule_source_kind === 'provider'
              ? `${row.provider ?? 'external'} monitor ${row.provider_monitor_ref ?? row.rule_id} via Argus incident #${incidentId}`
              : `Argus native alert #${incidentId} (automatic)`,
            sourceIncidentId: incidentId,
            labels: {
              ...impactLabels,
              ...correlationLabels(row),
              ...(row.rule_source_kind === 'provider' ? {
                'argus.core.alert.source': 'provider',
                'argus.core.alert.provider': row.provider ?? 'external',
                'argus.core.alert.monitor_ref': row.provider_monitor_ref ?? '',
                'argus.core.alert.fingerprint': row.provider_fingerprint ?? '',
              } : { 'argus.core.alert.source': 'native' }),
            },
          },
          {
            kind: 'service',
            id: row.rule_source_kind === 'provider'
              ? `provider-alert:${row.provider ?? 'external'}:${row.rule_id}`
              : `native-alert-rule:${row.rule_id}`,
            allowedBundleIds: bundleIds,
          },
          expectedActiveProfile,
        );
        const task = result.task as A2aTask;
        const link = await this.tasks.create({
          incidentId,
          packId: 'argus.aiops',
          agentId: 'incident-orchestrator',
          taskId: task.id,
          createdBy: null,
          snapshot: incidentAiopsSnapshotFromTask(task, result.rootTraceId),
          executionContext: {
            ...result.execution,
            serviceProfile: result.profile,
            trigger: { kind: 'native-alert', ref: String(incidentId) },
          },
        });
        await this.mark(id, 'started', { taskLinkId: link.id });
        logger.info({ incidentId, profileId: result.profile.id, taskId: task.id, rootTraceId: result.rootTraceId }, 'Profile-backed native alert AIOps investigation started');
        return 'started';
      }
      const scope = resourceScope(row.resource_scope);
      const result = await this.a2a.sendMessage(
        'argus.aiops',
        'incident-orchestrator',
        {
          text: `Automatically investigate native alert incident ${incidentId}.`,
          data: {
            operation: 'workflow.start',
            workflowId: 'incident-investigation',
            input: {
              title: row.rule_name,
              summary: row.message,
              severity: row.severity,
              service: row.service,
              environment: row.environment,
              started_at: iso(row.triggered_at),
              alert_source: `Argus native alert #${incidentId} (automatic)`,
              correlation_window_minutes: Math.max(5, Math.min(360, Number(row.window_minutes))),
              labels: { ...impactLabels, ...correlationLabels(row) },
            },
          },
        },
        {
          principalKind: 'service',
          principalId: `native-alert-rule:${row.rule_id}`,
          principalAllowedBundleIds: bundleIds,
          requestedBundleIds: bundleIds,
          requestedResourceScope: scope,
        },
      );
      const link = await this.tasks.create({
        incidentId,
        packId: 'argus.aiops',
        agentId: 'incident-orchestrator',
        taskId: result.task.id,
        createdBy: null,
        snapshot: incidentAiopsSnapshotFromTask(result.task, result.rootTraceId),
        executionContext: {
          bundleIds,
          resourceScope: scope,
          service: row.service,
          environment: row.environment,
          trigger: { kind: 'native-alert', ref: String(incidentId) },
        },
      });
      await this.mark(id, 'started', { taskLinkId: link.id });
      logger.info({ incidentId, taskId: result.task.id, rootTraceId: result.rootTraceId }, 'Native alert AIOps investigation started');
      return 'started';
    } catch (error) {
      const message = boundedError(error);
      const permanent = error instanceof AiOpsServiceProfileInvestigationError
        ? error.status === 400 || error.status === 409
        : error instanceof A2aClientError && (
          [400, 403, 404].includes(error.status)
          || error.status === 409 && error.code !== 'pack_not_ready'
        );
      if (permanent) {
        await this.mark(id, 'blocked', { error: message });
        logger.warn({ incidentId, err: message }, 'Native alert AIOps investigation blocked');
        return 'blocked';
      }
      const exhausted = Number(row.attempt_count) >= 3;
      await this.mark(id, exhausted ? 'failed' : 'pending', {
        error: message,
        ...(exhausted ? {} : { retryMinutes: Math.min(15, 2 ** Number(row.attempt_count)) }),
      });
      logger.warn({ incidentId, err: message, exhausted }, 'Native alert AIOps investigation dispatch failed');
      return 'failed';
    }
  }

  async dispatchOnce(): Promise<{ queued: number; started: number; blocked: number; failed: number; skipped: number; active: number }> {
    if (this.running) return { queued: 0, started: 0, blocked: 0, failed: 0, skipped: 0, active: 0 };
    this.running = true;
    try {
      const queued = await this.enqueueEligible();
      const active = await this.refreshActiveTasks();
      const capacity = Math.max(0, this.maxConcurrent - active);
      const result = { queued, started: 0, blocked: 0, failed: 0, skipped: 0, active };
      for (let index = 0; index < capacity; index++) {
        const row = await this.claimNext();
        if (!row) break;
        const status = await this.dispatch(row);
        result[status]++;
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
