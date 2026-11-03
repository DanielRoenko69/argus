export type SolutionPackRuntimeMode = 'auto' | 'default' | 'managed-hermes';
export type EffectiveSolutionPackRuntimeMode = Exclude<SolutionPackRuntimeMode, 'auto'>;

export type RuntimeSelectionReason =
  | 'explicit_default'
  | 'explicit_managed_hermes'
  | 'workflow_requires_coder_workspace_write'
  | 'workflow_uses_agent_default'
  | 'managed_hermes_unavailable_use_agent_default';

export interface SolutionPackRuntimeSelection {
  source: 'argus.core';
  kind: 'runtime-selection';
  requestedMode: SolutionPackRuntimeMode;
  effectiveMode: EffectiveSolutionPackRuntimeMode;
  reason: RuntimeSelectionReason;
  workflowId: string;
}

export interface WorkflowRuntimeContract {
  id: string;
  requiredAgents?: unknown;
  stages?: unknown;
}

function hasCoderWriteStage(workflow: WorkflowRuntimeContract): boolean {
  const requiredAgents = Array.isArray(workflow.requiredAgents)
    ? workflow.requiredAgents.filter((value): value is string => typeof value === 'string')
    : [];
  const stageKinds = Array.isArray(workflow.stages)
    ? workflow.stages.flatMap(stage => {
        if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return [];
        const kind = (stage as Record<string, unknown>)['kind'];
        return typeof kind === 'string' ? [kind] : [];
      })
    : [];
  return requiredAgents.includes('coder') && stageKinds.includes('code');
}

/**
 * Deterministic policy for the product-level runtime choice. It deliberately
 * reads only the signed workflow contract and never free-form user text.
 */
export function resolveSolutionPackRuntimeSelection(
  requestedMode: SolutionPackRuntimeMode | undefined,
  workflow: WorkflowRuntimeContract,
  options: { managedHermesAvailable?: boolean } = {},
): SolutionPackRuntimeSelection {
  const requested = requestedMode ?? 'default';
  if (requested === 'managed-hermes') {
    return {
      source: 'argus.core', kind: 'runtime-selection', requestedMode: requested,
      effectiveMode: 'managed-hermes', reason: 'explicit_managed_hermes', workflowId: workflow.id,
    };
  }
  if (requested === 'default') {
    return {
      source: 'argus.core', kind: 'runtime-selection', requestedMode: requested,
      effectiveMode: 'default', reason: 'explicit_default', workflowId: workflow.id,
    };
  }
  const managed = hasCoderWriteStage(workflow);
  const managedAvailable = options.managedHermesAvailable ?? true;
  return {
    source: 'argus.core', kind: 'runtime-selection', requestedMode: requested,
    effectiveMode: managed && managedAvailable ? 'managed-hermes' : 'default',
    reason: managed && !managedAvailable
      ? 'managed_hermes_unavailable_use_agent_default'
      : managed ? 'workflow_requires_coder_workspace_write' : 'workflow_uses_agent_default',
    workflowId: workflow.id,
  };
}
