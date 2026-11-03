import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  BellRing,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  Gauge,
  GitBranch,
  Network,
  PackagePlus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  checkIncidentRemediationPostChange,
  createIncidentRemediationChangePlan,
  createNativeAlert,
  decideIncidentRemediationChangePlan,
  decideIncidentRemediationPostChangeRollback,
  decideIncidentRemediation,
  deleteNativeAlert,
  evaluateNativeAlerts,
  getFabricManagement,
  getIncidentAiopsInvestigations,
  getIncidentAiopsFeedback,
  getIncidentChangeCorrelations,
  getIncidentImpact,
  getIncidentRemediationExecutorCandidates,
  getIncidentRemediationWriteAdapters,
  getAiopsOutcomes,
  getNativeAlerts,
  getNativeServiceCatalog,
  getOverview,
  getSolutionPacks,
  installNativeAlertTemplate,
  refreshNativeServiceCatalog,
  runIncidentRemediationDryRun,
  submitIncidentAiopsFeedback,
  executeIncidentRemediationChangePlan,
  executeIncidentRemediationPostChangeRollback,
  updateNativeAlert,
} from '../api';
import { isPlatformAdminRole } from '../access';
import { ErrorState, formatDuration, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { ObserveWorkspaceTabs } from '../features/observe/ObserveWorkspaceTabs';
import type {
  AiopsOutcomeResponse,
  FabricExecutionTarget,
  FabricManagementResponse,
  IncidentAiopsInvestigationsResponse,
  IncidentAiopsFeedbackReason,
  IncidentAiopsFeedbackResponse,
  IncidentAiopsFeedbackVerdict,
  IncidentAiopsInvestigation,
  IncidentRemediation,
  IncidentRemediationExecutorCandidate,
  NativeAlertMetric,
  NativeAlertIncident,
  NativeAlertExemplar,
  NativeAlertOperator,
  NativeAlertRule,
  NativeAlertRuleMutation,
  NativeAlertScopeKind,
  NativeAlertSeverity,
  NativeServiceCatalogRefreshInput,
  NativeServiceCatalogResponse,
} from '../types';

const rcaFeedbackReasons: Array<{ value: IncidentAiopsFeedbackReason; label: string }> = [
  { value: 'accurate_root_cause', label: 'Root cause is accurate' },
  { value: 'useful_evidence', label: 'Evidence was useful' },
  { value: 'incomplete_evidence', label: 'Evidence is incomplete' },
  { value: 'missing_context', label: 'Important context is missing' },
  { value: 'incorrect_root_cause', label: 'Root cause is incorrect' },
  { value: 'stale_evidence', label: 'Evidence is stale' },
  { value: 'unsafe_recommendation', label: 'Recommendation is unsafe' },
  { value: 'other', label: 'Other' },
];

const metricLabels: Record<NativeAlertMetric, string> = {
  error_rate: 'Error rate',
  success_rate: 'Success rate',
  p95_latency_ms: 'P95 latency',
  total_cost_usd: 'Total cost',
  failure_count: 'Failure count',
  latency_regression_percent: 'Latency regression',
  cost_regression_percent: 'Cost regression',
};

const operatorLabels: Record<NativeAlertOperator, string> = {
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
};

const emptyRule: NativeAlertRuleMutation = {
  name: '',
  description: '',
  metric: 'error_rate',
  operator: 'gt',
  threshold: 10,
  windowMinutes: 15,
  minSamples: 5,
  severity: 'warning',
  scopeKind: 'all',
  scopeValue: null,
  cooldownMinutes: 60,
  notify: true,
  enabled: true,
  aiopsAutoInvestigate: false,
  aiopsBundleIds: [],
  aiopsResourceScope: null,
  aiopsService: null,
  aiopsEnvironment: null,
};

const terminalAiopsStates = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

const aiopsPolicyPresets = [{
  id: 'reliability',
  label: 'Reliability RCA',
  detail: 'Error rate above 5% for 15 minutes.',
  metric: 'error_rate' as NativeAlertMetric,
  operator: 'gt' as NativeAlertOperator,
  threshold: 5,
  windowMinutes: 15,
  minSamples: 5,
  severity: 'critical' as NativeAlertSeverity,
  icon: ShieldCheck,
}, {
  id: 'latency',
  label: 'Latency RCA',
  detail: 'P95 regression above 25% for 30 minutes.',
  metric: 'latency_regression_percent' as NativeAlertMetric,
  operator: 'gt' as NativeAlertOperator,
  threshold: 25,
  windowMinutes: 30,
  minSamples: 10,
  severity: 'warning' as NativeAlertSeverity,
  icon: Gauge,
}, {
  id: 'cost',
  label: 'Cost RCA',
  detail: 'Cost regression above 30% for 60 minutes.',
  metric: 'cost_regression_percent' as NativeAlertMetric,
  operator: 'gt' as NativeAlertOperator,
  threshold: 30,
  windowMinutes: 60,
  minSamples: 5,
  severity: 'warning' as NativeAlertSeverity,
  icon: CircleDollarSign,
}] as const;

function aiopsStateLabel(state: string): string {
  return state.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, ' ');
}

function formatMetricValue(metric: NativeAlertMetric, value: number | null): string {
  if (value == null) return '—';
  if (metric === 'error_rate' || metric === 'success_rate' || metric === 'latency_regression_percent' || metric === 'cost_regression_percent') return `${value.toFixed(1)}%`;
  if (metric === 'p95_latency_ms') return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value.toFixed(0)}ms`;
  if (metric === 'total_cost_usd') return `$${value.toFixed(value < 1 ? 4 : 2)}`;
  return value.toFixed(0);
}

function safeIncidentExemplars(context: { exemplars?: unknown }) {
  if (!Array.isArray(context.exemplars)) return [];
  return context.exemplars.filter(exemplar => {
    if (!exemplar || typeof exemplar !== 'object') return false;
    const value = exemplar as Record<string, unknown>;
    return typeof value['href'] === 'string'
      && value['href'].startsWith('/runs/')
      && typeof value['title'] === 'string';
  }) as NonNullable<NativeAlertIncident['context']['exemplars']>;
}

function safeIncidentBaseline(context: NativeAlertIncident['context']) {
  const baseline = context.baseline;
  if (!baseline || typeof baseline !== 'object') return null;
  return Number.isFinite(baseline.value)
    && Number.isFinite(baseline.currentValue)
    && Number.isFinite(baseline.sampleCount)
    && (baseline.windowDays === 7 || baseline.windowDays === 30)
    ? baseline
    : null;
}

function incidentMetric(incident: NativeAlertIncident, rule?: NativeAlertRule): NativeAlertMetric {
  const metric = incident.context.metric;
  return typeof metric === 'string' && metric in metricLabels
    ? metric as NativeAlertMetric
    : rule?.metric ?? 'error_rate';
}

function formatComparisonValue(metric: NativeAlertMetric, value: number): string {
  if (metric === 'latency_regression_percent') return formatMetricValue('p95_latency_ms', value);
  if (metric === 'cost_regression_percent') return formatMetricValue('total_cost_usd', value);
  return formatMetricValue(metric, value);
}

function formatIncidentTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function incidentDuration(incident: NativeAlertIncident): string {
  const started = Date.parse(incident.triggeredAt);
  const ended = incident.recoveredAt ? Date.parse(incident.recoveredAt) : Date.now();
  return formatDuration(Math.max(0, ended - started));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function expectedProviderState(plan: IncidentRemediation['changePlans'][number]): string {
  if (plan.adapterKey === 'kubernetes.scale.v1' && plan.desiredReplicas != null) {
    return `${plan.desiredReplicas} replicas`;
  }
  const desired = record(plan.adapterState['desired']);
  if (plan.adapterKey === 'kubernetes.deployment-revision-rollback.v1') {
    const revision = Number(desired?.['targetRevision']);
    const hash = typeof desired?.['templateHash'] === 'string' ? desired['templateHash'] : '';
    if (Number.isSafeInteger(revision) && revision > 0 && /^[a-f0-9]{64}$/.test(hash)) {
      return `revision ${revision} · template ${hash.slice(0, 12)}…`;
    }
  }
  return 'adapter-defined state';
}

function observedProviderState(monitor: IncidentRemediation['changePlans'][number]['postChangeMonitor']): string {
  if (!monitor) return 'pending';
  if (monitor.observedReplicas != null) return String(monitor.observedReplicas);
  const observed = record(monitor.observedState?.['observed']);
  const revision = Number(observed?.['revision']);
  const hash = typeof observed?.['templateHash'] === 'string' ? observed['templateHash'] : '';
  if (Number.isSafeInteger(revision) && revision > 0 && /^[a-f0-9]{64}$/.test(hash)) {
    return `revision ${revision} · template ${hash.slice(0, 12)}…`;
  }
  return monitor.observedState ? 'captured' : 'pending';
}

function remediationIntentLabel(intent: IncidentRemediation['executionIntent']): string {
  if (!intent) return 'None · diagnosis only';
  if (intent.adapterKey === 'kubernetes.scale.v1') {
    return `${intent.workloadKind} ${intent.workloadName} → ${intent.desiredReplicas} replicas`;
  }
  return `Deployment ${intent.workloadName} → retained revision ${intent.targetRevision}`;
}

function aiOpsIncidentHref(incident: NativeAlertIncident): string {
  const scopeValue = typeof incident.context.scopeValue === 'string'
    ? incident.context.scopeValue.trim()
    : '';
  const windowMinutes = Number(incident.context.windowMinutes);
  const params = new URLSearchParams({
    launch: 'incident',
    source_incident_id: String(incident.id),
    title: incident.ruleName.slice(0, 300),
    summary: incident.message.slice(0, 20_000),
    severity: incident.severity,
    service: (scopeValue || 'argus-core').slice(0, 200),
    alert_source: `Argus native alert #${incident.id}`,
    correlation_window_minutes: String(Number.isFinite(windowMinutes) && windowMinutes > 0 ? Math.min(windowMinutes, 1_440) : 30),
  });
  return `/solutions/argus.aiops?${params.toString()}`;
}

