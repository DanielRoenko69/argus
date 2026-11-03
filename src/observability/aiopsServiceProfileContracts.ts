import { createHash } from 'node:crypto';
import { z } from 'zod';

export const AIOPS_SERVICE_PROFILE_SCHEMA_VERSION = 1 as const;

export const AIOPS_EVIDENCE_LANES = [
  'metrics',
  'logs',
  'traces',
  'runtime',
  'topology',
  'changes',
  'knowledge',
  'incident',
] as const;

export const AIOPS_SERVICE_PROFILE_LIMITS = {
  serviceNameChars: 160,
  environmentChars: 120,
  displayNameChars: 160,
  descriptionChars: 2_000,
  ownerFieldChars: 200,
  selectorValues: 64,
  selectorValueChars: 240,
  selectorLabels: 32,
  selectorLabelKeyChars: 120,
  selectorLabelValueChars: 240,
  evidenceLanes: AIOPS_EVIDENCE_LANES.length,
  toolsPerLane: 32,
  queryTemplatesPerLane: 16,
  queryTemplateChars: 4_000,
  queryResourceChars: 500,
  queryFieldChars: 240,
  querySignalChars: 500,
  correlationWindowMinutesMin: 5,
  correlationWindowMinutesMax: 360,
  providerResultBytesMin: 4_096,
  providerResultBytesMax: 524_288,
  alertRules: 64,
  slos: 64,
  providerMonitorRefs: 64,
  knowledgeSources: 64,
  runbookRefs: 64,
  dependencyOverrides: 128,
  remediationAdapters: 16,
  cooldownMinutesMin: 1,
  cooldownMinutesMax: 10_080,
  issues: 64,
  recoveryActions: 32,
  tags: 32,
} as const;

export const AIOPS_CAPABILITY_REQUIREMENT_VERSION = 1 as const;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const positiveId = z.number().int().positive();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoTimestamp = z.string().datetime({ offset: true });
const evidenceLaneSchema = z.enum(AIOPS_EVIDENCE_LANES);
const bundleCapabilitySchema = z.enum([
  'metrics', 'logs', 'traces', 'runtime', 'topology', 'incident', 'repository', 'rag',
]);

const uniqueValues = <T>(values: T[]): boolean => new Set(values).size === values.length;

const boundedUniqueTextArray = (maximumItems: number, maximumChars: number) => z.array(
  boundedText(maximumChars),
).max(maximumItems).refine(uniqueValues, 'values must be unique');

const boundedLabelRecord = z.record(
  boundedText(AIOPS_SERVICE_PROFILE_LIMITS.selectorLabelValueChars),
).superRefine((value, context) => {
  const keys = Object.keys(value);
  if (keys.length > AIOPS_SERVICE_PROFILE_LIMITS.selectorLabels) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'too many selector labels' });
  }
  for (const key of keys) {
    if (key.trim().length < 1 || key.length > AIOPS_SERVICE_PROFILE_LIMITS.selectorLabelKeyChars) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `invalid selector label key '${key}'` });
    }
  }
});

export const AIOPS_QUERY_PLACEHOLDERS = [
  'service.name',
  'environment',
  'window.start',
  'window.end',
  'window.start_micros',
  'window.end_micros',
  'runtime.cluster',
  'runtime.namespace',
  'signal.keyword',
  'signal.fingerprint',
  'trace.id',
] as const;

const allowedQueryPlaceholders = new Set<string>(AIOPS_QUERY_PLACEHOLDERS);

function queryTemplateHasOnlyAllowedPlaceholders(template: string): boolean {
  const placeholders = template.matchAll(/\$\{([^}]+)\}/g);
  return [...placeholders].every(match => allowedQueryPlaceholders.has(match[1] ?? ''));
}

