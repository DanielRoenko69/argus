import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, ExternalLink, FileSearch, Maximize2, Minimize2, Network, Search, Server, SquareTerminal, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { isPlatformAdminRole } from '../access';
import { getLogIndices, getOverview, getTraceEvidence, searchLogs } from '../api';
import { TraceToEvaluationButton } from '../components/TraceToEvaluationButton';
import { ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { ObserveWorkspaceTabs } from '../features/observe/ObserveWorkspaceTabs';
import type { DistributedTraceRun } from '../types';

interface LogFilters {
  q: string;
  level: string;
  index: string;
  source: string;
  traceId: string;
  rootTraceId: string;
  spanId: string;
  agentId?: number;
  workflowExecutionId?: number;
}
const emptyFilters: LogFilters = {
  q: '', level: '', index: '', source: '', traceId: '', rootTraceId: '', spanId: '',
};

function AgentOutputEvidence({ run }: { run: DistributedTraceRun }) {
  const [expanded, setExpanded] = useState(false);
  const output = run.error || run.outputPreview || '';
  const canExpand = output.length > 400 || output.includes('\n');

  return (
    <details open={run.status === 'failed'}>
      <summary><span><Bot size={14} /></span><b>{run.title}</b><small>{run.taskType || run.subtitle}</small><em className={`state-${run.status}`}>{run.status}</em></summary>
      <pre className={expanded ? 'is-expanded' : undefined}>{output}</pre>
      <footer className="log-agent-evidence-actions">
        {canExpand && (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
            {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            {expanded ? 'Collapse response' : 'Show complete response'}
          </button>
        )}
        {run.href && <a href={run.href}>Open full agent trace <ExternalLink size={11} /></a>}
      </footer>
    </details>
  );
}

export function LogsPage() {
  const [searchParams] = useSearchParams();
  const positiveInteger = (value: string | null): number | undefined => {
    const parsed = value == null ? NaN : Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const initialFilters = {
    ...emptyFilters,
    q: searchParams.get('q') ?? '',
    traceId: searchParams.get('trace') ?? '',
    rootTraceId: searchParams.get('root_trace') ?? '',
    spanId: searchParams.get('span') ?? '',
    agentId: positiveInteger(searchParams.get('agent')),
    workflowExecutionId: positiveInteger(searchParams.get('workflow_execution')),
  };
  const [draft, setDraft] = useState<LogFilters>(initialFilters);
  const [filters, setFilters] = useState<LogFilters>(initialFilters);
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview, staleTime: 15_000 });
  const indices = useQuery({ queryKey: ['log-indices'], queryFn: getLogIndices, staleTime: 60_000 });
  const logs = useQuery({ queryKey: ['logs', filters], queryFn: () => searchLogs(filters), refetchInterval: 15_000 });
  const correlatedTraceId = filters.traceId || filters.rootTraceId;
  const traceEvidence = useQuery({
    queryKey: ['log-trace-evidence', correlatedTraceId],
    queryFn: () => getTraceEvidence(correlatedTraceId),
    enabled: Boolean(correlatedTraceId),
    staleTime: 5_000,
  });
  const correlatedAgentOutputs = (traceEvidence.data?.family?.runs ?? [])
    .filter(run => run.kind === 'agent' && Boolean(run.outputPreview || run.error))
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const submit = (event: FormEvent) => { event.preventDefault(); setFilters(draft); };
  const correlationScope = filters.spanId
    ? { label: 'Span', value: filters.spanId }
    : filters.traceId
      ? { label: 'Trace', value: filters.traceId }
      : filters.rootTraceId
        ? { label: 'Trace family', value: filters.rootTraceId }
        : filters.workflowExecutionId
          ? { label: 'Workflow execution', value: `#${filters.workflowExecutionId}` }
          : filters.agentId
            ? { label: 'Agent', value: `#${filters.agentId}` }
            : null;

  if (logs.isLoading) return <LoadingState label="Searching operational logs…" />;
  if (logs.error) return <ErrorState error={logs.error} />;
  if (!logs.data) return null;

  return (
    <>
      <PageHeader
        eyebrow="OBSERVE · EVIDENCE"
        title="Logs"
        description="Search operational events and correlate request IDs, backends and tools with a failed execution."
        actions={isPlatformAdminRole(overview.data?.user.role)
          ? <a className="button button-secondary" href="/settings/platform?tab=otel"><Server size={15} />Telemetry settings</a>
          : undefined}
      />
      <ObserveWorkspaceTabs active="evidence" section="logs" isAdmin={isPlatformAdminRole(overview.data?.user.role)} />
      {correlationScope && (
        <div className="log-correlation-scope">
          <Network size={15} />
          <span><small>INVESTIGATION SCOPE</small><b><span>{correlationScope.label}</span><code>{correlationScope.value}</code></b></span>
          {correlatedTraceId && traceEvidence.data && <TraceToEvaluationButton traceId={correlatedTraceId} spanId={filters.spanId || null} />}
          <a href="/observe/logs" aria-label="Clear investigation scope"><X size={14} />Clear</a>
        </div>
      )}
      <form className="log-search-panel panel" onSubmit={submit}>
        <label className="log-query"><Search size={17} /><input value={draft.q} onChange={event => setDraft(value => ({ ...value, q: event.target.value }))} placeholder="Search messages and structured data" /></label>
        <label><span>Level</span><select value={draft.level} onChange={event => setDraft(value => ({ ...value, level: event.target.value }))}><option value="">All levels</option><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warning</option><option value="error">Error</option></select></label>
        <label><span>Day</span><select value={draft.index} onChange={event => setDraft(value => ({ ...value, index: event.target.value }))}><option value="">Any day</option>{indices.data?.indices.map(index => <option value={index.name} key={index.name}>{index.name} ({index.doc_count})</option>)}</select></label>
        <label><span>Source</span><input value={draft.source} onChange={event => setDraft(value => ({ ...value, source: event.target.value }))} placeholder="Backend or service" /></label>
        <button className="button button-primary" type="submit"><FileSearch size={15} />Search</button>
      </form>
      {correlatedTraceId && (traceEvidence.isLoading || correlatedAgentOutputs.length > 0) && (
        <section className="panel log-agent-evidence" aria-label="Correlated agent outputs">
          <header>
            <div><span className="eyebrow">TRACE EVIDENCE</span><h2>Agent outputs</h2><p>Redacted responses retained with the correlated workflow trace.</p></div>
            <b>{correlatedAgentOutputs.length}</b>
          </header>
          {traceEvidence.isLoading ? <LoadingState label="Loading correlated agent outputs…" /> : (
            <div>
              {correlatedAgentOutputs.map(run => <AgentOutputEvidence key={run.id} run={run} />)}
            </div>
          )}
        </section>
      )}
      <div className="log-result-heading"><span><b>{logs.data.total}</b> results</span><small>Auto-refreshing every 15 seconds</small></div>
      <section className="panel table-panel">
        <div className="data-table log-table">
          <div className="data-row data-head"><span>Time</span><span>Level</span><span>Event</span><span>Source</span><span>Correlation</span></div>
          {logs.data.hits.map(hit => <div className="data-row" key={hit.id}>
            <time title={new Date(hit['@timestamp']).toLocaleString()}>{timeAgo(hit['@timestamp'])}</time>
            <span className={`log-level log-${hit.level.toLowerCase()}`}>{hit.level}</span>
            <div className="log-message"><SquareTerminal size={15} /><span><b>{hit.message}</b><small>{hit.tool || 'platform event'}</small></span></div>
            <span>{hit.backend || 'argus'}</span>
            <div className="log-correlation-id">
              {hit.trace_id
                ? <a href={`/observe/logs?trace=${encodeURIComponent(hit.trace_id)}`} title={hit.trace_id}>Trace {hit.trace_id.slice(0, 8)}…</a>
                : <span>Trace —</span>}
              <code title={hit.span_id || hit.req_id || undefined}>
                {hit.span_id ? `Span ${hit.span_id.slice(0, 8)}…` : hit.req_id ? `Req ${hit.req_id.slice(0, 8)}…` : 'No child ID'}
              </code>
            </div>
          </div>)}
          {logs.data.hits.length === 0 && <div className="observe-mini-empty observe-trace-empty">No logs match this query.</div>}
        </div>
      </section>
    </>
  );
}
