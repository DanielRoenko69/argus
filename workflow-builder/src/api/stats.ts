import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { WorkflowStep } from './workflows';

export interface WorkflowStats {
  runs: number;
  succeeded: number;
  failed: number;
  success_rate: number;
  avg_duration_ms: number;
  p99_duration_ms: number;
  last_run_at: string | null;
}

export function useWorkflowStats(workflowId: number | null) {
  return useQuery({
    queryKey: ['stats', workflowId],
    queryFn: () => api.get<WorkflowStats>(`/api/workflows/${workflowId}/stats`),
    enabled: workflowId != null,
    staleTime: 30_000,
  });
}

export function useSetTags(workflowId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tags: string[]) => api.put<{ tags: string[] }>(`/api/workflows/${workflowId}/tags`, { tags }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flow', workflowId] }),
  });
}

export interface CostPrediction {
  total_usd: number;
  breakdown: Array<{ step_id: string; estimated_usd: number; reason: string }>;
}

export function useCostPredict() {
  return useMutation({
    mutationFn: (steps: WorkflowStep[]) =>
      api.post<CostPrediction>(`/api/workflows/cost-predict`, { steps }),
  });
}

export interface AuditEntry {
  id: number;
  ts: string;
  event_type: string;
  api_key_prefix?: string;
  model?: string;
  tool?: string;
  parameters?: Record<string, unknown>;
  risk_level?: string;
  error_type?: string;
}

export function useRunAudit(workflowId: number | null, runId: number | null) {
  return useQuery({
    queryKey: ['audit', workflowId, runId],
    queryFn: () => api.get<{ entries: AuditEntry[]; run_window: unknown }>(
      `/api/workflows/${workflowId}/runs/${runId}/audit`
    ),
    enabled: workflowId != null && runId != null,
  });
}