function queryTemplateRendersJsonObject(template: string): boolean {
  try {
    const parsed = JSON.parse(template.replaceAll(/\$\{[^}]+\}/g, 'preview')) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export const aiOpsBoundedQueryTemplateSchema = z.object({
  id: boundedText(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  toolName: boundedText(200),
  description: z.string().trim().max(500).optional(),
  source: z.object({
    kind: z.enum(['elasticsearch', 'opensearch', 'loki', 'generic']),
    resource: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.queryResourceChars).optional(),
    fields: z.object({
      timestamp: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.queryFieldChars),
      service: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.queryFieldChars),
      environment: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.queryFieldChars).optional(),
      message: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.queryFieldChars),
      severity: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.queryFieldChars).optional(),
      traceId: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.queryFieldChars).optional(),
    }).strict().optional(),
  }).strict().optional(),
  defaults: z.object({
    signalKeyword: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.querySignalChars).optional(),
    signalFingerprint: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.querySignalChars).optional(),
  }).strict().optional(),
  template: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.queryTemplateChars)
    .refine(queryTemplateHasOnlyAllowedPlaceholders, 'query template contains an unsupported placeholder'),
}).strict().superRefine((value, context) => {
  // v1 profiles already support provider-native PromQL and LogQL expressions.
  // A structured source marks the newer executable argument-template contract.
  if (value.source && !queryTemplateRendersJsonObject(value.template)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['template'],
      message: 'structured query template must render to a JSON argument object',
    });
  }
});

export const aiOpsEvidenceLaneBindingSchema = z.object({
  lane: evidenceLaneSchema,
  requirement: z.enum(['required', 'optional', 'disabled']),
  bundleId: positiveId,
  toolAllowlist: boundedUniqueTextArray(
    AIOPS_SERVICE_PROFILE_LIMITS.toolsPerLane,
    200,
  ).optional(),
  queryTemplates: z.array(aiOpsBoundedQueryTemplateSchema)
    .max(AIOPS_SERVICE_PROFILE_LIMITS.queryTemplatesPerLane),
}).strict().superRefine((value, context) => {
  if (value.requirement === 'disabled' && (value.toolAllowlist?.length || value.queryTemplates.length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'disabled evidence lanes cannot expose tools or query templates',
    });
  }
  if (!uniqueValues(value.queryTemplates.map(template => template.id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'query template ids must be unique within a lane' });
  }
  if (value.toolAllowlist) {
    const unlistedTemplate = value.queryTemplates.find(template => !value.toolAllowlist!.includes(template.toolName));
    if (unlistedTemplate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['queryTemplates'],
        message: `query template '${unlistedTemplate.id}' uses a tool outside the lane allowlist`,
      });
    }
  }
});

export const aiOpsEvidenceQueryPreflightInputSchema = z.object({
  bundleId: positiveId,
  lane: evidenceLaneSchema,
  query: aiOpsBoundedQueryTemplateSchema,
  context: z.object({
    serviceName: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.serviceNameChars),
    environment: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.environmentChars),
    windowStart: isoTimestamp,
    windowEnd: isoTimestamp,
    runtime: z.object({
      cluster: boundedText(200),
      namespace: boundedText(63),
    }).strict().optional(),
    signal: z.object({
      keyword: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.querySignalChars).optional(),
      fingerprint: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.querySignalChars).optional(),
    }).strict().optional(),
    traceId: z.string().trim().max(128).optional(),
  }).strict(),
  execute: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  const start = Date.parse(value.context.windowStart);
  const end = Date.parse(value.context.windowEnd);
  if (start >= end) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['context', 'windowEnd'], message: 'query window end must be after its start' });
  } else if (end - start > AIOPS_SERVICE_PROFILE_LIMITS.correlationWindowMinutesMax * 60_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['context'], message: 'query window exceeds the maximum AIOps correlation window' });
  }
});

export const aiOpsEvidenceQueryPreflightResultSchema = z.object({
  schemaVersion: z.literal(AIOPS_SERVICE_PROFILE_SCHEMA_VERSION),
  kind: z.literal('aiops-evidence-query-preflight'),
  lane: evidenceLaneSchema,
  bundleId: positiveId,
  queryId: boundedText(120),
  toolName: boundedText(200),
  generatedAt: isoTimestamp,
  state: z.enum(['preview', 'succeeded', 'failed']),
  executed: z.boolean(),
  request: z.object({
    arguments: z.record(z.unknown()),
  }).strict(),
  response: z.object({
    preview: z.string().max(16_384),
    matchedDocuments: z.number().int().min(0).nullable(),
    durationMs: z.number().int().min(0),
    resultBytes: z.number().int().min(0),
    truncated: z.boolean(),
  }).strict().nullable(),
}).strict();

