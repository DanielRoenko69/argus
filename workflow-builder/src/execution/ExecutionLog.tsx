// Bottom-docked execution console. It combines the selected run's live SSE
// events with persisted results and lets operators switch between concurrent
// or recent workflow executions without leaving the canvas.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, ChevronDown, ChevronRight, Copy, ExternalLink, GitBranch, Loader2, Radio, RotateCw, ShieldCheck, ShieldX, Webhook, X } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type { RunRow } from '@/api/builder';
import { useExecutionStore, type StepExecState } from '@/stores/executionStore';
import { useBuilderStore } from '@/stores/builderStore';
import { cn } from '@/lib/utils';
import { RunModal } from './RunModal';

interface RunDetailRow extends RunRow {
  input_args: Record<string, unknown>;
  waiting_approval_id: number | null;
  waiting_step_id: string | null;
  step_results: Record<string, {
    status?: string;
    result?: unknown;
    evidence?: unknown;
    error?: string;
    duration_ms?: number;
    started_at?: string;
    completed_at?: string;
  }>;
  child_executions?: Record<string, ChildRunEvidence[]>;
}

interface ExecutionLogProps {
  workflowId: number;
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'queued';
}

function isOpenStatus(status: string): boolean {
  return isActiveStatus(status) || status === 'waiting_for_approval';
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const value = (error.body as { error?: unknown }).error;
    if (typeof value === 'string') return value;
  }
  return error instanceof Error ? error.message : String(error);
}

function approvalMessage(detail: RunDetailRow | undefined): string | null {
  const stepId = detail?.waiting_step_id;
  const raw = stepId ? detail?.step_results[stepId]?.result : undefined;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : null;
  } catch {
    return null;
  }
}

function formatResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatRunTime(value: string | number | null | undefined): string {
  if (value == null) return 'time unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'time unknown'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface ChildRunEvidence {
  workflow_id: number;
  execution_id: number;
  trace_id: string | null;
  root_trace_id: string | null;
  status: string;
  started_at?: string;
  completed_at?: string | null;
  error?: string | null;
  parent_item_index?: number | null;
  retry_of_execution_id?: number | null;
}

