import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  Database,
  Download,
  FileArchive,
  FileCode2,
  FileSearch,
  Gauge,
  Lightbulb,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { isPlatformAdminRole } from '../access';
import {
  deleteComplianceRun,
  getComplianceRun,
  getComplianceWorkspace,
  getOverview,
  startComplianceRun,
} from '../api';
import { EmptyState, ErrorState, LoadingState, PageHeader, formatDuration, timeAgo } from '../components/Ui';
import { ComplianceDossiers } from '../components/ComplianceDossiers';
import { AiSystemRegistry } from '../components/AiSystemRegistry';
import type {
  ComplianceFinding,
  ComplianceFramework,
  ComplianceRun,
  ComplianceRunStatus,
  ComplianceVerdict,
} from '../types';

type RunFilter = 'all' | ComplianceRunStatus;
type FindingFilter = 'all' | ComplianceVerdict;
type ComplianceTab = 'assessments' | 'systems' | 'dossiers';

function statusLabel(status: ComplianceRunStatus): string {
  if (status === 'queued') return 'Queued';
  if (status === 'running') return 'Collecting evidence';
  if (status === 'completed') return 'Completed';
  if (status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function RunStatus({ status }: { status: ComplianceRunStatus }) {
  const Icon = status === 'completed' ? CheckCircle2
    : status === 'failed' ? XCircle
      : status === 'running' || status === 'queued' ? CircleDashed
        : X;
  return <span className={`compliance-status status-${status}`}><Icon className={status === 'running' ? 'spin' : ''} size={12} />{statusLabel(status)}</span>;
}

function Score({ value, compact = false }: { value: number | null; compact?: boolean }) {
  const state = value == null ? 'empty' : value >= 85 ? 'good' : value >= 60 ? 'warning' : 'bad';
  return <span className={`compliance-score score-${state}${compact ? ' is-compact' : ''}`}><b>{value ?? '—'}</b><small>/100</small></span>;
}

function FindingMark({ finding }: { finding: ComplianceFinding }) {
  const Icon = finding.verdict === 'passed' ? CheckCircle2
    : finding.verdict === 'failed' ? XCircle
      : finding.verdict === 'warning' ? AlertTriangle
        : CircleDashed;
  return <span className={`finding-mark verdict-${finding.verdict}`}><Icon size={15} /></span>;
}

function RunTable({ runs, search, filter }: { runs: ComplianceRun[]; search: string; filter: RunFilter }) {
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return runs.filter(run => (filter === 'all' || run.status === filter) && (!needle || [
      run.target, run.frameworkLabel, run.frameworkSlug, run.triggeredBy, String(run.id),
    ].join(' ').toLowerCase().includes(needle)));
  }, [filter, runs, search]);

  if (!visible.length) return <EmptyState title="No assessment runs found" description="Start an assessment or adjust the current filters." />;
  return (
    <div className="compliance-run-table" role="table" aria-label="Compliance assessment runs">
      <div className="compliance-run-row is-head" role="row">
        <span>Assessment</span><span>Status</span><span>Findings</span><span>Score</span><span>Started</span><span />
      </div>
      {visible.map(run => (
        <a className="compliance-run-row" href={`/governance/compliance/runs/${run.id}`} key={run.id}>
          <span className="compliance-run-primary"><b>{run.frameworkLabel ?? `Framework #${run.frameworkId}`}</b><small>#{run.id} · {run.target}</small></span>
          <RunStatus status={run.status} />
          <span className="compliance-counts"><b className="is-failed">{run.counts.failed}</b><b className="is-warning">{run.counts.warning}</b><b className="is-passed">{run.counts.passed}</b></span>
          <Score value={run.score} compact />
          <span className="compliance-run-time">{run.startedAt ? timeAgo(run.startedAt) : '—'}<small>{run.triggeredBy ?? 'system'}</small></span>
          <ArrowRight size={14} />
        </a>
      ))}
    </div>
  );
}