export const aiOpsRuntimeSelectorSchema = z.object({
  kind: z.literal('kubernetes'),
  backendId: positiveId,
  targetId: boundedText(128),
  cluster: boundedText(200),
  namespace: boundedText(63),
  workloads: z.array(z.object({
    kind: z.enum(['Deployment', 'StatefulSet', 'Job']),
    name: boundedText(200),
  }).strict()).min(1).max(64),
}).strict().superRefine((value, context) => {
  const identities = value.workloads.map(workload => `${workload.kind}\0${workload.name}`);
  if (!uniqueValues(identities)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'runtime workloads must be unique' });
  }
});

export const aiOpsDependencyOverrideSchema = z.object({
  targetKind: z.enum(['service', 'database', 'messaging', 'external']),
  targetName: boundedText(200),
  relation: z.enum(['calls', 'queries', 'publishes']),
  direction: z.enum(['upstream', 'downstream']),
  reason: z.string().trim().max(500).optional(),
}).strict();

export const aiOpsServiceProfileConfigSchema = z.object({
  schemaVersion: z.literal(AIOPS_SERVICE_PROFILE_SCHEMA_VERSION),
  service: z.object({
    displayName: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.displayNameChars),
    serviceName: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.serviceNameChars),
    environment: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.environmentChars),
    description: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.descriptionChars).optional(),
  }).strict(),
  ownership: z.object({
    team: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.ownerFieldChars).optional(),
    escalationPolicyRef: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.ownerFieldChars).optional(),
    businessService: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.ownerFieldChars).optional(),
    criticality: z.enum(['low', 'medium', 'high', 'critical']),
  }).strict(),
  evidencePolicy: z.object({
    lanes: z.array(aiOpsEvidenceLaneBindingSchema)
      .min(1)
      .max(AIOPS_SERVICE_PROFILE_LIMITS.evidenceLanes),
    minimumCollectedLanes: z.number().int().min(1).max(AIOPS_SERVICE_PROFILE_LIMITS.evidenceLanes),
    correlationWindowMinutes: z.number().int()
      .min(AIOPS_SERVICE_PROFILE_LIMITS.correlationWindowMinutesMin)
      .max(AIOPS_SERVICE_PROFILE_LIMITS.correlationWindowMinutesMax),
    maxProviderResultBytes: z.number().int()
      .min(AIOPS_SERVICE_PROFILE_LIMITS.providerResultBytesMin)
      .max(AIOPS_SERVICE_PROFILE_LIMITS.providerResultBytesMax),
  }).strict(),
  selectors: z.object({
    otelServiceNames: boundedUniqueTextArray(
      AIOPS_SERVICE_PROFILE_LIMITS.selectorValues,
      AIOPS_SERVICE_PROFILE_LIMITS.selectorValueChars,
    ),
    metricLabels: boundedLabelRecord,
    logLabels: boundedLabelRecord,
    traceOperations: boundedUniqueTextArray(
      AIOPS_SERVICE_PROFILE_LIMITS.selectorValues,
      AIOPS_SERVICE_PROFILE_LIMITS.selectorValueChars,
    ),
    runtime: aiOpsRuntimeSelectorSchema.optional(),
    repositories: z.array(z.object({
      provider: boundedText(80),
      owner: boundedText(200),
      repository: boundedText(200),
    }).strict()).max(32).optional(),
  }).strict(),
  detection: z.object({
    nativeAlertRuleIds: z.array(positiveId).max(AIOPS_SERVICE_PROFILE_LIMITS.alertRules).refine(uniqueValues),
    nativeSloIds: z.array(positiveId).max(AIOPS_SERVICE_PROFILE_LIMITS.slos).refine(uniqueValues),
    providerMonitorRefs: boundedUniqueTextArray(
      AIOPS_SERVICE_PROFILE_LIMITS.providerMonitorRefs,
      300,
    ),
    autoInvestigate: z.boolean(),
    cooldownMinutes: z.number().int()
      .min(AIOPS_SERVICE_PROFILE_LIMITS.cooldownMinutesMin)
      .max(AIOPS_SERVICE_PROFILE_LIMITS.cooldownMinutesMax),
  }).strict(),
  context: z.object({
    knowledgeSourceIds: z.array(positiveId)
      .max(AIOPS_SERVICE_PROFILE_LIMITS.knowledgeSources)
      .refine(uniqueValues),
    runbookRefs: boundedUniqueTextArray(AIOPS_SERVICE_PROFILE_LIMITS.runbookRefs, 500),
    dependencyOverrides: z.array(aiOpsDependencyOverrideSchema)
      .max(AIOPS_SERVICE_PROFILE_LIMITS.dependencyOverrides),
  }).strict(),
  remediationPolicy: z.object({
    mode: z.enum(['diagnose-only', 'propose', 'governed-execute']),
    allowedAdapterKeys: boundedUniqueTextArray(
      AIOPS_SERVICE_PROFILE_LIMITS.remediationAdapters,
      200,
    ),
    maxRiskWithoutApproval: z.enum(['none', 'low']),
    requireApprovalInProduction: z.literal(true),
    requireVerification: z.literal(true),
    requireRollbackPlan: z.literal(true),
  }).strict(),
}).strict().superRefine((value, context) => {
  const enabledLanes = value.evidencePolicy.lanes.filter(lane => lane.requirement !== 'disabled');
  if (!uniqueValues(value.evidencePolicy.lanes.map(lane => lane.lane))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence lanes must be unique' });
  }
  if (enabledLanes.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one evidence lane must be enabled' });
  }
  if (value.evidencePolicy.minimumCollectedLanes > enabledLanes.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'minimumCollectedLanes cannot exceed the number of enabled lanes',
    });
  }
  const runtimeLane = value.evidencePolicy.lanes.find(lane => lane.lane === 'runtime');
  if (runtimeLane?.requirement === 'required' && !value.selectors.runtime) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectors', 'runtime'],
      message: 'a required runtime lane needs an explicit runtime selector',
    });
  }
  if (value.remediationPolicy.mode === 'governed-execute' && !value.selectors.runtime) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectors', 'runtime'],
      message: 'governed execution needs an explicit runtime selector',
    });
  }
  if (value.remediationPolicy.mode === 'diagnose-only' && value.remediationPolicy.allowedAdapterKeys.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['remediationPolicy', 'allowedAdapterKeys'],
      message: 'diagnose-only profiles cannot allow remediation adapters',
    });
  }
});

