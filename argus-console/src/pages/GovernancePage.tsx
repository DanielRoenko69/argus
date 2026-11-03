import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  FileCheck2,
  GitBranch,
  Gauge,
  History,
  KeyRound,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Users,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { decideRuntimeApproval, decideWorkflowReview, getGovernance, resumeCodingWorkflow } from '../api';
import { EmptyState, ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { RunWorkspaceTabs } from '../features/runs/RunWorkspaceTabs';
import type { ApprovalInboxItem } from '../types';

type InboxFilter = 'all' | 'high' | 'mine';

function ApprovalRow({
  item,
  selected,
  onSelect,
}: {
  item: ApprovalInboxItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`approval-row${selected ? ' is-selected' : ''}`} type="button" onClick={onSelect}>
      <span className={`approval-risk risk-${item.risk}`}>
        {item.kind === 'runtime_tool' ? <Wrench size={15} /> : item.kind === 'coding_workflow' ? <GitBranch size={15} /> : <ShieldAlert size={15} />}
      </span>
      <span className="approval-row-copy">
        <span><b>{item.title}</b><small>{timeAgo(item.submittedAt)}</small></span>
        <small>
          {item.kind === 'runtime_tool' ? `${item.subjectLabel} · requested by ` : item.kind === 'coding_workflow' ? 'Argus Dev · ' : 'Submitted by '}
          {item.submittedBy}{item.version != null ? ` · v${item.version}` : ''}
        </small>
        <span className="approval-chip-row">
          <em className={`risk-chip risk-${item.risk}`}>
            {item.risk} risk{item.riskScore != null ? ` · ${item.riskScore}` : ''}
          </em>
          {item.humanOversightRequired && <em>Human oversight</em>}
          {item.bundles.slice(0, 2).map(bundle => <em key={bundle}>{bundle}</em>)}
        </span>
      </span>
      <ArrowRight size={14} />
    </button>
  );
}

