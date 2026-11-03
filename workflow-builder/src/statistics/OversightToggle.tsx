// Workflow-level human-oversight toggle (audit #2). When enabled, the
// human-approval-gate hook blocks sensitive tool steps (k8s_apply,
// helmrelease_deploy, gitea_create_pr, …) invoked by this workflow until a
// reviewer approves. Persists via PUT /api/admin/workflows/:id (admin-only),
// mirroring the MaintenanceWindow control.

import { useState, useEffect } from 'react';
import { ShieldCheck, Shield } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useFlow } from '@/api/workflows';
import { cn } from '@/lib/utils';

interface Props { workflowId: number | null }

export function OversightToggle({ workflowId }: Props) {
  const { data: flow } = useFlow(workflowId);
  const qc = useQueryClient();
  const [on, setOn] = useState(false);

  useEffect(() => {
    setOn(Boolean(flow?.human_oversight_required));
  }, [flow]);

  const save = useMutation({
    mutationFn: (next: boolean) =>
      api.put(`/api/admin/workflows/${workflowId}`, { human_oversight_required: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flow', workflowId] }),
    // Revert optimistic state if the PUT fails.
    onError: () => setOn(Boolean(flow?.human_oversight_required)),
  });

  if (!workflowId) return null;

  return (
    <button
      onClick={() => { const next = !on; setOn(next); save.mutate(next); }}
      disabled={save.isPending}
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border transition disabled:opacity-50',
        on
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          : 'border-border bg-card/30 text-muted-foreground hover:text-foreground',
      )}
      title={on
        ? 'Guarded writes: every external write capability requires a per-run approval. Explicit Approval blocks remain independent.'
        : 'Autonomous writes: allowed workflow actions execute without a per-run approval. Policies, scopes and audit logs still apply.'}
    >
      {on ? <ShieldCheck className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
      {on ? 'Writes: Guarded' : 'Writes: Auto'}
    </button>
  );
}
