import { createHash } from 'node:crypto';
import { stableAuditJson, type AuditJsonValue } from '../audit/canonicalAuditRedaction.js';
import type { ExternalEvidenceAnchorRecord } from '../audit/externalAnchorService.js';
import {
  AI_COMPLIANCE_DOSSIER_VERSION,
  aiActComplianceDossierManifestV2Schema,
  type AiActComplianceMatrix,
  type AiActComplianceRequirement,
  type AiActSystemRevision,
} from './aiActContracts.js';
import type { AiSystemControlLedger, AiSystemControlProjection } from './aiSystemControlLedger.js';

type RequirementGroup = AiActComplianceMatrix['groups'][number]['groupId'];
type RequirementState = AiActComplianceRequirement['state'];
type RequirementApplicability = AiActComplianceRequirement['applicability'];
type RequirementOwner = AiActComplianceRequirement['ownerRole'];
type EvidenceRef = AiActComplianceRequirement['evidence'][number];

interface RequirementDefinition {
  requirementId: string;
  groupId: RequirementGroup;
  legalRefs: string[];
  title: string;
  description: string;
  applicability: RequirementApplicability;
  ownerRole: RequirementOwner;
  expectedEvidence: string[];
  controlIds?: string[];
  foundation?: Array<'revision' | 'release' | 'runtime' | 'external_anchor'>;
  maximumStateFromFoundation?: 'partial';
  incompleteFinding: string;
}

export interface AiComplianceDossierMatrixInput {
  revision: AiActSystemRevision;
  controlLedger: AiSystemControlLedger;
  generatedAt: string;
  sourceReport: EvidenceRef;
  sourceEvidencePack: EvidenceRef;
  releaseDecision: EvidenceRef;
  externalAnchors: ExternalEvidenceAnchorRecord[];
}

const GROUPS: Record<RequirementGroup, { title: string; legalRefs: string[] }> = {
  annex_iv: {
    title: 'Annex IV technical documentation',
    legalRefs: ['Article 11', 'Annex IV'],
  },
  quality_management: {
    title: 'Provider quality-management system',
    legalRefs: ['Article 17'],
  },
  lifecycle: {
    title: 'Lifecycle, deployer and transparency obligations',
    legalRefs: ['Articles 5, 9-15, 19-21, 26-27, 50, 72-73'],
  },
  conformity_assessment: {
    title: 'Conformity assessment, declaration and registration',
    legalRefs: ['Articles 43, 47-49'],
  },
};

const requirement = (
  groupId: RequirementGroup,
  requirementId: string,
  legalRefs: string[],
  title: string,
  description: string,
  expectedEvidence: string[],
  incompleteFinding: string,
  options: Partial<Pick<RequirementDefinition, 'applicability' | 'ownerRole' | 'controlIds' | 'foundation' | 'maximumStateFromFoundation'>> = {},
): RequirementDefinition => ({
  groupId,
  requirementId,
  legalRefs,
  title,
  description,
  expectedEvidence,
  incompleteFinding,
  applicability: options.applicability ?? 'high_risk',
  ownerRole: options.ownerRole ?? 'provider',
  controlIds: options.controlIds ?? [],
  foundation: options.foundation ?? [],
  maximumStateFromFoundation: options.maximumStateFromFoundation,
});

/**
 * The matrix mirrors the auditable document families required by Annex IV and
 * Article 17. It deliberately asks for artifacts instead of inferring legal
 * compliance from a platform feature or a successful run.
 */
