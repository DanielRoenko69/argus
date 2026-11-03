import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  Clock3,
  Cloud,
  Container,
  Database,
  ExternalLink,
  FileCheck2,
  KeyRound,
  Network,
  Play,
  Radar,
  RefreshCw,
  SearchCheck,
  Server,
  ShieldCheck,
  Terminal,
  Upload,
  X,
} from 'lucide-react';
import {
  getFabricManagement,
  getAiOpsReadiness,
  getAiOpsServiceProfiles,
  getKubernetesCertificationHistory,
  getSolutionPackAgentCard,
  getSolutionPackTask,
  getSolutionPackTasks,
  getSolutionPacks,
  importKubernetesCertification,
  refreshSolutionPacks,
  runSolutionPackPreflight,
  startAiOpsServiceProfileInvestigation,
} from '../api';
import type {
  FabricExecutionTarget,
  FabricKubernetesCertification,
  HealthState,
  AiOpsServiceProfile,
  SolutionPackTask,
  SolutionPackWorkflowDefinition,
} from '../types';
import { EmptyState, ErrorState, HealthBadge, LoadingState, PageHeader } from '../components/Ui';
import { AiOpsServiceProfilesPanel } from '../components/AiOpsServiceProfilesPanel';

const CAPABILITY_LABELS: Record<string, string> = {
  metrics: 'Metrics',
  runtime: 'Runtime / Kubernetes',
  logs: 'Logs',
  traces: 'Traces',
  topology: 'Service topology',
  repository: 'Changes / repository',
  rag: 'Runbooks / knowledge',
  incident: 'Incident management',
};

type KubernetesPlatformId = FabricExecutionTarget['platform'];

type KubernetesPlatformAdapter = {
  id: KubernetesPlatformId;
  label: string;
  provider: string;
  identity: string;
  contract: string;
  configureCommand: string;
  certifyCommand: string;
  guardrails: string[];
};

const KUBERNETES_PLATFORM_ADAPTERS: KubernetesPlatformAdapter[] = [
  {
    id: 'kubernetes',
    label: 'Kubernetes',
    provider: 'Any conformant cluster',
    identity: 'Projected ServiceAccount token',
    contract: 'connector-contract.in-cluster.json',
    configureCommand: '.\\scripts\\bootstrap-aiops-kubernetes-connector.ps1',
    certifyCommand: 'npm run certify:kubernetes-connector',
    guardrails: ['Namespace allowlist', 'Read-only ClusterRole', 'NetworkPolicy egress boundary'],
  },
  {
    id: 'aks',
    label: 'AKS',
    provider: 'Microsoft Azure',
    identity: 'Microsoft Entra Workload Identity',
    contract: 'connector-contract.aks.example.json',
    configureCommand: '.\\scripts\\configure-aks-workload-identity.ps1 -Context <context> -ClientId <client-id> -TenantId <tenant-id>',
    certifyCommand: 'node scripts/certify-kubernetes-connector.mjs --contract <aks-contract.json>',
    guardrails: ['Federated workload identity', 'Fail-closed webhook mutation', 'No long-lived cloud secret'],
  },
  {
    id: 'eks',
    label: 'EKS',
    provider: 'Amazon Web Services',
    identity: 'EKS Pod Identity',
    contract: 'connector-contract.eks.example.json',
    configureCommand: '.\\scripts\\configure-eks-pod-identity.ps1 -Context <context> -ClusterName <cluster> -Region <region> -RoleArn <role-arn>',
    certifyCommand: 'node scripts/certify-kubernetes-connector.mjs --contract <eks-contract.json>',
    guardrails: ['Pod Identity association', 'Dedicated IAM role', 'IRSA conflict detection'],
  },
  {
    id: 'gke',
    label: 'GKE',
    provider: 'Google Cloud',
    identity: 'Workload Identity Federation for GKE',
    contract: 'connector-contract.gke.example.json',
    configureCommand: '.\\scripts\\configure-gke-workload-identity.ps1 -Context <context> -ProjectId <project> -ProjectNumber <number> -Location <location> -ClusterName <cluster> -ClusterMode standard -RequiredRoles <roles>',
    certifyCommand: 'node scripts/certify-kubernetes-connector.mjs --contract <gke-contract.json>',
    guardrails: ['Direct KSA principal', 'Broad IAM role refusal', 'Standard and Autopilot checks'],
  },
  {
    id: 'openshift',
    label: 'OpenShift',
    provider: 'Red Hat',
    identity: 'Dedicated OpenShift ServiceAccount',
    contract: 'connector-contract.openshift.example.json',
    configureCommand: '.\\scripts\\configure-openshift-service-account.ps1 -Context <context> -RequestServingCertificate',
    certifyCommand: 'node scripts/certify-kubernetes-connector.mjs --contract <openshift-contract.json>',
    guardrails: ['Restricted SCC validation', 'Service CA TLS', 'ClusterVersion health gate'],
  },
];

type InvestigationPlan = {
  kind: 'aiops-investigation-plan';
  implementationStage: string;
  generatedAt: string;
  incident: { title: string; summary: string; severity: string; service: string; environment: string };
  scope: { windowStart: string; windowEnd: string; selectedBundleIds: number[] };
  evidenceLanes: Array<{ id: string; purpose: string; questions: string[]; requiredCapabilities: string[] }>;
  hypotheses: Array<{ rank: number; statement: string; state: string; evidenceFor: string[]; evidenceAgainst: string[] }>;
  safety: { readOnly: boolean; rawTelemetryPersisted: boolean; writeActionsAllowed: boolean; notes: string[] };
};

type AgentEvidence = {
  role: 'researcher' | 'knowledge' | 'reviewer';
  status: 'completed' | 'failed';
  durationMs: number;
  agentId: number | null;
  model: string | null;
  sessionId: string | null;
  outputSummary: string;
  error: string | null;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
};

type InvestigationEvidence = {
  kind: 'aiops-investigation-evidence';
  generatedAt: string;
  quality: 'reviewed' | 'partial' | 'failed';
  agentEvidence: AgentEvidence[];
  signalCoverage?: Array<{
    lane: 'metrics' | 'logs' | 'traces' | 'runtime' | 'topology' | 'changes' | 'knowledge';
    status: 'collected' | 'missing' | 'failed';
    queryCount: number;
    sources: string[];
    toolNames: string[];
  }>;
  timeline?: Array<{
    id: string;
    timestamp: string;
    lane: string;
    source: string;
    title: string;
    summary: string;
    correlationKey: string | null;
  }>;
  kubernetesEvidence?: {
    namespace: string;
    resources: Array<{
      kind: 'Service' | 'Deployment' | 'Pod' | string;
      name: string;
      status: string;
      owner?: string;
      labels: Record<string, string>;
      provenance: {
        toolName: string;
        toolCallId?: string;
        traceId?: string;
        spanId?: string;
      };
    }>;
    edges: Array<{
      from: string;
      to: string;
      relation: 'selects' | 'owns' | 'depends-on' | string;
    }>;
    events: Array<{
      timestamp: string;
      type: string;
      reason: string;
      object: string;
      message: string;
      provenance: {
        toolName: string;
        toolCallId?: string;
        traceId?: string;
        spanId?: string;
      };
    }>;
  };
  synthesis: string;
  safety: { mode: 'read-only'; writesAllowed: false; rawTelemetryPersisted: false; redactionApplied: true };
};

const TERMINAL_TASK_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

function packHealth(state: string): HealthState {
  if (state === 'ready') return 'healthy';
  if (state === 'not_checked') return 'not_configured';
  if (state === 'unreachable') return 'offline';
  return 'degraded';
}

