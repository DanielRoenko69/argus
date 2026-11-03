import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  AlertTriangle,
  Activity,
  Bot,
  Boxes,
  CheckCircle2,
  GitBranch,
  History,
  Network,
  Plus,
  Search,
  ShieldCheck,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import { getRuns, getWorkflowAgentPreflight, getWorkflows } from '../api';
import { EmptyState, ErrorState, formatDuration, LoadingState, PageHeader, StatusBadge, timeAgo } from '../components/Ui';
import type { RunStatus, WorkflowAgentPreflight, WorkflowSummary } from '../types';

type WorkflowFilter = 'all' | 'enabled' | 'oversight';
type WorkflowView = 'catalog' | 'runs';
type RunFilter = 'all' | RunStatus;

export function WorkflowsPage() {
  const [filter, setFilter] = useState<WorkflowFilter>('all');
  const [runFilter, setRunFilter] = useState<RunFilter>('all');
  const [search, setSearch] = useState('');
  const [preflights, setPreflights] = useState<Record<number, WorkflowAgentPreflight>>({});
  const [checkingWorkflowId, setCheckingWorkflowId] = useState<number | null>(null);
  const [preflightErrors, setPreflightErrors] = useState<Record<number, string>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const view: WorkflowView = searchParams.get('view') === 'runs' ? 'runs' : 'catalog';
  const query = useQuery({ queryKey: ['workflows'], queryFn: getWorkflows, staleTime: 10_000 });
  const runsQuery = useQuery({
    queryKey: ['runs', 'workflow-catalog'],
    queryFn: getRuns,
    enabled: view === 'runs',
    refetchInterval: 10_000,
  });
  const scopedBundleIds = useMemo(() => {
    const ids = (searchParams.get('bundles') ?? '')
      .split(',')
      .map(value => Number(value))
      .filter(value => Number.isSafeInteger(value) && value > 0);
    return [...new Set(ids)];
  }, [searchParams]);

  const workflows = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (query.data ?? []).filter(workflow => {
      if (filter === 'enabled' && !workflow.enabled) return false;
      if (filter === 'oversight' && !workflow.human_oversight_required) return false;
      if (scopedBundleIds.length > 0 && !workflow.bundle_ids.some(id => scopedBundleIds.includes(id))) return false;
      return !normalized
        || `${workflow.name} ${workflow.description} ${(workflow.tags ?? []).join(' ')}`.toLowerCase().includes(normalized);
    });
  }, [filter, query.data, scopedBundleIds, search]);

  const workflowRuns = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (runsQuery.data?.runs ?? []).filter(run => {
      if (run.kind !== 'workflow') return false;
      if (runFilter !== 'all' && run.status !== runFilter) return false;
      return !normalized || `${run.title} ${run.subtitle} ${run.id}`.toLowerCase().includes(normalized);
    });
  }, [runFilter, runsQuery.data, search]);

  if (query.isLoading) return <LoadingState label="Loading workflow catalog…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (view === 'runs' && runsQuery.error) return <ErrorState error={runsQuery.error} />;

  const allWorkflows = query.data ?? [];
  const enabledCount = allWorkflows.filter(workflow => workflow.enabled).length;
  const oversightCount = allWorkflows.filter(workflow => workflow.human_oversight_required).length;
  const totalSteps = allWorkflows.reduce((sum, workflow) => sum + workflow.steps.length, 0);

  const setView = (nextView: WorkflowView) => setSearchParams(params => {
    const next = new URLSearchParams(params);
    if (nextView === 'runs') next.set('view', 'runs'); else next.delete('view');
    return next;
  });

  const approvalPosture = (workflow: WorkflowSummary): { label: string; className: string } => {
    const hasCheckpoint = workflow.steps.some(step => step.type === 'argus.approval');
    if (hasCheckpoint && workflow.human_oversight_required) return { label: 'Strict', className: 'is-strict' };
    if (hasCheckpoint) return { label: 'Checkpointed', className: 'is-checkpointed' };
    if (workflow.human_oversight_required) return { label: 'Guarded writes', className: 'is-guarded' };
    return { label: 'Autonomous', className: 'is-autonomous' };
  };

  const roleCount = (workflow: WorkflowSummary) => {
    if ((workflow.agent_requirements ?? []).length > 0) return workflow.agent_requirements!.length;
    return new Set(workflow.steps
      .filter(step => step.type === 'argus.agent')
      .map(step => step.agent_role ?? (step.agent_id ? `agent-${step.agent_id}` : step.id))).size;
  };

  const checkAgents = async (workflowId: number) => {
    setCheckingWorkflowId(workflowId);
    setPreflightErrors(current => ({ ...current, [workflowId]: '' }));
    try {
      const preflight = await getWorkflowAgentPreflight(workflowId);
      setPreflights(current => ({ ...current, [workflowId]: preflight }));
    } catch (error) {
      setPreflightErrors(current => ({
        ...current,
        [workflowId]: error instanceof Error ? error.message : 'Agent preflight failed',
      }));
    } finally {
      setCheckingWorkflowId(current => current === workflowId ? null : current);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="BUILD"
        title="Workflows"
        description="Browse the automation catalog, understand its execution boundaries and open a workflow in the visual builder."
        actions={(
          <>
            <button className="button button-secondary" type="button" onClick={() => setView(view === 'runs' ? 'catalog' : 'runs')}>
              <History size={16} />{view === 'runs' ? 'Workflow catalog' : 'Run log'}
            </button>
            <a className="button button-primary" href="/build/workflows/studio"><Plus size={16} />New workflow</a>
          </>
        )}
      />

      <section className="metric-grid build-metrics" aria-label="Workflow summary">
        <article className="metric-card">
          <span className="metric-icon violet"><Workflow size={17} /></span>
          <div><span>Workflows</span><strong>{allWorkflows.length}</strong><small>visible in your scope</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon teal"><GitBranch size={17} /></span>
          <div><span>Enabled</span><strong>{enabledCount}</strong><small>ready for execution</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon blue"><Boxes size={17} /></span>
          <div><span>Workflow steps</span><strong>{totalSteps}</strong><small>across the catalog</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon amber"><ShieldCheck size={17} /></span>
          <div><span>Human oversight</span><strong>{oversightCount}</strong><small>guarded workflows</small></div>
        </article>
      </section>

      <nav className="workflow-catalog-tabs" aria-label="Workflow workspace views">
        <button className={view === 'catalog' ? 'is-active' : ''} type="button" onClick={() => setView('catalog')}>
          <Workflow size={16} /><span><b>Workflow catalog</b><small>Design and configure automations</small></span>
        </button>
        <button className={view === 'runs' ? 'is-active' : ''} type="button" onClick={() => setView('runs')}>
          <History size={16} /><span><b>Run log</b><small>Inspect steps, hooks and runtime evidence</small></span>
        </button>
      </nav>

      {view === 'runs' ? (
        <>
          <div className="build-toolbar">
            <div className="segmented-filter" aria-label="Filter workflow runs">
              {(['all', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as RunFilter[]).map(value => (
                <button className={runFilter === value ? 'is-active' : ''} type="button" key={value} onClick={() => setRunFilter(value)}>{value}</button>
              ))}
            </div>
            <label className="search-field">
              <Search size={16} />
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search workflow runs" />
            </label>
          </div>

          <section className="panel workflow-run-log" aria-label="Workflow run log">
            {runsQuery.isLoading ? <LoadingState label="Loading workflow runsâ€¦" /> : workflowRuns.length > 0 ? (
              <div className="workflow-run-log-list">
                {workflowRuns.map(run => {
                  const inspectHref = run.workflowHref || (run.workflowId && run.numericId
                    ? `/build/workflows/studio/${run.workflowId}?execution=${run.numericId}`
                    : run.href || '/runs');
                  return (
                    <article className={`workflow-run-log-row is-${run.status}`} key={run.id}>
                      <a className="workflow-run-log-main" href={inspectHref}>
                        <span className={`run-glyph run-${run.status}`}><Activity size={17} /></span>
                        <span><b>{run.title}</b><small>{run.subtitle} · Execution #{run.id}</small></span>
                        <StatusBadge status={run.status} />
                        <span>{formatDuration(run.durationMs)}</span>
                        <time>{timeAgo(run.updatedAt)}</time>
                        <ArrowRight size={14} />
                      </a>
                      <footer>
                        <span>{run.error || 'Persisted workflow execution evidence'}</span>
                        {run.href && <a href={run.href}>Full run detail <ArrowRight size={12} /></a>}
                      </footer>
                    </article>
                  );
                })}
              </div>
            ) : <EmptyState title="No matching workflow runs" description="Change the filter or execute a workflow from the visual builder." />}
          </section>
        </>
      ) : (
        <>

      <div className="build-toolbar">
        <div className="segmented-filter" aria-label="Filter workflows">
          <button className={filter === 'all' ? 'is-active' : ''} type="button" onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'enabled' ? 'is-active' : ''} type="button" onClick={() => setFilter('enabled')}>Enabled</button>
          <button className={filter === 'oversight' ? 'is-active' : ''} type="button" onClick={() => setFilter('oversight')}>Human oversight</button>
        </div>
        <label className="search-field">
          <Search size={16} />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search workflows and tags" />
        </label>
      </div>

      {scopedBundleIds.length > 0 && (
        <div className="workflow-impact-scope" role="status">
          <span><Boxes size={15} /><b>Bundle impact</b> · showing workflows connected to {scopedBundleIds.length} access {scopedBundleIds.length === 1 ? 'bundle' : 'bundles'}</span>
          <button type="button" onClick={() => setSearchParams(params => {
            const next = new URLSearchParams(params);
            next.delete('bundles');
            return next;
          })}>Clear scope</button>
        </div>
      )}

      {workflows.length > 0 ? (
        <section className="build-card-grid workflow-card-grid" aria-label="Workflows">
          {workflows.map(workflow => (
            <article className={`build-card workflow-card ${preflights[workflow.id] ? 'is-contract-open' : ''}`} key={workflow.id}>
              <div className="build-card-head">
                <span className="workflow-avatar"><Workflow size={20} /></span>
                <div className="build-card-badges">
                  <span className={`workflow-state ${workflow.enabled ? 'is-enabled' : 'is-disabled'}`}><i />{workflow.enabled ? 'Enabled' : 'Disabled'}</span>
                  <span className={`capability-badge ${approvalPosture(workflow).className}`}>
                    {approvalPosture(workflow).className === 'is-autonomous' ? <Activity size={11} /> : <ShieldCheck size={11} />}
                    {approvalPosture(workflow).label}
                  </span>
                </div>
              </div>
              <div className="build-card-title">
                <small>{workflow.source || 'visual'} workflow</small>
                <h2>{workflow.name}</h2>
                <p>{workflow.description || 'No workflow description provided yet.'}</p>
              </div>
              <div className="workflow-facts">
                <span><GitBranch size={14} /><b>{workflow.steps.length}</b> steps</span>
                <span><Network size={14} /><b>{workflow.bundle_ids.length}</b> bundles</span>
                <span><Bot size={14} /><b>{roleCount(workflow)}</b> agent roles</span>
                <span>Updated {timeAgo(workflow.updated_at)}</span>
              </div>
              {(workflow.tags ?? []).length > 0 && (
                <div className="workflow-tags">
                  {(workflow.tags ?? []).slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}
                </div>
              )}
              <div className="workflow-agent-contract">
                <div className="workflow-agent-contract-head">
                  <div>
                    <small>AGENT CONTRACT</small>
                    <strong>{preflights[workflow.id]
                      ? preflights[workflow.id].ready ? 'Ready for execution' : 'Execution blocked'
                      : roleCount(workflow) > 0 ? 'Readiness not checked' : 'No Agent roles required'}</strong>
                  </div>
                  <button
                    type="button"
                    onClick={() => void checkAgents(workflow.id)}
                    disabled={checkingWorkflowId === workflow.id}
                  >
                    <RefreshCw size={13} className={checkingWorkflowId === workflow.id ? 'is-spinning' : ''} />
                    {checkingWorkflowId === workflow.id ? 'Checking' : 'Check agents'}
                  </button>
                </div>
                {preflightErrors[workflow.id] && (
                  <p className="workflow-agent-error"><AlertTriangle size={14} />{preflightErrors[workflow.id]}</p>
                )}
                {preflights[workflow.id] && (
                  <div className="workflow-agent-matrix" data-ready={preflights[workflow.id].ready}>
                    {preflights[workflow.id].assignments.length === 0 ? (
                      <p className="workflow-agent-empty"><CheckCircle2 size={14} />This workflow has no Agent execution dependency.</p>
                    ) : preflights[workflow.id].assignments.map(assignment => (
                      <article key={assignment.role} className={`workflow-agent-row is-${assignment.status}`}>
                        <span className="workflow-agent-status" title={assignment.status}>
                          {assignment.status === 'blocked' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
                        </span>
                        <div className="workflow-agent-role"><small>Role</small><b>{assignment.label}</b><code>{assignment.role}</code></div>
                        <div><small>Resolved agent</small><b>{assignment.agentLabel ?? assignment.agentName ?? 'Not resolved'}</b><span>{assignment.model ?? 'No model'}</span></div>
                        <div><small>Runtime / preset</small><b>{assignment.runtime?.profileLabel ?? assignment.runtime?.type ?? 'No runtime'}</b><span>{assignment.presetName ? `${assignment.presetName} v${assignment.installedPresetVersion ?? '?'}` : 'Direct binding'}</span></div>
                        <div><small>Capabilities</small><b>{assignment.toolNames.length} tools · {assignment.bundleIds.length} bundles</b><span>{assignment.skillNames.length} skills · {assignment.stepIds.length} steps</span></div>
                        {(assignment.blockers.length > 0 || assignment.warnings.length > 0) && (
                          <ul>
                            {assignment.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}
                            {assignment.warnings.map(warning => <li className="is-warning" key={warning}>{warning}</li>)}
                          </ul>
                        )}
                      </article>
                    ))}
                    {preflights[workflow.id].inferredLegacyContract && (
                      <p className="workflow-agent-legacy"><AlertTriangle size={13} />Legacy agent IDs were inferred. Convert them to portable roles before exporting this workflow.</p>
                    )}
                  </div>
                )}
              </div>
              <div className="build-card-actions">
                <a href={`/build/workflows/studio/${workflow.id}`}><Workflow size={14} />Open builder</a>
                <a href={`/build/workflows/studio/${workflow.id}`}>Inspect <ArrowRight size={13} /></a>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <section className="panel">
          <EmptyState
            title="No matching workflows"
            description={scopedBundleIds.length > 0
              ? 'No visible workflow currently depends on the selected bundle scope.'
              : 'Change the filter or create the first workflow in this access scope.'}
          />
        </section>
      )}
        </>
      )}
    </>
  );
}
