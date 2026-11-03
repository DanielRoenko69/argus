import { z } from 'zod';

export const GOLDEN_PATH_SCHEMA_VERSION = 1 as const;

export const GOLDEN_PATH_STAGE_IDS = [
  'preflight',
  'issue_ingestion',
  'repository_context',
  'dev_analysis',
  'policy_decision',
  'approval',
  'external_action',
  'evidence',
] as const;

export const GOLDEN_PATH_PREFLIGHT_CHECK_IDS = [
  'core',
  'argus_dev',
  'runtime',
  'mcp_git',
  'mcp_notification',
  'workflow',
  'policy',
  'evidence',
] as const;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const isoTimestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const optionalHref = z.string().trim().min(1).max(2_000).optional();
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

const goldenPathModeSchema = z.enum(['certification', 'live_demo']);
const runtimeKindSchema = z.enum(['hermes', 'native']);

export const goldenPathRunStartSchema = z.object({
  mode: goldenPathModeSchema.default('certification'),
  writeMode: z.enum(['read_only', 'guarded']).default('guarded'),
}).strict();

export const goldenPathRunStartReceiptSchema = z.object({
  schemaVersion: z.literal(GOLDEN_PATH_SCHEMA_VERSION),
  kind: z.literal('argus.golden-path-run-started'),
  runId: z.string().uuid(),
  workflowExecutionId: z.number().int().positive().nullable(),
  traceId: boundedText(200).nullable(),
  status: z.enum(['starting', 'running', 'failed']),
  replayed: z.boolean(),
  href: boundedText(2_000),
}).strict();

const goldenPathScopeSchema = z.object({
  tenantKey: boundedText(120),
  workspaceKey: boundedText(120),
  environment: boundedText(120),
}).strict();

const goldenPathGitTargetSchema = z.object({
  provider: z.enum(['gitea', 'github']),
  repository: boundedText(300),
  issueNumber: z.number().int().positive(),
  baseUrlOrigin: boundedText(500),
  allowedOperations: z.array(z.enum(['comment', 'add_label']))
    .min(1)
    .max(2)
    .refine(unique, 'git operations must be unique'),
  writeScopeSha256: sha256,
}).strict();

const goldenPathNotificationTargetSchema = z.object({
  provider: z.enum(['slack_fixture', 'slack']),
  destination: boundedText(200),
  allowedOperations: z.array(z.literal('post_message')).length(1),
  writeScopeSha256: sha256,
}).strict();

const goldenPathWorkflowBindingSchema = z.object({
  id: boundedText(200),
  revision: boundedText(120),
  sha256,
  saved: z.literal(true),
  agent: z.object({
    id: boundedText(200),
    revision: boundedText(120),
    sha256,
  }).strict(),
}).strict();

const goldenPathRuntimeBindingSchema = z.object({
  preferred: runtimeKindSchema,
  selected: runtimeKindSchema,
  fallbackAllowed: z.boolean(),
  profileId: boundedText(200),
  grantSha256: sha256,
}).strict().superRefine((value, context) => {
  if (!value.fallbackAllowed && value.preferred !== value.selected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selected'],
      message: 'selected runtime cannot differ when fallback is disabled',
    });
  }
});

const goldenPathPolicyBindingSchema = z.object({
  writeMode: z.enum(['read_only', 'guarded']),
  approvalRequired: z.boolean(),
  separationOfDutiesRequired: z.boolean(),
  policySha256: sha256,
  writes: z.array(z.enum(['git_comment', 'git_add_label', 'slack_post_message']))
    .max(3)
    .refine(unique, 'policy writes must be unique'),
}).strict().superRefine((value, context) => {
  if (value.writeMode === 'read_only' && (value.approvalRequired || value.writes.length > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'read-only policy cannot declare writes or runtime approval',
    });
  }
  if (value.writeMode === 'guarded' && (!value.approvalRequired || value.writes.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'guarded policy requires approval and at least one bounded write',
    });
  }
});

const goldenPathPreflightCheckSchema = z.object({
  id: z.enum(GOLDEN_PATH_PREFLIGHT_CHECK_IDS),
  label: boundedText(160),
  required: z.boolean(),
  state: z.enum(['ready', 'degraded', 'blocked', 'not_configured']),
  detail: boundedText(1_000),
  recovery: z.object({
    label: boundedText(160),
    href: boundedText(2_000),
  }).strict().optional(),
}).strict();

