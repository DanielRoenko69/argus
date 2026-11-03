// Workflow lifecycle status badge + actions (Submit/Approve/Reject/Withdraw).

import { useState } from 'react';
import { Loader2, ShieldCheck, ShieldAlert, Send, Check, X, Undo2 } from 'lucide-react';
import { useFlow } from '@/api/workflows';
import { useApprovalAction } from '@/api/approval';
import { cn } from '@/lib/utils';

interface Props { workflowId: number | null }

const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft:      { label: 'Draft',      cls: 'bg-zinc-700 text-zinc-200' },
  review:     { label: 'In Review',  cls: 'bg-amber-600/30 text-amber-300 border border-amber-600/50' },
  production: { label: 'Production', cls: 'bg-emerald-700/30 text-emerald-300 border border-emerald-700/50' },
};

export function LifecycleBadge({ workflowId }: Props) {
  const { data: flow } = useFlow(workflowId);
  const action = useApprovalAction(workflowId);
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const status = flow?.lifecycle_status ?? 'draft';
  const meta = STATUS_META[status] ?? STATUS_META['draft']!;

  if (!flow) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn('px-2 py-0.5 rounded-md text-[11px] font-medium transition', meta.cls)}
        title="Lifecycle-Status"
      >
        {meta.label}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 w-72 bg-card border border-border rounded-md shadow-2xl p-3 animate-fade-in"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="text-xs font-medium mb-2 flex items-center gap-1">
            {status === 'production' ? <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> :
              status === 'review' ? <ShieldAlert className="w-3.5 h-3.5 text-amber-400" /> :
              <Send className="w-3.5 h-3.5 text-muted-foreground" />}
            Status: <span className={meta.cls.split(' ')[1]}>{meta.label}</span>
          </div>

          {status === 'draft' && (
            <>
              <p className="text-[11px] text-muted-foreground mb-2">
                Workflow zum Review einreichen. Ein anderer User mit Admin- oder Reviewer-Rolle kann dann approven oder rejecten.
              </p>
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Optional: Kommentar für Reviewer"
                className="w-full text-[11px] px-2 py-1 rounded bg-input border border-border mb-1.5 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                onClick={() => action.mutate({ action: 'submit-for-review', comment })}
                disabled={action.isPending}
                className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded bg-primary text-primary-foreground text-xs disabled:opacity-50"
              >
                {action.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
                <Send className="w-3 h-3" /> Submit for Review
              </button>
            </>
          )}

          {status === 'review' && (
            <>
              <p className="text-[11px] text-muted-foreground mb-2">
                Wartet auf Approval. Du brauchst Admin/Reviewer-Rolle, und kannst nicht deine eigene Submission approven.
              </p>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                placeholder="Optional: Kommentar"
                className="w-full text-[11px] px-2 py-1 rounded bg-input border border-border mb-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="grid grid-cols-3 gap-1">
                <button onClick={() => action.mutate({ action: 'approve', comment })} disabled={action.isPending}
                  className="flex items-center justify-center gap-1 px-2 py-1 rounded bg-emerald-600 text-white text-xs hover:bg-emerald-500">
                  <Check className="w-3 h-3" /> Approve
                </button>
                <button onClick={() => action.mutate({ action: 'reject', comment })} disabled={action.isPending || !comment.trim()}
                  className="flex items-center justify-center gap-1 px-2 py-1 rounded bg-red-600 text-white text-xs hover:bg-red-500 disabled:opacity-50"
                  title={comment.trim() ? 'Reject' : 'Kommentar pflicht für reject'}>
                  <X className="w-3 h-3" /> Reject
                </button>
                <button onClick={() => action.mutate({ action: 'withdraw' })} disabled={action.isPending}
                  className="flex items-center justify-center gap-1 px-2 py-1 rounded bg-secondary text-xs hover:bg-secondary/70">
                  <Undo2 className="w-3 h-3" /> Withdraw
                </button>
              </div>
            </>
          )}

          {status === 'production' && (
            <p className="text-[11px] text-muted-foreground">
              Produktiv. Cron + Webhook-Trigger sind aktiv. Nur Admins können editieren — andere User sind Read-Only.
            </p>
          )}

          {action.isError && <div className="text-[11px] text-red-400 mt-2">{String(action.error)}</div>}
        </div>
      )}
    </div>
  );
}