const REQUIREMENTS: RequirementDefinition[] = [
  requirement('annex_iv', 'AIA-ANNEX-IV-1', ['Annex IV(1)'], 'General system description and instructions',
    'Identity, provider, intended purpose, system version, interactions, hardware/software requirements, marketed forms, user interface and instructions for use.',
    ['System description', 'Provider identity', 'Version inventory', 'Interface description', 'Instructions for use'],
    'The immutable revision proves identity and intended purpose, but separate interface, marketed-form and instructions-for-use artifacts are still required.',
    { foundation: ['revision'], maximumStateFromFoundation: 'partial' }),
  requirement('annex_iv', 'AIA-ANNEX-IV-2', ['Annex IV(2)', 'Article 10', 'Article 15'], 'Development process, architecture, data and design rationale',
    'Development methods, system architecture, algorithms, design choices, assumptions, target groups, data provenance and preparation, component resources and expected outputs.',
    ['Architecture document', 'Design rationale', 'Algorithm/model description', 'Dataset provenance', 'Data-preparation record'],
    'Pinned components provide an inventory, but design rationale, architecture detail and dataset provenance are not fully represented as verified artifacts.',
    { foundation: ['revision'], controlIds: ['AIA-ART15-ROBUSTNESS-SECURITY'], maximumStateFromFoundation: 'partial' }),
  requirement('annex_iv', 'AIA-ANNEX-IV-3', ['Annex IV(3)', 'Article 12', 'Article 14'], 'Monitoring, functioning and human control',
    'Technical measures for monitoring, logging, interpretation, human oversight and control of the system in operation.',
    ['Monitoring design', 'Logging specification', 'Human-oversight plan', 'Stop/intervention test'],
    'Runtime evidence exists, but the monitoring and oversight design is not completely evidenced for this exact revision.',
    { foundation: ['runtime'], controlIds: ['AIA-ART12-RECORD-KEEPING', 'AIA-ART14-HUMAN-OVERSIGHT'] }),
  requirement('annex_iv', 'AIA-ANNEX-IV-4', ['Annex IV(4)', 'Article 15'], 'Performance metrics, validation and test results',
    'Appropriateness of performance metrics, declared thresholds and reproducible accuracy, robustness, cybersecurity and discriminatory-impact test results.',
    ['Evaluation plan', 'Metric definitions', 'Acceptance thresholds', 'Validation results', 'Security and robustness results'],
    'No complete, revision-specific set of declared metrics, thresholds and test results is evidenced.',
    { controlIds: ['AIA-ART15-ROBUSTNESS-SECURITY'] }),
  requirement('annex_iv', 'AIA-ANNEX-IV-5', ['Annex IV(5)', 'Article 9'], 'Lifecycle risk-management system',
    'Risk identification, estimation, evaluation, treatment, residual-risk acceptance, testing and continuous reassessment for the intended purpose.',
    ['Risk register', 'Risk treatment plan', 'Residual-risk decision', 'Risk test evidence'],
    'The lifecycle risk-management evidence is missing, incomplete or expired.',
    { controlIds: ['AIA-ART9-RISK-MANAGEMENT'] }),
  requirement('annex_iv', 'AIA-ANNEX-IV-6', ['Annex IV(6)'], 'Lifecycle changes and substantial-change assessment',
    'Changes made throughout the lifecycle, their rationale, affected components and the determination whether each change is substantial.',
    ['Version history', 'Change rationale', 'Impact assessment', 'Substantial-change decision'],
    'The revision and release are traceable, but a complete lifecycle change history and substantial-change assessment are not separately evidenced.',
    { foundation: ['revision', 'release'], maximumStateFromFoundation: 'partial' }),
  requirement('annex_iv', 'AIA-ANNEX-IV-7', ['Annex IV(7)', 'Articles 40-42'], 'Standards and common specifications',
    'Harmonised standards, common specifications or alternative technical solutions applied, including the evidence supporting equivalence.',
    ['Standards applicability register', 'Implementation statement', 'Deviation/equivalence assessment'],
    'No revision-bound standards applicability and implementation statement is evidenced.'),
  requirement('annex_iv', 'AIA-ANNEX-IV-8', ['Annex IV(8)', 'Article 47'], 'EU declaration of conformity',
    'A signed EU declaration of conformity for the exact system revision where the conformity route requires it.',
    ['Signed EU declaration of conformity'],
    'No signed EU declaration of conformity is attached to this revision.',
    { ownerRole: 'external_assessor' }),
  requirement('annex_iv', 'AIA-ANNEX-IV-9', ['Annex IV(9)', 'Article 72'], 'Post-market monitoring plan',
    'A proportionate plan for proactive collection, documentation and analysis of performance, drift, feedback, incidents and corrective actions.',
    ['Post-market monitoring plan', 'Metric and drift reviews', 'Feedback process', 'Corrective-action records'],
    'The post-market monitoring plan or its revision-specific evidence is missing, incomplete or expired.',
    { controlIds: ['AIA-ART72-POST-MARKET'] }),

  requirement('quality_management', 'AIA-QMS-17-A', ['Article 17(1)(a)'], 'Regulatory compliance and change-management strategy',
    'Written strategy for regulatory conformity, conformity assessment and management of system changes.',
    ['Compliance policy', 'Change-management procedure', 'Regulatory applicability register'],
    'A complete written compliance and change-management strategy is not evidenced.',
    { foundation: ['revision'], maximumStateFromFoundation: 'partial' }),
  requirement('quality_management', 'AIA-QMS-17-B', ['Article 17(1)(b)'], 'Design control and verification',
    'Documented techniques and systematic actions for design control and design verification.',
    ['Design-control procedure', 'Architecture review', 'Verification record'],
    'Design control is not fully evidenced for the released revision.',
    { foundation: ['revision'], controlIds: ['AIA-ART15-ROBUSTNESS-SECURITY'] }),
  requirement('quality_management', 'AIA-QMS-17-C', ['Article 17(1)(c)'], 'Development, quality control and assurance',
    'Documented development, quality-control and quality-assurance procedures.',
    ['Development procedure', 'Quality plan', 'Release quality record'],
    'Development and quality-assurance procedures are not fully evidenced.',
    { controlIds: ['AIA-ART15-ROBUSTNESS-SECURITY'] }),
  requirement('quality_management', 'AIA-QMS-17-D', ['Article 17(1)(d)'], 'Examination, test and validation',
    'Documented examination, test and validation procedures, including their frequency.',
    ['Test strategy', 'Validation protocol', 'Test frequency', 'Test results'],
    'Examination, validation frequency or results are not fully evidenced.',
    { controlIds: ['AIA-ART15-ROBUSTNESS-SECURITY'] }),
  requirement('quality_management', 'AIA-QMS-17-E', ['Article 17(1)(e)'], 'Technical specifications and standards',
    'Technical specifications and standards applied, and the approach used where standards are not applied in full.',
    ['Technical specification register', 'Standards register', 'Deviation rationale'],
    'No complete technical-specification and standards register is evidenced.'),
  requirement('quality_management', 'AIA-QMS-17-F', ['Article 17(1)(f)', 'Article 10'], 'Data-management systems and procedures',
    'Procedures for acquisition, collection, analysis, labelling, storage, filtering, aggregation, retention and other data operations.',
    ['Data governance policy', 'Dataset register', 'Provenance record', 'Bias assessment', 'Retention procedure'],
    'Data categories are registered, but the full data-governance procedure and dataset evidence are not present.',
    { foundation: ['revision'], maximumStateFromFoundation: 'partial' }),
  requirement('quality_management', 'AIA-QMS-17-G', ['Article 17(1)(g)', 'Article 9'], 'Risk-management system',
    'Documented and continuously operated risk-management process.',
    ['Risk-management procedure', 'Risk register', 'Treatment and acceptance evidence'],
    'The risk-management system is missing, incomplete or expired.',
    { controlIds: ['AIA-ART9-RISK-MANAGEMENT'] }),
  requirement('quality_management', 'AIA-QMS-17-H', ['Article 17(1)(h)', 'Article 72'], 'Post-market monitoring system',
    'Documented establishment, implementation and maintenance of post-market monitoring.',
    ['Post-market procedure', 'Monitoring plan', 'Review evidence'],
    'The post-market monitoring system is missing, incomplete or expired.',
    { controlIds: ['AIA-ART72-POST-MARKET'] }),
  requirement('quality_management', 'AIA-QMS-17-I', ['Article 17(1)(i)', 'Article 73'], 'Serious-incident reporting',
    'Procedures for identifying, assessing, escalating and reporting serious incidents.',
    ['Incident policy', 'Reportability decision tree', 'Notification evidence', 'Corrective action'],
    'The serious-incident process is missing, incomplete or expired.',
    { controlIds: ['AIA-ART73-SERIOUS-INCIDENTS'] }),
  requirement('quality_management', 'AIA-QMS-17-J', ['Article 17(1)(j)', 'Articles 20-21'], 'Communications with authorities and operators',
    'Procedures for communications with authorities, notified bodies, customers and other operators.',
    ['Regulatory communication procedure', 'Contact register', 'Notification record'],
    'A complete regulatory and customer communication procedure is not evidenced.',
    { controlIds: ['AIA-ART73-SERIOUS-INCIDENTS'], maximumStateFromFoundation: 'partial' }),
  requirement('quality_management', 'AIA-QMS-17-K', ['Article 17(1)(k)', 'Articles 12, 18-19'], 'Document and record keeping',
    'Policies and procedures for controlled documentation and retention of automatically generated logs.',
    ['Document-control policy', 'Retention policy', 'Signed logs', 'Legal-hold evidence'],
    'Record-keeping evidence is missing, incomplete or expired.',
    { foundation: ['runtime'], controlIds: ['AIA-ART12-RECORD-KEEPING'] }),
  requirement('quality_management', 'AIA-QMS-17-L', ['Article 17(1)(l)'], 'Resources and security of supply',
    'Resource management, supplier controls, operational resilience and security of supply.',
    ['Resource plan', 'Supplier register', 'Business-continuity test', 'Security-of-supply assessment'],
    'Resource, supplier and continuity evidence is not fully represented.',
    { controlIds: ['AIA-ART15-ROBUSTNESS-SECURITY'], maximumStateFromFoundation: 'partial' }),
  requirement('quality_management', 'AIA-QMS-17-M', ['Article 17(1)(m)'], 'Accountability framework',
    'Named management and staff responsibilities for every part of the quality-management system.',
    ['RACI/accountability matrix', 'Role assignments', 'Competence and training records'],
    'Market roles and reviewers are recorded, but a complete QMS accountability and competence matrix is not evidenced.',
    { foundation: ['revision', 'release'], maximumStateFromFoundation: 'partial' }),

  requirement('lifecycle', 'AIA-LIFECYCLE-ART5', ['Article 5'], 'Prohibited-practice screening',
    'The intended and foreseeable use is screened and prohibited systems fail closed.',
    ['Classification assessment', 'Prohibited-practice review', 'Policy gate'],
    'Prohibited-practice screening is missing, incomplete or expired.',
    { applicability: 'always', controlIds: ['AIA-ART5-PROHIBITED-PRACTICES'], foundation: ['revision'] }),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART10', ['Article 10'], 'Data quality and governance',
    'Training, validation and testing data are governed for relevance, representativeness, errors, completeness, bias and context of use.',
    ['Dataset register', 'Data-quality assessment', 'Bias assessment', 'Data-gap treatment'],
    'The current control catalog has no complete revision-bound Article 10 evidence decision.'),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART12-19', ['Articles 12, 19'], 'Automatic logging and retention',
    'Automatic logs support traceability throughout the system lifecycle and are retained for the applicable period.',
    ['Automatic logs', 'Signed checkpoint', 'Retention decision', 'Restore evidence'],
    'Automatic logging or retention evidence is missing, incomplete or expired.',
    { foundation: ['runtime'], controlIds: ['AIA-ART12-RECORD-KEEPING'] }),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART13', ['Article 13'], 'Transparency and deployer instructions',
    'Deployers receive understandable instructions covering capabilities, limitations, performance, oversight and maintenance.',
    ['Instructions for use', 'Capabilities and limitations', 'Maintenance and oversight guidance'],
    'No complete revision-bound deployer instructions artifact is evidenced.'),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART14', ['Article 14'], 'Effective human oversight',
    'Assigned, competent humans can understand, monitor, intervene, override and stop the system.',
    ['Oversight plan', 'Approval evidence', 'Training record', 'Stop test'],
    'Human-oversight evidence is missing, incomplete or expired.',
    { controlIds: ['AIA-ART14-HUMAN-OVERSIGHT'] }),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART15', ['Article 15'], 'Accuracy, robustness and cybersecurity',
    'Declared accuracy and resilience thresholds are tested and maintained throughout the lifecycle.',
    ['Evaluation', 'Robustness test', 'Security scan', 'Red-team result'],
    'Accuracy, robustness or cybersecurity evidence is missing, incomplete or expired.',
    { controlIds: ['AIA-ART15-ROBUSTNESS-SECURITY'] }),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART20-21', ['Articles 20-21'], 'Corrective action and authority cooperation',
    'Non-conformity is investigated and corrected, relevant operators are informed and competent authorities can receive necessary evidence.',
    ['Corrective-action procedure', 'Operator notification', 'Authority cooperation procedure'],
    'Corrective-action and authority-cooperation evidence is not complete.',
    { controlIds: ['AIA-ART73-SERIOUS-INCIDENTS'], maximumStateFromFoundation: 'partial' }),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART26-27', ['Articles 26-27'], 'Deployer obligations and fundamental-rights impact assessment',
    'Applicable deployer monitoring, log retention, worker information and fundamental-rights impact assessment obligations are documented.',
    ['Deployer operating procedure', 'Fundamental-rights impact assessment', 'Affected-person information'],
    'Deployer obligations and any required fundamental-rights impact assessment are not evidenced.',
    { ownerRole: 'deployer' }),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART50', ['Article 50'], 'AI interaction and generated-content transparency',
    'Applicable users and recipients receive accessible, versioned AI interaction or generated-content notices.',
    ['Transparency notice', 'Channel configuration', 'Publication event'],
    'Transparency applicability or publication evidence is missing, incomplete or expired.',
    { applicability: 'conditional', ownerRole: 'deployer', controlIds: ['AIA-ART50-TRANSPARENCY'] }),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART72', ['Article 72'], 'Post-market monitoring operation',
    'Performance, drift, feedback and compliance signals are reviewed and lead to corrective action.',
    ['Monitoring plan', 'Metric review', 'Drift review', 'Corrective action'],
    'Post-market monitoring evidence is missing, incomplete or expired.',
    { controlIds: ['AIA-ART72-POST-MARKET'] }),
  requirement('lifecycle', 'AIA-LIFECYCLE-ART73', ['Article 73'], 'Serious-incident handling',
    'Incidents preserve causality, reportability decisions, notification deadlines and corrective action.',
    ['Incident record', 'Causality assessment', 'Notification', 'Corrective action'],
    'Serious-incident handling evidence is missing, incomplete or expired.',
    { controlIds: ['AIA-ART73-SERIOUS-INCIDENTS'] }),

  requirement('conformity_assessment', 'AIA-CONFORMITY-ART43', ['Article 43'], 'Conformity-assessment procedure',
    'The applicable conformity route and any notified-body involvement are documented for the exact revision.',
    ['Conformity route decision', 'Assessment result', 'Notified-body certificate where applicable'],
    'No completed revision-bound conformity-assessment procedure is evidenced.',
    { ownerRole: 'external_assessor' }),
  requirement('conformity_assessment', 'AIA-CONFORMITY-ART47', ['Article 47'], 'EU declaration of conformity',
    'The provider has issued and signed the required EU declaration of conformity.',
    ['Signed EU declaration of conformity'],
    'No signed EU declaration of conformity is evidenced.',
    { ownerRole: 'provider' }),
  requirement('conformity_assessment', 'AIA-CONFORMITY-ART48', ['Article 48'], 'CE marking',
    'Where applicable, CE marking is affixed visibly, legibly and indelibly or digitally accessible.',
    ['CE marking evidence'],
    'No CE-marking evidence is attached.',
    { ownerRole: 'provider' }),
  requirement('conformity_assessment', 'AIA-CONFORMITY-ART49', ['Article 49'], 'EU database registration',
    'Required provider and system registration is completed before placement on the market or putting into service.',
    ['EU database registration receipt'],
    'No EU database registration receipt is attached.',
    { ownerRole: 'provider' }),
];

