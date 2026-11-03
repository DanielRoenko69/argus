import type {
  TelemetrySpanKind,
  TelemetrySpanRow,
  TelemetryStatus,
  TelemetryTraceFamilyRow,
  TelemetryTraceKind,
} from './telemetryStore.js';
import { analyzeTelemetryTraceFamily } from './criticalPath.js';

interface ComparisonTraceInput {
  id: string;
  parent_trace_id: string | null;
  parent_span_id: string | null;
  name: string;
  kind: TelemetryTraceKind;
  status: TelemetryStatus;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  total_cost_usd: number;
}

interface ComparisonSpanInput {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  kind: TelemetrySpanKind;
  status: TelemetryStatus;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  total_cost_usd: number;
  tool_name: string | null;
}

interface ComparisonNode {
  key: string;
  parentKey: string | null;
  nodeType: 'run' | 'span';
  kind: string;
  label: string;
  status: TelemetryStatus;
  startedAt: string;
  durationMs: number;
  costUsd: number;
}

export interface NativeTraceComparison {
  baseline: {
    rootTraceId: string;
    startedAt: string;
    status: TelemetryStatus;
    durationMs: number;
    costUsd: number;
    failedNodes: number;
  };
  current: {
    rootTraceId: string;
    durationMs: number;
    costUsd: number;
    failedNodes: number;
  };
  summary: {
    durationDeltaMs: number;
    durationDeltaPercent: number | null;
    costDeltaUsd: number;
    costDeltaPercent: number | null;
    failedNodeDelta: number;
    regressionCount: number;
    improvementCount: number;
  };
  changes: Array<{
    signature: string;
    label: string;
    kind: string;
    nodeType: 'run' | 'span';
    change: 'regression' | 'improvement' | 'new' | 'removed' | 'status_regression';
    currentStatus: TelemetryStatus | null;
    baselineStatus: TelemetryStatus | null;
    currentDurationMs: number | null;
    baselineDurationMs: number | null;
    durationDeltaMs: number | null;
    durationDeltaPercent: number | null;
    currentCostUsd: number | null;
    baselineCostUsd: number | null;
    costDeltaUsd: number | null;
  }>;
}