function FrameworkCard({ framework, onStart }: { framework: ComplianceFramework; onStart: () => void }) {
  return (
    <article className={`compliance-framework${framework.ready ? ' is-ready' : ''}`}>
      <header><span><ClipboardCheck size={17} /></span><em>{framework.jurisdiction ?? 'Global'}</em></header>
      <h3>{framework.label}</h3>
      <p>{framework.description}</p>
      <div className="framework-readiness">
        <span className={framework.checklistReady ? 'is-ready' : ''}><BookOpenCheck size={12} />{framework.checklistReady ? 'Checklist ready' : 'Checklist required'}</span>
        <span className={framework.knowledgeAttached ? 'is-ready' : ''}><Database size={12} />{framework.knowledgeAttached ? 'Knowledge attached' : 'Checklist only'}</span>
      </div>
      <footer><small>Version {framework.version}</small><button type="button" disabled={!framework.ready} onClick={onStart}>{framework.ready ? 'Start assessment' : 'Not ready'}<ArrowRight size={12} /></button></footer>
    </article>
  );
}

export function CompliancePage() {
  const navigate = useNavigate();
  const params = useParams();
  const routeRunId = params.runId && /^[1-9]\d*$/.test(params.runId) ? Number(params.runId) : null;
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview, staleTime: 15_000 });
  const workspace = useQuery({
    queryKey: ['compliance-workspace'],
    queryFn: getComplianceWorkspace,
    refetchInterval: query => query.state.data?.stats.activeRuns ? 5_000 : 30_000,
  });
  const detail = useQuery({
    queryKey: ['compliance-run', routeRunId],
    queryFn: () => getComplianceRun(routeRunId!),
    enabled: routeRunId != null,
    refetchInterval: query => {
      const status = query.state.data?.run.status;
      return status === 'queued' || status === 'running' ? 2_500 : false;
    },
  });
  const [runSearch, setRunSearch] = useState('');
  const [runFilter, setRunFilter] = useState<RunFilter>('all');
  const [findingFilter, setFindingFilter] = useState<FindingFilter>('all');
  const [launchFrameworkId, setLaunchFrameworkId] = useState<number | null>(null);
  const [target, setTarget] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<ComplianceTab>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    return requested === 'dossiers' || requested === 'systems' ? requested : 'assessments';
  });

  const selectTab = (next: ComplianceTab) => {
    setTab(next);
    window.history.replaceState(null, '', next === 'assessments' ? '/governance/compliance' : `/governance/compliance?tab=${next}`);
  };

  const start = useMutation({
    mutationFn: () => startComplianceRun(launchFrameworkId!, target.trim()),
    onSuccess: async result => {
      setLaunchFrameworkId(null);
      setTarget('');
      await queryClient.invalidateQueries({ queryKey: ['compliance-workspace'] });
      navigate(`/governance/compliance/runs/${result.run.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteComplianceRun(id),
    onSuccess: async () => {
      setDeleteOpen(false);
      setDeleteConfirmation('');
      setNotice('Assessment run and its findings were deleted.');
      await queryClient.invalidateQueries({ queryKey: ['compliance-workspace'] });
      navigate('/governance/compliance');
    },
  });

  if (overview.isLoading || workspace.isLoading) return <LoadingState label="Loading Compliance Workspace…" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  if (!isPlatformAdminRole(overview.data?.user.role)) return <ErrorState error={new Error('Platform administrator access required.')} />;
  if (workspace.error) return <ErrorState error={workspace.error} />;
  if (!workspace.data) return null;
  if (params.runId && routeRunId == null) return <ErrorState error={new Error('Invalid compliance run ID.')} />;
  if (routeRunId != null && detail.isLoading) return <LoadingState label={`Loading compliance run #${routeRunId}…`} />;
  if (detail.error) return <ErrorState error={detail.error} />;

  const data = workspace.data;
  const selectedFramework = data.frameworks.find(framework => framework.id === launchFrameworkId) ?? null;
  const runDetail = detail.data;
  const visibleFindings = (runDetail?.findings ?? []).filter(finding => findingFilter === 'all' || finding.verdict === findingFilter);
  const active = data.stats.activeRuns > 0;

  return (
    <>
      <PageHeader
        eyebrow="GOVERN · ASSURANCE"
        title="Compliance workspace"
        description="Run checklist-backed evidence assessments, inspect every finding and export review-ready evidence packs."
        actions={!runDetail && <div className="compliance-page-actions"><div className="segmented-filter" aria-label="Compliance workspace view"><button className={tab === 'assessments' ? 'is-active' : ''} type="button" onClick={() => selectTab('assessments')}><ClipboardCheck size={14} />Assessments</button><button className={tab === 'systems' ? 'is-active' : ''} type="button" onClick={() => selectTab('systems')}><Database size={14} />AI systems</button><button className={tab === 'dossiers' ? 'is-active' : ''} type="button" onClick={() => selectTab('dossiers')}><FileArchive size={14} />AI dossiers</button></div>{tab === 'assessments' && <button className="button button-primary" type="button" disabled={!data.frameworks.some(framework => framework.ready)} onClick={() => setLaunchFrameworkId(data.frameworks.find(framework => framework.ready)?.id ?? null)}><Plus size={15} />New assessment</button>}</div>}
      />

      <section className="compliance-disclaimer" role="note">
        <span><ShieldCheck size={18} /></span>
        <div><b>Evidence support, not a certification</b><p>{data.assessmentNotice}</p></div>
        <em className={data.auditor.ready ? 'is-ready' : ''}><i />{data.auditor.ready ? 'Auditor ready' : 'Auditor unavailable'}</em>
      </section>
      {notice && <div className="console-notice is-success" role="status"><Check size={14} />{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={13} /></button></div>}

      {!runDetail && tab === 'assessments' && <section className="compliance-metrics" aria-label="Compliance workspace summary">
        <article><span className="metric-icon violet"><ClipboardCheck size={17} /></span><div><small>Frameworks ready</small><strong>{data.stats.readyFrameworks}<i>/{data.stats.frameworks}</i></strong><em>checklist + auditor</em></div></article>
        <article><span className="metric-icon blue"><FileSearch size={17} /></span><div><small>Active assessments</small><strong>{data.stats.activeRuns}</strong><em>{active ? 'collecting evidence now' : 'no collection in progress'}</em></div></article>
        <article><span className="metric-icon teal"><Gauge size={17} /></span><div><small>Average score</small><strong>{data.stats.averageScore ?? '—'}<i>{data.stats.averageScore == null ? '' : '/100'}</i></strong><em>{data.stats.completedRuns} completed runs</em></div></article>
        <article><span className="metric-icon amber"><AlertTriangle size={17} /></span><div><small>Recent gaps</small><strong>{data.stats.recentGaps}</strong><em>warnings + failed checks</em></div></article>
      </section>}

      {!runDetail && tab === 'assessments' && (
        <>
          <section className="panel compliance-framework-panel">
            <div className="panel-heading"><div><span className="eyebrow">ASSESSMENT CATALOG</span><h2>Framework readiness</h2></div><small>Versioned checklists · optional knowledge grounding</small></div>
            <div className="compliance-framework-grid">{data.frameworks.map(framework => <FrameworkCard key={framework.id} framework={framework} onStart={() => setLaunchFrameworkId(framework.id)} />)}</div>
          </section>
          <section className="panel compliance-history-panel">
            <div className="compliance-history-heading">
              <div><span className="eyebrow">EVIDENCE HISTORY</span><h2>Assessment runs</h2></div>
              <label className="search-field"><Search size={14} /><input aria-label="Search assessment runs" value={runSearch} onChange={event => setRunSearch(event.target.value)} placeholder="Framework, scope or run ID" /></label>
              <select aria-label="Filter assessment status" value={runFilter} onChange={event => setRunFilter(event.target.value as RunFilter)}><option value="all">All statuses</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select>
              <button type="button" aria-label="Refresh compliance runs" onClick={() => void workspace.refetch()}><RefreshCw size={14} /></button>
            </div>
            <RunTable runs={data.runs} search={runSearch} filter={runFilter} />
          </section>
        </>
      )}

      {!runDetail && tab === 'dossiers' && <ComplianceDossiers />}
      {!runDetail && tab === 'systems' && <AiSystemRegistry />}

      {runDetail && (
        <section className="compliance-detail">
          <a className="compliance-back" href="/governance/compliance"><ArrowLeft size={14} />All assessments</a>
          <div className="compliance-run-hero panel">
            <div className="compliance-run-title"><span><ClipboardCheck size={20} /></span><div><small>{runDetail.framework.jurisdiction ?? 'Global'} · VERSION {runDetail.framework.version}</small><h2>{runDetail.framework.label}</h2><p>Run #{runDetail.run.id} · {runDetail.run.target}</p></div></div>
            <RunStatus status={runDetail.run.status} />
            <Score value={runDetail.run.score} />
            <dl>
              <div><dt>Started by</dt><dd><UserRound size={12} />{runDetail.run.triggeredBy ?? 'system'}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(runDetail.run.durationMs)}</dd></div>
              <div><dt>Evidence checks</dt><dd>{runDetail.findings.length}</dd></div>
              <div><dt>Knowledge</dt><dd>{runDetail.framework.knowledgeAttached ? 'Attached' : 'Checklist only'}</dd></div>
            </dl>
          </div>

          {(runDetail.run.status === 'running' || runDetail.run.status === 'queued') && <div className="compliance-progress" role="status"><CircleDashed className="spin" size={16} /><div><b>Evidence collection is running</b><span>The auditor is walking the checklist. Findings appear after the run completes.</span></div></div>}
          {runDetail.run.error && <div className="compliance-error" role="alert"><XCircle size={16} /><div><b>Assessment failed</b><span>{runDetail.run.error}</span></div></div>}

          <div className="compliance-findings-head">
            <div><span className="eyebrow">ASSESSMENT EVIDENCE</span><h2>Findings</h2></div>
            <div className="finding-filters">{(['all', 'failed', 'warning', 'passed', 'not_applicable'] as FindingFilter[]).map(value => <button className={findingFilter === value ? 'is-active' : ''} type="button" onClick={() => setFindingFilter(value)} key={value}>{value.replace('_', ' ')}</button>)}</div>
            {runDetail.exports && <div className="compliance-export"><a href={runDetail.exports.pdf}><Download size={13} />PDF</a><a href={runDetail.exports.csv}><Download size={13} />CSV</a></div>}
          </div>

          {visibleFindings.length ? <div className="compliance-finding-list">{visibleFindings.map((finding, index) => (
            <article className={`compliance-finding verdict-${finding.verdict}`} key={finding.id ?? `${finding.article}-${index}`}>
              <FindingMark finding={finding} />
              <header><small>{finding.article}</small><h3>{finding.title}</h3></header>
              <span className={`severity severity-${finding.severity}`}>{finding.severity}</span>
              <section><span><FileSearch size={13} />Evidence</span><p>{finding.evidence || 'No evidence narrative was returned.'}</p></section>
              {finding.remediation && <section className="finding-remediation"><span><Lightbulb size={13} />Remediation</span><p>{finding.remediation}</p></section>}
              {finding.codePointers.length > 0 && <div className="finding-pointers"><span><FileCode2 size={13} />Code pointers</span>{finding.codePointers.map((pointer, pointerIndex) => <code key={`${pointer.file}-${pointerIndex}`}><b>{pointer.file}{pointer.line ? `:${pointer.line}` : ''}</b>{pointer.snippet && <small>{pointer.snippet}</small>}</code>)}</div>}
            </article>
          ))}</div> : <section className="panel"><EmptyState title={runDetail.run.status === 'completed' ? 'No findings match this filter' : 'Findings are not available yet'} description={runDetail.run.status === 'completed' ? 'Choose another verdict filter.' : 'Argus will show evidence here when the assessment finishes.'} /></section>}

          {runDetail.run.status !== 'running' && runDetail.run.status !== 'queued' && <div className="compliance-danger-zone panel"><div><Trash2 size={16} /><span><b>Delete assessment evidence</b><small>This permanently removes the run and all associated findings.</small></span></div><button className="button button-secondary" type="button" onClick={() => setDeleteOpen(true)}>Delete run</button></div>}
        </section>
      )}

      {launchFrameworkId != null && selectedFramework && (
        <div className="compliance-layer" role="presentation" onMouseDown={() => setLaunchFrameworkId(null)}>
          <section className="compliance-dialog" role="dialog" aria-modal="true" aria-label="Start compliance assessment" onMouseDown={event => event.stopPropagation()}>
            <header><div><span className="eyebrow">NEW EVIDENCE ASSESSMENT</span><h2>{selectedFramework.label}</h2></div><button type="button" aria-label="Close assessment dialog" onClick={() => setLaunchFrameworkId(null)}><X size={16} /></button></header>
            <form onSubmit={event => { event.preventDefault(); start.mutate(); }}>
              <label><span>Framework</span><select aria-label="Assessment framework" value={launchFrameworkId} onChange={event => setLaunchFrameworkId(Number(event.target.value))}>{data.frameworks.filter(framework => framework.ready).map(framework => <option value={framework.id} key={framework.id}>{framework.label} · {framework.version}</option>)}</select></label>
              <label><span>Audit scope</span><input aria-label="Audit scope" value={target} required maxLength={512} placeholder="argus-production or repository/service identifier" onChange={event => setTarget(event.target.value)} /><small>A single-line identifier for the repository, service or environment the auditor should inspect. It is never executed as a command.</small></label>
              <div className="compliance-dialog-note"><ShieldCheck size={15} /><p><b>Human review remains required.</b> The agent collects evidence against the selected checklist; the result is not a certification or legal determination.</p></div>
              {start.error && <p className="decision-error">{start.error.message}</p>}
              <footer><button className="button button-secondary" type="button" onClick={() => setLaunchFrameworkId(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={start.isPending || !target.trim()}>{start.isPending ? 'Starting…' : 'Start assessment'}<ArrowRight size={13} /></button></footer>
            </form>
          </section>
        </div>
      )}

      {deleteOpen && runDetail && (
        <div className="compliance-layer" role="presentation" onMouseDown={() => setDeleteOpen(false)}>
          <section className="compliance-dialog compliance-delete" role="dialog" aria-modal="true" aria-label="Delete compliance run" onMouseDown={event => event.stopPropagation()}>
            <header><div><span className="eyebrow">DESTRUCTIVE EVIDENCE ACTION</span><h2>Delete run #{runDetail.run.id}</h2></div><button type="button" aria-label="Close delete dialog" onClick={() => setDeleteOpen(false)}><X size={16} /></button></header>
            <p>This removes the assessment record and every finding. Existing downloaded reports cannot be recovered or verified against this workspace afterward.</p>
            <label><span>Type <code>run-{runDetail.run.id}</code> to confirm</span><input aria-label="Confirm compliance run deletion" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} /></label>
            {remove.error && <p className="decision-error">{remove.error.message}</p>}
            <footer><button className="button button-secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</button><button className="button button-danger" type="button" disabled={remove.isPending || deleteConfirmation !== `run-${runDetail.run.id}`} onClick={() => remove.mutate(runDetail.run.id)}>{remove.isPending ? 'Deleting…' : 'Delete evidence'}</button></footer>
          </section>
        </div>
      )}
    </>
  );
}