export const goldenPathPreflightSchema = z.object({
  schemaVersion: z.literal(GOLDEN_PATH_SCHEMA_VERSION),
  kind: z.literal('argus.golden-path-preflight'),
  mode: goldenPathModeSchema,
  state: z.enum(['ready', 'degraded', 'blocked']),
  generatedAt: isoTimestamp,
  scope: goldenPathScopeSchema,
  targets: z.object({
    git: goldenPathGitTargetSchema,
    notification: goldenPathNotificationTargetSchema,
  }).strict(),
  runtime: goldenPathRuntimeBindingSchema,
  workflow: goldenPathWorkflowBindingSchema,
  policy: goldenPathPolicyBindingSchema,
  checks: z.array(goldenPathPreflightCheckSchema)
    .length(GOLDEN_PATH_PREFLIGHT_CHECK_IDS.length),
  allowedActions: z.array(z.enum(['start', 'refresh', 'configure']))
    .max(3)
    .refine(unique, 'allowed actions must be unique'),
}).strict().superRefine((value, context) => {
  if (!unique(value.checks.map(check => check.id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['checks'], message: 'preflight check ids must be unique' });
  }

  const requiredProblem = value.checks.some(check => check.required && check.state !== 'ready');
  const optionalProblem = value.checks.some(check => !check.required && check.state !== 'ready');
  const expectedState = requiredProblem ? 'blocked' : optionalProblem ? 'degraded' : 'ready';
  if (value.state !== expectedState) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: `preflight state must be '${expectedState}' for the declared checks`,
    });
  }

  const expectedProviders = value.mode === 'certification'
    ? { git: 'gitea', notification: 'slack_fixture' }
    : { git: 'github', notification: 'slack' };
  if (value.targets.git.provider !== expectedProviders.git) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targets', 'git', 'provider'],
      message: `${value.mode} mode requires the ${expectedProviders.git} provider`,
    });
  }
  if (value.targets.notification.provider !== expectedProviders.notification) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targets', 'notification', 'provider'],
      message: `${value.mode} mode requires the ${expectedProviders.notification} provider`,
    });
  }
});

const goldenPathStageSchema = z.object({
  id: z.enum(GOLDEN_PATH_STAGE_IDS),
  label: boundedText(160),
  state: z.enum(['pending', 'running', 'action_required', 'succeeded', 'failed', 'skipped']),
  startedAt: isoTimestamp.nullable(),
  completedAt: isoTimestamp.nullable(),
  detail: z.string().trim().max(1_000),
  resourceRefIds: z.array(boundedText(200)).max(16).refine(unique, 'stage resource references must be unique'),
}).strict().superRefine((value, context) => {
  if (value.completedAt && !value.startedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'completed stage requires startedAt' });
  }
  if (value.state === 'succeeded' && !value.completedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'succeeded stage requires completedAt' });
  }
});

const goldenPathResourceRefSchema = z.object({
  refId: boundedText(200),
  type: z.enum([
    'task',
    'issue',
    'workflow',
    'repository_snapshot',
    'runtime_task',
    'approval',
    'trace',
    'audit_report',
    'evidence_pack',
    'compliance_dossier',
    'worm_receipt',
    'restore_receipt',
  ]),
  id: boundedText(300),
  label: boundedText(300),
  href: optionalHref,
  sha256: sha256.optional(),
}).strict();

const goldenPathApprovalSchema = z.object({
  id: boundedText(200).nullable(),
  state: z.enum(['not_required', 'not_requested', 'pending', 'approved', 'rejected']),
  planSha256: sha256.nullable(),
  payloadSha256: sha256.nullable(),
  targetSummary: z.string().trim().max(1_000),
  requestedAt: isoTimestamp.nullable(),
  decidedAt: isoTimestamp.nullable(),
  decidedBy: z.object({
    actorType: z.enum(['user', 'service']),
    actorId: boundedText(200),
    displayName: boundedText(200),
  }).strict().nullable(),
  rationale: z.string().trim().max(2_000).nullable(),
  allowedActions: z.array(z.enum(['approve', 'reject']))
    .max(2)
    .refine(unique, 'approval actions must be unique'),
}).strict().superRefine((value, context) => {
  if (value.state === 'pending' && (!value.id || !value.requestedAt || value.decidedAt || value.decidedBy)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'pending approval has inconsistent decision state' });
  }
  if ((value.state === 'approved' || value.state === 'rejected')
      && (!value.id || !value.requestedAt || !value.decidedAt || !value.decidedBy)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'decided approval requires actor and timestamps' });
  }
  if (value.state === 'not_required'
      && (value.id || value.planSha256 || value.payloadSha256 || value.requestedAt || value.decidedAt || value.decidedBy)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'non-required approval cannot retain decision identifiers' });
  }
  if (value.state === 'not_requested'
      && (value.id || value.planSha256 || value.payloadSha256 || value.requestedAt || value.decidedAt || value.decidedBy)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'non-requested approval cannot retain decision identifiers' });
  }
});

const goldenPathOutcomeSchema = z.object({
  target: z.enum(['git', 'slack']),
  operation: z.enum(['comment', 'add_label', 'post_message']),
  state: z.enum(['pending', 'succeeded', 'failed', 'skipped']),
  attemptCount: z.number().int().min(0).max(100),
  idempotencyKeySha256: sha256,
  providerReceiptSha256: sha256.nullable(),
  verifiedAt: isoTimestamp.nullable(),
  retryable: z.boolean(),
  detail: z.string().trim().max(1_000),
}).strict().superRefine((value, context) => {
  if (value.state === 'succeeded' && (!value.providerReceiptSha256 || !value.verifiedAt || value.attemptCount < 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'succeeded outcome requires receipt, verification and an attempt' });
  }
  if (value.state === 'pending' && (value.providerReceiptSha256 || value.verifiedAt || value.attemptCount !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'pending outcome cannot contain execution evidence' });
  }
});

