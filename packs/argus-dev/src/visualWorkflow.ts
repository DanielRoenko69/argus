import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import { callAgent, resolveAgentId } from './argus.js';
import type { CodexTaskType } from './codex.js';
import type { WorkflowCatalogEntry, WorkflowStageKind } from './workflowCatalog.js';
import { workflowCheckpointer } from './workflowCheckpointer.js';

const WORKSPACE_URL = process.env['AGENT_WORKSPACE_URL'] ?? 'http://localhost:3001';
const WORKSPACE_SECRET = process.env['WORKSPACE_SECRET'] ?? '';
const VISUAL_WORKSPACE_PATTERN = /^\/workspace\/[A-Za-z0-9-]+$/;

const inputFieldSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().max(2_000).default(''),
  required: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const nodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  type: z.enum([
    'trigger.manual', 'trigger.schedule', 'trigger.webhook',
    'argus.agent', 'argus.approval',
    'logic.condition', 'logic.parallel', 'logic.router', 'logic.response', 'logic.note',
  ]),
  label: z.string().min(1).max(160),
  dependsOn: z.array(z.string()).max(32).default([]),
  args: z.record(z.unknown()).default({}),
  agentRole: z.string().min(1).max(80).optional(),
  agentId: z.number().int().positive().optional(),
  outputContract: z.enum(['planner_plan', 'implementation_evidence', 'review_verdict']).optional(),
  outputContractRetries: z.number().int().min(0).max(2).optional(),
  condition: z.string().max(2_000).optional(),
}).superRefine((node, context) => {
  if (node.type === 'argus.agent' && !node.agentRole && !node.agentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Agent node requires agentRole or agentId' });
  }
});

export const visualWorkflowSpecSchema = z.object({
  schemaVersion: z.literal('argus.workflow/v1'),
  id: z.string().regex(/^visual-[a-zA-Z0-9-]{1,120}$/),
  graphId: z.string().regex(/^visual_workflow_[1-9][0-9]*$/),
  source: z.object({
    system: z.literal('argus.core'),
    workflowId: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  }),
  revision: z.number().int().positive(),
  name: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  description: z.string().max(2_000),
  inputSchema: z.array(inputFieldSchema).max(32),
  nodes: z.array(nodeSchema).min(1).max(32),
  agentRequirements: z.array(z.object({
    role: z.string(),
    stepIds: z.array(z.string()),
  }).passthrough()).max(32),
  requiredBundleCategories: z.array(z.string()).max(16),
  completion: z.object({
    trueFields: z.array(z.string()).max(16),
    nonEmptyFields: z.array(z.string()).max(16),
  }),
}).superRefine((spec, context) => {
  const ids = new Set(spec.nodes.map(node => node.id));
  if (ids.size !== spec.nodes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'workflow node ids must be unique' });
  }
  if (ids.has('__visual_finalize')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "node id '__visual_finalize' is reserved" });
  }
  for (const node of spec.nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `node '${node.id}' depends on missing node '${dependency}'` });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(spec.nodes.map(node => [node.id, node]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (spec.nodes.some(node => visit(node.id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'visual workflow must be acyclic' });
  }
  const outgoing = new Map(spec.nodes.map(node => [node.id, [] as string[]]));
  for (const node of spec.nodes) {
    for (const dependency of node.dependsOn) outgoing.get(dependency)?.push(node.id);
  }
  for (const node of spec.nodes) {
    if (node.type !== 'logic.router' && node.type !== 'logic.condition') continue;
    if (node.type === 'logic.router' && typeof node.args['route_on'] !== 'string') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `router node '${node.id}' requires route_on` });
    }
    if (node.type === 'logic.condition' && !node.condition?.trim()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `condition node '${node.id}' requires a condition expression` });
    }
    const targets = configuredRouteTargets(node);
    if (Object.keys(targets).filter(key => key !== 'default').length < 2) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `routing node '${node.id}' requires at least two branch targets` });
    }
    const directTargets = new Set(outgoing.get(node.id) ?? []);
    for (const [route, target] of Object.entries(targets)) {
      if (!ids.has(target)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `route '${route}' on node '${node.id}' targets a missing node` });
      } else if (!directTargets.has(target)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `route '${route}' on node '${node.id}' must target a directly connected node` });
      }
    }
  }
});

export type VisualWorkflowSpec = z.infer<typeof visualWorkflowSpecSchema>;

