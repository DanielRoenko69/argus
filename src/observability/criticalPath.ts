import type { TelemetryStatus, TelemetryTraceKind, TelemetrySpanKind } from './telemetryStore.js';

interface TraceNodeInput {
  id: string;
  parent_trace_id: string | null;
  parent_span_id: string | null;
  name: string;
  kind: TelemetryTraceKind;
  status: TelemetryStatus;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
}

interface SpanNodeInput {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  kind: TelemetrySpanKind;
  status: TelemetryStatus;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  tool_name: string | null;
}

interface AnalysisNode {
  key: string;
  id: string;
  parentKey: string | null;
  nodeType: 'run' | 'span';
  kind: string;
  label: string;
  status: TelemetryStatus;
  start: number;
  end: number;
  durationMs: number;
}

export interface NativeCriticalPathAnalysis {
  criticalPath: string[];
  bottleneck: null | {
    key: string;
    id: string;
    nodeType: 'run' | 'span';
    kind: string;
    label: string;
    durationMs: number;
    selfTimeMs: number;
    sharePercent: number;
  };
  totalDurationMs: number;
  maxConcurrency: number;
  failedNodes: number;
}

function time(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intervalUnionMs(intervals: Array<{ start: number; end: number }>): number {
  const ordered = intervals
    .filter(interval => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (ordered.length === 0) return 0;
  let total = 0;
  let start = ordered[0]!.start;
  let end = ordered[0]!.end;
  for (const interval of ordered.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
      continue;
    }
    total += end - start;
    start = interval.start;
    end = interval.end;
  }
  return total + end - start;
}

export function analyzeTelemetryTraceFamily(
  traces: TraceNodeInput[],
  spans: SpanNodeInput[],
  now = Date.now(),
): NativeCriticalPathAnalysis {
  const visibleTraces = traces.filter(trace => trace.kind === 'agent' || trace.kind === 'workflow');
  const runKeys = new Set(visibleTraces.map(trace => `run:${trace.id}`));
  const visibleSpans = spans.filter(span => runKeys.has(`run:${span.trace_id}`));
  const spanKeys = new Set(visibleSpans.map(span => `span:${span.id}`));

  const interval = (startedAt: string, endedAt: string | null, durationMs: number | null) => {
    const start = time(startedAt) ?? now;
    const explicitEnd = time(endedAt);
    const end = explicitEnd ?? (durationMs == null ? now : start + Math.max(0, Number(durationMs)));
    return { start, end: Math.max(start, end), durationMs: Math.max(0, end - start) };
  };
  const nodes: AnalysisNode[] = [
    ...visibleTraces.map(trace => {
      const timing = interval(trace.started_at, trace.ended_at, trace.duration_ms);
      return {
        key: `run:${trace.id}`,
        id: trace.id,
        parentKey: trace.parent_span_id && spanKeys.has(`span:${trace.parent_span_id}`)
          ? `span:${trace.parent_span_id}`
          : trace.parent_trace_id && runKeys.has(`run:${trace.parent_trace_id}`)
            ? `run:${trace.parent_trace_id}`
            : null,
        nodeType: 'run' as const,
        kind: trace.kind,
        label: trace.name,
        status: trace.status,
        ...timing,
      };
    }),
    ...visibleSpans.map(span => {
      const timing = interval(span.started_at, span.ended_at, span.duration_ms);
      return {
        key: `span:${span.id}`,
        id: span.id,
        parentKey: span.parent_span_id && spanKeys.has(`span:${span.parent_span_id}`)
          ? `span:${span.parent_span_id}`
          : `run:${span.trace_id}`,
        nodeType: 'span' as const,
        kind: span.kind,
        label: span.tool_name || span.name,
        status: span.status,
        ...timing,
      };
    }),
  ];
  if (nodes.length === 0) {
    return { criticalPath: [], bottleneck: null, totalDurationMs: 0, maxConcurrency: 0, failedNodes: 0 };
  }

  const byKey = new Map(nodes.map(node => [node.key, node]));
  const children = new Map<string, AnalysisNode[]>();
  for (const node of nodes) {
    if (!node.parentKey || !byKey.has(node.parentKey)) continue;
    const nested = children.get(node.parentKey) ?? [];
    nested.push(node);
    children.set(node.parentKey, nested);
  }
  const selfTime = new Map<string, number>();
  for (const node of nodes) {
    const nestedIntervals = (children.get(node.key) ?? []).map(child => ({
      start: Math.max(node.start, child.start),
      end: Math.min(node.end, child.end),
    }));
    selfTime.set(node.key, Math.max(0, node.durationMs - intervalUnionMs(nestedIntervals)));
  }

  const familyStart = Math.min(...nodes.map(node => node.start));
  const familyEnd = Math.max(...nodes.map(node => node.end));
  const totalDurationMs = Math.max(0, familyEnd - familyStart);
  const spanCandidates = nodes.filter(node => node.nodeType === 'span' && node.durationMs > 0);
  const candidates = spanCandidates.length > 0
    ? spanCandidates
    : nodes.filter(node => node.parentKey != null && node.durationMs > 0);
  const bottleneckNode = candidates.sort((left, right) =>
    (selfTime.get(right.key) ?? 0) - (selfTime.get(left.key) ?? 0)
    || right.durationMs - left.durationMs,
  )[0] ?? null;

  const criticalPath: string[] = [];
  const pathVisited = new Set<string>();
  let cursor: AnalysisNode | null = bottleneckNode;
  while (cursor && !pathVisited.has(cursor.key)) {
    criticalPath.unshift(cursor.key);
    pathVisited.add(cursor.key);
    cursor = cursor.parentKey ? byKey.get(cursor.parentKey) ?? null : null;
  }

  const concurrencyEvents = visibleSpans.flatMap(span => {
    const timing = interval(span.started_at, span.ended_at, span.duration_ms);
    return timing.end > timing.start
      ? [{ at: timing.start, delta: 1 }, { at: timing.end, delta: -1 }]
      : [];
  }).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maxConcurrency = 0;
  for (const event of concurrencyEvents) {
    active += event.delta;
    maxConcurrency = Math.max(maxConcurrency, active);
  }

  const bottleneckSelfTime = bottleneckNode ? selfTime.get(bottleneckNode.key) ?? 0 : 0;
  return {
    criticalPath,
    bottleneck: bottleneckNode ? {
      key: bottleneckNode.key,
      id: bottleneckNode.id,
      nodeType: bottleneckNode.nodeType,
      kind: bottleneckNode.kind,
      label: bottleneckNode.label,
      durationMs: bottleneckNode.durationMs,
      selfTimeMs: bottleneckSelfTime,
      sharePercent: totalDurationMs > 0 ? Math.min(100, 100 * bottleneckSelfTime / totalDurationMs) : 0,
    } : null,
    totalDurationMs,
    maxConcurrency,
    failedNodes: nodes.filter(node => node.status === 'failed' || node.status === 'cancelled').length,
  };
}
