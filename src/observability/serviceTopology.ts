import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { NativeServiceHealthState } from './nativeServiceHealth.js';
import { listServiceCatalog, type ServiceCatalogSource } from './serviceCatalog.js';
import { listServiceDependencies } from './serviceDependencies.js';

export type ServiceTopologyNodeKind = 'cluster' | 'namespace' | 'workload' | 'service' | 'dependency' | 'alert';
export type ServiceTopologySignal = 'kubernetes' | 'traces' | 'logs' | 'alerts';

export interface ServiceTopologyNode {
  id: string;
  kind: ServiceTopologyNodeKind;
  name: string;
  detail: string;
  environment: string | null;
  state: NativeServiceHealthState;
  current: boolean;
  signals: ServiceTopologySignal[];
  evidenceCount: number;
  events: number;
  calls: number;
  failures: number;
}

export interface ServiceTopologyEdge {
  id: string;
  source: string;
  target: string;
  relation: 'contains' | 'runs' | 'backs' | 'exposes' | 'monitored_by' | 'calls' | 'queries' | 'publishes';
  evidence: 'configured' | 'observed' | 'both';
  current: boolean;
  calls: number;
  failures: number;
  p95DurationMs: number | null;
  lastSeenAt: string | null;
}

export interface ServiceTopologyResponse {
  generatedAt: string;
  nodes: ServiceTopologyNode[];
  edges: ServiceTopologyEdge[];
  summary: {
    clusters: number;
    namespaces: number;
    workloads: number;
    services: number;
    alerts: number;
    firingAlerts: number;
    traceServices: number;
    logServices: number;
    runtimeDependencies: number;
    calls: number;
    failures: number;
  };
}

interface AlertTopologyRow {
  id: number | string;
  name: string;
  severity: 'info' | 'warning' | 'critical';
  last_state: 'ok' | 'firing' | 'no_data';
  enabled: boolean;
  aiops_service: string;
  aiops_environment: string;
  open_incidents: number | string;
}

const stateRank: Record<NativeServiceHealthState, number> = {
  no_data: 0,
  healthy: 1,
  degraded: 2,
  critical: 3,
};

function stableId(kind: ServiceTopologyNodeKind, ...parts: Array<string | number>): string {
  return `${kind}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20)}`;
}

function signalForSource(source: ServiceCatalogSource): ServiceTopologySignal | null {
  if (source === 'kubernetes') return 'kubernetes';
  if (source === 'opentelemetry') return 'traces';
  if (source === 'logs') return 'logs';
  if (source === 'alert_rule') return 'alerts';
  return null;
}

function alertState(row: AlertTopologyRow): NativeServiceHealthState {
  if (!row.enabled || row.last_state === 'no_data') return 'no_data';
  if (row.last_state === 'ok') return 'healthy';
  return row.severity === 'critical' ? 'critical' : 'degraded';
}

