import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Node, Edge, Viewport } from 'reactflow';

export interface WorkflowInputParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string | number | boolean;
}

export interface FlowState {
  id: number;
  name: string;
  description: string;
  steps: WorkflowStep[];
  input_params: WorkflowInputParam[];
  canvas_state: CanvasState;
  trigger_config: TriggerConfig;
  block_definitions: BlockDefinition[];
  source: 'manual' | 'visual';
  enabled: boolean;
  updated_at: string;
  tags?: string[];
  lifecycle_status?: 'draft' | 'review' | 'production';
  /** Audit #2 — when true, sensitive tool steps require human approval. */
  human_oversight_required?: boolean;
  /** Set by GET /flow — true if current user can save/run/delete. */
  can_edit?: boolean;
  agent_requirements?: WorkflowAgentRequirement[];
}

export interface WorkflowAgentRequirement {
  role: string;
  label?: string;
  stepIds: string[];
  agentName?: string;
  agentId?: number;
  presetName?: string;
  minimumPresetVersion?: number;
  allowedModes: Array<'chat' | 'worker' | 'reviewer'>;
  requiredSkillNames: string[];
  requiredToolPatterns: string[];
  minimumBundleCount: number;
}

export interface WorkflowAgentAssignment {
  role: string;
  label: string;
  stepIds: string[];
  status: 'ready' | 'degraded' | 'blocked';
  agentId: number | null;
  agentName: string | null;
  agentLabel: string | null;
  agentMode: 'chat' | 'worker' | 'reviewer' | null;
  model: string | null;
  presetName: string | null;
  installedPresetVersion: number | null;
  requiredPresetVersion: number | null;
  skillNames: string[];
  bundleIds: number[];
  toolNames: string[];
  runtime: { type: string; profileLabel: string | null; state: string; detail: string } | null;
  blockers: string[];
  warnings: string[];
}

export interface WorkflowAgentPreflight {
  workflowId: number;
  workflowName: string;
  checkedAt: string;
  ready: boolean;
  inferredLegacyContract: boolean;
  blockers: string[];
  warnings: string[];
  assignments: WorkflowAgentAssignment[];
}

export const workflowAgentPreflightQueryKey = (workflowId: number | null) => [
  'workflow-agent-preflight',
  workflowId,
] as const;

export function fetchWorkflowAgentPreflight(workflowId: number): Promise<WorkflowAgentPreflight> {
  return api.get<WorkflowAgentPreflight>(`/api/admin/workflows/${workflowId}/agent-preflight`);
}

export function useWorkflowAgentPreflight(workflowId: number | null, enabled = true) {
  return useQuery({
    queryKey: workflowAgentPreflightQueryKey(workflowId),
    queryFn: () => fetchWorkflowAgentPreflight(workflowId!),
    enabled: enabled && workflowId != null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** Credential binding for a step. Stores only { bundle_id } — never the secret.
 *  NOTE: when a bundle has multiple backends, backend_cred_id would disambiguate
 *  (accepted by the executor but out of v1 UI scope). */
export interface CredRef {
  bundle_id: number;
}

export interface WorkflowStep {
  id: string;
  label: string;
  type?: string;
  tool?: string;
  integration_id?: string;
  tool_binding?: {
    integration_id: string;
    action_hints: string[];
    access: 'read' | 'write';
    required_parameters?: string[];
  };
  agent_id?: number;
  agent_role?: string;
  output_contract?: 'planner_plan' | 'implementation_evidence' | 'review_verdict';
  output_contract_retries?: number;
  skill_id?: number;
  function_code?: string;
  args: Record<string, unknown>;
  condition?: string;
  depends_on?: string[];
  on_error?: 'stop' | 'continue' | 'skip_dependents';
  cred_ref?: CredRef;
}

export interface CanvasState {
  viewport?: Viewport;
  theme?: 'dark' | 'light';
  locked?: boolean;
}

export interface TriggerConfig {
  type?: 'manual' | 'webhook' | 'cron' | 'event' | 'api';
  cron_expr?: string;
  webhook_path?: string;
  [k: string]: unknown;
}

// Visual representation of a block as Sim-style JSON (parallels nodes[]).
export interface BlockDefinition {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export function useFlow(id: number | null) {
  return useQuery({
    queryKey: ['flow', id],
    queryFn: () => api.get<FlowState>(`/api/workflows/${id}/flow`),
    enabled: id != null,
    staleTime: 0, // always re-fetch — workflows can be edited elsewhere
  });
}

export interface SaveFlowPayload {
  steps: WorkflowStep[];
  input_params?: WorkflowInputParam[];
  canvas_state: CanvasState;
  block_definitions: BlockDefinition[];
  trigger_config?: TriggerConfig;
  agent_requirements?: WorkflowAgentRequirement[];
}

export function useSaveFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: SaveFlowPayload }) =>
      api.put<{ ok: true }>(`/api/workflows/${id}/flow`, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['flow', vars.id] });
      qc.invalidateQueries({ queryKey: workflowAgentPreflightQueryKey(vars.id) });
    },
  });
}

