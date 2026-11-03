// Shared shell for every Argus node — provides the Handle ports,
// header with icon/label, exec-status badge, and a slot for child content.
//
// Visual pattern inspired by sim/apps/sim/app/w/[workspaceId]/...
// node card layout (Apache 2.0).

import { type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { cn } from '@/lib/utils';
import { Check, Loader2, Minus, X } from 'lucide-react';
import { getIcon } from '@/lib/iconRegistry';
import { useExecutionStore, type StepExecStatus } from '@/stores/executionStore';
import { useBuilderStore } from '@/stores/builderStore';
import { useStepBundles } from '@/api/k8s';
import { useParams } from 'react-router-dom';
import { BrandMark } from '@/components/BrandMark';

export interface BaseNodeProps {
  icon: string;
  brand?: string | null;
  brandLabel?: string;
  label: string;
  category: 'triggers' | 'logic' | 'argus';
  selected: NodeProps['selected'];
  /** React Flow node id — used to look up live execution status. */
  nodeId: string;
  configurationState?: 'ready' | 'checking' | 'unconfigured' | 'blocked';
  children?: ReactNode;
  hasInput?: boolean;
  hasOutput?: boolean;
}

const CATEGORY_LABELS: Record<BaseNodeProps['category'], string> = {
  triggers: 'AUSLÖSER',
  logic: 'LOGIK',
  argus: 'ARGUS',
};

const EXEC_LABELS: Record<StepExecStatus, string> = {
  pending: 'Bereit',
  running: 'Läuft',
  waiting: 'Wartet',
  completed: 'Fertig',
  failed: 'Fehler',
  skipped: 'Übersprungen',
};

export function BaseNode({
  icon,
  brand,
  brandLabel,
  label,
  category,
  selected,
  nodeId,
  configurationState,
  children,
  hasInput = true,
  hasOutput = true,
}: BaseNodeProps) {
  const Icon = getIcon(icon);
  const exec = useExecutionStore((s) => s.stepStates[nodeId]);
  const execStatus = exec?.status ?? 'pending';
  const customLabel = useBuilderStore((s) => {
    const value = s.nodes.find((node) => node.id === nodeId)?.data?.label;
    return typeof value === 'string' ? value.trim() : '';
  });
  const displayLabel = customLabel || label;
  const shortId = nodeId.includes('.') ? nodeId.slice(nodeId.lastIndexOf('.') + 1) : nodeId;

  return (
    <article
      className={cn('builder-node', selected && 'is-selected')}
      data-category={category}
      data-status={execStatus}
      data-configuration={configurationState}
      aria-label={`${label}: ${displayLabel}`}
    >
      <span className="builder-node-accent" aria-hidden="true" />
      {hasInput && (
        <>
          <Handle type="target" position={Position.Left} id="in" className="builder-node-handle builder-node-handle-input" />
          <span className="builder-node-port-label is-input" aria-hidden="true">IN</span>
        </>
      )}
      <header className="builder-node-header">
        <div className="builder-node-icon">
          {brand
            ? <BrandMark brand={brand} label={brandLabel ?? displayLabel} fallbackIcon={icon} />
            : <Icon className="w-[17px] h-[17px]" />}
        </div>
        <div className="builder-node-title">
          <span>{CATEGORY_LABELS[category]} · {label}</span>
          <strong title={displayLabel}>{displayLabel}</strong>
        </div>
        <ExecStatusBadge status={execStatus} />
      </header>
      {children && <div className="builder-node-content">{children}</div>}
      <BundleBadges nodeId={nodeId} />
      <footer className="builder-node-footer">
        <span title={nodeId}>ID · {shortId}</span>
        {exec?.durationMs != null && <strong>{formatDuration(exec.durationMs)}</strong>}
      </footer>
      {hasOutput && (
        <>
          <Handle type="source" position={Position.Right} id="out" className="builder-node-handle builder-node-handle-output" />
          <span className="builder-node-port-label is-output" aria-hidden="true">OUT</span>
        </>
      )}
    </article>
  );
}

function BundleBadges({ nodeId }: { nodeId: string }) {
  const { id } = useParams<{ id?: string }>();
  const wfId = id ? Number(id) : null;
  const { data } = useStepBundles(wfId);
  const bundles = data?.stepBundles?.[nodeId];
  if (!bundles || bundles.length === 0) return null;
  return (
    <div className="builder-node-bundles" aria-label={`${bundles.length} Backend-Bundle${bundles.length === 1 ? '' : 's'}`}>
      {bundles.slice(0, 3).map((b) => (
        <span
          key={b}
          title={`Bundle: ${b}`}
        >
          {b}
        </span>
      ))}
      {bundles.length > 3 && <span>+{bundles.length - 3}</span>}
    </div>
  );
}

function ExecStatusBadge({ status }: { status: StepExecStatus }) {
  if (status === 'pending') return null;
  const StatusIcon = status === 'running'
    ? Loader2
    : status === 'completed'
      ? Check
      : status === 'failed'
        ? X
        : Minus;
  return (
    <span className="builder-node-status" data-status={status}>
      <StatusIcon className={cn('w-3 h-3', status === 'running' && 'animate-spin')} />
      {EXEC_LABELS[status]}
    </span>
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}
