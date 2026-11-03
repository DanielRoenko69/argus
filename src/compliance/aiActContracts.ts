import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableAuditJson, type AuditJsonValue } from '../audit/canonicalAuditRedaction.js';

export const AI_ACT_CONTRACT_VERSION = 1 as const;
export const AI_COMPLIANCE_DOSSIER_VERSION = 2 as const;

export const AI_ACT_MARKET_ROLES = [
  'provider',
  'deployer',
  'importer',
  'distributor',
  'authorised_representative',
  'product_manufacturer',
  'data_controller',
  'data_processor',
] as const;

export const AI_ACT_CLASSIFICATIONS = [
  'assessment_required',
  'prohibited',
  'high_risk',
  'limited_transparency',
  'minimal_or_no_risk',
  'out_of_scope',
] as const;

export const AI_ACT_SYSTEM_STATES = [
  'not_assessed',
  'assessment_in_progress',
  'blocked',
  'controls_incomplete',
  'ready_for_independent_review',
  'externally_assessed',
  'released',
  'suspended',
  'retired',
] as const;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const isoTimestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

const boundedUniqueText = (maximumItems: number, maximumChars: number, minimumItems = 0) => z.array(
  boundedText(maximumChars),
).min(minimumItems).max(maximumItems).refine(unique, 'values must be unique');

export const aiActActorRefSchema = z.object({
  actorType: z.enum(['user', 'service', 'system', 'external_reviewer']),
  actorId: boundedText(200),
  displayName: z.string().trim().max(200).optional(),
}).strict();

export const aiActEvidenceRefSchema = z.object({
  evidenceType: z.enum([
    'canonical_event',
    'evidence_pack',
    'report',
    'document',
    'evaluation',
    'run',
    'trace',
    'incident',
    'external_anchor',
    'training_record',
  ]),
  evidenceId: boundedText(240),
  sha256,
  href: z.string().trim().max(1_000).optional(),
}).strict();

export const aiActComponentBindingSchema = z.object({
  resourceType: z.enum([
    'agent',
    'workflow',
    'model',
    'runtime_profile',
    'mcp_bundle',
    'skill',
    'knowledge_source',
    'dataset',
  ]),
  resourceId: boundedText(240),
  revision: boundedText(160),
  sha256,
}).strict();

const controlResponsibilitySchema = z.object({
  party: z.enum(['argus_platform', 'provider', 'deployer', 'external_assessor']),
  responsibility: boundedText(1_000),
  required: z.boolean(),
}).strict();

const controlDefinitionSchema = z.object({
  controlId: boundedText(100).regex(/^AIA-[A-Z0-9-]+$/),
  articleRefs: boundedUniqueText(16, 40, 1),
  title: boundedText(240),
  description: boundedText(2_000),
  applicability: z.enum(['always', 'conditional', 'high_risk']),
  enforcement: z.enum(['technical', 'documentary', 'organisational', 'hybrid']),
  blocksProduction: z.boolean(),
  evidenceKinds: boundedUniqueText(32, 100, 1),
  responsibilities: z.array(controlResponsibilitySchema).min(1).max(12),
  customerInputs: boundedUniqueText(32, 500),
}).strict().superRefine((value, context) => {
  if (!unique(value.responsibilities.map(item => item.party))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['responsibilities'],
      message: 'each party may appear only once per control',
    });
  }
});

export const aiActControlCatalogSchema = z.object({
  schemaVersion: z.literal(AI_ACT_CONTRACT_VERSION),
  kind: z.literal('ai-act-control-catalog'),
  catalogId: boundedText(160),
  catalogVersion: z.number().int().positive(),
  catalogSha256: sha256,
  effectiveFrom: isoTimestamp,
  legalSource: z.object({
    regulation: z.literal('Regulation (EU) 2024/1689'),
    title: boundedText(300),
    url: z.string().url().max(1_000),
  }).strict(),
  claimBoundary: boundedText(1_000),
  controls: z.array(controlDefinitionSchema).min(1).max(256),
}).strict().superRefine((value, context) => {
  if (!unique(value.controls.map(control => control.controlId))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['controls'],
      message: 'control ids must be unique within a catalog version',
    });
  }
});

