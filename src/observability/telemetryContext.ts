import { AsyncLocalStorage } from 'node:async_hooks';

/** Minimal correlation envelope shared by native telemetry and structured logs. */
export interface NativeTelemetryContext {
  rootTraceId: string;
  traceId: string;
  spanId?: string | null;
  userId?: number | null;
  agentId?: number | null;
  /** Portable workflow contract role assigned to the current Agent step. */
  agentRole?: string | null;
  /** Workflow step that produced the current Agent trace. */
  workflowStepId?: string | null;
  workflowId?: number | null;
  workflowExecutionId?: number | null;
  tenantKey?: string;
  workspaceKey?: string;
}

const nativeTelemetryContext = new AsyncLocalStorage<NativeTelemetryContext>();

export function getNativeTelemetryContext(): NativeTelemetryContext | null {
  return nativeTelemetryContext.getStore() ?? null;
}

/** Run an operation with trace fields automatically available to the logger. */
export function withNativeTelemetryContext<T>(
  context: NativeTelemetryContext,
  operation: () => T,
): T {
  return nativeTelemetryContext.run(context, operation);
}