const profileStatusSchema = z.enum(['draft', 'active', 'paused', 'archived']);
const profileActionSchema = z.enum([
  'read', 'edit', 'validate', 'activate', 'pause', 'clone', 'archive', 'investigate',
]);
const profileTagSchema = z.object({
  id: boundedText(120),
  label: boundedText(120),
  color: z.string().regex(/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/).nullable(),
}).strict();

export const aiOpsServiceProfileRevisionSchema = z.object({
  revision: z.number().int().positive(),
  sha256,
  config: aiOpsServiceProfileConfigSchema,
  createdAt: isoTimestamp,
  createdBy: z.object({ id: positiveId, username: boundedText(160) }).strict(),
}).strict();

const aiOpsServiceProfileRevisionRefSchema = z.object({
  revision: z.number().int().positive(),
  sha256,
}).strict();

export const aiOpsServiceProfileResourceSchema = z.object({
  schemaVersion: z.literal(AIOPS_SERVICE_PROFILE_SCHEMA_VERSION),
  kind: z.literal('aiops-service-profile'),
  id: positiveId,
  status: profileStatusSchema,
  activeRevision: aiOpsServiceProfileRevisionRefSchema.nullable(),
  latestRevision: aiOpsServiceProfileRevisionSchema,
  tags: z.array(profileTagSchema).max(AIOPS_SERVICE_PROFILE_LIMITS.tags),
  allowedActions: z.array(profileActionSchema).refine(uniqueValues),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  if (value.activeRevision && value.activeRevision.revision > value.latestRevision.revision) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'active revision cannot be newer than latest revision' });
  }
  if (value.status === 'active' && !value.activeRevision) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'active profiles need an active revision' });
  }
});

const readinessIssueSchema = z.object({
  code: boundedText(120),
  severity: z.enum(['warning', 'blocking']),
  message: boundedText(1_000),
  lane: evidenceLaneSchema.optional(),
  bundleId: positiveId.optional(),
  backendId: positiveId.optional(),
}).strict();

const recoveryActionSchema = z.object({
  id: boundedText(120),
  label: boundedText(160),
  kind: z.enum(['manage_connection', 'add_environment', 'review_catalog', 'renew_certification', 'edit_profile']),
  href: z.string().trim().startsWith('/').max(500),
}).strict();

