import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, LoaderCircle, Radio, XCircle } from 'lucide-react';
import type { HealthState, RunStatus } from '../types';

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const icon = status === 'completed'
    ? <CheckCircle2 size={13} />
    : status === 'failed'
      ? <XCircle size={13} />
      : status === 'running'
        ? <LoaderCircle size={13} className="spin" />
        : status === 'waiting'
          ? <AlertTriangle size={13} />
          : <Radio size={13} />;
  return <span className={`status-badge status-${status}`}>{icon}{status}</span>;
}

export function HealthBadge({ state }: { state: HealthState }) {
  return <span className={`health-badge health-${state}`}><i />{state.replace('_', ' ')}</span>;
}

export function LoadingState({ label = 'Loading Argus data…' }: { label?: string }) {
  return (
    <div className="state-panel" role="status">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return (
    <div className="state-panel state-error" role="alert">
      <AlertTriangle size={22} />
      <div><b>Unable to load this view</b><span>{error.message}</span></div>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <span className="empty-orbit"><i /></span>
      <b>{title}</b>
      <p>{description}</p>
    </div>
  );
}

export function timeAgo(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatDuration(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
