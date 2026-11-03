import type pg from 'pg';
import { AIOPS_EVIDENCE_LANES } from './aiopsServiceProfileContracts.js';
import { sanitizeAiOpsProviderEvidenceUrl } from './aiopsProviderSignals.js';

type Queryable = Pick<pg.Pool, 'query'>;

type IncidentEntityRow = {
  actionable_key: string;
  service: string;
  environment: string;
  state: 'firing' | 'recovered';
  severity: 'info' | 'warning' | 'critical';
  signal_count: number | string;
  native_signal_count: number | string;
  provider_signal_count: number | string;
  first_triggered_at: Date | string;
  recovered_at: Date | string | null;
  correlation_group_id: number | string | null;
  incident_ids: Array<number | string>;
};

type InvestigationRow = {
  actionable_key: string;
  state: string;
  quality: string | null;
  conclusion: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  first_triggered_at: Date | string;
};

type DispatchRow = {
  actionable_key: string;
  status: string;
};

type RemediationRow = {
  actionable_key: string;
  remediation_id: number | string;
  remediation_status: string;
  plan_id: number | string | null;
  plan_status: string | null;
  monitor_status: string | null;
};

type ProviderDeliveryRow = {
  total: number | string;
};

type DependencyOutcomeRow = {
  environment: string;
  source_service: string;
  target_kind: 'service' | 'database' | 'messaging' | 'external';
  target_name: string;
  relation: 'calls' | 'queries' | 'publishes';
  calls: number | string;
  failures: number | string;
  p95_duration_ms: number | string | null;
  last_seen_at: Date | string;
};

type ProviderLinkRow = {
  incident_id: number | string;
  provider: string;
  monitor_ref: string;
  service: string;
  environment: string;
  evidence_url: string | null;
  occurred_at: Date | string;
};

type ProfileAttributionRow = {
  task_id: number | string;
  service_profile_id: number | string;
  service_profile_revision: number | string;
  service_profile_sha256: string;
  service: string;
  environment: string;
  display_name: string;
  state: string;
  quality: string | null;
  result_json: unknown;
  profile_json: unknown;
  telemetry_trace_count: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  recorded_cost_usd: number | string;
  feedback_reviews: number | string;
  feedback_helpful: number | string;
  feedback_partial: number | string;
  feedback_incorrect: number | string;
};

type AiopsEvidenceLane = typeof AIOPS_EVIDENCE_LANES[number];
type AiopsEvidenceRequirement = 'required' | 'optional';

export interface AiopsOutcomeProviderLink {
  provider: string;
  monitorRef: string;
  incidentId: number;
  observedAt: string;
  incidentHref: string;
  externalHref: string | null;
}

export interface AiopsOutcomeGraphNode {
  id: string;
  kind: 'service' | 'database' | 'messaging' | 'external';
  label: string;
  environment: string;
  incidents: number;
  signals: number;
  firing: number;
  incidentIds: number[];
  providerLinks: AiopsOutcomeProviderLink[];
}

export interface AiopsOutcomeGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: 'calls' | 'queries' | 'publishes';
  calls: number;
  failures: number;
  failureRate: number;
  p95DurationMs: number | null;
  lastSeenAt: string;
  evidence: 'observed' | 'causal_candidate';
  confidence: 'high' | 'medium' | 'low' | null;
}

export interface AiopsOutcomeProfileAttribution {
  profile: {
    id: number;
    revision: number;
    sha256: string;
    displayName: string;
    service: string;
    environment: string;
  };
  investigations: number;
  completedInvestigations: number;
  evidence: {
    assessedInvestigations: number;
    investigationsMeetingPolicy: number;
    policyCoveragePercent: number;
    minimumCollectedLanes: number;
    configuredLanes: number;
    requiredLanes: number;
    optionalLanes: number;
    lanes: Array<{
      lane: AiopsEvidenceLane;
      requirement: AiopsEvidenceRequirement;
      investigationsWithEvidence: number;
      coveragePercent: number;
      claims: number;
    }>;
  };
  usage: {
    telemetryLinkedInvestigations: number;
    tokenAttributedInvestigations: number;
    costAttributedInvestigations: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    recordedCostUsd: number;
    averageTokensPerInvestigation: number;
    averageRecordedCostUsdPerInvestigation: number;
  };
  feedback: {
    reviewedInvestigations: number;
    reviews: number;
    helpful: number;
    partial: number;
    incorrect: number;
    helpfulPercent: number;
  };
}