const laneReadinessSchema = z.object({
  lane: evidenceLaneSchema,
  requirement: z.enum(['required', 'optional', 'disabled']),
  state: z.enum(['ready', 'missing', 'blocked', 'disabled']),
  bundleId: positiveId.nullable(),
  bundleName: z.string().trim().max(160).nullable(),
  providedCategories: z.array(bundleCapabilitySchema).max(16).refine(uniqueValues),
  toolNames: boundedUniqueTextArray(AIOPS_SERVICE_PROFILE_LIMITS.toolsPerLane, 200),
  issueCodes: boundedUniqueTextArray(AIOPS_SERVICE_PROFILE_LIMITS.issues, 120),
}).strict();

export const aiOpsServiceProfileReadinessSchema = z.object({
  schemaVersion: z.literal(AIOPS_SERVICE_PROFILE_SCHEMA_VERSION),
  kind: z.literal('aiops-service-profile-readiness'),
  profileId: positiveId,
  revision: z.number().int().positive(),
  profileSha256: sha256,
  state: z.enum(['ready', 'degraded', 'blocked']),
  generatedAt: isoTimestamp,
  lanes: z.array(laneReadinessSchema).min(1).max(AIOPS_SERVICE_PROFILE_LIMITS.evidenceLanes),
  runtime: z.object({
    required: z.boolean(),
    state: z.enum(['not_required', 'ready', 'missing', 'blocked']),
    scope: aiOpsRuntimeSelectorSchema.nullable(),
    certification: z.object({
      status: z.enum(['passed', 'failed']),
      freshness: z.enum(['fresh', 'expiring', 'stale']),
      generatedAt: isoTimestamp,
      expiresAt: isoTimestamp,
    }).strict().nullable(),
  }).strict(),
  summary: z.object({
    requiredLanes: z.number().int().min(0),
    readyRequiredLanes: z.number().int().min(0),
    optionalGaps: z.number().int().min(0),
    blockingIssues: z.number().int().min(0),
  }).strict(),
  issues: z.array(readinessIssueSchema).max(AIOPS_SERVICE_PROFILE_LIMITS.issues),
  recoveryActions: z.array(recoveryActionSchema).max(AIOPS_SERVICE_PROFILE_LIMITS.recoveryActions),
}).strict().superRefine((value, context) => {
  if (!uniqueValues(value.lanes.map(lane => lane.lane))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'readiness lanes must be unique' });
  }
  const blocking = value.issues.filter(issue => issue.severity === 'blocking').length;
  if (blocking !== value.summary.blockingIssues) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'blocking issue summary does not match issues' });
  }
  if (value.state === 'blocked' && blocking === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'blocked readiness needs a blocking issue' });
  }
});

/**
 * The browser contributes only the incident signal. Service identity, evidence
 * access and query recipes are always resolved from the active profile by Core.
 */
export const aiOpsServiceProfileInvestigationSignalSchema = z.object({
  title: boundedText(200),
  summary: boundedText(10_000),
  severity: z.enum(['critical', 'warning', 'info']).default('warning'),
  startedAt: isoTimestamp.optional(),
  alertSource: z.string().trim().max(120).optional(),
  alertUrl: z.string().url().max(2_000).optional(),
  keyword: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.querySignalChars).optional(),
  fingerprint: z.string().trim().max(AIOPS_SERVICE_PROFILE_LIMITS.querySignalChars).optional(),
  sourceIncidentId: positiveId.optional(),
  labels: z.record(z.string().max(500)).optional(),
}).strict();