function numeric(value: number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function duration(startedAt: string, endedAt: string | null, durationMs: number | null): number {
  if (durationMs != null) return Math.max(0, numeric(durationMs));
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function percent(delta: number, baseline: number): number | null {
  return baseline > 0 ? 100 * delta / baseline : null;
}

function familyCost(traces: ComparisonTraceInput[], spans: ComparisonSpanInput[]): number {
  const spanCost = spans.reduce((total, span) => total + Math.max(0, numeric(span.total_cost_usd)), 0);
  if (spanCost > 0) return spanCost;
  const childRuns = traces.filter(trace => trace.parent_trace_id != null || trace.parent_span_id != null);
  const candidates = childRuns.length > 0 ? childRuns : traces;
  return candidates.reduce((total, trace) => total + Math.max(0, numeric(trace.total_cost_usd)), 0);
}

export function summarizeTelemetryTraceFamily(
  family: { traces: ComparisonTraceInput[]; spans: ComparisonSpanInput[] },
): { durationMs: number; costUsd: number; failedNodes: number } {
  const analysis = analyzeTelemetryTraceFamily(family.traces, family.spans);
  return {
    durationMs: analysis.totalDurationMs,
    costUsd: familyCost(family.traces, family.spans),
    failedNodes: analysis.failedNodes,
  };
}

function stableNodes(traces: ComparisonTraceInput[], spans: ComparisonSpanInput[]): Map<string, ComparisonNode> {
  const runKeys = new Set(traces.map(trace => `run:${trace.id}`));
  const spanKeys = new Set(spans.map(span => `span:${span.id}`));
  const nodes: ComparisonNode[] = [
    ...traces.map(trace => ({
      key: `run:${trace.id}`,
      parentKey: trace.parent_span_id && spanKeys.has(`span:${trace.parent_span_id}`)
        ? `span:${trace.parent_span_id}`
        : trace.parent_trace_id && runKeys.has(`run:${trace.parent_trace_id}`)
          ? `run:${trace.parent_trace_id}`
          : null,
      nodeType: 'run' as const,
      kind: trace.kind,
      label: trace.name,
      status: trace.status,
      startedAt: trace.started_at,
      durationMs: duration(trace.started_at, trace.ended_at, trace.duration_ms),
      costUsd: Math.max(0, numeric(trace.total_cost_usd)),
    })),
    ...spans.filter(span => runKeys.has(`run:${span.trace_id}`)).map(span => ({
      key: `span:${span.id}`,
      parentKey: span.parent_span_id && spanKeys.has(`span:${span.parent_span_id}`)
        ? `span:${span.parent_span_id}`
        : `run:${span.trace_id}`,
      nodeType: 'span' as const,
      kind: span.kind,
      label: span.tool_name || span.name,
      status: span.status,
      startedAt: span.started_at,
      durationMs: duration(span.started_at, span.ended_at, span.duration_ms),
      costUsd: Math.max(0, numeric(span.total_cost_usd)),
    })),
  ];
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const children = new Map<string | null, ComparisonNode[]>();
  for (const node of nodes) {
    const parentKey = node.parentKey && byKey.has(node.parentKey) ? node.parentKey : null;
    const siblings = children.get(parentKey) ?? [];
    siblings.push(node);
    children.set(parentKey, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.key.localeCompare(right.key));
  }

  const stable = new Map<string, ComparisonNode>();
  const visited = new Set<string>();
  const append = (node: ComparisonNode, parentSignature: string) => {
    if (visited.has(node.key)) return;
    visited.add(node.key);
    const siblings = children.get(node.parentKey && byKey.has(node.parentKey) ? node.parentKey : null) ?? [];
    const token = `${node.nodeType}:${node.kind}:${node.label}`;
    const occurrence = siblings.filter(sibling =>
      `${sibling.nodeType}:${sibling.kind}:${sibling.label}` === token
      && (Date.parse(sibling.startedAt) < Date.parse(node.startedAt)
        || (sibling.startedAt === node.startedAt && sibling.key.localeCompare(node.key) < 0)),
    ).length + 1;
    const signature = `${parentSignature}/${token}#${occurrence}`;
    stable.set(signature, node);
    for (const child of children.get(node.key) ?? []) append(child, signature);
  };
  for (const root of children.get(null) ?? []) append(root, '');
  for (const orphan of nodes) append(orphan, '');
  return stable;
}

function failed(status: TelemetryStatus | null): boolean {
  return status === 'failed' || status === 'cancelled';
}

export function compareTelemetryTraceFamilies(
  current: { traces: ComparisonTraceInput[]; spans: ComparisonSpanInput[] },
  baseline: { traces: ComparisonTraceInput[]; spans: ComparisonSpanInput[] },
): NativeTraceComparison | null {
  if (current.traces.length === 0 || baseline.traces.length === 0) return null;
  const currentSummary = summarizeTelemetryTraceFamily(current);
  const baselineSummary = summarizeTelemetryTraceFamily(baseline);
  const currentRoot = current.traces.find(trace => trace.id === trace.parent_trace_id)
    ?? current.traces.find(trace => trace.parent_trace_id == null && trace.parent_span_id == null)
    ?? current.traces[0]!;
  const baselineRoot = baseline.traces.find(trace => trace.id === trace.parent_trace_id)
    ?? baseline.traces.find(trace => trace.parent_trace_id == null && trace.parent_span_id == null)
    ?? baseline.traces[0]!;
  const currentNodes = stableNodes(current.traces, current.spans);
  const baselineNodes = stableNodes(baseline.traces, baseline.spans);
  const signatures = new Set([...currentNodes.keys(), ...baselineNodes.keys()]);
  const changes: NativeTraceComparison['changes'] = [];

  for (const signature of signatures) {
    const currentNode = currentNodes.get(signature) ?? null;
    const baselineNode = baselineNodes.get(signature) ?? null;
    if (!currentNode && !baselineNode) continue;
    // The root duration is already represented in the comparison summary.
    if (currentNode?.parentKey == null && baselineNode?.parentKey == null) continue;
    const durationDeltaMs = currentNode && baselineNode ? currentNode.durationMs - baselineNode.durationMs : null;
    const durationDeltaPercent = durationDeltaMs == null ? null : percent(durationDeltaMs, baselineNode!.durationMs);
    const costDeltaUsd = currentNode && baselineNode ? currentNode.costUsd - baselineNode.costUsd : null;
    let change: NativeTraceComparison['changes'][number]['change'] | null = null;
    if (!baselineNode) change = 'new';
    else if (!currentNode) change = 'removed';
    else if (failed(currentNode.status) && !failed(baselineNode.status)) change = 'status_regression';
    else {
      const slower = durationDeltaMs! > 50 && (durationDeltaPercent ?? 0) > 10;
      const costlier = costDeltaUsd! > 0.000001 && percent(costDeltaUsd!, baselineNode.costUsd) != null
        && percent(costDeltaUsd!, baselineNode.costUsd)! > 10;
      const faster = durationDeltaMs! < -50 && (durationDeltaPercent ?? 0) < -10;
      const cheaper = costDeltaUsd! < -0.000001 && (percent(costDeltaUsd!, baselineNode.costUsd) ?? 0) < -10;
      if (slower || costlier) change = 'regression';
      else if (faster || cheaper || (failed(baselineNode.status) && !failed(currentNode.status))) change = 'improvement';
    }
    if (!change) continue;
    const node = currentNode ?? baselineNode!;
    changes.push({
      signature,
      label: node.label,
      kind: node.kind,
      nodeType: node.nodeType,
      change,
      currentStatus: currentNode?.status ?? null,
      baselineStatus: baselineNode?.status ?? null,
      currentDurationMs: currentNode?.durationMs ?? null,
      baselineDurationMs: baselineNode?.durationMs ?? null,
      durationDeltaMs,
      durationDeltaPercent,
      currentCostUsd: currentNode?.costUsd ?? null,
      baselineCostUsd: baselineNode?.costUsd ?? null,
      costDeltaUsd,
    });
  }
  const priority: Record<NativeTraceComparison['changes'][number]['change'], number> = {
    status_regression: 5, regression: 4, new: 3, improvement: 2, removed: 1,
  };
  changes.sort((left, right) =>
    priority[right.change] - priority[left.change]
    || Math.abs(right.durationDeltaPercent ?? 0) - Math.abs(left.durationDeltaPercent ?? 0)
    || Math.abs(right.costDeltaUsd ?? 0) - Math.abs(left.costDeltaUsd ?? 0),
  );

  const currentCost = currentSummary.costUsd;
  const baselineCost = baselineSummary.costUsd;
  const durationDeltaMs = currentSummary.durationMs - baselineSummary.durationMs;
  const costDeltaUsd = currentCost - baselineCost;
  return {
    baseline: {
      rootTraceId: baselineRoot.id,
      startedAt: baselineRoot.started_at,
      status: baselineRoot.status,
      durationMs: baselineSummary.durationMs,
      costUsd: baselineCost,
      failedNodes: baselineSummary.failedNodes,
    },
    current: {
      rootTraceId: currentRoot.id,
      durationMs: currentSummary.durationMs,
      costUsd: currentCost,
      failedNodes: currentSummary.failedNodes,
    },
    summary: {
      durationDeltaMs,
      durationDeltaPercent: percent(durationDeltaMs, baselineSummary.durationMs),
      costDeltaUsd,
      costDeltaPercent: percent(costDeltaUsd, baselineCost),
      failedNodeDelta: currentSummary.failedNodes - baselineSummary.failedNodes,
      regressionCount: changes.filter(change => change.change === 'regression' || change.change === 'status_regression').length,
      improvementCount: changes.filter(change => change.change === 'improvement').length,
    },
    changes: changes.slice(0, 12),
  };
}

export type TraceComparisonFamily = {
  traces: TelemetryTraceFamilyRow[];
  spans: TelemetrySpanRow[];
};
