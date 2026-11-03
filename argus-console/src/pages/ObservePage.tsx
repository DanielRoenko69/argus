import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  BellRing,
  CheckCircle2,
  CircleDollarSign,
  Cpu,
  Gauge,
  HeartPulse,
  PauseCircle,
  Radio,
  Search,
  Timer,
  Target,
  TriangleAlert,
  Waypoints,
  Wrench,
  Workflow,
} from 'lucide-react';
import { getLiveActivity, getObservabilityAnalytics, getOverview, getRuns } from '../api';
import { isPlatformAdminRole } from '../access';
import { ErrorState, formatDuration, HealthBadge, LoadingState, PageHeader, StatusBadge, timeAgo } from '../components/Ui';
import { ObserveWorkspaceTabs } from '../features/observe/ObserveWorkspaceTabs';
import type { RunStatus } from '../types';

type TraceStatus = 'all' | RunStatus;
type TraceKind = 'all' | 'agent' | 'workflow';

const ranges = [1, 6, 24, 168] as const;
const statuses: TraceStatus[] = ['all', 'running', 'waiting', 'completed', 'failed', 'cancelled'];

function rangeLabel(hours: number): string {
  return hours === 1 ? '1h' : hours === 168 ? '7d' : `${hours}h`;
}

function compactNumber(value: number): string {
  return Intl.NumberFormat('en', { notation: value >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function formatCost(value: number): string {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

export function ObservePage() {
  const [hours, setHours] = useState<(typeof ranges)[number]>(24);
  const [status, setStatus] = useState<TraceStatus>('all');
  const [kind, setKind] = useState<TraceKind>('all');
  const [search, setSearch] = useState('');
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview, refetchInterval: 15_000 });
  const analytics = useQuery({ queryKey: ['observe-analytics', hours], queryFn: () => getObservabilityAnalytics(hours), refetchInterval: 30_000 });
  const runs = useQuery({ queryKey: ['runs'], queryFn: getRuns, refetchInterval: 10_000 });
  const isAdmin = isPlatformAdminRole(overview.data?.user.role);
  const live = useQuery({
    queryKey: ['live-activity'],
    queryFn: getLiveActivity,
    enabled: isAdmin,
    refetchInterval: 2_000,
  });

  const traces = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return (runs.data?.runs ?? []).filter(run => {
      if (status !== 'all' && run.status !== status) return false;
      if (kind !== 'all' && run.kind !== kind) return false;
      if (Number.isFinite(new Date(run.startedAt).getTime()) && new Date(run.startedAt).getTime() < cutoff) return false;
      return !normalized || `${run.title} ${run.subtitle} ${run.id}`.toLowerCase().includes(normalized);
    });
  }, [hours, kind, runs.data, search, status]);

  if (overview.isLoading || runs.isLoading) return <LoadingState label="Loading observability workspace…" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  if (runs.error) return <ErrorState error={runs.error} />;
  if (!overview.data) return null;

  const analyticsData = analytics.data;
  const summary = analyticsData?.summary;
  const timeline = analyticsData?.timeline ?? [];
  const maxCalls = Math.max(1, ...timeline.map(point => point.count));
  const maxToolCalls = Math.max(1, ...(analyticsData?.tools ?? []).map(tool => tool.calls));
  const maxModelWeight = Math.max(0.000001, ...(analyticsData?.models ?? []).map(model => model.costUsd || model.calls));
  const executors = [
    ...(analyticsData?.agents ?? []).map(item => ({ ...item, kind: 'agent' as const })),
    ...(analyticsData?.workflows ?? []).map(item => ({ ...item, kind: 'workflow' as const, tokens: 0, costUsd: 0 })),
  ].sort((left, right) => right.executions - left.executions).slice(0, 7);
  const visibleTraces = traces.slice(0, 12);

  return (
    <>
      <PageHeader
        eyebrow="OBSERVE"
        title="Observability"
        description="Understand what happened, where time was spent and which execution needs attention."
        actions={
          <div className="observe-range" aria-label="Observability time range">
            {ranges.map(value => <button type="button" className={hours === value ? 'is-active' : ''} key={value} onClick={() => setHours(value)}>{rangeLabel(value)}</button>)}
          </div>
        }
      />

      <ObserveWorkspaceTabs active="overview" isAdmin={isAdmin} />

      <section className="observe-status panel">
        <div>
          <span className="eyebrow">PLATFORM PULSE · LAST {rangeLabel(hours).toUpperCase()}</span>
          <h2>Argus is {overview.data.health.state.replace('_', ' ')}</h2>
          <p>{overview.data.stats.activeRuns} active runs · {overview.data.health.healthy}/{overview.data.health.total} connected systems healthy</p>
        </div>
        <div className="observe-status-actions">
          {isAdmin && <span className={`live-indicator${(live.data?.counts.total ?? 0) > 0 ? ' is-live' : ''}`}><i />{live.data?.counts.total ?? 0} live</span>}
          <HealthBadge state={overview.data.health.state} />
        </div>
      </section>

      {(overview.data.health.issues?.length ?? 0) > 0 && (
        <section className="observe-health-issues" aria-labelledby="observe-health-issues-title">
          <header>
            <TriangleAlert size={17} />
            <div><b id="observe-health-issues-title">Why Argus is degraded</b><span>Open the affected backend to test its connection or inspect its latest error.</span></div>
          </header>
          <div>
            {overview.data.health.issues?.map(issue => (
              <a href={issue.href} key={issue.id}>
                <i />
                <span><b>{issue.name}</b><small>{issue.error}</small></span>
                <strong>{issue.state}</strong>
              </a>
            ))}
          </div>
        </section>
      )}

      <section className="metric-grid observe-metrics" aria-label="Observability summary">
        <article className="metric-card"><span className="metric-icon violet"><Activity size={17} /></span><div><span>Executions</span><strong>{compactNumber(summary?.totalTraces ?? 0)}</strong><small>{summary?.activeTraces ?? 0} running · {summary?.waitingTraces ?? 0} waiting</small></div></article>
        <article className="metric-card"><span className={`metric-icon ${(summary?.successRate ?? 100) < 90 ? 'red' : 'teal'}`}><CheckCircle2 size={17} /></span><div><span>Success rate</span><strong>{(summary?.successRate ?? 0).toFixed(1)}%</strong><small>{summary?.failedTraces ?? 0} failed in selected window</small></div></article>
        <article className="metric-card"><span className="metric-icon blue"><Timer size={17} /></span><div><span>P95 latency</span><strong>{formatDuration(summary?.p95DurationMs ?? 0)}</strong><small>P50 {formatDuration(summary?.p50DurationMs ?? 0)}</small></div></article>
        <article className="metric-card"><span className="metric-icon amber"><CircleDollarSign size={17} /></span><div><span>Estimated cost</span><strong>{formatCost(summary?.totalCostUsd ?? 0)}</strong><small>provider model pricing</small></div></article>
      </section>

      <section className="observe-signal-strip" aria-label="Execution signals">
        <article><Cpu size={15} /><span><b>{compactNumber((summary?.totalInputTokens ?? 0) + (summary?.totalOutputTokens ?? 0))}</b><small>Total tokens</small></span></article>
        <article><Bot size={15} /><span><b>{compactNumber(summary?.llmCalls ?? 0)}</b><small>LLM calls</small></span></article>
        <article><Wrench size={15} /><span><b>{compactNumber(summary?.toolCalls ?? 0)}</b><small>Tool calls</small></span></article>
        <article><PauseCircle size={15} /><span><b>{(summary?.errorRate ?? 0).toFixed(1)}%</b><small>Error rate</small></span></article>
      </section>

      {analytics.error && <div className="observe-inline-warning"><TriangleAlert size={15} />Native trace analytics are temporarily unavailable. Run data remains current.</div>}

      <div className="observe-insight-grid">
        <section className="panel observe-chart-panel">
          <div className="panel-heading"><div><span className="eyebrow">EXECUTIONS & FAILURES</span><h2>Trace volume</h2></div><small>{summary?.totalTraces ?? 0} executions · {rangeLabel(hours)}</small></div>
          {timeline.length > 0 ? (
            <div className="activity-chart" role="img" aria-label={`Execution volume over the last ${rangeLabel(hours)}`}>
              {timeline.map((point, index) => {
                const totalHeight = Math.max(3, (point.count / maxCalls) * 100);
                const errorHeight = point.count > 0 ? Math.min(100, (point.failed / point.count) * 100) : 0;
                return (
                  <span className="activity-bar-slot" key={`${point.bucket}-${index}`} title={`${new Date(point.bucket).toLocaleString()}: ${point.count} executions, ${point.failed} failed, ${formatCost(point.costUsd)}`}>
                    <i style={{ height: `${totalHeight}%` }}><b style={{ height: `${errorHeight}%` }} /></i>
                  </span>
                );
              })}
            </div>
          ) : <div className="observe-chart-empty"><Gauge size={24} /><span>No native traces in this window</span></div>}
          <div className="chart-legend"><span><i className="legend-volume" />Executions</span><span><i className="legend-error" />Failed</span><time>Updated {timeAgo(analyticsData?.generatedAt ?? overview.data.generatedAt)}</time></div>
        </section>

        <section className="panel observe-model-panel">
          <div className="panel-heading"><div><span className="eyebrow">MODEL ECONOMICS</span><h2>LLM usage</h2></div><small>{summary?.llmCalls ?? 0} calls</small></div>
          {(analyticsData?.models.length ?? 0) > 0 ? (
            <div className="observe-analytics-list">
              {analyticsData?.models.slice(0, 6).map(model => {
                const weight = model.costUsd || model.calls;
                return <div className="observe-analytics-row" key={`${model.provider}-${model.model}`}>
                  <div><b>{model.model}</b><small>{model.provider} · {compactNumber(model.inputTokens + model.outputTokens)} tokens</small></div>
                  <span><i style={{ width: `${Math.max(4, (weight / maxModelWeight) * 100)}%` }} /></span>
                  <strong>{formatCost(model.costUsd)}</strong>
                </div>;
              })}
            </div>
          ) : <div className="observe-mini-empty">No LLM spans recorded yet.</div>}
        </section>
      </div>

      <div className="observe-breakdown-grid">
        <section className="panel top-tools-panel">
          <div className="panel-heading"><div><span className="eyebrow">TOOL RELIABILITY</span><h2>Hot paths</h2></div><small>{summary?.toolCalls ?? 0} calls</small></div>
          {(analyticsData?.tools.length ?? 0) > 0 ? (
            <div className="top-tool-list">
              {analyticsData?.tools.slice(0, 6).map(tool => (
                <div className="top-tool-row" key={tool.tool}>
                  <div><b>{tool.tool}</b><small>P95 {formatDuration(tool.p95DurationMs)} · {tool.failures} failed</small></div>
                  <span><i style={{ width: `${Math.max(4, (tool.calls / maxToolCalls) * 100)}%` }} /></span>
                  <strong>{tool.calls}</strong>
                </div>
              ))}
            </div>
          ) : <div className="observe-mini-empty">No tool spans recorded yet.</div>}
        </section>

        <section className="panel observe-executor-panel">
          <div className="panel-heading"><div><span className="eyebrow">EXECUTOR HEALTH</span><h2>Agents & workflows</h2></div><a href="/runs">All runs</a></div>
          {executors.length > 0 ? <div className="observe-executor-list">
            {executors.map(executor => <div className="observe-executor-row" key={`${executor.kind}-${executor.id}-${executor.name}`}>
              <span className={`run-glyph run-${executor.failures > 0 ? 'failed' : 'completed'}`}>{executor.kind === 'agent' ? <Bot size={14} /> : <Workflow size={14} />}</span>
              <div><b>{executor.name.replaceAll('_', ' ')}</b><small>{executor.executions} runs · P95 {formatDuration(executor.p95DurationMs)}</small></div>
              <strong>{executor.successRate.toFixed(0)}%</strong>
            </div>)}
          </div> : <div className="observe-mini-empty">No executor history recorded yet.</div>}
        </section>
      </div>

      <section className="observe-traces">
        <div className="section-heading-row">
          <div><span className="eyebrow">TRACE EXPLORER</span><h2>Agent & workflow executions</h2><p>Start with a run, then inspect its timeline, tools, approvals and failure point.</p></div>
          <a className="button button-secondary" href="/runs">All runs</a>
        </div>
        <div className="filter-bar observe-trace-filters">
          <div className="segmented-filter" aria-label="Filter traces by status">
            {statuses.map(value => <button className={status === value ? 'is-active' : ''} type="button" key={value} onClick={() => setStatus(value)}>{value}</button>)}
          </div>
          <div className="segmented-filter" aria-label="Filter traces by type">
            {(['all', 'agent', 'workflow'] as TraceKind[]).map(value => <button className={kind === value ? 'is-active' : ''} type="button" key={value} onClick={() => setKind(value)}>{value}</button>)}
          </div>
          <label className="search-field"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Trace ID, agent or workflow" /></label>
        </div>
        <div className="panel table-panel">
          {visibleTraces.length > 0 ? (
            <div className="data-table observe-trace-table">
              <div className="data-row data-head"><span>Execution</span><span>Status</span><span>Duration</span><span>Risk</span><span>Updated</span></div>
              {visibleTraces.map(run => (
                <a className="data-row" href={run.href || `/runs/${run.kind}/${run.id}`} key={`${run.kind}-${run.id}`}>
                  <div className="table-primary"><span className={`run-glyph run-${run.status}`}>{run.kind === 'agent' ? <Bot size={17} /> : <Workflow size={17} />}</span><span><b>{run.title}</b><small>{run.kind} · {run.id} · {run.subtitle}</small></span></div>
                  <StatusBadge status={run.status} />
                  <span>{formatDuration(run.durationMs)}</span>
                  <span className={`trace-risk trace-risk-${run.risk}`}>{run.risk}</span>
                  <time>{timeAgo(run.updatedAt)}</time>
                </a>
              ))}
            </div>
          ) : <div className="observe-mini-empty observe-trace-empty">No traces match this window and filter.</div>}
        </div>
      </section>

      <div className="observe-source-row">
        {isAdmin && <a href="/observe/health"><HeartPulse size={16} /><span><b>Service health</b><small>SLOs, error budget and runtime health</small></span></a>}
        {isAdmin && <a href="/observe/slos"><Target size={16} /><span><b>SLOs</b><small>Component objectives and error budgets</small></span></a>}
        {isAdmin && <a href="/observe/dependencies"><Waypoints size={16} /><span><b>Dependency map</b><small>Configured and observed runtime topology</small></span></a>}
        {isAdmin && <a href="/observe/alerts"><BellRing size={16} /><span><b>Alerts</b><small>Rules, incidents and recoveries</small></span></a>}
        {isAdmin && <a href="/observe/activity"><Radio size={16} /><span><b>Live sessions</b><small>What agents are doing right now</small></span></a>}
        {isAdmin && <a href="/observe/audit"><Gauge size={16} /><span><b>Audit trail</b><small>Who called which capability</small></span></a>}
        <a href="/observe/logs"><Activity size={16} /><span><b>Logs</b><small>Search operational evidence</small></span></a>
      </div>
    </>
  );
}
