import type pg from 'pg';
import type { ServiceDependencyRelation, ServiceDependencyTargetKind } from './serviceDependencies.js';

type Queryable = Pick<pg.Pool, 'query'>;

export type IncidentImpactDirection = 'upstream' | 'downstream';
export type IncidentImpactConfidence = 'high' | 'medium' | 'low';

export interface IncidentImpactDependency {
  sourceService: string;
  targetKind: ServiceDependencyTargetKind;
  targetName: string;
  relation: ServiceDependencyRelation;
  direction: IncidentImpactDirection;
  depth: number;
  path: string[];
  calls: number;
  failures: number;
  failureRate: number;
  p95DurationMs: number | null;
  lastSeenAt: string;
}

export interface IncidentImpactService {
  service: string;
  direction: IncidentImpactDirection;
  depth: number;
  path: string[];
}

export interface IncidentRootCauseCandidate extends IncidentImpactDependency {
  confidence: IncidentImpactConfidence;
  reason: string;
}

export interface IncidentImpactResponse {
  incidentId: number;
  generatedAt: string;
  available: boolean;
  reason: string | null;
  service: string | null;
  environment: string | null;
  window: { minutesBefore: number; minutesAfter: number };
  summary: {
    upstreamServices: number;
    downstreamServices: number;
    externalDependencies: number;
    failingDependencies: number;
    observedCalls: number;
    observedFailures: number;
  };
  impactedServices: IncidentImpactService[];
  dependencies: IncidentImpactDependency[];
  rootCauseCandidates: IncidentRootCauseCandidate[];
}

export type IncidentImpactLabels = Record<string, string>;

export interface IncidentImpactReader {
  getForIncident(incidentId: number): Promise<IncidentImpactResponse | null>;
}

export class PostgresIncidentImpactReader implements IncidentImpactReader {
  constructor(private readonly pool: Queryable) {}

  getForIncident(incidentId: number): Promise<IncidentImpactResponse | null> {
    return getIncidentImpact(this.pool, incidentId);
  }
}

interface IncidentRow {
  id: number | string;
  triggered_at: string | Date;
  recovered_at: string | Date | null;
  aiops_service: string | null;
  aiops_environment: string | null;
}

interface DependencyRow {
  source_service: string;
  target_kind: ServiceDependencyTargetKind;
  target_name: string;
  relation: ServiceDependencyRelation;
  calls: number | string;
  failures: number | string;
  p95_duration_ms: number | string | null;
  last_seen_at: string | Date;
}

const MAX_DEPTH = 3;
const MAX_GRAPH_EDGES = 500;
const MAX_RESPONSE_EDGES = 80;

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function key(value: string): string {
  return value.trim().toLowerCase();
}

function dependencyFromRow(
  row: DependencyRow,
  direction: IncidentImpactDirection,
  depth: number,
  path: string[],
): IncidentImpactDependency {
  const calls = Number(row.calls) || 0;
  const failures = Number(row.failures) || 0;
  return {
    sourceService: row.source_service,
    targetKind: row.target_kind,
    targetName: row.target_name,
    relation: row.relation,
    direction,
    depth,
    path,
    calls,
    failures,
    failureRate: calls > 0 ? failures / calls : 0,
    p95DurationMs: row.p95_duration_ms == null ? null : Math.round(Number(row.p95_duration_ms)),
    lastSeenAt: iso(row.last_seen_at),
  };
}

function emptyResponse(incidentId: number, service: string | null, environment: string | null, reason: string): IncidentImpactResponse {
  return {
    incidentId,
    generatedAt: new Date().toISOString(),
    available: false,
    reason,
    service,
    environment,
    window: { minutesBefore: 60, minutesAfter: 30 },
    summary: { upstreamServices: 0, downstreamServices: 0, externalDependencies: 0, failingDependencies: 0, observedCalls: 0, observedFailures: 0 },
    impactedServices: [],
    dependencies: [],
    rootCauseCandidates: [],
  };
}

function candidateConfidence(dependency: IncidentImpactDependency): IncidentImpactConfidence {
  if (dependency.depth === 1 && dependency.failureRate >= 0.5) return 'high';
  if (dependency.failureRate >= 0.25 || dependency.failures >= 3) return 'medium';
  return 'low';
}

function candidateReason(dependency: IncidentImpactDependency): string {
  const scope = dependency.depth === 1 ? 'Direct downstream dependency' : `Downstream dependency at depth ${dependency.depth}`;
  return `${dependency.failures} of ${dependency.calls} observed ${dependency.relation} failed. ${scope}; evidence is correlated, not causal proof.`;
}

function labelValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
}

function compactPath(path: string[]): string {
  return path.slice(0, MAX_DEPTH + 1).map(part => part.slice(0, 80)).join(' -> ');
}

