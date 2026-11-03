import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, ArrowUpRight, Bot, Check, Database, Gauge, Layers3, Pause, Play, Plus, Search, ShieldCheck, TestTube2, X } from 'lucide-react';
import {
  activateAiOpsServiceProfile,
  createAiOpsServiceProfile,
  getAiOpsServiceProfileReadiness,
  getAiOpsServiceProfiles,
  getNativeAlerts,
  pauseAiOpsServiceProfile,
  preflightAiOpsEvidenceQuery,
  validateAiOpsServiceProfile,
} from '../api';
import type {
  AiOpsEvidenceLane,
  AiOpsEvidenceQueryTemplate,
  AiOpsEvidenceQueryPreflightResult,
  AiOpsEvidenceRequirement,
  AiOpsGlobalReadiness,
  AiOpsServiceProfile,
  AiOpsServiceProfileConfig,
  FabricExecutionTarget,
  NativeAlertRule,
} from '../types';
import { EmptyState, ErrorState, LoadingState } from './Ui';

type EvidenceBundle = {
  id: number;
  name: string;
  label: string;
  capabilityCategories?: string[];
};

type EvidenceTool = {
  name: string;
  description: string;
  enabled: boolean;
  isWrite: boolean;
  bundleIds: number[];
};

type LogDialect = 'elasticsearch' | 'opensearch' | 'loki' | 'generic';

type LogMappingDraft = {
  toolName: string;
  dialect: LogDialect;
  resource: string;
  defaultKeyword: string;
  timestampField: string;
  serviceField: string;
  environmentField: string;
  messageField: string;
  severityField: string;
  traceIdField: string;
  customTemplate: string;
};

type Draft = {
  displayName: string;
  serviceName: string;
  environment: string;
  description: string;
  team: string;
  criticality: AiOpsServiceProfileConfig['ownership']['criticality'];
  bundleId: number;
  lanes: Partial<Record<AiOpsEvidenceLane, AiOpsEvidenceRequirement>>;
  laneBundleIds: Partial<Record<AiOpsEvidenceLane, number>>;
  runtimeTargetKey: string;
  runtimeWorkloadsText: string;
  correlationWindowMinutes: number;
  autoInvestigate: boolean;
  nativeAlertRuleIds: number[];
  providerMonitorRefsText: string;
  cooldownMinutes: number;
  remediationMode: 'diagnose-only' | 'propose';
  logMapping: LogMappingDraft;
};

const LANE_ORDER: AiOpsEvidenceLane[] = ['metrics', 'logs', 'traces', 'runtime', 'topology', 'changes', 'knowledge', 'incident'];
const LANE_LABELS: Record<AiOpsEvidenceLane, string> = {
  metrics: 'Metrics',
  logs: 'Logs',
  traces: 'Traces',
  runtime: 'Runtime',
  topology: 'Topology',
  changes: 'Changes',
  knowledge: 'Knowledge',
  incident: 'Incidents',
};
const WIZARD_PRIMARY_EVIDENCE_LANES = new Set<AiOpsEvidenceLane>(['metrics', 'logs', 'traces', 'incident']);
const LOG_SOURCE = /(?:elastic|opensearch|splunk|loki|logql|(?:^|_)logs?(?:_|$)|pod_logs)/i;
const READ_QUERY_ACTION = /(?:search|query|find|read|get|range)/i;

function logToolScore(tool: EvidenceTool): number {
  const name = tool.name.toLowerCase();
  if (/(?:loki.*query|elastic.*search|opensearch.*search|splunk.*search|search_logs|query_logs)/.test(name)) return 3;
  if (/pod_logs/.test(name)) return 2;
  return 1;
}

function inferLogDialect(toolName: string): LogDialect {
  if (/loki|logql/i.test(toolName)) return 'loki';
  if (/opensearch/i.test(toolName)) return 'opensearch';
  if (/elastic/i.test(toolName)) return 'elasticsearch';
  return 'generic';
}

function logToolsForBundle(tools: EvidenceTool[], bundleId: number): EvidenceTool[] {
  return tools
    .filter(tool => {
      const searchable = `${tool.name} ${tool.description}`;
      return tool.enabled
        && !tool.isWrite
        && tool.bundleIds.includes(bundleId)
        && LOG_SOURCE.test(searchable)
        && READ_QUERY_ACTION.test(searchable)
        && !/(?:^|_)(?:label_values|labels)(?:_|$)/i.test(tool.name);
    })
    .sort((left, right) => logToolScore(right) - logToolScore(left) || left.name.localeCompare(right.name));
}

function logMappingForTool(toolName: string): LogMappingDraft {
  const dialect = inferLogDialect(toolName);
  return {
    toolName,
    dialect,
    resource: dialect === 'loki' ? 'application logs' : 'logs-*',
    defaultKeyword: 'error',
    timestampField: dialect === 'loki' ? 'timestamp' : '@timestamp',
    serviceField: dialect === 'loki' ? 'service' : 'service.name',
    environmentField: dialect === 'loki' ? 'environment' : 'service.environment',
    messageField: 'message',
    severityField: 'log.level',
    traceIdField: 'trace.id',
    customTemplate: '{"query":"${service.name}","start":"${window.start}","end":"${window.end}"}',
  };
}

function initialLogMapping(tools: EvidenceTool[], bundleId: number): LogMappingDraft {
  return logMappingForTool(logToolsForBundle(tools, bundleId)[0]?.name ?? '');
}

function bundleLanes(bundle: EvidenceBundle | undefined): AiOpsEvidenceLane[] {
  const categories = new Set(bundle?.capabilityCategories ?? []);
  return LANE_ORDER.filter(lane => categories.has(lane === 'changes' ? 'repository' : lane === 'knowledge' ? 'rag' : lane));
}

function supportsPrimaryEvidence(bundle: EvidenceBundle): boolean {
  return bundleLanes(bundle).some(lane => WIZARD_PRIMARY_EVIDENCE_LANES.has(lane));
}

