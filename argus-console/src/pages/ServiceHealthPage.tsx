import { useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BellRing,
  Bot,
  CheckCircle2,
  CirclePlay,
  CircleDollarSign,
  Database,
  Gauge,
  GitBranch,
  KeyRound,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  ServerCog,
  Settings2,
  ShieldAlert,
  Target,
  TimerReset,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import { getCiProviderCanaries, getNativeServiceHealth, getOverview, getSyntheticCanaries, runCiProviderCanaries as runLiveCiProviderCanaries, runSyntheticCanaries, saveSyntheticCanaryConfig } from '../api';
import { isPlatformAdminRole } from '../access';
import { EmptyState, ErrorState, formatDuration, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { ObserveWorkspaceTabs } from '../features/observe/ObserveWorkspaceTabs';
import type { CiProviderCanaryOperationsResponse, CiProviderCanaryStatus, NativeServiceHealthState, SyntheticCanaryConfigMutation, SyntheticCanaryOperationsResponse, SyntheticCanaryStatus } from '../types';

const ranges = [1, 6, 24, 168] as const;
type ComponentFilter = 'all' | 'agent' | 'workflow' | 'model' | 'tool';

const stateLabels: Record<NativeServiceHealthState, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  critical: 'Critical',
  no_data: 'No data',
};

function rangeLabel(hours: number): string {
  return hours === 1 ? '1h' : hours === 168 ? '7d' : `${hours}h`;
}

function timeUntil(value: string): string {
  const milliseconds = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 30_000) return 'due now';
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.ceil(hours / 24)}d`;
}

function kindIcon(kind: Exclude<ComponentFilter, 'all'>) {
  if (kind === 'agent') return <Bot size={14} />;
  if (kind === 'workflow') return <GitBranch size={14} />;
  if (kind === 'model') return <ServerCog size={14} />;
  return <Wrench size={14} />;
}

const canaryStateLabels: Record<SyntheticCanaryOperationsResponse['state']['status'], string> = {
  disabled: 'Scheduler disabled',
  not_configured: 'Credential required',
  no_data: 'Waiting for first run',
  healthy: 'All targets passing',
  degraded: 'Failures detected',
  running: 'Run in progress',
};

const canaryStatusLabels: Record<SyntheticCanaryStatus, string> = {
  ok: 'Passed', failed: 'Failed', timeout: 'Timeout', error: 'Error',
};

function CanaryOperations({
  data,
  busy,
  error,
  onRun,
  onSave,
}: {
  data: SyntheticCanaryOperationsResponse;
  busy: boolean;
  error: string | null;
  onRun: (agentIds?: number[]) => void;
  onSave: (input: SyntheticCanaryConfigMutation) => void;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const [draft, setDraft] = useState<SyntheticCanaryConfigMutation>({
    enabled: data.config.enabled,
    intervalMinutes: data.config.intervalMinutes,
    timeoutSeconds: data.config.timeoutSeconds,
    retentionDays: data.config.retentionDays,
    agentIds: data.config.agentIds,
  });
  const openConfig = () => {
    setDraft({
      enabled: data.config.enabled,
      intervalMinutes: data.config.intervalMinutes,
      timeoutSeconds: data.config.timeoutSeconds,
      retentionDays: data.config.retentionDays,
      agentIds: data.config.agentIds,
    });
    setConfigOpen(true);
  };
  const toggleAgent = (id: number) => setDraft(current => ({
    ...current,
    agentIds: current.agentIds.includes(id) ? current.agentIds.filter(agentId => agentId !== id) : [...current.agentIds, id],
  }));
  const stateClass = data.state.status === 'healthy' ? 'ok'
    : data.state.status === 'degraded' || data.state.status === 'not_configured' ? 'failed'
      : data.state.status === 'running' ? 'running' : 'neutral';

  return <section className="panel canary-operations">
    <div className="canary-operations-heading">
      <span className={`canary-radar is-${stateClass}`}><RadioTower size={19} /></span>
      <div><span className="eyebrow">SYNTHETIC ASSURANCE</span><h2>Agent canaries</h2><p>Low-volume probes through the real Agent Chat path, including model credentials and runtime policy.</p></div>
      <span className={`canary-state is-${stateClass}`}><i />{canaryStateLabels[data.state.status]}</span>
      <div className="canary-actions"><button className="button button-secondary" type="button" onClick={openConfig}><Settings2 size={14} />Configure</button><button className="button button-primary" type="button" disabled={busy || !data.config.credentialConfigured || data.state.totalTargets === 0} onClick={() => onRun()}><CirclePlay size={14} />{busy ? 'Running…' : 'Run now'}</button></div>
    </div>

    {!data.config.credentialConfigured && <div className="canary-warning"><KeyRound size={16} /><span><b>Dedicated credential required</b><small>Set <code>CANARIES_API_KEY</code> in the deployment. Secrets are never stored in this dashboard.</small></span></div>}
    {error && <div className="connection-notice is-error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}

    <div className="canary-metric-strip">
      <div><span><Target size={14} />Targets</span><strong>{data.state.totalTargets}</strong><small>{data.config.targetMode === 'automatic' ? 'all enabled chat agents' : 'selected agents'}</small></div>
      <div><span><CheckCircle2 size={14} />Passing</span><strong>{data.state.passingTargets}</strong><small>{data.state.failingTargets} currently failing</small></div>
      <div><span><TimerReset size={14} />Schedule</span><strong>{data.config.enabled ? `${data.config.intervalMinutes}m` : 'Off'}</strong><small>{data.state.nextRunAt ? `next ${timeUntil(data.state.nextRunAt)}` : 'manual runs remain available'}</small></div>
      <div><span><Database size={14} />Evidence</span><strong>{data.history.length}</strong><small>{data.config.retentionDays} day retention</small></div>
    </div>

    <div className="canary-workspace">
      <div className="canary-targets">
        <div className="canary-section-heading"><div><span className="eyebrow">24H TARGET HEALTH</span><h3>Configured runtime probes</h3></div><small>{data.state.lastRunAt ? `last run ${timeAgo(data.state.lastRunAt)}` : 'not run yet'}</small></div>
        {data.canaries.length ? <div className="canary-target-grid">{data.canaries.map(canary => <article className={`canary-target is-${canary.lastStatus ?? 'unknown'}`} key={canary.agentId}>
          <header><span><Bot size={14} /></span><div><b>{canary.agentName}</b><small>Agent #{canary.agentId}</small></div><em>{canary.lastStatus ? canaryStatusLabels[canary.lastStatus] : 'No data'}</em></header>
          <dl><div><dt>Success</dt><dd>{canary.successRate.toFixed(1)}%</dd></div><div><dt>P95</dt><dd>{formatDuration(canary.p95LatencyMs)}</dd></div><div><dt>Runs</dt><dd>{canary.total}</dd></div></dl>
          <footer><small>{canary.lastAt ? timeAgo(canary.lastAt) : 'Never executed'}</small><button type="button" disabled={busy || !data.config.credentialConfigured} onClick={() => onRun([canary.agentId])}><CirclePlay size={12} />Run target</button></footer>
        </article>)}</div> : <EmptyState title="No Canary evidence yet" description={data.state.totalTargets ? 'Run the configured targets once or enable the scheduler.' : 'Enable at least one chat Agent before configuring synthetic probes.'} />}
      </div>

      <div className="canary-history">
        <div className="canary-section-heading"><div><span className="eyebrow">RECENT EXECUTIONS</span><h3>Persistent run evidence</h3></div><small>response content excluded</small></div>
        {data.history.length ? <div className="canary-history-list">{data.history.slice(0, 12).map(run => <div key={run.id}>
          <span className={`canary-result is-${run.status}`}><i />{canaryStatusLabels[run.status]}</span>
          <span><b>{run.agentName}</b><small>{run.source}{run.triggeredBy ? ` · ${run.triggeredBy}` : ''}</small></span>
          <span><b>{formatDuration(run.latencyMs)}</b><small>{timeAgo(run.completedAt)}</small></span>
          <em title={run.errorMessage}>{run.errorMessage || '—'}</em>
        </div>)}</div> : <div className="observe-mini-empty">No persisted Canary executions.</div>}
      </div>
    </div>

    {configOpen && <form className="canary-config" onSubmit={event => { event.preventDefault(); onSave(draft); setConfigOpen(false); }}>
      <div className="canary-config-heading"><div><span className="eyebrow">RUNTIME CONFIGURATION</span><h3>Canary schedule and targets</h3><p>Manual and scheduled probes call real providers and may incur model usage costs.</p></div><button type="button" aria-label="Close Canary configuration" onClick={() => setConfigOpen(false)}><X size={15} /></button></div>
      <label className="canary-enable"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))} /><span><b>Enable scheduled probes</b><small>Manual runs remain possible while the scheduler is disabled.</small></span></label>
      <div className="canary-config-fields">
        <label><span>Interval</span><div><input aria-label="Canary interval minutes" type="number" min={5} max={1440} value={draft.intervalMinutes} onChange={event => setDraft(current => ({ ...current, intervalMinutes: Number(event.target.value) }))} /><small>minutes</small></div></label>
        <label><span>Timeout</span><div><input aria-label="Canary timeout seconds" type="number" min={5} max={120} value={draft.timeoutSeconds} onChange={event => setDraft(current => ({ ...current, timeoutSeconds: Number(event.target.value) }))} /><small>seconds</small></div></label>
        <label><span>Evidence retention</span><div><input aria-label="Canary retention days" type="number" min={1} max={90} value={draft.retentionDays} onChange={event => setDraft(current => ({ ...current, retentionDays: Number(event.target.value) }))} /><small>days</small></div></label>
      </div>
      <div className="canary-agent-selection"><header><div><b>Target Agents</b><small>Leave the selection empty to automatically probe every enabled chat Agent.</small></div>{draft.agentIds.length > 0 && <button type="button" onClick={() => setDraft(current => ({ ...current, agentIds: [] }))}><RefreshCw size={12} />Use automatic discovery</button>}</header><div>{data.availableAgents.map(agent => <label className={draft.agentIds.includes(agent.id) ? 'is-selected' : ''} key={agent.id}><input type="checkbox" checked={draft.agentIds.includes(agent.id)} onChange={() => toggleAgent(agent.id)} /><Bot size={13} /><span><b>{agent.label}</b><small>{agent.name}</small></span></label>)}</div></div>
      <footer><span><KeyRound size={13} />Credential {data.config.credentialConfigured ? 'configured in deployment' : 'missing'}</span><div><button className="button button-secondary" type="button" onClick={() => setConfigOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}>Save configuration</button></div></footer>
    </form>}
  </section>;
}

const ciCanaryStatusLabels: Record<CiProviderCanaryStatus, string> = {
  ok: 'Passed', failed: 'Failed', timeout: 'Timeout', error: 'Error',
};

function CiProviderCanaryOperations({
  data,
  busy,
  error,
  onRun,
}: {
  data: CiProviderCanaryOperationsResponse;
  busy: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const stateClass = data.state.status === 'healthy' ? 'ok' : data.state.status === 'degraded' ? 'failed' : 'neutral';
  return <section className="panel ci-provider-canaries">
    <div className="ci-provider-canaries-heading">
      <span className={`canary-radar is-${stateClass}`}><ShieldCheck size={19} /></span>
      <div><span className="eyebrow">EXTERNAL CI ASSURANCE</span><h2>CI provider canaries</h2><p>Read-only checks against explicitly configured staging runs. Tokens stay inside LangGraph and are never persisted.</p></div>
      <span className={`canary-state is-${stateClass}`}><i />{data.state.status === 'healthy' ? 'All checks passing' : data.state.status === 'degraded' ? 'Failures detected' : 'No evidence yet'}</span>
      <button className="button button-secondary" type="button" disabled={busy} onClick={onRun}><CirclePlay size={14} />{busy ? 'Running…' : 'Run canaries'}</button>
    </div>
    {error && <div className="connection-notice is-error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
    <div className="canary-metric-strip">
      <div><span><Target size={14} />Checks</span><strong>{data.state.totalRuns}</strong><small>persisted evidence</small></div>
      <div><span><CheckCircle2 size={14} />Passing</span><strong>{data.state.passingRuns}</strong><small>{data.state.failingRuns} failed or timed out</small></div>
      <div><span><TimerReset size={14} />Last run</span><strong>{data.state.lastRunAt ? timeAgo(data.state.lastRunAt) : '—'}</strong><small>read-only provider probes</small></div>
      <div><span><Database size={14} />Retention</span><strong>100</strong><small>latest records</small></div>
    </div>
    {data.history.length ? <div className="ci-provider-canary-history">{data.history.slice(0, 12).map(run => <div key={run.id}>
      <span className={`canary-result is-${run.status}`}><i />{ciCanaryStatusLabels[run.status]}</span>
      <span><b>{run.provider}</b><small>run {run.externalId} · {run.source}</small></span>
      <span><b>{run.httpStatus ?? '—'}</b><small>{formatDuration(run.latencyMs)}</small></span>
      <em title={run.errorMessage ?? run.providerStatus ?? undefined}>{run.errorMessage ?? run.providerStatus ?? '—'}</em>
    </div>)}</div> : <div className="observe-mini-empty ci-provider-canary-empty">No provider evidence yet. Configure <code>ARGUS_CI_CANARIES_*</code> in LangGraph and run the check.</div>}
  </section>;
}

export function ServiceHealthPage() {
  const queryClient = useQueryClient();
  const [hours, setHours] = useState<(typeof ranges)[number]>(24);
  const [filter, setFilter] = useState<ComponentFilter>('all');
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview });
  const isAdmin = isPlatformAdminRole(overview.data?.user.role);
  const health = useQuery({
    queryKey: ['native-service-health', hours],
    queryFn: () => getNativeServiceHealth(hours),
    refetchInterval: 30_000,
  });
  const canaries = useQuery({
    queryKey: ['synthetic-canaries'],
    queryFn: getSyntheticCanaries,
    enabled: isAdmin,
    refetchInterval: 15_000,
  });
  const ciCanaries = useQuery({
    queryKey: ['ci-provider-canaries'],
    queryFn: getCiProviderCanaries,
    enabled: isAdmin,
    refetchInterval: 30_000,
  });
  const runCanaries = useMutation({
    mutationFn: (agentIds?: number[]) => runSyntheticCanaries(agentIds),
    onSuccess: result => queryClient.setQueryData(['synthetic-canaries'], result.operations),
  });
  const saveCanaryConfig = useMutation({
    mutationFn: (input: SyntheticCanaryConfigMutation) => saveSyntheticCanaryConfig(input),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['synthetic-canaries'] }); },
  });
  const runCiCanaries = useMutation({
    mutationFn: runLiveCiProviderCanaries,
    onSuccess: result => queryClient.setQueryData(['ci-provider-canaries'], result.operations),
  });
  const components = useMemo(
    () => (health.data?.components ?? []).filter(component => filter === 'all' || component.kind === filter),
    [filter, health.data?.components],
  );

  if (overview.isLoading || health.isLoading) return <LoadingState label="Calculating native service health…" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  if (!isAdmin) return <div className="state-panel state-error" role="alert"><TriangleAlert size={22} /><div><b>Platform administrator access required</b><span>Service Health combines cross-platform traces, costs, and incidents.</span></div></div>;
  if (health.error) return <ErrorState error={health.error} />;
  if (!health.data) return null;
  const data = health.data;

  return (
    <>
      <PageHeader
        eyebrow="OBSERVE · HEALTH"
        title="Service health"
        description="A native operational view of reliability, latency, error budget and active incidents."
        actions={<div className="observe-range" aria-label="Service health time range">{ranges.map(value => <button type="button" className={hours === value ? 'is-active' : ''} key={value} onClick={() => setHours(value)}>{rangeLabel(value)}</button>)}</div>}
      />

      <ObserveWorkspaceTabs active="health" section="service-health" isAdmin={isAdmin} />

      <section className={`service-health-hero health-state-${data.state}`}>
        <div className="service-health-score" style={{ '--health-score': `${data.score ?? 0}%` } as CSSProperties}>
          <div><strong>{data.score ?? '—'}</strong><small>health score</small></div>
        </div>
        <div className="service-health-copy">
          <span className={`service-health-state state-${data.state}`}><i />{stateLabels[data.state]}</span>
          <h2>{data.state === 'healthy' ? 'Objectives are within target' : data.state === 'no_data' ? 'Waiting for execution evidence' : 'Operational attention is required'}</h2>
          <p>Computed from native traces and persistent incidents over the last {rangeLabel(data.hours)}. Updated {timeAgo(data.generatedAt)}.</p>
        </div>
        <dl>
          <div><dt>Executions</dt><dd>{data.summary.totalExecutions}</dd></div>
          <div><dt>Success</dt><dd>{data.summary.successRate.toFixed(1)}%</dd></div>
          <div><dt>P95 latency</dt><dd>{formatDuration(data.summary.p95DurationMs)}</dd></div>
          <div><dt>Open incidents</dt><dd>{data.summary.firingIncidents}</dd></div>
        </dl>
      </section>

      <section className="service-health-metrics">
        <article className="panel error-budget-card">
          <div className="panel-heading"><div><span className="eyebrow">RELIABILITY</span><h2>Error budget</h2></div><span className={`slo-state is-${data.errorBudget.state}`}>{data.errorBudget.state.replace('_', ' ')}</span></div>
          <div className="error-budget-value"><strong>{data.errorBudget.remainingPercent.toFixed(0)}%</strong><span>remaining</span></div>
          <div className="error-budget-track"><i style={{ width: `${data.errorBudget.remainingPercent}%` }} /></div>
          <footer><span>{data.errorBudget.actualFailures} actual failures</span><span>{data.errorBudget.allowedFailures.toFixed(1)} allowed at {data.errorBudget.objective}%</span></footer>
        </article>
        <article className="panel service-cost-card">
          <span><CircleDollarSign size={19} /></span><div><small>Attributed model cost</small><strong>${data.summary.totalCostUsd.toFixed(data.summary.totalCostUsd < 1 ? 4 : 2)}</strong><p>Across the selected native trace window.</p></div>
        </article>
        <article className={`panel service-incident-card ${data.summary.criticalIncidents ? 'has-critical' : ''}`}>
          <span>{data.summary.criticalIncidents ? <ShieldAlert size={19} /> : <CheckCircle2 size={19} />}</span><div><small>Critical incidents</small><strong>{data.summary.criticalIncidents}</strong><p>{data.summary.criticalIncidents ? 'Immediate investigation recommended.' : 'No critical incident is currently open.'}</p></div>
        </article>
      </section>

      {canaries.isLoading ? <section className="panel"><LoadingState label="Loading synthetic Canary operations…" /></section>
        : canaries.error ? <section className="panel"><ErrorState error={canaries.error} /></section>
          : canaries.data ? <CanaryOperations
            data={canaries.data}
            busy={runCanaries.isPending || saveCanaryConfig.isPending}
            error={runCanaries.error?.message ?? saveCanaryConfig.error?.message ?? null}
            onRun={agentIds => { runCanaries.reset(); runCanaries.mutate(agentIds); }}
            onSave={input => { saveCanaryConfig.reset(); saveCanaryConfig.mutate(input); }}
          /> : null}

      {ciCanaries.isLoading ? <section className="panel"><LoadingState label="Loading CI provider evidence…" /></section>
        : ciCanaries.error ? <section className="panel"><ErrorState error={ciCanaries.error} /></section>
          : ciCanaries.data ? <CiProviderCanaryOperations
            data={ciCanaries.data}
            busy={runCiCanaries.isPending}
            error={runCiCanaries.error?.message ?? null}
            onRun={() => { runCiCanaries.reset(); runCiCanaries.mutate(); }}
          /> : null}

      <section className="service-slo-grid" aria-label="Service level objectives">
        {data.slos.map(slo => <article className={`panel service-slo-card slo-${slo.state}`} key={slo.id}>
          <header><span>{slo.id === 'reliability' ? <Target size={16} /> : slo.id === 'latency' ? <Gauge size={16} /> : <BellRing size={16} />}</span><em className={`slo-state is-${slo.state}`}>{slo.state.replace('_', ' ')}</em></header>
          <h3>{slo.name}</h3><p>{slo.description}</p>
          <dl><div><dt>Objective</dt><dd>{slo.target}</dd></div><div><dt>Actual</dt><dd>{slo.actual}</dd></div></dl>
        </article>)}
      </section>

      <section className="panel service-custom-slos">
        <div className="panel-heading"><div><span className="eyebrow">CONFIGURED OBJECTIVES</span><h2>Component SLOs</h2></div><a href="/observe/slos">Manage objectives</a></div>
        <div>{data.customSlos.slice(0, 6).map(slo => <a href="/observe/slos" key={slo.id}>
          <span className={`slo-state is-${slo.evaluation.state}`}>{slo.evaluation.state.replace('_', ' ')}</span>
          <div><b>{slo.name}</b><small>{slo.scopeKind === 'all' ? 'All executions' : `${slo.scopeKind} · ${slo.scopeValue}`} · {slo.evaluation.sampleCount} samples</small></div>
          <strong>{slo.evaluation.actual == null ? '—' : slo.metric === 'success_rate' ? `${slo.evaluation.actual.toFixed(1)}%` : formatDuration(slo.evaluation.actual)}</strong>
        </a>)}</div>
      </section>

      <div className="service-health-workspace">
        <section className="panel service-component-panel">
          <div className="panel-heading"><div><span className="eyebrow">COMPONENTS</span><h2>Health by runtime surface</h2></div><small>{components.length} visible</small></div>
          <div className="service-component-filters" role="group" aria-label="Component type">
            {(['all', 'agent', 'workflow', 'model', 'tool'] as const).map(value => <button type="button" className={filter === value ? 'is-active' : ''} key={value} onClick={() => setFilter(value)}>{value}</button>)}
          </div>
          {components.length > 0 ? <div className="service-component-table">
            <div className="service-component-row table-head"><span>Component</span><span>State</span><span>Success</span><span>P95</span><span>Volume</span></div>
            {components.map(component => <div className="service-component-row" key={component.id}>
              <span className="component-identity"><i>{kindIcon(component.kind)}</i><span><b>{component.name}</b><small>{component.detail}</small></span></span>
              <span><em className={`service-health-state state-${component.state}`}><i />{stateLabels[component.state]}</em></span>
              <strong>{component.successRate.toFixed(1)}%</strong>
              <strong>{formatDuration(component.p95DurationMs)}</strong>
              <strong>{component.executions} <small>· {component.failures} failed</small></strong>
            </div>)}
          </div> : <div className="observe-mini-empty">No components match this filter.</div>}
        </section>

        <aside className="service-health-aside">
          <section className="panel service-recommendations">
            <div className="panel-heading"><div><span className="eyebrow">NEXT ACTION</span><h2>Recommendations</h2></div></div>
            {data.recommendations.map((item, index) => <a href={item.href} className={`service-recommendation is-${item.severity}`} key={`${item.title}-${index}`}>
              <span>{item.severity === 'critical' ? <ShieldAlert size={15} /> : item.severity === 'warning' ? <TriangleAlert size={15} /> : <CheckCircle2 size={15} />}</span>
              <div><b>{item.title}</b><small>{item.description}</small></div>
            </a>)}
          </section>
          <section className="panel service-open-incidents">
            <div className="panel-heading"><div><span className="eyebrow">INCIDENTS</span><h2>Open now</h2></div><a href="/observe/alerts">Manage</a></div>
            {data.openIncidents.length > 0 ? data.openIncidents.slice(0, 5).map(incident => <a href="/observe/alerts" key={incident.id}><span className={`severity-${incident.severity}`}><Activity size={13} /></span><div><b>{incident.ruleName}</b><small>{incident.severity} · opened {timeAgo(incident.triggeredAt)}</small></div></a>) : <div className="service-calm"><CheckCircle2 size={20} /><span><b>No open incidents</b><small>The native alert engine is calm.</small></span></div>}
          </section>
        </aside>
      </div>
    </>
  );
}