const goldenPathEvidenceSchema = z.object({
  state: z.enum(['pending', 'complete', 'complete_with_gaps']),
  offlineVerifiable: z.boolean(),
  gaps: z.array(boundedText(500)).max(32),
  resourceRefIds: z.array(boundedText(200)).max(16).refine(unique, 'evidence references must be unique'),
}).strict().superRefine((value, context) => {
  if (value.state === 'complete' && (!value.offlineVerifiable || value.gaps.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'complete evidence must be offline-verifiable and gap-free' });
  }
  if (value.state === 'complete_with_gaps' && value.gaps.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'complete_with_gaps evidence requires declared gaps' });
  }
  if (value.state === 'pending' && value.offlineVerifiable) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'pending evidence cannot be offline-verifiable' });
  }
});

export const goldenPathRunSchema = z.object({
  schemaVersion: z.literal(GOLDEN_PATH_SCHEMA_VERSION),
  kind: z.literal('argus.golden-path-run'),
  mode: goldenPathModeSchema,
  status: z.enum(['running', 'waiting_for_approval', 'completed', 'completed_with_gaps', 'rejected', 'failed']),
  title: boundedText(300),
  startedAt: isoTimestamp,
  updatedAt: isoTimestamp,
  completedAt: isoTimestamp.nullable(),
  scope: goldenPathScopeSchema,
  workflow: goldenPathWorkflowBindingSchema,
  runtime: goldenPathRuntimeBindingSchema,
  policy: goldenPathPolicyBindingSchema,
  correlation: z.object({
    taskId: boundedText(200),
    externalIssueId: boundedText(300),
    runId: boundedText(200),
    traceId: boundedText(200),
    runtimeTaskId: boundedText(200),
  }).strict(),
  stages: z.array(goldenPathStageSchema).length(GOLDEN_PATH_STAGE_IDS.length),
  approval: goldenPathApprovalSchema,
  outcomes: z.array(goldenPathOutcomeSchema).max(3),
  evidence: goldenPathEvidenceSchema,
  resourceRefs: z.array(goldenPathResourceRefSchema).min(5).max(32),
  allowedActions: z.array(z.enum([
    'approve',
    'reject',
    'cancel',
    'retry',
    'open_trace',
    'open_report',
    'download_evidence',
  ])).max(7).refine(unique, 'run actions must be unique'),
}).strict().superRefine((value, context) => {
  const stageIds = value.stages.map(stage => stage.id);
  if (stageIds.some((id, index) => id !== GOLDEN_PATH_STAGE_IDS[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['stages'], message: 'golden path stages must use canonical order' });
  }

  const refIds = value.resourceRefs.map(ref => ref.refId);
  if (!unique(refIds)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resourceRefs'], message: 'resource ref ids must be unique' });
  }
  const knownRefs = new Set(refIds);
  for (const [index, stage] of value.stages.entries()) {
    for (const refId of stage.resourceRefIds) {
      if (!knownRefs.has(refId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', index, 'resourceRefIds'],
          message: `stage references unknown resource '${refId}'`,
        });
      }
    }
  }
  for (const refId of value.evidence.resourceRefIds) {
    if (!knownRefs.has(refId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence', 'resourceRefIds'], message: `evidence references unknown resource '${refId}'` });
    }
  }

  if (value.policy.writeMode === 'read_only' && value.approval.state !== 'not_required') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['approval'], message: 'read-only run cannot require approval' });
  }
  if (value.policy.writeMode === 'guarded' && value.approval.state === 'not_required') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['approval'], message: 'guarded run must carry an approval decision' });
  }
  if (value.status === 'waiting_for_approval' && value.approval.state !== 'pending') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['approval', 'state'], message: 'waiting run requires pending approval' });
  }
  if (value.status === 'rejected' && value.approval.state !== 'rejected') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['approval', 'state'], message: 'rejected run requires rejected approval' });
  }
  if ((value.status === 'completed' || value.status === 'completed_with_gaps') && !value.completedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: 'completed run requires completedAt' });
  }
  if (value.status === 'completed' && value.evidence.state !== 'complete') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence', 'state'], message: 'completed run requires complete evidence' });
  }
  if (value.status === 'completed_with_gaps' && value.evidence.state !== 'complete_with_gaps') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence', 'state'], message: 'completed_with_gaps run requires declared evidence gaps' });
  }
});

export type GoldenPathPreflight = z.infer<typeof goldenPathPreflightSchema>;
export type GoldenPathRun = z.infer<typeof goldenPathRunSchema>;
export type GoldenPathRunStart = z.infer<typeof goldenPathRunStartSchema>;
export type GoldenPathRunStartReceipt = z.infer<typeof goldenPathRunStartReceiptSchema>;