function bundlesForLane(bundles: EvidenceBundle[], lane: AiOpsEvidenceLane): EvidenceBundle[] {
  return bundles.filter(bundle => bundleLanes(bundle).includes(lane));
}

function executionTargetKey(target: FabricExecutionTarget): string {
  return `${target.backendId}:${target.targetId}:${target.namespace}`;
}

function runtimeWorkloads(value: string): Array<{ kind: 'Deployment' | 'StatefulSet' | 'Job'; name: string }> {
  const supported = new Set(['Deployment', 'StatefulSet', 'Job']);
  const seen = new Set<string>();
  return value.split(/[\n,]/).flatMap(entry => {
    const [rawKind, ...nameParts] = entry.trim().split('/');
    const kind = rawKind?.trim();
    const name = nameParts.join('/').trim();
    const key = `${kind}/${name}`;
    if (!supported.has(kind ?? '') || !name || name.length > 200 || seen.has(key)) return [];
    seen.add(key);
    return [{ kind: kind as 'Deployment' | 'StatefulSet' | 'Job', name }];
  }).slice(0, 64);
}

function initialDraft(
  readiness: AiOpsGlobalReadiness | undefined,
  bundles: EvidenceBundle[],
  tools: EvidenceTool[],
): Draft {
  const preferred = bundles.find(bundle => bundle.id === readiness?.primaryConnection?.bundleId)
    ?? bundles.find(supportsPrimaryEvidence)
    ?? bundles[0];
  const lanes = bundleLanes(preferred);
  const required = lanes.includes('metrics') ? 'metrics' : lanes.includes('logs') ? 'logs' : lanes[0];
  return {
    displayName: '',
    serviceName: '',
    environment: 'production',
    description: '',
    team: '',
    criticality: 'medium',
    bundleId: preferred?.id ?? 0,
    lanes: Object.fromEntries(lanes.filter(lane => lane !== 'runtime').map(lane => [lane, lane === required ? 'required' : 'optional'])),
    laneBundleIds: Object.fromEntries(lanes.map(lane => [lane, preferred?.id ?? 0])),
    runtimeTargetKey: '',
    runtimeWorkloadsText: '',
    correlationWindowMinutes: 30,
    autoInvestigate: false,
    nativeAlertRuleIds: [],
    providerMonitorRefsText: '',
    cooldownMinutes: 30,
    remediationMode: 'diagnose-only',
    logMapping: initialLogMapping(tools, preferred?.id ?? 0),
  };
}

function queryTemplateFromDraft(draft: Draft): AiOpsEvidenceQueryTemplate | null {
  const mapping = draft.logMapping;
  if (!mapping.toolName || !draft.lanes.logs) return null;
  if (mapping.dialect === 'generic') {
    return {
      id: 'service-log-search',
      toolName: mapping.toolName,
      description: 'Bounded service log search',
      source: { kind: 'generic', ...(mapping.resource.trim() ? { resource: mapping.resource.trim() } : {}) },
      defaults: { ...(mapping.defaultKeyword.trim() ? { signalKeyword: mapping.defaultKeyword.trim() } : {}) },
      template: mapping.customTemplate.trim(),
    };
  }
  if (mapping.dialect === 'loki') {
    const labels = [
      `${mapping.serviceField.trim()}="${'${service.name}'}"`,
      `${mapping.environmentField.trim()}="${'${environment}'}"`,
    ].join(',');
    const query = `{${labels}}${mapping.defaultKeyword.trim() ? ` |= "${'${signal.keyword}'}"` : ''}`;
    return {
      id: 'service-log-search',
      toolName: mapping.toolName,
      description: 'Bounded service LogQL search',
      source: {
        kind: 'loki',
        ...(mapping.resource.trim() ? { resource: mapping.resource.trim() } : {}),
        fields: {
          timestamp: mapping.timestampField.trim(),
          service: mapping.serviceField.trim(),
          ...(mapping.environmentField.trim() ? { environment: mapping.environmentField.trim() } : {}),
          message: mapping.messageField.trim(),
          ...(mapping.severityField.trim() ? { severity: mapping.severityField.trim() } : {}),
          ...(mapping.traceIdField.trim() ? { traceId: mapping.traceIdField.trim() } : {}),
        },
      },
      defaults: { ...(mapping.defaultKeyword.trim() ? { signalKeyword: mapping.defaultKeyword.trim() } : {}) },
      template: JSON.stringify({ query, start: '${window.start}', end: '${window.end}', limit: 20 }),
    };
  }
  const filters: unknown[] = [
    { term: { [mapping.serviceField.trim()]: '${service.name}' } },
    { term: { [mapping.environmentField.trim()]: '${environment}' } },
    { range: { [mapping.timestampField.trim()]: { gte: '${window.start}', lte: '${window.end}' } } },
  ];
  const queryDsl = {
    size: 20,
    sort: [{ [mapping.timestampField.trim()]: 'desc' }],
    query: {
      bool: {
        filter: filters,
        ...(mapping.defaultKeyword.trim()
          ? { must: [{ match_phrase: { [mapping.messageField.trim()]: '${signal.keyword}' } }] }
          : {}),
      },
    },
  };
  const queryArgument = mapping.dialect === 'opensearch' && mapping.toolName === 'opensearch_search'
    ? 'query'
    : 'query_json';
  return {
    id: 'service-log-search',
    toolName: mapping.toolName,
    description: 'Bounded service log search',
    source: {
      kind: mapping.dialect,
      resource: mapping.resource.trim(),
      fields: {
        timestamp: mapping.timestampField.trim(),
        service: mapping.serviceField.trim(),
        ...(mapping.environmentField.trim() ? { environment: mapping.environmentField.trim() } : {}),
        message: mapping.messageField.trim(),
        ...(mapping.severityField.trim() ? { severity: mapping.severityField.trim() } : {}),
        ...(mapping.traceIdField.trim() ? { traceId: mapping.traceIdField.trim() } : {}),
      },
    },
    defaults: { ...(mapping.defaultKeyword.trim() ? { signalKeyword: mapping.defaultKeyword.trim() } : {}) },
    template: JSON.stringify({
      index: mapping.resource.trim(),
      [queryArgument]: JSON.stringify(queryDsl),
      ...(queryArgument === 'query' ? { size: 20 } : {}),
    }),
  };
}

