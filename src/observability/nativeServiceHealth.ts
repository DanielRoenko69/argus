import type { NativeAlertIncident, NativeAlertRule } from './nativeAlerts.js';
import type { TelemetryAnalytics } from './telemetryStore.js';

export type NativeServiceHealthState = 'healthy' | 'degraded' | 'critical' | 'no_data';
export type NativeSloState = 'met' | 'breached' | 'no_data';

export interface NativeServiceHealthComponent {
  id: string;
  kind: 'agent' | 'workflow' | 'model' | 'tool';
  name: string;
  detail: string;
  state: NativeServiceHealthState;
  executions: number;
  failures: number;
  successRate: number;
  p95DurationMs: number;
  costUsd: number;
}

export interface NativeServiceHealth {
  state: NativeServiceHealthState;
  score: number | null;
  summary: {
    totalExecutions: number;
    successRate: number;
    p95DurationMs: number;
    totalCostUsd: number;
    firingIncidents: number;
    criticalIncidents: number;
  };
  errorBudget: {
    objective: number;
    terminalExecutions: number;
    allowedFailures: number;
    actualFailures: number;
    remainingPercent: number;
    state: NativeSloState;
  };
  slos: Array<{
    id: 'reliability' | 'latency' | 'incidents';
    name: string;
    state: NativeSloState;
    target: string;
    actual: string;
    description: string;
  }>;
  components: NativeServiceHealthComponent[];
  openIncidents: NativeAlertIncident[];
  recommendations: Array<{
    severity: 'info' | 'warning' | 'critical';
    title: string;
    description: string;
    href: string;
  }>;
}

const RELIABILITY_OBJECTIVE = 95;
const LATENCY_OBJECTIVE_MS = 30_000;

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function componentState(executions: number, successRate: number, p95DurationMs: number): NativeServiceHealthState {
  if (executions === 0) return 'no_data';
  if (successRate < 90) return 'critical';
  if (successRate < RELIABILITY_OBJECTIVE || p95DurationMs > LATENCY_OBJECTIVE_MS) return 'degraded';
  return 'healthy';
}

function componentSort(left: NativeServiceHealthComponent, right: NativeServiceHealthComponent): number {
  const weight: Record<NativeServiceHealthState, number> = { critical: 3, degraded: 2, no_data: 1, healthy: 0 };
  return weight[right.state] - weight[left.state]
    || right.failures - left.failures
    || right.executions - left.executions;
}