interface ChildRunGroup {
  index: number | null;
  itemStatus: string;
  attempts: number;
  error?: string;
  runs: ChildRunEvidence[];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function childEvidence(value: unknown): ChildRunEvidence | null {
  const candidate = recordValue(value);
  if (!candidate) return null;
  const workflowId = Number(candidate['workflow_id']);
  const executionId = Number(candidate['execution_id']);
  const traceId = candidate['trace_id'];
  const rootTraceId = candidate['root_trace_id'];
  if (!Number.isInteger(workflowId) || !Number.isInteger(executionId)
    || (traceId !== null && traceId !== undefined && typeof traceId !== 'string')) return null;
  return {
    workflow_id: workflowId,
    execution_id: executionId,
    trace_id: typeof traceId === 'string' ? traceId : null,
    root_trace_id: typeof rootTraceId === 'string' ? rootTraceId : typeof traceId === 'string' ? traceId : null,
    status: typeof candidate['status'] === 'string' ? candidate['status'] : 'unknown',
    ...(typeof candidate['started_at'] === 'string' ? { started_at: candidate['started_at'] } : {}),
    ...(candidate['completed_at'] === null || typeof candidate['completed_at'] === 'string' ? { completed_at: candidate['completed_at'] as string | null } : {}),
    ...(candidate['error'] === null || typeof candidate['error'] === 'string' ? { error: candidate['error'] as string | null } : {}),
    ...(candidate['parent_item_index'] === null || Number.isInteger(Number(candidate['parent_item_index']))
      ? { parent_item_index: candidate['parent_item_index'] === null ? null : Number(candidate['parent_item_index']) }
      : {}),
    ...(candidate['retry_of_execution_id'] === null || Number.isInteger(Number(candidate['retry_of_execution_id']))
      ? { retry_of_execution_id: candidate['retry_of_execution_id'] === null ? null : Number(candidate['retry_of_execution_id']) }
      : {}),
  };
}

function childRunGroups(value: unknown, stepEvidence?: unknown, persisted: ChildRunEvidence[] = []): ChildRunGroup[] {
  const standalone = childEvidence(stepEvidence);
  const groups: ChildRunGroup[] = standalone
    ? [{ index: null, itemStatus: standalone.status, attempts: 1, runs: [standalone] }]
    : [];
  const root = recordValue(value);
  if (root) {
    const direct = childEvidence(root['evidence']);
    if (direct && !groups.some(group => group.runs.some(run => run.execution_id === direct.execution_id))) {
      groups.push({ index: null, itemStatus: direct.status, attempts: 1, runs: [direct] });
    }
    if (Array.isArray(root['results'])) {
      for (const entry of root['results']) {
        const item = recordValue(entry);
        if (!item) continue;
        const candidates = [
          ...(Array.isArray(item['attempt_evidence']) ? item['attempt_evidence'] : []),
          item['evidence'],
        ];
        const seen = new Set<number>();
        const runs = candidates.flatMap(candidate => {
          const parsed = childEvidence(candidate);
          if (!parsed || seen.has(parsed.execution_id)) return [];
          seen.add(parsed.execution_id);
          return [parsed];
        });
        if (runs.length === 0) continue;
        groups.push({
          index: Number.isInteger(Number(item['index'])) ? Number(item['index']) : null,
          itemStatus: typeof item['status'] === 'string' ? item['status'] : runs.at(-1)?.status ?? 'unknown',
          attempts: Number.isInteger(Number(item['attempts'])) ? Number(item['attempts']) : runs.length,
          ...(typeof item['error'] === 'string' ? { error: item['error'] } : {}),
          runs,
        });
      }
    }
  }

  for (const candidate of persisted) {
    const run = childEvidence(candidate);
    if (!run) continue;
    const index = run.parent_item_index ?? null;
    let group = groups.find(current => current.index === index);
    if (!group) {
      group = { index, itemStatus: run.status, attempts: 0, runs: [] };
      groups.push(group);
    }
    if (!group.runs.some(existing => existing.execution_id === run.execution_id)) group.runs.push(run);
  }

  for (const group of groups) {
    group.runs.sort((left, right) => {
      const leftTime = left.started_at ? new Date(left.started_at).getTime() : left.execution_id;
      const rightTime = right.started_at ? new Date(right.started_at).getTime() : right.execution_id;
      return leftTime - rightTime;
    });
    group.attempts = Math.max(group.attempts, group.runs.length);
    const latest = group.runs.at(-1);
    if (!latest) continue;
    if (latest.status === 'completed' && group.itemStatus === 'failed') group.itemStatus = 'recovered';
    else if (latest.status !== 'failed' || group.itemStatus === 'failed') group.itemStatus = latest.status;
    group.error = latest.status === 'failed' ? latest.error ?? group.error : undefined;
  }
  return groups.sort((left, right) => (left.index ?? -1) - (right.index ?? -1));
}

function hasActiveChildExecutions(detail: RunDetailRow | undefined): boolean {
  return Object.values(detail?.child_executions ?? {}).some(children => children.some(child => isOpenStatus(child.status)));
}

export function ExecutionLog({ workflowId }: ExecutionLogProps) {
  const queryClient = useQueryClient();
  const open = useExecutionStore((state) => state.logOpen);
  const setOpen = useExecutionStore((state) => state.setLogOpen);
  const liveStepStates = useExecutionStore((state) => state.stepStates);
  const executionId = useExecutionStore((state) => state.executionId);
  const executionStartedAt = useExecutionStore((state) => state.executionStartedAt);
  const running = useExecutionStore((state) => state.running);
  const finalError = useExecutionStore((state) => state.finalError);
  const selectRun = useExecutionStore((state) => state.selectRun);
  const syncRunStatus = useExecutionStore((state) => state.syncRunStatus);
  const nodes = useBuilderStore((state) => state.nodes);
  const [approvalComment, setApprovalComment] = useState('');
  const [copiedTraceId, setCopiedTraceId] = useState<string | null>(null);
  const [retryOpen, setRetryOpen] = useState(false);

  const runsQuery = useQuery({
    queryKey: ['execution-log-runs', workflowId],
    queryFn: () => api.get<{ runs: RunRow[] }>(`/api/workflows/${workflowId}/runs`),
    enabled: open,
    refetchInterval: (query) => query.state.data?.runs.some(run => isOpenStatus(run.status)) ? 2_000 : 10_000,
  });

  const runs = useMemo(() => {
    const persisted = [...(runsQuery.data?.runs ?? [])];
    if (executionId != null && !persisted.some(run => run.id === executionId)) {
      persisted.unshift({
        id: executionId,
        workflow_id: workflowId,
        status: running ? 'running' : 'completed',
        started_at: new Date(executionStartedAt ?? Date.now()).toISOString(),
        completed_at: null,
        duration_ms: null,
        triggered_by: 'Builder',
        error_message: finalError,
      });
    }
    return persisted;
  }, [executionId, executionStartedAt, finalError, runsQuery.data?.runs, running, workflowId]);

  const selectedRun = runs.find(run => run.id === executionId) ?? null;
  const detailQuery = useQuery({
    queryKey: ['workflow-run-detail', workflowId, executionId],
    queryFn: () => api.get<RunDetailRow>(`/api/workflows/${workflowId}/runs/${executionId}`),
    enabled: open && executionId != null,
    staleTime: selectedRun && isOpenStatus(selectedRun.status) ? 0 : 5_000,
    refetchInterval: query => selectedRun && (isOpenStatus(selectedRun.status)
      || hasActiveChildExecutions(query.state.data)) ? 2_000 : false,
  });

  const childRetry = useMutation({
    mutationFn: (input: { stepId: string; itemIndex: number }) => {
      if (executionId == null) throw new Error('Select a parent run before retrying a child item');
      return api.post<{
        executionId: number;
        traceId: string;
        status: string;
      }>(`/api/workflows/${workflowId}/runs/${executionId}/steps/${encodeURIComponent(input.stepId)}/items/${input.itemIndex}/retry`);
    },
    onSuccess: async () => {
      await detailQuery.refetch();
    },
  });

  const approvalDecision = useMutation({
    mutationFn: (input: { approvalId: number; action: 'approve' | 'reject'; comment: string }) =>
      api.post(`/api/ui/governance/runtime-approvals/${input.approvalId}/${input.action}`, {
        comment: input.comment,
      }),
    onSuccess: async () => {
      setApprovalComment('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['execution-log-runs', workflowId] }),
        queryClient.invalidateQueries({ queryKey: ['workflow-run-detail', workflowId, executionId] }),
      ]);
    },
  });

