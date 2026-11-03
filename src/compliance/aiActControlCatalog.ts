import { createHash } from 'node:crypto';
import { stableAuditJson, type AuditJsonValue } from '../audit/canonicalAuditRedaction.js';
import { aiActControlCatalogSchema, type AiActControlCatalog } from './aiActContracts.js';

const responsibilities = (
  platform: string,
  customerParty: 'provider' | 'deployer',
  customer: string,
): AiActControlCatalog['controls'][number]['responsibilities'] => [
  { party: 'argus_platform', responsibility: platform, required: true },
  { party: customerParty, responsibility: customer, required: true },
];

const catalogWithoutDigest = {
  schemaVersion: 1 as const,
  kind: 'ai-act-control-catalog' as const,
  catalogId: 'eu-ai-act-2024-1689-core',
  catalogVersion: 1,
  effectiveFrom: '2024-08-01T00:00:00.000Z',
  legalSource: {
    regulation: 'Regulation (EU) 2024/1689' as const,
    title: 'European Union Artificial Intelligence Act',
    url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  claimBoundary: 'Coverage records technical, documentary and organisational evidence for a pinned AI-system revision. It is not an automatic legal conformity decision or certification.',
  controls: [
    {
      controlId: 'AIA-ART5-PROHIBITED-PRACTICES', articleRefs: ['Article 5'], title: 'Prohibited-practice screening',
      description: 'A released system must have a reviewed intended-purpose screening and must fail closed when a prohibited practice is identified.',
      applicability: 'always' as const, enforcement: 'hybrid' as const, blocksProduction: true,
      evidenceKinds: ['classification_assessment', 'review_decision', 'policy_gate'],
      responsibilities: responsibilities('Enforce versioned screening and block prohibited releases.', 'provider', 'Describe and legally assess intended and foreseeable use.'),
      customerInputs: ['Intended purpose', 'Foreseeable misuse', 'Legal review owner'],
    },
    {
      controlId: 'AIA-ART9-RISK-MANAGEMENT', articleRefs: ['Article 9'], title: 'Lifecycle risk management',
      description: 'Risks, treatments, residual risks, tests and approvals remain versioned throughout the system lifecycle.',
      applicability: 'high_risk' as const, enforcement: 'hybrid' as const, blocksProduction: true,
      evidenceKinds: ['risk_register', 'treatment', 'evaluation', 'risk_acceptance'],
      responsibilities: responsibilities('Version and enforce risk-control and reassessment gates.', 'provider', 'Own system risks, treatments and residual-risk decisions.'),
      customerInputs: ['Domain risks', 'Acceptance thresholds', 'Risk owner'],
    },
    {
      controlId: 'AIA-ART12-RECORD-KEEPING', articleRefs: ['Article 12', 'Article 19'], title: 'Traceable automatic record keeping',
      description: 'Production activity is correlated to the exact system, control, model, policy, tool and oversight revision.',
      applicability: 'high_risk' as const, enforcement: 'technical' as const, blocksProduction: true,
      evidenceKinds: ['canonical_event', 'run', 'trace', 'signed_checkpoint'],
      responsibilities: responsibilities('Produce tamper-evident bounded logs and offline-verifiable exports.', 'provider', 'Choose lawful retention and ensure relevant paths use governed execution.'),
      customerInputs: ['Retention purpose', 'Region', 'Legal-hold policy'],
    },
    {
      controlId: 'AIA-ART14-HUMAN-OVERSIGHT', articleRefs: ['Article 14'], title: 'Effective human oversight',
      description: 'Competent operators can understand, intervene, stop and review the system through enforced approval and suspension controls.',
      applicability: 'high_risk' as const, enforcement: 'hybrid' as const, blocksProduction: true,
      evidenceKinds: ['oversight_plan', 'approval', 'training_record', 'stop_test'],
      responsibilities: responsibilities('Provide enforceable approval, stop, replay-protection and audit mechanisms.', 'deployer', 'Assign competent operators and operate the oversight process.'),
      customerInputs: ['Oversight roles', 'Escalation path', 'Training evidence'],
    },
    {
      controlId: 'AIA-ART15-ROBUSTNESS-SECURITY', articleRefs: ['Article 15'], title: 'Accuracy, robustness and cybersecurity',
      description: 'Version-specific evaluation and security thresholds gate release and substantial changes.',
      applicability: 'high_risk' as const, enforcement: 'hybrid' as const, blocksProduction: true,
      evidenceKinds: ['evaluation', 'security_scan', 'red_team_result', 'release_gate'],
      responsibilities: responsibilities('Run and preserve reproducible evaluation and security gates.', 'provider', 'Define use-case thresholds and remediate failures.'),
      customerInputs: ['Accuracy threshold', 'Robustness scenarios', 'Security acceptance'],
    },
    {
      controlId: 'AIA-ART50-TRANSPARENCY', articleRefs: ['Article 50'], title: 'AI interaction and generated-content transparency',
      description: 'Applicable channels expose an accessible, versioned notice and preserve publication evidence.',
      applicability: 'conditional' as const, enforcement: 'hybrid' as const, blocksProduction: true,
      evidenceKinds: ['transparency_notice', 'channel_configuration', 'publication_event'],
      responsibilities: responsibilities('Render and audit configured notices and metadata.', 'deployer', 'Determine the publication context and provide approved language.'),
      customerInputs: ['Channel', 'Audience', 'Approved notice text'],
    },
    {
      controlId: 'AIA-ART72-POST-MARKET', articleRefs: ['Article 72'], title: 'Post-market monitoring',
      description: 'An active monitoring plan gathers and reviews performance, feedback, drift and compliance signals for the released system.',
      applicability: 'high_risk' as const, enforcement: 'hybrid' as const, blocksProduction: true,
      evidenceKinds: ['monitoring_plan', 'metric', 'drift_review', 'corrective_action'],
      responsibilities: responsibilities('Collect bounded evidence, schedule reviews and surface drift.', 'provider', 'Own, review and act on the post-market monitoring plan.'),
      customerInputs: ['Monitoring KPIs', 'Thresholds', 'Review cadence'],
    },
    {
      controlId: 'AIA-ART73-SERIOUS-INCIDENTS', articleRefs: ['Article 73'], title: 'Serious-incident handling',
      description: 'Incidents preserve causality, deadlines, notifications and corrective-action evidence without making an automatic legal reporting decision.',
      applicability: 'high_risk' as const, enforcement: 'hybrid' as const, blocksProduction: false,
      evidenceKinds: ['incident', 'causality_assessment', 'notification', 'corrective_action'],
      responsibilities: responsibilities('Provide a deadline-aware, immutable incident and CAPA workflow.', 'provider', 'Decide reportability and submit to the correct authority within the applicable deadline.'),
      customerInputs: ['Regulatory contact', 'Severity decision', 'Notification reference'],
    },
  ],
};

const catalogSha256 = createHash('sha256')
  .update(stableAuditJson(JSON.parse(JSON.stringify(catalogWithoutDigest)) as AuditJsonValue), 'utf8')
  .digest('hex');

export const AI_ACT_CONTROL_CATALOG = aiActControlCatalogSchema.parse({
  ...catalogWithoutDigest,
  catalogSha256,
});

export function getAiActControlCatalog(): AiActControlCatalog {
  return AI_ACT_CONTROL_CATALOG;
}

export function findAiActControl(controlId: string): AiActControlCatalog['controls'][number] | null {
  return AI_ACT_CONTROL_CATALOG.controls.find(control => control.controlId === controlId) ?? null;
}

export function matchesAiActControlCatalogPin(pin: { catalogId: string; catalogVersion: number; catalogSha256: string }): boolean {
  return pin.catalogId === AI_ACT_CONTROL_CATALOG.catalogId
    && pin.catalogVersion === AI_ACT_CONTROL_CATALOG.catalogVersion
    && pin.catalogSha256 === AI_ACT_CONTROL_CATALOG.catalogSha256;
}
