import { useEffect, useState } from 'react';
import { Bot, Check, Clock3, Copy, ExternalLink, GitBranch, Route, X } from 'lucide-react';
import type { WorkflowReplayStep } from '@/api/replay';

interface ReplayEvidenceDrawerProps {
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  rootTraceId: string;
  step: WorkflowReplayStep | null;
  onClose: () => void;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null) return '—';
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes} min ${seconds} s`;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="builder-replay-fact">
      <dt>{label}</dt>
      <dd className={mono ? 'is-mono' : undefined}>{value}</dd>
    </div>
  );
}

export function ReplayEvidenceDrawer({
  nodeId,
  nodeLabel,
  nodeType,
  rootTraceId,
  step,
  onClose,
}: ReplayEvidenceDrawerProps) {
  const [copied, setCopied] = useState(false);
  const status = step?.status ?? 'not-run';
  const isAgent = nodeType === 'argus.agent' || step?.type === 'argus.agent';

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const copyOutput = async () => {
    if (!step?.result) return;
    try {
      await navigator.clipboard.writeText(step.result);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <aside className="builder-replay-evidence" data-status={status} aria-label={`Run evidence · ${nodeLabel}`}>
      <header>
        <div>
          <span>RUN EVIDENCE · STEP</span>
          <h2>{nodeLabel}</h2>
          <p>{nodeId}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Evidence schließen" title="Evidence schließen">
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="builder-replay-evidence-body">
        <div className="builder-replay-status-row">
          <strong>{status.replace('-', ' ')}</strong>
          {step?.telemetryStatus && step.telemetryStatus !== step.status && (
            <span>Telemetry · {step.telemetryStatus}</span>
          )}
        </div>

        <section>
          <h3><Clock3 className="w-3.5 h-3.5" /> Execution</h3>
          <dl className="builder-replay-facts">
            <Fact label="Block type" value={step?.type ?? nodeType} mono />
            <Fact label="Duration" value={formatDuration(step?.durationMs ?? null)} />
            {step?.agentRole && <Fact label="Agent role" value={step.agentRole} mono />}
            {step?.agentName && <Fact label="Effective agent" value={step.agentName} mono />}
            {step?.model && <Fact label="Model" value={step.model} mono />}
            {step?.runtimeProfile && <Fact label="Runtime profile" value={step.runtimeProfile} />}
            {step?.runtimeType && <Fact label="Runtime" value={step.runtimeType} mono />}
            {step?.provider && <Fact label="Provider" value={step.provider} mono />}
            {step?.reasoningEffort && <Fact label="Reasoning" value={step.reasoningEffort} mono />}
          </dl>
        </section>

        {step?.selectedTarget && (
          <section className="builder-replay-decision">
            <h3><Route className="w-3.5 h-3.5" /> Router decision</h3>
            <div>
              <span>{step.result || 'Selected route'}</span>
              <GitBranch className="w-3.5 h-3.5" />
              <strong>{step.selectedTarget}</strong>
            </div>
          </section>
        )}

        {step?.result ? (
          <section className="builder-replay-output">
            <div className="builder-replay-section-heading">
              <h3>{isAgent && <Bot className="w-3.5 h-3.5" />} {isAgent ? 'Agent output' : 'Step output'}</h3>
              <button type="button" onClick={() => void copyOutput()} aria-label="Output kopieren">
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Kopiert' : 'Kopieren'}
              </button>
            </div>
            <pre>{step.result}</pre>
          </section>
        ) : (
          <section className="builder-replay-empty-evidence">
            <strong>{status === 'not-run' ? 'Dieser Block wurde nicht ausgeführt.' : 'Kein Output gespeichert.'}</strong>
            <p>{status === 'not-run' ? 'Der ausgewählte Kontrollpfad hat diesen Block nicht erreicht.' : 'Status und Laufzeit bleiben trotzdem als Evidence erhalten.'}</p>
          </section>
        )}

        <section>
          <h3><ExternalLink className="w-3.5 h-3.5" /> Correlation</h3>
          <div className="builder-replay-links">
            {step?.traceId && (
              <a href={`/runs/agent/${encodeURIComponent(step.traceId)}`} target="_top">
                Agent trace <ExternalLink className="w-3 h-3" />
              </a>
            )}
            <a href={`/runs/workflow/${encodeURIComponent(rootTraceId)}`} target="_top">
              Workflow trace <ExternalLink className="w-3 h-3" />
            </a>
            <a href={`/observe/logs?root_trace=${encodeURIComponent(rootTraceId)}${step?.traceId ? `&trace=${encodeURIComponent(step.traceId)}` : ''}`} target="_top">
              Correlated logs <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          {(step?.sessionId || step?.runtimeRunId) && (
            <dl className="builder-replay-facts is-correlation">
              {step.sessionId && <Fact label="Session" value={step.sessionId} mono />}
              {step.runtimeRunId && <Fact label="Runtime run" value={step.runtimeRunId} mono />}
            </dl>
          )}
        </section>
      </div>
    </aside>
  );
}