  useEffect(() => {
    if (!open || executionId != null || runs.length === 0) return;
    const first = runs[0]!;
    selectRun(first.id, first.status, first.started_at);
  }, [executionId, open, runs, selectRun]);

  useEffect(() => {
    if (!selectedRun) return;
    syncRunStatus(selectedRun.id, selectedRun.status, selectedRun.error_message);
    if (!isActiveStatus(selectedRun.status)) void detailQuery.refetch();
  // Refetch once when a run transitions to a terminal state. The query object
  // itself is intentionally omitted to avoid a refetch loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun?.error_message, selectedRun?.id, selectedRun?.status, syncRunStatus]);

  useEffect(() => {
    setApprovalComment('');
    setCopiedTraceId(null);
    setRetryOpen(false);
    approvalDecision.reset();
  // The mutation reset function is stable; only changing the selected run
  // should clear its local review note and decision error.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionId]);

  const stepStates = useMemo(() => {
    const merged: Record<string, StepExecState> = {};
    for (const [stepId, state] of Object.entries(detailQuery.data?.step_results ?? {})) {
      merged[stepId] = {
        status: state.status === 'running' || state.status === 'waiting' || state.status === 'failed' || state.status === 'skipped'
          ? state.status
          : 'completed',
        durationMs: state.duration_ms,
        result: formatResult(state.result),
        rawResult: state.result,
        rawEvidence: state.evidence,
        error: state.error,
      };
    }
    for (const [stepId, state] of Object.entries(liveStepStates)) merged[stepId] = state;
    return merged;
  }, [detailQuery.data?.step_results, liveStepStates]);

  const rows = useMemo(() => {
    const orderedIds = [
      ...nodes.map(node => node.id).filter(id => stepStates[id]),
      ...Object.keys(stepStates).filter(id => !nodes.some(node => node.id === id)),
    ];
    return orderedIds.map(stepId => {
      const node = nodes.find(candidate => candidate.id === stepId);
      return {
        stepId,
        label: (node?.data as { label?: string } | undefined)?.label ?? stepId,
        type: node?.type ?? '?',
        state: stepStates[stepId]!,
      };
    });
  }, [nodes, stepStates]);

  if (!open) return null;
  const activeCount = runs.filter(run => isOpenStatus(run.status)).length;
  const waitingApprovalId = detailQuery.data?.waiting_approval_id ?? selectedRun?.waiting_approval_id ?? null;
  const waitingStepId = detailQuery.data?.waiting_step_id ?? selectedRun?.waiting_step_id ?? null;
  const waitingMessage = approvalMessage(detailQuery.data);
  const traceId = detailQuery.data?.trace_id ?? selectedRun?.trace_id ?? null;
  const rootTraceId = detailQuery.data?.root_trace_id ?? selectedRun?.root_trace_id ?? traceId;
  const failedStepIds = Object.entries(detailQuery.data?.step_results ?? {})
    .filter(([, result]) => result.status === 'failed')
    .map(([stepId]) => stepId);
  const triggerEvidence = detailQuery.data?.trigger_evidence ?? selectedRun?.trigger_evidence;

  const copyTraceId = async () => {
    if (!rootTraceId) return;
    await navigator.clipboard.writeText(rootTraceId);
    setCopiedTraceId(rootTraceId);
    window.setTimeout(() => setCopiedTraceId(current => current === rootTraceId ? null : current), 1_500);
  };

  return (
    <div className="absolute bottom-0 left-0 right-0 min-h-[15rem] max-h-[48%] bg-card/95 backdrop-blur border-t border-border flex flex-col animate-slide-in-bottom z-10" aria-label="Execution log console">
      <header className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-small font-medium">Execution Log</span>
          {executionId != null && <span className="text-xs text-foreground">Run #{executionId}</span>}
          {selectedRun && <span className="text-[10px] text-muted-foreground">started {formatRunTime(selectedRun.started_at)}</span>}
          {selectedRun?.retry_of_execution_id != null && <span className="text-[10px] text-primary">retry of #{selectedRun.retry_of_execution_id}</span>}
          {running && <span className="inline-flex items-center gap-1 text-xs text-amber-400"><Radio className="w-3 h-3 animate-pulse" />live</span>}
          {!running && selectedRun?.status === 'waiting_for_approval' && <span className="inline-flex items-center gap-1 text-xs text-amber-300"><ShieldCheck className="w-3 h-3" />approval #{waitingApprovalId ?? '?'}</span>}
          {!running && selectedRun?.status === 'completed' && <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="w-3 h-3" />completed</span>}
        </div>
        <div className="flex items-center gap-3">
          {activeCount > 0 && <span className="text-[10px] text-amber-300">{activeCount} active</span>}
          <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary" title="Close execution log">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-border bg-background/25 p-2" aria-label="Workflow executions">
          <div className="flex items-center justify-between px-1 pb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>Runs</span><span>{runs.length}</span>
          </div>
          {runsQuery.isLoading && runs.length === 0 && <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading runs...</div>}
          {runs.map(run => {
            const active = isActiveStatus(run.status);
            const waiting = run.status === 'waiting_for_approval';
            return (
              <button
                type="button"
                key={run.id}
                className={cn(
                  'mb-1 flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition',
                  executionId === run.id ? 'border-primary/60 bg-primary/10' : 'border-transparent hover:border-border hover:bg-secondary/40',
                )}
                onClick={() => selectRun(run.id, run.status, run.started_at)}
                aria-label={`Open run ${run.id}, ${run.status}, started ${formatRunTime(run.started_at)}`}
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', active ? 'bg-amber-400 animate-pulse' : waiting ? 'bg-amber-300' : run.status === 'completed' ? 'bg-emerald-500' : run.status === 'failed' ? 'bg-red-500' : 'bg-zinc-500')} />
                <span className="min-w-0 flex-1">
                  <b className="block text-xs text-foreground">Run #{run.id}</b>
                  <small className="block truncate text-[10px] text-muted-foreground">
                    {formatRunTime(run.started_at)} · {run.retry_of_execution_id != null ? `retry of #${run.retry_of_execution_id}` : run.triggered_by ?? 'Builder'}
                  </small>
                </span>
                <span className="text-[9px] uppercase text-muted-foreground">{active ? 'live' : waiting ? `approval #${run.waiting_approval_id ?? '?'}` : run.status.replaceAll('_', ' ')}</span>
              </button>
            );
          })}
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto p-2 space-y-1 text-xs" aria-label={executionId == null ? 'Run events' : `Run ${executionId} events`}>
          {(detailQuery.isLoading || (running && rows.length === 0)) && (
            <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Waiting for run events...</div>
          )}
          {detailQuery.isError && rows.length === 0 && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-red-300">Persisted run output could not be loaded.</div>
          )}
          {!detailQuery.isLoading && !running && rows.length === 0 && (
            <div className="text-center py-4 text-muted-foreground">No events were persisted for this run.</div>
          )}
          {selectedRun?.status === 'waiting_for_approval' && waitingApprovalId != null && (
            <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3" aria-label={`Runtime approval ${waitingApprovalId}`}>
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                <div className="min-w-0 flex-1">
                  <strong className="text-amber-200">Run #{executionId} wartet auf Approval #{waitingApprovalId}</strong>
                  <p className="mt-1 text-foreground/80">{waitingMessage ?? `Freigabe für Schritt '${waitingStepId ?? 'approval'}' erforderlich.`}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">Write-Risk-Modi steuern automatische Tool-Gates. Dieser explizite Approval-Node verlangt immer eine menschliche Entscheidung.</p>
                </div>
              </div>
              <input
                type="text"
                value={approvalComment}
                onChange={event => setApprovalComment(event.target.value)}
                className="mt-3 w-full rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                placeholder="Review note (required for rejection)"
                aria-label="Approval review note"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={approvalDecision.isPending || approvalComment.trim().length === 0}
                  onClick={() => approvalDecision.mutate({ approvalId: waitingApprovalId, action: 'reject', comment: approvalComment.trim() })}
                  className="inline-flex items-center gap-1 rounded-md border border-red-500/30 px-2.5 py-1.5 text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ShieldX className="h-3.5 w-3.5" />Reject
                </button>
                <button
                  type="button"
                  disabled={approvalDecision.isPending}
                  onClick={() => approvalDecision.mutate({ approvalId: waitingApprovalId, action: 'approve', comment: approvalComment.trim() })}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {approvalDecision.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}Approve
                </button>
              </div>
              {approvalDecision.isError && <p className="mt-2 text-red-300">{errorMessage(approvalDecision.error)}</p>}
            </div>
          )}
          {selectedRun?.status !== 'waiting_for_approval' && (finalError || detailQuery.data?.error_message) && (
            <pre className="rounded-md border border-red-500/30 bg-red-500/5 p-2 whitespace-pre-wrap break-words text-red-300">{finalError ?? detailQuery.data?.error_message}</pre>
          )}
          {triggerEvidence?.event_id && (
            <section className="rounded-md border border-cyan-400/25 bg-cyan-400/5 px-3 py-2" aria-label="Trigger evidence">
              <div className="flex items-start gap-2">
                <Webhook className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <strong className="text-xs text-foreground">Automated trigger</strong>
                    <span className="text-[10px] uppercase text-cyan-300">{triggerEvidence.source ?? 'webhook'}</span>
                    <span className="text-[10px] text-muted-foreground">{triggerEvidence.event_type ?? 'event'}</span>
                    {triggerEvidence.mode === 'local_test' && <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-violet-300">Local test</span>}
                    {triggerEvidence.received_at && <time className="text-[10px] text-muted-foreground">received {formatRunTime(triggerEvidence.received_at)}</time>}
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-[10px] text-muted-foreground">Event ID</span>
                    <code className="min-w-0 select-all truncate text-[10px] text-foreground" title={triggerEvidence.event_id}>{triggerEvidence.event_id}</code>
                  </div>
                  {detailQuery.data?.input_args && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[10px] text-cyan-300 hover:text-cyan-200">Show normalized workflow inputs</summary>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-background/50 p-2 text-[10px] text-foreground">{JSON.stringify(detailQuery.data.input_args, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </div>
            </section>
          )}
          {selectedRun?.status === 'failed' && failedStepIds.length > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2" aria-label="Failed run recovery">
              <div className="min-w-0">
                <strong className="block text-xs text-foreground">Checkpoint-Retry verfügbar</strong>
                <span className="block truncate text-[10px] text-muted-foreground">
                  Erfolgreiche Schritte bleiben erhalten · Fehler: {failedStepIds.join(', ')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setRetryOpen(true)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-xs text-primary hover:bg-primary/20"
              >
                <RotateCw className="h-3.5 w-3.5" /> Retry ab {failedStepIds[0]}
              </button>
            </div>
          )}
          {rows.map(row => <LogRow
            key={row.stepId}
            {...row}
            persistedChildRuns={detailQuery.data?.child_executions?.[row.stepId] ?? []}
            onRetryChild={(stepId, itemIndex) => childRetry.mutate({ stepId, itemIndex })}
            retryingItem={childRetry.variables ?? null}
            retryPending={childRetry.isPending}
            retryError={childRetry.isError ? childRetry.error : null}
          />)}
          {rootTraceId && (
            <footer className="sticky bottom-0 mt-2 flex min-w-0 items-center gap-2 rounded-md border border-primary/25 bg-background/95 px-3 py-2 shadow-lg backdrop-blur" aria-label="Selected run trace">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-primary">Trace ID</span>
              <code className="min-w-0 flex-1 select-all truncate text-[11px] text-foreground" title={rootTraceId}>{rootTraceId}</code>
              <button
                type="button"
                onClick={() => void copyTraceId()}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                title="Copy trace ID"
              >
                {copiedTraceId === rootTraceId ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                {copiedTraceId === rootTraceId ? 'Copied' : 'Copy'}
              </button>
              <a
                href={`/observe/logs?root_trace=${encodeURIComponent(rootTraceId)}`}
                target="_top"
                className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
              >
                Open logs <ExternalLink className="h-3 w-3" />
              </a>
            </footer>
          )}
        </section>
      </div>
      <RunModal
        open={retryOpen}
        workflowId={workflowId}
        retryRunId={executionId}
        retryStepIds={failedStepIds}
        prefill={detailQuery.data?.input_args ?? null}
        onClose={() => setRetryOpen(false)}
      />
    </div>
  );
}

interface LogRowProps {
  stepId: string;
  label: string;
  type: string;
  state: { status: string; durationMs?: number; result?: string; rawResult?: unknown; rawEvidence?: unknown; error?: string };
  persistedChildRuns: ChildRunEvidence[];
  onRetryChild: (stepId: string, itemIndex: number) => void;
  retryingItem: { stepId: string; itemIndex: number } | null;
  retryPending: boolean;
  retryError: unknown;
}

function LogRow({ stepId, label, type, state, persistedChildRuns, onRetryChild, retryingItem, retryPending, retryError }: LogRowProps) {
  const [expanded, setExpanded] = useState(false);
  const childRuns = childRunGroups(state.rawResult, state.rawEvidence, persistedChildRuns);
  const dot =
    state.status === 'running'   ? 'bg-amber-400 animate-pulse' :
    state.status === 'waiting'   ? 'bg-amber-300' :
    state.status === 'completed' ? 'bg-emerald-500' :
    state.status === 'failed'    ? 'bg-red-500' :
    state.status === 'skipped'   ? 'bg-zinc-500' :
                                   'bg-zinc-700';
  const hasDetail = Boolean(state.result || state.error || childRuns.length > 0);
  const childRunCount = childRuns.reduce((total, group) => total + group.runs.length, 0);

  return (
    <div className={cn('rounded-md border border-border/60', expanded && 'bg-secondary/40')}>
      <button
        onClick={() => hasDetail && setExpanded(value => !value)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-secondary/30 rounded-md"
        disabled={!hasDetail}
      >
        <div className={cn('w-2 h-2 rounded-full shrink-0', dot)} />
        <span className="font-medium truncate flex-1">{label}</span>
        {childRunCount > 0 && <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[9px] font-semibold text-violet-300">{childRunCount} child run{childRunCount === 1 ? '' : 's'}</span>}
        <span className="text-muted-foreground font-mono text-[10px]">{type}</span>
        {state.durationMs != null && <span className="text-muted-foreground text-[10px]">{state.durationMs}ms</span>}
        {hasDetail && (expanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />)}
      </button>
      {expanded && hasDetail && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2">
          {childRuns.length > 0 && <ChildRunEvidence
            groups={childRuns}
            stepId={stepId}
            onRetry={onRetryChild}
            retryingItem={retryingItem}
            retryPending={retryPending}
            retryError={retryError}
          />}
          {(state.error || state.result) && (
            <details open={childRuns.length === 0}>
              {childRuns.length > 0 && <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground hover:text-foreground">Raw step output</summary>}
              <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                {state.error ? <span className="text-red-400">{state.error}</span> : state.result}
              </pre>
            </details>
          )}
        </div>
      )}
      <span className="sr-only">{stepId}</span>
    </div>
  );
}

function ChildRunEvidence({
  groups,
  stepId,
  onRetry,
  retryingItem,
  retryPending,
  retryError,
}: {
  groups: ChildRunGroup[];
  stepId: string;
  onRetry: (stepId: string, itemIndex: number) => void;
  retryingItem: { stepId: string; itemIndex: number } | null;
  retryPending: boolean;
  retryError: unknown;
}) {
  return (
    <section className="space-y-1.5" aria-label="Child workflow runs">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
        <GitBranch className="h-3.5 w-3.5" /> Persisted child executions
      </div>
      {groups.map((group, groupIndex) => (
        <div key={`${group.index ?? 'direct'}-${groupIndex}`} className="rounded border border-border/70 bg-background/40 p-2">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px]">
            <strong className="text-foreground">{group.index == null ? 'Sub-workflow' : `Item #${group.index + 1}`}</strong>
            <span className={cn('uppercase', group.itemStatus === 'completed' || group.itemStatus === 'recovered' ? 'text-emerald-400' : group.itemStatus === 'failed' ? 'text-red-400' : 'text-amber-300')}>{group.itemStatus}</span>
            <span className="text-muted-foreground">{group.attempts} attempt{group.attempts === 1 ? '' : 's'}</span>
            {group.error && <span className="min-w-0 truncate text-red-300" title={group.error}>{group.error}</span>}
            {group.index != null && group.runs.at(-1)?.status === 'failed' && (
              <button
                type="button"
                disabled={retryPending}
                onClick={() => onRetry(stepId, group.index!)}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-primary/35 bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`Retry item ${group.index + 1}`}
              >
                {retryPending && retryingItem?.stepId === stepId && retryingItem.itemIndex === group.index
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RotateCw className="h-3 w-3" />}
                Retry item
              </button>
            )}
          </div>
          <div className="space-y-1">
            {group.runs.map((run, runIndex) => (
              <div key={run.execution_id} className="flex min-w-0 items-center gap-2 rounded border border-border/50 px-2 py-1.5 text-[10px]">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', run.status === 'completed' ? 'bg-emerald-500' : run.status === 'failed' ? 'bg-red-500' : 'bg-amber-400')} />
                <strong className="shrink-0 text-foreground">Run #{run.execution_id}</strong>
                {group.runs.length > 1 && <span className="shrink-0 text-muted-foreground">attempt {runIndex + 1}</span>}
                <code className="min-w-0 flex-1 truncate text-muted-foreground" title={run.trace_id ?? undefined}>{run.trace_id ?? 'trace starting…'}</code>
                {run.trace_id && <a href={`/runs/workflow/${encodeURIComponent(run.trace_id)}`} target="_top" className="inline-flex shrink-0 items-center gap-1 text-violet-300 hover:text-violet-200">Trace <ExternalLink className="h-3 w-3" /></a>}
                {run.trace_id && <a href={`/observe/logs?trace=${encodeURIComponent(run.trace_id)}`} target="_top" className="inline-flex shrink-0 items-center gap-1 text-primary hover:text-primary/80">Logs <ExternalLink className="h-3 w-3" /></a>}
              </div>
            ))}
          </div>
          {group.index != null && Boolean(retryError) && retryingItem?.stepId === stepId && retryingItem.itemIndex === group.index && (
            <p className="mt-1.5 text-[10px] text-red-300">{errorMessage(retryError)}</p>
          )}
        </div>
      ))}
    </section>
  );
}
