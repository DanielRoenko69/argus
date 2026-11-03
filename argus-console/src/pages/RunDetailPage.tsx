import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  ExternalLink,
  GitBranch,
  GitCompare,
  MessageSquare,
  Minus,
  Network,
  PauseCircle,
  Play,
  RotateCcw,
  Rows3,
  Search,
  Send,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  XCircle,
  Zap,
} from 'lucide-react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { TraceToEvaluationButton } from '../components/TraceToEvaluationButton';
import { cancelCodexRuntimeRun, getCodexRuntimeStatus, getCodingThread, getRunDetail, getSpanEvidence, getTraceFeedback, submitTraceFeedback } from '../api';
import {
  ErrorState,
  formatDuration,
  LoadingState,
  PageHeader,
  StatusBadge,
  timeAgo,
} from '../components/Ui';
import type { CodingThreadSummary, DistributedTraceFamily, DistributedTraceSpan, RunCodeEvidenceCitation, RunCodeIntelligenceEvidence, RunDetailStep, RunTimelineEvent, RunTimelineEventKind, SolutionPackCiRun, TraceFeedback, TraceFeedbackSentiment, WorkflowAgentContractEvidence } from '../types';

function eventIcon(kind: RunTimelineEventKind) {
  if (kind === 'run_started') return <Play size={15} />;
  if (kind === 'run_resumed') return <RotateCcw size={15} />;
  if (kind === 'approval_requested') return <PauseCircle size={15} />;
  if (kind === 'approval_approved') return <ShieldCheck size={15} />;
  if (kind === 'approval_rejected') return <XCircle size={15} />;
  if (kind === 'step_failed' || kind === 'tool_failed' || kind === 'run_failed') return <XCircle size={15} />;
  if (kind === 'step_skipped') return <SkipForward size={15} />;
  if (kind === 'step_waiting') return <Clock3 size={15} />;
  if (kind === 'tool_started') return <Terminal size={15} />;
  if (kind.startsWith('llm_')) return <Bot size={15} />;
  if (kind.startsWith('rag_')) return <Search size={15} />;
  if (kind === 'run_cancelled') return <AlertTriangle size={15} />;
  return <CheckCircle2 size={15} />;
}

function eventTone(kind: RunTimelineEventKind): string {
  if (kind.includes('failed') || kind === 'approval_rejected') return 'danger';
  if (kind === 'approval_requested' || kind === 'step_waiting') return 'warning';
  if (kind === 'run_resumed' || kind === 'approval_approved') return 'violet';
  if (kind.includes('completed')) return 'success';
  return 'neutral';
}

function dateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

function signedPercent(value: number | null): string {
  if (value == null) return 'new';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function signedCost(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}$${Math.abs(value).toFixed(6)}`;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function humanChangeRequestStatus(thread: CodingThreadSummary): { label: string; tone: 'warning' | 'success' | 'violet' } {
  const values = thread.values ?? {};
  if (values['human_approved'] === true) return { label: 'Approved', tone: 'success' };
  if (thread.status === 'completed') return { label: 'Completed', tone: 'success' };
  if (thread.status === 'interrupted' && thread.next?.includes('human_approval')) {
    return { label: 'Awaiting approval', tone: 'warning' };
  }
  if (typeof values['review'] === 'string' && values['review'].trim()) {
    return { label: 'Reviewed', tone: 'violet' };
  }
  return { label: 'In progress', tone: 'warning' };
}

function codingCiRun(thread: CodingThreadSummary | undefined): SolutionPackCiRun | null {
  const value = thread?.values?.['ci_run'];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SolutionPackCiRun
    : null;
}

function ciProviderLabel(provider: string): string {
  const label = ({ gitea: 'Gitea', github: 'GitHub', gitlab: 'GitLab', jenkins: 'Jenkins', bitbucket: 'Bitbucket' } as Record<string, string>)[provider] ?? provider;
  return label || 'CI provider';
}

function externalHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function codeCitationLabel(citation: RunCodeEvidenceCitation): string {
  if (citation.startLine == null) return citation.filePath;
  const end = citation.endLine != null && citation.endLine !== citation.startLine
    ? `-${citation.endLine}`
    : '';
  return `${citation.filePath}#L${citation.startLine}${end}`;
}

function codeEvidenceHref(family: DistributedTraceFamily, traceId: string, spanId: string): string {
  const run = family.runs.find(candidate => candidate.id === traceId);
  const kind = run?.kind ?? (traceId === family.rootTraceId ? 'workflow' : 'agent');
  return `/runs/${kind}/${encodeURIComponent(traceId)}?span=${encodeURIComponent(spanId)}`;
}

