// Unified workflow history: Core executions plus durable Argus.Dev visual runs.

import { usePackRuns, useRuns } from '@/api/builder';
import {
  AlertCircle, Bot, Check, Clock, ExternalLink, GitBranch, Loader2,
  MinusCircle, OctagonX, Play, RotateCw, ScrollText, X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import { cancelWorkflowReplay } from '@/api/replay';
import { RunModal } from './RunModal';
import { AuditDrawer } from './AuditDrawer';

interface Props {
  open: boolean;
  workflowId: number | null;
  initialRunId?: number | null;
  onClose: () => void;
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs == null) return null;
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

function RunStatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <Check className="w-3.5 h-3.5 shrink-0 text-emerald-400" />;
  if (status === 'failed') return <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />;
  if (status === 'cancelled' || status === 'canceled') return <MinusCircle className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />;
  if (status === 'running' || status === 'queued') return <Loader2 className="w-3.5 h-3.5 shrink-0 text-amber-400 animate-spin" />;
  return <Clock className="w-3.5 h-3.5 shrink-0 text-amber-400" />;
}

export function RunsDrawer({ open, workflowId, initialRunId = null, onClose }: Props) {
  const coreRuns = useRuns(workflowId);
  const packRuns = usePackRuns(workflowId, open);
  const [replayPrefill, setReplayPrefill] = useState<Record<string, unknown> | null>(null);
  const [auditRunId, setAuditRunId] = useState<number | null>(initialRunId);
  const cancelPackRun = useMutation({
    mutationFn: ({ traceId }: { traceId: string }) => cancelWorkflowReplay(workflowId!, traceId),
    onSuccess: () => { void packRuns.refetch(); },
  });

  async function onRepeat(runId: number) {
    if (!workflowId) return;
    try {
      const run = await api.get<{ input_args: Record<string, unknown> }>(`/api/workflows/${workflowId}/runs/${runId}`);
      setReplayPrefill(run.input_args ?? {});
    } catch { /* the run may have been removed between list and selection */ }
  }

  useEffect(() => {
    if (open && initialRunId != null) setAuditRunId(initialRunId);
  }, [initialRunId, open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      void coreRuns.refetch();
      void packRuns.refetch();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [open, coreRuns.refetch, packRuns.refetch]);

  if (!open) return null;
  const visualRuns = packRuns.data?.runs ?? [];
  const executions = coreRuns.data?.runs ?? [];

  return (
    <aside className="builder-runs-drawer" aria-label="Workflow run history">
      <header>
        <div>
          <span>EXECUTION HISTORY</span>
          <h3>Runs</h3>
          <p>{visualRuns.length + executions.length} geladene Ausführungen</p>
        </div>
        <button onClick={onClose} aria-label="Run-History schließen" title="Run-History schließen">
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="builder-runs-body">
        <section>
          <div className="builder-runs-section-heading">
            <div><GitBranch className="w-3.5 h-3.5" /><span>ARGUS.DEV · VISUAL RUNS</span></div>
            <strong>{visualRuns.length}</strong>
          </div>
          {packRuns.isLoading ? (
            <div className="builder-runs-empty"><Loader2 className="w-4 h-4 animate-spin" /> Lädt Visual Runs…</div>
          ) : packRuns.isError ? (
            <div className="builder-runs-empty is-error"><AlertCircle className="w-4 h-4" /> Argus.Dev-Historie ist derzeit nicht erreichbar.</div>
          ) : visualRuns.length === 0 ? (
            <div className="builder-runs-empty">Noch keine Visual Runs für diesen Workflow.</div>
          ) : visualRuns.map(run => (
            <article key={run.traceId} className="builder-run-card is-pack">
              <div className="builder-run-card-title">
                <RunStatusIcon status={run.status} />
                <div><strong>{run.title}</strong><span>{run.currentStage ? `Stage · ${run.currentStage}` : 'Visual workflow'}</span></div>
                <em>{run.status.replaceAll('_', ' ')}</em>
              </div>
              <dl>
                <div><dt>Trace</dt><dd>{run.traceId.slice(0, 8)}…</dd></div>
                <div><dt>Steps</dt><dd>{run.stepCount}</dd></div>
                <div><dt>Agents</dt><dd>{run.agentStepCount}</dd></div>
                {formatDuration(run.durationMs) && <div><dt>Duration</dt><dd>{formatDuration(run.durationMs)}</dd></div>}
              </dl>
              {run.error && <p className="builder-run-error" title={run.error}>{run.error}</p>}
              {cancelPackRun.isError && cancelPackRun.variables?.traceId === run.traceId && (
                <p className="builder-run-error">
                  {cancelPackRun.error instanceof Error ? cancelPackRun.error.message : 'Run konnte nicht abgebrochen werden.'}
                </p>
              )}
              <footer>
                <span>{run.createdAt ? new Date(run.createdAt).toLocaleString() : 'Zeit unbekannt'}</span>
                <div>
                  {run.canCancel && (
                    <button
                      type="button"
                      disabled={cancelPackRun.isPending}
                      onClick={() => cancelPackRun.mutate({ traceId: run.traceId })}
                      title="Run am sicheren Checkpoint abbrechen"
                    >
                      {cancelPackRun.isPending && cancelPackRun.variables?.traceId === run.traceId
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <OctagonX className="w-3 h-3" />}
                      Abbrechen
                    </button>
                  )}
                  {run.canResume && (
                    <a href={run.replayHref} target="_top" title="Approval im Replay bearbeiten">
                      <Play className="w-3 h-3" /> Fortsetzen
                    </a>
                  )}
                  <a href={run.replayHref} target="_top">Evidence <ExternalLink className="w-3 h-3" /></a>
                </div>
              </footer>
            </article>
          ))}
        </section>

        <section>
          <div className="builder-runs-section-heading">
            <div><Bot className="w-3.5 h-3.5" /><span>ARGUS CORE · API EXECUTIONS</span></div>
            <strong>{executions.length}</strong>
          </div>
          {coreRuns.isLoading ? (
            <div className="builder-runs-empty"><Loader2 className="w-4 h-4 animate-spin" /> Lädt Core Runs…</div>
          ) : executions.length === 0 ? (
            <div className="builder-runs-empty">Noch keine direkten Core-Executions.</div>
          ) : executions.map(run => (
            <article key={run.id} className="builder-run-card">
              <div className="builder-run-card-title">
                <RunStatusIcon status={run.status} />
                <div><strong>Execution #{run.id}</strong><span>{run.triggered_by ?? 'Builder'}</span></div>
                <em>{run.status}</em>
              </div>
              {run.error_message && <p className="builder-run-error" title={run.error_message}>{run.error_message}</p>}
              <footer>
                <span>{new Date(run.started_at).toLocaleString()}{formatDuration(run.duration_ms) ? ` · ${formatDuration(run.duration_ms)}` : ''}</span>
                <div>
                  <button onClick={() => void onRepeat(run.id)} title="Mit denselben Inputs erneut ausführen">
                    <RotateCw className="w-3 h-3" /> Wiederholen
                  </button>
                  <button onClick={() => setAuditRunId(run.id)} title="Run-Log und Audit-Evidence anzeigen">
                    <ScrollText className="w-3 h-3" /> Run log
                  </button>
                </div>
              </footer>
            </article>
          ))}
        </section>
      </div>

      <RunModal open={replayPrefill != null} workflowId={workflowId} prefill={replayPrefill} onClose={() => setReplayPrefill(null)} />
      <AuditDrawer open={auditRunId != null} workflowId={workflowId} runId={auditRunId} onClose={() => setAuditRunId(null)} />
    </aside>
  );
}