const roleAssignmentSchema = z.object({
  role: z.enum(AI_ACT_MARKET_ROLES),
  organisationId: boundedText(200),
  organisationName: boundedText(240),
  rationale: boundedText(1_000),
  confirmedBy: aiActActorRefSchema,
  confirmedAt: isoTimestamp,
}).strict();

const classificationSchema = z.object({
  assessmentId: uuid,
  classification: z.enum(AI_ACT_CLASSIFICATIONS),
  articleRefs: boundedUniqueText(24, 60),
  annexRefs: boundedUniqueText(24, 100),
  highRiskBasis: z.string().trim().max(2_000).optional(),
  rationale: boundedText(4_000),
  legalReviewRequired: z.boolean(),
  assessedBy: aiActActorRefSchema,
  assessedAt: isoTimestamp,
  nextReviewAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  if (value.classification === 'high_risk' && !value.highRiskBasis) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['highRiskBasis'],
      message: 'high-risk classifications require an explicit legal basis',
    });
  }
});

const createMarketRoleSchema = z.object({
  role: z.enum(AI_ACT_MARKET_ROLES),
  organisationId: boundedText(200),
  organisationName: boundedText(240),
  rationale: boundedText(1_000),
}).strict();

const createClassificationSchema = z.object({
  classification: z.enum(AI_ACT_CLASSIFICATIONS),
  articleRefs: boundedUniqueText(24, 60),
  annexRefs: boundedUniqueText(24, 100),
  highRiskBasis: z.string().trim().max(2_000).optional(),
  rationale: boundedText(4_000),
  legalReviewRequired: z.boolean(),
  nextReviewAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  if (value.classification === 'high_risk' && !value.highRiskBasis) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['highRiskBasis'],
      message: 'high-risk classifications require an explicit legal basis',
    });
  }
});

/**
 * Browser/API input for the first immutable AI-system revision. Server-owned
 * identity, actor, timestamps and digests are deliberately absent.
 */
export const aiActCreateSystemInputSchema = z.object({
  displayName: boundedText(240),
  intendedPurpose: boundedText(4_000),
  prohibitedUses: boundedUniqueText(32, 1_000),
  targetUsers: boundedUniqueText(32, 500, 1),
  affectedGroups: boundedUniqueText(64, 500),
  regions: boundedUniqueText(32, 100, 1),
  marketRoles: z.array(createMarketRoleSchema).min(1).max(AI_ACT_MARKET_ROLES.length),
  prohibitedPracticeCheck: z.object({
    decision: z.enum(['clear', 'blocked', 'external_review_required']),
    articleRefs: boundedUniqueText(16, 60),
    rationale: boundedText(2_000),
  }).strict(),
  classification: createClassificationSchema,
  componentBindings: z.array(aiActComponentBindingSchema).min(1).max(512),
  dataCategories: boundedUniqueText(64, 240),
  controlCatalog: z.object({
    catalogId: boundedText(160),
    catalogVersion: z.number().int().positive(),
    catalogSha256: sha256,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!unique(value.marketRoles.map(item => item.role))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['marketRoles'], message: 'market roles must be unique' });
  }
  const componentKeys = value.componentBindings.map(item => `${item.resourceType}\0${item.resourceId}`);
  if (!unique(componentKeys)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['componentBindings'], message: 'component bindings must be unique' });
  }
  if (
    value.prohibitedPracticeCheck.decision === 'blocked'
    && value.classification.classification !== 'prohibited'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['classification', 'classification'],
      message: 'a blocked prohibited-practice check requires the prohibited classification',
    });
  }
  if (
    value.classification.classification === 'prohibited'
    && value.prohibitedPracticeCheck.decision !== 'blocked'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prohibitedPracticeCheck', 'decision'],
      message: 'the prohibited classification requires a blocked prohibited-practice check',
    });
  }
});