function codeAgentLabel(retrieval: RunCodeIntelligenceEvidence['retrievals'][number]): string {
  const raw = retrieval.agentName || retrieval.taskType || (retrieval.agentId == null ? 'Agent' : `Agent ${retrieval.agentId}`);
  const label = raw.replaceAll('_', ' ').replaceAll('-', ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function codeTaskLabel(taskType: string | null): string {
  if (!taskType) return 'repository context';
  return taskType.replaceAll('_', ' ').replaceAll('-', ' ');
}

interface VisualRoutingDecision {
  stepId: string;
  label: string;
  routeValue: string;
  selectedTarget: string;
  selectedLabel: string;
  skippedLabels: string[];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function visualWorkflowTraceEvidence(thread?: CodingThreadSummary): {
  steps: RunDetailStep[];
  decisions: VisualRoutingDecision[];
} {
  const values = thread?.values;
  const rawResults = objectRecord(values?.['step_results']);
  if (!rawResults) return { steps: [], decisions: [] };

  const allowedStatuses = new Set<RunDetailStep['status']>([
    'pending', 'running', 'waiting', 'completed', 'failed', 'skipped',
  ]);
  const rawByStep = new Map<string, Record<string, unknown>>();
  const steps: RunDetailStep[] = [];
  for (const [id, value] of Object.entries(rawResults)) {
    const raw = objectRecord(value);
    if (!raw) continue;
    const statusValue = typeof raw['status'] === 'string' ? raw['status'] : 'pending';
    const status = allowedStatuses.has(statusValue as RunDetailStep['status'])
      ? statusValue as RunDetailStep['status']
      : 'pending';
    const result = typeof raw['result'] === 'string' ? raw['result'] : '';
    rawByStep.set(id, raw);
    steps.push({
      id,
      label: typeof raw['label'] === 'string' && raw['label'].trim() ? raw['label'] : id,
      type: typeof raw['type'] === 'string' && raw['type'].trim() ? raw['type'] : 'workflow.step',
      toolName: null,
      status,
      durationMs: typeof raw['durationMs'] === 'number' && Number.isFinite(raw['durationMs'])
        ? raw['durationMs']
        : null,
      resultPreview: result ? result.slice(0, 2_000) : null,
    });
  }

  const logTargets = new Map<string, string>();
  if (Array.isArray(values?.['log'])) {
    for (const entry of values.log) {
      const raw = objectRecord(entry);
      const stepId = typeof raw?.['step'] === 'string' ? raw['step'] : '';
      const summary = typeof raw?.['summary'] === 'string' ? raw['summary'] : '';
      const selected = summary.match(/selected '([^']+)'/)?.[1];
      if (stepId && selected) logTargets.set(stepId, selected);
    }
  }

  const stepsById = new Map(steps.map(step => [step.id, step]));
  const skipped = steps.filter(step => step.status === 'skipped');
  const decisions = steps.flatMap<VisualRoutingDecision>(step => {
    if (!['logic.router', 'logic.condition'].includes(step.type) || step.status !== 'completed') return [];
    const raw = rawByStep.get(step.id)!;
    let selectedTarget = typeof raw['selectedTarget'] === 'string' ? raw['selectedTarget'] : '';
    if (!selectedTarget) selectedTarget = logTargets.get(step.id) ?? '';
    if (!selectedTarget) {
      for (const candidate of skipped) {
        const inferred = candidate.resultPreview?.match(/selected '([^']+)'/)?.[1];
        if (inferred) {
          selectedTarget = inferred;
          break;
        }
      }
    }
    const relatedSkipped = skipped.filter(candidate =>
      candidate.resultPreview?.includes(`selected '${selectedTarget}'`),
    );
    return [{
      stepId: step.id,
      label: step.label,
      routeValue: step.resultPreview ?? 'unknown',
      selectedTarget: selectedTarget || 'unknown',
      selectedLabel: stepsById.get(selectedTarget)?.label ?? (selectedTarget || 'Unknown target'),
      skippedLabels: relatedSkipped.map(candidate => candidate.label),
    }];
  });
  return { steps, decisions };
}

function RoutingDecisionEvidence({ decisions }: { decisions: VisualRoutingDecision[] }) {
  if (decisions.length === 0) return null;
  return (
    <div className="run-routing-evidence" aria-label="Workflow routing decisions">
      {decisions.map(decision => (
        <article key={decision.stepId}>
          <span className="run-routing-icon"><GitBranch size={15} /></span>
          <div>
            <small>ROUTING DECISION</small>
            <b>{decision.label} · {decision.routeValue}</b>
            <p>Selected <code>{decision.selectedLabel}</code></p>
          </div>
          <div className="run-routing-branches">
            <span className="is-selected"><CheckCircle2 size={12} />{decision.selectedLabel}</span>
            {decision.skippedLabels.map(label => <span className="is-skipped" key={label}><SkipForward size={12} />{label}</span>)}
          </div>
        </article>
      ))}
    </div>
  );
}

function TimelineEvent({ event, selected, onSelect }: { event: RunTimelineEvent; selected: boolean; onSelect: (event: RunTimelineEvent) => void }) {
  return (
    <article
      className={`run-event event-${eventTone(event.kind)}${selected ? ' is-selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(event)}
      onKeyDown={keyboardEvent => { if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') onSelect(event); }}
    >
      <span className="run-event-icon">{eventIcon(event.kind)}</span>
      <div className="run-event-body">
        <div className="run-event-heading">
          <div>
            <b>{event.title}</b>
            <span>{event.detail}</span>
          </div>
          <time title={dateTime(event.timestamp)}>{timeAgo(event.timestamp)}</time>
        </div>
        <div className="run-event-meta">
          {event.stepId && <span>Step {event.stepId}</span>}
          {event.approvalId && <span>Approval #{event.approvalId}</span>}
          {event.durationMs != null && <span>{formatDuration(event.durationMs)}</span>}
          {event.actor && <span>{event.actor}</span>}
        </div>
        {event.riskLevel && event.riskScore != null && (
          <div className={`timeline-risk risk-${event.riskLevel}`}>
            <span>{event.riskLevel} risk · {event.riskScore}/100</span>
            <div>
              {(event.riskFactors ?? []).map(factor => (
                <em key={factor.id}>+{factor.weight} {factor.label}</em>
              ))}
            </div>
          </div>
        )}
        {event.comment && <blockquote>{event.comment}</blockquote>}
        {event.resultPreview && (
          <details className="run-event-output">
            <summary>Inspect output</summary>
            <pre>{event.resultPreview}</pre>
          </details>
        )}
      </div>
    </article>
  );
}

const terminalKinds: RunTimelineEventKind[] = ['run_started', 'run_completed', 'run_failed', 'run_cancelled'];

function spanLabel(event: RunTimelineEvent): string {
  if (event.kind.startsWith('approval_')) return 'Governance';
  if (event.kind.startsWith('tool_')) return 'Tool';
  if (event.kind.startsWith('llm_')) return 'LLM';
  if (event.kind.startsWith('rag_')) return 'RAG';
  if (event.kind.startsWith('step_')) return 'Step';
  return 'Lifecycle';
}

function Waterfall({
  events,
  startedAt,
  durationMs,
  selectedId,
  onSelect,
}: {
  events: RunTimelineEvent[];
  startedAt: string;
  durationMs: number;
  selectedId: string | null;
  onSelect: (event: RunTimelineEvent) => void;
}) {
  const startMs = Date.parse(startedAt);
  const safeDuration = Math.max(1, durationMs);
  const spans = events.filter(event => !terminalKinds.includes(event.kind));
  const marks = [0, .25, .5, .75, 1];

  return (
    <div className="trace-waterfall">
      <div className="trace-waterfall-ruler"><span>SPAN</span><div>{marks.map(mark => <i style={{ left: `${mark * 100}%` }} key={mark}><small>{formatDuration(safeDuration * mark)}</small></i>)}</div><em>DURATION</em></div>
      <div className="trace-waterfall-root"><div><b>Run</b><small>root execution</small></div><span><i /></span><time>{formatDuration(safeDuration)}</time></div>
      {spans.map(event => {
        const eventEnd = Date.parse(event.timestamp);
        const eventDuration = Math.max(0, event.durationMs ?? 0);
        const eventStart = eventDuration > 0 ? eventEnd - eventDuration : eventEnd;
        const left = Math.min(99, Math.max(0, ((eventStart - startMs) / safeDuration) * 100));
        const available = Math.max(1, 100 - left);
        const width = eventDuration > 0
          ? Math.min(available, Math.max(1.5, (eventDuration / safeDuration) * 100))
          : Math.min(available, 1.5);
        return (
          <button className={`trace-waterfall-row span-${eventTone(event.kind)}${selectedId === event.id ? ' is-selected' : ''}`} type="button" key={event.id} onClick={() => onSelect(event)}>
            <div><b>{event.toolName || event.title}</b><small>{spanLabel(event)} · {event.stepId || event.kind.replaceAll('_', ' ')}</small></div>
            <span className="trace-waterfall-track"><i style={{ left: `${left}%`, width: `${width}%` }} /></span>
            <time>{event.durationMs != null ? formatDuration(event.durationMs) : 'event'}</time>
          </button>
        );
      })}
      {spans.length === 0 && <div className="trace-waterfall-empty">This run has no child spans yet.</div>}
    </div>
  );
}

function prettyPreview(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}

function TraceInspector({ event, runId, traceId }: { event: RunTimelineEvent | null; runId: string; traceId?: string }) {
  if (!event) return <div className="trace-inspector-empty"><Search size={19} /><span>Select a span to inspect its evidence.</span></div>;
  const logHref = event.spanId
    ? `/observe/logs?span=${encodeURIComponent(event.spanId)}`
    : traceId
      ? `/observe/logs?trace=${encodeURIComponent(traceId)}`
      : `/observe/logs?q=${encodeURIComponent(event.toolName || runId)}`;
  return (
    <section className={`trace-inspector inspector-${eventTone(event.kind)}`}>
      <header>
        <span>{eventIcon(event.kind)}</span>
        <div><small>{spanLabel(event)} · {event.kind.replaceAll('_', ' ')}</small><h3>{event.title}</h3></div>
        {event.durationMs != null && <strong>{formatDuration(event.durationMs)}</strong>}
      </header>
      <dl>
        <div><dt>Timestamp</dt><dd>{dateTime(event.timestamp)}</dd></div>
        {event.toolName && <div><dt>Tool</dt><dd>{event.toolName}</dd></div>}
        {event.stepId && <div><dt>Step</dt><dd>{event.stepId}</dd></div>}
        {event.actor && <div><dt>Actor</dt><dd>{event.actor}</dd></div>}
      </dl>
      <div className="trace-inspector-copy">
        {event.inputPreview && <section><span><Braces size={13} />Input</span><pre>{prettyPreview(event.inputPreview)}</pre></section>}
        {event.resultPreview && <section><span><Rows3 size={13} />Output</span><pre>{prettyPreview(event.resultPreview)}</pre></section>}
        {!event.inputPreview && !event.resultPreview && <p>{event.detail}</p>}
      </div>
      {event.riskLevel && <div className={`trace-inspector-risk risk-${event.riskLevel}`}><ShieldCheck size={14} /><span>{event.riskLevel} risk · {event.riskScore ?? 0}/100</span></div>}
      <footer><a href={logHref}><Search size={13} />Find correlated logs</a></footer>
    </section>
  );
}

interface DistributedTraceEntity {
  key: string;
  id: string;
  parentKey: string | null;
  nodeType: 'run' | 'span' | 'approval';
  kind: string;
  title: string;
  subtitle: string;
  status: DistributedTraceSpan['status'];
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  href?: string;
  current: boolean;
  error?: string | null;
  approval?: TraceFeedback;
}

function distributedTraceIcon(entity: DistributedTraceEntity) {
  if (entity.nodeType === 'approval') return <ShieldCheck size={13} />;
  if (entity.nodeType === 'run') return entity.kind === 'agent' ? <Bot size={13} /> : <GitBranch size={13} />;
  if (entity.kind === 'llm') return <Bot size={13} />;
  if (entity.kind === 'tool') return <Terminal size={13} />;
  if (entity.kind === 'rag') return <Search size={13} />;
  if (entity.kind === 'approval') return <ShieldCheck size={13} />;
  if (entity.kind === 'workflow') return <GitBranch size={13} />;
  return <Zap size={13} />;
}

function DistributedTraceView({
  family,
  initialSpanId,
  mode,
}: {
  family: DistributedTraceFamily;
  initialSpanId?: string | null;
  mode: 'tree' | 'waterfall';
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(() => initialSpanId ?? null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedFeedbackId, setSelectedFeedbackId] = useState<number | null>(null);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(() => (family.comparison?.summary.regressionCount ?? 0) > 0);
  const spanEvidence = useQuery({
    queryKey: ['span-evidence', selectedSpanId],
    queryFn: () => getSpanEvidence(selectedSpanId!),
    enabled: selectedSpanId != null,
    staleTime: 30_000,
  });
  const traceFeedback = useQuery({
    queryKey: ['trace-feedback', family.rootTraceId],
    queryFn: () => getTraceFeedback(family.rootTraceId),
    staleTime: 30_000,
  });
  const runKeys = new Set(family.runs.map(run => `run:${run.id}`));
  const spanKeys = new Set((family.spans ?? []).map(span => `span:${span.id}`));
  const criticalKeys = new Set(family.analysis?.criticalPath ?? []);
  const bottleneckKey = family.analysis?.bottleneck?.key ?? null;
  const approvalSignals = (traceFeedback.data?.feedback ?? []).filter(item => (
    item.label.toLowerCase().includes('approval')
    || item.tags.some(tag => tag.toLowerCase() === 'human-approval')
  ));
  const rootRunKey = runKeys.has(`run:${family.rootTraceId}`)
    ? `run:${family.rootTraceId}`
    : family.runs[0]
      ? `run:${family.runs[0].id}`
      : null;
  const allEntities: DistributedTraceEntity[] = [
    ...family.runs.map(run => ({
      key: `run:${run.id}`,
      id: run.id,
      parentKey: run.parentSpanId && spanKeys.has(`span:${run.parentSpanId}`)
        ? `span:${run.parentSpanId}`
        : run.parentTraceId && runKeys.has(`run:${run.parentTraceId}`)
          ? `run:${run.parentTraceId}`
          : null,
      nodeType: 'run' as const,
      kind: run.kind,
      title: run.title,
      subtitle: run.subtitle,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.durationMs,
      href: run.href,
      current: run.id === family.currentTraceId,
      error: null,
    })),
    ...(family.spans ?? []).map(span => ({
      key: `span:${span.id}`,
      id: span.id,
      parentKey: span.parentSpanId && spanKeys.has(`span:${span.parentSpanId}`)
        ? `span:${span.parentSpanId}`
        : runKeys.has(`run:${span.traceId}`)
          ? `run:${span.traceId}`
          : null,
      nodeType: 'span' as const,
      kind: span.kind,
      title: span.name,
      subtitle: [span.kind.toUpperCase(), span.provider, span.model].filter(Boolean).join(' · '),
      status: span.status,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      durationMs: span.durationMs,
      current: false,
      error: span.error,
    })),
    ...approvalSignals.map(item => {
      const rejected = item.sentiment === 'negative' || (item.score != null && item.score < .5);
      return {
        key: `approval:${item.id}`,
        id: String(item.id),
        parentKey: item.spanId && spanKeys.has(`span:${item.spanId}`) ? `span:${item.spanId}` : rootRunKey,
        nodeType: 'approval' as const,
        kind: 'approval',
        title: item.label.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()),
        subtitle: [rejected ? 'Rejected' : 'Approved', item.createdByName || item.source].join(' · '),
        status: rejected ? 'failed' as const : 'completed' as const,
        startedAt: item.createdAt,
        endedAt: item.createdAt,
        durationMs: 0,
        current: false,
        error: rejected ? item.comment : null,
        approval: item,
      };
    }),
  ];
  const entities = criticalOnly && criticalKeys.size > 0
    ? allEntities.filter(entity => criticalKeys.has(entity.key) || entity.nodeType === 'approval')
    : allEntities;
  const byKey = new Map(entities.map(entity => [entity.key, entity]));
  const children = new Map<string, DistributedTraceEntity[]>();
  for (const entity of entities) {
    if (!entity.parentKey || !byKey.has(entity.parentKey)) continue;
    const siblings = children.get(entity.parentKey) ?? [];
    siblings.push(entity);
    children.set(entity.parentKey, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  }
  const roots = entities
    .filter(entity => !entity.parentKey || !byKey.has(entity.parentKey))
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const treeVisible: Array<{ entity: DistributedTraceEntity; depth: number }> = [];
  const visited = new Set<string>();
  const append = (entity: DistributedTraceEntity, depth: number) => {
    if (visited.has(entity.key)) return;
    visited.add(entity.key);
    treeVisible.push({ entity, depth });
    if (collapsed.has(entity.key)) {
      const markHidden = (parentId: string) => {
        for (const child of children.get(parentId) ?? []) {
          if (visited.has(child.key)) continue;
          visited.add(child.key);
          markHidden(child.key);
        }
      };
      markHidden(entity.key);
      return;
    }
    for (const child of children.get(entity.key) ?? []) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  for (const orphan of entities) append(orphan, 0);
  const visible = mode === 'waterfall'
    ? [...entities]
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
      .map(entity => ({ entity, depth: 0 }))
    : treeVisible;

  const starts = entities.map(entity => Date.parse(entity.startedAt)).filter(Number.isFinite);
  const rootStart = starts.length > 0 ? Math.min(...starts) : Date.now();
  const ends = entities.map(entity => {
    const started = Date.parse(entity.startedAt);
    if (entity.endedAt) return Date.parse(entity.endedAt);
    if (entity.durationMs != null) return started + entity.durationMs;
    return Date.now();
  }).filter(Number.isFinite);
  const totalDuration = Math.max(1, (ends.length > 0 ? Math.max(...ends) : rootStart) - rootStart);
  const agentCount = family.runs.filter(run => run.kind === 'agent').length;
  const llmCount = (family.spans ?? []).filter(span => span.kind === 'llm').length;
  const ragCount = (family.spans ?? []).filter(span => span.kind === 'rag').length;
  const toolCount = (family.spans ?? []).filter(span => span.kind === 'tool').length;
  const rootRun = family.runs.find(run => run.id === family.rootTraceId) ?? family.runs[0] ?? null;
  const runtimeLabel = rootRun && `${rootRun.title} ${rootRun.subtitle}`.toLowerCase().includes('langgraph')
    ? 'Argus LangGraph'
    : rootRun?.subtitle || 'Native runtime';
  const selectedRun = selectedRunId ? family.runs.find(run => run.id === selectedRunId) ?? null : null;
  const selectedApproval = selectedFeedbackId == null
    ? null
    : approvalSignals.find(item => item.id === selectedFeedbackId) ?? null;

  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const inspectEntity = (entity: DistributedTraceEntity) => {
    if (entity.nodeType === 'span') {
      setSelectedSpanId(entity.id);
      setSelectedRunId(null);
      setSelectedFeedbackId(null);
      return;
    }
    if (entity.nodeType === 'approval') {
      setSelectedSpanId(null);
      setSelectedRunId(null);
      setSelectedFeedbackId(Number(entity.id));
      return;
    }
    setSelectedSpanId(null);
    setSelectedRunId(entity.id);
    setSelectedFeedbackId(null);
  };

  return (
    <div className={`distributed-trace view-${mode}`}>
      <div className="distributed-trace-summary">
        <span><Network size={14} />{family.runs.length} correlated run{family.runs.length === 1 ? '' : 's'}</span>
        <em>{agentCount} agent{agentCount === 1 ? '' : 's'} · {(family.spans ?? []).length} span{(family.spans ?? []).length === 1 ? '' : 's'}</em>
        <small title={family.rootTraceId}>Root {family.rootTraceId.slice(0, 8)}…</small>
      </div>
      <section className="distributed-runtime-summary" aria-label="Runtime trace summary">
        <div><span><GitBranch size={14} /></span><p><small>WORKFLOW RUNTIME</small><b>{runtimeLabel}</b></p></div>
        <dl>
          <div><dt>Agents</dt><dd>{agentCount}</dd></div>
          <div><dt>LLM calls</dt><dd>{llmCount}</dd></div>
          <div><dt>RAG calls</dt><dd>{ragCount}</dd></div>
          <div><dt>Tools</dt><dd>{toolCount}</dd></div>
          <div className={approvalSignals.length > 0 ? 'has-approvals' : ''}><dt>Approval gates</dt><dd>{approvalSignals.length}</dd></div>
        </dl>
      </section>
      {family.analysis?.bottleneck && (
        <div className="distributed-trace-analysis">
          <span><Zap size={14} /></span>
          <div>
            <small>AUTOMATIC BOTTLENECK</small>
            <b>{family.analysis.bottleneck.label}</b>
            <em>{family.analysis.bottleneck.kind} · {formatDuration(family.analysis.bottleneck.selfTimeMs)} self time</em>
          </div>
          <dl>
            <div><dt>Trace share</dt><dd>{family.analysis.bottleneck.sharePercent.toFixed(1)}%</dd></div>
            <div><dt>Peak parallelism</dt><dd>{family.analysis.maxConcurrency}×</dd></div>
            <div><dt>Failed nodes</dt><dd>{family.analysis.failedNodes}</dd></div>
          </dl>
          <button type="button" className={criticalOnly ? 'is-active' : ''} onClick={() => setCriticalOnly(value => !value)}>
            <Network size={12} />{criticalOnly ? 'Show full trace' : 'Focus critical path'}
          </button>
        </div>
      )}
      <section className={`distributed-trace-baseline state-${family.historicalBaseline.durationState}`} aria-label="Historical performance baseline">
        <span><RotateCcw size={14} /></span>
        <div>
          <small>HISTORICAL BASELINE</small>
          <b>{family.historicalBaseline.selectedWindowDays ? `${family.historicalBaseline.selectedWindowDays}-day performance envelope` : 'Learning this workload'}</b>
          <em>{family.historicalBaseline.sampleCount} successful run{family.historicalBaseline.sampleCount === 1 ? '' : 's'} · {family.historicalBaseline.confidence} confidence</em>
        </div>
        {family.historicalBaseline.selected ? (
          <dl>
            <div className={`is-${family.historicalBaseline.durationState}`}><dt>Duration vs median</dt><dd>{signedPercent(family.historicalBaseline.durationDeltaPercent)}</dd><small>{formatDuration(family.historicalBaseline.currentDurationMs)} / {formatDuration(family.historicalBaseline.selected.medianDurationMs)}</small></div>
            <div><dt>Duration P95</dt><dd>{formatDuration(family.historicalBaseline.selected.p95DurationMs)}</dd><small>historical envelope</small></div>
            <div className={`is-${family.historicalBaseline.costState}`}><dt>Cost vs median</dt><dd>{signedPercent(family.historicalBaseline.costDeltaPercent)}</dd><small>${family.historicalBaseline.currentCostUsd.toFixed(6)} / ${family.historicalBaseline.selected.medianCostUsd.toFixed(6)}</small></div>
            <div><dt>Success rate</dt><dd>{family.historicalBaseline.selected.successRate.toFixed(1)}%</dd><small>{family.historicalBaseline.selected.terminalCount} terminal runs</small></div>
          </dl>
        ) : <p>Argus needs completed comparable runs before it can calculate a reliable performance envelope.</p>}
        <strong className={`baseline-confidence confidence-${family.historicalBaseline.confidence}`}>{family.historicalBaseline.confidence}</strong>
      </section>
      {family.comparison && (
        <section className={`distributed-trace-comparison${comparisonOpen ? ' is-open' : ''}`} aria-label="Run comparison">
          <header>
            <span><GitCompare size={14} /></span>
            <div>
              <small>RUN COMPARISON</small>
              <b>Previous successful baseline</b>
              {family.comparison.baseline.href
                ? <a href={family.comparison.baseline.href}>{timeAgo(family.comparison.baseline.startedAt)} <ExternalLink size={10} /></a>
                : <em>{timeAgo(family.comparison.baseline.startedAt)}</em>}
            </div>
            <dl>
              <div className={family.comparison.summary.durationDeltaMs > 0 ? 'is-regression' : family.comparison.summary.durationDeltaMs < 0 ? 'is-improvement' : ''}>
                <dt>Duration</dt><dd>{signedPercent(family.comparison.summary.durationDeltaPercent)}</dd>
              </div>
              <div className={family.comparison.summary.costDeltaUsd > 0 ? 'is-regression' : family.comparison.summary.costDeltaUsd < 0 ? 'is-improvement' : ''}>
                <dt>Cost</dt><dd>{signedCost(family.comparison.summary.costDeltaUsd)}</dd>
              </div>
              <div className={family.comparison.summary.failedNodeDelta > 0 ? 'is-regression' : family.comparison.summary.failedNodeDelta < 0 ? 'is-improvement' : ''}>
                <dt>Failures</dt><dd>{family.comparison.summary.failedNodeDelta > 0 ? '+' : ''}{family.comparison.summary.failedNodeDelta}</dd>
              </div>
              <div className={family.comparison.summary.regressionCount > 0 ? 'is-regression' : ''}>
                <dt>Regressions</dt><dd>{family.comparison.summary.regressionCount}</dd>
              </div>
            </dl>
            <button type="button" aria-expanded={comparisonOpen} onClick={() => setComparisonOpen(value => !value)}>
              {comparisonOpen ? 'Hide changes' : 'Inspect changes'}{comparisonOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </header>
          {comparisonOpen && (
            <div className="distributed-trace-changes">
              {family.comparison.changes.length === 0 && <p>No material node-level change from this baseline.</p>}
              {family.comparison.changes.map(change => {
                const durationTone = change.change === 'regression' || change.change === 'status_regression' || change.change === 'new'
                  ? 'is-regression'
                  : 'is-improvement';
                return (
                  <article className={`trace-change change-${change.change}`} key={change.signature}>
                    <span>{change.change === 'improvement' || change.change === 'removed' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}</span>
                    <div><b>{change.label}</b><small>{change.kind} · {change.change.replace('_', ' ')}</small></div>
                    <dl>
                      <div><dt>Baseline</dt><dd>{change.baselineDurationMs == null ? '—' : formatDuration(change.baselineDurationMs)}</dd></div>
                      <div><dt>Current</dt><dd>{change.currentDurationMs == null ? '—' : formatDuration(change.currentDurationMs)}</dd></div>
                      <div className={durationTone}><dt>Delta</dt><dd>{change.durationDeltaPercent == null ? change.change : signedPercent(change.durationDeltaPercent)}</dd></div>
                      <div className={(change.costDeltaUsd ?? 0) > 0 ? 'is-regression' : (change.costDeltaUsd ?? 0) < 0 ? 'is-improvement' : ''}>
                        <dt>Cost delta</dt><dd>{change.costDeltaUsd == null ? '—' : signedCost(change.costDeltaUsd)}</dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
      <div className="distributed-trace-ruler"><span>EXECUTION</span><i>RELATIVE TIME</i><em>STATUS</em></div>
      <div className="distributed-trace-rows">
        {visible.map(({ entity, depth }) => {
          const nested = children.get(entity.key) ?? [];
          const start = Date.parse(entity.startedAt);
          const left = Math.min(98, Math.max(0, ((start - rootStart) / totalDuration) * 100));
          const duration = Math.max(0, entity.durationMs ?? (entity.endedAt ? Date.parse(entity.endedAt) - start : Date.now() - start));
          const width = Math.min(100 - left, Math.max(1.5, (duration / totalDuration) * 100));
          return (
            <div className={`distributed-trace-row trace-${entity.status} kind-${entity.kind} node-${entity.nodeType}${entity.current ? ' is-current' : ''}${(entity.nodeType === 'span' && entity.id === selectedSpanId) || (entity.nodeType === 'run' && entity.id === selectedRunId) || (entity.nodeType === 'approval' && Number(entity.id) === selectedFeedbackId) ? ' is-inspected' : ''}${criticalKeys.has(entity.key) ? ' is-critical' : ''}${entity.key === bottleneckKey ? ' is-bottleneck' : ''}`} key={entity.key} title={entity.error ?? undefined}>
              <div className="distributed-trace-name" style={{ paddingLeft: `${8 + Math.min(depth, 8) * 20}px` }}>
                {mode === 'tree' && nested.length > 0
                  ? <button type="button" aria-label={`${collapsed.has(entity.key) ? 'Expand' : 'Collapse'} ${entity.title}`} onClick={() => toggle(entity.key)}>{collapsed.has(entity.key) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
                  : <span className="trace-tree-spacer" />}
                <span className="trace-tree-kind">{distributedTraceIcon(entity)}</span>
                {entity.href
                  ? <a href={entity.href} aria-current={entity.current ? 'page' : undefined}><b>{entity.title}{entity.key === bottleneckKey && <em className="trace-bottleneck-badge">Bottleneck</em>}</b><small>{entity.subtitle}</small></a>
                  : <button className="distributed-trace-label" type="button" aria-pressed={(entity.nodeType === 'span' && entity.id === selectedSpanId) || (entity.nodeType === 'run' && entity.id === selectedRunId) || (entity.nodeType === 'approval' && Number(entity.id) === selectedFeedbackId)} onClick={() => inspectEntity(entity)}><b>{entity.title}{entity.key === bottleneckKey && <em className="trace-bottleneck-badge">Bottleneck</em>}</b><small>{entity.error || entity.subtitle}</small></button>}
              </div>
              <div className="distributed-trace-track"><i style={{ left: `${left}%`, width: `${width}%` }} /><small style={{ left: `${Math.min(96, left)}%` }}>{formatDuration(entity.durationMs)}</small></div>
              <span className={`distributed-trace-status status-${entity.status}`}><i />{entity.status}</span>
            </div>
          );
        })}
      </div>
      {(family.truncated || family.spansTruncated) && <p className="distributed-trace-truncated">This trace is larger than the inspection limit. Showing up to 250 runs and 2,000 spans.</p>}
      {selectedRun && (
        <section className="distributed-entity-inspector" aria-label="Run evidence">
          <header>
            <span className={`trace-tree-kind kind-${selectedRun.kind}`}>{selectedRun.kind === 'agent' ? <Bot size={13} /> : <GitBranch size={13} />}</span>
            <div><small>RUN EVIDENCE · {selectedRun.kind}</small><h3>{selectedRun.title}</h3></div>
            <button type="button" aria-label="Close run inspector" onClick={() => setSelectedRunId(null)}><XCircle size={15} /></button>
          </header>
          <dl>
            <div><dt>Status</dt><dd className={`status-${selectedRun.status}`}>{selectedRun.status}</dd></div>
            <div><dt>Duration</dt><dd>{formatDuration(selectedRun.durationMs)}</dd></div>
            <div><dt>Started</dt><dd>{dateTime(selectedRun.startedAt)}</dd></div>
            <div><dt>Parent</dt><dd title={selectedRun.parentTraceId ?? undefined}>{selectedRun.parentTraceId ? `${selectedRun.parentTraceId.slice(0, 8)}…` : 'Trace root'}</dd></div>
          </dl>
          <p>{selectedRun.subtitle}</p>
          <footer>
            <span title={family.rootTraceId}>Trace {selectedRun.id.slice(0, 8)}…</span>
            <a href={`/observe/logs?trace=${encodeURIComponent(selectedRun.id)}`}><Search size={13} />Correlated logs</a>
          </footer>
        </section>
      )}
      {selectedApproval && (
        <section className="distributed-entity-inspector approval-inspector" aria-label="Approval evidence">
          <header>
            <span className="trace-tree-kind kind-approval"><ShieldCheck size={13} /></span>
            <div><small>GOVERNANCE EVIDENCE · APPROVAL</small><h3>{selectedApproval.label.replaceAll('_', ' ')}</h3></div>
            <button type="button" aria-label="Close approval inspector" onClick={() => setSelectedFeedbackId(null)}><XCircle size={15} /></button>
          </header>
          <dl>
            <div><dt>Decision</dt><dd>{selectedApproval.sentiment === 'negative' || (selectedApproval.score != null && selectedApproval.score < .5) ? 'Rejected' : 'Approved'}</dd></div>
            <div><dt>Score</dt><dd>{selectedApproval.score == null ? 'Not scored' : `${Math.round(selectedApproval.score * 100)}%`}</dd></div>
            <div><dt>Reviewer</dt><dd>{selectedApproval.createdByName || selectedApproval.source}</dd></div>
            <div><dt>Recorded</dt><dd>{dateTime(selectedApproval.createdAt)}</dd></div>
          </dl>
          {selectedApproval.comment && <blockquote>{selectedApproval.comment}</blockquote>}
          {selectedApproval.tags.length > 0 && <div className="approval-inspector-tags">{selectedApproval.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
          <footer>
            <span>Feedback #{selectedApproval.id}</span>
            <a href={`/observe/logs?root_trace=${encodeURIComponent(family.rootTraceId)}`}><Search size={13} />Correlated logs</a>
          </footer>
        </section>
      )}
      {selectedSpanId && (
        <section className="distributed-span-inspector" aria-label="Span evidence">
          {spanEvidence.isLoading && <div className="distributed-span-state"><Clock3 size={15} />Loading span evidence…</div>}
          {spanEvidence.error && <div className="distributed-span-state is-error"><AlertTriangle size={15} />{spanEvidence.error instanceof Error ? spanEvidence.error.message : 'Span evidence could not be loaded.'}</div>}
          {spanEvidence.data && (() => {
            const { span, trace } = spanEvidence.data;
            return (
              <>
                <header>
                  <span className={`trace-tree-kind kind-${span.kind}`}>{distributedTraceIcon({
                    key: `span:${span.id}`, id: span.id, parentKey: null, nodeType: 'span', kind: span.kind,
                    title: span.name, subtitle: span.kind, status: span.status, startedAt: span.startedAt,
                    endedAt: span.endedAt, durationMs: span.durationMs, current: false,
                  })}</span>
                  <div><small>SPAN EVIDENCE · {span.kind}</small><h3>{span.name}</h3></div>
                  <button type="button" aria-label="Close span inspector" onClick={() => setSelectedSpanId(null)}><XCircle size={15} /></button>
                </header>
                <div className="distributed-span-facts">
                  <div><span>Status</span><b className={`status-${span.status}`}>{span.status}</b></div>
                  <div><span>Duration</span><b>{formatDuration(span.durationMs)}</b></div>
                  <div><span>Tokens</span><b>{span.inputTokens + span.outputTokens}</b></div>
                  <div><span>Cost</span><b>${span.totalCostUsd.toFixed(6)}</b></div>
                  <div><span>Provider</span><b>{span.provider || '—'}</b></div>
                  <div><span>Model / tool</span><b>{span.model || span.toolName || '—'}</b></div>
                </div>
                {span.error && <div className="distributed-span-error"><AlertTriangle size={14} /><span>{span.error}</span></div>}
                <div className="distributed-span-previews">
                  <section><span><Braces size={13} />Input</span><pre>{span.inputPreview ? prettyPreview(span.inputPreview) : 'No input preview recorded.'}</pre></section>
                  <section><span><Rows3 size={13} />Output</span><pre>{span.outputPreview ? prettyPreview(span.outputPreview) : 'No output preview recorded.'}</pre></section>
                </div>
                {span.metadataPreview && <details className="distributed-span-metadata"><summary>Span metadata</summary><pre>{prettyPreview(span.metadataPreview)}</pre></details>}
                <footer>
                  <span title={trace.rootTraceId}>Trace {trace.id.slice(0, 8)}… · Span {span.id.slice(0, 8)}…</span>
                  <TraceToEvaluationButton traceId={trace.id} spanId={span.id} />
                  <a href={`/observe/logs?trace=${encodeURIComponent(trace.id)}&span=${encodeURIComponent(span.id)}`}><Search size={13} />Correlated logs</a>
                </footer>
              </>
            );
          })()}
        </section>
      )}
    </div>
  );
}

const feedbackTags = ['accurate', 'helpful', 'incomplete', 'hallucination', 'unsafe', 'needs-review'];

function TraceFeedbackPanel({ traceId }: { traceId: string }) {
  const queryClient = useQueryClient();
  const [sentiment, setSentiment] = useState<Exclude<TraceFeedbackSentiment, 'mixed'> | null>(null);
  const [comment, setComment] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const feedback = useQuery({
    queryKey: ['trace-feedback', traceId],
    queryFn: () => getTraceFeedback(traceId),
  });
  const submit = useMutation({
    mutationFn: () => submitTraceFeedback(traceId, {
      label: 'overall',
      sentiment,
      score: sentiment === 'positive' ? 1 : sentiment === 'neutral' ? 0.5 : sentiment === 'negative' ? 0 : null,
      comment: comment.trim() || null,
      tags,
    }),
    onSuccess: result => {
      queryClient.setQueryData(['trace-feedback', traceId], result);
      setSentiment(null);
      setComment('');
      setTags([]);
    },
  });
  const toggleTag = (tag: string) => setTags(current => current.includes(tag)
    ? current.filter(item => item !== tag)
    : [...current, tag]);
  const summary = feedback.data?.summary;
  const recent = feedback.data?.feedback.slice(0, 5) ?? [];
  const canSubmit = Boolean(sentiment || comment.trim());

  return (
    <section className="panel trace-feedback-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">QUALITY LOOP</span><h2>Trace feedback</h2></div>
        <MessageSquare size={17} />
      </div>
      {feedback.isLoading && <p className="trace-feedback-state">Loading quality signals…</p>}
      {feedback.error && <p className="trace-feedback-state is-error">{feedback.error instanceof Error ? feedback.error.message : 'Feedback could not be loaded.'}</p>}
      {!feedback.isLoading && !feedback.error && (
        <>
          <div className="trace-feedback-summary">
            <div><strong>{summary?.averageScore == null ? '—' : `${Math.round(summary.averageScore * 100)}%`}</strong><span>Average</span></div>
            <div><strong>{summary?.humanCount ?? 0}</strong><span>Human</span></div>
            <div><strong>{summary?.modelCount ?? 0}</strong><span>Model</span></div>
          </div>
          {(summary?.labels.length ?? 0) > 0 && (
            <div className="trace-feedback-labels" aria-label="Quality dimensions">
              {summary!.labels.map(label => (
                <span key={label.label}>
                  {label.label}<b>{label.averageScore == null ? 'signal' : `${Math.round(label.averageScore * 100)}%`}</b>
                </span>
              ))}
            </div>
          )}
          <div className="trace-feedback-review">
            <span className="trace-feedback-prompt">Was this run useful and correct?</span>
            <div className="trace-feedback-sentiment" aria-label="Run sentiment">
              <button type="button" className={sentiment === 'positive' ? 'is-selected is-positive' : ''} aria-pressed={sentiment === 'positive'} onClick={() => setSentiment(value => value === 'positive' ? null : 'positive')}><ThumbsUp size={13} />Positive</button>
              <button type="button" className={sentiment === 'neutral' ? 'is-selected is-neutral' : ''} aria-pressed={sentiment === 'neutral'} onClick={() => setSentiment(value => value === 'neutral' ? null : 'neutral')}><Minus size={13} />Neutral</button>
              <button type="button" className={sentiment === 'negative' ? 'is-selected is-negative' : ''} aria-pressed={sentiment === 'negative'} onClick={() => setSentiment(value => value === 'negative' ? null : 'negative')}><ThumbsDown size={13} />Negative</button>
            </div>
            <textarea
              aria-label="Correction note"
              maxLength={2_000}
              placeholder="Add a correction or reviewer note…"
              value={comment}
              onChange={event => setComment(event.target.value)}
            />
            <div className="trace-feedback-tags" aria-label="Feedback tags">
              {feedbackTags.map(tag => <button type="button" aria-pressed={tags.includes(tag)} className={tags.includes(tag) ? 'is-selected' : ''} key={tag} onClick={() => toggleTag(tag)}>{tag}</button>)}
            </div>
            {submit.error && <p className="trace-feedback-state is-error">{submit.error instanceof Error ? submit.error.message : 'Feedback could not be saved.'}</p>}
            <button className="button button-primary trace-feedback-submit" type="button" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? <Sparkles size={13} /> : <Send size={13} />}{submit.isPending ? 'Saving…' : 'Save feedback'}
            </button>
          </div>
          {recent.length > 0 && (
            <div className="trace-feedback-history">
              <span>ACTIVE SIGNALS</span>
              {recent.map(item => (
                <article key={item.id}>
                  <i className={`sentiment-${item.sentiment ?? 'none'}`} />
                  <div>
                    <b>{item.label} · {item.source}</b>
                    <small>{item.score == null ? item.sentiment ?? 'signal' : `${Math.round(item.score * 100)}%`} · {item.createdByName || (item.source === 'model' ? 'Argus evaluator' : 'System')}</small>
                    {item.comment && <p>{item.comment}</p>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function WorkflowAgentContractCard({ evidence }: { evidence: WorkflowAgentContractEvidence }) {
  const overallStatus = evidence.assignments.some(item => item.status === 'blocked')
    ? 'blocked'
    : evidence.assignments.some(item => item.status === 'degraded') ? 'degraded' : 'ready';
  return (
    <section className="panel run-agent-contract-card" aria-label="Workflow Agent contract evidence">
      <div className="panel-heading">
        <div><span className="eyebrow">EXECUTION CONTRACT</span><h2>Agent resolution</h2></div>
        <ShieldCheck size={17} />
      </div>
      <div className="run-agent-contract-summary">
        <span className={`state-${overallStatus}`}><i />{overallStatus}</span>
        <small>{evidence.assignments.length} captured role{evidence.assignments.length === 1 ? '' : 's'}</small>
      </div>
      {evidence.inferredLegacyContract && (
        <p className="run-agent-contract-legacy"><AlertTriangle size={13} />Legacy agent binding captured; migrate the workflow to portable roles.</p>
      )}
      <div className="run-agent-contract-list">
        {evidence.assignments.map(assignment => (
          <article key={assignment.role} className={`state-${assignment.status}`}>
            <header>
              <div><Bot size={14} /><span><small>{assignment.role}</small><b>{assignment.label}</b></span></div>
              <em>{assignment.status}</em>
            </header>
            <dl>
              <div><dt>Agent</dt><dd title={assignment.agentLabel ?? assignment.agentName ?? 'Unresolved'}>{assignment.agentLabel ?? assignment.agentName ?? 'Unresolved'}</dd></div>
              <div><dt>Model</dt><dd title={assignment.model ?? assignment.runtime?.model ?? 'Not captured'}>{assignment.model ?? assignment.runtime?.model ?? 'Not captured'}</dd></div>
              <div><dt>Runtime</dt><dd title={assignment.runtime?.profileLabel ?? assignment.runtime?.profileName ?? assignment.runtime?.type ?? 'Argus default'}>{assignment.runtime?.profileLabel ?? assignment.runtime?.profileName ?? assignment.runtime?.type ?? 'Argus default'}</dd></div>
              <div><dt>Mode</dt><dd title={assignment.agentMode ?? 'Not captured'}>{assignment.agentMode ?? 'Not captured'}</dd></div>
            </dl>
            <div className="run-agent-contract-counts">
              <span>{assignment.stepIds.length} step{assignment.stepIds.length === 1 ? '' : 's'}</span>
              <span>{assignment.skillNames.length} skill{assignment.skillNames.length === 1 ? '' : 's'}</span>
              <span>{assignment.toolNames.length} tool{assignment.toolNames.length === 1 ? '' : 's'}</span>
              <span>{assignment.bundleIds.length} bundle{assignment.bundleIds.length === 1 ? '' : 's'}</span>
            </div>
            <details>
              <summary>Captured capabilities <ChevronDown size={13} /></summary>
              <div className="run-agent-contract-capabilities">
                <CapabilityEvidence label="Steps" values={assignment.stepIds} />
                <CapabilityEvidence label="Skills" values={assignment.skillNames} />
                <CapabilityEvidence label="Tools" values={assignment.toolNames} />
                <CapabilityEvidence label="Bundles" values={assignment.bundleIds.map(id => `#${id}`)} />
                {assignment.presetName && <CapabilityEvidence label="Preset" values={[`${assignment.presetName}${assignment.installedPresetVersion ? ` v${assignment.installedPresetVersion}` : ''}`]} />}
              </div>
            </details>
            {(assignment.runs ?? []).length > 0 && (
              <section className="run-agent-contract-runs" aria-label={`${assignment.label} correlated agent runs`}>
                <header><small>AGENT RUNS</small><span>{assignment.runs?.length}</span></header>
                {(assignment.runs ?? []).map(run => (
                  <article key={run.traceId}>
                    <a href={run.runHref} aria-label={`Open ${assignment.label} agent run`}>
                      <Network size={13} />
                      <span>
                        <b>{run.taskType?.replaceAll('_', ' ') || run.title}</b>
                        <small>{timeAgo(run.startedAt)}{run.durationMs != null ? ` · ${formatDuration(run.durationMs)}` : ''}</small>
                      </span>
                      <em className={`state-${run.status}`}>{run.status}</em>
                      <ChevronRight size={13} />
                    </a>
                    <a href={run.traceHref} aria-label={`Open ${assignment.label} trace logs`}><Search size={12} />Trace logs</a>
                  </article>
                ))}
              </section>
            )}
            {(assignment.blockers.length > 0 || assignment.warnings.length > 0) && (
              <ul className="run-agent-contract-findings">
                {[...assignment.blockers, ...assignment.warnings].map(message => <li key={message}>{message}</li>)}
              </ul>
            )}
            {assignment.catalogFingerprint && <code title={assignment.catalogFingerprint}>Catalog {assignment.catalogFingerprint.slice(0, 12)}</code>}
          </article>
        ))}
      </div>
      <footer className="run-agent-contract-footer">
        <span>{evidence.capturedAt ? `Resolved ${dateTime(evidence.capturedAt)}` : 'Resolution timestamp unavailable'}</span>
        {evidence.contractFingerprint && <code title={evidence.contractFingerprint}>Contract {evidence.contractFingerprint.slice(0, 12)}</code>}
      </footer>
    </section>
  );
}

