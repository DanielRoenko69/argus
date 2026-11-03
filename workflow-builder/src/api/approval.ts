import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface Approval {
  id: number;
  action: 'submitted' | 'approved' | 'rejected' | 'withdrawn';
  actor_username: string;
  actor_role: string | null;
  comment: string | null;
  workflow_version: number | null;
  created_at: string;
}

export function useApprovals(workflowId: number | null) {
  return useQuery({
    queryKey: ['approvals', workflowId],
    queryFn: () => api.get<{ approvals: Approval[] }>(`/api/workflows/${workflowId}/approvals`),
    enabled: workflowId != null,
  });
}

export function useApprovalAction(workflowId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { action: 'submit-for-review' | 'approve' | 'reject' | 'withdraw'; comment?: string }) =>
      api.post(`/api/workflows/${workflowId}/${vars.action}`, vars.comment ? { comment: vars.comment } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['flow', workflowId] });
      qc.invalidateQueries({ queryKey: ['approvals', workflowId] });
    },
  });
}

export interface LintFinding {
  severity: 'error' | 'warning' | 'info';
  step_id?: string;
  title: string;
  suggestion: string;
}

export function useLint(workflowId: number | null) {
  return useMutation({
    mutationFn: (steps?: unknown[]) =>
      api.post<{ findings: LintFinding[] }>(`/api/workflows/${workflowId}/lint`, steps ? { steps } : {}),
  });
}