export const aiActSystemRevisionSchema = z.object({
  schemaVersion: z.literal(AI_ACT_CONTRACT_VERSION),
  kind: z.literal('ai-system-revision'),
  aiSystemId: uuid,
  revisionId: uuid,
  revision: z.number().int().positive(),
  revisionSha256: sha256,
  displayName: boundedText(240),
  lifecycleState: z.enum(AI_ACT_SYSTEM_STATES),
  owner: aiActActorRefSchema,
  intendedPurpose: boundedText(4_000),
  prohibitedUses: boundedUniqueText(32, 1_000),
  targetUsers: boundedUniqueText(32, 500, 1),
  affectedGroups: boundedUniqueText(64, 500),
  regions: boundedUniqueText(32, 100, 1),
  marketRoles: z.array(roleAssignmentSchema).min(1).max(AI_ACT_MARKET_ROLES.length),
  prohibitedPracticeCheck: z.object({
    decision: z.enum(['clear', 'blocked', 'external_review_required']),
    articleRefs: boundedUniqueText(16, 60),
    rationale: boundedText(2_000),
    decidedBy: aiActActorRefSchema,
    decidedAt: isoTimestamp,
  }).strict(),
  classification: classificationSchema,
  componentBindings: z.array(aiActComponentBindingSchema).min(1).max(512),
  dataCategories: boundedUniqueText(64, 240),
  controlCatalog: z.object({
    catalogId: boundedText(160),
    catalogVersion: z.number().int().positive(),
    catalogSha256: sha256,
  }).strict(),
  createdAt: isoTimestamp,
  releasedAt: isoTimestamp.nullable(),
}).strict().superRefine((value, context) => {
  if (!unique(value.marketRoles.map(item => item.role))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['marketRoles'], message: 'market roles must be unique' });
  }
  const componentKeys = value.componentBindings.map(item => `${item.resourceType}\0${item.resourceId}`);
  if (!unique(componentKeys)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['componentBindings'], message: 'component bindings must be unique' });
  }
  if (
    (value.classification.classification === 'prohibited' || value.prohibitedPracticeCheck.decision === 'blocked')
    && value.lifecycleState !== 'blocked'
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lifecycleState'], message: 'prohibited systems must be blocked' });
  }
  if (value.lifecycleState === 'released' && !value.releasedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['releasedAt'], message: 'released systems need a release timestamp' });
  }
});

/** Optimistic, server-owned transition input for a new immutable draft revision. */
export const aiActRevisionDecisionInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedRevisionSha256: sha256,
  changeSummary: boundedText(2_000),
  displayName: boundedText(240),
  intendedPurpose: boundedText(4_000),
  prohibitedUses: boundedUniqueText(32, 1_000),
  targetUsers: boundedUniqueText(32, 500, 1),
  affectedGroups: boundedUniqueText(64, 500),
  regions: boundedUniqueText(32, 100, 1),
  marketRoles: z.array(createMarketRoleSchema).min(1).max(AI_ACT_MARKET_ROLES.length),
  componentBindings: z.array(aiActComponentBindingSchema).min(1).max(512),
  dataCategories: boundedUniqueText(64, 240),
  controlCatalog: z.object({
    catalogId: boundedText(160),
    catalogVersion: z.number().int().positive(),
    catalogSha256: sha256,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!unique(value.marketRoles.map(item => item.role))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['marketRoles'], message: 'market roles must be unique' });
  }
  const componentKeys = value.componentBindings.map(item => `${item.resourceType}\0${item.resourceId}`);
  if (!unique(componentKeys)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['componentBindings'], message: 'component bindings must be unique' });
  }
});

/** A separate reviewer confirms Art. 5 and risk classification for the current revision. */
export const aiActClassificationDecisionInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedRevisionSha256: sha256,
  prohibitedPracticeCheck: z.object({
    decision: z.enum(['clear', 'blocked', 'external_review_required']),
    articleRefs: boundedUniqueText(16, 60),
    rationale: boundedText(2_000),
  }).strict(),
  classification: createClassificationSchema,
}).strict().superRefine((value, context) => {
  if (value.prohibitedPracticeCheck.decision === 'blocked' && value.classification.classification !== 'prohibited') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['classification', 'classification'], message: 'a blocked prohibited-practice check requires the prohibited classification' });
  }
  if (value.classification.classification === 'prohibited' && value.prohibitedPracticeCheck.decision !== 'blocked') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['prohibitedPracticeCheck', 'decision'], message: 'the prohibited classification requires a blocked prohibited-practice check' });
  }
});

