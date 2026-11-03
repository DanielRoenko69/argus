import { useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import type { WorkflowAgentPreflight } from '@/api/workflows';
import { Button } from '@/ui/button';

export type AgentPreflightTone = 'ready' | 'degraded' | 'blocked' | 'stale' | 'checking';

export interface AgentPreflightSummary {
  tone: AgentPreflightTone;
  label: string;
  detail: string;
}

export function summarizeAgentPreflight(
  preflight: WorkflowAgentPreflight | null | undefined,
  options: { dirty?: boolean; loading?: boolean; error?: boolean } = {},
): AgentPreflightSummary {
  if (options.dirty) return { tone: 'stale', label: 'Agents geändert', detail: 'Speichern und erneut prüfen' };
  if (options.loading) return { tone: 'checking', label: 'Agents werden geprüft', detail: 'Runtime und Capabilities werden verifiziert' };
  if (options.error) return { tone: 'blocked', label: 'Prüfung fehlgeschlagen', detail: 'Preflight konnte nicht geladen werden' };
  if (!preflight) return { tone: 'stale', label: 'Agents nicht geprüft', detail: 'Preflight vor dem Start ausführen' };
  if (!preflight.ready) {
    return {
      tone: 'blocked',
      label: 'Agents blockiert',
      detail: `${preflight.blockers.length || 1} Blocker`,
    };
  }
  const degraded = preflight.warnings.length > 0
    || preflight.assignments.some((assignment) => assignment.status === 'degraded');
  if (degraded) {
    return {
      tone: 'degraded',
      label: 'Agents eingeschränkt',
      detail: `${preflight.assignments.length} Rollen · ${preflight.warnings.length} Warnungen`,
    };
  }
  return {
    tone: 'ready',
    label: 'Agents bereit',
    detail: `${preflight.assignments.length} Rollen verifiziert`,
  };
}

interface Props {
  visible: boolean;
  dirty: boolean;
  loading: boolean;
  refreshing: boolean;
  error: boolean;
  preflight?: WorkflowAgentPreflight | null;
  onRefresh: () => void;
  onOpenContract: () => void;
}

export function AgentPreflightBadge({
  visible,
  dirty,
  loading,
  refreshing,
  error,
  preflight,
  onRefresh,
  onOpenContract,
}: Props) {
  const [open, setOpen] = useState(false);
  if (!visible) return null;
  const summary = summarizeAgentPreflight(preflight, { dirty, loading, error });
  const SummaryIcon = summary.tone === 'ready'
    ? CheckCircle2
    : summary.tone === 'checking'
      ? Loader2
      : AlertTriangle;

  return (
    <div className="builder-agent-preflight-control">
      <button
        type="button"
        className={`builder-agent-preflight-trigger is-${summary.tone}`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`Agent Preflight: ${summary.label}`}
        title={summary.detail}
      >
        <SummaryIcon className={`w-3.5 h-3.5 ${summary.tone === 'checking' ? 'animate-spin' : ''}`} />
        <span>{summary.label}</span>
      </button>

      {open && (
        <section className="builder-agent-preflight-popover" role="dialog" aria-label="Agent Preflight Details">
          <header>
            <div className={`builder-agent-preflight-icon is-${summary.tone}`}><Bot className="w-4 h-4" /></div>
            <div><small>EXECUTION READINESS</small><strong>{summary.label}</strong><span>{summary.detail}</span></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Agent Preflight schließen"><X className="w-3.5 h-3.5" /></button>
          </header>

          <div className="builder-agent-preflight-body">
            {dirty && <PreflightNotice tone="stale" messages={['Der Canvas enthält ungespeicherte Änderungen. Vor dem Start wird gespeichert und erneut geprüft.']} />}
            {error && <PreflightNotice tone="blocked" messages={['Argus konnte den gespeicherten Agent Contract nicht prüfen.']} />}
            {preflight?.assignments.map((assignment) => (
              <article key={assignment.role} className={`builder-agent-preflight-assignment is-${assignment.status}`}>
                <span className="builder-agent-preflight-dot" />
                <div>
                  <small>{assignment.role}</small>
                  <strong>{assignment.agentLabel ?? assignment.agentName ?? 'Nicht aufgelöst'}</strong>
                  <span>{assignment.model ?? 'Kein Modell'} · {assignment.runtime?.profileLabel ?? assignment.runtime?.type ?? 'Keine Runtime'}</span>
                </div>
                <em>{assignment.status === 'ready' ? 'Ready' : assignment.status === 'degraded' ? 'Degraded' : 'Blocked'}</em>
                {(assignment.blockers.length > 0 || assignment.warnings.length > 0) && (
                  <ul>{[...assignment.blockers, ...assignment.warnings].map((message) => <li key={message}>{message}</li>)}</ul>
                )}
              </article>
            ))}
            {preflight && preflight.assignments.length === 0 && preflight.ready && (
              <PreflightNotice tone="ready" messages={['Dieser Workflow enthält keine Agent-Abhängigkeit.']} />
            )}
            {preflight && (preflight.blockers.length > 0 || preflight.warnings.length > 0) && (
              <PreflightNotice
                tone={preflight.blockers.length > 0 ? 'blocked' : 'degraded'}
                messages={[...preflight.blockers, ...preflight.warnings]}
              />
            )}
          </div>

          <footer>
            <Button variant="ghost" size="sm" disabled={refreshing || dirty} onClick={onRefresh}>
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Erneut prüfen
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setOpen(false); onOpenContract(); }}>
              <Bot className="w-3.5 h-3.5" /> Contract öffnen
            </Button>
          </footer>
        </section>
      )}
    </div>
  );
}

function PreflightNotice({ tone, messages }: { tone: 'ready' | 'degraded' | 'blocked' | 'stale'; messages: string[] }) {
  return (
    <div className={`builder-agent-preflight-notice is-${tone}`}>
      {tone === 'ready' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
      <ul>{messages.map((message) => <li key={message}>{message}</li>)}</ul>
    </div>
  );
}