export interface AiopsOutcomeResponse {
  schemaVersion: 1;
  generatedAt: string;
  window: { days: number; from: string; to: string };
  signals: {
    total: number;
    native: number;
    provider: number;
    providerDeliveries: number;
  };
  incidents: {
    actionable: number;
    firing: number;
    recovered: number;
    correlated: number;
    standalone: number;
    suppressedSignals: number;
    compressionRatio: number;
    medianRecoveryMs: number | null;
    p95RecoveryMs: number | null;
  };
  investigations: {
    started: number;
    completed: number;
    partial: number;
    failed: number;
    blocked: number;
    active: number;
    coveragePercent: number;
    completionRatePercent: number;
    medianTimeToStartMs: number | null;
    medianTimeToCompleteMs: number | null;
  };
  rootCause: {
    confirmed: number;
    suspected: number;
    refuted: number;
    inconclusive: number;
  };
  remediations: {
    proposed: number;
    approved: number;
    awaitingApproval: number;
    executed: number;
    verified: number;
    failed: number;
    rolledBack: number;
    successRatePercent: number;
    postChangeHealthy: number;
    postChangeRegressed: number;
  };
  recurrence: {
    servicesWithRepeatIncidents: number;
    repeatIncidents: number;
  };
  topServices: Array<{
    service: string;
    environment: string;
    incidents: number;
    signals: number;
    firing: number;
    recovered: number;
    medianRecoveryMs: number | null;
  }>;
  profileAttribution: {
    profileBoundInvestigations: number;
    telemetryLinkedInvestigations: number;
    totalTokens: number;
    recordedCostUsd: number;
    reviewedInvestigations: number;
    reviews: number;
    helpful: number;
    partial: number;
    incorrect: number;
    helpfulPercent: number;
    truncated: boolean;
    profiles: AiopsOutcomeProfileAttribution[];
  };
  graph: {
    nodes: AiopsOutcomeGraphNode[];
    edges: AiopsOutcomeGraphEdge[];
    truncated: { nodes: boolean; edges: boolean };
  };
}

function boundedDays(value: number): number {
  if (!Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(90, Math.trunc(value)));
}

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round(sorted[index]!);
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100) / 100;
}

const COMPLETED_STATES = new Set(['TASK_STATE_COMPLETED', 'COMPLETED']);
const FAILED_STATES = new Set(['TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED', 'FAILED', 'CANCELED', 'REJECTED']);
const MAX_GRAPH_NODES = 32;
const MAX_GRAPH_EDGES = 80;
const MAX_PROFILE_ATTRIBUTION_TASKS = 1_000;
const EVIDENCE_LANES = new Set<string>(AIOPS_EVIDENCE_LANES);

function graphIdentity(kind: AiopsOutcomeGraphNode['kind'], environment: string, label: string): string {
  return `${kind}:${environment.trim().toLocaleLowerCase('en-US')}:${label.trim().toLocaleLowerCase('en-US')}`;
}

