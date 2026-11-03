import type {
  WorkflowAgentRequirement,
  WorkflowInputParam,
  WorkflowStep,
} from './types.js';

export const ARGUS_WORKFLOW_SPEC_VERSION = 'argus.workflow/v1' as const;

export type PortableWorkflowNodeType =
  | 'trigger.manual'
  | 'trigger.schedule'
  | 'trigger.webhook'
  | 'argus.agent'
  | 'argus.approval'
  | 'logic.condition'
  | 'logic.parallel'
  | 'logic.router'
  | 'logic.response'
  | 'logic.note';

export interface PortableWorkflowNode {
  id: string;
  type: PortableWorkflowNodeType;
  label: string;
  dependsOn: string[];
  args: Record<string, unknown>;
  agentRole?: string;
  agentId?: number;
  outputContract?: 'planner_plan' | 'implementation_evidence' | 'review_verdict';
  outputContractRetries?: number;
  condition?: string;
}

export interface ArgusWorkflowSpecV1 {
  schemaVersion: typeof ARGUS_WORKFLOW_SPEC_VERSION;
  id: string;
  graphId: string;
  source: {
    system: 'argus.core';
    workflowId: number;
    updatedAt: string;
  };
  revision: number;
  name: string;
  label: string;
  description: string;
  inputSchema: WorkflowInputParam[];
  nodes: PortableWorkflowNode[];
  agentRequirements: WorkflowAgentRequirement[];
  requiredBundleCategories: string[];
  completion: {
    trueFields: string[];
    nonEmptyFields: string[];
  };
}

export interface VisualWorkflowSource {
  id: number;
  name: string;
  description: string;
  steps: WorkflowStep[];
  input_params: WorkflowInputParam[];
  agent_requirements?: WorkflowAgentRequirement[];
  updated_at: string;
}

export class VisualWorkflowSpecError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'VisualWorkflowSpecError';
  }
}

const SUPPORTED_TYPES = new Set<PortableWorkflowNodeType>([
  'trigger.manual',
  'trigger.schedule',
  'trigger.webhook',
  'argus.agent',
  'argus.approval',
  'logic.condition',
  'logic.parallel',
  'logic.router',
  'logic.response',
  'logic.note',
]);

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'workflow';
}

function label(value: string): string {
  return value
    .replace(/^tpl[_-]/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .trim();
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function routeTargets(node: PortableWorkflowNode): Record<string, string> {
  if (node.type === 'logic.condition') {
    return {
      true: typeof node.args['true_target'] === 'string' ? node.args['true_target'].trim() : '',
      false: typeof node.args['false_target'] === 'string' ? node.args['false_target'].trim() : '',
    };
  }
  const configured = node.args['routes'];
  const routes = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? Object.fromEntries(Object.entries(configured)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, target]) => [key.trim(), target.trim()]))
    : {};
  const defaultRoute = typeof node.args['default_route'] === 'string' ? node.args['default_route'].trim() : '';
  return defaultRoute ? { ...routes, default: defaultRoute } : routes;
}