function configFromDraft(draft: Draft, targets: FabricExecutionTarget[]): AiOpsServiceProfileConfig {
  const serviceName = draft.serviceName.trim();
  const enabledLanes = LANE_ORDER.filter(lane => draft.lanes[lane]);
  const requiredCount = enabledLanes.filter(lane => draft.lanes[lane] === 'required').length;
  const logQuery = queryTemplateFromDraft(draft);
  const providerMonitorRefs = [...new Set(draft.providerMonitorRefsText
    .split(/[\n,]/)
    .map(value => value.trim())
    .filter(Boolean))].slice(0, 64);
  const runtimeTarget = targets.find(target => executionTargetKey(target) === draft.runtimeTargetKey);
  const workloads = runtimeWorkloads(draft.runtimeWorkloadsText);
  return {
    schemaVersion: 1,
    service: {
      displayName: draft.displayName.trim(),
      serviceName,
      environment: draft.environment.trim(),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    },
    ownership: {
      ...(draft.team.trim() ? { team: draft.team.trim() } : {}),
      criticality: draft.criticality,
    },
    evidencePolicy: {
      lanes: enabledLanes.map(lane => ({
        lane,
        requirement: draft.lanes[lane]!,
        bundleId: draft.laneBundleIds[lane] ?? draft.bundleId,
        ...(lane === 'logs' && logQuery ? { toolAllowlist: [logQuery.toolName] } : {}),
        queryTemplates: lane === 'logs' && logQuery ? [logQuery] : [],
      })),
      minimumCollectedLanes: Math.max(1, requiredCount),
      correlationWindowMinutes: draft.correlationWindowMinutes,
      maxProviderResultBytes: 262_144,
    },
    selectors: {
      otelServiceNames: [serviceName],
      metricLabels: { service: serviceName, environment: draft.environment.trim() },
      logLabels: { service: serviceName, environment: draft.environment.trim() },
      traceOperations: [],
      ...(draft.lanes.runtime && runtimeTarget ? {
        runtime: {
          kind: 'kubernetes' as const,
          backendId: runtimeTarget.backendId,
          targetId: runtimeTarget.targetId,
          cluster: runtimeTarget.cluster,
          namespace: runtimeTarget.namespace,
          workloads,
        },
      } : {}),
    },
    detection: {
      nativeAlertRuleIds: draft.nativeAlertRuleIds,
      nativeSloIds: [],
      providerMonitorRefs,
      autoInvestigate: draft.autoInvestigate,
      cooldownMinutes: draft.cooldownMinutes,
    },
    context: { knowledgeSourceIds: [], runbookRefs: [], dependencyOverrides: [] },
    remediationPolicy: {
      mode: draft.remediationMode,
      allowedAdapterKeys: [],
      maxRiskWithoutApproval: 'none',
      requireApprovalInProduction: true,
      requireVerification: true,
      requireRollbackPlan: true,
    },
  };
}