function initialInput(workflow: SolutionPackWorkflowDefinition): Record<string, string | number> {
  return Object.fromEntries(workflow.inputSchema
    .filter(field => field.defaultValue !== undefined)
    .map(field => [field.name, field.defaultValue!])) as Record<string, string | number>;
}

function alertInput(workflow: SolutionPackWorkflowDefinition, searchParams: URLSearchParams): Record<string, string | number> {
  const input = initialInput(workflow);
  for (const field of workflow.inputSchema) {
    const value = searchParams.get(field.name);
    if (value == null || value.trim() === '') continue;
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      input[field.name] = Math.min(field.max ?? number, Math.max(field.min ?? number, number));
      continue;
    }
    if (field.type === 'select' && field.options && !field.options.some(option => option.value === value)) continue;
    input[field.name] = value.slice(0, field.type === 'textarea' ? 20_000 : 300);
  }
  return input;
}

function artifactData(task: SolutionPackTask | undefined, kind?: string): Record<string, unknown> | undefined {
  return task?.artifacts?.flatMap(artifact => artifact.parts ?? []).map(part => part.data)
    .find((data): data is Record<string, unknown> => Boolean(data) && (!kind || data?.['kind'] === kind));
}

function asInvestigationPlan(task: SolutionPackTask | undefined): InvestigationPlan | undefined {
  return artifactData(task, 'aiops-investigation-plan') as unknown as InvestigationPlan | undefined;
}

function asInvestigationEvidence(task: SolutionPackTask | undefined): InvestigationEvidence | undefined {
  return artifactData(task, 'aiops-investigation-evidence') as unknown as InvestigationEvidence | undefined;
}

function taskStateLabel(state: string | undefined): string {
  return (state ?? 'TASK_STATE_WORKING').replace('TASK_STATE_', '').replaceAll('_', ' ').toLowerCase();
}

function kubernetesStatusTone(status: string): 'healthy' | 'warning' | 'critical' | 'neutral' {
  if (/(?:running|ready|available|active|healthy|completed)/i.test(status)) return 'healthy';
  if (/(?:crash|error|failed|unavailable|oom|evicted)/i.test(status)) return 'critical';
  if (/(?:pending|restart|progress|unknown|degraded)/i.test(status)) return 'warning';
  return 'neutral';
}

function provenanceHref(rootTraceId: string, provenance?: { spanId?: string }): string | null {
  return rootTraceId && provenance?.spanId
    ? `/runs/workflow/${encodeURIComponent(rootTraceId)}?span=${encodeURIComponent(provenance.spanId)}`
    : null;
}

const KUBERNETES_RESOURCE_GROUPS = ['Service', 'Deployment', 'Pod'] as const;