export function mergeWorkflowInputParams(
  existing: WorkflowInputParam[] = [],
  additions: WorkflowInputParam[] = [],
): WorkflowInputParam[] {
  const merged = new Map(existing.map(parameter => [parameter.name, parameter]));
  for (const parameter of additions) {
    if (!merged.has(parameter.name)) merged.set(parameter.name, parameter);
  }
  return [...merged.values()];
}

/** Input for creating a brand-new (empty) workflow from inside the builder. */
export interface CreateWorkflowInput {
  name: string;
  description: string;
}

// Canvas data mixes step metadata (tool, agent_id, condition, ...) with the
// editable operation fields shown in the properties panel. The executor expects
// those operation fields under step.args. Keep one explicit metadata allowlist
// so manually edited nodes and Copilot-generated nodes serialize identically.
const STEP_METADATA_KEYS = new Set([
  'label',
  'tool',
  'tool_binding',
  'integration_id',
  'agent_id',
  'agent_role',
  'output_contract',
  'output_contract_retries',
  'skill_id',
  'function_code',
  'condition',
  'on_error',
  'cred_ref',
  'args',
  // Trigger configuration is persisted separately by deriveTriggerConfig().
  'cron_expr',
  'schedule_static_inputs',
  'webhook_path',
  'webhook_secret_env',
  'webhook_provider',
  'webhook_allowed_events',
  'webhook_static_inputs',
  // Canvas-only fixture used by the authenticated local webhook test action.
  'webhook_test_payload',
  // Sticky-note content is canvas-only.
  'text',
]);

/** Convert editable flat canvas fields into the executor's step.args shape. */
export function serializeStepArgs(data: Record<string, unknown>): Record<string, unknown> {
  const nested = data['args'] !== null
    && typeof data['args'] === 'object'
    && !Array.isArray(data['args'])
    ? data['args'] as Record<string, unknown>
    : {};
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!STEP_METADATA_KEYS.has(key) && value !== undefined) flat[key] = value;
  }
  // Explicit data.args is canonical and wins over a stale flat canvas value.
  return { ...flat, ...nested };
}

/**
 * Create a new empty workflow via POST /api/admin/workflows.
 * NOTE: that endpoint is requireAdmin (src/index.ts:1998) — non-admins get 403.
 * On success, invalidates the ['admin-workflows'] list query (see PropertiesPanel.tsx:200).
 */
export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, description }: CreateWorkflowInput) =>
      api.post<FlowState>('/api/admin/workflows', { name, description, enabled: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-workflows'] });
    },
  });
}

/**
 * Convert React Flow nodes + edges + viewport → SaveFlowPayload that
 * the backend accepts. Steps are derived from blocks; edges become
 * depends_on relationships.
 */