function ProfileCard({
  profile,
  busy,
  onValidate,
  onActivate,
  onPause,
  onOpen,
}: {
  profile: AiOpsServiceProfile;
  busy: boolean;
  onValidate(): void;
  onActivate(): void;
  onPause(): void;
  onOpen(): void;
}) {
  const readinessQuery = useQuery({
    queryKey: ['aiops-service-profile-readiness', profile.id, profile.latestRevision.revision],
    queryFn: () => getAiOpsServiceProfileReadiness(profile.id),
    staleTime: 15_000,
    refetchInterval: profile.status === 'active' ? 30_000 : false,
  });
  const readiness = readinessQuery.data;
  const config = profile.latestRevision.config;
  const lanes = config.evidencePolicy.lanes.filter(lane => lane.requirement !== 'disabled');
  const canActivate = profile.allowedActions.includes('activate') && readiness && readiness.state !== 'blocked';
  return <article className={`aiops-service-profile-card is-${profile.status}`}>
    <header>
      <span className="aiops-service-profile-icon"><Layers3 size={17} /></span>
      <div><small>{config.service.environment} · {config.ownership.criticality}</small><h3>{config.service.displayName}</h3><p>{config.service.serviceName}</p></div>
      <em>{profile.status}</em>
    </header>
    <div className="aiops-service-profile-lanes">{lanes.map(lane => <span className={`is-${lane.requirement}`} key={lane.lane}>{LANE_LABELS[lane.lane]}<small>{lane.requirement}</small></span>)}</div>
    <dl>
      <div><dt>Window</dt><dd>{config.evidencePolicy.correlationWindowMinutes} min</dd></div>
      <div><dt>Detection</dt><dd>{config.detection.autoInvestigate ? `Automatic · ${config.detection.nativeAlertRuleIds.length + config.detection.providerMonitorRefs.length} source${config.detection.nativeAlertRuleIds.length + config.detection.providerMonitorRefs.length === 1 ? '' : 's'}` : 'Manual'}</dd></div>
      <div><dt>Safety</dt><dd>{config.remediationPolicy.mode}</dd></div>
      <div><dt>Revision</dt><dd>#{profile.latestRevision.revision}</dd></div>
    </dl>
    {readinessQuery.isLoading && <div className="aiops-profile-readiness is-loading" role="status"><Gauge size={14} /><span><b>Checking</b><small>Resolving current evidence health…</small></span></div>}
    {readinessQuery.error && <div className="aiops-profile-readiness is-blocked" role="alert"><AlertTriangle size={14} /><span><b>Readiness unavailable</b><small>{readinessQuery.error.message}</small></span></div>}
    {readiness && <>
      <div className={`aiops-profile-readiness is-${readiness.state}`} role="status">
        {readiness.state === 'blocked' ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
        <span><b>{readiness.state}</b><small>{readiness.summary.readyRequiredLanes}/{readiness.summary.requiredLanes} required lanes ready{readiness.summary.optionalGaps ? ` · ${readiness.summary.optionalGaps} optional gaps` : ''}</small></span>
      </div>
      {readiness.issues.length > 0 && <div className={`aiops-profile-readiness-details is-${readiness.state}`}>
        <ul>{readiness.issues.slice(0, 4).map((issue, index) => <li key={`${issue.code}-${issue.lane ?? issue.backendId ?? index}`}><span>{issue.message}</span>{issue.lane && <small>{LANE_LABELS[issue.lane]}</small>}</li>)}</ul>
        {readiness.issues.length > 4 && <small>+{readiness.issues.length - 4} more readiness issue{readiness.issues.length - 4 === 1 ? '' : 's'}</small>}
        {readiness.recoveryActions.length > 0 && <nav aria-label={`Recovery actions for ${config.service.displayName}`}>{readiness.recoveryActions.slice(0, 3).map(action => <a href={action.href} key={action.id}>{action.label}<ArrowUpRight size={11} /></a>)}</nav>}
      </div>}
    </>}
    <footer>
      <button className="button button-secondary" type="button" onClick={onOpen}><Search size={14} />View profile</button>
      {profile.allowedActions.includes('validate') && <button className="button button-secondary" type="button" disabled={busy} onClick={onValidate}><Gauge size={14} />Validate</button>}
      {profile.status !== 'active' && profile.allowedActions.includes('activate') && <button className="button button-primary" type="button" disabled={busy || !canActivate} title={readiness ? readiness.state === 'blocked' ? 'Resolve blocking evidence issues first' : 'Activate this validated revision' : 'Validate this revision first'} onClick={onActivate}><Play size={14} />Activate</button>}
      {profile.status === 'active' && profile.allowedActions.includes('pause') && <button className="button button-secondary" type="button" disabled={busy} onClick={onPause}><Pause size={14} />Pause</button>}
    </footer>
  </article>;
}

export function AiOpsServiceProfilesPanel({ readiness, bundles, tools, targets = [] }: {
  readiness?: AiOpsGlobalReadiness;
  bundles: EvidenceBundle[];
  tools: EvidenceTool[];
  targets?: FabricExecutionTarget[];
}) {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ['aiops-service-profiles'], queryFn: getAiOpsServiceProfiles, staleTime: 10_000 });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState<AiOpsServiceProfile | null>(null);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(readiness, bundles, tools));
  const [queryResult, setQueryResult] = useState<AiOpsEvidenceQueryPreflightResult | null>(null);
  const nativeAlerts = useQuery({
    queryKey: ['native-alerts'],
    queryFn: getNativeAlerts,
    enabled: dialogOpen,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!dialogOpen && !selectedDetail) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (selectedDetail) setSelectedDetail(null);
      else setDialogOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [dialogOpen, selectedDetail]);

  const openDialog = () => {
    setDraft(initialDraft(readiness, bundles, tools));
    setQueryResult(null);
    setDialogOpen(true);
  };
  const availableLanes = LANE_ORDER.filter(lane => bundlesForLane(bundles, lane).length > 0 || (lane === 'runtime' && targets.length > 0));
  const enabledLanes = availableLanes.filter(lane => draft.lanes[lane]);
  const logBundleId = draft.laneBundleIds.logs ?? draft.bundleId;
  const availableLogTools = logToolsForBundle(tools, logBundleId);
  const availableAlertRules: NativeAlertRule[] = (nativeAlerts.data?.rules ?? []).filter(rule => rule.enabled);
  const logQuery = queryTemplateFromDraft(draft);
  const logMappingReady = !draft.lanes.logs || Boolean(logQuery && (
    draft.logMapping.dialect === 'generic'
      ? draft.logMapping.customTemplate.trim()
      : draft.logMapping.resource.trim()
        && draft.logMapping.timestampField.trim()
        && draft.logMapping.serviceField.trim()
        && draft.logMapping.environmentField.trim()
        && draft.logMapping.messageField.trim()
  ));
  const formValid = draft.displayName.trim().length > 0
    && draft.serviceName.trim().length > 0
    && draft.environment.trim().length > 0
    && draft.bundleId > 0
    && enabledLanes.length > 0
    && enabledLanes.every(lane => Number(draft.laneBundleIds[lane] ?? 0) > 0)
    && (!draft.lanes.runtime || (Boolean(draft.runtimeTargetKey) && runtimeWorkloads(draft.runtimeWorkloadsText).length > 0))
    && (!draft.autoInvestigate || draft.nativeAlertRuleIds.length > 0 || draft.providerMonitorRefsText.split(/[\n,]/).some(value => value.trim()))
    && logMappingReady;

  const refreshProfiles = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['aiops-service-profiles'] }),
      queryClient.invalidateQueries({ queryKey: ['aiops-service-profile-readiness'] }),
      queryClient.invalidateQueries({ queryKey: ['aiops-readiness'] }),
    ]);
  };
  const create = useMutation({
    mutationFn: () => createAiOpsServiceProfile(configFromDraft(draft, targets)),
    onSuccess: async response => {
      setDialogOpen(false);
      await refreshProfiles();
      const validation = await validateAiOpsServiceProfile(response.profile.id, response.profile.latestRevision.revision);
      queryClient.setQueryData(
        ['aiops-service-profile-readiness', response.profile.id, response.profile.latestRevision.revision],
        validation.readiness,
      );
    },
  });
  const queryPreflight = useMutation({
    mutationFn: () => {
      if (!logQuery) throw new Error('Complete the log evidence mapping first.');
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - draft.correlationWindowMinutes * 60_000);
      return preflightAiOpsEvidenceQuery({
        bundleId: logBundleId,
        lane: 'logs',
        query: logQuery,
        context: {
          serviceName: draft.serviceName.trim() || 'service-preview',
          environment: draft.environment.trim() || 'production',
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          ...(draft.logMapping.defaultKeyword.trim()
            ? { signal: { keyword: draft.logMapping.defaultKeyword.trim() } }
            : {}),
        },
        execute: true,
      });
    },
    onSuccess: setQueryResult,
  });
  const validate = useMutation({
    mutationFn: (profile: AiOpsServiceProfile) => validateAiOpsServiceProfile(profile.id, profile.latestRevision.revision),
    onSuccess: response => queryClient.setQueryData(
      ['aiops-service-profile-readiness', response.readiness.profileId, response.readiness.revision],
      response.readiness,
    ),
  });
  const activate = useMutation({
    mutationFn: (profile: AiOpsServiceProfile) => activateAiOpsServiceProfile(profile.id, profile.latestRevision.revision),
    onSuccess: refreshProfiles,
  });
  const pause = useMutation({
    mutationFn: (profile: AiOpsServiceProfile) => pauseAiOpsServiceProfile(profile.id, profile.latestRevision.revision),
    onSuccess: refreshProfiles,
  });
  const error = create.error ?? validate.error ?? activate.error ?? pause.error;
  const busy = create.isPending || validate.isPending || activate.isPending || pause.isPending;
  const profileItems = useMemo(() => (profiles.data?.profiles ?? []).filter(profile => profile.status !== 'archived'), [profiles.data]);
  const updateLogMapping = (update: Partial<LogMappingDraft>) => {
    setQueryResult(null);
    queryPreflight.reset();
    setDraft(current => ({ ...current, logMapping: { ...current.logMapping, ...update } }));
  };

  return <>
    <section className="panel aiops-service-profiles" aria-labelledby="aiops-service-profiles-title">
      <div className="panel-heading">
        <div><span className="eyebrow">SERVICE-SPECIFIC AIOPS</span><h2 id="aiops-service-profiles-title">Service profiles</h2><p>Give every service its own evidence contract, selectors, detection cadence and safety mode.</p></div>
        <div className="aiops-service-profile-heading-actions"><span><b>{profileItems.filter(profile => profile.status === 'active').length}</b><small>active</small></span><button className="button button-primary" type="button" disabled={!bundles.some(supportsPrimaryEvidence)} onClick={openDialog}><Plus size={15} />New service profile</button></div>
      </div>
      {profiles.isLoading ? <LoadingState label="Loading service profiles…" /> : profiles.error ? <ErrorState error={profiles.error} /> : profileItems.length === 0 ? <EmptyState title="No service profiles yet" description="Create the first bounded AIOps configuration for a service and environment." /> : <div className="aiops-service-profile-grid">
        {profileItems.map(profile => <ProfileCard
          key={profile.id}
          profile={profile}
          busy={busy}
          onValidate={() => validate.mutate(profile)}
          onActivate={() => activate.mutate(profile)}
          onPause={() => pause.mutate(profile)}
          onOpen={() => setSelectedDetail(profile)}
        />)}
      </div>}
      {error && <div className="editor-error" role="alert">{error.message}</div>}
    </section>

    {dialogOpen && <div className="solution-dialog-layer" role="presentation" onMouseDown={() => setDialogOpen(false)}>
      <section className="solution-start-dialog aiops-profile-dialog" role="dialog" aria-modal="true" aria-label="Create AIOps service profile" onMouseDown={event => event.stopPropagation()}>
        <header><div><span className="eyebrow">SERVICE PROFILE · DRAFT</span><h2>Configure service intelligence</h2><p>One immutable revision captures exactly what Argus may observe for this service.</p></div><button type="button" aria-label="Close service profile dialog" onClick={() => setDialogOpen(false)}><X size={17} /></button></header>
        <form className="solution-run-form aiops-profile-form" onSubmit={event => { event.preventDefault(); if (formValid) create.mutate(); }}>
          <div className="aiops-profile-form-grid">
            <label className="editor-field"><span>Display name <em>required</em></span><input required maxLength={160} value={draft.displayName} onChange={event => setDraft(current => ({ ...current, displayName: event.target.value }))} placeholder="Checkout API" /></label>
            <label className="editor-field"><span>OTel service name <em>required</em></span><input required maxLength={160} value={draft.serviceName} onChange={event => setDraft(current => ({ ...current, serviceName: event.target.value }))} placeholder="checkout-api" /></label>
            <label className="editor-field"><span>Environment <em>required</em></span><input required maxLength={120} value={draft.environment} onChange={event => setDraft(current => ({ ...current, environment: event.target.value }))} placeholder="production" /></label>
            <label className="editor-field"><span>Owning team</span><input maxLength={200} value={draft.team} onChange={event => setDraft(current => ({ ...current, team: event.target.value }))} placeholder="payments" /></label>
            <label className="editor-field"><span>Criticality</span><select value={draft.criticality} onChange={event => setDraft(current => ({ ...current, criticality: event.target.value as Draft['criticality'] }))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
             <label className="editor-field"><span>Default evidence bundle <em>required</em></span><select value={draft.bundleId || ''} onChange={event => {
               const bundleId = Number(event.target.value);
               const next = bundles.find(bundle => bundle.id === bundleId);
               const lanes = bundleLanes(next);
              const required = lanes.includes('metrics') ? 'metrics' : lanes.includes('logs') ? 'logs' : lanes[0];
              setQueryResult(null);
              queryPreflight.reset();
              setDraft(current => ({
                 ...current,
                 bundleId,
                 lanes: Object.fromEntries(lanes.filter(lane => lane !== 'runtime').map(lane => [lane, lane === required ? 'required' : 'optional'])),
                 laneBundleIds: Object.fromEntries(lanes.map(lane => [lane, bundleId])),
                 runtimeTargetKey: '',
                 runtimeWorkloadsText: '',
                 logMapping: initialLogMapping(tools, bundleId),
               }));
             }}><option value="">Select governed evidence</option>{bundles.filter(supportsPrimaryEvidence).map(bundle => <option key={bundle.id} value={bundle.id}>{bundle.label}</option>)}</select><small>Used as the initial choice; every lane can bind a different governed Bundle below.</small></label>
          </div>
          <label className="editor-field"><span>Description</span><textarea rows={2} maxLength={2000} value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} placeholder="What does this service do and which failures matter?" /></label>

           <fieldset className="aiops-profile-evidence"><legend>Evidence contract <em>at least one lane</em></legend><p>Required gaps block an investigation. Optional gaps reduce confidence but remain visible.</p><div>{availableLanes.map(lane => {
             const requirement = draft.lanes[lane];
             const compatibleBundles = bundlesForLane(bundles, lane).filter(bundle => lane !== 'runtime' || targets.some(target => target.bundleIds.includes(bundle.id)));
             const selectedLaneBundle = draft.laneBundleIds[lane] ?? 0;
             return <label className={requirement ? 'is-enabled' : ''} key={lane}><input type="checkbox" checked={Boolean(requirement)} onChange={event => {
               setQueryResult(null);
               queryPreflight.reset();
               setDraft(current => ({
                 ...current,
                 lanes: { ...current.lanes, [lane]: event.target.checked ? 'optional' : undefined },
                 laneBundleIds: {
                   ...current.laneBundleIds,
                   [lane]: event.target.checked
                     ? current.laneBundleIds[lane] ?? compatibleBundles[0]?.id
                     : undefined,
                 },
               }));
             }} /><span className="connection-check">{requirement && <Check size={11} />}</span><b>{lane === 'runtime' ? 'Runtime / Kubernetes' : LANE_LABELS[lane]}</b><select aria-label={`${LANE_LABELS[lane]} requirement`} disabled={!requirement} value={requirement ?? 'optional'} onChange={event => setDraft(current => ({ ...current, lanes: { ...current.lanes, [lane]: event.target.value as AiOpsEvidenceRequirement } }))}><option value="optional">Optional</option><option value="required">Required</option></select>{requirement && <select aria-label={`${LANE_LABELS[lane]} evidence bundle`} value={selectedLaneBundle || ''} onChange={event => {
               const bundleId = Number(event.target.value);
               setQueryResult(null);
               queryPreflight.reset();
               setDraft(current => ({
                 ...current,
                 laneBundleIds: { ...current.laneBundleIds, [lane]: bundleId },
                 ...(lane === 'logs' ? { logMapping: initialLogMapping(tools, bundleId) } : {}),
               }));
             }}><option value="">Select Bundle</option>{compatibleBundles.map(bundle => <option value={bundle.id} key={bundle.id}>{bundle.label}</option>)}</select>}</label>;
           })}</div>{availableLanes.length === 0 && <small className="aiops-profile-no-lanes"><AlertTriangle size={13} />The selected bundle does not expose a recognized AIOps evidence lane.</small>}</fieldset>

          {draft.lanes.runtime && <fieldset className="aiops-profile-query-mapping">
            <legend><Layers3 size={15} />Runtime boundary <em>explicit target</em></legend>
            <p>Bind this service to one certified Kubernetes environment and an exact workload allowlist. Other clusters and workloads never enter its grant.</p>
            <div className="aiops-profile-form-grid">
              <label className="editor-field"><span>Execution target <em>required</em></span><select aria-label="Runtime execution target" required value={draft.runtimeTargetKey} onChange={event => {
                const runtimeTargetKey = event.target.value;
                const target = targets.find(item => executionTargetKey(item) === runtimeTargetKey);
                const compatibleBundle = target?.bundleIds.find(bundleId => bundlesForLane(bundles, 'runtime').some(bundle => bundle.id === bundleId));
                setDraft(current => ({
                  ...current,
                  runtimeTargetKey,
                  laneBundleIds: { ...current.laneBundleIds, ...(compatibleBundle ? { runtime: compatibleBundle } : {}) },
                }));
              }}><option value="">Select certified target</option>{targets.map(target => <option value={executionTargetKey(target)} key={executionTargetKey(target)}>{target.label} · {target.namespace} · {target.environment}</option>)}</select></label>
              <label className="editor-field"><span>Allowed workloads <em>required</em></span><textarea aria-label="Runtime allowed workloads" required rows={3} maxLength={4096} value={draft.runtimeWorkloadsText} onChange={event => setDraft(current => ({ ...current, runtimeWorkloadsText: event.target.value }))} placeholder={'Deployment/checkout-api\nJob/checkout-migrations'} /><small>One <code>Kind/name</code> per line. Deployment, StatefulSet and Job are supported.</small></label>
            </div>
          </fieldset>}

          {draft.lanes.logs && <fieldset className="aiops-profile-query-mapping">
            <legend><Database size={15} />Log evidence mapping <em>service bounded</em></legend>
            <p>Choose the read-only tool, source and field mapping Argus must use for this service. Incident values are inserted server-side.</p>
            <div className="aiops-profile-form-grid">
              <label className="editor-field"><span>Query tool <em>required</em></span><select aria-label="Log query tool" value={draft.logMapping.toolName} onChange={event => {
                const next = logMappingForTool(event.target.value);
                setQueryResult(null);
                queryPreflight.reset();
                setDraft(current => ({ ...current, logMapping: next }));
              }}><option value="">Select a read-only log query</option>{availableLogTools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}</select><small>Only enabled, non-write tools from the selected Bundle are offered.</small></label>
              <label className="editor-field"><span>Query dialect</span><select aria-label="Log query dialect" value={draft.logMapping.dialect} onChange={event => {
                const dialect = event.target.value as LogDialect;
                updateLogMapping({
                  dialect,
                  timestampField: dialect === 'loki' ? 'timestamp' : '@timestamp',
                  serviceField: dialect === 'loki' ? 'service' : 'service.name',
                  environmentField: dialect === 'loki' ? 'environment' : 'service.environment',
                  resource: dialect === 'loki' ? 'application logs' : draft.logMapping.resource || 'logs-*',
                });
              }}><option value="elasticsearch">Elasticsearch</option><option value="opensearch">OpenSearch</option><option value="loki">Loki / LogQL</option><option value="generic">Custom JSON arguments</option></select></label>
              <label className="editor-field"><span>{draft.logMapping.dialect === 'loki' ? 'Stream label' : 'Index / data view'}{draft.logMapping.dialect !== 'generic' && <em> required</em>}</span><input aria-label="Log source or index" maxLength={500} value={draft.logMapping.resource} onChange={event => updateLogMapping({ resource: event.target.value })} placeholder={draft.logMapping.dialect === 'loki' ? 'application logs' : 'logs-checkout-*'} /></label>
              <label className="editor-field"><span>Default signal keyword</span><input aria-label="Default signal keyword" maxLength={500} value={draft.logMapping.defaultKeyword} onChange={event => updateLogMapping({ defaultKeyword: event.target.value })} placeholder="payment_failed" /><small>An alert may override this value for one run.</small></label>
            </div>
            {draft.logMapping.dialect === 'generic' ? <label className="editor-field aiops-profile-query-template"><span>Tool arguments template <em>JSON object</em></span><textarea aria-label="Log query arguments template" rows={6} maxLength={4000} value={draft.logMapping.customTemplate} onChange={event => updateLogMapping({ customTemplate: event.target.value })} /><small>Supported placeholders: service.name, environment, window.start/end, signal.keyword/fingerprint and trace.id.</small></label> : <details className="aiops-profile-field-mapping" open>
              <summary>Field mapping</summary>
              <div className="aiops-profile-form-grid">
                <label className="editor-field"><span>Timestamp field</span><input aria-label="Log timestamp field" maxLength={240} value={draft.logMapping.timestampField} onChange={event => updateLogMapping({ timestampField: event.target.value })} /></label>
                <label className="editor-field"><span>Service field / label</span><input aria-label="Log service field" maxLength={240} value={draft.logMapping.serviceField} onChange={event => updateLogMapping({ serviceField: event.target.value })} /></label>
                <label className="editor-field"><span>Environment field / label</span><input aria-label="Log environment field" maxLength={240} value={draft.logMapping.environmentField} onChange={event => updateLogMapping({ environmentField: event.target.value })} /></label>
                <label className="editor-field"><span>Message field</span><input aria-label="Log message field" maxLength={240} value={draft.logMapping.messageField} onChange={event => updateLogMapping({ messageField: event.target.value })} /></label>
                <label className="editor-field"><span>Severity field</span><input aria-label="Log severity field" maxLength={240} value={draft.logMapping.severityField} onChange={event => updateLogMapping({ severityField: event.target.value })} /></label>
                <label className="editor-field"><span>Trace ID field</span><input aria-label="Log trace ID field" maxLength={240} value={draft.logMapping.traceIdField} onChange={event => updateLogMapping({ traceIdField: event.target.value })} /></label>
              </div>
            </details>}
            <div className="aiops-profile-query-actions">
              <span><Search size={14} />The server checks Bundle access, tool policy and read-only status before executing.</span>
              <button className="button button-secondary" type="button" disabled={!logQuery || !logMappingReady || queryPreflight.isPending} onClick={() => queryPreflight.mutate()}><TestTube2 size={14} />{queryPreflight.isPending ? 'Testing query…' : 'Test query'}</button>
            </div>
            {queryPreflight.error && <div className="editor-error" role="alert">{queryPreflight.error.message}</div>}
            {queryResult && <div className={`aiops-profile-query-result is-${queryResult.state}`} role="status">
              <header><span>{queryResult.state === 'succeeded' ? <Check size={14} /> : <AlertTriangle size={14} />}<b>{queryResult.state === 'succeeded' ? 'Query succeeded' : queryResult.state === 'preview' ? 'Query preview ready' : 'Query failed'}</b></span>{queryResult.response && <small>{queryResult.response.matchedDocuments == null ? 'Match count unavailable' : `${queryResult.response.matchedDocuments} matching documents`} · {queryResult.response.durationMs} ms</small>}</header>
              <details><summary>Rendered, redacted request</summary><pre>{JSON.stringify(queryResult.request.arguments, null, 2)}</pre></details>
              {queryResult.response?.preview && <details><summary>Redacted result sample</summary><pre>{queryResult.response.preview}</pre></details>}
            </div>}
          </fieldset>}

          <div className="aiops-profile-form-grid">
            <label className="editor-field"><span>Correlation window</span><input type="number" min={5} max={360} value={draft.correlationWindowMinutes} onChange={event => setDraft(current => ({ ...current, correlationWindowMinutes: Number(event.target.value) }))} /><small>Minutes of evidence around an incident.</small></label>
            <label className="editor-field"><span>Cooldown</span><input type="number" min={1} max={10080} value={draft.cooldownMinutes} onChange={event => setDraft(current => ({ ...current, cooldownMinutes: Number(event.target.value) }))} /><small>Prevents duplicate investigations.</small></label>
            <label className="editor-field"><span>Safety mode</span><select value={draft.remediationMode} onChange={event => setDraft(current => ({ ...current, remediationMode: event.target.value as Draft['remediationMode'] }))}><option value="diagnose-only">Diagnose only</option><option value="propose">Propose remediation</option></select><small>Execution remains governed and approval-bound.</small></label>
            <label className="aiops-profile-toggle"><input type="checkbox" checked={draft.autoInvestigate} onChange={event => setDraft(current => ({ ...current, autoInvestigate: event.target.checked, ...(!event.target.checked ? { nativeAlertRuleIds: [], providerMonitorRefsText: '' } : {}) }))} /><span><Activity size={15} /><b>Auto-investigate alerts</b><small>Deterministic detection starts agents only after a matching signal.</small></span></label>
          </div>
          {draft.autoInvestigate && <fieldset className="aiops-profile-alert-rules">
            <legend>Detection sources <em>at least one source</em></legend>
            <p>Use Native Rules, external provider monitor references, or both. Every signal is matched to this exact service, environment and active revision.</p>
            <label className="editor-field aiops-profile-monitor-refs"><span>Provider monitor references</span><textarea aria-label="Provider monitor references" rows={3} maxLength={4096} value={draft.providerMonitorRefsText} onChange={event => setDraft(current => ({ ...current, providerMonitorRefsText: event.target.value }))} placeholder={'CheckoutLatencyHigh\nprometheus-alertmanager:CheckoutErrorRate'} /><small>One exact reference per line or comma. Prefix with the provider to avoid naming collisions.</small></label>
            <h4>Native alert rules</h4>
            {nativeAlerts.isLoading ? <LoadingState label="Loading native alert rules…" /> : nativeAlerts.error ? <ErrorState error={nativeAlerts.error} /> : availableAlertRules.length === 0 ? <EmptyState title="No enabled alert rules" description="Create or enable a native alert rule before enabling automatic investigations." /> : <div>
              {availableAlertRules.map(rule => <label className={draft.nativeAlertRuleIds.includes(rule.id) ? 'is-selected' : ''} key={rule.id}>
                <input type="checkbox" checked={draft.nativeAlertRuleIds.includes(rule.id)} onChange={event => setDraft(current => ({
                  ...current,
                  nativeAlertRuleIds: event.target.checked
                    ? [...current.nativeAlertRuleIds, rule.id].sort((left, right) => left - right)
                    : current.nativeAlertRuleIds.filter(id => id !== rule.id),
                }))} />
                <span className="connection-check">{draft.nativeAlertRuleIds.includes(rule.id) && <Check size={11} />}</span>
                <span><b>{rule.name}</b><small>{rule.metric.replaceAll('_', ' ')} {rule.operator} {rule.threshold} · {rule.severity}</small></span>
              </label>)}
            </div>}
          </fieldset>}
          {create.error && <div className="editor-error" role="alert">{create.error.message}</div>}
          <footer><span className="aiops-profile-contract-note"><Bot size={14} />No new model per service — the same governed AIOps agents receive this bounded context.</span><button className="button button-secondary" type="button" onClick={() => setDialogOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={!formValid || create.isPending}><ShieldCheck size={15} />{create.isPending ? 'Creating…' : 'Create and validate draft'}</button></footer>
        </form>
      </section>
    </div>}

    {selectedDetail && <div className="solution-dialog-layer" role="presentation" onMouseDown={() => setSelectedDetail(null)}>
      <section className="solution-start-dialog aiops-profile-dialog aiops-profile-detail" role="dialog" aria-modal="true" aria-label={`AIOps service profile ${selectedDetail.latestRevision.config.service.displayName}`} onMouseDown={event => event.stopPropagation()}>
        <header><div><span className="eyebrow">IMMUTABLE SERVICE PROFILE · REVISION {selectedDetail.latestRevision.revision}</span><h2>{selectedDetail.latestRevision.config.service.displayName}</h2><p>{selectedDetail.latestRevision.config.service.serviceName} · {selectedDetail.latestRevision.config.service.environment}</p></div><button type="button" aria-label="Close service profile detail" onClick={() => setSelectedDetail(null)}><X size={17} /></button></header>
        <div className="aiops-profile-detail-body">
          <section><span className="eyebrow">IDENTITY & OWNERSHIP</span><dl><div><dt>Team</dt><dd>{selectedDetail.latestRevision.config.ownership.team || 'Unassigned'}</dd></div><div><dt>Criticality</dt><dd>{selectedDetail.latestRevision.config.ownership.criticality}</dd></div><div><dt>Status</dt><dd>{selectedDetail.status}</dd></div><div><dt>SHA-256</dt><dd><code title={selectedDetail.latestRevision.sha256}>{selectedDetail.latestRevision.sha256.slice(0, 16)}…</code></dd></div></dl></section>
          <section><span className="eyebrow">EVIDENCE LANES</span><div className="aiops-profile-detail-lanes">{selectedDetail.latestRevision.config.evidencePolicy.lanes.filter(lane => lane.requirement !== 'disabled').map(lane => <article key={lane.lane}><span><b>{LANE_LABELS[lane.lane]}</b><em>{lane.requirement}</em></span><small>{bundles.find(bundle => bundle.id === lane.bundleId)?.label ?? `Bundle #${lane.bundleId}`}</small><code>{lane.toolAllowlist?.length ? `${lane.toolAllowlist.length} allowed tools` : 'Bundle policy tools'} · {lane.queryTemplates.length} queries</code></article>)}</div></section>
          <section><span className="eyebrow">SELECTORS & RUNTIME</span><dl><div><dt>OTel services</dt><dd>{selectedDetail.latestRevision.config.selectors.otelServiceNames.join(', ')}</dd></div><div><dt>Correlation window</dt><dd>{selectedDetail.latestRevision.config.evidencePolicy.correlationWindowMinutes} min</dd></div><div><dt>Runtime</dt><dd>{selectedDetail.latestRevision.config.selectors.runtime ? `${selectedDetail.latestRevision.config.selectors.runtime.cluster} · ${selectedDetail.latestRevision.config.selectors.runtime.namespace}` : 'Not required'}</dd></div><div><dt>Workloads</dt><dd>{selectedDetail.latestRevision.config.selectors.runtime?.workloads.map(workload => `${workload.kind}/${workload.name}`).join(', ') || 'None'}</dd></div></dl></section>
          <section><span className="eyebrow">DETECTION & SAFETY</span><dl><div><dt>Trigger</dt><dd>{selectedDetail.latestRevision.config.detection.autoInvestigate ? 'Automatic' : 'Manual'}</dd></div><div><dt>Cooldown</dt><dd>{selectedDetail.latestRevision.config.detection.cooldownMinutes} min</dd></div><div><dt>Provider monitors</dt><dd>{selectedDetail.latestRevision.config.detection.providerMonitorRefs.length}</dd></div><div><dt>Remediation</dt><dd>{selectedDetail.latestRevision.config.remediationPolicy.mode}</dd></div></dl></section>
        </div>
        <footer><span className="aiops-profile-contract-note"><ShieldCheck size={14} />Historical runs retain this revision and hash.</span><button className="button button-secondary" type="button" onClick={() => setSelectedDetail(null)}>Close</button></footer>
      </section>
    </div>}
  </>;
}
