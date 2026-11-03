// Phase 5 API hooks: templates, runs, validation.
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from './client';
import type {
  WorkflowAgentRequirement,
  WorkflowStep,
  CanvasState,
  BlockDefinition,
  TriggerConfig,
} from './workflows';

export interface TemplateRow {
  id: number;
  name: string;
  description: string;
  steps: WorkflowStep[];
  input_params: unknown[];
  canvas_state: CanvasState;
  trigger_config: TriggerConfig;
  block_definitions: BlockDefinition[];
  human_oversight_required: boolean;
  agent_requirements: WorkflowAgentRequirement[];
  integration_readiness?: {
    ready: boolean;
    requirements: Array<{
      stepId: string;
      stepLabel: string;
      integrationId: string;
      integrationLabel: string;
      access: 'read' | 'write';
      actionHints: string[];
      toolName: string | null;
      connectionName: string | null;
      ready: boolean;
      issue: string | null;
      configureHref: string;
    }>;
  };
}
export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<{ templates: TemplateRow[] }>('/api/workflows/templates'),
    staleTime: 5 * 60_000,
  });
}

export function useCloneTemplate() {
  return useMutation({
    mutationFn: (vars: { template_id: number; name?: string }) =>
      api.post<{ id: number; name: string }>('/api/workflows/from-template', vars),
  });
}

export interface RunRow {
  id: number;
  workflow_id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  triggered_by: string | null;
  error_message: string | null;
  waiting_approval_id?: number | null;
  waiting_step_id?: string | null;
  trace_id?: string | null;
  root_trace_id?: string | null;
  retry_of_execution_id?: number | null;
  retry_from_step_ids?: string[];
  trigger_evidence?: TriggerEvidence;
}

export interface TriggerEvidence {
  source?: string;
  event_id?: string;
  event_type?: string;
  received_at?: string;
  payload_sha256?: string;
  event_id_source?: string;
  path?: string;
  mode?: 'delivery' | 'local_test';
}
export function useRuns(workflowId: number | null) {
  return useQuery({
    queryKey: ['runs', workflowId],
    queryFn: () => api.get<{ runs: RunRow[] }>(`/api/workflows/${workflowId}/runs`),
    enabled: workflowId != null,
    staleTime: 5_000,
  });
}

export interface PackRunRow {
  traceId: string;
  taskId: string | null;
  title: string;
  status: string;
  error: string | null;
  currentStage: string | null;
  completed: boolean;
  stepCount: number;
  agentStepCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  durationMs: number | null;
  canCancel: boolean;
  canResume: boolean;
  approvalStage: string | null;
  replayHref: string;
}

export function usePackRuns(workflowId: number | null, enabled = true) {
  return useQuery({
    queryKey: ['pack-runs', workflowId],
    queryFn: () => api.get<{ runs: PackRunRow[] }>(`/api/workflows/${workflowId}/pack-runs?limit=25`),
    enabled: enabled && workflowId != null,
    staleTime: 3_000,
    refetchInterval: (query) => query.state.data?.runs.some(run => (
      ['queued', 'running', 'waiting', 'waiting_approval', 'waiting_external_ci'].includes(run.status)
    )) ? 3_000 : false,
    retry: false,
  });
}

export interface ValidationResult {
  valid: boolean;
  errors:   Array<{ stepId: string; issue: string }>;
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

export function useWorkflowResourcePreflight(workflowId: number | null, enabled = true) {
  return useQuery({
    queryKey: ['workflow-resource-preflight', workflowId],
    queryFn: () => api.get<WorkflowResourcePreflight>(`/api/workflows/${workflowId}/preflight`),
    enabled: enabled && workflowId != null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

export function useValidate() {
  return useMutation({
    mutationFn: ({ workflowId, steps }: { workflowId: number; steps: WorkflowStep[] }) =>
      api.post<ValidationResult>(`/api/workflows/${workflowId}/validate`, { steps }),
  });
}