export function buildSavePayload(
  nodes: Node[],
  edges: Edge[],
  viewport: Viewport,
  existingAgentRequirements?: WorkflowAgentRequirement[],
): SaveFlowPayload {
  // Build depends_on from edges (target depends_on source)
  const dependsBySource: Record<string, string[]> = {};
  for (const e of edges) {
    if (!dependsBySource[e.target]) dependsBySource[e.target] = [];
    dependsBySource[e.target]!.push(e.source);
  }

  const steps: WorkflowStep[] = nodes.map((n) => {
    const data = (n.data ?? {}) as Record<string, unknown>;
    const step: WorkflowStep = {
      id: n.id,
      label: (data['label'] as string) ?? n.type ?? 'step',
      type: n.type,
      args: serializeStepArgs(data),
    };
    if (typeof data['tool'] === 'string') step.tool = data['tool'];
    if (typeof data['integration_id'] === 'string' && data['integration_id'].trim()) {
      step.integration_id = data['integration_id'].trim();
    }
    if (data['tool_binding'] && typeof data['tool_binding'] === 'object' && !Array.isArray(data['tool_binding'])) {
      step.tool_binding = data['tool_binding'] as WorkflowStep['tool_binding'];
    }
    const agentRole = typeof data['agent_role'] === 'string' ? data['agent_role'].trim().toLowerCase() : '';
    if (agentRole) step.agent_role = agentRole;
    else if (typeof data['agent_id'] === 'number') step.agent_id = data['agent_id'];
    if (typeof data['output_contract'] === 'string' && data['output_contract']) {
      step.output_contract = data['output_contract'] as WorkflowStep['output_contract'];
    }
    if (typeof data['output_contract_retries'] === 'number') {
      step.output_contract_retries = data['output_contract_retries'];
    }
    if (typeof data['skill_id'] === 'number') step.skill_id = data['skill_id'];
    if (typeof data['function_code'] === 'string') step.function_code = data['function_code'];
    if (typeof data['condition'] === 'string') step.condition = data['condition'];
    if (typeof data['on_error'] === 'string') {
      step.on_error = data['on_error'] as WorkflowStep['on_error'];
    }
    const cr = data['cred_ref'] as { bundle_id?: unknown } | undefined;
    if (cr && typeof cr.bundle_id === 'number') {
      step.cred_ref = { bundle_id: cr.bundle_id };
    }
    const dep = dependsBySource[n.id];
    if (dep && dep.length > 0) step.depends_on = dep;
    return step;
  });

  const block_definitions: BlockDefinition[] = nodes.map((n) => ({
    id: n.id,
    type: n.type ?? 'tool',
    position: n.position,
    data: serializeBlockData(n),
  }));

  const trigger_config = deriveTriggerConfig(nodes);

  return {
    steps,
    canvas_state: { viewport, theme: 'dark' },
    block_definitions,
    // Only include trigger_config when the canvas actually has a trigger node.
    // Omitting it (undefined) makes flowRoutes leave the stored value untouched,
    // so older trigger-less workflows configured via API keep their config.
    ...(trigger_config ? { trigger_config } : {}),
    // Normal canvas saves pass the current server contract so role changes and
    // concrete Agent pins cannot leave stale step bindings behind.
    ...(existingAgentRequirements
      ? { agent_requirements: reconcileWorkflowAgentRequirements(nodes, existingAgentRequirements) }
      : {}),
  };
}

function serializeBlockData(node: Node): Record<string, unknown> {
  const data = { ...((node.data ?? {}) as Record<string, unknown>) };
  if (node.type !== 'argus.agent') return data;
  const role = typeof data['agent_role'] === 'string' ? data['agent_role'].trim().toLowerCase() : '';
  if (role) {
    data['agent_role'] = role;
    delete data['agent_id'];
  } else {
    delete data['agent_role'];
  }
  return data;
}

/**
 * Align the portable Agent contract with the Agent bindings visible on the
 * canvas while retaining governance constraints for roles that still exist.
 */