function digest(value: unknown): string {
  return createHash('sha256')
    .update(stableAuditJson(JSON.parse(JSON.stringify(value)) as AuditJsonValue), 'utf8')
    .digest('hex');
}

function uniqueEvidence(values: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = `${value.evidenceType}\0${value.evidenceId}\0${value.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function controlEvidence(control: AiSystemControlProjection): EvidenceRef[] {
  if (!control.assessment) return [];
  return uniqueEvidence([
    {
      evidenceType: 'document',
      evidenceId: control.assessment.assessmentId,
      sha256: control.assessment.assessmentSha256,
    },
    ...(control.assessment.evidence ?? []),
  ]);
}

function foundationEvidence(definition: RequirementDefinition, input: AiComplianceDossierMatrixInput): EvidenceRef[] {
  const values: EvidenceRef[] = [];
  if (definition.foundation?.includes('revision')) values.push({
    evidenceType: 'document', evidenceId: input.revision.revisionId, sha256: input.revision.revisionSha256,
  });
  if (definition.foundation?.includes('release')) values.push(input.releaseDecision);
  if (definition.foundation?.includes('runtime')) values.push(input.sourceReport, input.sourceEvidencePack);
  if (definition.foundation?.includes('external_anchor')) values.push(...input.externalAnchors
    .filter(anchor => anchor.verification === 'verified')
    .map(anchor => ({ evidenceType: 'external_anchor' as const, evidenceId: anchor.anchorId, sha256: anchor.receiptSha256 })));
  return values;
}

function controlState(control: AiSystemControlProjection): RequirementState {
  if (control.expired) return 'expired';
  if (control.effectiveStatus === 'satisfied') return 'satisfied';
  if (control.effectiveStatus === 'not_applicable' && control.definition.applicability === 'conditional') return 'not_applicable';
  if (control.assessment) return 'partial';
  return 'missing';
}

function requirementFields(definition: RequirementDefinition) {
  return {
    requirementId: definition.requirementId,
    legalRefs: definition.legalRefs,
    title: definition.title,
    description: definition.description,
    applicability: definition.applicability,
    ownerRole: definition.ownerRole,
    expectedEvidence: definition.expectedEvidence,
    controlIds: definition.controlIds ?? [],
  };
}

function buildRequirement(definition: RequirementDefinition, input: AiComplianceDossierMatrixInput): AiActComplianceRequirement {
  const highRisk = input.revision.classification.classification === 'high_risk';
  if (definition.applicability === 'high_risk' && !highRisk) return {
    ...requirementFields(definition),
    evidence: [],
    findings: [],
    state: 'not_applicable',
    assessedAt: input.generatedAt,
    nextReviewAt: null,
  };

  const controls = (definition.controlIds ?? [])
    .map(controlId => input.controlLedger.controls.find(control => control.definition.controlId === controlId))
    .filter((control): control is AiSystemControlProjection => Boolean(control));
  if (definition.applicability === 'conditional' && controls.length > 0
    && controls.every(control => controlState(control) === 'not_applicable')) return {
    ...requirementFields(definition),
    evidence: uniqueEvidence(controls.flatMap(controlEvidence)),
    findings: [],
    state: 'not_applicable',
    assessedAt: input.generatedAt,
    nextReviewAt: null,
  };

  const evidence = uniqueEvidence([
    ...foundationEvidence(definition, input),
    ...controls.flatMap(controlEvidence),
  ]);
  const states = controls.map(controlState);
  let state: RequirementState;
  if (states.includes('expired')) state = 'expired';
  else if (controls.length > 0 && states.every(value => value === 'satisfied')) state = 'satisfied';
  else if (evidence.length > 0) state = 'partial';
  else state = 'missing';
  if (definition.maximumStateFromFoundation === 'partial' && state === 'satisfied') state = 'partial';
  const dates = controls.flatMap(control => [control.assessment?.dueAt, control.assessment?.reassessmentAt])
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    ...requirementFields(definition),
    evidence,
    findings: state === 'satisfied' ? [] : [definition.incompleteFinding],
    state,
    assessedAt: input.generatedAt,
    nextReviewAt: dates[0] ?? null,
  };
}

function coverage(requirements: AiActComplianceRequirement[]): AiActComplianceMatrix['coverage'] {
  const count = (state: RequirementState): number => requirements.filter(item => item.state === state).length;
  return {
    applicable: requirements.length - count('not_applicable'),
    satisfied: count('satisfied'),
    partial: count('partial'),
    missing: count('missing'),
    expired: count('expired'),
    notApplicable: count('not_applicable'),
  };
}

export function buildAiComplianceDossierMatrix(input: AiComplianceDossierMatrixInput): AiActComplianceMatrix {
  const grouped = (Object.keys(GROUPS) as RequirementGroup[]).map(groupId => {
    const requirements = REQUIREMENTS.filter(definition => definition.groupId === groupId)
      .map(definition => buildRequirement(definition, input));
    return { groupId, ...GROUPS[groupId], coverage: coverage(requirements), requirements };
  });
  const all = grouped.flatMap(group => group.requirements);
  const unsigned = {
    schemaVersion: AI_COMPLIANCE_DOSSIER_VERSION,
    kind: 'argus.ai-compliance-obligation-matrix' as const,
    legalBaseline: {
      regulation: 'Regulation (EU) 2024/1689' as const,
      officialJournalUrl: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
      annexIvUrl: 'https://ai-act-service-desk.ec.europa.eu/en/ai-act/annex-4',
      qualityManagementUrl: 'https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-17',
      assessedAt: input.generatedAt,
      legalReviewRequired: true as const,
      applicabilityRationale: input.revision.classification.classification === 'high_risk'
        ? 'The released revision is classified as high-risk; high-risk technical documentation, quality-management and conformity-assessment requirements are included as applicable.'
        : `The released revision is classified as ${input.revision.classification.classification}; high-risk-only requirements are recorded as not applicable, while always and conditionally applicable obligations remain assessed.`,
    },
    coverage: coverage(all),
    groups: grouped,
  };
  return aiActComplianceDossierManifestV2Schema.shape.complianceMatrix.parse({
    ...unsigned,
    matrixSha256: digest(unsigned),
  });
}

export function complianceMatrixGaps(matrix: AiActComplianceMatrix): Array<{
  gapId: string;
  severity: 'medium' | 'high' | 'critical';
  description: string;
  ownerRole: RequirementOwner;
  dueAt: string | null;
}> {
  return matrix.groups.flatMap(group => group.requirements
    .filter(requirement => requirement.state === 'partial' || requirement.state === 'missing' || requirement.state === 'expired')
    .map(requirement => ({
      gapId: `requirement-${requirement.requirementId}`.slice(0, 120),
      severity: requirement.state === 'expired'
        ? 'critical' as const
        : requirement.state === 'missing'
          ? 'high' as const
          : 'medium' as const,
      description: `${requirement.legalRefs.join(', ')} ${requirement.title}: ${requirement.findings.join(' ')}`,
      ownerRole: requirement.ownerRole,
      dueAt: requirement.nextReviewAt,
    })));
}