/** Release accepts only content-addressed evidence references, never raw artifacts. */
export const aiActReleaseDecisionInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedRevisionSha256: sha256,
  decisionRationale: boundedText(2_000),
  evidence: z.array(aiActEvidenceRefSchema).min(1).max(256),
}).strict().superRefine((value, context) => {
  if (!unique(value.evidence.map(item => `${item.evidenceType}\0${item.evidenceId}\0${item.sha256}`))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'release evidence references must be unique' });
  }
});

export const aiActProductionRunBindingSchema = z.object({
  schemaVersion: z.literal(AI_ACT_CONTRACT_VERSION),
  kind: z.literal('ai-system-production-run-binding'),
  rootRunId: boundedText(240),
  environment: boundedText(120),
  production: z.boolean(),
  executionAuthorized: z.boolean(),
  boundAt: isoTimestamp,
  aiSystemId: uuid,
  aiSystemRevisionId: uuid,
  classificationAssessmentId: uuid,
  controlCatalog: z.object({
    catalogId: boundedText(160),
    catalogVersion: z.number().int().positive(),
    catalogSha256: sha256,
  }).strict(),
  controlSetSha256: sha256,
  intendedPurposeSha256: sha256,
  componentBindings: z.array(aiActComponentBindingSchema).min(1).max(512),
  effectiveIdentity: z.object({
    actorType: z.enum(['human', 'service']),
    subjectId: boundedText(240),
    role: boundedText(120),
    authenticationMethod: z.enum(['sso', 'workload_identity', 'local', 'api_key']),
    identityVerified: z.boolean(),
    mfaStepUpAt: isoTimestamp.nullable(),
  }).strict(),
  releaseGate: z.object({
    status: z.enum(['passed', 'blocked']),
    checkedAt: isoTimestamp,
    blockingReasons: boundedUniqueText(64, 500),
    evidence: z.array(aiActEvidenceRefSchema).max(256),
  }).strict(),
  retentionClass: boundedText(120),
  legalHoldIds: boundedUniqueText(32, 240),
}).strict().superRefine((value, context) => {
  if (value.executionAuthorized && value.releaseGate.status !== 'passed') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['releaseGate', 'status'], message: 'authorized execution requires a passed release gate' });
  }
  if (value.executionAuthorized && value.releaseGate.blockingReasons.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['releaseGate', 'blockingReasons'], message: 'authorized execution cannot retain blocking reasons' });
  }
  if (value.production && value.executionAuthorized && !value.effectiveIdentity.identityVerified) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['effectiveIdentity', 'identityVerified'], message: 'authorized production runs require a verified identity' });
  }
  if (
    value.production && value.executionAuthorized
    && value.effectiveIdentity.actorType === 'human'
    && value.effectiveIdentity.authenticationMethod !== 'sso'
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['effectiveIdentity', 'authenticationMethod'], message: 'authorized human production runs require SSO' });
  }
  if (
    value.production && value.executionAuthorized
    && value.effectiveIdentity.actorType === 'service'
    && value.effectiveIdentity.authenticationMethod !== 'workload_identity'
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['effectiveIdentity', 'authenticationMethod'], message: 'authorized automated production runs require a workload identity' });
  }
});

const registrationStepSchema = z.object({
  stepId: z.enum([
    'identity',
    'intended_purpose',
    'market_roles',
    'prohibited_practices',
    'classification',
    'components',
    'controls',
    'independent_review',
  ]),
  title: boundedText(200),
  status: z.enum(['not_started', 'in_progress', 'complete', 'blocked', 'external_review_required']),
  blocking: z.boolean(),
  issues: boundedUniqueText(32, 500),
  action: z.object({
    label: boundedText(120),
    href: boundedText(1_000),
  }).strict().nullable(),
}).strict();