type StepResult = {
  status: 'completed' | 'skipped';
  label: string;
  type: string;
  result: string;
  durationMs: number;
  selectedTarget?: string;
  agentRole?: string;
  agentId?: number;
  traceId?: string;
  sessionId?: string;
  runtimeRunId?: string;
};

type AgentOutput = {
  stepId: string;
  label: string;
  role: string;
  agentId: number;
  output: string;
  attempt: number;
  traceId?: string;
  sessionId?: string;
  runtimeRunId?: string;
  recordedAt: string;
};

const VisualWorkflowState = Annotation.Root({
  input: Annotation<Record<string, unknown>>({
    reducer: (_previous, next) => next ?? {},
    default: () => ({}),
  }),
  argus_execution_grant: Annotation<string>({
    reducer: (_previous, next) => next ?? '',
    default: () => '',
  }),
  argus_bundle_id: Annotation<number>({
    reducer: (_previous, next) => next ?? 0,
    default: () => 0,
  }),
  argus_workspace_root: Annotation<string>({
    reducer: (_previous, next) => next ?? '',
    default: () => '',
  }),
  step_results: Annotation<Record<string, StepResult>>({
    reducer: (previous, next) => ({ ...previous, ...(next ?? {}) }),
    default: () => ({}),
  }),
  agent_outputs: Annotation<AgentOutput[]>({
    reducer: (previous, next) => [...previous, ...(next ?? [])],
    default: () => [],
  }),
  current_stage: Annotation<string>({
    reducer: (_previous, next) => next ?? '',
    default: () => '',
  }),
  human_approved: Annotation<boolean>({
    reducer: (_previous, next) => next ?? false,
    default: () => false,
  }),
  review_passed: Annotation<boolean>({
    reducer: (_previous, next) => next ?? false,
    default: () => false,
  }),
  delivery_summary: Annotation<string>({
    reducer: (_previous, next) => next ?? '',
    default: () => '',
  }),
  visual_completed: Annotation<boolean>({
    reducer: (_previous, next) => next ?? false,
    default: () => false,
  }),
  log: Annotation<Array<{ step: string; summary: string }>>({
    reducer: (previous, next) => [...previous, ...(next ?? [])],
    default: () => [],
  }),
});