function strongestDominantSpan(exemplars: NativeAlertExemplar[]): { label: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const exemplar of exemplars) {
    if (exemplar.dominantSpanLabel) counts.set(exemplar.dominantSpanLabel, (counts.get(exemplar.dominantSpanLabel) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => ({ label, count }))[0] ?? null;
}

function formatChangeOffset(minutes: number): string {
  if (minutes === 0) return 'at incident trigger';
  const distance = formatDuration(Math.abs(minutes) * 60_000);
  return `${distance} ${minutes < 0 ? 'before incident' : 'after trigger'}`;
}

function PostChangeMonitorPanel({
  incidentId,
  proposal,
  plan,
  onRemediationUpdate,
}: {
  incidentId: number;
  proposal: IncidentRemediation;
  plan: IncidentRemediation['changePlans'][number];
  onRemediationUpdate: (remediation: IncidentRemediation) => void;
}) {
  const [comment, setComment] = useState('');
  const monitor = plan.postChangeMonitor;
  const check = useMutation({
    mutationFn: () => {
      if (!monitor) throw new Error('Post-change monitor is unavailable.');
      return checkIncidentRemediationPostChange(incidentId, proposal.id, plan.id, {
        monitorId: monitor.id, version: monitor.version, rollbackHash: monitor.rollbackHash,
      });
    },
    onSuccess: ({ remediation }) => onRemediationUpdate(remediation),
  });
  const decideRollback = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => {
      if (!monitor) throw new Error('Post-change monitor is unavailable.');
      return decideIncidentRemediationPostChangeRollback(incidentId, proposal.id, plan.id, {
        monitorId: monitor.id, version: monitor.version, rollbackHash: monitor.rollbackHash,
        decision, comment: comment.trim() || null,
      });
    },
    onSuccess: ({ remediation }) => onRemediationUpdate(remediation),
  });
  const executeRollback = useMutation({
    mutationFn: () => {
      if (!monitor) throw new Error('Post-change monitor is unavailable.');
      return executeIncidentRemediationPostChangeRollback(incidentId, proposal.id, plan.id, {
        monitorId: monitor.id, version: monitor.version, rollbackHash: monitor.rollbackHash,
      });
    },
    onSuccess: ({ remediation }) => onRemediationUpdate(remediation),
  });
  if (!monitor) return null;
  const canCheck = ['scheduled', 'healthy', 'check_failed'].includes(monitor.status);
  const scalePlan = plan.adapterKey === 'kubernetes.scale.v1';
  return (
    <section className={`incident-post-change-monitor is-${monitor.status}`}>
      <header><span><Activity size={12} />Post-change monitor</span><b>{monitor.status.replaceAll('_', ' ')}</b></header>
      <dl>
        <div><dt>Expected</dt><dd>{expectedProviderState(plan)}</dd></div>
        <div><dt>Observed</dt><dd>{observedProviderState(monitor)}</dd></div>
        <div><dt>Scheduled</dt><dd>{formatIncidentTimestamp(monitor.scheduledFor)}</dd></div>
        <div><dt>Rollback hash</dt><dd title={monitor.rollbackHash}>{monitor.rollbackHash.slice(0, 16)}…</dd></div>
      </dl>
      {monitor.status === 'checking' && <small>Reading the exact approved workload state…</small>}
      {monitor.status === 'healthy' && <div className="incident-change-plan-result is-success"><CheckCircle2 size={13} />Desired state remains healthy.</div>}
      {monitor.status === 'check_failed' && <div className="incident-change-plan-result is-warning"><TriangleAlert size={13} />State could not be read. No rollback was authorized.</div>}
      {monitor.observationError && <p className="incident-change-plan-error">{monitor.observationError}</p>}
      {canCheck && (
        <>
          {check.isError && <span role="alert"><TriangleAlert size={12} />{check.error.message}</span>}
          <button type="button" className="button button-secondary" disabled={check.isPending} onClick={() => check.mutate()}>
            <RefreshCw size={12} />{check.isPending ? 'Checking state…' : monitor.status === 'scheduled' ? 'Check post-change state now' : 'Recheck post-change state'}
          </button>
        </>
      )}
      {monitor.status === 'regression_detected' && (
        <div className="incident-post-change-regression">
          <div className="incident-change-plan-result is-error"><TriangleAlert size={13} />Drift detected. Rollback requires a separate approval.</div>
          <label><span>Rollback decision note</span><textarea value={comment} maxLength={2_000} onChange={event => setComment(event.target.value)} placeholder="Review the observed drift and exact rollback hash." /></label>
          {decideRollback.isError && <span role="alert"><TriangleAlert size={12} />{decideRollback.error.message}</span>}
          <div><button type="button" className="button button-secondary" disabled={decideRollback.isPending || comment.trim().length < 8} onClick={() => decideRollback.mutate('reject')}><X size={12} />Reject rollback</button><button type="button" className="button button-primary" disabled={decideRollback.isPending} onClick={() => decideRollback.mutate('approve')}><ShieldCheck size={12} />Approve rollback hash</button></div>
        </div>
      )}
      {monitor.status === 'rollback_approved' && (
        <div className="incident-change-plan-execute">
          <small>Approved by {monitor.decidedByUsername}. Execution is bound to the displayed rollback hash.</small>
          {executeRollback.isError && <span role="alert"><TriangleAlert size={12} />{executeRollback.error.message}</span>}
          <button type="button" className="button button-primary" disabled={executeRollback.isPending} onClick={() => executeRollback.mutate()}><RefreshCw size={12} />{executeRollback.isPending ? 'Rolling back and verifying…' : 'Execute approved rollback'}</button>
        </div>
      )}
      {monitor.status === 'rollback_rejected' && <div className="incident-change-plan-result is-warning"><X size={13} />Rollback rejected; evidence retained.</div>}
      {monitor.status === 'rolling_back' && <small>Rollback execution claimed. Verification is in progress…</small>}
      {monitor.status === 'rolled_back' && <div className="incident-change-plan-result is-warning"><RefreshCw size={13} />{scalePlan ? 'Previous replica count restored and verified.' : 'Previous provider state restored and verified.'}</div>}
      {monitor.status === 'rollback_failed' && <div className="incident-change-plan-result is-error"><TriangleAlert size={13} />Rollback could not be verified. Manual intervention is required.</div>}
      {monitor.rollbackError && <p className="incident-change-plan-error">{monitor.rollbackError}</p>}
    </section>
  );
}

function RemediationChangePlanPanel({
  incidentId,
  proposal,
  onRemediationUpdate,
}: {
  incidentId: number;
  proposal: IncidentRemediation;
  onRemediationUpdate: (remediation: IncidentRemediation) => void;
}) {
  const [workloadKind, setWorkloadKind] = useState<'Deployment' | 'StatefulSet'>('Deployment');
  const [workloadName, setWorkloadName] = useState('');
  const [desiredReplicas, setDesiredReplicas] = useState(2);
  const [targetRevision, setTargetRevision] = useState(1);
  const [approvalComment, setApprovalComment] = useState('');
  const plan = proposal.changePlans?.[0] ?? null;
  const latestDryRun = proposal.dryRuns?.[0] ?? null;
  const adapters = useQuery({
    queryKey: ['incident-remediation-write-adapters', incidentId, proposal.id, latestDryRun?.id ?? 0],
    queryFn: () => getIncidentRemediationWriteAdapters(incidentId, proposal.id),
    enabled: proposal.status === 'approved' && !plan,
    staleTime: 10_000,
  });
  const adapter = adapters.data?.adapters.find(item => item.status === 'ready')
    ?? adapters.data?.adapters[0]
    ?? null;
  const requestedWorkloadKind = adapter?.intent?.workloadKind ?? workloadKind;
  const requestedWorkloadName = adapter?.intent?.workloadName ?? workloadName.trim();
  const requestedDesiredReplicas = adapter?.intent && 'desiredReplicas' in adapter.intent
    ? adapter.intent.desiredReplicas : desiredReplicas;
  const requestedTargetRevision = adapter?.intent && 'targetRevision' in adapter.intent
    ? adapter.intent.targetRevision : targetRevision;
  const revisionAdapter = adapter?.adapterKey === 'kubernetes.deployment-revision-rollback.v1';
  const scalePlan = plan?.adapterKey === 'kubernetes.scale.v1';
  const prepare = useMutation({
    mutationFn: () => {
      if (!adapter || adapter.status !== 'ready' || adapter.bundleId == null || !adapter.writeToolName) {
        throw new Error('No eligible governed-write adapter is available.');
      }
      return createIncidentRemediationChangePlan(incidentId, proposal.id, {
        version: proposal.version,
        adapterKey: adapter.adapterKey,
        bundleId: adapter.bundleId,
        writeToolName: adapter.writeToolName,
        workloadKind: requestedWorkloadKind,
        workloadName: requestedWorkloadName,
        ...(revisionAdapter
          ? { targetRevision: requestedTargetRevision }
          : { desiredReplicas: requestedDesiredReplicas }),
      });
    },
    onSuccess: ({ remediation }) => onRemediationUpdate(remediation),
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => {
      if (!plan) throw new Error('Change plan is unavailable.');
      return decideIncidentRemediationChangePlan(incidentId, proposal.id, plan.id, {
        version: plan.version,
        planHash: plan.planHash,
        decision,
        comment: approvalComment.trim() || null,
      });
    },
    onSuccess: ({ remediation }) => onRemediationUpdate(remediation),
  });
  const execute = useMutation({
    mutationFn: () => {
      if (!plan) throw new Error('Change plan is unavailable.');
      return executeIncidentRemediationChangePlan(incidentId, proposal.id, plan.id, {
        version: plan.version,
        planHash: plan.planHash,
      });
    },
    onSuccess: ({ remediation }) => onRemediationUpdate(remediation),
  });

  if (!plan) {
    if (proposal.status !== 'approved' || !latestDryRun) return null;
    return (
      <section className="incident-change-plan">
        <header><span><ShieldCheck size={12} />Provider change plan</span><small>preview + second approval</small></header>
        {adapters.isLoading && <small>Checking governed-write adapters and connector certificationâ€¦</small>}
        {adapters.isError && <span role="alert"><TriangleAlert size={12} />{adapters.error.message}</span>}
        {adapter?.status === 'unavailable' && <div className="incident-change-plan-unavailable"><TriangleAlert size={13} /><span>{adapter.reason}</span></div>}
        {adapter?.status === 'ready' && (
          <>
            <p>{adapter.description}</p>
            <div className="incident-change-plan-fields">
              <label><span>Workload kind</span><select disabled={Boolean(adapter.intent)} value={requestedWorkloadKind} onChange={event => setWorkloadKind(event.target.value as 'Deployment' | 'StatefulSet')}><option>Deployment</option><option>StatefulSet</option></select></label>
              <label><span>Workload name</span><input disabled={Boolean(adapter.intent)} value={requestedWorkloadName} onChange={event => setWorkloadName(event.target.value)} placeholder="checkout-api" /></label>
              {revisionAdapter ? (
                <label><span>Retained target revision</span><input disabled={Boolean(adapter.intent)} type="number" min={1} max={1_000_000_000} value={requestedTargetRevision} onChange={event => setTargetRevision(Number(event.target.value))} /></label>
              ) : (
                <label><span>Desired replicas</span><input disabled={Boolean(adapter.intent)} type="number" min={adapter.replicas?.minimum ?? 1} max={adapter.replicas?.maximum ?? 50} value={requestedDesiredReplicas} onChange={event => setDesiredReplicas(Number(event.target.value))} /></label>
              )}
            </div>
            <small>{adapter.bundleLabel} · {adapter.writeBackendName} · namespace {adapter.target?.namespace}</small>
            <small>{adapter.controls.riskLevel} risk · hash-bound approval · read-after-write verification · verified rollback · delayed drift check</small>
            {prepare.isError && <span role="alert"><TriangleAlert size={12} />{prepare.error.message}</span>}
            <button className="button button-primary" type="button" disabled={prepare.isPending || !requestedWorkloadName || (revisionAdapter ? requestedTargetRevision < 1 : requestedDesiredReplicas < 1 || requestedDesiredReplicas > 50)} onClick={() => prepare.mutate()}>
              <GitBranch size={12} />{prepare.isPending ? 'Reading current provider stateâ€¦' : 'Prepare immutable preview'}
            </button>
          </>
        )}
      </section>
    );
  }

  return (
    <section className={`incident-change-plan is-${plan.status}`}>
      <header><span><GitBranch size={12} />Kubernetes change #{plan.id}</span><b>{plan.status.replaceAll('_', ' ')}</b></header>
      <p>{plan.preview.summary}</p>
      <pre className="incident-change-plan-diff">{plan.preview.lines.join('\n')}</pre>
      <dl>
        <div><dt>Plan hash</dt><dd title={plan.planHash}>{plan.planHash.slice(0, 16)}â€¦</dd></div>
        <div><dt>Tool</dt><dd>{plan.writeToolName}</dd></div>
        <div><dt>Rollback</dt><dd>{plan.preview.rollbackSummary}</dd></div>
      </dl>
      {plan.status === 'awaiting_approval' && (
        <div className="incident-change-plan-approval">
          <label><span>Second approval note</span><textarea value={approvalComment} maxLength={2_000} onChange={event => setApprovalComment(event.target.value)} placeholder="Review the exact target, replica diff and rollback before approval." /></label>
          {decide.isError && <span role="alert"><TriangleAlert size={12} />{decide.error.message}</span>}
          <div><button className="button button-secondary" type="button" disabled={decide.isPending || approvalComment.trim().length < 8} onClick={() => decide.mutate('reject')}><X size={12} />Reject plan</button><button className="button button-primary" type="button" disabled={decide.isPending} onClick={() => decide.mutate('approve')}><CheckCircle2 size={12} />Approve exact hash</button></div>
        </div>
      )}
      {plan.status === 'approved' && (
        <div className="incident-change-plan-execute">
          <small>Approved by {plan.approvedByUsername}. Execution is bound to this exact plan hash.</small>
          {execute.isError && <span role="alert"><TriangleAlert size={12} />{execute.error.message}</span>}
          <button className="button button-primary" type="button" disabled={execute.isPending} onClick={() => execute.mutate()}><Play size={12} />{execute.isPending ? 'Executing and verifyingâ€¦' : 'Execute approved change'}</button>
        </div>
      )}
      {plan.status === 'executing' && <small>Execution claimed. Verification is in progressâ€¦</small>}
      {plan.status === 'verified' && <div className="incident-change-plan-result is-success"><CheckCircle2 size={13} />{scalePlan ? 'Desired replica count verified.' : 'Approved desired state verified.'}</div>}
      {plan.status === 'rolled_back' && <div className="incident-change-plan-result is-warning"><RefreshCw size={13} />{plan.postChangeMonitor?.status === 'rolled_back' ? (scalePlan ? 'Post-change drift was rolled back to the previous replica count.' : 'Post-change drift was rolled back to the previous provider state.') : (scalePlan ? 'Verification failed; the previous replica count was restored.' : 'Verification failed; the previous provider state was restored.')}</div>}
      {plan.status === 'rollback_failed' && <div className="incident-change-plan-result is-error"><TriangleAlert size={13} />Rollback could not be verified. Manual intervention is required.</div>}
      {plan.executionError && <p className="incident-change-plan-error">{plan.executionError}</p>}
      {plan.verificationError && <p className="incident-change-plan-error">{plan.verificationError}</p>}
      <PostChangeMonitorPanel incidentId={incidentId} proposal={proposal} plan={plan} onRemediationUpdate={onRemediationUpdate} />
    </section>
  );
}