export const aiActRegistrationReadinessSchema = z.object({
  schemaVersion: z.literal(AI_ACT_CONTRACT_VERSION),
  kind: z.literal('ai-system-registration-readiness'),
  aiSystemId: uuid,
  revisionId: uuid,
  state: z.enum(AI_ACT_SYSTEM_STATES),
  generatedAt: isoTimestamp,
  evidenceCoverage: z.object({
    applicable: z.number().int().min(0),
    satisfied: z.number().int().min(0),
    blocked: z.number().int().min(0),
    notAssessed: z.number().int().min(0),
    expiring: z.number().int().min(0),
  }).strict(),
  steps: z.array(registrationStepSchema).length(8),
  customerResponsibilities: z.array(z.object({
    responsibilityId: boundedText(120),
    title: boundedText(240),
    ownerRole: z.enum(['provider', 'deployer', 'external_assessor']),
    status: z.enum(['open', 'provided', 'verified']),
    dueAt: isoTimestamp.nullable(),
  }).strict()).max(128),
  allowedActions: boundedUniqueText(32, 100),
  claimBoundary: boundedText(1_000),
}).strict().superRefine((value, context) => {
  const accounted = value.evidenceCoverage.satisfied
    + value.evidenceCoverage.blocked
    + value.evidenceCoverage.notAssessed;
  if (accounted !== value.evidenceCoverage.applicable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceCoverage'], message: 'applicable controls must equal satisfied + blocked + notAssessed' });
  }
  if (!unique(value.steps.map(step => step.stepId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'registration steps must be unique' });
  }
});

const dossierSectionSchema = z.object({
  sectionId: boundedText(120),
  title: boundedText(240),
  state: z.enum(['complete', 'complete_with_gaps', 'missing', 'not_applicable']),
  evidenceCount: z.number().int().min(0),
  gapCount: z.number().int().min(0),
  evidence: z.array(aiActEvidenceRefSchema).max(1_000),
}).strict();

const dossierRequirementStateSchema = z.enum([
  'satisfied',
  'partial',
  'missing',
  'not_applicable',
  'expired',
]);

const dossierRequirementCoverageSchema = z.object({
  applicable: z.number().int().min(0),
  satisfied: z.number().int().min(0),
  partial: z.number().int().min(0),
  missing: z.number().int().min(0),
  expired: z.number().int().min(0),
  notApplicable: z.number().int().min(0),
}).strict().superRefine((value, context) => {
  if (value.applicable !== value.satisfied + value.partial + value.missing + value.expired) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['applicable'],
      message: 'applicable dossier requirements must equal satisfied + partial + missing + expired',
    });
  }
});

const dossierRequirementSchema = z.object({
  requirementId: boundedText(160),
  legalRefs: boundedUniqueText(24, 120, 1),
  title: boundedText(300),
  description: boundedText(3_000),
  applicability: z.enum(['always', 'conditional', 'high_risk']),
  state: dossierRequirementStateSchema,
  ownerRole: z.enum(['argus_platform', 'provider', 'deployer', 'external_assessor']),
  expectedEvidence: boundedUniqueText(32, 240, 1),
  controlIds: boundedUniqueText(32, 120),
  evidence: z.array(aiActEvidenceRefSchema).max(1_000),
  findings: boundedUniqueText(64, 1_000),
  assessedAt: isoTimestamp,
  nextReviewAt: isoTimestamp.nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === 'satisfied' && value.evidence.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'satisfied requirements require evidence' });
  }
  if ((value.state === 'partial' || value.state === 'missing' || value.state === 'expired') && value.findings.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['findings'], message: 'incomplete requirements require an explicit finding' });
  }
  if (value.state === 'not_applicable' && value.applicability === 'always') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['state'], message: 'always-applicable requirements cannot be marked not applicable' });
  }
});

