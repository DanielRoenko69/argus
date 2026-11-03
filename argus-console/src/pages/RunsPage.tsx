import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  ExternalLink,
  Filter,
  GitBranch,
  Network,
  Search,
  ShieldCheck,
  Workflow,
  XCircle,
} from 'lucide-react';
import { getRunFamilies } from '../api';
import { EmptyState, ErrorState, formatDuration, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { RunWorkspaceTabs } from '../features/runs/RunWorkspaceTabs';
import type { RunDisplayStatus, RunSummaryV2 } from '../types';

type RunFilter = 'all' | RunDisplayStatus;

const filters: RunFilter[] = ['all', 'active', 'action_required', 'waiting', 'succeeded', 'failed', 'cancelled', 'stale'];

const statusLabels: Record<RunDisplayStatus, string> = {
  active: 'Active',
  waiting: 'Waiting',
  action_required: 'Action required',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  stale: 'Stale',
};

function StatusIcon({ status }: { status: RunDisplayStatus }) {
  if (status === 'succeeded') return <CheckCircle2 size={14} />;
  if (status === 'failed') return <XCircle size={14} />;
  if (status === 'action_required') return <AlertTriangle size={14} />;
  if (status === 'waiting') return <Clock3 size={14} />;
  if (status === 'active') return <Activity size={14} />;
  return <CircleDot size={14} />;
}

function RunState({ status }: { status: RunDisplayStatus }) {
  return (
    <span className={`run-family-state is-${status}`}>
      <StatusIcon status={status} />
      {statusLabels[status]}
    </span>
  );
}

function childTotal(run: RunSummaryV2): number {
  return Object.values(run.childCounts).reduce((total, value) => total + value, 0);
}

function evidenceLabel(run: RunSummaryV2): string {
  if (run.evidenceCompleteness === 'frozen') return 'Frozen evidence';
  if (run.evidenceCompleteness === 'legacy_live_fallback') return 'Live fallback';
  return 'Evidence missing';
}

function approvalTarget(run: RunSummaryV2): RunSummaryV2 | null {
  if (run.allowedActions.includes('review_approval')) return run;
  for (const child of run.children ?? []) {
    const match = approvalTarget(child);
    if (match) return match;
  }
  return null;
}

function approvalHref(run: RunSummaryV2): string | null {
  const target = approvalTarget(run);
  if (!target) return null;
  const params = new URLSearchParams({ run: target.id, kind: target.kind });
  if (target.kind === 'workflow' && /^\d+$/.test(target.id)) params.set('workflowExecutionId', target.id);
  return `/governance?${params.toString()}`;
}

function descendantRows(children: RunSummaryV2[], depth = 0): JSX.Element[] {
  return children.flatMap(child => [
    <a className="run-child-row" href={child.href} key={`${child.kind}-${child.id}`} style={{ '--run-depth': depth } as CSSProperties}>
      <span className={`run-child-glyph is-${child.displayStatus}`}>{child.kind === 'agent' ? <Bot size={14} /> : <GitBranch size={14} />}</span>
      <span className="run-child-copy">
        <b>{child.title}</b>
        <small>{child.currentPhase || child.kind} · {child.id}</small>
      </span>
      <RunState status={child.displayStatus} />
      <time>{timeAgo(child.updatedAt)}</time>
      <ExternalLink size={13} />
    </a>,
    ...descendantRows(child.children ?? [], depth + 1),
  ]);
}

function RunFamilyCard({ run }: { run: RunSummaryV2 }) {
  const children = childTotal(run);
  const tags = [...new Map(run.resourceRefs.flatMap(ref => ref.tags).map(tag => [tag.id, tag])).values()];
  const references = run.resourceRefs.slice(0, 3);
  const reviewHref = approvalHref(run);

  return (
    <article className={`run-family-card is-${run.displayStatus}`}>
      <div className="run-family-header">
        <span className={`run-family-glyph is-${run.displayStatus}`}>
          {run.kind === 'agent' ? <Bot size={19} /> : <Workflow size={19} />}
        </span>
        <div className="run-family-title">
          <span className="run-family-kicker">{run.kind} root · {run.id}</span>
          <h2>{run.title}</h2>
          <p>{run.attentionReason || (run.currentPhase ? `Current phase: ${run.currentPhase}` : 'Run family and governed execution lineage')}</p>
        </div>
        <RunState status={run.displayStatus} />
        <div className="run-family-actions">
          {reviewHref && <a className="button button-primary" href={reviewHref}><ShieldCheck size={15} />Review approval</a>}
          <a className="button button-secondary" href={run.href}>Open run<ExternalLink size={14} /></a>
        </div>
      </div>

      <div className="run-family-facts">
        <span><Clock3 size={14} /><b>{formatDuration(run.durationMs)}</b><small>duration</small></span>
        <span><Network size={14} /><b>{children}</b><small>child runs</small></span>
        <span className={`run-evidence is-${run.evidenceCompleteness}`}><ShieldCheck size={14} /><b>{evidenceLabel(run)}</b><small>evidence</small></span>
        <span><Activity size={14} /><b>{timeAgo(run.updatedAt)}</b><small>last update</small></span>
      </div>

      {(references.length > 0 || tags.length > 0) && (
        <div className="run-family-context">
          {references.map(ref => ref.href
            ? <a href={ref.href} key={`${ref.type}-${ref.id}`}>{ref.label}</a>
            : <span key={`${ref.type}-${ref.id}`}>{ref.label}</span>)}
          {tags.map(tag => <em key={tag.id} style={tag.color ? { '--tag-color': tag.color } as CSSProperties : undefined}>{tag.label}</em>)}
        </div>
      )}

      {children > 0 && (
        <details className="run-family-children" open={run.displayStatus === 'active' || run.displayStatus === 'action_required'}>
          <summary>
            <ChevronDown size={15} />
            Execution lineage
            <span>{run.childCounts.running} active · {run.childCounts.waiting} waiting · {run.childCounts.failed} failed · {run.childCounts.completed} completed</span>
          </summary>
          <div>{descendantRows(run.children ?? [])}</div>
        </details>
      )}
    </article>
  );
}

export function RunsPage() {
  const [status, setStatus] = useState<RunFilter>('all');
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['run-families'], queryFn: getRunFamilies, refetchInterval: 10_000 });

  const allRuns = query.data?.items ?? [];
  const runs = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return allRuns.filter(run => {
      if (status !== 'all' && run.displayStatus !== status) return false;
      if (!normalized) return true;
      const familyText = [
        run.title,
        run.id,
        run.currentPhase,
        run.attentionReason,
        ...run.resourceRefs.flatMap(ref => [ref.label, ...ref.tags.map(tag => tag.label)]),
        ...(run.children ?? []).flatMap(child => [child.title, child.id, child.currentPhase]),
      ].filter(Boolean).join(' ').toLowerCase();
      return familyText.includes(normalized);
    });
  }, [allRuns, search, status]);

  const counts = useMemo(() => ({
    active: allRuns.filter(run => run.displayStatus === 'active').length,
    action: allRuns.filter(run => run.displayStatus === 'action_required').length,
    failed: allRuns.filter(run => run.displayStatus === 'failed').length,
    frozen: allRuns.filter(run => run.evidenceCompleteness === 'frozen').length,
  }), [allRuns]);

  if (query.isLoading) return <LoadingState label="Loading governed run families…" />;
  if (query.error) return <ErrorState error={query.error} />;

  return (
    <>
      <PageHeader
        eyebrow="OPERATE · RUN CONTROL"
        title="Runs"
        description="Follow one governed task from root workflow through agents, retries, approval and evidence."
        actions={<a className="button button-primary" href="/build/workflows"><Workflow size={16} />Start workflow</a>}
      />

      <RunWorkspaceTabs active="runs" />

      <section className="metric-grid run-family-metrics" aria-label="Run control summary">
        <article className="metric-card"><span className="metric-icon blue"><Activity size={17} /></span><div><span>Active</span><strong>{counts.active}</strong><small>root runs</small></div></article>
        <article className="metric-card"><span className="metric-icon amber"><AlertTriangle size={17} /></span><div><span>Action required</span><strong>{counts.action}</strong><small>approval or intervention</small></div></article>
        <article className="metric-card"><span className="metric-icon red"><XCircle size={17} /></span><div><span>Failed</span><strong>{counts.failed}</strong><small>root families</small></div></article>
        <article className="metric-card"><span className="metric-icon violet"><ShieldCheck size={17} /></span><div><span>Frozen evidence</span><strong>{counts.frozen}</strong><small>reproducible context</small></div></article>
      </section>

      <div className="filter-bar run-family-toolbar">
        <div className="segmented-filter" aria-label="Filter runs by status">
          {filters.map(value => (
            <button className={status === value ? 'is-active' : ''} type="button" key={value} onClick={() => setStatus(value)}>
              {value === 'all' ? 'All' : statusLabels[value]}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search runs, resources or tags" />
        </label>
        <button className="icon-button" type="button" aria-label="More filters"><Filter size={17} /></button>
      </div>

      {query.data?.orphanCount ? (
        <div className="run-family-warning" role="status"><AlertTriangle size={15} />{query.data.orphanCount} visible run(s) have a parent outside your authorized scope.</div>
      ) : null}

      <section className="run-family-list" aria-label="Run families">
        {runs.length > 0
          ? runs.map(run => <RunFamilyCard run={run} key={`${run.kind}-${run.id}`} />)
          : <div className="panel"><EmptyState title="No matching run families" description="Change the filter or start a new workflow execution." /></div>}
      </section>

      {query.data?.nextCursor && <p className="run-family-limit">Showing the latest 100 root runs. Refine the search to narrow the result.</p>}
    </>
  );
}