export function reconcileWorkflowAgentRequirements(
  nodes: Node[],
  existing: WorkflowAgentRequirement[] = [],
): WorkflowAgentRequirement[] {
  const stepsByRole = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.type !== 'argus.agent') continue;
    const rawRole = (node.data as Record<string, unknown> | undefined)?.['agent_role'];
    const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : '';
    if (!role) continue;
    const stepIds = stepsByRole.get(role) ?? [];
    stepIds.push(node.id);
    stepsByRole.set(role, stepIds);
  }

  const reconciled: WorkflowAgentRequirement[] = [];
  const retainedRoles = new Set<string>();
  for (const requirement of existing) {
    const role = requirement.role.trim().toLowerCase();
    const currentStepIds = stepsByRole.get(role);
    if (currentStepIds) {
      reconciled.push(cloneAgentRequirement(requirement, role, currentStepIds));
      retainedRoles.add(role);
      continue;
    }
    // Empty requirements are intentional supporting roles with no canvas step.
    if (requirement.stepIds.length === 0) {
      reconciled.push(cloneAgentRequirement(requirement, role, []));
      retainedRoles.add(role);
    }
  }

  for (const [role, stepIds] of stepsByRole) {
    if (retainedRoles.has(role)) continue;
    reconciled.push({
      role,
      label: role,
      stepIds: [...stepIds],
      allowedModes: ['chat', 'worker', 'reviewer'],
      requiredSkillNames: [],
      requiredToolPatterns: [],
      minimumBundleCount: 0,
    });
  }
  return reconciled;
}

function cloneAgentRequirement(
  requirement: WorkflowAgentRequirement,
  role: string,
  stepIds: string[],
): WorkflowAgentRequirement {
  return {
    ...requirement,
    role,
    stepIds: [...stepIds],
    allowedModes: [...requirement.allowedModes],
    requiredSkillNames: [...requirement.requiredSkillNames],
    requiredToolPatterns: [...requirement.requiredToolPatterns],
  };
}

/**
 * Derive the backend trigger_config from the canvas trigger node. Without this
 * the visual Schedule/Webhook trigger nodes were decorative — their data
 * round-tripped via block_definitions but the cron worker + webhook route
 * (which read mcp_workflows.trigger_config) never saw them, so a workflow
 * "configured" in the builder never actually fired. (audit follow-up.)
 *
 * Returns undefined when there is no trigger node, so the save leaves any
 * existing trigger_config untouched.
 */
export function deriveTriggerConfig(nodes: Node[]): TriggerConfig | undefined {
  const trigger = nodes.find((n) => (n.type ?? '').startsWith('trigger.'));
  if (!trigger) return undefined;
  const d = (trigger.data ?? {}) as Record<string, unknown>;

  switch (trigger.type) {
    case 'trigger.schedule': {
      const cron = typeof d['cron_expr'] === 'string' && d['cron_expr'].trim() ? d['cron_expr'].trim() : '0 * * * *';
      const cfg: TriggerConfig = { type: 'cron', cron_expr: cron };
      const staticInputsText = typeof d['schedule_static_inputs'] === 'string' ? d['schedule_static_inputs'].trim() : '';
      if (staticInputsText) {
        try {
          const parsed = JSON.parse(staticInputsText) as unknown;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) cfg['static_inputs'] = parsed;
        } catch {
          // Keep malformed draft JSON on the canvas, but never publish it into
          // the executable schedule configuration.
        }
      }
      return cfg;
    }
    case 'trigger.webhook': {
      // Normalise the path to a single leading slash so it matches the
      // POST /webhooks/wf/:slug lookup (`webhook_path = '/' + slug`).
      const rawPath = typeof d['webhook_path'] === 'string' ? d['webhook_path'].trim() : '';
      const webhook_path = rawPath ? '/' + rawPath.replace(/^\/+/, '') : '';
      const cfg: TriggerConfig = { type: 'webhook', webhook_path };
      const secretEnv = typeof d['webhook_secret_env'] === 'string' ? d['webhook_secret_env'].trim() : '';
      if (secretEnv) cfg['webhook_secret_env'] = secretEnv;
      const provider = typeof d['webhook_provider'] === 'string' ? d['webhook_provider'].trim() : '';
      if (provider) cfg['provider'] = provider;
      const allowedEvents = typeof d['webhook_allowed_events'] === 'string'
        ? d['webhook_allowed_events'].split(',').map(value => value.trim()).filter(Boolean)
        : [];
      if (allowedEvents.length > 0) cfg['allowed_events'] = allowedEvents;
      const staticInputsText = typeof d['webhook_static_inputs'] === 'string' ? d['webhook_static_inputs'].trim() : '';
      if (staticInputsText) {
        try {
          const parsed = JSON.parse(staticInputsText) as unknown;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) cfg['static_inputs'] = parsed;
        } catch {
          // Leave malformed draft JSON out of the executable trigger config.
          // The raw text stays on the canvas so the user can correct it.
        }
      }
      return cfg;
    }
    case 'trigger.manual':
    default:
      return { type: 'manual' };
  }
}