export async function getServiceTopology(pool: pg.Pool): Promise<ServiceTopologyResponse> {
  const [catalog, alertResult, dependencies] = await Promise.all([
    listServiceCatalog(pool),
    pool.query<AlertTopologyRow>(
      `SELECT rule.id, rule.name, rule.severity, rule.last_state, rule.enabled,
              rule.aiops_service, rule.aiops_environment,
              count(incident.id) FILTER (WHERE incident.state='firing')::int AS open_incidents
         FROM mcp_observability_alert_rules rule
         LEFT JOIN mcp_observability_alert_incidents incident ON incident.rule_id=rule.id
        WHERE rule.archived_at IS NULL
          AND rule.aiops_service IS NOT NULL AND rule.aiops_environment IS NOT NULL
        GROUP BY rule.id
        ORDER BY rule.enabled DESC, rule.name`,
    ),
    listServiceDependencies(pool),
  ]);
  const nodes = new Map<string, ServiceTopologyNode>();
  const edges = new Map<string, ServiceTopologyEdge>();

  const addNode = (node: ServiceTopologyNode): ServiceTopologyNode => {
    const current = nodes.get(node.id);
    if (!current) {
      nodes.set(node.id, node);
      return node;
    }
    current.current ||= node.current;
    current.evidenceCount += node.evidenceCount;
    current.events += node.events;
    current.calls += node.calls;
    current.failures += node.failures;
    for (const signal of node.signals) if (!current.signals.includes(signal)) current.signals.push(signal);
    if (stateRank[node.state] > stateRank[current.state]) current.state = node.state;
    if (current.detail === 'Discovered service' && node.detail !== current.detail) current.detail = node.detail;
    return current;
  };
  const addEdge = (
    source: string,
    target: string,
    relation: ServiceTopologyEdge['relation'],
    evidence: Exclude<ServiceTopologyEdge['evidence'], 'both'>,
    current: boolean,
    metrics: Pick<ServiceTopologyEdge, 'calls' | 'failures' | 'p95DurationMs' | 'lastSeenAt'> = {
      calls: 0, failures: 0, p95DurationMs: null, lastSeenAt: null,
    },
  ) => {
    const id = `${source}->${target}:${relation}`;
    const existing = edges.get(id);
    if (existing) {
      if (existing.evidence !== evidence) existing.evidence = 'both';
      existing.current ||= current;
      existing.calls += metrics.calls;
      existing.failures += metrics.failures;
      if (metrics.p95DurationMs != null) existing.p95DurationMs = Math.max(existing.p95DurationMs ?? 0, metrics.p95DurationMs);
      if (metrics.lastSeenAt && (!existing.lastSeenAt || Date.parse(metrics.lastSeenAt) > Date.parse(existing.lastSeenAt))) existing.lastSeenAt = metrics.lastSeenAt;
      return;
    }
    edges.set(id, { id, source, target, relation, evidence, current, ...metrics });
  };

  for (const entry of catalog.entries) {
    const serviceId = stableId('service', entry.environment, entry.serviceName);
    const signals = entry.sources.flatMap(source => {
      const signal = signalForSource(source);
      return signal ? [signal] : [];
    });
    addNode({
      id: serviceId,
      kind: 'service',
      name: entry.serviceName,
      detail: `${entry.environment} · ${entry.evidenceCount} evidence record${entry.evidenceCount === 1 ? '' : 's'}`,
      environment: entry.environment,
      state: 'no_data',
      current: entry.current,
      signals: [...new Set(signals)].sort(),
      evidenceCount: entry.evidenceCount,
      events: 0,
      calls: 0,
      failures: 0,
    });
    for (const target of entry.targets) {
      const clusterId = stableId('cluster', target.backendId, target.targetId);
      const namespaceId = stableId('namespace', target.backendId, target.targetId, target.namespace);
      addNode({
        id: clusterId, kind: 'cluster', name: target.cluster, detail: target.targetId,
        environment: entry.environment, state: 'no_data', current: target.current,
        signals: ['kubernetes'], evidenceCount: 1, events: 0,
        calls: 0, failures: 0,
      });
      addNode({
        id: namespaceId, kind: 'namespace', name: target.namespace, detail: target.cluster,
        environment: entry.environment, state: 'no_data', current: target.current,
        signals: ['kubernetes'], evidenceCount: 1, events: 0,
        calls: 0, failures: 0,
      });
      addEdge(clusterId, namespaceId, 'contains', 'observed', target.current);
      for (const workload of target.workloads) {
        if (workload.kind.toLowerCase() === 'service') {
          addEdge(namespaceId, serviceId, 'exposes', 'observed', target.current);
          continue;
        }
        const workloadId = stableId(
          'workload', target.backendId, target.targetId, target.namespace,
          workload.kind.toLowerCase(), workload.name,
        );
        addNode({
          id: workloadId, kind: 'workload', name: workload.name, detail: `${workload.kind} · ${target.namespace}`,
          environment: entry.environment, state: 'no_data', current: target.current,
          signals: ['kubernetes'], evidenceCount: 1, events: 0,
          calls: 0, failures: 0,
        });
        addEdge(namespaceId, workloadId, 'runs', 'observed', target.current);
        addEdge(workloadId, serviceId, 'backs', 'observed', target.current);
      }
    }
  }

  for (const row of alertResult.rows) {
    const serviceId = stableId('service', row.aiops_environment, row.aiops_service);
    const openIncidents = Number(row.open_incidents) || 0;
    const state = alertState(row);
    const serviceAlreadyCataloged = nodes.has(serviceId);
    addNode({
      id: serviceId, kind: 'service', name: row.aiops_service, detail: 'Configured AIOps service',
      environment: row.aiops_environment, state, current: row.enabled,
      signals: ['alerts'], evidenceCount: serviceAlreadyCataloged ? 0 : 1, events: openIncidents,
      calls: 0, failures: 0,
    });
    const alertId = stableId('alert', row.id);
    addNode({
      id: alertId, kind: 'alert', name: row.name,
      detail: `${row.severity} · ${row.last_state.replace('_', ' ')}`,
      environment: row.aiops_environment, state, current: row.enabled,
      signals: ['alerts'], evidenceCount: 1, events: openIncidents,
      calls: 0, failures: 0,
    });
    addEdge(serviceId, alertId, 'monitored_by', 'configured', row.enabled);
  }

  for (const dependency of dependencies) {
    const sourceId = stableId('service', dependency.environment, dependency.sourceService);
    const observedState: NativeServiceHealthState = dependency.failures > 0 ? 'degraded' : 'no_data';
    addNode({
      id: sourceId, kind: 'service', name: dependency.sourceService, detail: 'Observed trace service',
      environment: dependency.environment, state: observedState, current: dependency.current,
      signals: ['traces'], evidenceCount: 0, events: 0,
      calls: dependency.calls, failures: dependency.failures,
    });
    const targetId = dependency.targetKind === 'service'
      ? stableId('service', dependency.environment, dependency.targetName)
      : stableId('dependency', dependency.environment, dependency.targetKind, dependency.targetName);
    addNode({
      id: targetId,
      kind: dependency.targetKind === 'service' ? 'service' : 'dependency',
      name: dependency.targetName,
      detail: dependency.targetKind === 'service' ? 'Observed downstream service' : dependency.targetKind,
      environment: dependency.environment,
      state: observedState,
      current: dependency.current,
      signals: ['traces'],
      evidenceCount: 0,
      events: 0,
      calls: dependency.calls,
      failures: dependency.failures,
    });
    addEdge(sourceId, targetId, dependency.relation, 'observed', dependency.current, {
      calls: dependency.calls,
      failures: dependency.failures,
      p95DurationMs: dependency.p95DurationMs,
      lastSeenAt: dependency.lastSeenAt,
    });
  }

  const nodeList = [...nodes.values()]
    .map(node => ({ ...node, signals: node.signals.sort() }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  const edgeList = [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    generatedAt: new Date().toISOString(),
    nodes: nodeList,
    edges: edgeList,
    summary: {
      clusters: nodeList.filter(node => node.kind === 'cluster').length,
      namespaces: nodeList.filter(node => node.kind === 'namespace').length,
      workloads: nodeList.filter(node => node.kind === 'workload').length,
      services: nodeList.filter(node => node.kind === 'service').length,
      alerts: nodeList.filter(node => node.kind === 'alert').length,
      firingAlerts: nodeList.filter(node => node.kind === 'alert' && (node.state === 'degraded' || node.state === 'critical')).length,
      traceServices: nodeList.filter(node => node.kind === 'service' && node.signals.includes('traces')).length,
      logServices: nodeList.filter(node => node.kind === 'service' && node.signals.includes('logs')).length,
      runtimeDependencies: edgeList.filter(edge => ['calls', 'queries', 'publishes'].includes(edge.relation)).length,
      calls: edgeList.reduce((total, edge) => total + edge.calls, 0),
      failures: edgeList.reduce((total, edge) => total + edge.failures, 0),
    },
  };
}