export const aiOpsResolvedServiceContextSchema = z.object({
  schemaVersion: z.literal(AIOPS_SERVICE_PROFILE_SCHEMA_VERSION),
  kind: z.literal('aiops-resolved-service-context'),
  profile: z.object({
    id: positiveId,
    revision: z.number().int().positive(),
    sha256,
  }).strict(),
  service: aiOpsServiceProfileConfigSchema.innerType().shape.service,
  ownership: aiOpsServiceProfileConfigSchema.innerType().shape.ownership,
  evidence: z.object({
    minimumCollectedLanes: z.number().int().min(1).max(AIOPS_SERVICE_PROFILE_LIMITS.evidenceLanes),
    correlationWindowMinutes: z.number().int()
      .min(AIOPS_SERVICE_PROFILE_LIMITS.correlationWindowMinutesMin)
      .max(AIOPS_SERVICE_PROFILE_LIMITS.correlationWindowMinutesMax),
    maxProviderResultBytes: z.number().int()
      .min(AIOPS_SERVICE_PROFILE_LIMITS.providerResultBytesMin)
      .max(AIOPS_SERVICE_PROFILE_LIMITS.providerResultBytesMax),
    lanes: z.array(z.object({
      lane: evidenceLaneSchema,
      requirement: z.enum(['required', 'optional']),
      bundleId: positiveId,
      toolNames: boundedUniqueTextArray(AIOPS_SERVICE_PROFILE_LIMITS.toolsPerLane, 200),
      queryTemplates: z.array(aiOpsBoundedQueryTemplateSchema)
        .max(AIOPS_SERVICE_PROFILE_LIMITS.queryTemplatesPerLane),
    }).strict()).min(1).max(AIOPS_SERVICE_PROFILE_LIMITS.evidenceLanes),
  }).strict(),
  selectors: aiOpsServiceProfileConfigSchema.innerType().shape.selectors,
  context: aiOpsServiceProfileConfigSchema.innerType().shape.context,
  remediationPolicy: aiOpsServiceProfileConfigSchema.innerType().shape.remediationPolicy,
  resolvedAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  if (!uniqueValues(value.evidence.lanes.map(lane => lane.lane))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolved evidence lanes must be unique' });
  }
  if (value.evidence.minimumCollectedLanes > value.evidence.lanes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolved minimum evidence exceeds enabled lanes' });
  }
});

export const aiOpsServiceProfileInvestigationStartedSchema = z.object({
  schemaVersion: z.literal(AIOPS_SERVICE_PROFILE_SCHEMA_VERSION),
  kind: z.literal('aiops-service-profile-investigation-started'),
  profile: z.object({ id: positiveId, revision: z.number().int().positive(), sha256 }).strict(),
  resolvedContextSha256: sha256,
  execution: z.object({
    bundleIds: z.array(positiveId).min(1).max(64).refine(uniqueValues),
    toolNames: boundedUniqueTextArray(256, 200),
    resourceScope: z.object({
      kind: z.literal('kubernetes'),
      backendId: positiveId,
      targetId: boundedText(128),
      namespace: boundedText(63),
    }).strict().nullable(),
    service: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.serviceNameChars),
    environment: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.environmentChars),
  }).strict(),
  rootTraceId: z.string().uuid(),
  task: z.record(z.unknown()),
}).strict();

export const aiOpsGlobalReadinessSchema = z.object({
  schemaVersion: z.literal(AIOPS_SERVICE_PROFILE_SCHEMA_VERSION),
  kind: z.literal('aiops-readiness'),
  state: z.enum(['setup_required', 'ready', 'degraded', 'blocked']),
  presentation: z.enum(['connector_setup', 'connected_summary']),
  generatedAt: isoTimestamp,
  pack: z.object({ state: z.enum(['ready', 'degraded', 'offline']), version: boundedText(40).nullable() }).strict(),
  eligibleBundleCount: z.number().int().min(0),
  availableLanes: z.array(evidenceLaneSchema).max(AIOPS_SERVICE_PROFILE_LIMITS.evidenceLanes).refine(uniqueValues),
  primaryConnection: z.object({
    bundleId: positiveId,
    bundleName: boundedText(160),
    lanes: z.array(evidenceLaneSchema).min(1).max(AIOPS_SERVICE_PROFILE_LIMITS.evidenceLanes).refine(uniqueValues),
    certifiedTargetCount: z.number().int().min(0),
    checkedAt: isoTimestamp,
  }).strict().nullable(),
  profiles: z.object({
    active: z.number().int().min(0),
    ready: z.number().int().min(0),
    degraded: z.number().int().min(0),
    blocked: z.number().int().min(0),
  }).strict(),
  issues: z.array(readinessIssueSchema).max(AIOPS_SERVICE_PROFILE_LIMITS.issues),
  recoveryActions: z.array(recoveryActionSchema).max(AIOPS_SERVICE_PROFILE_LIMITS.recoveryActions),
}).strict().superRefine((value, context) => {
  if (value.presentation === 'connected_summary' && !value.primaryConnection) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'connected summary needs a primary connection' });
  }
  if (value.presentation === 'connector_setup' && value.eligibleBundleCount > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'connector setup cannot hide an eligible bundle' });
  }
});