export function GovernancePage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useQuery({ queryKey: ['governance'], queryFn: getGovernance, refetchInterval: 20_000 });
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');

  const filtered = useMemo(() => {
    const items = query.data?.approvals ?? [];
    if (filter === 'high') return items.filter(item => item.risk === 'high' || item.risk === 'critical');
    if (filter === 'mine') return items.filter(item => item.submittedBy === query.data?.user.username);
    return items;
  }, [filter, query.data]);
  const selected = query.data?.approvals.find(item => item.id === selectedId)
    ?? filtered[0]
    ?? null;

  useEffect(() => {
    if (selectedId && !query.data?.approvals.some(item => item.id === selectedId)) setSelectedId(null);
  }, [query.data, selectedId]);

  useEffect(() => {
    if (!query.data || selectedId) return;
    const requestedApprovalId = searchParams.get('approval');
    const requestedExecutionId = searchParams.get('workflowExecutionId');
    const requestedRunId = searchParams.get('run');
    const requested = query.data.approvals.find(item => (
      (requestedApprovalId != null && item.id === requestedApprovalId)
      || (requestedExecutionId != null && String(item.workflowExecutionId ?? '') === requestedExecutionId)
      || (requestedRunId != null && (
        String(item.workflowExecutionId ?? '') === requestedRunId
        || item.codingThreadId === requestedRunId
        || item.sessionId === requestedRunId
      ))
    ));
    if (requested) setSelectedId(requested.id);
  }, [query.data, searchParams, selectedId]);

  const selectApproval = (item: ApprovalInboxItem) => {
    setSelectedId(item.id);
    setDecision(null);
    setComment('');
    const next = new URLSearchParams(searchParams);
    next.set('approval', item.id);
    if (item.workflowExecutionId != null) next.set('workflowExecutionId', String(item.workflowExecutionId));
    setSearchParams(next, { replace: true });
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (!selected || !decision) throw new Error('Select an approval decision');
      if (decision === 'reject' && !comment.trim()) {
        throw new Error(selected.kind === 'coding_workflow' ? 'Requested changes are required' : 'A rejection reason is required');
      }
      if (selected.kind === 'coding_workflow' && selected.codingThreadId) {
        return resumeCodingWorkflow(selected.codingThreadId, {
          approved: decision === 'approve',
          feedback: comment.trim(),
          rationale: comment.trim(),
        });
      }
      if (selected.kind === 'runtime_tool' && selected.runtimeApprovalId) {
        return decideRuntimeApproval(selected.runtimeApprovalId, decision, comment.trim());
      }
      if (selected.workflowId) {
        return decideWorkflowReview(selected.workflowId, decision, comment.trim());
      }
      throw new Error('Approval target is incomplete');
    },
    onSuccess: async () => {
      setDecision(null);
      setComment('');
      setSelectedId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['governance'] }),
        queryClient.invalidateQueries({ queryKey: ['overview'] }),
        queryClient.invalidateQueries({ queryKey: ['argus-dev-runs'] }),
      ]);
    },
  });

  if (query.isLoading) return <LoadingState label="Loading approval inbox…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data) return null;

  const { permissions, recentDecisions, stats } = query.data;
  const oldest = stats.oldestSubmittedAt ? timeAgo(stats.oldestSubmittedAt) : '—';

  return (
    <>
      <PageHeader
        eyebrow="OPERATE · RUN CONTROL"
        title="Approvals"
        description="Review workflow changes, enforce four-eyes decisions and retain a complete evidence trail."
        actions={permissions.canManagePlatform
          ? <a className="button button-secondary" href="/observe/audit"><ScrollText size={16} />Open audit trail</a>
          : undefined}
      />

      <RunWorkspaceTabs active="approvals" />

      <section className="metric-grid governance-metrics" aria-label="Approval inbox summary">
        <article className="metric-card">
          <span className="metric-icon amber"><Clock3 size={17} /></span>
          <div><span>Pending</span><strong>{stats.pending}</strong><small>workflow reviews</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon red"><ShieldAlert size={17} /></span>
          <div><span>High risk</span><strong>{stats.highRisk}</strong><small>human oversight</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon violet"><UserRound size={17} /></span>
          <div><span>Submitted by me</span><strong>{stats.submittedByMe}</strong><small>four-eyes applies</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon blue"><History size={17} /></span>
          <div><span>Oldest request</span><strong className="metric-word">{oldest}</strong><small>queue age</small></div>
        </article>
      </section>

      <section className="governance-control-strip">
        <span><ShieldCheck size={17} /></span>
        <div>
          <b>{permissions.canReview ? 'Reviewer controls active' : 'Read-only governance view'}</b>
          <small>
            {permissions.canOverrideFourEyes
              ? 'Platform admin override is available and always recorded.'
              : permissions.canReview
                ? 'You can approve other submissions and reject with documented feedback.'
                : 'Agent operator role or higher is required to make decisions.'}
          </small>
        </div>
      </section>

      <div className="approval-workspace">
        <section className="panel approval-inbox-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">PENDING</span><h2>Review queue</h2></div>
            <div className="inbox-filter" aria-label="Filter approval requests">
              {(['all', 'high', 'mine'] as InboxFilter[]).map(value => (
                <button className={filter === value ? 'is-active' : ''} type="button" key={value} onClick={() => setFilter(value)}>
                  {value}
                </button>
              ))}
            </div>
          </div>
          {filtered.length > 0 ? (
            <div className="approval-list">
              {filtered.map(item => (
                <ApprovalRow
                  item={item}
                  selected={selected?.id === item.id}
                  onSelect={() => selectApproval(item)}
                  key={item.id}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title={query.data.approvals.length === 0 ? 'Review queue is clear' : 'No matching requests'}
              description={query.data.approvals.length === 0
                ? 'New workflow submissions will appear here with their policy context and audit history.'
                : 'Choose a different approval filter.'}
            />
          )}
        </section>

        <section className="panel approval-detail-panel">
          {selected ? (
            <>
              <div className="approval-detail-head">
                <span className={`approval-risk risk-${selected.risk}`}>
                  {selected.kind === 'runtime_tool' ? <Wrench size={17} /> : selected.kind === 'coding_workflow' ? <GitBranch size={17} /> : <ShieldAlert size={17} />}
                </span>
                <div>
                  <span className="eyebrow">{selected.kind === 'runtime_tool' ? 'RUNTIME TOOL APPROVAL' : selected.kind === 'coding_workflow' ? 'ARGUS DEV · HUMAN APPROVAL' : 'WORKFLOW REVIEW'}</span>
                  <h2>{selected.title}</h2>
                  <p>{selected.description || 'No workflow description provided.'}</p>
                </div>
                <a href={selected.href} aria-label="Open workflow"><GitBranch size={16} /></a>
              </div>

              <dl className="approval-facts">
                <div><dt>{selected.kind === 'runtime_tool' ? 'Requested by' : selected.kind === 'coding_workflow' ? 'Workflow' : 'Submitted by'}</dt><dd>{selected.kind === 'coding_workflow' ? 'Argus Dev' : selected.submittedBy}</dd></div>
                <div><dt>{selected.kind === 'runtime_tool' ? 'Requested' : 'Submitted'}</dt><dd>{timeAgo(selected.submittedAt)}</dd></div>
                <div>
                    <dt>{selected.kind === 'runtime_tool' ? 'Target' : selected.kind === 'coding_workflow' ? 'Ticket' : 'Version'}</dt>
                    <dd>{selected.kind === 'runtime_tool' ? selected.subjectLabel : selected.kind === 'coding_workflow' ? selected.title.replace(/ · Argus Dev approval$/, '') : selected.version == null ? 'Latest' : `v${selected.version}`}</dd>
                </div>
                <div><dt>Boundary</dt><dd>{selected.bundles.join(', ') || 'Unscoped'}</dd></div>
              </dl>

              {selected.kind === 'runtime_tool' && selected.riskScore != null && (
                <section className={`risk-assessment risk-${selected.risk}`}>
                  <div className="risk-assessment-head">
                    <span><Gauge size={17} /></span>
                    <div>
                      <span className="graph-label">ARGUS RISK ASSESSMENT</span>
                      <b>{selected.risk} · {selected.riskScore}/100</b>
                    </div>
                    <small>{selected.riskModel ?? 'argus-risk-v1'}</small>
                  </div>
                  <div className="risk-score-track">
                    <i style={{ width: `${selected.riskScore}%` }} />
                  </div>
                  <div className="risk-factor-grid">
                    {(selected.riskFactors ?? []).map(factor => (
                      <article key={factor.id}>
                        <span>+{factor.weight}</span>
                        <div><b>{factor.label}</b><small>{factor.evidence}</small></div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {selected.kind === 'runtime_tool' && selected.toolArgs && (
                <div className="tool-args-review">
                  <span className="graph-label">EXACT TOOL ARGUMENTS</span>
                  <pre>{JSON.stringify(selected.toolArgs, null, 2)}</pre>
                  <small>
                    Session {selected.sessionId} · seen {selected.occurrenceCount ?? 1} time{selected.occurrenceCount === 1 ? '' : 's'}
                  </small>
                  {selected.autoResume && (
                    <span className="auto-resume-note">
                      <CheckCircle2 size={13} />
                      Approval automatically resumes run #{selected.workflowExecutionId} at step {selected.workflowStepId}.
                    </span>
                  )}
                </div>
              )}

              {selected.comment && (
                <blockquote className="submission-note">
                  <span>Submission note</span>
                  <p>{selected.comment}</p>
                </blockquote>
              )}

              <div className="approval-history">
                <span className="graph-label">DECISION HISTORY</span>
                {selected.history.length === 0 && selected.kind === 'runtime_tool' && (
                  <p className="runtime-history-note">
                    Pending first decision. Approval creates a 30-minute, single-use grant
                    {selected.autoResume ? ' and resumes the paused workflow.' : '.'}
                  </p>
                )}
                {selected.history.map(event => (
                  <article key={event.id}>
                    <span className={`history-dot action-${event.action}`}>
                      {event.action === 'approved' ? <Check size={11} /> : event.action === 'rejected' ? <X size={11} /> : <Clock3 size={11} />}
                    </span>
                    <div><b>{event.action}</b><small>{event.actor} · {timeAgo(event.createdAt)}</small>{event.comment && <p>{event.comment}</p>}</div>
                  </article>
                ))}
              </div>

              {decision ? (
                <form className={`decision-form decision-${decision}`} onSubmit={event => { event.preventDefault(); mutation.mutate(); }}>
                  <div>
                    {decision === 'approve' ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
                    <b>
                      {decision === 'approve'
                        ? selected.kind === 'runtime_tool' ? 'Approve exact tool call' : selected.kind === 'coding_workflow' ? 'Approve & continue Argus Dev' : 'Approve for production'
                        : selected.kind === 'runtime_tool' ? 'Reject tool call' : selected.kind === 'coding_workflow' ? 'Request changes & rerun Argus Dev' : 'Reject to draft'}
                    </b>
                  </div>
                  <textarea
                    value={comment}
                    onChange={event => setComment(event.target.value)}
                    placeholder={decision === 'reject' ? 'Requested changes for Argus Dev (required)' : 'Decision rationale (optional)'}
                    maxLength={1000}
                    autoFocus
                  />
                  <small className="decision-form-help">
                    {decision === 'reject'
                      ? 'This sends the requested changes back to the coder and reviewer.'
                      : 'Approval comments are recorded as rationale only. To change the implementation, choose Request changes.'}
                  </small>
                  {mutation.error && <p className="decision-error">{mutation.error.message}</p>}
                  <div className="decision-form-actions">
                    <button type="button" onClick={() => { setDecision(null); mutation.reset(); }}>Cancel</button>
                    <button className={decision === 'approve' ? 'button button-primary' : 'button button-danger'} type="submit" disabled={mutation.isPending}>
                      {mutation.isPending ? 'Recording…' : decision === 'approve' ? 'Confirm approval' : 'Confirm rejection'}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="approval-actions">
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={!selected.actions.canReject}
                    onClick={() => setDecision('reject')}
                  >
                    <XCircle size={15} />{selected.kind === 'coding_workflow' ? 'Request changes' : 'Reject'}
                  </button>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={!selected.actions.canApprove}
                    onClick={() => setDecision('approve')}
                  >
                    <CheckCircle2 size={15} />Approve
                  </button>
                  {selected.actions.blockedReason && <small>{selected.actions.blockedReason}</small>}
                </div>
              )}
            </>
          ) : (
            <EmptyState title="No request selected" description="Select a workflow review to inspect its context and decision history." />
          )}
        </section>
      </div>

      <section className="panel recent-decisions-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">EVIDENCE</span><h2>Recent decisions</h2></div>
          {permissions.canManagePlatform && <a href="/observe/audit">Full audit trail <ArrowRight size={14} /></a>}
        </div>
        {recentDecisions.length > 0 ? (
          <div className="decision-timeline">
            {recentDecisions.map(item => (
              <a href={item.href} key={item.id}>
                <span className={`decision-icon action-${item.action}`}>
                  {item.kind === 'runtime_tool'
                    ? <Wrench size={15} />
                    : item.action === 'approved' ? <FileCheck2 size={15} /> : <ShieldAlert size={15} />}
                </span>
                <span><b>{item.title}</b><small>{item.action} by {item.actor}</small></span>
                <time>{timeAgo(item.createdAt)}</time>
              </a>
            ))}
          </div>
        ) : (
          <EmptyState title="No recorded decisions yet" description="Approved, rejected and withdrawn workflow reviews will appear here." />
        )}
      </section>

      {permissions.canManagePlatform && (
        <div className="feature-grid governance-links">
          <a className="feature-card" href="/observe/audit">
            <span className="feature-icon violet"><FileCheck2 size={19} /></span>
            <div><h3>Audit evidence</h3><p>Trace executions, tool calls and decisions through immutable records.</p><b>Open evidence <ArrowRight size={13} /></b></div>
          </a>
          <a className="feature-card" href="/governance/policies">
            <span className="feature-icon teal"><Users size={19} /></span>
            <div><h3>Access policies</h3><p>Compose bundle boundaries and bind identity groups.</p><b>Manage policies <ArrowRight size={13} /></b></div>
          </a>
          <a className="feature-card" href="/settings/api-keys">
            <span className="feature-icon blue"><KeyRound size={19} /></span>
            <div><h3>Machine identities</h3><p>Manage scoped API keys for clients and runtimes.</p><b>Manage keys <ArrowRight size={13} /></b></div>
          </a>
          <a className="feature-card" href="/governance/compliance">
            <span className="feature-icon amber"><FileCheck2 size={19} /></span>
            <div><h3>Compliance assessments</h3><p>Run checklist-backed evidence assessments and review actionable findings.</p><b>Open workspace <ArrowRight size={13} /></b></div>
          </a>
        </div>
      )}
    </>
  );
}