function CapabilityEvidence({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <small>{label}</small>
      <span>{values.length > 0 ? values.map(value => <i key={value}>{value}</i>) : <i>None</i>}</span>
    </div>
  );
}

export function RunDetailPage() {
  const { kind: rawKind, runId } = useParams();
  const [searchParams] = useSearchParams();
  const rawSpanId = searchParams.get('span');
  const requestedSpanId = rawSpanId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawSpanId)
    ? rawSpanId
    : null;
  const kind = rawKind === 'agent' || rawKind === 'workflow' ? rawKind : null;
  const query = useQuery({
    queryKey: ['run-detail', kind, runId],
    queryFn: () => getRunDetail(kind!, runId!),
    enabled: Boolean(kind && runId),
    refetchInterval: current =>
      ['running', 'waiting'].includes(current.state.data?.run.status ?? '') ? 3_000 : false,
  });
  const [traceView, setTraceView] = useState<'tree' | 'waterfall' | 'timeline' | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const codexRuntime = useQuery({
    queryKey: ['codex-runtime-status'],
    queryFn: getCodexRuntimeStatus,
    enabled: kind === 'workflow' || kind === 'agent',
    refetchInterval: queryState => queryState.state.data?.activeRuns ? 5_000 : 30_000,
  });
  const codingThread = useQuery({
    queryKey: ['coding-thread-detail', runId],
    queryFn: () => getCodingThread(runId!),
    enabled: kind === 'workflow' && Boolean(runId && uuidPattern.test(runId)),
    retry: false,
    refetchInterval: current => {
      const status = current.state.data?.status;
      return status && ['queued', 'running', 'interrupted', 'waiting_external_ci'].includes(status) ? 4_000 : false;
    },
  });
  const cancelRuntime = useMutation({
    mutationFn: cancelCodexRuntimeRun,
    onSuccess: () => { void codexRuntime.refetch(); },
  });

  if (!kind || !runId) return <Navigate to="/runs" replace />;
  if (query.isLoading) return <LoadingState label="Loading run timeline…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data) return null;

  const { run, timeline, steps, currentApproval, metrics, traceFamily, agentContract } = query.data;
  const visualEvidence = visualWorkflowTraceEvidence(codingThread.data);
  const displayedSteps = visualEvidence.steps.length > 0 ? visualEvidence.steps : steps;
  const codeIntelligence = traceFamily?.codeIntelligence ?? null;
  const humanChangeRequest = typeof codingThread.data?.values?.['human_change_request'] === 'string'
    ? codingThread.data.values['human_change_request'].trim()
    : '';
  const humanChangeStatus = codingThread.data && humanChangeRequest
    ? humanChangeRequestStatus(codingThread.data)
    : null;
  const ciRun = codingCiRun(codingThread.data);
  const ciRunHref = externalHttpUrl(ciRun?.run_url) ?? externalHttpUrl(typeof codingThread.data?.values?.['build_url'] === 'string' ? codingThread.data.values['build_url'] : undefined);
  const codingAgentRun = traceFamily?.runs.find(candidate => candidate.kind === 'agent' && /coder/i.test(`${candidate.title} ${candidate.subtitle}`));
  const reviewerAgentRun = traceFamily?.runs.find(candidate => candidate.kind === 'agent' && /review/i.test(`${candidate.title} ${candidate.subtitle}`));
  const codingAgentHref = codingAgentRun ? codingAgentRun.href ?? `/runs/agent/${encodeURIComponent(codingAgentRun.id)}` : null;
  const reviewerAgentHref = reviewerAgentRun ? reviewerAgentRun.href ?? `/runs/agent/${encodeURIComponent(reviewerAgentRun.id)}` : null;
  const hasDistributedTrace = Boolean(traceFamily?.runs.length);
  const runtimeCorrelationIds = new Set([
    run.rootTraceId,
    run.traceId,
    traceFamily?.rootTraceId,
    traceFamily?.currentTraceId,
    ...(traceFamily?.runs.map(candidate => candidate.id) ?? []),
  ].filter((value): value is string => Boolean(value)));
  const correlatedCodexRuns = codexRuntime.data?.runs.filter(runtimeRun => [
    runtimeRun.rootTraceId,
    runtimeRun.telemetryRootTraceId,
    runtimeRun.telemetryTraceId,
  ].some(correlationId => Boolean(correlationId && runtimeCorrelationIds.has(correlationId)))) ?? [];
  const activeTraceView = traceView ?? (requestedSpanId && traceFamily ? 'tree' : (traceFamily?.runs.length ?? 0) > 1 ? 'tree' : 'waterfall');
  const totalSteps = visualEvidence.steps.length > 0 ? displayedSteps.length : run.totalSteps;
  const completedSteps = visualEvidence.steps.length > 0
    ? displayedSteps.filter(step => ['completed', 'failed', 'skipped'].includes(step.status)).length
    : run.completedSteps;
  const progress = totalSteps > 0
    ? Math.round((completedSteps / totalSteps) * 100)
    : run.status === 'completed' ? 100 : 0;
  const selectedEvent = timeline.find(event => event.id === selectedEventId)
    ?? timeline.find(event => !terminalKinds.includes(event.kind))
    ?? timeline[0]
    ?? null;
  const observedDuration = Math.max(
    run.durationMs ?? 0,
    Date.parse(query.data.generatedAt) - Date.parse(run.startedAt),
    ...timeline.map(event => Math.max(0, Date.parse(event.timestamp) - Date.parse(run.startedAt))),
  );

  return (
    <>
      <a className="back-link" href="/runs"><ArrowLeft size={14} />All runs</a>
      <PageHeader
        eyebrow={run.kind === 'workflow' ? 'WORKFLOW RUN' : 'AGENT RUN'}
        title={run.title}
        description={`${run.subtitle} · Started ${timeAgo(run.startedAt)}`}
        actions={(
          <>
            <StatusBadge status={run.status} />
            {(run.traceId || traceFamily?.currentTraceId) && <TraceToEvaluationButton traceId={(run.traceId || traceFamily?.currentTraceId)!} />}
            {run.workflowHref && (
              <a className="button button-secondary" href={run.workflowHref}>
                <GitBranch size={15} />{run.workflowHref.includes('?replay=') ? 'Replay workflow' : 'Open workflow'}<ExternalLink size={12} />
              </a>
            )}
          </>
        )}
      />

      {run.status === 'waiting' && (
        <section className="run-waiting-banner">
          <span><PauseCircle size={18} /></span>
          <div>
            <b>Execution paused for human approval</b>
            <p>
              {currentApproval
                ? `${currentApproval.toolName} is waiting at step ${currentApproval.stepId ?? run.waitingStepId ?? 'unknown'}.`
                : `Run is waiting at step ${run.waitingStepId ?? 'unknown'}.`}
            </p>
          </div>
          <a className="button button-primary" href={`/governance?workflowExecutionId=${encodeURIComponent(run.id)}&run=${encodeURIComponent(run.id)}&kind=workflow`}>Review approval</a>
        </section>
      )}

      {run.status === 'failed' && run.error && (
        <section className="run-failure-banner" aria-label="Runtime failure evidence">
          <span><AlertTriangle size={19} /></span>
          <div>
            <small>RUNTIME FAILURE</small>
            <b>{run.error}</b>
            <p>The workflow stopped before the next stage. Select the failed node in the trace to inspect its runtime evidence.</p>
            <div>
              <a href={`/observe/logs?root_trace=${encodeURIComponent(run.rootTraceId ?? run.traceId ?? run.id)}`}><Search size={13} />Open correlated logs</a>
              {run.traceId && <a href={`/observe/logs?trace=${encodeURIComponent(run.traceId)}`}><Network size={13} />Open trace logs</a>}
            </div>
          </div>
        </section>
      )}

      <section className="run-metric-grid">
        <article>
          <span>Progress</span>
          <strong>{progress}%</strong>
          <div className="run-progress"><i style={{ width: `${progress}%` }} /></div>
          <small>{completedSteps} of {totalSteps} steps settled</small>
        </article>
        <article>
          <span>Duration</span>
          <strong>{formatDuration(run.durationMs)}</strong>
          <small>{run.status === 'running' || run.status === 'waiting' ? 'Execution is still active' : dateTime(run.updatedAt)}</small>
        </article>
        <article>
          <span>{run.kind === 'workflow' ? 'Resumes' : 'Tool calls'}</span>
          <strong>{run.kind === 'workflow' ? (run.resumeCount ?? 0) : (metrics.toolCallCount ?? 0)}</strong>
          <small>{run.kind === 'workflow' ? `${metrics.approvalCount ?? 0} approval checkpoints` : `Iteration ${run.iteration ?? 0}`}</small>
        </article>
        <article>
          <span>{run.kind === 'workflow' ? 'Oversight' : 'Token usage'}</span>
          <strong>
            {run.kind === 'workflow'
              ? run.humanOversightRequired ? 'Required' : 'Standard'
              : (run.inputTokens ?? 0) + (run.outputTokens ?? 0)}
          </strong>
          <small>
            {run.kind === 'workflow'
              ? run.lifecycleStatus ?? 'workflow policy'
              : `${run.termination ? `${run.termination.replaceAll('_', ' ')} · ` : ''}$${(run.estimatedCostUsd ?? 0).toFixed(4)} estimated`}
          </small>
        </article>
      </section>

      <div className="run-detail-layout">
        <section className="panel run-timeline-panel">
          <div className="panel-heading trace-panel-heading">
            <div><span className="eyebrow">TRACE</span><h2>{activeTraceView === 'tree' ? 'Distributed trace' : activeTraceView === 'waterfall' ? traceFamily ? 'Distributed waterfall' : 'Execution waterfall' : 'Execution timeline'}</h2></div>
            <div className="trace-view-switch" aria-label="Trace visualization">
              {hasDistributedTrace && <button type="button" className={activeTraceView === 'tree' ? 'is-active' : ''} onClick={() => setTraceView('tree')}><Network size={13} />Trace tree</button>}
              <button type="button" className={activeTraceView === 'waterfall' ? 'is-active' : ''} onClick={() => setTraceView('waterfall')}><Rows3 size={13} />Waterfall</button>
              <button type="button" className={activeTraceView === 'timeline' ? 'is-active' : ''} onClick={() => setTraceView('timeline')}><Clock3 size={13} />Timeline</button>
            </div>
          </div>
          <RoutingDecisionEvidence decisions={visualEvidence.decisions} />
          {activeTraceView === 'tree' && traceFamily
            ? <DistributedTraceView family={traceFamily} initialSpanId={requestedSpanId} mode="tree" />
            : activeTraceView === 'waterfall' && traceFamily
              ? <DistributedTraceView family={traceFamily} initialSpanId={requestedSpanId} mode="waterfall" />
              : activeTraceView === 'waterfall'
                ? <Waterfall events={timeline} startedAt={run.startedAt} durationMs={observedDuration} selectedId={selectedEvent?.id ?? null} onSelect={event => setSelectedEventId(event.id)} />
                : <div className="run-timeline">{timeline.map(event => <TimelineEvent event={event} selected={selectedEvent?.id === event.id} onSelect={selected => setSelectedEventId(selected.id)} key={event.id} />)}</div>}
          {(activeTraceView === 'timeline' || (activeTraceView === 'waterfall' && !traceFamily)) && <TraceInspector event={selectedEvent} runId={run.id} traceId={run.traceId} />}
        </section>

        <aside className="run-detail-side">
          <section className="panel run-context-panel">
            <div className="panel-heading">
              <div><span className="eyebrow">CONTEXT</span><h2>Run facts</h2></div>
              {run.kind === 'agent' ? <Bot size={17} /> : <GitBranch size={17} />}
            </div>
            <dl className="run-facts">
              <div><dt>Run ID</dt><dd>{run.id}</dd></div>
              {run.rootTraceId && <div><dt>Trace root</dt><dd title={run.rootTraceId}>{run.rootTraceId === run.id ? 'This run' : `${run.rootTraceId.slice(0, 8)}…`}</dd></div>}
              {run.parentTraceId && <div><dt>Parent trace</dt><dd title={run.parentTraceId}>{run.parentTraceId.slice(0, 8)}…</dd></div>}
              {run.parentSpanId && <div><dt>Parent span</dt><dd title={run.parentSpanId}>{run.parentSpanId.slice(0, 8)}…</dd></div>}
              {run.termination && <div><dt>Termination</dt><dd>{run.termination.replaceAll('_', ' ')}</dd></div>}
              <div><dt>Type</dt><dd>{run.kind}</dd></div>
              <div><dt>Started</dt><dd>{dateTime(run.startedAt)}</dd></div>
              {run.trigger && <div><dt>Trigger</dt><dd>{run.trigger}</dd></div>}
              {run.inputKeys && <div><dt>Inputs</dt><dd>{run.inputKeys.join(', ') || 'None'}</dd></div>}
              {run.tags && <div><dt>Tags</dt><dd>{run.tags.join(', ') || 'None'}</dd></div>}
            </dl>
          </section>

          {agentContract && agentContract.assignments.length > 0 && (
            <WorkflowAgentContractCard evidence={agentContract} />
          )}

          {codeIntelligence && (
            <section className="panel run-code-evidence-card" aria-label="Native code intelligence evidence">
              <div className="panel-heading">
                <div><span className="eyebrow">CODE INTELLIGENCE</span><h2>Repository evidence</h2></div>
                <Braces size={17} />
              </div>
              <div className="run-code-evidence-mode">
                <span><i />{codeIntelligence.mode === 'local_retrieval' ? 'Local retrieval observed' : 'Commit metadata only'}</span>
                <small>{codeIntelligence.snapshots.length} snapshot{codeIntelligence.snapshots.length === 1 ? '' : 's'}</small>
              </div>
              <div className="run-code-snapshot-list">
                {codeIntelligence.snapshots.map(snapshot => (
                  <article key={snapshot.snapshotId}>
                    <header>
                      <span><GitBranch size={13} /><b>{snapshot.repositoryKey}</b></span>
                      <a href={codeEvidenceHref(traceFamily!, snapshot.traceId, snapshot.spanId)}>Trace <ExternalLink size={10} /></a>
                    </header>
                    <code title={snapshot.commitSha}>{snapshot.branchName} · {snapshot.commitSha.slice(0, 12)}</code>
                    <footer>
                      <span>#{snapshot.snapshotId}</span>
                      {snapshot.fileCount != null && <span>{snapshot.fileCount} files</span>}
                      {snapshot.symbolCount != null && <span>{snapshot.symbolCount} symbols</span>}
                      {snapshot.edgeCount != null && <span>{snapshot.edgeCount} relations</span>}
                    </footer>
                  </article>
                ))}
              </div>
              {codeIntelligence.retrievals.length > 0 ? (
                <div className="run-code-retrieval-list">
                  <span>CONTEXT QUERIES</span>
                  {codeIntelligence.retrievals.map(retrieval => {
                    const snapshot = codeIntelligence.snapshots.find(item => item.snapshotId === retrieval.snapshotId);
                    return (
                      <article key={retrieval.spanId} className={`state-${retrieval.status}`}>
                        <header>
                          <span><Bot size={12} /><b>{codeAgentLabel(retrieval)}</b></span>
                          {retrieval.runtimeTraceId
                            ? <a href={`/runs/agent/${encodeURIComponent(retrieval.runtimeTraceId)}`}>Agent run <ExternalLink size={10} /></a>
                            : <small>Agent trace unavailable</small>}
                        </header>
                        <div className="run-code-retrieval-summary">
                          <span><Search size={12} /><b>{retrieval.evidenceCount} references</b><small>{codeTaskLabel(retrieval.taskType)}</small></span>
                          <a href={codeEvidenceHref(traceFamily!, retrieval.traceId, retrieval.spanId)}>Context · {formatDuration(retrieval.durationMs)} <ExternalLink size={10} /></a>
                        </div>
                        <div className="run-code-retrieval-channels">
                          <span>{retrieval.channels.length > 0 ? retrieval.channels.map(channel => <i key={channel}>{channel}</i>) : <i>no matches</i>}</span>
                          {snapshot && <small title={snapshot.commitSha}>Snapshot #{snapshot.snapshotId} · {snapshot.commitSha.slice(0, 8)}</small>}
                        </div>
                        {retrieval.citations.length > 0 ? (
                          <ul>{retrieval.citations.map((citation, index) => (
                            <li key={`${citation.filePath}-${citation.startLine ?? 'file'}-${index}`}>
                              <code title={codeCitationLabel(citation)}>{codeCitationLabel(citation)}</code>
                              <small>{citation.symbolName || citation.chunkKind || 'file context'}{citation.channels.length > 0 ? ` · ${citation.channels.join(' + ')}` : ''}</small>
                            </li>
                          ))}</ul>
                        ) : <p>{retrieval.error || 'This earlier trace recorded the evidence count but no source-free citations.'}</p>}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="run-code-evidence-empty">No source context was requested. Subscription runtimes remain on the metadata-only boundary.</p>
              )}
            </section>
          )}

          {ciRun && (
            <section className="panel run-ci-evidence-card" aria-label="External CI/CD evidence">
              <div className="panel-heading">
                <div><span className="eyebrow">EXTERNAL CI/CD</span><h2>{ciProviderLabel(ciRun.provider)} pipeline</h2></div>
                <Network size={17} />
              </div>
              <div className="run-ci-evidence-status">
                <span className={`state-${ciRun.status}`}><i />{ciRun.status}</span>
                <small>{ciRun.workflow || 'External CI/CD'}</small>
              </div>
              <dl className="run-facts run-ci-evidence-facts">
                <div><dt>Branch</dt><dd>{ciRun.branch || '—'}</dd></div>
                {ciRun.external_id && <div><dt>Provider run</dt><dd>{ciRun.external_id}</dd></div>}
                {ciRun.commit_sha && <div><dt>Commit</dt><dd title={ciRun.commit_sha}>{ciRun.commit_sha.slice(0, 12)}{ciRun.commit_sha.length > 12 ? '…' : ''}</dd></div>}
              </dl>
              {ciRunHref && <a className="run-ci-evidence-link" href={ciRunHref} target="_blank" rel="noreferrer">Open {ciProviderLabel(ciRun.provider)} CI run <ExternalLink size={12} /></a>}
            </section>
          )}

          {humanChangeRequest && humanChangeStatus && (
            <section className="panel human-change-request-card" aria-label="Human change request">
              <div className="panel-heading">
                <div><span className="eyebrow">HUMAN INPUT</span><h2>Change request</h2></div>
                <MessageSquare size={17} />
              </div>
              <div className="human-change-request-status">
                <span className={`status-dot status-${humanChangeStatus.tone}`} />
                <b>{humanChangeStatus.label}</b>
              </div>
              <blockquote>{humanChangeRequest}</blockquote>
              {codingThread.data?.updated_at && (
                <small className="human-change-request-updated">Last updated {dateTime(codingThread.data.updated_at)}</small>
              )}
              <div className="human-change-request-links">
                {codingAgentHref && <a href={codingAgentHref}><Bot size={13} />Coder activity<ExternalLink size={11} /></a>}
                {reviewerAgentHref && <a href={reviewerAgentHref}><ShieldCheck size={13} />Reviewer activity<ExternalLink size={11} /></a>}
                {!codingAgentHref && !reviewerAgentHref && <span><GitBranch size={13} />Persisted in workflow trace</span>}
              </div>
            </section>
          )}

          {(kind === 'workflow' || kind === 'agent') && (codexRuntime.data || codexRuntime.error) && (
            <section className="panel runtime-session-panel" aria-label="Codex runtime sessions">
              <div className="panel-heading">
                <div><span className="eyebrow">EXECUTION RUNTIME</span><h2>Codex sessions</h2></div>
                <Zap size={17} />
              </div>
              {codexRuntime.data ? <>
                <div className="runtime-session-summary">
                  <span className={codexRuntime.data.authenticated ? 'is-ok' : 'is-error'}><i />{codexRuntime.data.authenticated ? 'Authenticated' : 'Not authenticated'}</span>
                  <b>{codexRuntime.data.activeRuns}/{codexRuntime.data.maxConcurrentRuns} active</b>
                </div>
                {correlatedCodexRuns.length === 0 ? <p className="runtime-session-empty">No Codex sessions are correlated with this run.</p> : (
                <div className="runtime-session-list">
                  {correlatedCodexRuns.map(runtimeRun => (
                    <article key={runtimeRun.id} className={`runtime-session state-${runtimeRun.state}`}>
                      <div><b>{runtimeRun.taskType || 'Codex worker'}</b><small>{runtimeRun.state} · {runtimeRun.model || 'codex-default'}</small></div>
                      <code title={runtimeRun.id}>{runtimeRun.id.slice(0, 8)}…</code>
                      {['starting', 'running'].includes(runtimeRun.state) && <button type="button" disabled={cancelRuntime.isPending} onClick={() => cancelRuntime.mutate(runtimeRun.id)}>{cancelRuntime.isPending ? 'Stopping…' : 'Stop'}</button>}
                      {runtimeRun.error && <p>{runtimeRun.error}</p>}
                    </article>
                  ))}
                </div>
                )}
              </> : null}
              {codexRuntime.error && <p className="runtime-session-error">Runtime status unavailable: {codexRuntime.error instanceof Error ? codexRuntime.error.message : 'unknown error'}</p>}
              {cancelRuntime.error && <p className="runtime-session-error">Could not stop session: {cancelRuntime.error instanceof Error ? cancelRuntime.error.message : 'unknown error'}</p>}
            </section>
          )}

          {run.traceId && <TraceFeedbackPanel traceId={run.traceId} />}

          {currentApproval && (
            <section className="panel run-approval-card">
              <span className="eyebrow">APPROVAL</span>
              <div className="run-approval-title">
                <ShieldCheck size={17} />
                <div>
                  <b>#{currentApproval.id} · {currentApproval.status}</b>
                  <span>{currentApproval.toolName} · {currentApproval.riskLevel} {currentApproval.riskScore}/100</span>
                </div>
              </div>
              <div className="run-approval-factors">
                {currentApproval.riskFactors.map(factor => <span key={factor.id}>+{factor.weight} {factor.label}</span>)}
              </div>
              <p>{currentApproval.comment || 'No reviewer comment.'}</p>
              <a href={`/governance?approval=runtime-${encodeURIComponent(String(currentApproval.id))}&workflowExecutionId=${encodeURIComponent(run.id)}&run=${encodeURIComponent(run.id)}&kind=workflow`}>Open approval <ExternalLink size={12} /></a>
            </section>
          )}

          <section className="panel run-step-map">
            <div className="panel-heading">
              <div><span className="eyebrow">{run.kind === 'agent' ? 'TOOLS' : 'STEPS'}</span><h2>Execution map</h2></div>
              <Zap size={17} />
            </div>
            <div className="run-step-list">
              {displayedSteps.map(step => (
                <div className={`run-step step-${step.status}`} key={step.id}>
                  <span className="step-state">
                    {step.status === 'completed'
                      ? <CheckCircle2 size={13} />
                      : step.status === 'failed'
                        ? <XCircle size={13} />
                        : step.status === 'waiting'
                          ? <PauseCircle size={13} />
                          : step.status === 'skipped'
                            ? <SkipForward size={13} />
                          : <Circle size={11} />}
                  </span>
                  <div><b>{step.label}</b><small>{step.toolName || step.type}</small></div>
                  <time>{formatDuration(step.durationMs)}</time>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