function hasCycle(nodes: PortableWorkflowNode[]): boolean {
  const dependencies = new Map(nodes.map(node => [node.id, node.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodes.some(node => visit(node.id));
}

function inferRequirements(steps: WorkflowStep[]): WorkflowAgentRequirement[] {
  const byRole = new Map<string, string[]>();
  for (const step of steps) {
    if (step.type !== 'argus.agent' || !step.agent_role?.trim()) continue;
    const role = step.agent_role.trim().toLowerCase();
    byRole.set(role, [...(byRole.get(role) ?? []), step.id]);
  }
  return [...byRole.entries()].map(([role, stepIds]) => ({
    role,
    label: label(role),
    stepIds,
    allowedModes: role === 'reviewer' ? ['reviewer', 'worker'] : ['chat', 'worker'],
    requiredSkillNames: [],
    requiredToolPatterns: [],
    minimumBundleCount: 0,
  }));
}

export function buildVisualWorkflowSpec(source: VisualWorkflowSource): ArgusWorkflowSpecV1 {
  const issues: string[] = [];
  if (!Number.isSafeInteger(source.id) || source.id <= 0) issues.push('workflow id must be a positive integer');
  if (!Array.isArray(source.steps) || source.steps.length === 0) issues.push('workflow must contain at least one node');
  if (source.steps.length > 32) issues.push('prototype Pack workflows support at most 32 nodes');

  const ids = new Set<string>();
  const nodes: PortableWorkflowNode[] = [];
  for (const step of source.steps ?? []) {
    const type = String(step.type ?? '');
    if (!SUPPORTED_TYPES.has(type as PortableWorkflowNodeType)) {
      issues.push(`node '${step.id}' uses unsupported Pack type '${type || 'legacy tool'}'`);
      continue;
    }
    if (!step.id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(step.id)) {
      issues.push(`node id '${step.id}' is invalid`);
      continue;
    }
    if (ids.has(step.id)) issues.push(`node id '${step.id}' is duplicated`);
    ids.add(step.id);
    if (type === 'argus.agent' && !step.agent_role?.trim() && !(Number.isSafeInteger(step.agent_id) && Number(step.agent_id) > 0)) {
      issues.push(`agent node '${step.id}' requires a portable role or direct Agent id`);
    }
    const args = jsonClone(step.args ?? {});
    if (type === 'logic.router' && typeof args['routes'] === 'string') {
      try {
        const parsed = JSON.parse(args['routes']) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        args['routes'] = parsed;
      } catch {
        issues.push(`router node '${step.id}' routes must be a JSON object`);
      }
    }
    nodes.push({
      id: step.id,
      type: type as PortableWorkflowNodeType,
      label: String(step.label || step.id).slice(0, 160),
      dependsOn: [...new Set(step.depends_on ?? [])],
      args,
      ...(step.agent_role?.trim() ? { agentRole: step.agent_role.trim().toLowerCase() } : {}),
      ...(Number.isSafeInteger(step.agent_id) && Number(step.agent_id) > 0 ? { agentId: Number(step.agent_id) } : {}),
      ...(step.output_contract ? { outputContract: step.output_contract } : {}),
      ...(step.output_contract_retries !== undefined
        ? { outputContractRetries: Math.min(2, Math.max(0, Math.trunc(step.output_contract_retries))) }
        : {}),
      ...(step.condition?.trim() ? { condition: step.condition.trim() } : {}),
    });
  }

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) issues.push(`node '${node.id}' depends on missing node '${dependency}'`);
      if (dependency === node.id) issues.push(`node '${node.id}' cannot depend on itself`);
    }
  }
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) outgoing.get(dependency)?.push(node.id);
  }
  for (const node of nodes) {
    if (node.type !== 'logic.router' && node.type !== 'logic.condition') continue;
    if (node.type === 'logic.router' && typeof node.args['route_on'] !== 'string') {
      issues.push(`router node '${node.id}' requires route_on`);
    }
    if (node.type === 'logic.condition' && !node.condition) {
      issues.push(`condition node '${node.id}' requires a condition expression`);
    }
    const routes = routeTargets(node);
    const configuredRoutes = Object.entries(routes).filter(([, target]) => Boolean(target));
    if (configuredRoutes.length < 2) {
      issues.push(`${node.type === 'logic.router' ? 'router' : 'condition'} node '${node.id}' requires at least two branch targets`);
    }
    const directTargets = new Set(outgoing.get(node.id) ?? []);
    for (const [route, target] of configuredRoutes) {
      if (!ids.has(target)) issues.push(`route '${route}' on node '${node.id}' targets missing node '${target}'`);
      else if (!directTargets.has(target)) issues.push(`route '${route}' on node '${node.id}' must target a directly connected node`);
    }
  }
  if (hasCycle(nodes)) issues.push('Pack workflows must be acyclic');
  if (!nodes.some(node => node.type === 'argus.agent')) issues.push('Pack workflow requires at least one Agent node');
  if (!nodes.some(node => node.type === 'logic.response')) issues.push('Pack workflow requires a terminal Response node');
  if (issues.length > 0) throw new VisualWorkflowSpecError(issues);

  const requiredAgents = (source.agent_requirements?.length
    ? source.agent_requirements
    : inferRequirements(source.steps)).map(requirement => ({
      ...requirement,
      stepIds: [...requirement.stepIds],
      allowedModes: [...requirement.allowedModes],
      requiredSkillNames: [...requirement.requiredSkillNames],
      requiredToolPatterns: [...requirement.requiredToolPatterns],
    }));
  const updatedAt = new Date(source.updated_at || Date.now()).toISOString();
  const workflowSlug = slug(source.name);
  return {
    schemaVersion: ARGUS_WORKFLOW_SPEC_VERSION,
    id: `visual-${source.id}-${workflowSlug}`,
    graphId: `visual_workflow_${source.id}`,
    source: { system: 'argus.core', workflowId: source.id, updatedAt },
    revision: Math.max(1, Date.parse(updatedAt)),
    name: source.name,
    label: label(source.name),
    description: String(source.description ?? '').slice(0, 2_000),
    inputSchema: jsonClone(source.input_params ?? []),
    nodes,
    agentRequirements: requiredAgents,
    requiredBundleCategories: [],
    completion: {
      trueFields: ['visual_completed'],
      nonEmptyFields: ['delivery_summary'],
    },
  };
}
