import { metrics, trace, type Attributes } from '@opentelemetry/api';
import { logger } from '../lib/logger.js';
import type { SolutionPackRuntimeSelection } from './runtimeSelection.js';

const meter = metrics.getMeter('argus-core.solution-packs');
const runtimeSelectionCounter = meter.createCounter('argus.solution_pack.runtime_selection.decisions', {
  description: 'Core-owned Solution Pack runtime-routing decisions.',
  unit: '{decision}',
});

export interface RuntimeSelectionTelemetryContext {
  rootTraceId: string;
  packId: string;
  agentId: string;
  operation: string;
}

export function runtimeSelectionMetricAttributes(
  selection: SolutionPackRuntimeSelection,
  operation: string,
): Attributes {
  return {
    'argus.runtime.requested': selection.requestedMode,
    'argus.runtime.effective': selection.effectiveMode,
    'argus.runtime.reason': selection.reason,
    'argus.solution_pack.operation': operation,
  };
}

/**
 * Record one deterministic routing decision without introducing
 * high-cardinality metric labels. Workflow and trace identifiers remain in
 * structured logs and trace fields, while the counter contains only bounded
 * enums suitable for dashboards and alerts.
 */
export function recordSolutionPackRuntimeSelection(
  selection: SolutionPackRuntimeSelection,
  context: RuntimeSelectionTelemetryContext,
): void {
  const attributes = runtimeSelectionMetricAttributes(selection, context.operation);

  runtimeSelectionCounter.add(1, attributes);
  trace.getActiveSpan()?.setAttributes({
    ...attributes,
    'argus.solution_pack.id': context.packId,
    'argus.solution_pack.agent_id': context.agentId,
    'argus.solution_pack.workflow_id': selection.workflowId,
    'argus.root_trace_id': context.rootTraceId,
  });
  logger.info({
    rootTraceId: context.rootTraceId,
    packId: context.packId,
    packAgentId: context.agentId,
    operation: context.operation,
    workflowId: selection.workflowId,
    requestedRuntimeMode: selection.requestedMode,
    effectiveRuntimeMode: selection.effectiveMode,
    runtimeSelectionReason: selection.reason,
  }, 'Solution Pack runtime selected');
}