function RemediationProposalCard({
  incidentId,
  proposal,
  pending,
  error,
  onDecision,
  onRemediationUpdate,
}: {
  incidentId: number;
  proposal: IncidentRemediation;
  pending: boolean;
  error: string | null;
  onDecision: (decision: 'approve' | 'reject', comment: string | null) => void;
  onRemediationUpdate: (remediation: IncidentRemediation) => void;
}) {
  const [comment, setComment] = useState(proposal.decisionComment ?? '');
  const [selectedExecutor, setSelectedExecutor] = useState('');
  const [argumentValues, setArgumentValues] = useState<Record<string, string | number | boolean>>({});
  const executorCandidates = useQuery({
    queryKey: ['incident-remediation-executors', incidentId, proposal.id],
    queryFn: () => getIncidentRemediationExecutorCandidates(incidentId, proposal.id),
    enabled: proposal.status === 'approved',
    staleTime: 30_000,
  });
  const candidateKey = (candidate: IncidentRemediationExecutorCandidate) => `${candidate.bundleId}:${candidate.toolName}`;
  const selectedCandidate = executorCandidates.data?.candidates.find(candidate => candidateKey(candidate) === selectedExecutor)
    ?? executorCandidates.data?.candidates[0]
    ?? null;
  const effectiveArguments = selectedCandidate ? Object.fromEntries(selectedCandidate.parameters.flatMap(parameter => {
    const value = argumentValues[parameter.name] ?? parameter.suggestedValue;
    return value === undefined || value === '' ? [] : [[parameter.name, value]];
  })) as Record<string, string | number | boolean> : {};
  const missingArguments = selectedCandidate?.parameters
    .filter(parameter => parameter.required && effectiveArguments[parameter.name] === undefined)
    .map(parameter => parameter.name) ?? [];
  const dryRun = useMutation({
    mutationFn: () => {
      if (!selectedCandidate) throw new Error('Select a read-only MCP tool.');
      return runIncidentRemediationDryRun(incidentId, proposal.id, {
        version: proposal.version,
        bundleId: selectedCandidate.bundleId,
        toolName: selectedCandidate.toolName,
        arguments: effectiveArguments,
      });
    },
    onSuccess: ({ remediation }) => onRemediationUpdate(remediation),
  });
  const rejectionReady = comment.trim().length >= 8;
  const scope = proposal.targetScope;
  const scopeLabel = scope
    ? [scope['cluster'], scope['namespace'], scope['environment']]
      .filter(value => typeof value === 'string').join(' · ')
    : '';
  return (
    <article className={`incident-remediation-proposal is-${proposal.status}`}>
      <header>
        <span className={`is-${proposal.riskLevel}`}>{proposal.riskLevel} risk</span>
        <em>{proposal.priority}</em>
        <b>{proposal.status}</b>
      </header>
      <h4>{proposal.action}</h4>
      <p>{proposal.rationale}</p>
      <dl>
        <div><dt>Mode</dt><dd>{proposal.executionMode.replaceAll('_', ' ')}</dd></div>
        <div><dt>Executor</dt><dd>{proposal.executorToolName ?? 'Not assigned'}</dd></div>
        <div><dt>Scope</dt><dd>{scopeLabel || 'Incident boundary only'}</dd></div>
        <div><dt>Write intent</dt><dd>{remediationIntentLabel(proposal.executionIntent)}</dd></div>
        <div><dt>Source</dt><dd>Task {proposal.taskId.slice(0, 12)}</dd></div>
      </dl>
      {proposal.status === 'proposed' ? (
        <div className="incident-remediation-decision">
          <label htmlFor={`remediation-comment-${proposal.id}`}>Operator note</label>
          <textarea
            id={`remediation-comment-${proposal.id}`}
            aria-label={`Operator note for ${proposal.action}`}
            value={comment}
            maxLength={2_000}
            placeholder="Required when rejecting; optional approval rationale."
            onChange={event => setComment(event.target.value)}
          />
          <small>Approval records intent only. No tool or cluster action is executed.</small>
          {error && <span role="alert"><TriangleAlert size={12} />{error}</span>}
          <div>
            <button type="button" className="button button-secondary" disabled={pending || !rejectionReady} onClick={() => onDecision('reject', comment.trim())}><X size={12} />Reject</button>
            <button type="button" className="button button-primary" disabled={pending} onClick={() => onDecision('approve', comment.trim() || null)}><CheckCircle2 size={12} />Approve proposal</button>
          </div>
        </div>
      ) : proposal.status === 'approved' ? (
        <div className="incident-remediation-executor">
          <header>
            <span><ShieldCheck size={12} />Read-only evidence run</span>
            <small>{proposal.decidedByUsername ?? 'Operator'} approved · provider changes require a separate hash-bound plan</small>
          </header>
          {executorCandidates.isLoading && <small>Loading eligible tools from the incident bundle…</small>}
          {executorCandidates.isError && <span role="alert"><TriangleAlert size={12} />{executorCandidates.error.message}</span>}
          {executorCandidates.data?.candidates.length === 0 && <small>No eligible read-only tool is configured in the incident bundle.</small>}
          {selectedCandidate && (
            <>
              <label htmlFor={`remediation-executor-${proposal.id}`}>Bundle / MCP tool</label>
              <select
                id={`remediation-executor-${proposal.id}`}
                value={candidateKey(selectedCandidate)}
                onChange={event => { setSelectedExecutor(event.target.value); setArgumentValues({}); }}
              >
                {executorCandidates.data?.candidates.map(candidate => (
                  <option key={candidateKey(candidate)} value={candidateKey(candidate)}>
                    {candidate.bundleLabel} · {candidate.toolName}
                  </option>
                ))}
              </select>
              <p>{selectedCandidate.description}</p>
              {selectedCandidate.parameters.length > 0 && (
                <div className="incident-remediation-arguments">
                  {selectedCandidate.parameters.map(parameter => {
                    const value = argumentValues[parameter.name] ?? parameter.suggestedValue ?? '';
                    return (
                      <label key={parameter.name}>
                        <span>{parameter.name}{parameter.required ? ' *' : ''}{parameter.locked ? <em>incident-bound</em> : null}</span>
                        {parameter.type === 'boolean' ? (
                          <select
                            aria-label={`${parameter.name} argument`}
                            disabled={parameter.locked || dryRun.isPending}
                            value={String(value)}
                            onChange={event => setArgumentValues(current => ({ ...current, [parameter.name]: event.target.value === 'true' }))}
                          >
                            {!parameter.required && <option value="">Unset</option>}
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <input
                            aria-label={`${parameter.name} argument`}
                            disabled={parameter.locked || dryRun.isPending}
                            type={parameter.type === 'number' ? 'number' : 'text'}
                            value={String(value)}
                            placeholder={parameter.description}
                            onChange={event => {
                              const next = parameter.type === 'number' && event.target.value !== ''
                                ? Number(event.target.value) : event.target.value;
                              setArgumentValues(current => ({ ...current, [parameter.name]: next }));
                            }}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
              {missingArguments.length > 0 && <small>Required: {missingArguments.join(', ')}</small>}
              {dryRun.isError && <span role="alert"><TriangleAlert size={12} />{dryRun.error.message}</span>}
              <button
                type="button"
                className="button button-primary"
                disabled={dryRun.isPending || missingArguments.length > 0}
                onClick={() => dryRun.mutate()}
              >
                <Play size={12} />{dryRun.isPending ? 'Running evidence check…' : 'Run read-only validation'}
              </button>
            </>
          )}
          {proposal.dryRuns?.[0] && (
            <article className={`incident-remediation-dry-run is-${proposal.dryRuns[0].status}`}>
              <header><b>{proposal.dryRuns[0].status}</b><span>{proposal.dryRuns[0].toolName}</span><time>{formatIncidentTimestamp(proposal.dryRuns[0].startedAt)}</time></header>
              {proposal.dryRuns[0].resultPreview && <pre>{proposal.dryRuns[0].resultPreview}</pre>}
              {proposal.dryRuns[0].errorMessage && <p>{proposal.dryRuns[0].errorMessage}</p>}
              <small>Evidence trace {proposal.dryRuns[0].executionTraceId.slice(0, 12)} · stored and redacted by Argus Core</small>
            </article>
          )}
        </div>
      ) : (
        <footer>
          <span>{proposal.decidedByUsername ?? 'Unknown operator'} · {proposal.decidedAt ? formatIncidentTimestamp(proposal.decidedAt) : 'decision recorded'}</span>
          {proposal.decisionComment && <p>{proposal.decisionComment}</p>}
          <small>{proposal.status === 'rejected' ? 'No execution will be scheduled.' : 'Execution lifecycle evidence is retained by Argus Core.'}</small>
        </footer>
      )}
      <RemediationChangePlanPanel incidentId={incidentId} proposal={proposal} onRemediationUpdate={onRemediationUpdate} />
    </article>
  );
}

function IncidentAiopsFeedbackControl({
  incidentId,
  investigation,
}: {
  incidentId: number;
  investigation: IncidentAiopsInvestigation;
}) {
  const queryClient = useQueryClient();
  const [verdict, setVerdict] = useState<IncidentAiopsFeedbackVerdict | null>(null);
  const [reason, setReason] = useState<IncidentAiopsFeedbackReason | ''>('');
  const [comment, setComment] = useState('');
  const feedback = useQuery({
    queryKey: ['incident-aiops-rca-feedback', incidentId, investigation.id],
    queryFn: () => getIncidentAiopsFeedback(incidentId, investigation.id),
    enabled: investigation.state === 'TASK_STATE_COMPLETED' && Boolean(investigation.rootTraceId && investigation.result),
    staleTime: 30_000,
  });
  const current = feedback.data?.currentUserFeedback;
  useEffect(() => {
    if (!current) return;
    setVerdict(current.verdict);
    setReason(current.reason);
    setComment(current.comment ?? '');
  }, [current?.id]);
  const submit = useMutation({
    mutationFn: () => submitIncidentAiopsFeedback(incidentId, investigation.id, {
      verdict: verdict!,
      reason: reason as IncidentAiopsFeedbackReason,
      comment: comment.trim() || null,
    }),
    onSuccess: result => {
      queryClient.setQueryData<IncidentAiopsFeedbackResponse>(
        ['incident-aiops-rca-feedback', incidentId, investigation.id],
        result,
      );
      void queryClient.invalidateQueries({ queryKey: ['aiops-outcomes'] });
    },
  });
  const chooseVerdict = (next: IncidentAiopsFeedbackVerdict) => {
    setVerdict(next);
    if (!reason) {
      setReason(next === 'helpful' ? 'accurate_root_cause' : next === 'partial' ? 'incomplete_evidence' : 'incorrect_root_cause');
    }
  };

  return (
    <section className="incident-aiops-feedback" aria-label="AIOps RCA feedback">
      <header>
        <div>
          <b>Was this RCA useful?</b>
          <small>Human review is bound to this trace and immutable profile revision.</small>
        </div>
        {feedback.data && (
          <span>{feedback.data.summary.reviews} review{feedback.data.summary.reviews === 1 ? '' : 's'} · {feedback.data.summary.helpfulPercent ?? 0}% helpful</span>
        )}
      </header>
      <div className="incident-aiops-feedback-verdicts">
        {(['helpful', 'partial', 'incorrect'] as const).map(value => (
          <button
            type="button"
            key={value}
            className={verdict === value ? `is-selected is-${value}` : ''}
            onClick={() => chooseVerdict(value)}
          >
            {value === 'helpful' ? 'Helpful' : value === 'partial' ? 'Partly useful' : 'Incorrect'}
          </button>
        ))}
      </div>
      {verdict && (
        <div className="incident-aiops-feedback-form">
          <label>
            <span>Reason</span>
            <select aria-label="RCA review reason" value={reason} onChange={event => setReason(event.target.value as IncidentAiopsFeedbackReason)}>
              <option value="" disabled>Select a reason</option>
              {rcaFeedbackReasons.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span>Reviewer note <em>optional</em></span>
            <textarea
              aria-label="RCA reviewer note"
              maxLength={2000}
              rows={2}
              value={comment}
              onChange={event => setComment(event.target.value)}
              placeholder="What should the next investigation do better?"
            />
          </label>
          <div className="incident-aiops-feedback-actions">
            <small>
              Trace <code>{investigation.rootTraceId?.slice(0, 8)}</code>
              {investigation.executionContext.serviceProfile
                ? <> · Profile #{investigation.executionContext.serviceProfile.id} r{investigation.executionContext.serviceProfile.revision}</>
                : ' · Legacy run without profile'}
            </small>
            <button type="button" className="button button-primary" disabled={!reason || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? 'Saving…' : current ? 'Update review' : 'Save review'}
            </button>
          </div>
          {submit.isSuccess && <p className="incident-aiops-feedback-state is-success"><CheckCircle2 size={12} />Review retained in the canonical audit trail.</p>}
          {submit.error && <p className="incident-aiops-feedback-state is-error"><CircleAlert size={12} />{submit.error.message}</p>}
        </div>
      )}
      {feedback.isLoading && <p className="incident-aiops-feedback-state">Loading prior reviews…</p>}
      {feedback.error && <p className="incident-aiops-feedback-state is-error"><CircleAlert size={12} />Review history could not be loaded.</p>}
    </section>
  );
}

function IncidentInvestigation({
  incident,
  rule,
  history,
  onSelectIncident,
}: {
  incident: NativeAlertIncident;
  rule?: NativeAlertRule;
  history: NativeAlertIncident[];
  onSelectIncident: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const correlations = useQuery({
    queryKey: ['native-alert-incident-correlations', incident.id],
    queryFn: () => getIncidentChangeCorrelations(incident.id),
    staleTime: 30_000,
  });
  const impact = useQuery({
    queryKey: ['native-alert-incident-impact', incident.id],
    queryFn: () => getIncidentImpact(incident.id),
    staleTime: 30_000,
  });
  const aiops = useQuery({
    queryKey: ['native-alert-aiops-investigations', incident.id],
    queryFn: () => getIncidentAiopsInvestigations(incident.id),
    refetchInterval: query => query.state.data?.investigations.some(item => !terminalAiopsStates.has(item.state))
      || ['pending', 'dispatching'].includes(query.state.data?.automation?.status ?? '')
      ? 3_000
      : false,
  });
  const remediationDecision = useMutation({
    mutationFn: ({ proposal, decision, comment }: { proposal: IncidentRemediation; decision: 'approve' | 'reject'; comment: string | null }) =>
      decideIncidentRemediation(incident.id, proposal.id, { decision, version: proposal.version, comment }),
    onSuccess: ({ remediation }) => {
      queryClient.setQueryData<IncidentAiopsInvestigationsResponse>(
        ['native-alert-aiops-investigations', incident.id],
        current => current ? {
          ...current,
          remediations: current.remediations.map(item => item.id === remediation.id ? remediation : item),
        } : current,
      );
    },
  });
  const metric = incidentMetric(incident, rule);
  const baseline = safeIncidentBaseline(incident.context);
  const exemplars = safeIncidentExemplars(incident.context);
  const dominant = strongestDominantSpan(exemplars);
  const comparisonCurrent = baseline?.currentValue ?? incident.metricValue;
  const comparisonReference = baseline?.value ?? incident.threshold;
  const comparisonMax = Math.max(Math.abs(comparisonCurrent), Math.abs(comparisonReference), 0.000001);
  const delta = baseline && baseline.value !== 0
    ? ((baseline.currentValue - baseline.value) / Math.abs(baseline.value)) * 100
    : null;
  const largestExemplar = [...exemplars].sort((left, right) => (
    metric === 'cost_regression_percent' || metric === 'total_cost_usd'
      ? right.costUsd - left.costUsd
      : right.durationMs - left.durationMs
  ))[0];
  const previousEpisodes = history.filter(candidate => candidate.ruleId === incident.ruleId && candidate.id !== incident.id).slice(0, 4);
  const correlatedSignals = incident.correlation
    ? history
      .filter(candidate => candidate.correlation?.groupId === incident.correlation?.groupId)
      .sort((left, right) => Date.parse(left.triggeredAt) - Date.parse(right.triggeredAt))
    : [];
  const latestAiops = aiops.data?.investigations[0];
  const aiopsAutomation = aiops.data?.automation;
  const aiopsResult = latestAiops?.result;

  return (
    <section className={`panel incident-investigation is-${incident.state}`} aria-labelledby="incident-investigation-title">
      <div className="incident-investigation-heading">
        <div>
          <span className="eyebrow">INCIDENT COCKPIT · INCIDENT #{incident.id}</span>
          <h2 id="incident-investigation-title">{incident.ruleName}</h2>
          <p>{incident.message}</p>
        </div>
        <div className="incident-investigation-state">
          <a className="button button-primary incident-aiops-handoff" href={aiOpsIncidentHref(incident)}><Activity size={13} />Run Argus AIOps<ExternalLink size={12} /></a>
          <span className={`alert-severity severity-${incident.severity}`}>{incident.severity}</span>
          <b><i />{incident.state}</b>
        </div>
      </div>

      <div className="incident-investigation-stats">
        <article><span>Observed signal</span><strong>{formatMetricValue(metric, incident.metricValue)}</strong><small>{metricLabels[metric]}</small></article>
        <article><span>Rule boundary</span><strong>{formatMetricValue(metric, incident.threshold)}</strong><small>{rule ? operatorLabels[rule.operator] : 'configured threshold'}</small></article>
        <article><span>Evidence</span><strong>{incident.sampleCount}</strong><small>{exemplars.length} exemplar run{exemplars.length === 1 ? '' : 's'}</small></article>
        <article><span>Duration</span><strong>{incidentDuration(incident)}</strong><small>{incident.state === 'firing' ? 'still firing' : 'until recovery'}</small></article>
      </div>

      {incident.correlation && (
        <section className="incident-correlation-summary" aria-label="Correlated incident group">
          <div className="incident-correlation-heading">
            <span><Network size={15} />CORRELATED INCIDENT #{incident.correlation.groupId}</span>
            <b>{incident.correlation.signalCount} signal{incident.correlation.signalCount === 1 ? '' : 's'} · {incident.correlation.service} · {incident.correlation.environment}</b>
            <small>{incident.correlation.correlationWindowMinutes} minute window · primary incident #{incident.correlation.primaryIncidentId}</small>
          </div>
          <div className="incident-correlation-reasons">
            {incident.correlation.groupingReasons.map(reason => (
              <span key={reason.code}><CheckCircle2 size={11} />{reason.summary}</span>
            ))}
          </div>
          <div className="incident-correlation-members">
            {correlatedSignals.map(signal => (
              <button type="button" className={signal.id === incident.id ? 'is-current' : ''} key={signal.id} onClick={() => onSelectIncident(signal.id)}>
                <i className={`is-${signal.state}`} />
                <span>#{signal.id} · {signal.ruleName}</span>
                <em>{signal.correlation?.role}</em>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="incident-investigation-grid">
        <div className="incident-analysis-column">
          <section className="incident-analysis-card">
            <header><span><BarChart3 size={14} />SIGNAL COMPARISON</span><small>{baseline ? `${baseline.windowDays}-day adaptive baseline` : 'configured rule boundary'}</small></header>
            <div className="incident-comparison-row">
              <div><span>Current</span><b>{formatComparisonValue(metric, comparisonCurrent)}</b></div>
              <i><em style={{ width: `${Math.max(3, Math.abs(comparisonCurrent) / comparisonMax * 100)}%` }} /></i>
            </div>
            <div className="incident-comparison-row is-reference">
              <div><span>{baseline ? 'Expected' : 'Threshold'}</span><b>{formatComparisonValue(metric, comparisonReference)}</b></div>
              <i><em style={{ width: `${Math.max(3, Math.abs(comparisonReference) / comparisonMax * 100)}%` }} /></i>
            </div>
            <footer>
              {baseline
                ? <><b>{delta == null ? 'Baseline comparison available' : `${Math.abs(delta).toFixed(1)}% ${delta >= 0 ? 'above' : 'below'} expected`}</b><span>{baseline.sampleCount} historical samples before the active window</span></>
                : <><b>{incident.sampleCount} samples evaluated</b><span>No historical baseline is required for this threshold rule.</span></>}
            </footer>
          </section>

          <section className="incident-analysis-card">
            <header><span><Activity size={14} />OBSERVED RCA LEADS</span><small>evidence, not causal proof</small></header>
            <div className="incident-findings">
              {baseline && <article><i className="is-red" /><div><b>Historical deviation</b><p>The current {metric === 'latency_regression_percent' ? 'P95 latency' : 'average cost'} is {delta == null ? 'different from' : `${Math.abs(delta).toFixed(1)}% ${delta >= 0 ? 'above' : 'below'}`} its {baseline.windowDays}-day baseline.</p></div></article>}
              {dominant && <article><i className="is-violet" /><div><b>{dominant.count > 1 ? 'Repeated dominant span' : 'Dominant span candidate'}</b><p><code>{dominant.label}</code> appears as the dominant span in {dominant.count} of {exemplars.length} exemplar run{exemplars.length === 1 ? '' : 's'}.</p></div></article>}
              {largestExemplar && <article><i className="is-amber" /><div><b>Largest observed exemplar</b><p>{largestExemplar.title} contributed {formatDuration(largestExemplar.durationMs)} runtime and ${largestExemplar.costUsd.toFixed(6)} recorded cost.</p></div></article>}
              {!baseline && exemplars.length === 0 && <article><i /><div><b>Run evidence pending</b><p>The alert has a valid signal, but no correlated agent or workflow exemplar was retained for this incident.</p></div></article>}
            </div>
          </section>

          {aiopsResult && (
            <section className={`incident-analysis-card incident-aiops-verdict is-${aiopsResult.conclusion}`}>
              <header>
                <span><ShieldCheck size={14} />AIOPS REVIEWER VERDICT</span>
                <small>{aiopsResult.quality} evidence · contract v{aiopsResult.sourceSchemaVersion}</small>
              </header>
              <div className="incident-aiops-verdict-summary">
                <div>
                  <span><i />{aiopsResult.conclusion}</span>
                  <h3>{aiopsResult.rootCause
                    ? aiopsResult.rootCause.targetName || aiopsResult.rootCause.statement
                    : 'No root cause confirmed'}</h3>
                  {aiopsResult.rootCause?.targetKind && <em>{aiopsResult.rootCause.targetKind}</em>}
                </div>
                {aiopsResult.rootCause && <strong>{aiopsResult.rootCause.confidence}%<small>confidence</small></strong>}
              </div>
              <p className="incident-aiops-assessment">{aiopsResult.executiveAssessment}</p>
              {aiopsResult.rootCause && (
                <div className="incident-aiops-root-cause">
                  <b>{aiopsResult.rootCause.statement}</b>
                  <p>{aiopsResult.rootCause.rationale}</p>
                  {aiopsResult.rootCause.candidateRef && <code>{aiopsResult.rootCause.candidateRef}</code>}
                </div>
              )}
              <div className="incident-aiops-result-grid">
                <section>
                  <header><b>Reviewer evidence</b><small>{aiopsResult.evidence.length} claims</small></header>
                  {aiopsResult.evidence.length > 0
                    ? aiopsResult.evidence.slice(0, 5).map((evidence, index) => (
                      <article key={`${evidence.lane}:${index}`}>
                        <em>{evidence.lane}</em>
                        <p>{evidence.claim}</p>
                        {evidence.sourceRefs.length > 0 && <small>{evidence.sourceRefs.join(' · ')}</small>}
                      </article>
                    ))
                    : <p className="incident-aiops-result-empty">No structured evidence claims were returned.</p>}
                </section>
                <section>
                  <header><b>Recommended next actions</b><small>no automatic writes</small></header>
                  {aiopsResult.recommendedActions.length > 0
                    ? aiopsResult.recommendedActions.slice(0, 5).map((action, index) => (
                      <article key={`${action.priority}:${index}`}>
                        <em className={`is-${action.priority}`}>{action.priority}</em>
                        <p>{action.action}</p>
                        <small>{action.rationale}{action.requiresApproval ? ' · approval required' : ''}</small>
                      </article>
                    ))
                    : <p className="incident-aiops-result-empty">No follow-up action was recommended.</p>}
                </section>
              </div>
              {aiopsResult.hypotheses.length > 0 && (
                <footer className="incident-aiops-hypotheses">
                  <span>Hypotheses</span>
                  <div>{aiopsResult.hypotheses.slice(0, 6).map(hypothesis => (
                    <span key={hypothesis.id} className={`is-${hypothesis.verdict}`} title={hypothesis.statement}>
                      {hypothesis.verdict} · {hypothesis.confidence}%
                    </span>
                  ))}</div>
                </footer>
              )}
              {latestAiops && <IncidentAiopsFeedbackControl key={latestAiops.id} incidentId={incident.id} investigation={latestAiops} />}
            </section>
          )}

          {aiops.data && aiops.data.remediations.length > 0 && (
            <section className="incident-analysis-card incident-remediation-control">
              <header>
                <span><ShieldCheck size={14} />GOVERNED REMEDIATION</span>
                <small>{aiops.data.remediations.filter(item => item.status === 'proposed').length} awaiting decision · proposal-only</small>
              </header>
              <p className="incident-remediation-intro">Reviewer recommendations are isolated from execution. A provider write requires validated evidence, an immutable preview and a second approval bound to its exact hash.</p>
              <div className="incident-remediation-list">
                {aiops.data.remediations.map(proposal => (
                  <RemediationProposalCard
                    key={proposal.id}
                    incidentId={incident.id}
                    proposal={proposal}
                    pending={remediationDecision.isPending && remediationDecision.variables?.proposal.id === proposal.id}
                    error={remediationDecision.isError && remediationDecision.variables?.proposal.id === proposal.id
                      ? remediationDecision.error.message : null}
                    onDecision={(decision, comment) => remediationDecision.mutate({ proposal, decision, comment })}
                    onRemediationUpdate={remediation => {
                      queryClient.setQueryData<IncidentAiopsInvestigationsResponse>(
                        ['native-alert-aiops-investigations', incident.id],
                        current => current ? {
                          ...current,
                          remediations: current.remediations.map(item => item.id === remediation.id ? remediation : item),
                        } : current,
                      );
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="incident-analysis-card incident-impact-card">
            <header>
              <span><Network size={14} />INCIDENT BLAST RADIUS</span>
              <small>{impact.data?.available
                ? `${impact.data.summary.upstreamServices} upstream · ${impact.data.summary.downstreamServices} downstream`
                : 'incident-scoped runtime evidence'}</small>
            </header>
            {impact.isLoading && <div className="incident-impact-state">Tracing service dependencies…</div>}
            {impact.error && <div className="incident-impact-state is-error">Dependency impact could not be loaded.</div>}
            {impact.data && !impact.data.available && <div className="incident-impact-state">{impact.data.reason}</div>}
            {impact.data?.available && (
              <>
                <div className="incident-impact-summary">
                  <article><span>Observed calls</span><b>{impact.data.summary.observedCalls}</b></article>
                  <article className={impact.data.summary.observedFailures > 0 ? 'is-danger' : ''}><span>Failures</span><b>{impact.data.summary.observedFailures}</b></article>
                  <article><span>External dependencies</span><b>{impact.data.summary.externalDependencies}</b></article>
                  <article className={impact.data.summary.failingDependencies > 0 ? 'is-danger' : ''}><span>Failing edges</span><b>{impact.data.summary.failingDependencies}</b></article>
                </div>
                {impact.data.rootCauseCandidates.length > 0 ? (
                  <div className="incident-root-cause-list">
                    {impact.data.rootCauseCandidates.slice(0, 4).map(candidate => (
                      <article key={`${candidate.sourceService}:${candidate.targetKind}:${candidate.targetName}:${candidate.relation}`} className={`confidence-${candidate.confidence}`}>
                        <i />
                        <div>
                          <header><b>{candidate.targetName}</b><em>{candidate.targetKind}</em><strong>{candidate.confidence}</strong></header>
                          <p>{candidate.reason}</p>
                          <small>{candidate.path.join(' → ')} · p95 {candidate.p95DurationMs == null ? 'n/a' : formatDuration(candidate.p95DurationMs)}</small>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : <div className="incident-impact-state">{impact.data.reason || 'No failing downstream dependency was observed inside the incident window.'}</div>}
                {impact.data.impactedServices.length > 0 && (
                  <div className="incident-impact-services">
                    <span>Affected service paths</span>
                    <div>{impact.data.impactedServices.slice(0, 8).map(item => (
                      <code key={`${item.direction}:${item.service}`}>{item.direction} · {item.path.join(' → ')}</code>
                    ))}</div>
                  </div>
                )}
                <footer><a href="/observe/dependencies?view=services">Open service topology <ExternalLink size={11} /></a><span>{impact.data.window.minutesBefore}m before · {impact.data.window.minutesAfter}m after incident</span></footer>
              </>
            )}
          </section>

          <section className="incident-analysis-card incident-change-card">
            <header>
              <span><GitBranch size={14} />CHANGE CORRELATION</span>
              <small>{correlations.data ? `${correlations.data.summary.direct} direct · ${correlations.data.summary.contextual} contextual` : '6h before · incident window'}</small>
            </header>
            {correlations.isLoading && <div className="incident-change-state">Correlating platform changes…</div>}
            {correlations.error && <div className="incident-change-state is-error">Change evidence could not be loaded.</div>}
            {correlations.data && correlations.data.changes.length === 0 && <div className="incident-change-state">No audited platform changes occurred inside this correlation window.</div>}
            {correlations.data && correlations.data.changes.length > 0 && (
              <div className="incident-change-list">
                {correlations.data.changes.slice(0, 8).map(change => (
                  <article key={change.id} className={`relevance-${change.relevance}`}>
                    <i />
                    <div>
                      <header><b>{change.objectLabel}</b><em>{change.kind}</em><em className={`is-${change.relevance}`}>{change.relevance}</em></header>
                      <p>{change.action} by {change.actor} · {formatChangeOffset(change.minutesFromTrigger)}</p>
                      <small>{change.reason}{change.changedFields.length > 0 ? ` Changed: ${change.changedFields.join(', ')}.` : ''}</small>
                    </div>
                  </article>
                ))}
                {correlations.data.changes.length > 8 && <footer>+{correlations.data.changes.length - 8} additional temporal changes retained by the API</footer>}
              </div>
            )}
          </section>
        </div>

        <aside className="incident-investigation-aside">
          <section className="incident-analysis-card incident-aiops-card">
            <header><span><Activity size={14} />ARGUS AIOPS</span><small>{aiops.data?.total ? `${aiops.data.total} investigation${aiops.data.total === 1 ? '' : 's'}` : 'governed workflow'}</small></header>
            {aiops.isLoading && <div className="incident-aiops-state">Loading investigation statusâ€¦</div>}
            {aiops.error && <div className="incident-aiops-state is-error">Investigation status is currently unavailable.</div>}
            {!aiops.isLoading && !aiops.error && !latestAiops && aiopsAutomation && <div className={`incident-aiops-automation is-${aiopsAutomation.status}`}>
              <div><i /><b>Automatic investigation {aiopsAutomation.status}</b></div>
              <p>{aiopsAutomation.lastError || `Scoped to ${aiopsAutomation.service} in ${aiopsAutomation.environment}.`}</p>
              <small>{aiopsAutomation.attemptCount} dispatch attempt{aiopsAutomation.attemptCount === 1 ? '' : 's'} · bundle {aiopsAutomation.bundleIds.join(', ')}</small>
            </div>}
            {!aiops.isLoading && !aiops.error && !latestAiops && !aiopsAutomation && <div className="incident-aiops-empty"><p>No AIOps investigation has been linked to this incident yet.</p><a href={aiOpsIncidentHref(incident)}>Start investigation <ChevronRight size={12} /></a></div>}
            {latestAiops && <div className="incident-aiops-run">
              <div className="incident-aiops-run-heading">
                <span className={`is-${aiopsStateLabel(latestAiops.state).replace(/\s+/g, '-')}`}><i />{aiopsStateLabel(latestAiops.state)}</span>
                {latestAiops.quality && <em>{latestAiops.quality}</em>}
              </div>
              <b>Task {latestAiops.taskId}</b>
              {latestAiops.summary && <p>{latestAiops.summary}</p>}
              <div className="incident-aiops-boundary">
                <span>Frozen execution boundary</span>
                <b>{latestAiops.executionContext.service || 'Unscoped service'} · {latestAiops.executionContext.environment || 'Unscoped environment'}</b>
                <small>Bundle{latestAiops.executionContext.bundleIds.length === 1 ? '' : 's'} {latestAiops.executionContext.bundleIds.join(', ') || 'none'}{latestAiops.executionContext.resourceScope ? ` · ${latestAiops.executionContext.resourceScope.namespace}` : ' · no provider scope'}</small>
              </div>
              {!latestAiops.statusAvailable && <small>Showing the latest persisted status; the Pack is currently unavailable.</small>}
              <div className="incident-aiops-links">
                <a href={`/solutions/${encodeURIComponent(latestAiops.packId)}?task=${encodeURIComponent(latestAiops.taskId)}`}>Open investigation <ExternalLink size={12} /></a>
                {latestAiops.rootTraceId && <a href={`/runs/workflow/${encodeURIComponent(latestAiops.rootTraceId)}`}>Open trace <GitBranch size={12} /></a>}
              </div>
              {aiops.data && aiops.data.investigations.length > 1 && <div className="incident-aiops-history">{aiops.data.investigations.slice(1, 4).map(item => <a key={item.id} href={`/solutions/${encodeURIComponent(item.packId)}?task=${encodeURIComponent(item.taskId)}`}><span>{aiopsStateLabel(item.state)}</span><small>{timeAgo(item.createdAt)}</small></a>)}</div>}
            </div>}
          </section>

          <section className="incident-analysis-card">
            <header><span>INCIDENT TIMELINE</span></header>
            <ol className="incident-timeline">
              <li className="is-alert"><i /><div><b>Threshold breached</b><span>{formatIncidentTimestamp(incident.triggeredAt)}</span></div></li>
              {incident.correlation && <li className="is-correlated"><i /><div><b>{incident.correlation.role === 'primary' ? 'Correlation group opened' : `Correlated with incident #${incident.correlation.primaryIncidentId}`}</b><span>{formatIncidentTimestamp(incident.correlation.groupedAt)} · {incident.correlation.groupingReasons.map(reason => reason.code.replaceAll('_', ' ')).join(' · ')}</span></div></li>}
              {incident.notifiedAt && <li><i /><div><b>Notification dispatched</b><span>{formatIncidentTimestamp(incident.notifiedAt)}</span></div></li>}
              {incident.recoveredAt
                ? <li className="is-recovered"><i /><div><b>Automatically recovered</b><span>{formatIncidentTimestamp(incident.recoveredAt)}</span></div></li>
                : <li className="is-current"><i /><div><b>Investigation active</b><span>Firing for {incidentDuration(incident)}</span></div></li>}
            </ol>
          </section>

          <section className="incident-analysis-card">
            <header><span>RELATED EPISODES</span><small>same signal policy</small></header>
            {previousEpisodes.length > 0 ? <div className="incident-history-list">{previousEpisodes.map(previous => (
              <button type="button" key={previous.id} onClick={() => onSelectIncident(previous.id)}>
                <i className={`is-${previous.state}`} />
                <span><b>Incident #{previous.id}</b><small>{timeAgo(previous.triggeredAt)} · {incidentDuration(previous)}</small></span>
                <ChevronRight size={12} />
              </button>
            ))}</div> : <p className="incident-no-history">No earlier episodes of this policy appear in the latest 100 incidents.</p>}
          </section>
        </aside>
      </div>

      {exemplars.length > 0 && (
        <section className="incident-exemplar-table">
          <header><div><span className="eyebrow">CORRELATED EVIDENCE</span><h3>Exemplar runs</h3></div><small>Open a run at its dominant span</small></header>
          <div>{exemplars.map((exemplar, index) => (
            <a href={exemplar.href} key={`${exemplar.traceId}:${exemplar.spanId ?? 'run'}`}>
              <em>{String(index + 1).padStart(2, '0')}</em>
              <span><b>{exemplar.title}</b><small>{exemplar.runKind} · {timeAgo(exemplar.startedAt)}</small></span>
              <span><b>{exemplar.dominantSpanLabel || 'Run root'}</b><small>dominant evidence</small></span>
              <span><b>{formatDuration(exemplar.durationMs)}</b><small>${exemplar.costUsd.toFixed(6)}</small></span>
              <ExternalLink size={13} />
            </a>
          ))}</div>
        </section>
      )}
    </section>
  );
}

function editorValue(rule: NativeAlertRule): NativeAlertRuleMutation {
  const { id: _id, lastState: _lastState, lastValue: _lastValue, lastSampleCount: _lastSampleCount,
    lastEvaluatedAt: _lastEvaluatedAt, lastTriggeredAt: _lastTriggeredAt, createdAt: _createdAt,
    updatedAt: _updatedAt, openIncidentId: _openIncidentId, ...input } = rule;
  return input;
}

function AlertRuleEditor({
  initial,
  fabric,
  serviceCatalog,
  catalogRefreshPending,
  catalogRefreshError,
  catalogRefreshSummary,
  pending,
  error,
  onCancel,
  onSave,
  onRefreshCatalog,
}: {
  initial: NativeAlertRuleMutation;
  fabric: FabricManagementResponse | null;
  serviceCatalog: NativeServiceCatalogResponse | null;
  catalogRefreshPending: boolean;
  catalogRefreshError: string | null;
  catalogRefreshSummary: string | null;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (input: NativeAlertRuleMutation) => void;
  onRefreshCatalog: (input: NativeServiceCatalogRefreshInput) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const set = <K extends keyof NativeAlertRuleMutation>(key: K, value: NativeAlertRuleMutation[K]) =>
    setDraft(current => ({ ...current, [key]: value }));
  const aiopsBundles = (fabric?.bundles ?? []).filter(bundle =>
    bundle.capabilityCategories?.includes('metrics') && bundle.capabilityCategories?.includes('runtime'));
  const certificationForTarget = (target: FabricExecutionTarget) =>
    fabric?.kubernetesCertifications?.find(item => item.backendId === target.backendId && item.targetId === target.targetId);
  const certificationUsable = (target: FabricExecutionTarget) => {
    const item = certificationForTarget(target);
    return item?.status === 'passed' && item.freshness !== 'stale';
  };
  const preferredBoundary = aiopsBundles.flatMap(bundle =>
    (fabric?.backends ?? []).flatMap(backend => backend.executionTargets ?? [])
      .filter(target => target.bundleIds.includes(bundle.id) && certificationUsable(target))
      .map(target => ({
        bundle,
        target,
        score: ['logs', 'traces', 'topology', 'rag', 'incident']
          .filter(category => bundle.capabilityCategories?.includes(category)).length,
      })))
    .sort((left, right) => right.score - left.score || left.bundle.id - right.bundle.id)[0];
  const targets = (fabric?.backends ?? []).flatMap(backend => backend.executionTargets ?? [])
    .filter(target => target.bundleIds.some(bundleId => draft.aiopsBundleIds.includes(bundleId)));
  const targetKey = (target: FabricExecutionTarget) => `${target.backendId}:${target.targetId}:${target.namespace}`;
  const selectedTarget = targets.find(target => draft.aiopsResourceScope
    && target.backendId === draft.aiopsResourceScope.backendId
    && target.targetId === draft.aiopsResourceScope.targetId
    && target.namespace === draft.aiopsResourceScope.namespace);
  const certification = selectedTarget ? certificationForTarget(selectedTarget) : undefined;
  const certificationReady = certification?.status === 'passed' && certification.freshness !== 'stale';
  const automationReady = !draft.aiopsAutoInvestigate || Boolean(
    draft.aiopsBundleIds.length > 0
    && draft.aiopsResourceScope
    && draft.aiopsService?.trim()
    && draft.aiopsEnvironment?.trim()
    && certificationReady,
  );
  const catalogSuggestions = (serviceCatalog?.entries ?? []).filter(entry => {
    if (!entry.current || !preferredBoundary || entry.environment !== preferredBoundary.target.environment) return false;
    return entry.targets.length === 0 || entry.targets.some(target =>
      target.current
      && target.backendId === preferredBoundary.target.backendId
      && target.targetId === preferredBoundary.target.targetId
      && target.namespace === preferredBoundary.target.namespace);
  });
  const applyAiopsPreset = (preset: typeof aiopsPolicyPresets[number]) => {
    if (!preferredBoundary) return;
    const service = draft.aiopsService?.trim() ?? '';
    setDraft(current => ({
      ...current,
      name: current.name.trim() || (service ? `${service} · ${preset.label}` : preset.label),
      description: current.description.trim() || `${preset.detail} Automatically start a governed read-only Argus AIOps investigation.`,
      metric: preset.metric,
      operator: preset.operator,
      threshold: preset.threshold,
      windowMinutes: preset.windowMinutes,
      minSamples: preset.minSamples,
      severity: preset.severity,
      scopeKind: 'all',
      scopeValue: null,
      aiopsAutoInvestigate: true,
      aiopsBundleIds: [preferredBoundary.bundle.id],
      aiopsResourceScope: {
        kind: 'kubernetes',
        backendId: preferredBoundary.target.backendId,
        targetId: preferredBoundary.target.targetId,
        namespace: preferredBoundary.target.namespace,
      },
      aiopsEnvironment: preferredBoundary.target.environment,
    }));
  };
  return (
    <section className="panel alert-editor-panel">
      <div className="panel-heading"><div><span className="eyebrow">RULE BUILDER</span><h2>{initial.name ? 'Edit alert rule' : 'New alert rule'}</h2></div><button className="icon-button" type="button" aria-label="Close rule editor" onClick={onCancel}><X size={15} /></button></div>
      <section className="alert-aiops-presets" aria-labelledby="alert-aiops-presets-title">
        <header><div><span className="eyebrow">GUIDED AIOPS POLICIES</span><h3 id="alert-aiops-presets-title">Start with a governed service preset</h3></div>{preferredBoundary && <span className="alert-catalog-boundary"><small>{preferredBoundary.bundle.label} · {preferredBoundary.target.cluster}/{preferredBoundary.target.namespace}</small><button className="button button-secondary" type="button" disabled={catalogRefreshPending} onClick={() => onRefreshCatalog({ bundleId: preferredBoundary.bundle.id, resourceScope: { kind: 'kubernetes', backendId: preferredBoundary.target.backendId, targetId: preferredBoundary.target.targetId, namespace: preferredBoundary.target.namespace } })}><RefreshCw size={13} className={catalogRefreshPending ? 'is-spinning' : undefined} />{catalogRefreshPending ? 'Discovering…' : 'Refresh services'}</button></span>}</header>
        <label className="alert-field"><span>Investigation service or workload</span><input aria-label="Preset service or workload" list="alert-service-catalog" value={draft.aiopsService ?? ''} onChange={event => set('aiopsService', event.target.value || null)} placeholder="Choose a discovered service or enter an exact name" /><datalist id="alert-service-catalog">{catalogSuggestions.map(entry => <option value={entry.serviceName} key={entry.id}>{entry.sources.join(' + ')} · {entry.environment}</option>)}</datalist><small>{catalogSuggestions.length > 0 ? `${catalogSuggestions.length} current service${catalogSuggestions.length === 1 ? '' : 's'} discovered for this governed boundary. Selection remains explicit.` : 'No current catalog match. Refresh discovery or enter an exact service name.'}</small></label>
        {catalogRefreshSummary && <p className="is-success"><CheckCircle2 size={13} />{catalogRefreshSummary}</p>}
        {catalogRefreshError && <p className="is-error"><TriangleAlert size={13} />{catalogRefreshError}</p>}
        <div>{aiopsPolicyPresets.map(preset => { const Icon = preset.icon; return <button type="button" key={preset.id} disabled={!preferredBoundary} onClick={() => applyAiopsPreset(preset)} aria-label={`Apply ${preset.label}`}><Icon size={16} /><span><b>{preset.label}</b><small>{preset.detail}</small></span><ChevronRight size={13} /></button>; })}</div>
        {!preferredBoundary && <p><TriangleAlert size={13} />No bundle with metrics/runtime capabilities and a current Kubernetes certification is ready yet.</p>}
      </section>
      <div className="alert-editor-grid">
        <label className="alert-field field-wide"><span>Name</span><input value={draft.name} onChange={event => set('name', event.target.value)} placeholder="High agent error rate" /></label>
        <label className="alert-field field-wide"><span>Description</span><input value={draft.description} onChange={event => set('description', event.target.value)} placeholder="Pages the platform team when failures spike." /></label>
        <label className="alert-field"><span>Metric</span><select value={draft.metric} onChange={event => set('metric', event.target.value as NativeAlertMetric)}>{Object.entries(metricLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label className="alert-field"><span>Condition</span><select value={draft.operator} onChange={event => set('operator', event.target.value as NativeAlertOperator)}>{Object.entries(operatorLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label className="alert-field"><span>Threshold</span><input type="number" step="any" value={draft.threshold} onChange={event => set('threshold', Number(event.target.value))} /></label>
        <label className="alert-field"><span>Window</span><div className="alert-input-unit"><input type="number" min="1" max="10080" value={draft.windowMinutes} onChange={event => set('windowMinutes', Number(event.target.value))} /><em>min</em></div></label>
        <label className="alert-field"><span>Minimum samples</span><input type="number" min="1" value={draft.minSamples} onChange={event => set('minSamples', Number(event.target.value))} /></label>
        <label className="alert-field"><span>Severity</span><select value={draft.severity} onChange={event => set('severity', event.target.value as NativeAlertSeverity)}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select></label>
        <label className="alert-field"><span>Scope</span><select value={draft.scopeKind} onChange={event => set('scopeKind', event.target.value as NativeAlertScopeKind)}><option value="all">All executions</option><option value="agent">Agent traces</option><option value="workflow">Workflow traces</option><option value="model">Model spans</option><option value="tool">Tool spans</option></select></label>
        <label className="alert-field"><span>Scope value</span><input disabled={draft.scopeKind === 'all'} value={draft.scopeValue ?? ''} onChange={event => set('scopeValue', event.target.value || null)} placeholder={draft.scopeKind === 'agent' || draft.scopeKind === 'workflow' ? 'Optional numeric ID' : 'Optional exact name'} /></label>
        <label className="alert-field"><span>Cooldown</span><div className="alert-input-unit"><input type="number" min="1" max="10080" value={draft.cooldownMinutes} onChange={event => set('cooldownMinutes', Number(event.target.value))} /><em>min</em></div></label>
        <div className="alert-toggle-group">
          <label><input type="checkbox" checked={draft.notify} onChange={event => set('notify', event.target.checked)} /><span>Send notifications</span></label>
          <label><input type="checkbox" checked={draft.enabled} onChange={event => set('enabled', event.target.checked)} /><span>Rule enabled</span></label>
        </div>
        <fieldset className="alert-aiops-policy field-wide">
          <legend>ARGUS AIOPS AUTOMATION</legend>
          <label className="alert-aiops-toggle"><input type="checkbox" checked={draft.aiopsAutoInvestigate} onChange={event => setDraft(current => ({
            ...current,
            aiopsAutoInvestigate: event.target.checked,
            ...(!event.target.checked ? { aiopsBundleIds: [], aiopsResourceScope: null, aiopsService: null, aiopsEnvironment: null } : {}),
          }))} /><span><b>Automatically investigate firing incidents</b><small>Read-only evidence collection only. This never performs remediation.</small></span></label>
          {draft.aiopsAutoInvestigate && <div className="alert-aiops-policy-grid">
            <label className="alert-field"><span>MCP bundle</span><select aria-label="AIOps MCP bundle" value={draft.aiopsBundleIds[0] ?? ''} onChange={event => setDraft(current => ({ ...current, aiopsBundleIds: event.target.value ? [Number(event.target.value)] : [], aiopsResourceScope: null, aiopsEnvironment: null }))}><option value="">Select governed bundle</option>{aiopsBundles.map(bundle => <option value={bundle.id} key={bundle.id}>{bundle.label}</option>)}</select><small>Requires metrics and runtime capabilities.</small></label>
            <label className="alert-field"><span>Kubernetes target</span><select aria-label="AIOps Kubernetes target" value={selectedTarget ? targetKey(selectedTarget) : ''} disabled={draft.aiopsBundleIds.length === 0} onChange={event => { const target = targets.find(candidate => targetKey(candidate) === event.target.value); setDraft(current => ({ ...current, aiopsResourceScope: target ? { kind: 'kubernetes', backendId: target.backendId, targetId: target.targetId, namespace: target.namespace } : null, aiopsEnvironment: target?.environment ?? null })); }}><option value="">Select certified target</option>{targets.map(target => <option key={targetKey(target)} value={targetKey(target)}>{target.cluster} · {target.namespace}</option>)}</select><small>{selectedTarget ? certificationReady ? `Certified · ${selectedTarget.backendName}` : 'Target certification is missing, failed, or stale.' : 'Exact execution boundary.'}</small></label>
            <label className="alert-field"><span>Service</span><input aria-label="AIOps service" value={draft.aiopsService ?? ''} onChange={event => set('aiopsService', event.target.value || null)} placeholder="checkout-api" /></label>
            <label className="alert-field"><span>Environment</span><input aria-label="AIOps environment" value={draft.aiopsEnvironment ?? ''} onChange={event => set('aiopsEnvironment', event.target.value || null)} placeholder="production" /></label>
          </div>}
        </fieldset>
      </div>
      {error && <div className="editor-error" role="alert"><TriangleAlert size={14} />{error}</div>}
      <footer className="alert-editor-actions"><button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button><button className="button button-primary" type="button" disabled={pending || !draft.name.trim() || !automationReady} onClick={() => onSave(draft)}>{pending ? 'Saving…' : 'Save rule'}</button></footer>
    </section>
  );
}

function providerLabel(value: string): string {
  return value.split('-').map(part => part ? part[0]!.toUpperCase() + part.slice(1) : '').join(' ');
}

function formatTokens(value: number): string {
  return Intl.NumberFormat('en', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

function formatRecordedCost(value: number): string {
  if (value === 0) return '$0';
  return `$${value.toFixed(value < 0.01 ? 6 : value < 1 ? 4 : 2)}`;
}

function evidenceLaneLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function AiopsProfileAttribution({ attribution }: { attribution: AiopsOutcomeResponse['profileAttribution'] }) {
  return (
    <section className="aiops-profile-attribution" aria-labelledby="aiops-profile-attribution-title">
      <header>
        <div><span className="eyebrow">PROFILE EVIDENCE &amp; USAGE</span><h3 id="aiops-profile-attribution-title">What each service investigation used</h3></div>
        <span>{formatTokens(attribution.totalTokens)} reported tokens · {formatRecordedCost(attribution.recordedCostUsd)} recorded cost · {attribution.reviews} human review{attribution.reviews === 1 ? '' : 's'}</span>
      </header>
      {attribution.profiles.length === 0 ? (
        <div className="aiops-profile-attribution-empty"><BarChart3 size={18} /><span>No profile-bound investigation evidence exists in this window yet.</span></div>
      ) : (
        <div className="aiops-profile-attribution-grid">{attribution.profiles.slice(0, 8).map(profile => (
          <article key={`${profile.profile.id}:${profile.profile.revision}`}>
            <header>
              <div><small>{profile.profile.environment} · profile #{profile.profile.id} r{profile.profile.revision}</small><b>{profile.profile.displayName}</b><em>{profile.profile.service}</em></div>
              <span className={profile.evidence.policyCoveragePercent === 100 ? 'is-complete' : profile.evidence.assessedInvestigations > 0 ? 'is-partial' : 'is-missing'}>{profile.evidence.assessedInvestigations > 0 ? `${profile.evidence.policyCoveragePercent.toFixed(1)}%` : 'No data'}<small>policy coverage</small></span>
            </header>
            <div className="aiops-profile-attribution-metrics">
              <span><b>{profile.investigations}</b><small>investigations</small></span>
              <span><b>{formatTokens(profile.usage.totalTokens)}</b><small>reported tokens</small></span>
              <span><b>{formatRecordedCost(profile.usage.recordedCostUsd)}</b><small>recorded cost</small></span>
              <span><b>{profile.usage.telemetryLinkedInvestigations}/{profile.investigations}</b><small>trace-linked</small></span>
            </div>
            <div className="aiops-profile-feedback-summary">
              <span><ShieldCheck size={11} />Human RCA feedback</span>
              <b>{profile.feedback.reviews > 0 ? `${profile.feedback.helpfulPercent.toFixed(1)}% helpful` : 'Awaiting review'}</b>
              <small>{profile.feedback.reviewedInvestigations}/{profile.completedInvestigations} completed investigations reviewed · {profile.feedback.helpful} helpful · {profile.feedback.partial} partial · {profile.feedback.incorrect} incorrect</small>
            </div>
            <div className="aiops-profile-lane-coverage" aria-label={`${profile.profile.displayName} evidence lane coverage`}>
              {profile.evidence.lanes.map(lane => (
                <span key={lane.lane} className={lane.coveragePercent === 100 ? 'is-complete' : lane.coveragePercent > 0 ? 'is-partial' : 'is-missing'} title={`${lane.investigationsWithEvidence}/${profile.evidence.assessedInvestigations} assessed investigations · ${lane.claims} retained claims`}>
                  <i style={{ '--lane-coverage': `${lane.coveragePercent}%` } as CSSProperties} />
                  <b>{evidenceLaneLabel(lane.lane)}</b>
                  <small>{lane.requirement} · {lane.coveragePercent.toFixed(0)}%</small>
                </span>
              ))}
            </div>
            <footer>
              <span>{profile.evidence.investigationsMeetingPolicy}/{profile.evidence.assessedInvestigations} assessed runs met the frozen profile policy</span>
              <span>{formatTokens(profile.usage.averageTokensPerInvestigation)} avg tokens · {formatRecordedCost(profile.usage.averageRecordedCostUsdPerInvestigation)} avg recorded cost</span>
            </footer>
          </article>
        ))}</div>
      )}
      <footer><ShieldCheck size={11} />Values come from immutable profile revisions, normalized result evidence and trace-reported usage. Zero recorded cost does not imply a free runtime.</footer>
      {attribution.truncated && <footer className="is-warning"><TriangleAlert size={11} />Bounded to the latest 1,000 profile-bound investigations in this window.</footer>}
    </section>
  );
}

function AiopsCausalGraph({ graph }: { graph: AiopsOutcomeResponse['graph'] }) {
  const preferredNode = graph.nodes.find(node => node.firing > 0)
    ?? [...graph.nodes].sort((left, right) => right.incidents - left.incidents || right.signals - left.signals)[0]
    ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(preferredNode?.id ?? null);
  const selected = graph.nodes.find(node => node.id === selectedId) ?? preferredNode;
  const center = preferredNode;
  const surrounding = graph.nodes.filter(node => node.id !== center?.id);
  const positions = new Map<string, { x: number; y: number }>();
  if (center) positions.set(center.id, { x: 450, y: 170 });
  surrounding.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, surrounding.length) - Math.PI / 2;
    positions.set(node.id, { x: 450 + Math.cos(angle) * 340, y: 170 + Math.sin(angle) * 125 });
  });
  const connectedEdges = selected
    ? graph.edges.filter(edge => edge.source === selected.id || edge.target === selected.id)
    : [];
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));

  return (
    <section className="aiops-causal-graph" aria-labelledby="aiops-causal-graph-title">
      <header>
        <div><span className="eyebrow">CAUSAL / SERVICE GRAPH</span><h3 id="aiops-causal-graph-title">Incident-bound runtime evidence</h3></div>
        <span className="aiops-causal-legend"><i />Observed <i className="is-candidate" />Causal candidate</span>
      </header>
      {graph.nodes.length === 0 ? (
        <div className="aiops-causal-empty"><Network size={20} /><span>No service-bound incident evidence in this window yet.</span></div>
      ) : (
        <div className="aiops-causal-layout">
          <div className="aiops-causal-canvas">
            <svg viewBox="0 0 900 340" role="img" aria-label="AIOps incident causal and service graph">
              <defs><marker id="aiops-causal-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5"><path d="M0,0 L7,3.5 L0,7 z" /></marker></defs>
              <g className="aiops-causal-edges">{graph.edges.map(edge => {
                const source = positions.get(edge.source);
                const target = positions.get(edge.target);
                if (!source || !target) return null;
                const highlighted = selected && (edge.source === selected.id || edge.target === selected.id);
                return <path key={edge.id} className={`${edge.evidence === 'causal_candidate' ? 'is-candidate' : ''}${highlighted ? ' is-highlighted' : ''}`} d={`M ${source.x} ${source.y} Q 450 170 ${target.x} ${target.y}`} markerEnd="url(#aiops-causal-arrow)"><title>{edge.relation} · {edge.failures}/{edge.calls} failed · {edge.evidence === 'causal_candidate' ? `${edge.confidence} confidence candidate` : 'observed relation'}</title></path>;
              })}</g>
              <g className="aiops-causal-nodes">{graph.nodes.map(node => {
                const position = positions.get(node.id);
                if (!position) return null;
                const selectedNode = selected?.id === node.id;
                return <g key={node.id} role="button" tabIndex={0} aria-label={`${node.kind} ${node.label}`} className={`${node.kind === 'service' ? 'is-service' : 'is-dependency'}${node.firing ? ' is-firing' : ''}${selectedNode ? ' is-selected' : ''}`} transform={`translate(${position.x} ${position.y})`} onClick={() => setSelectedId(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelectedId(node.id); }}>
                  <circle r={selectedNode ? 26 : 21} />
                  <text className="aiops-causal-node-kind" textAnchor="middle" y={selectedNode ? -34 : -29}>{node.kind}</text>
                  <text className="aiops-causal-node-label" textAnchor="middle" y={selectedNode ? 41 : 36}>{node.label.length > 22 ? `${node.label.slice(0, 20)}…` : node.label}</text>
                  {node.incidents > 0 && <text className="aiops-causal-node-count" textAnchor="middle" y="4">{node.incidents}</text>}
                  <title>{node.label} · {node.environment} · {node.incidents} incidents · {node.signals} signals</title>
                </g>;
              })}</g>
            </svg>
          </div>
          <aside className="aiops-causal-inspector">
            {selected && <>
              <div className="aiops-causal-selected"><span className={selected.firing ? 'is-firing' : ''}><Network size={16} /></span><div><small>{selected.kind} · {selected.environment}</small><b>{selected.label}</b><em>{selected.incidents} incidents · {selected.signals} signals</em></div></div>
              <div className="aiops-causal-connections">
                {connectedEdges.length > 0 ? connectedEdges.slice(0, 8).map(edge => {
                  const outbound = edge.source === selected.id;
                  const other = nodesById.get(outbound ? edge.target : edge.source);
                  return <div key={edge.id}><i className={edge.evidence === 'causal_candidate' ? 'is-candidate' : ''} /><span><b>{outbound ? edge.relation : 'upstream'}</b><small>{other?.label ?? 'Unknown'} · {edge.failures}/{edge.calls} failed{edge.confidence ? ` · ${edge.confidence}` : ''}</small></span></div>;
                }) : <small>No runtime edge is connected to this node.</small>}
              </div>
              {selected.providerLinks.length > 0 && <div className="aiops-provider-links"><span>Provider evidence</span>{selected.providerLinks.slice(0, 5).map(link => <div key={`${link.provider}:${link.monitorRef}:${link.incidentId}`}>
                {link.externalHref && <a href={link.externalHref} target="_blank" rel="noreferrer">Open in {providerLabel(link.provider)} <ExternalLink size={10} /></a>}
                <a href={link.incidentHref}>{link.monitorRef} · Incident #{link.incidentId} <ChevronRight size={10} /></a>
              </div>)}</div>}
              <p>Failed edges are ranked candidates, not causal proof.</p>
            </>}
          </aside>
        </div>
      )}
      {(graph.truncated.nodes || graph.truncated.edges) && <footer><TriangleAlert size={11} />Bounded view · open the service topology for the complete retained graph.</footer>}
    </section>
  );
}

function AiopsOutcomePanel({ data, loading, error }: { data?: AiopsOutcomeResponse; loading: boolean; error: Error | null }) {
  if (loading) return <section className="panel aiops-outcome-panel is-loading" aria-label="AIOps outcome metrics"><RefreshCw className="spin" size={15} />Calculating 30-day AIOps outcomes…</section>;
  if (error || !data) return <section className="panel aiops-outcome-panel is-error" aria-label="AIOps outcome metrics"><TriangleAlert size={15} />Outcome metrics are temporarily unavailable.</section>;
  return (
    <section className="panel aiops-outcome-panel" aria-labelledby="aiops-outcome-title">
      <header className="panel-heading">
        <div><span className="eyebrow">AIOPS OUTCOMES · LAST {data.window.days} DAYS</span><h2 id="aiops-outcome-title">From signal noise to verified action</h2></div>
        <small>{data.signals.total} signals · {data.incidents.actionable} actionable incidents</small>
      </header>
      <div className="aiops-outcome-kpis">
        <article><span>Alert compression</span><strong>{data.incidents.compressionRatio.toFixed(2)}×</strong><small>{data.incidents.suppressedSignals} duplicate signal{data.incidents.suppressedSignals === 1 ? '' : 's'} grouped</small></article>
        <article><span>Investigation coverage</span><strong>{data.investigations.coveragePercent.toFixed(1)}%</strong><small>{data.investigations.completed} completed · {data.investigations.blocked} blocked</small></article>
        <article><span>Median recovery</span><strong>{formatDuration(data.incidents.medianRecoveryMs)}</strong><small>P95 {formatDuration(data.incidents.p95RecoveryMs)}</small></article>
        <article><span>Remediation success</span><strong>{data.remediations.successRatePercent.toFixed(1)}%</strong><small>{data.remediations.verified} verified · {data.remediations.rolledBack} rolled back</small></article>
      </div>
      <div className="aiops-outcome-details">
        <div><span>Evidence funnel</span><b>{data.signals.native} native + {data.signals.provider} provider signals</b><small>{data.signals.providerDeliveries} immutable provider deliveries · median start {formatDuration(data.investigations.medianTimeToStartMs)}</small></div>
        <div><span>RCA confidence</span><b>{data.rootCause.confirmed} confirmed · {data.rootCause.suspected} suspected</b><small>{data.rootCause.refuted} refuted · {data.rootCause.inconclusive} inconclusive · {data.investigations.partial} partial</small></div>
        <div><span>Post-change proof</span><b>{data.remediations.postChangeHealthy} healthy · {data.remediations.postChangeRegressed} regressed</b><small>{data.remediations.awaitingApproval} awaiting approval · {data.remediations.failed} failed</small></div>
        <div><span>Recurring services</span><b>{data.recurrence.servicesWithRepeatIncidents} services · {data.recurrence.repeatIncidents} repeats</b><small>{data.topServices[0] ? `${data.topServices[0].service} · ${data.topServices[0].environment} leads the window` : 'No incident recurrence in this window'}</small></div>
      </div>
      {data.topServices.length > 0 && (
        <footer className="aiops-outcome-services" aria-label="Top incident services">
          {data.topServices.slice(0, 5).map(service => (
            <span key={`${service.service}:${service.environment}`}><i className={service.firing ? 'is-firing' : ''} /><b>{service.service}</b><small>{service.environment} · {service.incidents} incident{service.incidents === 1 ? '' : 's'} · {service.signals} signals</small></span>
          ))}
        </footer>
      )}
      <AiopsProfileAttribution attribution={data.profileAttribution} />
      <AiopsCausalGraph graph={data.graph} />
    </section>
  );
}

export function AlertsPage() {
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview });
  const alerts = useQuery({ queryKey: ['native-alerts'], queryFn: getNativeAlerts, refetchInterval: 30_000 });
  const solutionPacks = useQuery({
    queryKey: ['solution-packs'],
    queryFn: getSolutionPacks,
    staleTime: 15_000,
    enabled: isPlatformAdminRole(overview.data?.user.role),
  });
  const aiopsConnected = solutionPacks.data?.packs.some(pack =>
    pack.configuredId === 'argus.aiops'
    && pack.state === 'ready'
    && pack.manifest?.metadata.id === 'argus.aiops',
  ) ?? false;
  const outcomes = useQuery({
    queryKey: ['aiops-outcomes', 30],
    queryFn: () => getAiopsOutcomes(30),
    refetchInterval: 60_000,
    enabled: isPlatformAdminRole(overview.data?.user.role) && aiopsConnected,
  });
  const fabric = useQuery({
    queryKey: ['fabric-management'],
    queryFn: getFabricManagement,
    staleTime: 30_000,
    enabled: isPlatformAdminRole(overview.data?.user.role),
  });
  const serviceCatalog = useQuery({
    queryKey: ['native-service-catalog'],
    queryFn: getNativeServiceCatalog,
    staleTime: 30_000,
    enabled: isPlatformAdminRole(overview.data?.user.role),
  });
  const [editor, setEditor] = useState<NativeAlertRule | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['native-alerts'] });
  const save = useMutation({
    mutationFn: (input: NativeAlertRuleMutation) => editor === 'new' ? createNativeAlert(input) : updateNativeAlert(editor!.id, input),
    onSuccess: () => { setEditor(null); refresh(); },
  });
  const remove = useMutation({
    mutationFn: deleteNativeAlert,
    onSuccess: () => { setDeleteTarget(null); refresh(); },
  });
  const toggle = useMutation({
    mutationFn: ({ rule, enabled }: { rule: NativeAlertRule; enabled: boolean }) => updateNativeAlert(rule.id, { ...editorValue(rule), enabled }),
    onSuccess: refresh,
  });
  const evaluate = useMutation({ mutationFn: evaluateNativeAlerts, onSuccess: refresh });
  const installTemplate = useMutation({ mutationFn: installNativeAlertTemplate, onSuccess: refresh });
  const catalogRefresh = useMutation({
    mutationFn: refreshNativeServiceCatalog,
    onSuccess: data => client.setQueryData(['native-service-catalog'], data),
  });

  if (overview.isLoading || alerts.isLoading) return <LoadingState label="Loading native alerting…" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  const isAdmin = isPlatformAdminRole(overview.data?.user.role);
  if (!isAdmin) return <div className="state-panel state-error" role="alert"><TriangleAlert size={22} /><div><b>Platform administrator access required</b><span>Alert rules can notify external on-call channels and expose cross-platform telemetry.</span></div></div>;
  if (alerts.error) return <ErrorState error={alerts.error} />;
  if (!alerts.data) return null;
  const requestedIncidentId = Number(searchParams.get('incident'));
  const selectedIncident = alerts.data.incidents.find(incident => incident.id === requestedIncidentId)
    ?? alerts.data.incidents.find(incident => incident.state === 'firing')
    ?? alerts.data.incidents[0];
  const selectIncident = (id: number) => {
    const next = new URLSearchParams(searchParams);
    next.set('incident', String(id));
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        eyebrow="OBSERVE · ALERTS"
        title="Native alerting"
        description="Turn trace latency, reliability and spend signals into deduplicated incidents and recoveries."
        actions={<><button className="button button-secondary" type="button" disabled={evaluate.isPending} onClick={() => evaluate.mutate()}><Play size={14} />{evaluate.isPending ? 'Evaluating…' : 'Evaluate now'}</button><button className="button button-primary" type="button" onClick={() => { save.reset(); setEditor('new'); }}><Plus size={14} />New rule</button></>}
      />

      <ObserveWorkspaceTabs active="alerts" isAdmin={isAdmin} />

      <section className="metric-grid alert-metrics">
        <article className="metric-card"><span className="metric-icon violet"><BellRing size={17} /></span><div><span>Enabled rules</span><strong>{alerts.data.summary.enabledRules}</strong><small>{alerts.data.rules.length} configured</small></div></article>
        <article className="metric-card"><span className={`metric-icon ${alerts.data.summary.firingRules ? 'red' : 'teal'}`}><ShieldAlert size={17} /></span><div><span>Firing now</span><strong>{alerts.data.summary.firingRules}</strong><small>deduplicated incidents</small></div></article>
        <article className="metric-card"><span className="metric-icon amber"><CircleAlert size={17} /></span><div><span>Triggered 24h</span><strong>{alerts.data.summary.incidents24h}</strong><small>new incidents</small></div></article>
        <article className="metric-card"><span className="metric-icon blue"><CheckCircle2 size={17} /></span><div><span>Recovered 24h</span><strong>{alerts.data.summary.recovered24h}</strong><small>automatic resolutions</small></div></article>
      </section>

      {aiopsConnected && <AiopsOutcomePanel data={outcomes.data} loading={outcomes.isLoading} error={outcomes.error} />}

      {evaluate.data && <div className="connection-notice is-success" role="status"><CheckCircle2 size={15} /><span>{evaluate.data.evaluated} rules evaluated · {evaluate.data.fired} fired · {evaluate.data.recovered} recovered</span><button type="button" onClick={() => evaluate.reset()}><X size={13} /></button></div>}
      {evaluate.error && <div className="connection-notice is-error" role="alert"><TriangleAlert size={15} /><span>{evaluate.error.message}</span></div>}

      <section className="panel alert-template-panel">
        <div className="panel-heading"><div><span className="eyebrow">QUICK START</span><h2>SLO and guardrail presets</h2></div><small>safe, idempotent installation</small></div>
        <div className="alert-template-grid">
          {alerts.data.templates.map(template => {
            const icon = template.category === 'reliability' ? <ShieldCheck size={17} />
              : template.category === 'latency' ? <Gauge size={17} />
                : template.category === 'cost' ? <CircleDollarSign size={17} /> : <ShieldAlert size={17} />;
            const installing = installTemplate.isPending && installTemplate.variables === template.id;
            return <article className={`alert-template-card template-${template.category}`} key={template.id}>
              <span>{icon}</span>
              <div><small>{template.category}</small><h3>{template.name}</h3><p>{template.description}</p><em>{template.rules.length} rule{template.rules.length === 1 ? '' : 's'} · {template.installedRules} installed</em></div>
              <button className={`button ${template.installed ? 'button-secondary' : 'button-primary'}`} type="button" disabled={template.installed || installing} onClick={() => installTemplate.mutate(template.id)}>
                {template.installed ? <><CheckCircle2 size={13} />Installed</> : <><PackagePlus size={13} />{installing ? 'Installing…' : 'Install'}</>}
              </button>
            </article>;
          })}
        </div>
        {installTemplate.data && <div className="alert-template-result" role="status"><CheckCircle2 size={13} />{installTemplate.data.created} rules created · {installTemplate.data.skipped} already present</div>}
        {installTemplate.error && <div className="editor-error" role="alert"><TriangleAlert size={14} />{installTemplate.error.message}</div>}
      </section>

      {editor && <AlertRuleEditor key={editor === 'new' ? 'new' : editor.id} initial={editor === 'new' ? emptyRule : editorValue(editor)} fabric={fabric.data ?? null} serviceCatalog={serviceCatalog.data ?? null} catalogRefreshPending={catalogRefresh.isPending} catalogRefreshError={catalogRefresh.error?.message ?? serviceCatalog.error?.message ?? null} catalogRefreshSummary={catalogRefresh.data ? `${catalogRefresh.data.refresh.discovered} service evidence records refreshed · ${catalogRefresh.data.refresh.dependencies} runtime dependenc${catalogRefresh.data.refresh.dependencies === 1 ? 'y' : 'ies'}${catalogRefresh.data.refresh.warnings.length ? ` · ${catalogRefresh.data.refresh.warnings.length} warning${catalogRefresh.data.refresh.warnings.length === 1 ? '' : 's'}` : ''}.` : null} pending={save.isPending} error={save.error?.message ?? null} onCancel={() => setEditor(null)} onSave={input => save.mutate(input)} onRefreshCatalog={input => catalogRefresh.mutate(input)} />}

      <div className="alert-workspace-grid">
        <section className="panel alert-rules-panel">
          <div className="panel-heading"><div><span className="eyebrow">RULES</span><h2>Signal policies</h2></div><small>evaluated every minute</small></div>
          {alerts.data.rules.length > 0 ? <div className="alert-rule-list">{alerts.data.rules.map(rule => (
            <article className={`alert-rule-card state-${rule.lastState}`} key={rule.id}>
              <header><span className={`alert-rule-state is-${rule.lastState}`}><i />{rule.lastState.replace('_', ' ')}</span><span className={`alert-severity severity-${rule.severity}`}>{rule.severity}</span><label className="switch"><input type="checkbox" checked={rule.enabled} disabled={toggle.isPending} onChange={event => toggle.mutate({ rule, enabled: event.target.checked })} /><i /></label></header>
              <div><h3>{rule.name}</h3><p>{rule.description || `${metricLabels[rule.metric]} threshold rule.`}</p>{rule.aiopsAutoInvestigate && <span className="alert-rule-aiops"><Activity size={11} />Auto-investigate · bundle {rule.aiopsBundleIds.join(', ')}</span>}</div>
              <dl><div><dt>Signal</dt><dd>{metricLabels[rule.metric]}</dd></div><div><dt>Condition</dt><dd>{operatorLabels[rule.operator]} {formatMetricValue(rule.metric, rule.threshold)}</dd></div><div><dt>Last value</dt><dd>{formatMetricValue(rule.metric, rule.lastValue)}</dd></div><div><dt>Evidence</dt><dd>{rule.lastSampleCount} samples · {rule.windowMinutes}m</dd></div></dl>
              <footer><span><Clock3 size={12} />{rule.lastEvaluatedAt ? `Checked ${timeAgo(rule.lastEvaluatedAt)}` : 'Not evaluated yet'}</span><div><button type="button" onClick={() => { save.reset(); setEditor(rule); }}><Pencil size={12} />Edit</button>{deleteTarget === rule.id ? <><button type="button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="is-danger" type="button" disabled={remove.isPending} onClick={() => remove.mutate(rule.id)}>Archive</button></> : <button className="is-danger" type="button" onClick={() => setDeleteTarget(rule.id)}><Trash2 size={12} />Archive</button>}</div></footer>
            </article>
          ))}</div> : <div className="observe-empty-state"><BellRing size={28} /><h2>No native alert rules yet</h2><p>Create a threshold rule for reliability, latency or cost.</p><button className="button button-primary" type="button" onClick={() => setEditor('new')}><Plus size={14} />Create first rule</button></div>}
        </section>

        <section className="panel alert-incidents-panel">
          <div className="panel-heading"><div><span className="eyebrow">INCIDENTS</span><h2>Recent history</h2></div><small>latest 100</small></div>
          {alerts.data.incidents.length > 0 ? <div className="alert-incident-list">{alerts.data.incidents.map(incident => {
            const exemplars = safeIncidentExemplars(incident.context);
            return (
              <article className={`alert-incident is-${incident.state}${selectedIncident?.id === incident.id ? ' is-selected' : ''}`} key={incident.id}>
                <span>{incident.state === 'firing' ? <ShieldAlert size={15} /> : <CheckCircle2 size={15} />}</span>
                <div>
                  <header><b>{incident.ruleName}</b><em className={`alert-severity severity-${incident.severity}`}>{incident.severity}</em></header>
                  {incident.correlation && <span className="alert-incident-correlation"><Network size={10} />Group #{incident.correlation.groupId} · {incident.correlation.signalCount} signal{incident.correlation.signalCount === 1 ? '' : 's'} · {incident.correlation.role}</span>}
                  <p>{incident.message}</p>
                  {exemplars.length > 0 && (
                    <div className="alert-incident-evidence">
                      <span>EXEMPLAR RUNS</span>
                      {exemplars.map(exemplar => (
                        <a href={exemplar.href} key={`${exemplar.traceId}:${exemplar.spanId ?? 'run'}`}>
                          <span><b>{exemplar.title}</b><small>{exemplar.dominantSpanLabel || `${exemplar.runKind} execution`}</small></span>
                          <em>{formatDuration(exemplar.durationMs)} · ${exemplar.costUsd.toFixed(6)}</em>
                          <ExternalLink size={11} />
                        </a>
                      ))}
                    </div>
                  )}
                  <small>{incident.sampleCount} samples · triggered {timeAgo(incident.triggeredAt)}{incident.recoveredAt ? ` · recovered ${timeAgo(incident.recoveredAt)}` : ''}</small>
                  <button className="alert-investigate-button" type="button" aria-pressed={selectedIncident?.id === incident.id} onClick={() => selectIncident(incident.id)}>
                    <Activity size={11} />{selectedIncident?.id === incident.id ? 'Investigating' : 'Investigate'}<ChevronRight size={11} />
                  </button>
                </div>
              </article>
            );
          })}</div> : <div className="observe-mini-empty">No alert incidents recorded yet.</div>}
        </section>
      </div>

      {selectedIncident && (
        <IncidentInvestigation
          incident={selectedIncident}
          rule={alerts.data.rules.find(rule => rule.id === selectedIncident.ruleId)}
          history={alerts.data.incidents}
          onSelectIncident={selectIncident}
        />
      )}
    </>
  );
}
