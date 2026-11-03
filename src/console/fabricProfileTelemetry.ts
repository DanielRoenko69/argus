import { metrics, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

export type FabricProfileOperation = 'list' | 'versions' | 'diff' | 'export' | 'preview' | 'apply' | 'drift_check' | 'drift_sweep';

export interface FabricProfileTelemetryContext {
  traceId: string | null;
  spanId: string | null;
  setAttributes(attributes: Attributes): void;
}

const W3C_TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}(?:-.+)?$/i;

export function resolveFabricProfileCorrelation(
  traceparent: unknown,
  active: Pick<FabricProfileTelemetryContext, 'traceId' | 'spanId'>,
): { traceId: string | null; spanId: string | null } {
  if (active.traceId && active.spanId) return { traceId: active.traceId, spanId: active.spanId };
  const raw = Array.isArray(traceparent) ? traceparent[0] : traceparent;
  const match = typeof raw === 'string' ? W3C_TRACEPARENT.exec(raw.trim()) : null;
  const parentTraceId = match?.[1]?.toLowerCase() ?? null;
  const parentSpanId = match?.[2]?.toLowerCase() ?? null;
  return {
    traceId: active.traceId ?? (parentTraceId && !/^0+$/.test(parentTraceId) ? parentTraceId : null),
    spanId: active.spanId ?? (parentSpanId && !/^0+$/.test(parentSpanId) ? parentSpanId : null),
  };
}

const tracer = trace.getTracer('argus-core.mcp-fabric-profiles');
const meter = metrics.getMeter('argus-core.mcp-fabric-profiles');
const operationCounter = meter.createCounter('argus.mcp_fabric.profile.operations', {
  description: 'MCP Fabric profile lifecycle operations by bounded operation and outcome.',
  unit: '{operation}',
});
const operationDuration = meter.createHistogram('argus.mcp_fabric.profile.operation.duration', {
  description: 'Duration of MCP Fabric profile lifecycle operations.',
  unit: 'ms',
});
const driftFindingHistogram = meter.createHistogram('argus.mcp_fabric.profile.drift.findings', {
  description: 'Number of findings returned by an MCP Fabric profile drift check.',
  unit: '{finding}',
});
const driftTransitionCounter = meter.createCounter('argus.mcp_fabric.profile.drift.transitions', {
  description: 'MCP Fabric profile drift state transitions by bounded target state.',
  unit: '{transition}',
});
const driftNotificationCounter = meter.createCounter('argus.mcp_fabric.profile.drift.notifications', {
  description: 'MCP Fabric profile drift notification attempts by bounded kind and outcome.',
  unit: '{notification}',
});

export async function observeFabricProfileOperation<T>(
  operation: FabricProfileOperation,
  execute: (context: FabricProfileTelemetryContext) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  return tracer.startActiveSpan(`argus.mcp_fabric.profile.${operation}`, async span => {
    const spanContext = span.spanContext();
    const context: FabricProfileTelemetryContext = {
      traceId: spanContext.isRemote || spanContext.traceId === '00000000000000000000000000000000'
        ? null
        : spanContext.traceId,
      spanId: spanContext.spanId === '0000000000000000' ? null : spanContext.spanId,
      setAttributes: attributes => span.setAttributes(attributes),
    };
    try {
      const result = await execute(context);
      operationCounter.add(1, { 'argus.fabric_profile.operation': operation, 'argus.outcome': 'success' });
      operationDuration.record(Date.now() - startedAt, { 'argus.fabric_profile.operation': operation, 'argus.outcome': 'success' });
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      operationCounter.add(1, { 'argus.fabric_profile.operation': operation, 'argus.outcome': 'failure' });
      operationDuration.record(Date.now() - startedAt, { 'argus.fabric_profile.operation': operation, 'argus.outcome': 'failure' });
      const normalized = error instanceof Error ? error : new Error(String(error));
      span.recordException(normalized);
      span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function recordFabricProfileDriftFindings(
  status: 'in_sync' | 'drifted' | 'not_applied',
  findingCount: number,
): void {
  const attributes = { 'argus.fabric_profile.drift_status': status };
  driftFindingHistogram.record(findingCount, attributes);
  trace.getActiveSpan()?.setAttributes({
    ...attributes,
    'argus.fabric_profile.drift_finding_count': findingCount,
  });
}

export function recordFabricProfileDriftTransition(
  status: 'in_sync' | 'drifted' | 'not_applied',
): void {
  driftTransitionCounter.add(1, { 'argus.fabric_profile.drift_status': status });
}

export function recordFabricProfileDriftNotification(
  kind: 'drift' | 'recovery' | 'check_failure',
  outcome: 'success' | 'failure',
): void {
  driftNotificationCounter.add(1, {
    'argus.fabric_profile.notification_kind': kind,
    'argus.outcome': outcome,
  });
}
