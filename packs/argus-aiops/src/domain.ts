import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PackExecutionResourceScope } from './executionGrant.js';

const optionalUrl = z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().max(2_000).optional(),
);

const optionalTimestamp = z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().datetime({ offset: true }).optional(),
);

export const IncidentInputSchema = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().min(3).max(10_000),
  severity: z.enum(['critical', 'warning', 'info']).default('warning'),
  service: z.string().trim().min(1).max(200),
  environment: z.string().trim().min(1).max(120).default('production'),
  started_at: optionalTimestamp,
  alert_source: z.string().trim().max(120).optional(),
  alert_url: optionalUrl,
  correlation_window_minutes: z.coerce.number().int().min(5).max(360).default(30),
  labels: z.record(z.string().max(500)).optional(),
  signal_keyword: z.string().trim().max(500).optional(),
  signal_fingerprint: z.string().trim().max(500).optional(),
}).strict();

export type IncidentInput = z.infer<typeof IncidentInputSchema>;

const evidenceLaneSchema = z.enum(['metrics', 'logs', 'traces', 'runtime', 'topology', 'changes', 'knowledge', 'incident']);
const queryTemplateSchema = z.object({
  id: z.string().trim().min(1).max(120),
  toolName: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional(),
  source: z.object({
    kind: z.enum(['elasticsearch', 'opensearch', 'loki', 'generic']),
    resource: z.string().trim().max(500).optional(),
    fields: z.object({
      timestamp: z.string().trim().min(1).max(240),
      service: z.string().trim().min(1).max(240),
      environment: z.string().trim().max(240).optional(),
      message: z.string().trim().min(1).max(240),
      severity: z.string().trim().max(240).optional(),
      traceId: z.string().trim().max(240).optional(),
    }).strict().optional(),
  }).strict().optional(),
  defaults: z.object({
    signalKeyword: z.string().trim().max(500).optional(),
    signalFingerprint: z.string().trim().max(500).optional(),
  }).strict().optional(),
  template: z.string().trim().min(1).max(4_000),
}).strict();

export const ResolvedServiceContextSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('aiops-resolved-service-context'),
  profile: z.object({
    id: z.number().int().positive(),
    revision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  service: z.object({
    displayName: z.string().trim().min(1).max(160),
    serviceName: z.string().trim().min(1).max(160),
    environment: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000).optional(),
  }).strict(),
  ownership: z.object({
    team: z.string().trim().max(200).optional(),
    escalationPolicyRef: z.string().trim().max(200).optional(),
    businessService: z.string().trim().max(200).optional(),
    criticality: z.enum(['low', 'medium', 'high', 'critical']),
  }).strict(),
  evidence: z.object({
    minimumCollectedLanes: z.number().int().min(1).max(8),
    correlationWindowMinutes: z.number().int().min(5).max(360),
    maxProviderResultBytes: z.number().int().min(4_096).max(524_288),
    lanes: z.array(z.object({
      lane: evidenceLaneSchema,
      requirement: z.enum(['required', 'optional']),
      bundleId: z.number().int().positive(),
      toolNames: z.array(z.string().trim().min(1).max(200)).max(32),
      queryTemplates: z.array(queryTemplateSchema).max(16),
    }).strict()).min(1).max(8),
  }).strict(),
  selectors: z.object({
    otelServiceNames: z.array(z.string().trim().min(1).max(240)).max(64),
    metricLabels: z.record(z.string().max(240)),
    logLabels: z.record(z.string().max(240)),
    traceOperations: z.array(z.string().trim().min(1).max(240)).max(64),
    runtime: z.object({
      kind: z.literal('kubernetes'), backendId: z.number().int().positive(),
      targetId: z.string().trim().min(1).max(128), cluster: z.string().trim().min(1).max(200),
      namespace: z.string().trim().min(1).max(63),
      workloads: z.array(z.object({ kind: z.enum(['Deployment', 'StatefulSet', 'Job']), name: z.string().trim().min(1).max(200) }).strict()).min(1).max(64),
    }).strict().optional(),
    repositories: z.array(z.object({ provider: z.string().trim().min(1).max(80), owner: z.string().trim().min(1).max(200), repository: z.string().trim().min(1).max(200) }).strict()).max(32).optional(),
  }).strict(),
  context: z.object({
    knowledgeSourceIds: z.array(z.number().int().positive()).max(64),
    runbookRefs: z.array(z.string().trim().min(1).max(500)).max(64),
    dependencyOverrides: z.array(z.object({
      targetKind: z.enum(['service', 'database', 'messaging', 'external']),
      targetName: z.string().trim().min(1).max(200), relation: z.enum(['calls', 'queries', 'publishes']),
      direction: z.enum(['upstream', 'downstream']), reason: z.string().trim().max(500).optional(),
    }).strict()).max(128),
  }).strict(),
  remediationPolicy: z.object({
    mode: z.enum(['diagnose-only', 'propose', 'governed-execute']),
    allowedAdapterKeys: z.array(z.string().trim().min(1).max(200)).max(16),
    maxRiskWithoutApproval: z.enum(['none', 'low']),
    requireApprovalInProduction: z.literal(true), requireVerification: z.literal(true), requireRollbackPlan: z.literal(true),
  }).strict(),
  resolvedAt: z.string().datetime({ offset: true }),
}).strict();