function graphConfidence(failures: number, calls: number): 'high' | 'medium' | 'low' | null {
  if (failures <= 0) return null;
  const failureRate = calls > 0 ? failures / calls : 0;
  if (failureRate >= 0.5 || failures >= 10) return 'high';
  if (failureRate >= 0.25 || failures >= 3) return 'medium';
  return 'low';
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function configuredEvidencePolicy(profileJson: unknown): {
  minimumCollectedLanes: number;
  lanes: Array<{ lane: AiopsEvidenceLane; requirement: AiopsEvidenceRequirement }>;
} {
  const profile = object(profileJson);
  const policy = object(profile?.['evidencePolicy']);
  const rawLanes = Array.isArray(policy?.['lanes']) ? policy['lanes'] : [];
  const lanes = rawLanes.flatMap(value => {
    const lane = object(value);
    const laneName = lane?.['lane'];
    const requirement = lane?.['requirement'];
    if (!EVIDENCE_LANES.has(String(laneName)) || !['required', 'optional'].includes(String(requirement))) return [];
    return [{ lane: laneName as AiopsEvidenceLane, requirement: requirement as AiopsEvidenceRequirement }];
  });
  const unique = [...new Map(lanes.map(lane => [lane.lane, lane])).values()];
  const requestedMinimum = Number(policy?.['minimumCollectedLanes']);
  const minimumCollectedLanes = Number.isSafeInteger(requestedMinimum)
    ? Math.max(1, Math.min(unique.length || 1, requestedMinimum))
    : Math.max(1, unique.filter(lane => lane.requirement === 'required').length);
  return { minimumCollectedLanes, lanes: unique };
}

function collectedEvidence(resultJson: unknown): { lanes: Set<AiopsEvidenceLane>; claims: Map<AiopsEvidenceLane, number> } | null {
  const result = object(resultJson);
  if (!result || !Array.isArray(result['evidence'])) return null;
  const lanes = new Set<AiopsEvidenceLane>(['incident']);
  const claims = new Map<AiopsEvidenceLane, number>([['incident', 1]]);
  for (const value of result['evidence'].slice(0, 100)) {
    const evidence = object(value);
    const lane = evidence?.['lane'];
    if (!EVIDENCE_LANES.has(String(lane))) continue;
    const typedLane = lane as AiopsEvidenceLane;
    lanes.add(typedLane);
    claims.set(typedLane, (claims.get(typedLane) ?? 0) + 1);
  }
  return { lanes, claims };
}

function money(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export async function getAiopsOutcomes(pool: Queryable, requestedDays = 30): Promise<AiopsOutcomeResponse> {
  const days = boundedDays(requestedDays);
  const now = new Date();
  const from = new Date(now.getTime() - days * 86_400_000);
  const params = [days];

  const [incidentResult, investigationResult, dispatchResult, remediationResult, providerDeliveryResult, dependencyResult, providerLinkResult, profileAttributionResult] = await Promise.all([
    pool.query<IncidentEntityRow>(
      `WITH window_signals AS (
         SELECT incident.id, incident.state, incident.severity, incident.triggered_at, incident.recovered_at,
                rule.source_kind, rule.aiops_service, rule.aiops_environment,
                membership.group_id, alert_group.service AS group_service,
                alert_group.environment AS group_environment,
                alert_group.first_triggered_at AS group_first_triggered_at,
                alert_group.recovered_at AS group_recovered_at
           FROM mcp_observability_alert_incidents incident
           JOIN mcp_observability_alert_rules rule ON rule.id=incident.rule_id
           LEFT JOIN mcp_observability_alert_incident_group_members membership ON membership.incident_id=incident.id
           LEFT JOIN mcp_observability_alert_incident_groups alert_group ON alert_group.id=membership.group_id
          WHERE incident.triggered_at >= now() - make_interval(days => $1::int)
       )
       SELECT CASE WHEN group_id IS NULL THEN 'incident:' || id::text ELSE 'group:' || group_id::text END AS actionable_key,
              COALESCE(max(group_service), max(aiops_service), 'unassigned') AS service,
              COALESCE(max(group_environment), max(aiops_environment), 'unknown') AS environment,
              CASE WHEN bool_or(state='firing') THEN 'firing' ELSE 'recovered' END AS state,
              CASE max(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)
                WHEN 3 THEN 'critical' WHEN 2 THEN 'warning' ELSE 'info' END AS severity,
              count(*) AS signal_count,
              count(*) FILTER (WHERE source_kind='native') AS native_signal_count,
              count(*) FILTER (WHERE source_kind='provider') AS provider_signal_count,
              min(COALESCE(group_first_triggered_at, triggered_at)) AS first_triggered_at,
              CASE WHEN bool_or(state='firing') THEN NULL ELSE max(COALESCE(group_recovered_at, recovered_at)) END AS recovered_at,
              max(group_id) AS correlation_group_id,
              array_agg(id ORDER BY id) AS incident_ids
         FROM window_signals
        GROUP BY CASE WHEN group_id IS NULL THEN 'incident:' || id::text ELSE 'group:' || group_id::text END`,
      params,
    ),
    pool.query<InvestigationRow>(
      `SELECT DISTINCT ON (CASE WHEN membership.group_id IS NULL THEN 'incident:' || incident.id::text ELSE 'group:' || membership.group_id::text END)
              CASE WHEN membership.group_id IS NULL THEN 'incident:' || incident.id::text ELSE 'group:' || membership.group_id::text END AS actionable_key,
              task.state, task.quality, task.result_json->>'conclusion' AS conclusion,
              task.created_at, task.updated_at,
              COALESCE(alert_group.first_triggered_at, incident.triggered_at) AS first_triggered_at
         FROM mcp_observability_incident_aiops_tasks task
         JOIN mcp_observability_alert_incidents incident ON incident.id=task.incident_id
         LEFT JOIN mcp_observability_alert_incident_group_members membership ON membership.incident_id=incident.id
         LEFT JOIN mcp_observability_alert_incident_groups alert_group ON alert_group.id=membership.group_id
        WHERE incident.triggered_at >= now() - make_interval(days => $1::int)
        ORDER BY CASE WHEN membership.group_id IS NULL THEN 'incident:' || incident.id::text ELSE 'group:' || membership.group_id::text END,
                 task.updated_at DESC, task.id DESC`,
      params,
    ),
    pool.query<DispatchRow>(
      `SELECT DISTINCT ON (CASE WHEN membership.group_id IS NULL THEN 'incident:' || incident.id::text ELSE 'group:' || membership.group_id::text END)
              CASE WHEN membership.group_id IS NULL THEN 'incident:' || incident.id::text ELSE 'group:' || membership.group_id::text END AS actionable_key,
              dispatch.status
         FROM mcp_observability_incident_aiops_dispatches dispatch
         JOIN mcp_observability_alert_incidents incident ON incident.id=dispatch.incident_id
         LEFT JOIN mcp_observability_alert_incident_group_members membership ON membership.incident_id=incident.id
        WHERE incident.triggered_at >= now() - make_interval(days => $1::int)
        ORDER BY CASE WHEN membership.group_id IS NULL THEN 'incident:' || incident.id::text ELSE 'group:' || membership.group_id::text END,
                 dispatch.updated_at DESC, dispatch.id DESC`,
      params,
    ),
    pool.query<RemediationRow>(
      `SELECT CASE WHEN membership.group_id IS NULL THEN 'incident:' || incident.id::text ELSE 'group:' || membership.group_id::text END AS actionable_key,
              remediation.id AS remediation_id, remediation.status AS remediation_status,
              plan.id AS plan_id, plan.status AS plan_status, monitor.status AS monitor_status
         FROM mcp_observability_incident_remediations remediation
         JOIN mcp_observability_alert_incidents incident ON incident.id=remediation.incident_id
         LEFT JOIN mcp_observability_alert_incident_group_members membership ON membership.incident_id=incident.id
         LEFT JOIN mcp_observability_incident_remediation_change_plans plan ON plan.remediation_id=remediation.id
         LEFT JOIN mcp_observability_incident_remediation_post_change_monitors monitor ON monitor.plan_id=plan.id
        WHERE incident.triggered_at >= now() - make_interval(days => $1::int)`,
      params,
    ),
    pool.query<ProviderDeliveryRow>(
      `SELECT count(*) AS total
         FROM mcp_observability_aiops_provider_signals
        WHERE received_at >= now() - make_interval(days => $1::int)`,
      params,
    ),
    pool.query<DependencyOutcomeRow>(
      `SELECT environment, source_service, target_kind, target_name, relation,
              count(*)::int AS calls,
              count(*) FILTER (WHERE failed)::int AS failures,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
                FILTER (WHERE duration_ms IS NOT NULL) AS p95_duration_ms,
              max(observed_at) AS last_seen_at
         FROM mcp_observability_service_dependency_evidence
        WHERE observed_at >= now() - make_interval(days => $1::int)
        GROUP BY environment, source_service, target_kind, target_name, relation
        ORDER BY failures DESC, calls DESC, source_service, target_name
        LIMIT 161`,
      params,
    ),
    pool.query<ProviderLinkRow>(
      `SELECT DISTINCT ON (signal.provider, signal.monitor_ref, signal.incident_id)
              signal.incident_id, signal.provider, signal.monitor_ref,
              signal.service, signal.environment,
              signal.normalized_signal->>'evidenceUrl' AS evidence_url,
              signal.occurred_at
         FROM mcp_observability_aiops_provider_signals signal
        WHERE signal.received_at >= now() - make_interval(days => $1::int)
          AND signal.incident_id IS NOT NULL
        ORDER BY signal.provider, signal.monitor_ref, signal.incident_id, signal.occurred_at DESC`,
      params,
    ),
    pool.query<ProfileAttributionRow>(
      `SELECT task.id AS task_id,
              task.service_profile_id, task.service_profile_revision,
              task.service_profile_sha256,
              COALESCE(task.execution_service, profile.service_name) AS service,
              COALESCE(task.execution_environment, profile.environment) AS environment,
              profile.display_name,
              task.state, task.quality, task.result_json, revision.profile_json,
              COALESCE(usage.telemetry_trace_count, 0) AS telemetry_trace_count,
              COALESCE(usage.input_tokens, 0) AS input_tokens,
              COALESCE(usage.output_tokens, 0) AS output_tokens,
              COALESCE(usage.recorded_cost_usd, 0) AS recorded_cost_usd,
              COALESCE(review.feedback_reviews, 0) AS feedback_reviews,
              COALESCE(review.feedback_helpful, 0) AS feedback_helpful,
              COALESCE(review.feedback_partial, 0) AS feedback_partial,
              COALESCE(review.feedback_incorrect, 0) AS feedback_incorrect
         FROM mcp_observability_incident_aiops_tasks task
         JOIN mcp_observability_alert_incidents incident ON incident.id=task.incident_id
         JOIN mcp_observability_aiops_service_profiles profile
           ON profile.id=task.service_profile_id
         JOIN mcp_observability_aiops_service_profile_revisions revision
           ON revision.profile_id=task.service_profile_id
          AND revision.revision=task.service_profile_revision
          AND revision.profile_sha256=task.service_profile_sha256
         LEFT JOIN LATERAL (
           SELECT count(trace.id)::int AS telemetry_trace_count,
                  COALESCE(sum(trace.input_tokens), 0) AS input_tokens,
                  COALESCE(sum(trace.output_tokens), 0) AS output_tokens,
                  COALESCE(sum(trace.total_cost_usd), 0) AS recorded_cost_usd
             FROM mcp_observability_traces trace
            WHERE task.root_trace_id IS NOT NULL
              AND trace.root_trace_id::text=task.root_trace_id
         ) usage ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS feedback_reviews,
                  count(*) FILTER (WHERE feedback.metadata->>'verdict'='helpful')::int AS feedback_helpful,
                  count(*) FILTER (WHERE feedback.metadata->>'verdict'='partial')::int AS feedback_partial,
                  count(*) FILTER (WHERE feedback.metadata->>'verdict'='incorrect')::int AS feedback_incorrect
             FROM mcp_observability_feedback feedback
            WHERE task.root_trace_id IS NOT NULL
              AND feedback.trace_id::text=task.root_trace_id
              AND feedback.label='aiops.rca.' || task.id::text
              AND feedback.source='human'
              AND feedback.active
         ) review ON true
        WHERE task.pack_id='argus.aiops'
          AND task.service_profile_id IS NOT NULL
          AND incident.triggered_at >= now() - make_interval(days => $1::int)
        ORDER BY task.created_at DESC, task.id DESC
        LIMIT ${MAX_PROFILE_ATTRIBUTION_TASKS + 1}`,
      params,
    ),
  ]);

  const entities = incidentResult.rows;
  const totalSignals = entities.reduce((sum, row) => sum + Number(row.signal_count), 0);
  const nativeSignals = entities.reduce((sum, row) => sum + Number(row.native_signal_count), 0);
  const providerSignals = entities.reduce((sum, row) => sum + Number(row.provider_signal_count), 0);
  const recoveryDurations = entities.flatMap(row => row.recovered_at
    ? [Math.max(0, timestamp(row.recovered_at) - timestamp(row.first_triggered_at))]
    : []);

  const investigations = investigationResult.rows;
  const failed = investigations.filter(row => FAILED_STATES.has(row.state.toUpperCase()) || row.quality?.toLowerCase() === 'failed').length;
  const completed = investigations.filter(row => COMPLETED_STATES.has(row.state.toUpperCase()) && row.quality?.toLowerCase() !== 'failed').length;
  const partial = investigations.filter(row => COMPLETED_STATES.has(row.state.toUpperCase()) && row.quality?.toLowerCase() === 'partial').length;
  const active = Math.max(0, investigations.length - completed - failed);
  const blockedKeys = new Set(dispatchResult.rows.filter(row => row.status === 'blocked').map(row => row.actionable_key));
  const timeToStart = investigations.map(row => Math.max(0, timestamp(row.created_at) - timestamp(row.first_triggered_at)));
  const timeToComplete = investigations.flatMap(row => COMPLETED_STATES.has(row.state.toUpperCase()) || FAILED_STATES.has(row.state.toUpperCase())
    ? [Math.max(0, timestamp(row.updated_at) - timestamp(row.created_at))]
    : []);

  const rootCause = { confirmed: 0, suspected: 0, refuted: 0, inconclusive: 0 };
  for (const row of investigations) {
    const conclusion = row.conclusion?.toLowerCase();
    if (conclusion === 'confirmed' || conclusion === 'suspected' || conclusion === 'refuted' || conclusion === 'inconclusive') {
      rootCause[conclusion] += 1;
    }
  }

  const remediationIds = new Map<string, string>();
  const planIds = new Map<string, string>();
  const monitorStatuses = new Map<string, string>();
  for (const row of remediationResult.rows) {
    remediationIds.set(String(row.remediation_id), row.remediation_status);
    if (row.plan_id != null && row.plan_status) planIds.set(String(row.plan_id), row.plan_status);
    if (row.plan_id != null && row.monitor_status) monitorStatuses.set(String(row.plan_id), row.monitor_status);
  }
  const remediationStatuses = [...remediationIds.values()];
  const planStatuses = [...planIds.values()];
  const attemptedPlans = planStatuses.filter(state => ['verified', 'failed', 'rolled_back', 'rollback_failed'].includes(state)).length;
  const verifiedPlans = planStatuses.filter(state => state === 'verified').length;

  const serviceMap = new Map<string, {
    service: string; environment: string; incidents: number; signals: number; firing: number; recovered: number; durations: number[];
  }>();
  for (const row of entities) {
    const key = `${row.service}\u0000${row.environment}`;
    const value = serviceMap.get(key) ?? {
      service: row.service, environment: row.environment, incidents: 0, signals: 0, firing: 0, recovered: 0, durations: [],
    };
    value.incidents += 1;
    value.signals += Number(row.signal_count);
    value[row.state] += 1;
    if (row.recovered_at) value.durations.push(Math.max(0, timestamp(row.recovered_at) - timestamp(row.first_triggered_at)));
    serviceMap.set(key, value);
  }
  const services = [...serviceMap.values()];
  const repeatServices = services.filter(service => service.incidents > 1);
  const rankedServices = [...services]
    .sort((left, right) => right.incidents - left.incidents || right.signals - left.signals || left.service.localeCompare(right.service));

  type ProfileAccumulator = {
    output: AiopsOutcomeProfileAttribution;
    laneCounters: Map<AiopsEvidenceLane, { investigations: number; claims: number }>;
  };
  const attributionRows = profileAttributionResult.rows.slice(0, MAX_PROFILE_ATTRIBUTION_TASKS);
  const profileAccumulators = new Map<string, ProfileAccumulator>();
  for (const row of attributionRows) {
    const profileId = Number(row.service_profile_id);
    const revision = Number(row.service_profile_revision);
    const key = `${profileId}:${revision}`;
    const policy = configuredEvidencePolicy(row.profile_json);
    const accumulator = profileAccumulators.get(key) ?? {
      output: {
        profile: {
          id: profileId,
          revision,
          sha256: row.service_profile_sha256,
          displayName: row.display_name,
          service: row.service,
          environment: row.environment,
        },
        investigations: 0,
        completedInvestigations: 0,
        evidence: {
          assessedInvestigations: 0,
          investigationsMeetingPolicy: 0,
          policyCoveragePercent: 0,
          minimumCollectedLanes: policy.minimumCollectedLanes,
          configuredLanes: policy.lanes.length,
          requiredLanes: policy.lanes.filter(lane => lane.requirement === 'required').length,
          optionalLanes: policy.lanes.filter(lane => lane.requirement === 'optional').length,
          lanes: policy.lanes.map(lane => ({
            ...lane,
            investigationsWithEvidence: 0,
            coveragePercent: 0,
            claims: 0,
          })),
        },
        usage: {
          telemetryLinkedInvestigations: 0,
          tokenAttributedInvestigations: 0,
          costAttributedInvestigations: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          recordedCostUsd: 0,
          averageTokensPerInvestigation: 0,
          averageRecordedCostUsdPerInvestigation: 0,
        },
        feedback: {
          reviewedInvestigations: 0,
          reviews: 0,
          helpful: 0,
          partial: 0,
          incorrect: 0,
          helpfulPercent: 0,
        },
      },
      laneCounters: new Map(policy.lanes.map(lane => [lane.lane, { investigations: 0, claims: 0 }])),
    };
    const output = accumulator.output;
    output.investigations += 1;
    if (COMPLETED_STATES.has(row.state.toUpperCase())) output.completedInvestigations += 1;

    const evidence = collectedEvidence(row.result_json);
    if (evidence) {
      output.evidence.assessedInvestigations += 1;
      const configuredCollected = policy.lanes.filter(lane => evidence.lanes.has(lane.lane));
      const missingRequired = policy.lanes.some(lane => lane.requirement === 'required' && !evidence.lanes.has(lane.lane));
      if (!missingRequired && configuredCollected.length >= policy.minimumCollectedLanes) {
        output.evidence.investigationsMeetingPolicy += 1;
      }
      for (const lane of configuredCollected) {
        const counter = accumulator.laneCounters.get(lane.lane);
        if (!counter) continue;
        counter.investigations += 1;
        counter.claims += evidence.claims.get(lane.lane) ?? 0;
      }
    }

    const telemetryTraces = Number(row.telemetry_trace_count) || 0;
    const inputTokens = Math.max(0, Number(row.input_tokens) || 0);
    const outputTokens = Math.max(0, Number(row.output_tokens) || 0);
    const recordedCostUsd = Math.max(0, Number(row.recorded_cost_usd) || 0);
    if (telemetryTraces > 0) output.usage.telemetryLinkedInvestigations += 1;
    if (inputTokens + outputTokens > 0) output.usage.tokenAttributedInvestigations += 1;
    if (recordedCostUsd > 0) output.usage.costAttributedInvestigations += 1;
    output.usage.inputTokens += inputTokens;
    output.usage.outputTokens += outputTokens;
    output.usage.totalTokens += inputTokens + outputTokens;
    output.usage.recordedCostUsd += recordedCostUsd;
    const feedbackReviews = Math.max(0, Number(row.feedback_reviews) || 0);
    if (feedbackReviews > 0) output.feedback.reviewedInvestigations += 1;
    output.feedback.reviews += feedbackReviews;
    output.feedback.helpful += Math.max(0, Number(row.feedback_helpful) || 0);
    output.feedback.partial += Math.max(0, Number(row.feedback_partial) || 0);
    output.feedback.incorrect += Math.max(0, Number(row.feedback_incorrect) || 0);
    profileAccumulators.set(key, accumulator);
  }

  const profileAttributions = [...profileAccumulators.values()].map(({ output, laneCounters }) => {
    output.evidence.policyCoveragePercent = percent(
      output.evidence.investigationsMeetingPolicy,
      output.evidence.assessedInvestigations,
    );
    output.evidence.lanes = output.evidence.lanes.map(lane => {
      const counter = laneCounters.get(lane.lane) ?? { investigations: 0, claims: 0 };
      return {
        ...lane,
        investigationsWithEvidence: counter.investigations,
        coveragePercent: percent(counter.investigations, output.evidence.assessedInvestigations),
        claims: counter.claims,
      };
    });
    output.usage.recordedCostUsd = money(output.usage.recordedCostUsd);
    output.usage.averageTokensPerInvestigation = output.investigations > 0
      ? Math.round(output.usage.totalTokens / output.investigations)
      : 0;
    output.usage.averageRecordedCostUsdPerInvestigation = output.investigations > 0
      ? money(output.usage.recordedCostUsd / output.investigations)
      : 0;
    output.feedback.helpfulPercent = percent(output.feedback.helpful, output.feedback.reviews);
    return output;
  }).sort((left, right) => right.investigations - left.investigations
    || left.profile.displayName.localeCompare(right.profile.displayName)
    || right.profile.revision - left.profile.revision);

  const providerLinksByService = new Map<string, AiopsOutcomeProviderLink[]>();
  for (const row of providerLinkResult.rows) {
    const serviceKey = `${row.service}\u0000${row.environment}`;
    const links = providerLinksByService.get(serviceKey) ?? [];
    if (links.length >= 8) continue;
    links.push({
      provider: row.provider,
      monitorRef: row.monitor_ref,
      incidentId: Number(row.incident_id),
      observedAt: new Date(row.occurred_at).toISOString(),
      incidentHref: `/observe/alerts?incident=${Number(row.incident_id)}`,
      externalHref: sanitizeAiOpsProviderEvidenceUrl(row.evidence_url),
    });
    providerLinksByService.set(serviceKey, links);
  }

  const graphNodes = new Map<string, AiopsOutcomeGraphNode>();
  let nodesTruncated = false;
  const ensureGraphNode = (
    kind: AiopsOutcomeGraphNode['kind'],
    environment: string,
    label: string,
    serviceStats?: typeof services[number],
  ): string | null => {
    const id = graphIdentity(kind, environment, label);
    if (graphNodes.has(id)) return id;
    if (graphNodes.size >= MAX_GRAPH_NODES) {
      nodesTruncated = true;
      return null;
    }
    const entity = serviceStats
      ? entities.filter(row => row.service === serviceStats.service && row.environment === serviceStats.environment)
      : [];
    graphNodes.set(id, {
      id,
      kind,
      label,
      environment,
      incidents: serviceStats?.incidents ?? 0,
      signals: serviceStats?.signals ?? 0,
      firing: serviceStats?.firing ?? 0,
      incidentIds: entity.flatMap(row => row.incident_ids.map(Number)).slice(0, 20),
      providerLinks: kind === 'service'
        ? (providerLinksByService.get(`${label}\u0000${environment}`) ?? [])
        : [],
    });
    return id;
  };
  for (const service of rankedServices.slice(0, 16)) {
    ensureGraphNode('service', service.environment, service.service, service);
  }
  if (rankedServices.length > 16) nodesTruncated = true;

  const graphEdges: AiopsOutcomeGraphEdge[] = [];
  let edgesTruncated = dependencyResult.rows.length > 160;
  for (const row of dependencyResult.rows) {
    if (graphEdges.length >= MAX_GRAPH_EDGES) {
      edgesTruncated = true;
      break;
    }
    const sourceStats = serviceMap.get(`${row.source_service}\u0000${row.environment}`);
    const targetStats = row.target_kind === 'service'
      ? serviceMap.get(`${row.target_name}\u0000${row.environment}`)
      : undefined;
    if (!sourceStats && !targetStats) continue;
    const source = ensureGraphNode('service', row.environment, row.source_service, sourceStats);
    const target = ensureGraphNode(row.target_kind, row.environment, row.target_name, targetStats);
    if (!source || !target) {
      edgesTruncated = true;
      continue;
    }
    const calls = Number(row.calls) || 0;
    const failures = Number(row.failures) || 0;
    const confidence = graphConfidence(failures, calls);
    graphEdges.push({
      id: `${source}->${target}:${row.relation}`,
      source,
      target,
      relation: row.relation,
      calls,
      failures,
      failureRate: calls > 0 ? Math.round((failures / calls) * 1_000) / 1_000 : 0,
      p95DurationMs: row.p95_duration_ms == null ? null : Math.round(Number(row.p95_duration_ms)),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      evidence: failures > 0 ? 'causal_candidate' : 'observed',
      confidence,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    window: { days, from: from.toISOString(), to: now.toISOString() },
    signals: {
      total: totalSignals,
      native: nativeSignals,
      provider: providerSignals,
      providerDeliveries: Number(providerDeliveryResult.rows[0]?.total ?? 0),
    },
    incidents: {
      actionable: entities.length,
      firing: entities.filter(row => row.state === 'firing').length,
      recovered: entities.filter(row => row.state === 'recovered').length,
      correlated: entities.filter(row => row.correlation_group_id != null).length,
      standalone: entities.filter(row => row.correlation_group_id == null).length,
      suppressedSignals: Math.max(0, totalSignals - entities.length),
      compressionRatio: ratio(totalSignals, entities.length),
      medianRecoveryMs: percentile(recoveryDurations, 0.5),
      p95RecoveryMs: percentile(recoveryDurations, 0.95),
    },
    investigations: {
      started: investigations.length,
      completed,
      partial,
      failed,
      blocked: blockedKeys.size,
      active,
      coveragePercent: percent(investigations.length, entities.length),
      completionRatePercent: percent(completed, investigations.length),
      medianTimeToStartMs: percentile(timeToStart, 0.5),
      medianTimeToCompleteMs: percentile(timeToComplete, 0.5),
    },
    rootCause,
    remediations: {
      proposed: remediationStatuses.length,
      approved: remediationStatuses.filter(state => ['approved', 'executed', 'failed', 'verified'].includes(state)).length,
      awaitingApproval: remediationStatuses.filter(state => state === 'proposed').length
        + planStatuses.filter(state => state === 'awaiting_approval').length,
      executed: planStatuses.filter(state => ['verified', 'failed', 'rolled_back', 'rollback_failed'].includes(state)).length,
      verified: verifiedPlans,
      failed: planStatuses.filter(state => ['failed', 'rollback_failed'].includes(state)).length,
      rolledBack: planStatuses.filter(state => state === 'rolled_back').length,
      successRatePercent: percent(verifiedPlans, attemptedPlans),
      postChangeHealthy: [...monitorStatuses.values()].filter(state => state === 'healthy').length,
      postChangeRegressed: [...monitorStatuses.values()].filter(state => ['regression_detected', 'rollback_approved', 'rollback_rejected', 'rolling_back', 'rolled_back', 'rollback_failed'].includes(state)).length,
    },
    recurrence: {
      servicesWithRepeatIncidents: repeatServices.length,
      repeatIncidents: repeatServices.reduce((sum, service) => sum + service.incidents - 1, 0),
    },
    topServices: rankedServices
      .slice(0, 8)
      .map(({ durations, ...service }) => ({ ...service, medianRecoveryMs: percentile(durations, 0.5) })),
    profileAttribution: {
      profileBoundInvestigations: attributionRows.length,
      telemetryLinkedInvestigations: profileAttributions.reduce(
        (sum, profile) => sum + profile.usage.telemetryLinkedInvestigations,
        0,
      ),
      totalTokens: profileAttributions.reduce((sum, profile) => sum + profile.usage.totalTokens, 0),
      recordedCostUsd: money(profileAttributions.reduce((sum, profile) => sum + profile.usage.recordedCostUsd, 0)),
      reviewedInvestigations: profileAttributions.reduce((sum, profile) => sum + profile.feedback.reviewedInvestigations, 0),
      reviews: profileAttributions.reduce((sum, profile) => sum + profile.feedback.reviews, 0),
      helpful: profileAttributions.reduce((sum, profile) => sum + profile.feedback.helpful, 0),
      partial: profileAttributions.reduce((sum, profile) => sum + profile.feedback.partial, 0),
      incorrect: profileAttributions.reduce((sum, profile) => sum + profile.feedback.incorrect, 0),
      helpfulPercent: percent(
        profileAttributions.reduce((sum, profile) => sum + profile.feedback.helpful, 0),
        profileAttributions.reduce((sum, profile) => sum + profile.feedback.reviews, 0),
      ),
      truncated: profileAttributionResult.rows.length > MAX_PROFILE_ATTRIBUTION_TASKS,
      profiles: profileAttributions,
    },
    graph: {
      nodes: [...graphNodes.values()],
      edges: graphEdges,
      truncated: { nodes: nodesTruncated, edges: edgesTruncated },
    },
  };
}