export function buildNativeServiceHealth(
  analytics: TelemetryAnalytics,
  alerts: { rules: NativeAlertRule[]; incidents: NativeAlertIncident[] },
): NativeServiceHealth {
  const summary = analytics.summary;
  const terminalExecutions = summary.completedTraces + summary.failedTraces;
  const openIncidents = alerts.incidents.filter(incident => incident.state === 'firing');
  const criticalIncidents = openIncidents.filter(incident => incident.severity === 'critical').length;
  const warningIncidents = openIncidents.filter(incident => incident.severity === 'warning').length;

  let state: NativeServiceHealthState;
  if (criticalIncidents > 0 || terminalExecutions > 0 && summary.successRate < 90) state = 'critical';
  else if (openIncidents.length > 0 || terminalExecutions > 0 && summary.successRate < RELIABILITY_OBJECTIVE || summary.p95DurationMs > LATENCY_OBJECTIVE_MS) state = 'degraded';
  else if (summary.totalTraces === 0) state = 'no_data';
  else state = 'healthy';

  const latencyScore = summary.totalTraces === 0
    ? 0
    : summary.p95DurationMs <= 0 ? 100 : clamp(100 * LATENCY_OBJECTIVE_MS / summary.p95DurationMs);
  const incidentScore = criticalIncidents > 0 ? 0 : warningIncidents > 0 || openIncidents.length > 0 ? 60 : 100;
  const score = summary.totalTraces === 0 && openIncidents.length === 0
    ? null
    : Math.round(clamp(summary.successRate * 0.65 + latencyScore * 0.2 + incidentScore * 0.15));

  const allowedFailures = terminalExecutions * (1 - RELIABILITY_OBJECTIVE / 100);
  const remainingPercent = terminalExecutions === 0
    ? 100
    : clamp(100 - 100 * summary.failedTraces / Math.max(allowedFailures, Number.EPSILON));
  const reliabilityState: NativeSloState = terminalExecutions === 0
    ? 'no_data'
    : summary.successRate >= RELIABILITY_OBJECTIVE ? 'met' : 'breached';
  const latencyState: NativeSloState = summary.totalTraces === 0
    ? 'no_data'
    : summary.p95DurationMs <= LATENCY_OBJECTIVE_MS ? 'met' : 'breached';
  const incidentState: NativeSloState = summary.totalTraces === 0 && openIncidents.length === 0
    ? 'no_data'
    : criticalIncidents === 0 ? 'met' : 'breached';

  const components: NativeServiceHealthComponent[] = [
    ...analytics.agents.map(item => ({
      id: `agent:${item.id ?? item.name}`, kind: 'agent' as const, name: item.name,
      detail: 'Agent executions', executions: item.executions, failures: item.failures,
      successRate: item.successRate, p95DurationMs: item.p95DurationMs, costUsd: item.costUsd,
      state: componentState(item.executions, item.successRate, item.p95DurationMs),
    })),
    ...analytics.workflows.map(item => ({
      id: `workflow:${item.id ?? item.name}`, kind: 'workflow' as const, name: item.name,
      detail: 'Workflow executions', executions: item.executions, failures: item.failures,
      successRate: item.successRate, p95DurationMs: item.p95DurationMs, costUsd: 0,
      state: componentState(item.executions, item.successRate, item.p95DurationMs),
    })),
    ...analytics.models.map(item => {
      const successRate = item.calls > 0 ? 100 * (item.calls - item.failures) / item.calls : 0;
      return {
        id: `model:${item.provider}:${item.model}`, kind: 'model' as const, name: item.model,
        detail: item.provider, executions: item.calls, failures: item.failures, successRate,
        p95DurationMs: item.p95DurationMs, costUsd: item.costUsd,
        state: componentState(item.calls, successRate, item.p95DurationMs),
      };
    }),
    ...analytics.tools.map(item => {
      const successRate = item.calls > 0 ? 100 * (item.calls - item.failures) / item.calls : 0;
      return {
        id: `tool:${item.tool}`, kind: 'tool' as const, name: item.tool,
        detail: 'MCP capability', executions: item.calls, failures: item.failures, successRate,
        p95DurationMs: item.p95DurationMs, costUsd: 0,
        state: componentState(item.calls, successRate, item.p95DurationMs),
      };
    }),
  ].sort(componentSort);

  const recommendations: NativeServiceHealth['recommendations'] = [];
  if (criticalIncidents > 0) recommendations.push({
    severity: 'critical', title: 'Investigate active critical incidents',
    description: `${criticalIncidents} critical incident${criticalIncidents === 1 ? '' : 's'} require attention.`, href: '/observe/alerts',
  });
  if (reliabilityState === 'breached') recommendations.push({
    severity: 'warning', title: 'Reliability objective is breached',
    description: `Success is ${summary.successRate.toFixed(1)}% against a ${RELIABILITY_OBJECTIVE}% objective.`, href: '/observe',
  });
  if (latencyState === 'breached') recommendations.push({
    severity: 'warning', title: 'P95 latency exceeds target',
    description: `P95 is ${(summary.p95DurationMs / 1000).toFixed(1)}s against a 30s target.`, href: '/observe',
  });
  if (summary.totalTraces === 0) recommendations.push({
    severity: 'info', title: 'No execution evidence in this window',
    description: 'Run an agent or workflow to establish a native health baseline.', href: '/runs',
  });
  if (recommendations.length === 0) recommendations.push({
    severity: 'info', title: 'Objectives are within target',
    description: 'No immediate reliability or latency action is required.', href: '/observe',
  });

  return {
    state,
    score,
    summary: {
      totalExecutions: summary.totalTraces,
      successRate: summary.successRate,
      p95DurationMs: summary.p95DurationMs,
      totalCostUsd: summary.totalCostUsd,
      firingIncidents: openIncidents.length,
      criticalIncidents,
    },
    errorBudget: {
      objective: RELIABILITY_OBJECTIVE,
      terminalExecutions,
      allowedFailures,
      actualFailures: summary.failedTraces,
      remainingPercent,
      state: reliabilityState,
    },
    slos: [
      { id: 'reliability', name: 'Execution reliability', state: reliabilityState, target: '≥ 95%', actual: terminalExecutions ? `${summary.successRate.toFixed(1)}%` : 'No data', description: 'Completed executions among all terminal traces.' },
      { id: 'latency', name: 'Interaction latency', state: latencyState, target: 'P95 ≤ 30s', actual: summary.totalTraces ? `${(summary.p95DurationMs / 1000).toFixed(1)}s` : 'No data', description: 'End-to-end duration across native traces.' },
      { id: 'incidents', name: 'Critical incidents', state: incidentState, target: '0 open', actual: `${criticalIncidents} open`, description: 'Open critical incidents from native alert policies.' },
    ],
    components,
    openIncidents: openIncidents.slice(0, 10),
    recommendations,
  };
}
