// Per-run audit-trail panel. Slides in over RunsDrawer when 'Audit' is clicked.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, X, ShieldCheck, ShieldAlert, ShieldX, Activity, Brain, ScrollText } from 'lucide-react';
import { useRunAudit } from '@/api/stats';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';
import { InspectorPanel } from './InspectorPanel';

type Tab = 'execution' | 'audit' | 'memories' | 'hooks';

interface StepExecutionResult {
  status?: string;
  result?: unknown;
  error?: string;
  duration_ms?: number;
  started_at?: string;
  completed_at?: string;
  approval_request_id?: number;
}

interface WorkflowRunDetail {
  id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  triggered_by: string | null;
  input_args: Record<string, unknown>;
  step_results: Record<string, StepExecutionResult>;
  error_message: string | null;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface Props {
  open: boolean;
  workflowId: number | null;
  runId: number | null;
  onClose: () => void;
}

export function AuditDrawer({ open, workflowId, runId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('execution');
  const { data, isLoading } = useRunAudit(workflowId, runId);
  const run = useQuery({
    queryKey: ['workflow-run-detail', workflowId, runId],
    queryFn: () => api.get<WorkflowRunDetail>(`/api/workflows/${workflowId}/runs/${runId}`),
    enabled: open && workflowId != null && runId != null,
    staleTime: 2_000,
  });

  useEffect(() => {
    if (open && runId != null) setTab('execution');
  }, [open, runId]);

  if (!open) return null;

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-[28rem] border-l border-border bg-card/95 backdrop-blur flex flex-col animate-slide-in-right z-30">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h3 className="text-small font-medium flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" /> Inspector
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {runId != null ? `Run #${runId}` : 'kein Run gewählt'}
          </p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary">
          <X className="w-3.5 h-3.5" />
        </button>
      </header>
      <div className="flex border-b border-border bg-card/40">
        {([
          { key: 'execution', label: 'Run log',  icon: ScrollText },
          { key: 'audit',    label: 'Audit',    icon: ShieldCheck },
          { key: 'hooks',    label: 'Hooks',    icon: ShieldAlert },
          { key: 'memories', label: 'Memory',   icon: Brain },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 py-1.5 text-xs border-b-2 transition',
              tab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <t.icon className="w-3 h-3" />
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'execution' && <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs" aria-label="Execution log">
        {run.isLoading && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> Loading execution log...
          </div>
        )}
        {run.isError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-red-300">
            The persisted execution log could not be loaded.
          </div>
        )}
        {run.data && <>
          <section className="rounded-md border border-border/70 bg-background/30 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <strong className="text-foreground">Execution #{run.data.id}</strong>
              <span className="uppercase text-[10px] tracking-wide text-muted-foreground">{run.data.status}</span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <dt>Triggered by</dt><dd className="text-right text-foreground">{run.data.triggered_by ?? 'Builder'}</dd>
              <dt>Started</dt><dd className="text-right text-foreground">{new Date(run.data.started_at).toLocaleString()}</dd>
              <dt>Duration</dt><dd className="text-right text-foreground">{run.data.duration_ms == null ? '—' : `${run.data.duration_ms} ms`}</dd>
            </dl>
            {run.data.error_message && <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-red-500/10 p-2 text-[11px] text-red-300">{run.data.error_message}</pre>}
          </section>

          {Object.keys(run.data.input_args ?? {}).length > 0 && (
            <details className="rounded-md border border-border/70 bg-background/30 px-3 py-2">
              <summary className="cursor-pointer font-medium text-foreground">Run input</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{formatValue(run.data.input_args)}</pre>
            </details>
          )}

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <strong className="text-foreground">Step output</strong>
              <span className="text-[10px] text-muted-foreground">{Object.keys(run.data.step_results ?? {}).length} steps</span>
            </div>
            {Object.entries(run.data.step_results ?? {}).length === 0 && (
              <div className="rounded-md border border-dashed border-border px-3 py-5 text-center text-muted-foreground">No step output was persisted.</div>
            )}
            {Object.entries(run.data.step_results ?? {}).map(([stepId, step]) => (
              <details key={stepId} className="rounded-md border border-border/70 bg-background/30" open={step.status === 'failed'}>
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                  <span className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    step.status === 'completed' ? 'bg-emerald-400' : step.status === 'failed' ? 'bg-red-400' : 'bg-amber-400',
                  )} />
                  <strong className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={stepId}>{stepId}</strong>
                  <span className="text-[10px] uppercase text-muted-foreground">{step.status ?? 'unknown'}</span>
                  {step.duration_ms != null && <span className="text-[10px] text-muted-foreground">{step.duration_ms} ms</span>}
                </summary>
                <div className="border-t border-border/60 p-3 space-y-2">
                  {step.error && <div><span className="text-[10px] uppercase tracking-wide text-red-300">Error</span><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-red-300">{step.error}</pre></div>}
                  {step.result !== undefined && <div><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Output</span><pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">{formatValue(step.result)}</pre></div>}
                  {step.approval_request_id != null && <p className="text-[11px] text-amber-300">Approval request #{step.approval_request_id}</p>}
                </div>
              </details>
            ))}
          </section>
        </>}
      </div>}
      {(tab === 'hooks' || tab === 'memories') && <InspectorPanel workflowId={workflowId} runId={runId} kind={tab} />}
      {tab === 'audit' && <div className="flex-1 overflow-y-auto p-2 space-y-1 text-xs">
        {isLoading && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> lädt…
          </div>
        )}
        {data && data.entries.length === 0 && (
          <div className="text-center py-6 text-muted-foreground">
            Kein Immutable-Audit-Log gefunden für dieses Run-Fenster.
          </div>
        )}
        {(data?.entries ?? []).map((e) => {
          const Icon = e.risk_level === 'high' ? ShieldX
                     : e.risk_level === 'medium' ? ShieldAlert
                     : Activity;
          const tone = e.risk_level === 'high' ? 'border-red-500/40 bg-red-500/5'
                     : e.risk_level === 'medium' ? 'border-amber-500/40 bg-amber-500/5'
                     : e.error_type ? 'border-red-500/30 bg-red-500/5'
                     : 'border-border/60';
          return (
            <div key={e.id} className={cn('rounded-md border px-2 py-1.5 text-[11px]', tone)}>
              <div className="flex items-center gap-1.5">
                <Icon className="w-3 h-3 shrink-0 text-muted-foreground" />
                <span className="font-mono text-[10px] text-muted-foreground">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <span className="font-medium text-foreground">{e.event_type}</span>
                {e.tool && <span className="text-muted-foreground">· {e.tool}</span>}
                {e.error_type && <span className="text-red-400">· {e.error_type}</span>}
              </div>
              {e.parameters && Object.keys(e.parameters).length > 0 && (
                <pre className="mt-1 text-[10px] font-mono text-muted-foreground truncate" title={JSON.stringify(e.parameters, null, 2)}>
                  {JSON.stringify(e.parameters).slice(0, 120)}
                </pre>
              )}
            </div>
          );
        })}
      </div>}
    </aside>
  );
}