function renderTemplate(template: unknown, state: typeof VisualWorkflowState.State): string {
  if (typeof template !== 'string') return template == null ? '' : JSON.stringify(template);
  return template.replace(/\{\{\s*(input|steps)\.([A-Za-z0-9_-]+)(?:\.(result))?\s*\}\}/g,
    (_match, scope: string, key: string) => {
      const value = scope === 'input' ? state.input[key] : state.step_results[key]?.result;
      if (value === undefined || value === null) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
}

function portableReference(
  expression: string,
  input: Record<string, unknown>,
  stepResults: Record<string, Pick<StepResult, 'result'>>,
): unknown {
  const match = expression.trim().match(/^(input|steps)\.([A-Za-z0-9_-]+)(?:\.result)?$/);
  if (!match) return undefined;
  return match[1] === 'input' ? input[match[2]!] : stepResults[match[2]!]?.result;
}

function portableLiteral(value: string): unknown {
  const trimmed = value.trim();
  if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export function evaluateVisualCondition(
  expression: string,
  input: Record<string, unknown>,
  stepResults: Record<string, Pick<StepResult, 'result'>>,
): boolean {
  const trimmed = expression.trim();
  const negated = trimmed.startsWith('!');
  const candidate = negated ? trimmed.slice(1).trim() : trimmed;
  const comparison = candidate.match(/^(input|steps)\.([A-Za-z0-9_-]+)(?:\.result)?\s*(===|!==|==|!=)\s*(.+)$/);
  if (comparison) {
    const actual = portableReference(`${comparison[1]}.${comparison[2]}${comparison[1] === 'steps' ? '.result' : ''}`, input, stepResults);
    const expected = portableLiteral(comparison[4]!);
    const equal = actual === expected || String(actual) === String(expected);
    return comparison[3] === '!==' || comparison[3] === '!=' ? !equal : equal;
  }
  const result = Boolean(portableReference(candidate, input, stepResults));
  return negated ? !result : result;
}

export function resolveVisualRouteValue(
  routeOn: unknown,
  input: Record<string, unknown>,
  stepResults: Record<string, Pick<StepResult, 'result'>>,
): string {
  if (typeof routeOn !== 'string') return '';
  const reference = portableReference(routeOn, input, stepResults);
  if (reference !== undefined) return String(reference).trim();
  const templateMatch = routeOn.trim().match(/^\{\{\s*(input|steps)\.([A-Za-z0-9_-]+)(?:\.result)?\s*\}\}$/);
  if (templateMatch) {
    const value = templateMatch[1] === 'input' ? input[templateMatch[2]!] : stepResults[templateMatch[2]!]?.result;
    return value == null ? '' : String(value).trim();
  }
  return routeOn.trim();
}

export function configuredRouteTargets(
  node: Pick<VisualWorkflowSpec['nodes'][number], 'type' | 'args'>,
): Record<string, string> {
  if (node.type === 'logic.condition') {
    return {
      true: typeof node.args['true_target'] === 'string' ? node.args['true_target'].trim() : '',
      false: typeof node.args['false_target'] === 'string' ? node.args['false_target'].trim() : '',
    };
  }
  let routes: unknown = node.args['routes'];
  if (typeof routes === 'string') {
    try { routes = JSON.parse(routes) as unknown; } catch { routes = {}; }
  }
  const normalized = routes && typeof routes === 'object' && !Array.isArray(routes)
    ? Object.fromEntries(Object.entries(routes)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
      .map(([route, target]) => [route.trim(), target.trim()]))
    : {};
  const defaultRoute = typeof node.args['default_route'] === 'string' ? node.args['default_route'].trim() : '';
  return defaultRoute ? { ...normalized, default: defaultRoute } : normalized;
}

export function visualSelectedTarget(
  node: Pick<VisualWorkflowSpec['nodes'][number], 'type' | 'args'>,
  routeValue: string,
): string | undefined {
  const targets = configuredRouteTargets(node);
  return targets[routeValue] ?? targets.default;
}

export function visualResponseFallback(
  dependsOn: string[],
  stepResults: Record<string, Pick<StepResult, 'status' | 'result'>>,
): string | undefined {
  return [...dependsOn].reverse()
    .map(id => stepResults[id])
    .find(result => result?.status === 'completed' && Boolean(result.result))?.result;
}

function stageKind(node: VisualWorkflowSpec['nodes'][number]): WorkflowStageKind {
  if (node.type === 'argus.approval') return 'approval';
  if (node.type === 'logic.response') return 'delivery';
  if (node.agentRole === 'reviewer' || node.outputContract === 'review_verdict') return 'review';
  if (node.agentRole === 'coder' || node.outputContract === 'implementation_evidence') return 'code';
  if (node.agentRole === 'knowledge' || node.agentRole === 'researcher') return 'knowledge';
  if (node.agentRole === 'planner' || node.outputContract === 'planner_plan') return 'plan';
  return 'workspace';
}

function outputSatisfiesContract(output: string, contract: VisualWorkflowSpec['nodes'][number]['outputContract']): boolean {
  if (!output.trim()) return false;
  if (contract === 'review_verdict') return /\b(APPROVE|APPROVED|REQUEST_CHANGES|REJECTED)\b/i.test(output);
  return output.trim().length >= 20;
}

export function visualReviewPassed(output: string): boolean {
  const explicitLine = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /^(?:VERDICT\s*:\s*)?(?:APPROVE|APPROVED|REQUEST_CHANGES|REJECTED)[.!]?$/i.test(line));
  const verdict = explicitLine?.match(/(?:VERDICT\s*:\s*)?(APPROVE|APPROVED|REQUEST_CHANGES|REJECTED)/i)?.[1]
    ?? [...output.matchAll(/\b(APPROVE|APPROVED|REQUEST_CHANGES|REJECTED)\b/gi)].at(-1)?.[1]
    ?? '';
  return /^APPROVE(?:D)?$/i.test(verdict);
}

function contractInstruction(contract: VisualWorkflowSpec['nodes'][number]['outputContract']): string {
  if (contract === 'review_verdict') return 'End with an explicit APPROVE or REQUEST_CHANGES verdict.';
  if (contract === 'planner_plan') return 'Return a concrete plan with scope, steps, validation and risks.';
  if (contract === 'implementation_evidence') return 'Return implementation evidence including changed files and validation performed.';
  return '';
}

export function visualWorkerTaskType(
  node: Pick<VisualWorkflowSpec['nodes'][number], 'agentRole' | 'outputContract'>,
): CodexTaskType | undefined {
  if (node.outputContract === 'planner_plan' || node.agentRole === 'planner') return 'plan';
  if (node.outputContract === 'implementation_evidence' || node.agentRole === 'coder') return 'implement_ticket';
  if (node.outputContract === 'review_verdict' || node.agentRole === 'reviewer') return 'review';
  if (node.agentRole === 'knowledge' || node.agentRole === 'researcher') return 'knowledge';
  return undefined;
}

function visualWorkspaceDir(state: typeof VisualWorkflowState.State): string {
  if (!VISUAL_WORKSPACE_PATTERN.test(state.argus_workspace_root)) {
    throw new Error('Visual Agent execution requires a workspace-bound Core grant');
  }
  return state.argus_workspace_root;
}

async function ensureVisualWorkspace(workspaceRoot: string): Promise<void> {
  if (!WORKSPACE_SECRET || !VISUAL_WORKSPACE_PATTERN.test(workspaceRoot)) {
    throw new Error('Visual Agent workspace boundary is unavailable');
  }
  const response = await fetch(`${WORKSPACE_URL}/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
    body: JSON.stringify({
      path: `${workspaceRoot}/.argus-visual-workspace`,
      content: 'Managed by an Argus visual workflow.\n',
    }),
  });
  if (!response.ok) {
    throw new Error(`Visual Agent workspace initialization failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  const gitInit = await fetch(`${WORKSPACE_URL}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
    body: JSON.stringify({ cmd: 'git init', cwd: workspaceRoot, timeoutSec: 10 }),
  });
  if (!gitInit.ok) {
    throw new Error(`Visual Agent git workspace initialization failed (${gitInit.status}): ${(await gitInit.text()).slice(0, 300)}`);
  }
  const result = await gitInit.json() as { exit_code?: number; stderr?: string };
  if (result.exit_code !== 0) {
    throw new Error(`Visual Agent git workspace initialization failed: ${String(result.stderr ?? '').slice(0, 300)}`);
  }
}

export function visualRoutingSkipReason(
  node: VisualWorkflowSpec['nodes'][number],
  stepResults: Record<string, Pick<StepResult, 'status' | 'result'>>,
  nodesById: Map<string, VisualWorkflowSpec['nodes'][number]>,
): string | undefined {
  for (const dependency of node.dependsOn) {
    const routingNode = nodesById.get(dependency);
    if (routingNode?.type !== 'logic.router' && routingNode?.type !== 'logic.condition') continue;
    const selected = visualSelectedTarget(routingNode, stepResults[dependency]?.result ?? '');
    if (selected !== node.id) return `Route '${stepResults[dependency]?.result ?? ''}' selected '${selected ?? 'no target'}'`;
  }
  const dependencyResults = node.dependsOn.map(dependency => stepResults[dependency]).filter(Boolean);
  if (node.type === 'logic.response') {
    return dependencyResults.length > 0 && dependencyResults.every(result => result.status === 'skipped')
      ? 'All response branches were skipped'
      : undefined;
  }
  const skippedDependency = node.dependsOn.find(dependency => stepResults[dependency]?.status === 'skipped');
  return skippedDependency ? `Dependency '${skippedDependency}' was skipped` : undefined;
}

function createNodeRunner(
  node: VisualWorkflowSpec['nodes'][number],
  nodesById: Map<string, VisualWorkflowSpec['nodes'][number]>,
) {
  return async (state: typeof VisualWorkflowState.State, config?: { configurable?: { thread_id?: string } }) => {
    const started = Date.now();
    const skipReason = visualRoutingSkipReason(node, state.step_results, nodesById);
    if (skipReason) {
      return {
        current_stage: node.id,
        step_results: { [node.id]: {
          status: 'skipped', label: node.label, type: node.type, result: skipReason,
          durationMs: Date.now() - started,
        } },
        log: [{ step: node.id, summary: `Skipped: ${skipReason}` }],
      };
    }

    if (node.type === 'logic.router' || node.type === 'logic.condition') {
      const routeValue = node.type === 'logic.condition'
        ? String(evaluateVisualCondition(node.condition ?? '', state.input, state.step_results))
        : resolveVisualRouteValue(node.args['route_on'], state.input, state.step_results);
      const selectedTarget = visualSelectedTarget(node, routeValue);
      if (!selectedTarget) throw new Error(`Routing node '${node.label}' has no target for '${routeValue}' and no default route`);
      return {
        current_stage: node.id,
        step_results: { [node.id]: {
          status: 'completed', label: node.label, type: node.type, result: routeValue,
          durationMs: Date.now() - started, selectedTarget,
        } },
        log: [{ step: node.id, summary: `Route '${routeValue}' selected '${selectedTarget}'` }],
      };
    }

    if (node.type === 'argus.agent') {
      const agentId = node.agentId ?? await resolveAgentId(node.agentRole!);
      const basePrompt = renderTemplate(node.args['prompt'] ?? node.label, state);
      const requiredFormat = contractInstruction(node.outputContract);
      const maxAttempts = 1 + (node.outputContractRetries ?? 0);
      const workerTaskType = visualWorkerTaskType(node);
      const workspaceRoot = workerTaskType ? visualWorkspaceDir(state) : undefined;
      if (workspaceRoot) await ensureVisualWorkspace(workspaceRoot);
      let output = '';
      let latest: Awaited<ReturnType<typeof callAgent>> | null = null;
      let attempt = 0;
      for (attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const prompt = `${basePrompt}${requiredFormat ? `\n\nOutput contract:\n${requiredFormat}` : ''}${attempt > 1 ? '\n\nThe previous response did not satisfy the output contract. Return a corrected, complete response.' : ''}`;
        latest = await callAgent(
          agentId,
          prompt,
          undefined,
          config?.configurable?.thread_id ?? '',
          state.argus_execution_grant,
          workerTaskType,
          workspaceRoot,
        );
        output = latest.response;
        if (!node.outputContract || outputSatisfiesContract(output, node.outputContract)) break;
      }
      if (!latest || (node.outputContract && !outputSatisfiesContract(output, node.outputContract))) {
        throw new Error(`Agent node '${node.label}' did not satisfy ${node.outputContract ?? 'its output contract'}`);
      }
      const result: StepResult = {
        status: 'completed', label: node.label, type: node.type, result: output,
        durationMs: Date.now() - started, agentRole: node.agentRole ?? `agent-${agentId}`, agentId,
        ...(latest.trace_id ? { traceId: latest.trace_id } : {}),
        ...(latest.session_id ? { sessionId: latest.session_id } : {}),
        ...(latest.runtime_run_id ? { runtimeRunId: latest.runtime_run_id } : {}),
      };
      return {
        current_stage: node.id,
        ...((node.agentRole === 'reviewer' || node.outputContract === 'review_verdict')
          ? { review_passed: visualReviewPassed(output) }
          : {}),
        step_results: { [node.id]: result },
        agent_outputs: [{
          stepId: node.id, label: node.label, role: node.agentRole ?? `agent-${agentId}`, agentId,
          output, attempt,
          ...(latest.trace_id ? { traceId: latest.trace_id } : {}),
          ...(latest.session_id ? { sessionId: latest.session_id } : {}),
          ...(latest.runtime_run_id ? { runtimeRunId: latest.runtime_run_id } : {}),
          recordedAt: new Date().toISOString(),
        }],
        log: [{ step: node.id, summary: output.slice(0, 240) }],
      };
    }

    if (node.type === 'argus.approval') {
      const evidence = Object.fromEntries(node.dependsOn.map(id => [id, state.step_results[id]?.result ?? '']));
      const decision = interrupt({
        stage: node.id,
        message: renderTemplate(node.args['message'] ?? `Approve ${node.label}?`, state),
        workflow_step_id: node.id,
        evidence,
      }) as { approved?: boolean; feedback?: string };
      if (decision?.approved !== true) {
        const feedback = typeof decision?.feedback === 'string' ? decision.feedback.trim() : '';
        throw new Error(`Human rejected '${node.label}'${feedback ? `: ${feedback}` : ''}`);
      }
      return {
        current_stage: node.id,
        human_approved: true,
        step_results: { [node.id]: {
          status: 'completed', label: node.label, type: node.type,
          result: typeof decision.feedback === 'string' ? decision.feedback : 'Approved',
          durationMs: Date.now() - started,
        } },
        log: [{ step: node.id, summary: 'Human approval granted' }],
      };
    }

    if (node.type === 'logic.response') {
      const output = renderTemplate(node.args['value'] ?? node.args['response'] ?? '', state)
        || visualResponseFallback(node.dependsOn, state.step_results)
        || 'Workflow completed.';
      return {
        current_stage: node.id,
        delivery_summary: output,
        step_results: { [node.id]: {
          status: 'completed', label: node.label, type: node.type, result: output,
          durationMs: Date.now() - started,
        } },
        log: [{ step: node.id, summary: output.slice(0, 240) }],
      };
    }

    const skipped = node.type === 'logic.note';
    return {
      current_stage: node.id,
      step_results: { [node.id]: {
        status: skipped ? 'skipped' : 'completed', label: node.label, type: node.type,
        result: skipped ? 'Canvas note skipped' : 'Control node passed', durationMs: Date.now() - started,
      } },
      log: [{ step: node.id, summary: skipped ? 'Canvas note skipped' : 'Control node passed' }],
    };
  };
}

export function parseVisualWorkflowSpec(value: unknown): VisualWorkflowSpec {
  return visualWorkflowSpecSchema.parse(value);
}

export function visualWorkflowCatalogEntry(spec: VisualWorkflowSpec): WorkflowCatalogEntry {
  const firstInput = spec.inputSchema[0]?.name ?? '__visual_run';
  return {
    id: spec.id,
    graphId: spec.graphId,
    label: spec.label,
    description: spec.description || `Visual workflow published from Argus Core workflow ${spec.source.workflowId}.`,
    tags: ['visual-builder', 'governed-agents', 'prototype'],
    inputSchema: spec.inputSchema.map(field => ({
      name: field.name,
      label: field.name.replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()),
      type: field.type === 'string' ? (field.description.length > 80 ? 'textarea' : 'text') : field.type,
      required: field.required,
      description: field.description,
      ...(field.default !== undefined ? { defaultValue: field.default } : {}),
    })),
    stages: spec.nodes
      .filter(node => node.type !== 'logic.note')
      .map(node => ({ id: node.id, label: node.label, hint: node.type.replace(/^argus\.|^logic\.|^trigger\./, ''), kind: stageKind(node) })),
    approvalGates: spec.nodes.filter(node => node.type === 'argus.approval').map(node => node.id),
    requiredAgents: [...new Set([
      ...spec.agentRequirements.map(requirement => requirement.role),
      ...spec.nodes.map(node => node.agentRole).filter((role): role is string => Boolean(role)),
    ])],
    titleField: firstInput,
    descriptionField: spec.inputSchema.find(field => field.type === 'string')?.name,
    requiredBundleCategories: [...spec.requiredBundleCategories],
    completionCriteria: {
      trueFields: [...spec.completion.trueFields],
      nonEmptyFields: [...spec.completion.nonEmptyFields],
    },
    origin: 'visual-builder',
    revision: spec.revision,
  };
}

export function buildVisualWorkflowGraph(spec: VisualWorkflowSpec) {
  // LangGraph's public builder is strongly typed for literal node names. A
  // published visual spec intentionally supplies those names at runtime, so
  // the small cast is isolated to graph assembly while state remains typed.
  const builder = new StateGraph(VisualWorkflowState) as any;
  const nodesById = new Map(spec.nodes.map(node => [node.id, node]));
  for (const node of spec.nodes) builder.addNode(node.id, createNodeRunner(node, nodesById));
  builder.addNode('__visual_finalize', (state: typeof VisualWorkflowState.State) => {
    const fallback = [...spec.nodes].reverse()
      .map(node => state.step_results[node.id]?.result ?? '')
      .find(Boolean) ?? `${spec.label} completed.`;
    return {
      current_stage: 'completed',
      visual_completed: true,
      delivery_summary: state.delivery_summary || fallback,
      log: [{ step: '__visual_finalize', summary: `${spec.label} completed` }],
    };
  });

  const outgoing = new Map(spec.nodes.map(node => [node.id, [] as string[]]));
  for (const node of spec.nodes) {
    for (const dependency of node.dependsOn) outgoing.get(dependency)?.push(node.id);
    if (node.dependsOn.length === 0) builder.addEdge(START, node.id);
    else builder.addEdge(node.dependsOn.length === 1 ? node.dependsOn[0] : node.dependsOn, node.id);
  }
  const leaves = spec.nodes.filter(node => (outgoing.get(node.id)?.length ?? 0) === 0).map(node => node.id);
  builder.addEdge(leaves.length === 1 ? leaves[0] : leaves, '__visual_finalize');
  builder.addEdge('__visual_finalize', END);
  return builder.compile({ checkpointer: workflowCheckpointer });
}