const dossierObligationGroupSchema = z.object({
  groupId: z.enum(['annex_iv', 'quality_management', 'lifecycle', 'conformity_assessment']),
  title: boundedText(300),
  legalRefs: boundedUniqueText(32, 120, 1),
  coverage: dossierRequirementCoverageSchema,
  requirements: z.array(dossierRequirementSchema).min(1).max(64),
}).strict().superRefine((value, context) => {
  const stateCount = (state: z.infer<typeof dossierRequirementStateSchema>): number => value.requirements.filter(item => item.state === state).length;
  const expected = {
    applicable: value.requirements.length - stateCount('not_applicable'),
    satisfied: stateCount('satisfied'),
    partial: stateCount('partial'),
    missing: stateCount('missing'),
    expired: stateCount('expired'),
    notApplicable: stateCount('not_applicable'),
  };
  for (const [key, count] of Object.entries(expected)) {
    if (value.coverage[key as keyof typeof value.coverage] !== count) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage', key], message: `group coverage ${key} does not match its requirements` });
    }
  }
  if (!unique(value.requirements.map(requirement => requirement.requirementId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['requirements'], message: 'requirement ids must be unique within a dossier group' });
  }
});

const dossierComplianceMatrixSchema = z.object({
  schemaVersion: z.literal(AI_COMPLIANCE_DOSSIER_VERSION),
  kind: z.literal('argus.ai-compliance-obligation-matrix'),
  matrixSha256: sha256,
  legalBaseline: z.object({
    regulation: z.literal('Regulation (EU) 2024/1689'),
    officialJournalUrl: z.string().url().max(1_000),
    annexIvUrl: z.string().url().max(1_000),
    qualityManagementUrl: z.string().url().max(1_000),
    assessedAt: isoTimestamp,
    legalReviewRequired: z.literal(true),
    applicabilityRationale: boundedText(2_000),
  }).strict(),
  coverage: dossierRequirementCoverageSchema,
  groups: z.array(dossierObligationGroupSchema).length(4),
}).strict().superRefine((value, context) => {
  const requirements = value.groups.flatMap(group => group.requirements);
  const stateCount = (state: z.infer<typeof dossierRequirementStateSchema>): number => requirements.filter(item => item.state === state).length;
  const expected = {
    applicable: requirements.length - stateCount('not_applicable'),
    satisfied: stateCount('satisfied'),
    partial: stateCount('partial'),
    missing: stateCount('missing'),
    expired: stateCount('expired'),
    notApplicable: stateCount('not_applicable'),
  };
  for (const [key, count] of Object.entries(expected)) {
    if (value.coverage[key as keyof typeof value.coverage] !== count) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage', key], message: `matrix coverage ${key} does not match its requirements` });
    }
  }
  const groupIds = value.groups.map(group => group.groupId);
  if (!unique(groupIds)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['groups'], message: 'dossier obligation groups must be unique' });
  if (!unique(requirements.map(requirement => requirement.requirementId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['groups'], message: 'dossier requirement ids must be globally unique' });
  }
});

/** Server-scoped request for a dossier over one immutable released revision. */
export const aiActComplianceDossierGenerationInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedRevisionSha256: sha256,
  sourceReportRunId: uuid,
}).strict();

const aiActComplianceDossierManifestCommonShape = {
  kind: z.literal('ai-compliance-dossier-manifest'),
  dossierId: uuid,
  dossierSha256: sha256,
  generatedAt: isoTimestamp,
  generatedBy: aiActActorRefSchema,
  assessmentStatus: z.enum([
    'controls_incomplete',
    'ready_for_independent_review',
    'externally_assessed',
    'suspended',
  ]),
  aiSystem: z.object({
    aiSystemId: uuid,
    revisionId: uuid,
    revision: z.number().int().positive(),
    revisionSha256: sha256,
    displayName: boundedText(240),
    classification: z.enum(AI_ACT_CLASSIFICATIONS),
  }).strict(),
  scope: z.object({
    workspaceId: boundedText(200),
    tenantId: boundedText(200),
    environments: boundedUniqueText(32, 120, 1),
    from: isoTimestamp,
    to: isoTimestamp,
  }).strict(),
  sourceEvidencePack: z.object({
    evidencePackId: uuid,
    sha256,
    checkpointId: uuid,
    verification: z.enum(['verified', 'verified_with_declared_gaps', 'failed']),
  }).strict(),
  controlCoverage: z.object({
    applicable: z.number().int().min(0),
    satisfied: z.number().int().min(0),
    open: z.number().int().min(0),
    exceptions: z.number().int().min(0),
    expired: z.number().int().min(0),
  }).strict(),
  sections: z.array(dossierSectionSchema).min(1).max(64),
  artifacts: z.array(z.object({
    format: z.enum(['pdfa', 'pdf', 'json', 'jsonl', 'csv', 'signature']),
    filename: boundedText(240),
    mediaType: boundedText(160),
    bytes: z.number().int().positive(),
    sha256,
  }).strict()).min(2).max(8),
  externalAnchors: z.array(z.object({
    kind: z.enum(['worm_object', 'qualified_timestamp', 'transparency_log']),
    provider: boundedText(240),
    reference: boundedText(1_000),
    anchoredAt: isoTimestamp,
    verification: z.enum(['verified', 'failed', 'unverified']),
  }).strict()).max(16),
  declaredGaps: z.array(z.object({
    gapId: boundedText(120),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    description: boundedText(2_000),
    ownerRole: z.enum(['argus_platform', 'provider', 'deployer', 'external_assessor']),
    dueAt: isoTimestamp.nullable(),
  }).strict()).max(256),
  claimBoundary: boundedText(1_000),
};