/**
 * Inverse: blocks + canvas_state → React Flow nodes + edges + viewport.
 * Edges are reconstructed from each step's depends_on.
 */
export function restoreFromFlow(
  flow: FlowState
): { nodes: Node[]; edges: Edge[]; viewport: Viewport } {
  const steps = flow.steps ?? [];
  const stepsById = new Map(steps.map(step => [step.id, step]));
  const storedBlocks = flow.block_definitions ?? [];

  // API-authored and legacy workflows can contain executable steps without a
  // visual canvas representation. Reconstruct a deterministic editable canvas
  // instead of presenting a misleading empty workflow.
  const blocks: BlockDefinition[] = storedBlocks.length > 0
    ? storedBlocks
    : steps.map((step, index) => ({
        id: step.id,
        type: inferStepNodeType(step),
        position: {
          x: 96 + (index % 4) * 280,
          y: 96 + Math.floor(index / 4) * 180,
        },
        data: stepToNodeData(step),
      }));

  const nodes: Node[] = blocks.map((b) => ({
    id: b.id,
    type: b.type,
    position: b.position,
    data: {
      ...b.data,
      ...(stepsById.get(b.id)?.agent_id != null ? { agent_id: stepsById.get(b.id)!.agent_id } : {}),
      ...(stepsById.get(b.id)?.agent_role ? { agent_role: stepsById.get(b.id)!.agent_role } : {}),
      ...(stepsById.get(b.id)?.output_contract ? { output_contract: stepsById.get(b.id)!.output_contract } : {}),
      ...(stepsById.get(b.id)?.output_contract_retries != null
        ? { output_contract_retries: stepsById.get(b.id)!.output_contract_retries }
        : {}),
    },
  }));

  const edges: Edge[] = [];
  for (const step of flow.steps ?? []) {
    for (const dep of step.depends_on ?? []) {
      edges.push({
        id: `e-${dep}-${step.id}`,
        source: dep,
        target: step.id,
      });
    }
  }

  const viewport: Viewport = flow.canvas_state?.viewport ?? { x: 0, y: 0, zoom: 1 };
  return { nodes, edges, viewport };
}

function inferStepNodeType(step: WorkflowStep): string {
  if (typeof step.type === 'string' && step.type.trim()) return step.type;
  if (step.agent_id != null || step.agent_role) return 'argus.agent';
  if (step.skill_id != null) return 'argus.skill';
  if (step.function_code) return 'logic.function';
  if (step.tool) return 'argus.tool';
  return 'logic.response';
}

function stepToNodeData(step: WorkflowStep): Record<string, unknown> {
  return {
    label: step.label,
    args: step.args ?? {},
    ...(step.tool ? { tool: step.tool } : {}),
    ...(step.integration_id ? { integration_id: step.integration_id } : {}),
    ...(step.tool_binding ? { tool_binding: step.tool_binding } : {}),
    ...(step.agent_id != null ? { agent_id: step.agent_id } : {}),
    ...(step.agent_role ? { agent_role: step.agent_role } : {}),
    ...(step.output_contract ? { output_contract: step.output_contract } : {}),
    ...(step.output_contract_retries != null ? { output_contract_retries: step.output_contract_retries } : {}),
    ...(step.skill_id != null ? { skill_id: step.skill_id } : {}),
    ...(step.function_code ? { function_code: step.function_code } : {}),
    ...(step.condition ? { condition: step.condition } : {}),
    ...(step.on_error ? { on_error: step.on_error } : {}),
    ...(step.cred_ref ? { cred_ref: step.cred_ref } : {}),
  };
}
