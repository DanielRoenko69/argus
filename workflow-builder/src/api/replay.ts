import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type WorkflowReplayStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowReplayStep {
  id: string;
  label: string;
  type: string;
  status: WorkflowReplayStepStatus;
  result: string;
  durationMs: number | null;
  selectedTarget: string | null;
  agentRole: string | null;
  agentId: number | null;
  agentName: string | null;
  traceId: string | null;
  sessionId: string | null;
  runtimeRunId: string | null;
  telemetryStatus: string | null;
  model: string | null;
  provider: string | null;
  runtimeType: string | null;
  runtimeProfile: string | null;
  reasoningEffort: string | null;
}

export interface WorkflowReplay {
  traceId: string;
  status: string;
  currentStage: string | null;
  completed: boolean;
  canCancel: boolean;
  approval: { stage: string; message: string } | null;
  steps: Record<string, WorkflowReplayStep>;
}

interface CodingThreadState {
  status?: unknown;
  values?: unknown;
  can_cancel?: unknown;
  approval?: unknown;
}

const STEP_STATUSES = new Set<WorkflowReplayStepStatus>([
  'pending', 'running', 'completed', 'failed', 'skipped',
]);

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableString(value: unknown): string | null {
  return stringValue(value).trim() || null;
}

function nullablePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function normalizeWorkflowReplay(traceId: string, state: CodingThreadState): WorkflowReplay {
  const values = recordValue(state.values);
  const rawApproval = recordValue(state.approval);
  const approvalStage = nullableString(rawApproval['stage']);
  const rawSteps = recordValue(values['step_results']);
  const steps: Record<string, WorkflowReplayStep> = {};

  for (const [id, rawStep] of Object.entries(rawSteps)) {
    const step = recordValue(rawStep);
    const rawStatus = stringValue(step['status']);
    const status = STEP_STATUSES.has(rawStatus as WorkflowReplayStepStatus)
      ? rawStatus as WorkflowReplayStepStatus
      : 'pending';
    const rawDuration = step['durationMs'] ?? step['duration_ms'];
    steps[id] = {
      id,
      label: stringValue(step['label']) || id,
      type: stringValue(step['type']) || 'unknown',
      status,
      result: stringValue(step['result']),
      durationMs: typeof rawDuration === 'number' && Number.isFinite(rawDuration) ? rawDuration : null,
      selectedTarget: stringValue(step['selectedTarget'] ?? step['selected_target']) || null,
      agentRole: nullableString(step['agentRole'] ?? step['agent_role']),
      agentId: nullablePositiveInteger(step['agentId'] ?? step['agent_id']),
      agentName: nullableString(step['agentName'] ?? step['agent_name']),
      traceId: nullableString(step['traceId'] ?? step['trace_id']),
      sessionId: nullableString(step['sessionId'] ?? step['session_id']),
      runtimeRunId: nullableString(step['runtimeRunId'] ?? step['runtime_run_id']),
      telemetryStatus: nullableString(step['telemetryStatus'] ?? step['telemetry_status']),
      model: nullableString(step['model']),
      provider: nullableString(step['provider']),
      runtimeType: nullableString(step['runtimeType'] ?? step['runtime_type']),
      runtimeProfile: nullableString(step['runtimeProfile'] ?? step['runtime_profile']),
      reasoningEffort: nullableString(step['reasoningEffort'] ?? step['reasoning_effort']),
    };
  }

  const status = values['visual_completed'] === true
    ? 'completed'
    : stringValue(state.status) || 'unknown';
  return {
    traceId,
    status,
    currentStage: stringValue(values['current_stage']) || null,
    completed: values['visual_completed'] === true || status === 'completed',
    canCancel: state.can_cancel === true,
    approval: approvalStage ? {
      stage: approvalStage,
      message: nullableString(rawApproval['message']) ?? `Approval required for ${approvalStage}`,
    } : null,
    steps,
  };
}

export function useWorkflowReplay(workflowId: number, traceId: string | null) {
  return useQuery({
    queryKey: ['workflow-replay', workflowId, traceId],
    enabled: traceId != null,
    queryFn: async () => normalizeWorkflowReplay(
      traceId!,
      await api.get<CodingThreadState>(`/api/workflows/${workflowId}/replay/${encodeURIComponent(traceId!)}`),
    ),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ['completed', 'failed', 'cancelled', 'canceled', 'error'].includes(status) ? false : 3_000;
    },
  });
}

export interface ReplayResumeDecision {
  decision: 'approved' | 'rejected';
  feedback: string;
}

export function cancelWorkflowReplay(workflowId: number, traceId: string) {
  return api.post<{ ok: true; traceId: string; taskId: string }>(
    `/api/workflows/${workflowId}/replay/${encodeURIComponent(traceId)}/cancel`,
    {},
  );
}

export function resumeWorkflowReplay(workflowId: number, traceId: string, decision: ReplayResumeDecision) {
  return api.post<{ ok: true; traceId: string; decision: ReplayResumeDecision['decision'] }>(
    `/api/workflows/${workflowId}/replay/${encodeURIComponent(traceId)}/resume`,
    decision,
  );
}

export function useCancelWorkflowReplay(workflowId: number, traceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cancelWorkflowReplay(workflowId, traceId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workflow-replay', workflowId, traceId] }),
        queryClient.invalidateQueries({ queryKey: ['pack-runs', workflowId] }),
      ]);
    },
  });
}

export function useResumeWorkflowReplay(workflowId: number, traceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decision: ReplayResumeDecision) => resumeWorkflowReplay(workflowId, traceId, decision),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workflow-replay', workflowId, traceId] }),
        queryClient.invalidateQueries({ queryKey: ['pack-runs', workflowId] }),
      ]);
    },
  });
}
