import type { WorkflowPaletteIntegration, WorkflowPaletteTool } from './integrationCatalog.js';
import type { WorkflowStep } from './types.js';

export interface WorkflowValidationSummary {
  valid: boolean;
  errors: Array<{ stepId: string; issue: string }>;
  warnings: Array<{ stepId: string; issue: string }>;
}

export interface WorkflowToolPreflightFinding {
  stepId: string;
  stepLabel: string;
  status: 'ready' | 'blocked';
  toolName: string | null;
  actionLabel: string;
  integrationId: string | null;
  integrationLabel: string;
  integrationBrand: string | null;
  connectionName: string | null;
  access: 'read' | 'write';
  riskLevel: 'low' | 'medium' | 'high';
  missingParameters: string[];
  issue: string | null;
  configureHref: string;
}

export interface WorkflowResourcePreflight {
  workflowId: number;
  workflowName: string;
  checkedAt: string;
  ready: boolean;
  errors: Array<{ stepId: string; issue: string }>;
  warnings: Array<{ stepId: string; issue: string }>;
  blockers: string[];
  tools: WorkflowToolPreflightFinding[];
}

export function preflightWorkflowResources(input: {
  workflowId: number;
  workflowName: string;
  steps: WorkflowStep[];
  validation: WorkflowValidationSummary;
  tools: WorkflowPaletteTool[];
  integrations: WorkflowPaletteIntegration[];
  allowedBundleIds: number[] | null;
  checkedAt?: string;
}): WorkflowResourcePreflight {
  const catalogByName = new Map(input.tools.map(tool => [tool.name, tool]));
  const integrationsById = new Map(input.integrations.map(integration => [integration.id, integration]));
  const tools = input.steps
    .filter(step => {
      const type = step.type ?? 'argus.tool';
      return type === 'argus.tool' || type === 'tool';
    })
    .map(step => preflightTool(step, catalogByName, integrationsById, input.allowedBundleIds));
  const blockers = [
    ...input.validation.errors.map(error => `${error.stepId}: ${error.issue}`),
    ...tools.filter(tool => tool.status === 'blocked').map(tool => `${tool.stepLabel}: ${tool.issue ?? 'tool is not ready'}`),
  ];
  return {
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    ready: blockers.length === 0,
    errors: input.validation.errors,
    warnings: input.validation.warnings,
    blockers: [...new Set(blockers)],
    tools,
  };
}

function preflightTool(
  step: WorkflowStep,
  catalogByName: Map<string, WorkflowPaletteTool>,
  integrationsById: Map<string, WorkflowPaletteIntegration>,
  allowedBundleIds: number[] | null,
): WorkflowToolPreflightFinding {
  const toolName = typeof step.tool === 'string' && step.tool.trim() ? step.tool.trim() : null;
  const tool = toolName ? catalogByName.get(toolName) ?? null : null;
  const integrationId = tool?.integration_id
    ?? step.integration_id
    ?? step.tool_binding?.integration_id
    ?? null;
  const integration = integrationId ? integrationsById.get(integrationId) ?? null : null;
  const configureHref = integration?.configure_href ?? '/mcp-fabric?new=mcp';
  const referencedBundleId = step.cred_ref?.bundle_id;
  if (allowedBundleIds !== null && typeof referencedBundleId === 'number' && !allowedBundleIds.includes(referencedBundleId)) {
    return finding(step, tool, integration, integrationId, configureHref, {
      status: 'blocked',
      issue: `MCP bundle #${referencedBundleId} is not assigned to the current identity.`,
    });
  }
  if (!toolName) {
    return finding(step, null, integration, integrationId, configureHref, {
      status: 'blocked',
      issue: 'No MCP Fabric tool is selected.',
    });
  }
  if (!tool) {
    const issue = integration?.state === 'unconfigured'
      ? `${integration.label} is not connected in MCP Fabric.`
      : integration?.state === 'unavailable'
        ? `${integration.label} is not available to the current identity.`
        : integration?.state === 'ready'
          ? `${toolName} is no longer exposed by an accessible ${integration.label} connection.`
          : `${toolName} is not in the accessible MCP Fabric catalog.`;
    return finding(step, null, integration, integrationId, configureHref, { status: 'blocked', issue });
  }
  const missingParameters = tool.parameters
    .filter(parameter => parameter.required && parameter.default === undefined && !configured(step.args?.[parameter.name]))
    .map(parameter => parameter.name);
  if (missingParameters.length > 0) {
    return finding(step, tool, integration, integrationId, configureHref, {
      status: 'blocked',
      issue: `Required parameter${missingParameters.length === 1 ? '' : 's'} missing: ${missingParameters.join(', ')}.`,
      missingParameters,
    });
  }
  return finding(step, tool, integration, integrationId, configureHref, { status: 'ready', issue: null });
}

function configured(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

function finding(
  step: WorkflowStep,
  tool: WorkflowPaletteTool | null,
  integration: WorkflowPaletteIntegration | null,
  integrationId: string | null,
  configureHref: string,
  state: { status: 'ready' | 'blocked'; issue: string | null; missingParameters?: string[] },
): WorkflowToolPreflightFinding {
  const access = tool?.is_write || step.tool_binding?.access === 'write' ? 'write' : 'read';
  return {
    stepId: step.id,
    stepLabel: step.label || step.id,
    status: state.status,
    toolName: tool?.name ?? step.tool ?? null,
    actionLabel: tool?.action_label ?? step.label ?? step.tool ?? 'Tool',
    integrationId,
    integrationLabel: tool?.integration_label ?? integration?.label ?? 'MCP Fabric',
    integrationBrand: tool?.integration_brand ?? integration?.brand ?? null,
    connectionName: tool?.connection_name ?? null,
    access,
    riskLevel: tool?.risk_level ?? (access === 'write' ? 'medium' : 'low'),
    missingParameters: state.missingParameters ?? [],
    issue: state.issue,
    configureHref,
  };
}