export const aiOpsServiceProfileErrorSchema = z.object({
  schemaVersion: z.literal(AIOPS_SERVICE_PROFILE_SCHEMA_VERSION),
  kind: z.literal('aiops-service-profile-error'),
  error: z.object({
    code: z.enum(['forbidden', 'not_found', 'revision_conflict', 'validation_failed', 'profile_blocked']),
    message: boundedText(1_000),
    requiredPermission: boundedText(160).optional(),
    issueCodes: boundedUniqueTextArray(AIOPS_SERVICE_PROFILE_LIMITS.issues, 120).optional(),
  }).strict(),
}).strict();

export const aiOpsLegacyProjectionSchema = z.object({
  schemaVersion: z.literal(AIOPS_SERVICE_PROFILE_SCHEMA_VERSION),
  kind: z.literal('aiops-legacy-investigation-context'),
  source: z.literal('native-alert-rule-v0'),
  legacy: z.object({
    alertRuleId: positiveId,
    bundleIds: z.array(positiveId).min(1).max(64).refine(uniqueValues),
    resourceScope: z.object({
      kind: z.literal('kubernetes'),
      backendId: positiveId,
      targetId: boundedText(128),
      namespace: boundedText(63),
    }).strict(),
    service: boundedText(200),
    environment: boundedText(120),
  }).strict(),
  resolved: z.object({
    serviceName: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.serviceNameChars),
    environment: boundedText(AIOPS_SERVICE_PROFILE_LIMITS.environmentChars),
    bundleIds: z.array(positiveId).min(1).max(64).refine(uniqueValues),
    runtimeRequired: z.literal(true),
  }).strict(),
  warnings: boundedUniqueTextArray(16, 500),
}).strict();

export const aiOpsCapabilityRequirementSchema = z.object({
  version: z.literal(AIOPS_CAPABILITY_REQUIREMENT_VERSION),
  required: z.array(bundleCapabilitySchema).max(16).refine(uniqueValues),
  optional: z.array(bundleCapabilitySchema).max(16).refine(uniqueValues),
  atLeastOneOf: z.array(z.array(bundleCapabilitySchema).min(1).max(16).refine(uniqueValues))
    .max(8),
}).strict();

export type AiOpsServiceProfileConfig = z.infer<typeof aiOpsServiceProfileConfigSchema>;
export type AiOpsServiceProfileResource = z.infer<typeof aiOpsServiceProfileResourceSchema>;
export type AiOpsServiceProfileReadiness = z.infer<typeof aiOpsServiceProfileReadinessSchema>;
export type AiOpsGlobalReadiness = z.infer<typeof aiOpsGlobalReadinessSchema>;
export type AiOpsCapabilityRequirement = z.infer<typeof aiOpsCapabilityRequirementSchema>;
export type AiOpsEvidenceQueryPreflightInput = z.infer<typeof aiOpsEvidenceQueryPreflightInputSchema>;
export type AiOpsEvidenceQueryPreflightResult = z.infer<typeof aiOpsEvidenceQueryPreflightResultSchema>;
export type AiOpsServiceProfileInvestigationSignal = z.infer<typeof aiOpsServiceProfileInvestigationSignalSchema>;
export type AiOpsResolvedServiceContext = z.infer<typeof aiOpsResolvedServiceContextSchema>;
export type AiOpsServiceProfileInvestigationStarted = z.infer<typeof aiOpsServiceProfileInvestigationStartedSchema>;

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]));
  }
  return value;
}

export function parseAiOpsServiceProfileConfig(value: unknown): AiOpsServiceProfileConfig {
  return aiOpsServiceProfileConfigSchema.parse(value);
}

export function hashAiOpsServiceProfileConfig(value: unknown): string {
  const config = parseAiOpsServiceProfileConfig(value);
  return createHash('sha256').update(JSON.stringify(canonicalJson(config))).digest('hex');
}

export function hashAiOpsResolvedServiceContext(value: unknown): string {
  const context = aiOpsResolvedServiceContextSchema.parse(value);
  return createHash('sha256').update(JSON.stringify(canonicalJson(context))).digest('hex');
}