/**
 * Existing Argus AIOps releases accept a strict incident input contract with a
 * bounded string-label extension. This adapter keeps Core as the source of
 * truth without coupling automatic dispatch to a new Pack version. It contains
 * only aggregate graph evidence and never raw traces, logs or provider payloads.
 */
export function incidentImpactLabels(impact: IncidentImpactResponse | null): IncidentImpactLabels {
  if (!impact) {
    return {
      'argus.core.impact.schema': '1',
      'argus.core.impact.status': 'unavailable',
    };
  }
  const labels: IncidentImpactLabels = {
    'argus.core.impact.schema': '1',
    'argus.core.impact.status': impact.available
      ? impact.dependencies.length > 0 ? 'observed' : 'no_evidence'
      : 'unavailable',
    'argus.core.impact.source': 'argus.core',
    'argus.core.impact.generated_at': impact.generatedAt,
    'argus.core.impact.scope': labelValue(`incident=${impact.incidentId}; service=${impact.service ?? 'unknown'}; environment=${impact.environment ?? 'unknown'}; window=-${impact.window.minutesBefore}m/+${impact.window.minutesAfter}m`),
    'argus.core.impact.summary': labelValue(`upstream_services=${impact.summary.upstreamServices}; downstream_services=${impact.summary.downstreamServices}; external_dependencies=${impact.summary.externalDependencies}; failing_dependencies=${impact.summary.failingDependencies}; observed_calls=${impact.summary.observedCalls}; observed_failures=${impact.summary.observedFailures}`),
  };
  if (impact.reason) labels['argus.core.impact.reason'] = labelValue(impact.reason);
  impact.rootCauseCandidates.slice(0, 5).forEach((candidate, index) => {
    labels[`argus.core.impact.candidate.${index + 1}`] = labelValue(
      `confidence=${candidate.confidence}; target=${candidate.targetKind}:${candidate.targetName}; relation=${candidate.relation}; failures=${candidate.failures}/${candidate.calls}; failure_rate=${Math.round(candidate.failureRate * 100)}%; p95_ms=${candidate.p95DurationMs ?? 'n/a'}; path=${compactPath(candidate.path)}`,
    );
  });
  [...impact.dependencies]
    .sort((left, right) => right.failures - left.failures || right.calls - left.calls || left.depth - right.depth)
    .slice(0, 10)
    .forEach((dependency, index) => {
      labels[`argus.core.impact.dependency.${index + 1}`] = labelValue(
        `direction=${dependency.direction}; target=${dependency.targetKind}:${dependency.targetName}; relation=${dependency.relation}; depth=${dependency.depth}; failures=${dependency.failures}/${dependency.calls}; p95_ms=${dependency.p95DurationMs ?? 'n/a'}; path=${compactPath(dependency.path)}`,
      );
    });
  impact.impactedServices.slice(0, 10).forEach((service, index) => {
    labels[`argus.core.impact.service_path.${index + 1}`] = labelValue(
      `direction=${service.direction}; depth=${service.depth}; service=${service.service}; path=${compactPath(service.path)}`,
    );
  });
  return labels;
}

export function mergeIncidentImpactLabels(existing: unknown, impact: IncidentImpactResponse | null): IncidentImpactLabels {
  const retained: IncidentImpactLabels = {};
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [rawKey, rawValue] of Object.entries(existing as Record<string, unknown>).slice(0, 64)) {
      const labelKey = rawKey.replace(/[\r\n\t]+/g, '').trim().slice(0, 120);
      if (!labelKey || labelKey.startsWith('argus.core.impact.') || typeof rawValue !== 'string') continue;
      retained[labelKey] = labelValue(rawValue);
    }
  }
  return { ...retained, ...incidentImpactLabels(impact) };
}