export type ResolvedServiceContext = z.infer<typeof ResolvedServiceContextSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

export function hashResolvedServiceContext(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(ResolvedServiceContextSchema.parse(value)))).digest('hex');
}

export interface InvestigationPlan {
  kind: 'aiops-investigation-plan';
  schemaVersion: 1;
  implementationStage: 'contract-seed';
  generatedAt: string;
  incident: IncidentInput & { started_at: string };
  scope: {
    windowStart: string;
    windowEnd: string;
    service: string;
    environment: string;
    selectedBundleIds: number[];
    resourceScope?: PackExecutionResourceScope;
  };
  evidenceLanes: Array<{
    id: z.infer<typeof evidenceLaneSchema>;
    requirement: 'required' | 'optional';
    bundleId?: number;
    allowedToolNames: string[];
    queryTemplates: z.infer<typeof queryTemplateSchema>[];
    purpose: string;
    questions: string[];
    requiredCapabilities: string[];
  }>;
  hypotheses: Array<{
    id: string;
    statement: string;
    status: 'untested';
    confidence: null;
    differentiatingTests: string[];
  }>;
  safety: {
    mode: 'read-only';
    writesAllowed: false;
    rawTelemetryPersisted: false;
  };
  serviceContext?: ResolvedServiceContext;
}

