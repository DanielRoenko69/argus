import type { WorkflowPaletteTool } from './integrationCatalog.js';
import type { WorkflowStep, WorkflowToolBinding } from './types.js';

export interface WorkflowToolBindingResolution {
  stepId: string;
  stepLabel: string;
  integrationId: string;
  integrationLabel: string;
  access: 'read' | 'write';
  actionHints: string[];
  requiredParameters: string[];
  toolName: string | null;
  connectionName: string | null;
  ready: boolean;
  issue: string | null;
}

export interface WorkflowToolBindingResult {
  ready: boolean;
  steps: WorkflowStep[];
  blockDefinitions: unknown[];
  resolutions: WorkflowToolBindingResolution[];
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function validBinding(value: unknown): value is WorkflowToolBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Partial<WorkflowToolBinding>;
  return typeof binding.integration_id === 'string'
    && binding.integration_id.trim().length > 0
    && (binding.access === 'read' || binding.access === 'write')
    && Array.isArray(binding.action_hints)
    && binding.action_hints.some(hint => typeof hint === 'string' && hint.trim().length > 0)
    && (binding.required_parameters == null || (
      Array.isArray(binding.required_parameters)
      && binding.required_parameters.every(parameter => typeof parameter === 'string')
    ));
}

function candidateScore(
  tool: WorkflowPaletteTool,
  binding: WorkflowToolBinding,
  args: Record<string, unknown>,
): number | null {
  if (tool.integration_id !== binding.integration_id) return null;
  if (binding.access === 'read' ? tool.is_write : !tool.is_write) return null;

  const toolName = normalized(tool.name);
  const actionLabel = normalized(tool.action_label);
  const hints = binding.action_hints.map(normalized).filter(Boolean);
  const matchingHint = hints
    .map(hint => ({ hint, exact: toolName.endsWith(hint) || actionLabel === hint }))
    .filter(match => toolName.includes(match.hint) || actionLabel.includes(match.hint))
    .sort((left, right) => Number(right.exact) - Number(left.exact) || right.hint.length - left.hint.length)[0];
  if (!matchingHint) return null;

  const required = (binding.required_parameters ?? []).map(normalized);
  const parameters = new Set(tool.parameters.map(parameter => normalized(parameter.name)));
  if (tool.schema === 'typed' && required.some(parameter => !parameters.has(parameter))) return null;
  const suppliedArgs = new Set(Object.keys(args).map(normalized));
  if (tool.schema === 'typed' && tool.parameters.some(parameter => (
    parameter.required
    && parameter.default === undefined
    && !suppliedArgs.has(normalized(parameter.name))
  ))) return null;

  return (matchingHint.exact ? 1_000 : 500)
    + matchingHint.hint.length
    + (tool.schema === 'typed' ? 100 : 0)
    + required.filter(parameter => parameters.has(parameter)).length * 10;
}

function resolveOne(
  step: WorkflowStep,
  binding: WorkflowToolBinding,
  tools: WorkflowPaletteTool[],
): { tool: WorkflowPaletteTool | null; resolution: WorkflowToolBindingResolution } {
  const candidates = tools
    .map(tool => ({ tool, score: candidateScore(tool, binding, step.args ?? {}) }))
    .filter((candidate): candidate is { tool: WorkflowPaletteTool; score: number } => candidate.score != null)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
  const tool = candidates[0]?.tool ?? null;
  const integrationLabel = tool?.integration_label
    ?? binding.integration_id.split('-').map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');
  const expectedAction = binding.action_hints.join(' / ');
  const issue = tool
    ? null
    : `No accessible ${integrationLabel} ${binding.access} tool matches ${expectedAction}.`;
  return {
    tool,
    resolution: {
      stepId: step.id,
      stepLabel: step.label,
      integrationId: binding.integration_id,
      integrationLabel,
      access: binding.access,
      actionHints: [...binding.action_hints],
      requiredParameters: [...(binding.required_parameters ?? [])],
      toolName: tool?.name ?? null,
      connectionName: tool?.connection_name ?? null,
      ready: tool != null,
      issue,
    },
  };
}

/** Resolve template-owned capability contracts against the RBAC-filtered MCP catalog. */
export function resolveWorkflowToolBindings(
  steps: WorkflowStep[],
  blockDefinitions: unknown[],
  tools: WorkflowPaletteTool[],
): WorkflowToolBindingResult {
  const resolvedByStep = new Map<string, WorkflowPaletteTool>();
  const resolutions: WorkflowToolBindingResolution[] = [];
  const resolvedSteps = steps.map(step => {
    if (step.tool_binding == null) return { ...step };
    if (!validBinding(step.tool_binding)) {
      resolutions.push({
        stepId: step.id,
        stepLabel: step.label,
        integrationId: 'invalid',
        integrationLabel: 'Invalid binding',
        access: 'read',
        actionHints: [],
        requiredParameters: [],
        toolName: null,
        connectionName: null,
        ready: false,
        issue: `Step '${step.id}' has an invalid portable tool binding.`,
      });
      return { ...step, tool: undefined };
    }
    const { tool, resolution } = resolveOne(step, step.tool_binding, tools);
    resolutions.push(resolution);
    if (!tool) return { ...step, tool: undefined };
    resolvedByStep.set(step.id, tool);
    return { ...step, tool: tool.name };
  });

  const resolvedBlocks = blockDefinitions.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const block = raw as Record<string, unknown>;
    const id = typeof block['id'] === 'string' ? block['id'] : '';
    const tool = resolvedByStep.get(id);
    if (!tool) return { ...block };
    const rawData = block['data'];
    const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
      ? rawData as Record<string, unknown>
      : {};
    return {
      ...block,
      data: {
        ...data,
        tool: tool.name,
        integration_id: tool.integration_id,
      },
    };
  });

  return {
    ready: resolutions.every(resolution => resolution.ready),
    steps: resolvedSteps,
    blockDefinitions: resolvedBlocks,
    resolutions,
  };
}