const aiActComplianceDossierManifestV1Schema = z.object({
  schemaVersion: z.literal(AI_ACT_CONTRACT_VERSION),
  ...aiActComplianceDossierManifestCommonShape,
}).strict();

export const aiActComplianceDossierManifestV2Schema = z.object({
  schemaVersion: z.literal(AI_COMPLIANCE_DOSSIER_VERSION),
  ...aiActComplianceDossierManifestCommonShape,
  complianceMatrix: dossierComplianceMatrixSchema,
}).strict();

export const aiActComplianceDossierManifestSchema = z.union([
  aiActComplianceDossierManifestV1Schema,
  aiActComplianceDossierManifestV2Schema,
]).superRefine((value, context) => {
  const accounted = value.controlCoverage.satisfied
    + value.controlCoverage.open
    + value.controlCoverage.exceptions
    + value.controlCoverage.expired;
  if (accounted !== value.controlCoverage.applicable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['controlCoverage'], message: 'applicable controls must be fully accounted for' });
  }
  if (!unique(value.sections.map(section => section.sectionId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sections'], message: 'dossier section ids must be unique' });
  }
  if (!unique(value.artifacts.map(artifact => artifact.format))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts'], message: 'dossier artifact formats must be unique' });
  }
  if (value.schemaVersion === AI_COMPLIANCE_DOSSIER_VERSION) {
    const { matrixSha256: _digest, ...unsignedMatrix } = value.complianceMatrix;
    const computed = createHash('sha256')
      .update(stableAuditJson(JSON.parse(JSON.stringify(unsignedMatrix)) as AuditJsonValue), 'utf8')
      .digest('hex');
    if (computed !== value.complianceMatrix.matrixSha256) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['complianceMatrix', 'matrixSha256'], message: 'compliance matrix digest does not match its canonical content' });
    }
  }
});

export type AiActControlCatalog = z.infer<typeof aiActControlCatalogSchema>;
export type AiActCreateSystemInput = z.infer<typeof aiActCreateSystemInputSchema>;
export type AiActSystemRevision = z.infer<typeof aiActSystemRevisionSchema>;
export type AiActRevisionDecisionInput = z.infer<typeof aiActRevisionDecisionInputSchema>;
export type AiActClassificationDecisionInput = z.infer<typeof aiActClassificationDecisionInputSchema>;
export type AiActReleaseDecisionInput = z.infer<typeof aiActReleaseDecisionInputSchema>;
export type AiActProductionRunBinding = z.infer<typeof aiActProductionRunBindingSchema>;
export type AiActRegistrationReadiness = z.infer<typeof aiActRegistrationReadinessSchema>;
export type AiActComplianceDossierGenerationInput = z.infer<typeof aiActComplianceDossierGenerationInputSchema>;
export type AiActComplianceDossierManifest = z.infer<typeof aiActComplianceDossierManifestSchema>;
export type AiActComplianceDossierManifestV2 = z.infer<typeof aiActComplianceDossierManifestV2Schema>;
export type AiActComplianceMatrix = AiActComplianceDossierManifestV2['complianceMatrix'];
export type AiActComplianceRequirement = AiActComplianceMatrix['groups'][number]['requirements'][number];