export function buildInvestigationPlan(
  raw: unknown,
  options: { now?: Date; selectedBundleIds?: number[]; resourceScope?: PackExecutionResourceScope; serviceContext?: ResolvedServiceContext },
): InvestigationPlan {
  const parsed = IncidentInputSchema.parse(raw);
  const now = options.now ?? new Date();
  const startedAt = parsed.started_at ? new Date(parsed.started_at) : now;
  const windowMs = parsed.correlation_window_minutes * 60_000;
  const incident = { ...parsed, started_at: startedAt.toISOString() };
  const selectedBundleIds = [...new Set((options.selectedBundleIds ?? []).filter(id => Number.isInteger(id) && id > 0))];
  const context = options.serviceContext;
  if (context && (parsed.service !== context.service.serviceName
    || parsed.environment !== context.service.environment
    || parsed.correlation_window_minutes !== context.evidence.correlationWindowMinutes)) {
    throw new Error('workflow input does not match the signed service profile context');
  }
  const laneCopy = (id: z.infer<typeof evidenceLaneSchema>, purpose: string, questions: string[], requiredCapabilities: string[]) => {
    const configured = context?.evidence.lanes.find(lane => lane.lane === id);
    return {
      id,
      requirement: configured?.requirement ?? 'required' as const,
      ...(configured ? { bundleId: configured.bundleId } : {}),
      allowedToolNames: configured?.toolNames ?? [],
      queryTemplates: configured?.queryTemplates ?? [],
      purpose,
      questions,
      requiredCapabilities,
    };
  };
  const catalog = [
    laneCopy('topology', 'Resolve upstream, downstream and shared dependencies before ranking causes.', ['Which dependencies are on the failing request path?', 'Which related services changed health in the same window?'], ['topology.read']),
    laneCopy('metrics', 'Compare rate, errors, duration and saturation against a preceding baseline.', ['Which golden signal deviated first?', 'Is the deviation isolated to one instance or shared by peers?'], ['metrics.query']),
    laneCopy('logs', 'Find new or sharply increasing error patterns without copying the raw log corpus.', ['Which normalized patterns appeared or increased?', 'Do examples identify a dependency, resource or version?'], ['logs.query']),
    laneCopy('traces', 'Locate the critical path and failing or slow dependency edges.', ['Which span first becomes slow or erroneous?', 'Does the failure propagate from a downstream service?'], ['traces.query']),
    laneCopy('runtime', 'Inspect the bounded runtime target and workload health.', ['Which configured workload is unhealthy?', 'Do runtime events explain the symptom onset?'], ['runtime.read']),
    laneCopy('changes', 'Correlate deploys, configuration and repository changes with symptom onset.', ['What changed immediately before the incident?', 'Does the affected scope match the changed component?'], ['changes.read']),
    laneCopy('knowledge', 'Retrieve relevant runbooks and comparable historical incidents.', ['Has this symptom occurred before?', 'Which verified mitigation was previously effective?'], ['knowledge.search']),
    laneCopy('incident', 'Correlate the signal with active incidents and alert history.', ['Are related alerts firing?', 'Is this part of an existing incident?'], ['incident.read']),
  ];

  return {
    kind: 'aiops-investigation-plan',
    schemaVersion: 1,
    implementationStage: 'contract-seed',
    generatedAt: now.toISOString(),
    incident,
    scope: {
      windowStart: new Date(startedAt.getTime() - windowMs).toISOString(),
      windowEnd: new Date(startedAt.getTime() + windowMs).toISOString(),
      service: parsed.service,
      environment: parsed.environment,
      selectedBundleIds,
      ...(options.resourceScope ? { resourceScope: { ...options.resourceScope } } : {}),
    },
    evidenceLanes: context ? catalog.filter(lane => context.evidence.lanes.some(item => item.lane === lane.id)) : catalog.filter(lane => ['topology', 'metrics', 'logs', 'traces', 'changes', 'knowledge'].includes(lane.id)),
    hypotheses: [
      {
        id: 'recent-change-regression',
        statement: 'A recent deployment, configuration or feature-flag change caused the observed degradation.',
        status: 'untested',
        confidence: null,
        differentiatingTests: ['Compare symptom onset with changes.', 'Compare changed and unchanged instances or versions.'],
      },
      {
        id: 'dependency-degradation',
        statement: 'A downstream dependency degraded and propagated errors or latency into the affected service.',
        status: 'untested',
        confidence: null,
        differentiatingTests: ['Inspect service graph edges.', 'Compare downstream RED signals and trace spans.'],
      },
      {
        id: 'resource-saturation',
        statement: 'Compute, memory, connection, queue or storage saturation constrained the service.',
        status: 'untested',
        confidence: null,
        differentiatingTests: ['Inspect saturation metrics and throttling events.', 'Compare affected instances with healthy peers.'],
      },
    ],
    safety: {
      mode: 'read-only',
      writesAllowed: false,
      rawTelemetryPersisted: false,
    },
    ...(context ? { serviceContext: context } : {}),
  };
}