export async function getIncidentImpact(pool: Queryable, incidentId: number): Promise<IncidentImpactResponse | null> {
  const incidentResult = await pool.query<IncidentRow>(
    `SELECT incident.id, incident.triggered_at, incident.recovered_at,
            COALESCE(task.execution_service, rule.aiops_service) AS aiops_service,
            COALESCE(task.execution_environment, rule.aiops_environment) AS aiops_environment
       FROM mcp_observability_alert_incidents incident
       JOIN mcp_observability_alert_rules rule ON rule.id=incident.rule_id
       LEFT JOIN LATERAL (
         SELECT execution_service, execution_environment
           FROM mcp_observability_incident_aiops_tasks
          WHERE incident_id=incident.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) task ON true
      WHERE incident.id=$1`,
    [incidentId],
  );
  const incident = incidentResult.rows[0];
  if (!incident) return null;
  const service = incident.aiops_service?.trim() || null;
  const environment = incident.aiops_environment?.trim() || null;
  if (!service || !environment) {
    return emptyResponse(incidentId, service, environment, 'The alert rule has no explicit AIOps service and environment boundary.');
  }

  const dependencyResult = await pool.query<DependencyRow>(
    `SELECT source_service, target_kind, target_name, relation,
            count(*)::int AS calls,
            count(*) FILTER (WHERE failed)::int AS failures,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
              FILTER (WHERE duration_ms IS NOT NULL) AS p95_duration_ms,
            max(observed_at) AS last_seen_at
       FROM mcp_observability_service_dependency_evidence
      WHERE environment=$1
        AND observed_at >= $2::timestamptz - interval '60 minutes'
        AND observed_at <= COALESCE($3::timestamptz, now()) + interval '30 minutes'
      GROUP BY source_service, target_kind, target_name, relation
      ORDER BY failures DESC, calls DESC, source_service, target_name
      LIMIT ${MAX_GRAPH_EDGES}`,
    [environment, iso(incident.triggered_at), incident.recovered_at ? iso(incident.recovered_at) : null],
  );

  const rows = dependencyResult.rows;
  const dependencies: IncidentImpactDependency[] = [];
  const impactedServices = new Map<string, IncidentImpactService>();
  const seenEdges = new Set<string>();
  const traverse = (direction: IncidentImpactDirection) => {
    const visited = new Set([key(service)]);
    const queue: Array<{ service: string; depth: number; path: string[] }> = [{ service, depth: 0, path: [service] }];
    while (queue.length > 0 && dependencies.length < MAX_RESPONSE_EDGES) {
      const current = queue.shift()!;
      if (current.depth >= MAX_DEPTH) continue;
      for (const row of rows) {
        const matches = direction === 'downstream'
          ? key(row.source_service) === key(current.service)
          : row.target_kind === 'service' && key(row.target_name) === key(current.service);
        if (!matches) continue;
        const nextService = direction === 'downstream' ? row.target_name : row.source_service;
        const path = direction === 'downstream'
          ? [...current.path, nextService]
          : [nextService, ...current.path];
        const edgeKey = `${direction}\0${row.source_service}\0${row.target_kind}\0${row.target_name}\0${row.relation}`.toLowerCase();
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          dependencies.push(dependencyFromRow(row, direction, current.depth + 1, path));
        }
        const traversable = direction === 'upstream' || row.target_kind === 'service';
        const nextKey = key(nextService);
        if (traversable && !visited.has(nextKey)) {
          visited.add(nextKey);
          const impact: IncidentImpactService = { service: nextService, direction, depth: current.depth + 1, path };
          impactedServices.set(`${direction}:${nextKey}`, impact);
          queue.push({ service: nextService, depth: current.depth + 1, path });
        }
      }
    }
  };
  traverse('downstream');
  traverse('upstream');

  const rootCauseCandidates = dependencies
    .filter(dependency => dependency.direction === 'downstream' && dependency.failures > 0)
    .map(dependency => ({
      ...dependency,
      confidence: candidateConfidence(dependency),
      reason: candidateReason(dependency),
    }))
    .sort((left, right) => {
      const confidenceRank = { high: 0, medium: 1, low: 2 } as const;
      return confidenceRank[left.confidence] - confidenceRank[right.confidence]
        || left.depth - right.depth
        || right.failureRate - left.failureRate
        || right.failures - left.failures;
    })
    .slice(0, 10);
  const impacted = [...impactedServices.values()]
    .sort((left, right) => left.direction.localeCompare(right.direction) || left.depth - right.depth || left.service.localeCompare(right.service))
    .slice(0, 50);
  const uniqueObservedEdges = dependencies.filter(dependency => dependency.direction === 'downstream');
  return {
    incidentId,
    generatedAt: new Date().toISOString(),
    available: true,
    reason: dependencies.length === 0 ? 'No runtime dependency evidence was observed for this service inside the incident window.' : null,
    service,
    environment,
    window: { minutesBefore: 60, minutesAfter: 30 },
    summary: {
      upstreamServices: impacted.filter(item => item.direction === 'upstream').length,
      downstreamServices: impacted.filter(item => item.direction === 'downstream').length,
      externalDependencies: uniqueObservedEdges.filter(item => item.targetKind !== 'service').length,
      failingDependencies: uniqueObservedEdges.filter(item => item.failures > 0).length,
      observedCalls: uniqueObservedEdges.reduce((total, item) => total + item.calls, 0),
      observedFailures: uniqueObservedEdges.reduce((total, item) => total + item.failures, 0),
    },
    impactedServices: impacted,
    dependencies,
    rootCauseCandidates,
  };
}