export function AiOpsSolutionPackPage({ packId }: { packId: string }) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const packs = useQuery({ queryKey: ['solution-packs'], queryFn: getSolutionPacks, staleTime: 15_000 });
  const refresh = useMutation({
    mutationFn: refreshSolutionPacks,
    onSuccess: data => queryClient.setQueryData(['solution-packs'], data),
  });
  const pack = packs.data?.packs.find(item => item.configuredId === packId);
  const aiopsReadiness = useQuery({
    queryKey: ['aiops-readiness'],
    queryFn: getAiOpsReadiness,
    enabled: Boolean(pack),
    staleTime: 15_000,
  });
  const manifest = pack?.manifest;
  const orchestrator = manifest?.spec.components.agents[0];
  const catalog = useQuery({
    queryKey: ['solution-pack-agent-card', packId, orchestrator?.id],
    queryFn: () => getSolutionPackAgentCard(packId, orchestrator!.id),
    enabled: Boolean(orchestrator && pack?.state === 'ready'),
    staleTime: 30_000,
  });
  const workflows = useMemo(() => (catalog.data?.agentCard.skills ?? [])
    .map(skill => skill['x-argus-workflow'])
    .filter((workflow): workflow is SolutionPackWorkflowDefinition => Boolean(workflow)), [catalog.data]);
  const workflow = workflows[0];
  const fabric = useQuery({
    queryKey: ['fabric-management'],
    queryFn: getFabricManagement,
    enabled: Boolean(orchestrator && pack?.state === 'ready'),
    staleTime: 30_000,
  });
  const serviceProfiles = useQuery({
    queryKey: ['aiops-service-profiles'],
    queryFn: getAiOpsServiceProfiles,
    staleTime: 10_000,
  });
  const [launchOpen, setLaunchOpen] = useState(false);
  const [selectedPlatformId, setSelectedPlatformId] = useState<KubernetesPlatformId | null>(null);
  const [certificationTargetKey, setCertificationTargetKey] = useState('');
  const [certificationFileError, setCertificationFileError] = useState<string | null>(null);
  const [workflowInput, setWorkflowInput] = useState<Record<string, string | number>>({});
  const [bundleIds, setBundleIds] = useState<number[]>([]);
  const [selectedTargetKey, setSelectedTargetKey] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [seedTask, setSeedTask] = useState<SolutionPackTask>();
  const [seedRootTraceId, setSeedRootTraceId] = useState('');
  const [historyCursors, setHistoryCursors] = useState<Array<string | undefined>>([undefined]);
  const historyPage = historyCursors.length - 1;
  const historyCursor = historyCursors[historyPage];
  const selectedTaskId = searchParams.get('task') ?? '';
  const launchSource = searchParams.get('launch') ?? '';
  const sourceIncidentId = searchParams.get('source_incident_id') ?? '';
  const connectorSetupOpen = searchParams.get('setup') === 'connectors';
  const activeProfiles = (serviceProfiles.data?.profiles ?? []).filter(profile =>
    profile.status === 'active' && profile.activeRevision && profile.allowedActions.includes('investigate'));
  const selectedProfile: AiOpsServiceProfile | undefined = activeProfiles.find(profile => profile.id === selectedProfileId)
    ?? activeProfiles[0];

  useEffect(() => {
    if (!selectedProfileId && activeProfiles[0]) setSelectedProfileId(activeProfiles[0].id);
  }, [selectedProfileId, activeProfiles.map(profile => profile.id).join(',')]);

  useEffect(() => {
    if (!workflow) return;
    setWorkflowInput(launchSource === 'incident' && sourceIncidentId
      ? alertInput(workflow, searchParams)
      : initialInput(workflow));
    if (launchSource === 'incident' && sourceIncidentId) setLaunchOpen(true);
  }, [workflow?.id, launchSource, sourceIncidentId]);

  const requiredCategories = workflow?.requiredBundleCategories ?? [];
  const recommendedCategories = workflow?.recommendedBundleCategories ?? [];
  const allExecutionTargets = (fabric.data?.backends ?? []).flatMap(backend => backend.executionTargets ?? []);
  const kubernetesCertifications = fabric.data?.kubernetesCertifications ?? [];
  const certificationPolicy = fabric.data?.kubernetesCertificationPolicy ?? {
    warningAgeHours: 120,
    maxAgeHours: 168,
    enforceAIOps: true,
  };
  const executionTargets = allExecutionTargets
    .filter(target => target.bundleIds.some(bundleId => bundleIds.includes(bundleId)));
  const targetKey = (target: FabricExecutionTarget) => `${target.backendId}:${target.targetId}:${target.namespace}`;
  const certificationForTarget = (target: FabricExecutionTarget): FabricKubernetesCertification | undefined =>
    kubernetesCertifications.find(certification => certification.backendId === target.backendId && certification.targetId === target.targetId);
  const selectedPlatform = KUBERNETES_PLATFORM_ADAPTERS.find(adapter => adapter.id === selectedPlatformId);
  const selectedPlatformTargets = selectedPlatform
    ? allExecutionTargets.filter(target => target.platform === selectedPlatform.id)
    : [];
  const selectedCertificationTarget = selectedPlatformTargets.find(target => targetKey(target) === certificationTargetKey)
    ?? selectedPlatformTargets[0];
  const selectedCertification = selectedCertificationTarget
    ? certificationForTarget(selectedCertificationTarget)
    : undefined;
  const selectedCertificationRenewalAt = selectedCertification
    ? new Date(Date.parse(selectedCertification.generatedAt) + certificationPolicy.warningAgeHours * 3_600_000)
    : undefined;
  const selectedCertificationWasAutomated = selectedCertification?.importedBy?.startsWith('automation:') === true;
  const certificationUsable = (certification: FabricKubernetesCertification | undefined) =>
    certification?.status === 'passed' && certification.freshness !== 'stale';
  const selectedPlatformCertificationCount = selectedPlatformTargets.filter(target => certificationUsable(certificationForTarget(target))).length;
  const certifiedTargetCount = allExecutionTargets.filter(target => certificationUsable(certificationForTarget(target))).length;
  const selectedTarget = executionTargets.find(target => targetKey(target) === selectedTargetKey);
  const executionTargetSignature = executionTargets
    .map(target => `${target.backendId}:${target.targetId}:${target.namespace}`)
    .join('|');

  useEffect(() => {
    if (!workflow || !fabric.data || launchSource !== 'incident' || !sourceIncidentId || bundleIds.length > 0) return;
    const candidates = fabric.data.bundles
      .filter(bundle => requiredCategories.every(category => bundle.capabilityCategories?.includes(category)))
      .sort((left, right) => {
        if (left.name === 'argus-aiops-observe') return -1;
        if (right.name === 'argus-aiops-observe') return 1;
        const leftScore = recommendedCategories.filter(category => left.capabilityCategories?.includes(category)).length;
        const rightScore = recommendedCategories.filter(category => right.capabilityCategories?.includes(category)).length;
        return rightScore - leftScore || right.toolCount - left.toolCount;
      });
    if (candidates[0]) setBundleIds([candidates[0].id]);
  }, [workflow?.id, fabric.data?.generatedAt, launchSource, sourceIncidentId]);

  useEffect(() => {
    if (launchSource !== 'incident' || !sourceIncidentId || selectedTargetKey || executionTargets.length === 0) return;
    const target = executionTargets.find(candidate => certificationUsable(certificationForTarget(candidate)))
      ?? executionTargets[0];
    setSelectedTargetKey(targetKey(target));
    setWorkflowInput(input => ({ ...input, environment: target.environment }));
  }, [launchSource, sourceIncidentId, selectedTargetKey, executionTargetSignature]);
  const certificationHistory = useQuery({
    queryKey: ['kubernetes-certification-history', selectedCertificationTarget?.backendId, selectedCertificationTarget?.targetId],
    queryFn: () => getKubernetesCertificationHistory(
      selectedCertificationTarget!.backendId,
      selectedCertificationTarget!.targetId,
      10,
    ),
    enabled: Boolean(selectedPlatformId && selectedCertificationTarget),
    staleTime: 30_000,
  });
  const profileInputValid = Boolean(selectedProfile
    && String(workflowInput['title'] ?? '').trim().length >= 3
    && String(workflowInput['summary'] ?? '').trim().length >= 3);
  const investigationInput = {
    title: String(workflowInput['title'] ?? '').trim(),
    summary: String(workflowInput['summary'] ?? '').trim(),
    severity: String(workflowInput['severity'] ?? 'warning') as 'critical' | 'warning' | 'info',
    ...(workflowInput['started_at'] ? { startedAt: String(workflowInput['started_at']) } : {}),
    ...(workflowInput['alert_source'] ? { alertSource: String(workflowInput['alert_source']) } : {}),
    ...(workflowInput['alert_url'] ? { alertUrl: String(workflowInput['alert_url']) } : {}),
    ...(workflowInput['signal_keyword'] ? { keyword: String(workflowInput['signal_keyword']) } : {}),
    ...(workflowInput['signal_fingerprint'] ? { fingerprint: String(workflowInput['signal_fingerprint']) } : {}),
    ...(sourceIncidentId && Number.isSafeInteger(Number(sourceIncidentId)) && Number(sourceIncidentId) > 0
      ? { sourceIncidentId: Number(sourceIncidentId) }
      : {}),
  };

  const preflight = useMutation({
    mutationFn: () => runSolutionPackPreflight(packId, orchestrator!.id, {
      workflowId: workflow!.id,
      bundleIds,
      ...(selectedTarget ? {
        resourceScope: {
          kind: selectedTarget.kind,
          backendId: selectedTarget.backendId,
          targetId: selectedTarget.targetId,
          namespace: selectedTarget.namespace,
        },
      } : {}),
    }),
  });
  const certificationImport = useMutation({
    mutationFn: (input: { backendId: number; report: unknown }) => importKubernetesCertification(input.backendId, input.report),
    onSuccess: async () => {
      setCertificationFileError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['fabric-management'] }),
        queryClient.invalidateQueries({ queryKey: ['kubernetes-certification-history'] }),
      ]);
    },
  });
  const importCertificationFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || !selectedCertificationTarget) return;
    try {
      if (file.size > 512_000) throw new Error('Certification report must be smaller than 500 KB.');
      const report = JSON.parse(await file.text()) as unknown;
      setCertificationFileError(null);
      certificationImport.mutate({ backendId: selectedCertificationTarget.backendId, report });
    } catch (error) {
      setCertificationFileError(error instanceof Error ? error.message : 'Certification report could not be read.');
    } finally {
      input.value = '';
    }
  };
  const start = useMutation({
    mutationFn: ({ profileId, input }: { profileId: number; input: typeof investigationInput }) =>
      startAiOpsServiceProfileInvestigation(profileId, input),
    onSuccess: result => {
      setSeedTask(result.task);
      setSeedRootTraceId(result.rootTraceId);
      setSearchParams(current => {
        const next = new URLSearchParams(current);
        next.set('task', result.task.id);
        return next;
      });
      setLaunchOpen(false);
      queryClient.setQueryData(
        ['solution-pack-task', packId, orchestrator?.id, result.task.id],
        { task: result.task },
      );
      void queryClient.invalidateQueries({ queryKey: ['solution-pack-tasks', packId, orchestrator?.id] });
    },
  });
  const taskHistory = useQuery({
    queryKey: ['solution-pack-tasks', packId, orchestrator?.id, historyCursor ?? 'first'],
    queryFn: () => getSolutionPackTasks(packId, orchestrator!.id, { limit: 6, ...(historyCursor ? { cursor: historyCursor } : {}) }),
    enabled: Boolean(orchestrator && pack?.state === 'ready'),
    refetchInterval: queryState => queryState.state.data?.tasks.some(entry => !TERMINAL_TASK_STATES.has(entry.task.status.state))
      ? 3_000
      : false,
  });
  const taskQuery = useQuery({
    queryKey: ['solution-pack-task', packId, orchestrator?.id, selectedTaskId],
    queryFn: () => getSolutionPackTask(packId, orchestrator!.id, selectedTaskId),
    enabled: Boolean(orchestrator && selectedTaskId),
    refetchInterval: queryState => TERMINAL_TASK_STATES.has(
      queryState.state.data?.task.status.state ?? (seedTask?.id === selectedTaskId ? seedTask.status.state : ''),
    ) ? false : 2_000,
  });
  const task = taskQuery.data?.task ?? (seedTask?.id === selectedTaskId ? seedTask : undefined);
  const plan = asInvestigationPlan(task);
  const evidence = asInvestigationEvidence(task);
  const writeAccessDeclared = plan?.safety.writeActionsAllowed === true;
  const readOnlyEvidence = !writeAccessDeclared && (
    plan?.safety.readOnly === true || evidence?.safety.mode === 'read-only'
  );
  const preflightEvidence = artifactData(preflight.data?.task);
  const taskState = task?.status.state ?? '';
  const taskMessage = task?.status.message?.parts?.map(part => part.text).filter(Boolean).join(' ') ?? '';
  const rootTraceId = typeof task?.metadata?.['rootTraceId'] === 'string'
    ? task.metadata['rootTraceId']
    : typeof task?.metadata?.['argusRootTraceId'] === 'string'
      ? task.metadata['argusRootTraceId']
      : seedTask?.id === selectedTaskId ? seedRootTraceId : '';

  useEffect(() => {
    if (task && TERMINAL_TASK_STATES.has(task.status.state)) {
      void queryClient.invalidateQueries({ queryKey: ['solution-pack-tasks', packId, orchestrator?.id] });
    }
  }, [task?.id, task?.status.state, packId, orchestrator?.id, queryClient]);

  if (packs.isLoading) return <LoadingState label="Discovering Argus AIOps…" />;
  if (packs.error) return <ErrorState error={packs.error} />;
  if (!pack) return (
    <>
      <PageHeader eyebrow="SOLUTIONS" title="Argus AIOps" description="Evidence-first incident investigation delivered as an external Solution Pack." />
      <section className="panel solution-empty">
        <EmptyState title="Argus AIOps is not connected" description="Configure argus.aiops through ARGUS_SOLUTION_PACK_ENDPOINTS, then refresh discovery." />
        <button className="button button-primary" type="button" onClick={() => refresh.mutate()}><RefreshCw size={15} />Refresh packs</button>
      </section>
    </>
  );

  const title = manifest?.metadata.displayName ?? 'Argus AIOps';
  return (
    <>
      <PageHeader
        eyebrow="SOLUTIONS · ARGUS CORE"
        title={title}
        description={manifest?.metadata.description ?? 'Governed, provider-neutral incident investigation.'}
        actions={<>
          <a className="button button-secondary" href="/observe/dependencies?view=services"><Network size={15} />Service topology</a>
          <button className="button button-secondary" type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw className={refresh.isPending ? 'spin' : ''} size={15} />Refresh</button>
          <button className="button button-primary" type="button" disabled={!workflow} onClick={() => setLaunchOpen(true)}><SearchCheck size={15} />New investigation</button>
        </>}
      />

      <section className="solution-hero aiops-solution-hero">
        <div className="solution-identity">
          <span className="solution-mark"><Radar size={26} /></span>
          <div><small>CONTAINERIZED SOLUTION PACK</small><h2>{title}</h2><p>{pack.endpoint}</p></div>
          <HealthBadge state={packHealth(pack.state)} />
        </div>
        <div className="solution-facts">
          <span><b>{manifest?.metadata.version ?? '—'}</b><small>pack version</small></span>
          <span><b>{workflows.length}</b><small>workflows</small></span>
          <span><b>{workflow?.requiredAgents.length ?? 0}</b><small>Core agents</small></span>
          <span><b>Read-only</b><small>execution mode</small></span>
          <span><b>{pack.readiness?.latencyMs ?? '—'}{pack.readiness ? ' ms' : ''}</b><small>readiness</small></span>
        </div>
      </section>

      {aiopsReadiness.isLoading ? (
      <section className="panel aiops-connected-readiness" aria-label="AIOps evidence readiness">
        <LoadingState label="Checking governed AIOps evidence…" />
      </section>
      ) : aiopsReadiness.data?.presentation === 'connected_summary' && !connectorSetupOpen ? (
      <section className="panel aiops-connected-readiness" aria-labelledby="aiops-connected-readiness-title">
        <div className="panel-heading">
          <div><span className="eyebrow">AIOPS EVIDENCE</span><h2 id="aiops-connected-readiness-title">Evidence connected</h2><p>Argus can build service-specific investigations from the governed MCP evidence already available to you.</p></div>
          <HealthBadge state={aiopsReadiness.data.state === 'ready' ? 'healthy' : aiopsReadiness.data.state === 'blocked' ? 'offline' : 'degraded'} />
        </div>
        <div className="aiops-connected-card">
          <span className="aiops-connected-mark"><Network size={20} /></span>
          <div className="aiops-connected-copy">
            <small>PRIMARY GOVERNED BUNDLE</small>
            <h3>{aiopsReadiness.data.primaryConnection?.bundleName}</h3>
            <div className="aiops-connected-lanes" aria-label="Available evidence lanes">
              {aiopsReadiness.data.primaryConnection?.lanes.map(lane => <span key={lane}>{CAPABILITY_LABELS[lane === 'changes' ? 'repository' : lane === 'knowledge' ? 'rag' : lane] ?? lane}</span>)}
            </div>
          </div>
          <dl className="aiops-connected-facts">
            <div><dt>Evidence lanes</dt><dd>{aiopsReadiness.data.availableLanes.length}</dd></div>
            <div><dt>Service profiles</dt><dd>{aiopsReadiness.data.profiles.active}</dd></div>
            <div><dt>Certified targets</dt><dd>{aiopsReadiness.data.primaryConnection?.certifiedTargetCount ?? 0}</dd></div>
          </dl>
          <div className="aiops-connected-actions">
            <a className="button button-secondary" href="/mcp-fabric"><Boxes size={14} />Manage evidence</a>
            <button className="button button-secondary" type="button" onClick={() => setSearchParams(current => {
              const next = new URLSearchParams(current);
              next.set('setup', 'connectors');
              return next;
            })}><Cloud size={14} />Add environment</button>
          </div>
        </div>
        {aiopsReadiness.data.issues.length > 0 && <div className="aiops-connected-issues" role="status">{aiopsReadiness.data.issues.map(issue => <span key={issue.code}><AlertTriangle size={13} />{issue.message}</span>)}</div>}
      </section>
      ) : (
      <section className="panel aiops-platform-readiness" aria-labelledby="aiops-platform-readiness-title">
        <div className="panel-heading">
          <div><span className="eyebrow">KUBERNETES CONNECTOR READINESS</span><h2 id="aiops-platform-readiness-title">One evidence contract, five platforms</h2><p>Choose a platform to configure its workload identity, publish a governed MCP Fabric target and run the live certification gate.</p></div>
          <div className="aiops-platform-heading-actions">
            {aiopsReadiness.data?.presentation === 'connected_summary' && <button className="button button-secondary" type="button" onClick={() => setSearchParams(current => {
              const next = new URLSearchParams(current);
              next.delete('setup');
              return next;
            })}>Back to evidence summary</button>}
            <div className="aiops-platform-summary" aria-label="Platform readiness summary"><span><b>{KUBERNETES_PLATFORM_ADAPTERS.length}</b><small>adapters</small></span><span><b>{allExecutionTargets.length}</b><small>targets</small></span><span><b>{certifiedTargetCount}</b><small>certified targets</small></span></div>
          </div>
        </div>
        <div className="aiops-platform-grid">
          {KUBERNETES_PLATFORM_ADAPTERS.map(adapter => {
            const targets = allExecutionTargets.filter(target => target.platform === adapter.id);
            const connected = targets.length > 0;
            const certifications = targets.map(certificationForTarget).filter((certification): certification is FabricKubernetesCertification => Boolean(certification));
            const certified = connected && certifications.length === targets.length && certifications.every(certification => certificationUsable(certification));
            const failed = certifications.some(certification => certification.status === 'failed');
            const stale = certifications.some(certification => certification.status === 'passed' && certification.freshness === 'stale');
            const expiring = certifications.some(certification => certification.status === 'passed' && certification.freshness === 'expiring');
            const status = fabric.isLoading ? 'Checking' : failed ? 'Certification failed' : stale ? 'Certification stale' : expiring && certified ? 'Expiring' : certified ? 'Certified' : connected ? 'Connected' : 'Setup required';
            return <button className={failed ? 'has-certification-failure' : stale ? 'has-certification-stale' : expiring ? 'has-certification-warning' : certified ? 'is-certified' : connected ? 'is-connected' : ''} type="button" key={adapter.id} aria-label={`Open ${adapter.label} setup`} onClick={() => {
              setSelectedPlatformId(adapter.id);
              setCertificationTargetKey(targets[0] ? targetKey(targets[0]) : '');
              setCertificationFileError(null);
              certificationImport.reset();
            }}>
              <header><span>{adapter.id === 'kubernetes' ? <Server size={18} /> : <Cloud size={18} />}</span><em className={failed ? 'is-failed' : stale ? 'is-stale' : expiring ? 'is-expiring' : certified ? 'is-certified' : connected ? 'is-connected' : 'is-setup'}>{status}</em></header>
              <div><h3>{adapter.label}</h3><p>{adapter.provider}</p></div>
              <dl><div><dt>Identity</dt><dd>{adapter.identity}</dd></div><div><dt>Fabric targets</dt><dd>{targets.length}</dd></div></dl>
              <footer><span>{failed ? `${certifications.reduce((sum, certification) => sum + certification.failedCount, 0)} checks failed` : stale ? 'Re-certification required' : expiring ? 'Re-certify before expiry' : certified ? `${certifications[0]?.checkCount ?? 0} checks passed` : 'Adapter available'}</span><ArrowRight size={14} /></footer>
            </button>;
          })}
        </div>
        <div className="aiops-platform-legend"><span><i className="is-certified" />Fresh evidence is stored and bound to the Fabric target.</span><span><i className="is-expiring" />Expiring evidence remains usable but should be renewed.</span><span><i className="is-stale" />Stale evidence blocks new AIOps grants.</span><span><i className="is-connected" />Connected means a governed target is published in MCP Fabric.</span></div>
      </section>
      )}

      <AiOpsServiceProfilesPanel readiness={aiopsReadiness.data} bundles={(fabric.data?.bundles ?? []).map(bundle => ({
        id: bundle.id,
        name: bundle.name,
        label: bundle.label,
        capabilityCategories: bundle.capabilityCategories,
       }))} tools={(fabric.data?.tools ?? []).map(tool => ({
        name: tool.name,
        description: tool.description,
        enabled: tool.enabled,
        isWrite: tool.isWrite,
         bundleIds: tool.bundleIds,
        }))} targets={allExecutionTargets.filter(target => certificationUsable(certificationForTarget(target)))} />

      {pack.error && <div className="editor-error" role="alert">{pack.error}</div>}
      <section className="panel aiops-control-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">INCIDENT CONTROL PLANE</span><h2>{workflow?.label ?? 'Loading workflow contract…'}</h2><p>{workflow?.description ?? 'Reading the A2A Agent Card from the external pack.'}</p></div>
          <button className="button button-primary" type="button" disabled={!workflow} onClick={() => setLaunchOpen(true)}><Play size={14} />Investigate</button>
        </div>
        {catalog.isLoading ? <LoadingState label="Loading AIOps workflow…" /> : catalog.error ? <ErrorState error={catalog.error} /> : workflow ? (
          <>
            <div className="aiops-workflow-flow" aria-label="Incident investigation stages">
              {workflow.stages.map((stage, index) => <div key={stage.id}><span>{index + 1}</span><b>{stage.label}</b><small>{stage.hint}</small>{index < workflow.stages.length - 1 && <ArrowRight size={12} />}</div>)}
            </div>
            <div className="aiops-contract-grid">
              <article><span className="eyebrow">REQUIRED</span><h3>Minimum evidence boundary</h3><div className="aiops-capability-list">{requiredCategories.map(category => <span key={category}><CheckCircle2 size={13} />{CAPABILITY_LABELS[category] ?? category}</span>)}</div><p>An investigation cannot start until a selected Core bundle provides every required category.</p></article>
              <article><span className="eyebrow">RECOMMENDED</span><h3>Higher-confidence correlation</h3><div className="aiops-capability-list">{recommendedCategories.map(category => <span key={category}><Activity size={13} />{CAPABILITY_LABELS[category] ?? category}</span>)}</div><p>Missing optional evidence stays visible; the agent must not silently invent it.</p></article>
              <article><span className="eyebrow">SAFETY</span><h3>Evidence before automation</h3><div className="aiops-capability-list"><span><ShieldCheck size={13} />Read-only tools</span><span><Database size={13} />No raw telemetry in Pack artifacts</span><span><Bot size={13} />Core-owned grants</span></div><p>Remediation and infrastructure writes are deliberately outside this first vertical slice.</p></article>
            </div>
            <div className="aiops-preflight-row">
              <button className="button button-secondary" type="button" disabled={preflight.isPending || !orchestrator} onClick={() => preflight.mutate()}><ShieldCheck size={14} />{preflight.isPending ? 'Checking…' : 'Run boundary preflight'}</button>
              {preflight.data && <span className={preflightEvidence?.['ready'] === true ? 'is-ready' : 'is-blocked'}>{preflightEvidence?.['ready'] === true ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{preflightEvidence?.['ready'] === true ? 'Pack and bundle boundary ready' : 'Pack reachable; required bundle capability is missing'}</span>}
              {preflight.error && <div className="editor-error" role="alert">{preflight.error.message}</div>}
            </div>
          </>
        ) : <EmptyState title="No AIOps workflow published" description="The pack is connected but its Agent Card does not expose an x-argus-workflow contract." />}
      </section>

      <section className="panel aiops-run-history">
        <div className="panel-heading">
          <div><span className="eyebrow">AIOPS RUNS</span><h2>Incident investigations</h2><p>Persisted, Pack-owned evidence. Select a run to inspect its agent findings and correlated Core trace.</p></div>
          <span className="aiops-history-page">Page {historyPage + 1}</span>
        </div>
        {taskHistory.isLoading ? <LoadingState label="Loading incident history…" /> : taskHistory.error ? <ErrorState error={taskHistory.error} /> : taskHistory.data?.tasks.length ? (
          <div className="aiops-run-list">
            {taskHistory.data.tasks.map(entry => {
              const runPlan = asInvestigationPlan(entry.task);
              const runEvidence = asInvestigationEvidence(entry.task);
              const selected = entry.task.id === selectedTaskId;
              return <button className={selected ? 'is-selected' : ''} key={entry.task.id} type="button" aria-label={`Open investigation ${runPlan?.incident.title ?? entry.task.id}`} onClick={() => setSearchParams(current => {
                const next = new URLSearchParams(current);
                next.set('task', entry.task.id);
                return next;
              })}>
                <span className={`aiops-run-severity severity-${runPlan?.incident.severity ?? 'unknown'}`}><Radar size={14} /></span>
                <span className="aiops-run-copy"><b>{runPlan?.incident.title ?? 'Incident investigation'}</b><small>{runPlan ? `${runPlan.incident.service} · ${runPlan.incident.environment}` : entry.task.id}</small></span>
                <span className="aiops-run-time"><b>{new Date(entry.updatedAt).toLocaleString()}</b><small>{runEvidence?.quality ?? taskStateLabel(entry.task.status.state)}</small></span>
                <ArrowRight size={14} />
              </button>;
            })}
          </div>
        ) : <EmptyState title="No incident investigations yet" description="Start the first read-only investigation. Preflight checks are deliberately not shown as runs." />}
        <div className="aiops-history-pagination">
          <button className="button button-secondary" type="button" disabled={historyPage === 0} onClick={() => setHistoryCursors(cursors => cursors.slice(0, -1))}>Previous</button>
          <button className="button button-secondary" type="button" disabled={!taskHistory.data?.nextCursor} onClick={() => {
            const nextCursor = taskHistory.data?.nextCursor;
            if (nextCursor) setHistoryCursors(cursors => [...cursors, nextCursor]);
          }}>Next</button>
        </div>
      </section>

      {plan && <section className="panel aiops-evidence-panel">
        <div className="panel-heading"><div><span className="eyebrow">INCIDENT EVIDENCE</span><h2>{plan.incident.title}</h2><p>{plan.incident.summary}</p></div><div className="aiops-evidence-actions"><em className={`solution-task-state state-${taskStateLabel(taskState).replaceAll(' ', '-')}`}>{taskStateLabel(taskState)}</em><button type="button" aria-label="Close incident detail" onClick={() => setSearchParams(current => { const next = new URLSearchParams(current); next.delete('task'); return next; })}><X size={15} /></button></div></div>
        {taskMessage && <div className="aiops-task-message"><RefreshCw className={TERMINAL_TASK_STATES.has(taskState) ? '' : 'spin'} size={14} /><span>{taskMessage}</span></div>}
        {taskQuery.error && <div className="editor-error" role="alert">{taskQuery.error.message}</div>}
        <div className="aiops-evidence-meta"><span><small>SEVERITY</small><b>{plan.incident.severity}</b></span><span><small>SERVICE</small><b>{plan.incident.service}</b></span><span><small>ENVIRONMENT</small><b>{plan.incident.environment}</b></span><span><small>WINDOW</small><b>{new Date(plan.scope.windowStart).toLocaleTimeString()}–{new Date(plan.scope.windowEnd).toLocaleTimeString()}</b></span></div>
        {evidence?.signalCoverage && <div className="aiops-signal-coverage" aria-label="Signal coverage">
          {evidence.signalCoverage.map(signal => <span className={`state-${signal.status}`} key={signal.lane}><i>{signal.status === 'collected' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}</i><b>{signal.lane}</b><small>{signal.queryCount > 0 ? `${signal.queryCount} · ${signal.sources.join(', ')}` : signal.status}</small></span>)}
        </div>}
        {evidence?.timeline && evidence.timeline.length > 0 && <section className="aiops-signal-timeline">
          <header><span><Network size={14} /><b>Correlated evidence timeline</b></span><small>{evidence.timeline.length} provider queries · Pack stores normalized evidence only</small></header>
          <div>{evidence.timeline.map(event => <article key={event.id}><time>{new Date(event.timestamp).toLocaleTimeString()}</time><i className={`lane-${event.lane}`} /><span><b>{event.title}</b><small>{event.summary}</small>{event.correlationKey && <em>{event.correlationKey}</em>}</span></article>)}</div>
        </section>}
        {evidence?.kubernetesEvidence && <section className="aiops-kubernetes-evidence" aria-label="Kubernetes topology evidence">
          <header>
            <span><Boxes size={15} /><span><b>Kubernetes topology</b><small>Normalized Pack evidence · bounded audit previews remain in Core</small></span></span>
            <em>{evidence.kubernetesEvidence.namespace}</em>
          </header>
          <div className="aiops-kubernetes-map">
            {KUBERNETES_RESOURCE_GROUPS.map(group => {
              const resources = evidence.kubernetesEvidence!.resources.filter(resource => resource.kind === group);
              return <section key={group}>
                <header><span>{group === 'Pod' ? <Container size={13} /> : <Network size={13} />}</span><b>{group}{group === 'Service' ? '' : 's'}</b><em>{resources.length}</em></header>
                <div>{resources.length > 0 ? resources.map(resource => {
                  const sourceHref = provenanceHref(rootTraceId, resource.provenance);
                  return <article key={`${resource.kind}/${resource.name}`}>
                    <i className={`state-${kubernetesStatusTone(resource.status)}`} />
                    <span><b>{resource.name}</b><small>{resource.owner ? `owner: ${resource.owner}` : Object.entries(resource.labels).slice(0, 2).map(([key, value]) => `${key}=${value}`).join(' · ') || resource.kind}</small></span>
                    <em>{resource.status}</em>
                    {sourceHref && <a href={sourceHref} aria-label={`Inspect ${resource.kind} ${resource.name} source span`} title={resource.provenance.toolName}><SearchCheck size={13} /></a>}
                  </article>;
                }) : <p>No {group.toLowerCase()} evidence</p>}</div>
              </section>;
            })}
          </div>
          {evidence.kubernetesEvidence.edges.length > 0 && <div className="aiops-kubernetes-relations" aria-label="Kubernetes resource relations">
            {evidence.kubernetesEvidence.edges.map((edge, index) => <span key={`${edge.from}-${edge.to}-${index}`}><b>{edge.from}</b><em>{edge.relation}</em><ArrowRight size={11} /><b>{edge.to}</b></span>)}
          </div>}
          {evidence.kubernetesEvidence.events.length > 0 && <div className="aiops-kubernetes-events">
            <header><b>Recent cluster events</b><small>{evidence.kubernetesEvidence.events.length} bounded events</small></header>
            {evidence.kubernetesEvidence.events.map((event, index) => {
              const sourceHref = provenanceHref(rootTraceId, event.provenance);
              return <article className={event.type.toLowerCase() === 'warning' ? 'is-warning' : ''} key={`${event.timestamp}-${event.object}-${index}`}>
                <time>{new Date(event.timestamp).toLocaleTimeString()}</time><span><b>{event.reason}</b><small>{event.object} · {event.message}</small></span><em>{event.type}</em>
                {sourceHref && <a href={sourceHref} aria-label={`Inspect ${event.object} event source span`} title={event.provenance.toolName}><SearchCheck size={13} /></a>}
              </article>;
            })}
          </div>}
        </section>}
        {!evidence && <div className="aiops-evidence-lanes">{plan.evidenceLanes.map(lane => <article key={lane.id}><header><Activity size={14} /><b>{lane.id}</b></header><p>{lane.purpose}</p><small>{lane.requiredCapabilities.join(' · ')}</small></article>)}</div>}
        {evidence && <>
          <div className="aiops-agent-evidence">
            {evidence.agentEvidence.map(agent => <article className={`state-${agent.status}`} key={agent.role}>
              <header><span><Bot size={14} /><b>{agent.role}</b></span><em>{agent.status}</em></header>
              <div className="aiops-agent-meta"><span>{agent.model ?? 'runtime unavailable'}</span><span>{(agent.durationMs / 1000).toFixed(1)} s</span><span>{agent.toolCalls.length} tool calls</span></div>
              {agent.error ? <p className="aiops-agent-error">{agent.error}</p> : <pre>{agent.outputSummary}</pre>}
              {agent.toolCalls.length > 0 && <footer>{agent.toolCalls.map((call, index) => <span key={`${call.name}-${index}`}>{call.name}</span>)}</footer>}
            </article>)}
          </div>
          <article className={`aiops-synthesis state-${evidence.quality}`}>
            <header><span><SearchCheck size={15} /><b>Reviewer synthesis</b></span><em>{evidence.quality}</em></header>
            <pre>{evidence.synthesis}</pre>
          </article>
        </>}
        <div className="aiops-plan-footer"><span><ShieldCheck size={14} />{writeAccessDeclared ? 'Write access declared' : readOnlyEvidence ? 'Read-only investigation' : 'Safety mode unavailable'} · Pack raw telemetry {plan.safety.rawTelemetryPersisted ? 'retained' : 'not retained'}</span><span><Clock3 size={14} />{new Date(plan.generatedAt).toLocaleString()}</span>{rootTraceId && <><a href={`/runs/workflow/${encodeURIComponent(rootTraceId)}`}>Open Core trace <ArrowRight size={12} /></a><a href={`/observe/logs?root_trace=${encodeURIComponent(rootTraceId)}`}>Correlated logs <Network size={12} /></a></>}</div>
      </section>}

      {launchOpen && workflow && <div className="solution-dialog-layer" role="presentation" onMouseDown={() => setLaunchOpen(false)}>
        <section className="solution-start-dialog" role="dialog" aria-modal="true" aria-label="Start Argus AIOps investigation" onMouseDown={event => event.stopPropagation()}>
          <header><div><span className="eyebrow">SERVICE-AWARE AIOPS</span><h2>Run Argus AIOps</h2><p>Choose the affected service. Argus resolves its evidence, queries and runtime boundary from the active immutable profile.</p></div><button type="button" aria-label="Close investigation dialog" onClick={() => setLaunchOpen(false)}><X size={17} /></button></header>
          <form className="solution-run-form" onSubmit={event => {
            event.preventDefault();
            if (selectedProfile) start.mutate({ profileId: selectedProfile.id, input: investigationInput });
          }}>
            {sourceIncidentId && <div className="aiops-alert-handoff" role="status"><AlertTriangle size={15} /><span><b>Prefilled from native alert #{sourceIncidentId}</b><small>Review the scope and evidence boundary before starting the governed investigation.</small></span><a href={`/observe/alerts?incident=${encodeURIComponent(sourceIncidentId)}`}>Open source incident <ExternalLink size={12} /></a></div>}
            <label className="editor-field"><span>Service profile <em>required</em></span><select aria-label="AIOps service profile" required value={selectedProfile?.id ?? ''} onChange={event => setSelectedProfileId(Number(event.target.value))}><option value="">Select an active service profile</option>{activeProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.latestRevision.config.service.displayName} · {profile.latestRevision.config.service.environment}</option>)}</select><small>The browser sends only this profile ID and the incident signal. Core owns the effective revision and access scope.</small></label>
            {selectedProfile ? <div className="aiops-profile-run-boundary" role="status"><ShieldCheck size={16} /><span><b>{selectedProfile.latestRevision.config.service.serviceName} · {selectedProfile.latestRevision.config.service.environment}</b><small>{selectedProfile.activeRevision?.revision === selectedProfile.latestRevision.revision ? `Revision ${selectedProfile.activeRevision.revision} · ${selectedProfile.latestRevision.config.evidencePolicy.lanes.filter(lane => lane.requirement !== 'disabled').length} evidence lanes · ${selectedProfile.latestRevision.config.remediationPolicy.mode}` : `Active revision ${selectedProfile.activeRevision?.revision} is resolved by Argus Core · newer draft ${selectedProfile.latestRevision.revision} is not used`}</small></span><code>{selectedProfile.activeRevision?.sha256.slice(0, 12)}</code></div> : <div className="editor-error" role="alert">No active, authorized service profile is ready. Validate and activate one below first.</div>}
            {workflow.inputSchema.filter(field => ['title', 'summary', 'severity', 'started_at', 'alert_source', 'alert_url'].includes(field.name)).map(field => <label className="editor-field" key={field.name}><span>{field.label} {['title', 'summary'].includes(field.name) && <em>required</em>}</span>{field.type === 'textarea' ? <textarea required={['title', 'summary'].includes(field.name)} maxLength={20_000} rows={4} value={String(workflowInput[field.name] ?? '')} onChange={event => setWorkflowInput(input => ({ ...input, [field.name]: event.target.value }))} placeholder={field.placeholder} /> : field.type === 'select' ? <select value={String(workflowInput[field.name] ?? field.defaultValue ?? '')} onChange={event => setWorkflowInput(input => ({ ...input, [field.name]: event.target.value }))}>{field.options?.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : <input type="text" value={String(workflowInput[field.name] ?? '')} onChange={event => setWorkflowInput(input => ({ ...input, [field.name]: event.target.value }))} placeholder={field.placeholder} />}{field.description && <small>{field.description}</small>}</label>)}
            <div className="aiops-signal-grid"><label className="editor-field"><span>Log keyword</span><input maxLength={500} value={String(workflowInput['signal_keyword'] ?? '')} onChange={event => setWorkflowInput(input => ({ ...input, signal_keyword: event.target.value }))} placeholder="e.g. circuit_breaker_open" /><small>Optional signal substituted only into approved query recipes.</small></label><label className="editor-field"><span>Fingerprint</span><input maxLength={500} value={String(workflowInput['signal_fingerprint'] ?? '')} onChange={event => setWorkflowInput(input => ({ ...input, signal_fingerprint: event.target.value }))} placeholder="Provider alert fingerprint" /></label></div>
            {start.error && <div className="editor-error" role="alert">{start.error.message}</div>}
            <footer><button className="button button-secondary" type="button" onClick={() => setLaunchOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={!profileInputValid || start.isPending}><Radar size={15} />{start.isPending ? 'Resolving profile & starting…' : 'Start profile-backed investigation'}</button></footer>
          </form>
        </section>
      </div>}

      {selectedPlatform && <div className="solution-dialog-layer" role="presentation" onMouseDown={() => setSelectedPlatformId(null)}>
        <section className="aiops-platform-dialog" role="dialog" aria-modal="true" aria-label={`${selectedPlatform.label} platform setup`} onMouseDown={event => event.stopPropagation()}>
          <header><div><span className="eyebrow">{selectedPlatform.provider.toUpperCase()}</span><h2>{selectedPlatform.label} connector setup</h2><p>Bring the platform identity; Argus Core keeps bundles, execution scope and agent grants as the control plane.</p></div><button type="button" aria-label="Close platform setup" onClick={() => setSelectedPlatformId(null)}><X size={17} /></button></header>
          <div className="aiops-platform-dialog-body">
            <div className="aiops-platform-dialog-status">
              <span className="is-ready"><CheckCircle2 size={15} /><b>Adapter contract</b><small>Available</small></span>
              <span className={selectedPlatformTargets.length > 0 ? 'is-ready' : 'is-pending'}><Network size={15} /><b>MCP Fabric target</b><small>{selectedPlatformTargets.length > 0 ? `${selectedPlatformTargets.length} configured` : 'Not configured'}</small></span>
              <span className={selectedPlatformTargets.length > 0 && selectedPlatformCertificationCount === selectedPlatformTargets.length ? 'is-ready' : selectedCertification?.status === 'failed' ? 'is-failed' : 'is-pending'}><ShieldCheck size={15} /><b>Live certification</b><small>{selectedPlatformTargets.length > 0 && selectedPlatformCertificationCount === selectedPlatformTargets.length ? `${selectedPlatformCertificationCount} certified` : selectedCertification?.status === 'failed' ? `${selectedCertification.failedCount} checks failed` : 'Run per deployment'}</small></span>
            </div>
            <div className="aiops-platform-setup-grid">
              <section>
                <span className="eyebrow">SETUP FLOW</span>
                <ol className="aiops-platform-steps">
                  <li className="is-complete"><span><Check size={13} /></span><div><b>Use the platform adapter</b><small>Start from <code>{selectedPlatform.contract}</code>.</small></div></li>
                  <li><span><KeyRound size={13} /></span><div><b>Configure workload identity</b><small>{selectedPlatform.identity}; no credentials are exposed to the Solution Pack.</small></div></li>
                  <li className={selectedPlatformTargets.length > 0 ? 'is-complete' : ''}><span>{selectedPlatformTargets.length > 0 ? <Check size={13} /> : <Network size={13} />}</span><div><b>Publish through MCP Fabric</b><small>Assign the connector and its namespace boundary to an access bundle.</small></div></li>
                  <li className={selectedPlatformTargets.length > 0 && selectedPlatformCertificationCount === selectedPlatformTargets.length ? 'is-complete' : ''}><span>{selectedPlatformTargets.length > 0 && selectedPlatformCertificationCount === selectedPlatformTargets.length ? <Check size={13} /> : <ShieldCheck size={13} />}</span><div><b>Run the live certification gate</b><small>Validate identity, RBAC, namespace isolation, TLS and read-only tool behavior against the real cluster.</small></div></li>
                </ol>
              </section>
              <section>
                <span className="eyebrow">PLATFORM GUARDRAILS</span>
                <div className="aiops-platform-guardrails">{selectedPlatform.guardrails.map(guardrail => <span key={guardrail}><CheckCircle2 size={14} />{guardrail}</span>)}</div>
                {selectedPlatformTargets.length > 0 && <div className="aiops-platform-targets"><b>Published targets</b>{selectedPlatformTargets.map(target => <span key={`${target.backendId}:${target.targetId}:${target.namespace}`}><i />{target.cluster}<small>{target.namespace} · {target.environment}</small></span>)}</div>}
              </section>
            </div>
            <section className="aiops-platform-commands">
              <div><span><Terminal size={14} />Configure identity</span><code>{selectedPlatform.configureCommand}</code></div>
              <div><span><ShieldCheck size={14} />Certify connector</span><code>{selectedPlatform.certifyCommand}</code></div>
            </section>
            <section className="aiops-certification-panel" aria-label={`${selectedPlatform.label} certification evidence`}>
              <header><span><FileCheck2 size={15} /><span><b>Certification evidence</b><small>Normalized report metadata stored by Argus Core</small></span></span>{selectedCertification && <em className={`is-${selectedCertification.status === 'failed' ? 'failed' : selectedCertification.freshness}`}>{selectedCertification.status === 'failed' ? 'failed' : selectedCertification.freshness}</em>}</header>
              {selectedPlatformTargets.length > 0 ? <>
                <div className="aiops-certification-toolbar">
                  <label className="editor-field"><span>Governed target</span><select aria-label="Certification target" value={selectedCertificationTarget ? targetKey(selectedCertificationTarget) : ''} onChange={event => setCertificationTargetKey(event.target.value)}>{selectedPlatformTargets.map(target => <option key={targetKey(target)} value={targetKey(target)}>{target.cluster} · {target.namespace}</option>)}</select></label>
                  <label className={`button button-secondary aiops-certification-import${certificationImport.isPending ? ' is-disabled' : ''}`}><Upload size={14} />{certificationImport.isPending ? 'Importingâ€¦' : 'Import report'}<input aria-label="Import certification report" type="file" accept="application/json,.json" disabled={certificationImport.isPending} onChange={importCertificationFile} /></label>
                </div>
                {selectedCertification ? <article className={`aiops-certification-record is-${selectedCertification.status === 'failed' ? 'failed' : selectedCertification.freshness}`}>
                  <div className="aiops-certification-metrics"><span><b>{selectedCertification.passedCount}/{selectedCertification.checkCount}</b><small>checks passed</small></span><span><b>{selectedCertification.profile}</b><small>profile</small></span><span><b>{Math.round(selectedCertification.ageHours)} h</b><small>evidence age</small></span><span><b>{new Date(selectedCertification.expiresAt).toLocaleString()}</b><small>{selectedCertification.freshness === 'stale' ? 'expired' : 'valid until'}</small></span></div>
                  <div className="aiops-certification-hashes"><span><small>CONTRACT SHA-256</small><code title={selectedCertification.contractSha256}>{selectedCertification.contractSha256}</code></span><span><small>REPORT SHA-256</small><code title={selectedCertification.reportSha256}>{selectedCertification.reportSha256}</code></span></div>
                  {selectedCertification.failedChecks.length > 0 ? <div className="aiops-certification-failures"><b>Failed checks</b>{selectedCertification.failedChecks.map(check => <span key={check.id}><AlertTriangle size={13} /><span><code>{check.id}</code><small>{check.detail}</small></span></span>)}</div> : <div className="aiops-certification-success"><CheckCircle2 size={15} /><span><b>All certification checks passed</b><small>Imported {new Date(selectedCertification.importedAt).toLocaleString()}{selectedCertification.importedBy ? ` by ${selectedCertification.importedBy}` : ''}</small></span></div>}
                  <div className={`aiops-certification-renewal is-${selectedCertification.status === 'failed' ? 'failed' : selectedCertification.freshness}`}><RefreshCw size={15} /><span><b>{selectedCertificationWasAutomated ? 'Scheduled renewal reporting' : 'External renewal available'}</b><small>{selectedCertification.status === 'failed' ? 'The latest renewal failed and new AIOps grants remain blocked until a passing report arrives.' : selectedCertification.freshness === 'stale' ? 'Evidence is expired. Run the external certifier before starting another investigation.' : selectedCertification.freshness === 'expiring' ? `Renew now; enforcement starts ${new Date(selectedCertification.expiresAt).toLocaleString()}.` : `Renewal window opens ${selectedCertificationRenewalAt?.toLocaleString()}.`}</small></span></div>
                </article> : <div className="aiops-certification-empty"><ShieldCheck size={17} /><span><b>No certification evidence stored</b><small>Run the platform command, then import the generated JSON report for this target.</small></span></div>}
                {certificationHistory.isLoading ? <small className="aiops-certification-history-loading">Loading certification history…</small> : certificationHistory.data?.history.length ? <div className="aiops-certification-history"><header><b>Certification history</b><small>Latest {certificationHistory.data.history.length} immutable reports</small></header>{certificationHistory.data.history.map((entry, index) => <span key={entry.id}><i className={`is-${entry.status === 'failed' ? 'failed' : entry.freshness}`} /> <span><b>{entry.status === 'failed' ? 'Failed' : entry.freshness === 'stale' ? 'Expired' : entry.freshness === 'expiring' ? 'Expiring' : 'Passed'}</b><small>{new Date(entry.generatedAt).toLocaleString()} · {entry.passedCount}/{entry.checkCount} checks · {entry.importedBy ?? 'system'}</small></span>{index === 0 && <em>latest</em>}</span>)}</div> : null}
              </> : <div className="aiops-certification-empty"><Network size={17} /><span><b>Publish a Fabric target first</b><small>Certification evidence can only be bound to an enabled, bundle-scoped execution target.</small></span></div>}
              {(certificationFileError || certificationImport.error) && <div className="editor-error" role="alert">{certificationFileError ?? certificationImport.error?.message}</div>}
            </section>
          </div>
          <footer><button className="button button-secondary" type="button" onClick={() => setSelectedPlatformId(null)}>Close</button><a className="button button-primary" href="/mcp-fabric">Open MCP Fabric <ExternalLink size={14} /></a></footer>
        </section>
      </div>}
    </>
  );
}
