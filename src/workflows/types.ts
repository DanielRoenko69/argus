/**
 * Workflow Orchestration Engine - Type Definitions
 */

export type StepStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';
export type WorkflowStatus = 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';
export type OnErrorStrategy = 'stop' | 'continue' | 'skip_dependents';
export type AgentOutputContractName = 'planner_plan' | 'implementation_evidence' | 'review_verdict';

/**
 * Step-type discriminator for the visual workflow builder.
 * `undefined` (legacy steps without `type`) behaves like `'argus.tool'`.
 */
export type StepType =
  | 'argus.tool'      // calls toolRunner with step.tool / args
  | 'argus.agent'     // invokes a chat agent
  | 'argus.skill'     // resolves a skill (returns its text/content)
  | 'argus.memory'    // retrieve/store/consolidate via memory.ts
  | 'argus.knowledge' // RAG query against an index
  | 'argus.approval'  // explicit human-in-the-loop gate (Pack runtime)
  | 'logic.condition' // routes flow — result = boolean evaluated against args
  | 'logic.parallel'  // orchestration only; no per-step action
  | 'logic.router'    // orchestration; no-op at executor level
  | 'logic.function'  // controlled synchronous data transformation
  | 'logic.response'  // terminal — stores `value` as workflow result
  | 'logic.wait'      // pause for N seconds
  | 'logic.note'      // sticky note — skipped at runtime
  | 'logic.variables' // set workflow-scoped variables
  | 'logic.table'     // pass-through tabular data
  | 'logic.for_each'  // bounded item transform or governed sub-workflow fan-out
  | 'argus.workflow'  // sub-workflow call
  | 'trigger.manual'  // entry-only; no execution side-effect
  | 'trigger.schedule'
  | 'trigger.webhook';

/** Single workflow step definition (stored in JSONB) */
export interface WorkflowStep {
  id: string;
  label: string;
  /** Step type (visual-builder). Default 'argus.tool' for legacy steps. */
  type?: StepType | string;
  /** Tool name — only used when type is 'argus.tool' (or legacy). */
  tool?: string;
  /** Stable provider identity retained for diagnostics if a concrete tool later disappears. */
  integration_id?: string;
  /** Portable capability resolved to a concrete, accessible MCP tool when a template is instantiated. */
  tool_binding?: WorkflowToolBinding;
  /** Argus Agent ID — only when type='argus.agent'. */
  agent_id?: number;
  /** Portable Core-owned role resolved to an Agent at execution time. */
  agent_role?: string;
  /** Optional structured hand-off schema validated after an Agent response. */
  output_contract?: AgentOutputContractName;
  /** Additional Agent attempts after a contract validation failure (0-2). */
  output_contract_retries?: number;
  /** Argus Skill ID — only when type='argus.skill'. */
  skill_id?: number;
  /** Inline JavaScript code for type='logic.function'. */
  function_code?: string;
  args: Record<string, unknown>;
  condition?: string;
  depends_on?: string[];
  on_error?: OnErrorStrategy;
  /**
   * Optional credential override for an `argus.tool` step. References a
   * bundle (and optionally a specific backend) whose STORED service creds
   * are resolved server-side at run time. Only the ref is persisted —
   * tokens are NEVER stored in steps/args. RBAC: the executing identity
   * must be able to access `bundle_id` (enforced in executeRoutes).
   */
  cred_ref?: { bundle_id?: number; backend_cred_id?: number };
}

export interface WorkflowToolBinding {
  integration_id: string;
  action_hints: string[];
  access: 'read' | 'write';
  required_parameters?: string[];
}

export interface WorkflowAgentRequirement {
  role: string;
  label?: string;
  stepIds: string[];
  /** Optional stable Agent name override. Avoid database IDs in portable packs. */
  agentName?: string;
  /** Legacy compatibility for visual workflows that still carry agent_id. */
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
  runtime: import('../agents/agentReadiness.js').AgentReadinessRuntime | null;
  catalogFingerprint: string | null;
  blockers: string[];
  warnings: string[];
}

export interface WorkflowAgentPreflight {
  workflowId: number;
  workflowName: string;
  checkedAt: string;
  ready: boolean;
  inferredLegacyContract: boolean;
  contractFingerprint: string;
  blockers: string[];
  warnings: string[];
  assignments: WorkflowAgentAssignment[];
}

/** Input parameter definition for a workflow */
export interface WorkflowInputParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string | number | boolean;
}

/** Workflow DB row */
export interface WorkflowRow {
  id: number;
  /** Persisted ownership; optional only for legacy fixtures/in-memory definitions. */
  tenant_key?: string;
  workspace_key?: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  input_params: WorkflowInputParam[];
  enabled: boolean;
  bundle_ids: number[];
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /** Audit #2 — workflow-level human oversight for sensitive tool steps. */
  human_oversight_required?: boolean;
  agent_requirements?: WorkflowAgentRequirement[];
  lifecycle_status?: 'draft' | 'review' | 'production';
  /** Explicit opt-in to the AI-system production release gate. */
  ai_act_governed?: boolean;
  ai_system_id?: string | null;
  ai_system_revision?: number | null;
}

/** Step execution result */
export interface StepResult {
  status: StepStatus;
  result?: unknown;
  /** Runtime lineage or provider evidence kept separate from business output. */
  evidence?: unknown;
  error?: string;
  duration_ms: number;
  started_at?: string;
  completed_at?: string;
  approval_request_id?: number;
}

/** Execution context (accumulates results as workflow progresses) */
export interface ExecutionContext {
  workflowId: number;
  executionId: number;
  input: Record<string, unknown>;
  steps: Map<string, StepResult>;
  /** Direct branch roots disabled by a completed Condition or Router step. */
  inactiveBranchTargets?: Set<string>;
}

/** Workflow execution DB row */
export interface WorkflowExecutionRow {
  id: number;
  workflow_id: number;
  /** Persisted ownership; optional only for legacy fixtures/in-memory definitions. */
  tenant_key?: string;
  workspace_key?: string;
  status: WorkflowStatus;
  started_at: string;
  completed_at: string | null;
  triggered_by: string | null;
  input_args: Record<string, unknown>;
  step_results: Record<string, StepResult>;
  error_message: string | null;
  duration_ms: number | null;
  waiting_approval_id?: number | null;
  waiting_step_id?: string | null;
  resume_count?: number;
  resumed_at?: string | null;
  execution_snapshot?: Record<string, unknown>;
  retry_of_execution_id?: number | null;
  retry_from_step_ids?: string[];
  parent_execution_id?: number | null;
  trigger_evidence?: {
    source?: string;
    event_id?: string;
    event_type?: string;
    received_at?: string;
    payload_sha256?: string;
    event_id_source?: string;
    path?: string;
  };
}

/**
 * Authorized per-step backend reference. Visual workflows pass backendId and
 * token:null; trusted transport resolves identity at call time. Raw token is
 * retained only for legacy service callers, never to downgrade OAuth policy.
 */
export interface StepCredOverride { token: string | null; backendId?: number }

/** Tool runner callback — executes any tool by name (optional cred override). */
export type ToolRunner = (
  toolName: string,
  args: Record<string, unknown>,
  credOverride?: StepCredOverride,
  executionMeta?: { stepId?: string },
) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  approvalRequestId?: number;
}>;
