import { createHash, randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import type pg from 'pg';
import type { AuditEvidencePackV1 } from '../audit/evidencePack.js';
import { verifyAuditEvidencePack } from '../audit/evidencePack.js';
import { stableAuditJson, type AuditJsonValue } from '../audit/canonicalAuditRedaction.js';
import { appendCanonicalAuditEvent, executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary, CanonicalAuditScope } from '../audit/canonicalAuditTypes.js';
import type { AuditReportSummary } from '../audit/reportTypes.js';
import { externalAnchorForDossier, listExternalEvidenceAnchors, type ExternalEvidenceAnchorRecord } from '../audit/externalAnchorService.js';
import {
  AI_COMPLIANCE_DOSSIER_VERSION,
  aiActComplianceDossierManifestSchema,
  aiActSystemRevisionSchema,
  type AiActComplianceMatrix,
  type AiActComplianceDossierGenerationInput,
  type AiActComplianceDossierManifest,
  type AiActRegistrationReadiness,
  type AiActSystemRevision,
} from './aiActContracts.js';
import { buildAiComplianceDossierMatrix, complianceMatrixGaps } from './aiComplianceDossierMatrix.js';
import { AiSystemRegistryError } from './aiSystemRegistry.js';
import { evaluateAiSystemRegistrationReadiness } from './aiSystemReadiness.js';
import { getAiSystemControlLedger, type AiSystemControlLedger } from './aiSystemControlLedger.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AiComplianceDossierContext {
  scope: CanonicalAuditScope;
  actor: CanonicalAuditActor;
  producerEventId: string;
  requestId?: string | null;
  now?: () => Date;
  uuid?: () => string;
}

export interface AiComplianceDossierEvidenceV1 {
  schemaVersion: 1;
  kind: 'argus.ai-compliance-dossier-evidence';
  dossierId: string;
  generatedAt: string;
  aiSystemRevision: AiActSystemRevision;
  registrationReadiness: AiActRegistrationReadiness;
  legalControlLedger: AiSystemControlLedger;
  sourceReport: {
    reportRunId: string;
    reportType: string;
    name: string;
    periodFrom: string;
    periodTo: string;
    summary: AuditReportSummary;
  };
  releaseDecision: {
    decisionId: string;
    auditEventId: string;
    auditEventSha256: string;
  };
  externalAnchorReceipts: ExternalEvidenceAnchorRecord[];
  sourceEvidencePack: AuditEvidencePackV1;
}

export interface AiComplianceDossierEvidenceV2 extends Omit<AiComplianceDossierEvidenceV1, 'schemaVersion'> {
  schemaVersion: 2;
  complianceMatrix: AiActComplianceMatrix;
}

type AiComplianceDossierEvidence = AiComplianceDossierEvidenceV1 | AiComplianceDossierEvidenceV2;

export interface AiComplianceDossier {
  manifest: AiActComplianceDossierManifest;
  sourceReportRunId: string;
  verification: AiComplianceDossierVerification;
}

export interface AiComplianceDossierVerification {
  state: 'valid' | 'invalid';
  reasons: string[];
  sourceEvidencePackState: 'valid' | 'invalid';
}

export type AiComplianceDossierArtifactFormat = 'manifest' | 'json' | 'pdf' | 'signature';

interface SourceReportRow {
  id: string;
  report_type: string;
  name_snapshot: string;
  period_from: Date | string;
  period_to: Date | string;
  pack_id: string;
  pack_digest: string;
  summary: AuditReportSummary;
  evidence_pack: AuditEvidencePackV1;
}

interface ReleaseDecisionRow {
  decision_id: string;
  decision_json: Record<string, unknown>;
  event_id: string;
  event_hash: string;
}

interface DossierRow {
  dossier_id: string;
  source_report_run_id: string;
  source_pack_digest: string;
  manifest_json: AiActComplianceDossierManifest;
  evidence_json_artifact: Buffer | Uint8Array;
  pdf_artifact: Buffer | Uint8Array;
  checkpoint_signature: Buffer | Uint8Array;
}

interface FrozenDossier {
  manifest: AiActComplianceDossierManifest;
  evidenceJson: Buffer;
  pdf: Buffer;
  signature: Buffer;
  sourceEvidencePack: AuditEvidencePackV1;
  sourceReportRunId: string;
}

function normalizedScope(context: AiComplianceDossierContext): Required<CanonicalAuditScope> {
  const field = (value: string | undefined, name: string, fallback?: string): string => {
    const normalized = value?.trim() || fallback || '';
    if (!normalized || !IDENTIFIER.test(normalized)) throw new AiSystemRegistryError(`${name} is invalid`);
    return normalized;
  };
  return {
    workspaceKey: field(context.scope.workspaceKey, 'workspaceKey', 'default'),
    tenantKey: field(context.scope.tenantKey, 'tenantKey', 'default'),
    environment: field(context.scope.environment, 'environment'),
  };
}

function generatedBy(context: AiComplianceDossierContext): AiActComplianceDossierManifest['generatedBy'] {
  if (context.actor.type !== 'human' || context.actor.authMethod !== 'oidc' || !context.actor.ssoSubject) {
    throw new AiSystemRegistryError(
      'Compliance dossier generation requires a verified OIDC/Entra identity',
      403,
      'AI_DOSSIER_SSO_REQUIRED',
    );
  }
  return { actorType: 'user', actorId: context.actor.id };
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalBuffer(value: unknown): Buffer {
  const json = JSON.parse(JSON.stringify(value)) as AuditJsonValue;
  return Buffer.from(`${stableAuditJson(json)}\n`, 'utf8');
}

function manifestDigest(manifest: AiActComplianceDossierManifest): string {
  const { dossierSha256: _digest, ...unsigned } = manifest;
  return sha256(stableAuditJson(unsigned as unknown as AuditJsonValue));
}

function collectPdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

async function dossierPdf(
  dossierId: string,
  revision: AiActSystemRevision,
  report: SourceReportRow,
  readiness: AiActRegistrationReadiness,
  controlLedger: AiSystemControlLedger,
  gaps: AiActComplianceDossierManifest['declaredGaps'],
  complianceMatrix: AiActComplianceMatrix,
  generatedAt: string,
): Promise<Buffer> {
  const timestamp = new Date(generatedAt);
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: {
      Title: `AI compliance dossier - ${revision.displayName}`,
      Author: 'Argus AI Governance',
      Subject: `Evidence dossier ${dossierId}`,
      Producer: 'Argus AI compliance dossier builder',
      CreationDate: timestamp,
      ModDate: timestamp,
    },
  });
  const output = collectPdf(doc);
  doc.fillColor('#6956e8').fontSize(10).text('ARGUS · AI COMPLIANCE DOSSIER');
  doc.moveDown(0.6).fillColor('#111827').fontSize(21).text(revision.displayName);
  doc.moveDown(0.25).fillColor('#526173').fontSize(9)
    .text(`Dossier ${dossierId}`)
    .text(`AI system ${revision.aiSystemId} · revision ${revision.revision}`)
    .text(`Revision SHA-256 ${revision.revisionSha256}`)
    .text(`Classification ${revision.classification.classification} · state ${revision.lifecycleState}`)
    .text(`Generated ${generatedAt}`);
  doc.moveDown().fillColor('#111827').fontSize(13).text('Intended purpose');
  doc.moveDown(0.3).fontSize(9).text(revision.intendedPurpose);
  doc.moveDown().fontSize(13).text('Evidence provenance');
  doc.moveDown(0.3).fontSize(9)
    .text(`Source report ${report.id} · ${report.name_snapshot}`)
    .text(`Evidence window ${new Date(report.period_from).toISOString()} — ${new Date(report.period_to).toISOString()}`)
    .text(`Signed evidence pack ${report.pack_id}`)
    .text(`Pack SHA-256 ${report.pack_digest}`)
    .text(`Checkpoint ${report.evidence_pack.checkpoint.checkpointId}`)
    .text(`Checkpoint key ${report.evidence_pack.verificationKey.keyId}`);
  doc.moveDown().fontSize(13).text('Operational readiness');
  doc.moveDown(0.3).fontSize(9)
    .text(`${readiness.evidenceCoverage.satisfied}/${readiness.evidenceCoverage.applicable} registry and evidence steps complete.`);
  for (const step of readiness.steps) doc.text(`${step.status === 'complete' ? '[OK]' : '[OPEN]'} ${step.title}: ${step.status}`);
  doc.moveDown().fontSize(13).text('EU AI Act control ledger');
  doc.moveDown(0.3).fontSize(9)
    .text(`${controlLedger.coverage.satisfied}/${controlLedger.coverage.applicable} applicable article controls satisfied; release ready: ${controlLedger.releaseReady ? 'yes' : 'no'}.`)
    .text(`Catalog ${controlLedger.catalog.catalogId} v${controlLedger.catalog.catalogVersion} · SHA-256 ${controlLedger.catalog.catalogSha256}`);
  for (const control of controlLedger.controls.filter(item => item.applicable)) {
    doc.text(`${control.effectiveStatus === 'satisfied' && !control.expired ? '[OK]' : '[OPEN]'} ${control.definition.articleRefs.join(', ')} ${control.definition.title}: ${control.expired ? 'expired' : control.effectiveStatus}`);
  }
  doc.addPage();
  doc.fillColor('#6956e8').fontSize(10).text('ARGUS · AI COMPLIANCE DOSSIER V2');
  doc.moveDown(0.7).fillColor('#111827').fontSize(16).text('Obligation coverage matrix');
  doc.moveDown(0.3).fillColor('#526173').fontSize(9)
    .text(`Matrix SHA-256 ${complianceMatrix.matrixSha256}`)
    .text(`${complianceMatrix.coverage.satisfied}/${complianceMatrix.coverage.applicable} applicable requirements satisfied · ${complianceMatrix.coverage.partial} partial · ${complianceMatrix.coverage.missing} missing · ${complianceMatrix.coverage.expired} expired · ${complianceMatrix.coverage.notApplicable} not applicable`)
    .text(complianceMatrix.legalBaseline.applicabilityRationale);
  for (const group of complianceMatrix.groups) {
    doc.moveDown().fillColor('#111827').fontSize(12).text(group.title);
    doc.moveDown(0.2).fillColor('#526173').fontSize(8)
      .text(`${group.legalRefs.join(', ')} · ${group.coverage.satisfied}/${group.coverage.applicable} satisfied · ${group.coverage.partial} partial · ${group.coverage.missing} missing`);
    for (const requirement of group.requirements) {
      const marker = requirement.state === 'satisfied' ? '[OK]' : requirement.state === 'not_applicable' ? '[N/A]' : '[OPEN]';
      doc.fillColor(requirement.state === 'satisfied' || requirement.state === 'not_applicable' ? '#245b47' : '#8a4f11')
        .fontSize(8)
        .text(`${marker} ${requirement.requirementId} · ${requirement.legalRefs.join(', ')} · ${requirement.title} · ${requirement.state}`);
      if (requirement.findings.length > 0) doc.fillColor('#526173').fontSize(7).text(`    ${requirement.findings.join(' ')}`);
    }
  }
  doc.moveDown().fontSize(13).text('Declared gaps');
  doc.moveDown(0.3).fontSize(9);
  for (const gap of gaps) doc.text(`- ${gap.severity.toUpperCase()} · ${gap.gapId}: ${gap.description}`);
  doc.moveDown().fillColor('#526173').fontSize(8)
    .text('This dossier packages verified technical and governance evidence for independent review. It is not an automatic EU AI Act conformity declaration. The JSON evidence artifact and signed checkpoint are authoritative; this PDF is a human-readable projection and has not been independently validated as PDF/A.');
  doc.end();
  return output;
}

function releaseReferencesSource(decision: Record<string, unknown>, report: SourceReportRow): boolean {
  const evidence = Array.isArray(decision['evidence']) ? decision['evidence'] : [];
  return evidence.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const ref = item as Record<string, unknown>;
    return ref['sha256'] === report.pack_digest && (
      (ref['evidenceType'] === 'report' && ref['evidenceId'] === report.id)
      || (ref['evidenceType'] === 'evidence_pack' && ref['evidenceId'] === report.pack_id)
    );
  });
}

function sourcePackContainsRelease(pack: AuditEvidencePackV1, release: ReleaseDecisionRow, revision: AiActSystemRevision): boolean {
  return pack.events.some(event => event.eventId === release.event_id
    && event.eventHash === release.event_hash
    && event.action === 'compliance.ai_system.released'
    && event.resource.type === 'ai_system'
    && event.resource.id === revision.aiSystemId
    && event.resource.revision === String(revision.revision));
}

function declaredGaps(
  pack: AuditEvidencePackV1,
  readiness: AiActRegistrationReadiness,
  controlLedger: AiSystemControlLedger,
  externalAnchors: ExternalEvidenceAnchorRecord[],
  complianceMatrix: AiActComplianceMatrix,
): AiActComplianceDossierManifest['declaredGaps'] {
  const gaps: AiActComplianceDossierManifest['declaredGaps'] = [
    ...(!externalAnchors.some(anchor => anchor.anchorKind === 'worm_object') ? [{
      gapId: 'external-worm-anchor-not-configured',
      severity: 'high' as const,
      description: 'The source Evidence Pack has no verified customer-owned WORM receipt.',
      ownerRole: 'provider' as const,
      dueAt: null,
    }] : []),
    ...(!externalAnchors.some(anchor => anchor.anchorKind === 'qualified_timestamp') ? [{
      gapId: 'qualified-timestamp-not-configured',
      severity: 'medium' as const,
      description: 'The source Evidence Pack has no verified qualified timestamp receipt.',
      ownerRole: 'provider' as const,
      dueAt: null,
    }] : []),
    {
      gapId: 'pdfa-validation-not-configured',
      severity: 'medium',
      description: 'The human-readable PDF has not been independently validated as a PDF/A archival artifact.',
      ownerRole: 'argus_platform',
      dueAt: null,
    },
    ...pack.manifest.declaredGaps.map((gap, index) => ({
      gapId: `source-pack-${index + 1}-${gap.code}`.slice(0, 120),
      severity: 'medium' as const,
      description: gap.description,
      ownerRole: 'argus_platform' as const,
      dueAt: null,
    })),
    ...complianceMatrixGaps(complianceMatrix),
  ];
  for (const step of readiness.steps.filter(item => item.status !== 'complete')) {
    gaps.push({
      gapId: `readiness-${step.stepId}`,
      severity: step.blocking ? 'high' : 'medium',
      description: step.issues.join(' ') || `${step.title} is not complete.`,
      ownerRole: 'provider',
      dueAt: null,
    });
  }
  for (const control of controlLedger.controls.filter(item => item.applicable && (item.effectiveStatus !== 'satisfied' || item.expired))) {
    gaps.push({
      gapId: `control-${control.definition.controlId}`.slice(0, 120),
      severity: control.releaseBlocking ? 'critical' : 'high',
      description: `${control.definition.articleRefs.join(', ')} ${control.definition.title}: ${control.issues.join(' ') || control.effectiveStatus}.`,
      ownerRole: control.assessment?.ownerParty ?? control.definition.responsibilities.find(item => item.party !== 'argus_platform')?.party ?? 'provider',
      dueAt: control.assessment?.dueAt ?? control.assessment?.reassessmentAt ?? null,
    });
  }
  return gaps;
}

async function loadReleasedRevision(
  client: pg.PoolClient,
  scope: Required<CanonicalAuditScope>,
  aiSystemId: string,
  input: AiActComplianceDossierGenerationInput,
): Promise<AiActSystemRevision> {
  const result = await client.query<{ revision_json: unknown }>(
    `SELECT revision.revision_json
       FROM mcp_ai_systems system
       JOIN mcp_ai_system_revisions revision ON revision.ai_system_id=system.id
      WHERE system.id=$1 AND system.workspace_key=$2 AND system.tenant_key=$3
        AND revision.revision=$4
      FOR SHARE OF revision`,
    [aiSystemId, scope.workspaceKey, scope.tenantKey, input.expectedRevision],
  );
  if (!result.rows[0]) throw new AiSystemRegistryError('AI-system revision was not found in the authorized scope', 404, 'AI_SYSTEM_NOT_FOUND');
  const revision = aiActSystemRevisionSchema.parse(result.rows[0].revision_json);
  if (revision.revisionSha256 !== input.expectedRevisionSha256) {
    throw new AiSystemRegistryError('AI-system revision digest does not match', 409, 'AI_SYSTEM_REVISION_CONFLICT');
  }
  if (revision.lifecycleState !== 'released') {
    throw new AiSystemRegistryError('Compliance dossiers require an immutable released revision', 409, 'AI_DOSSIER_REVISION_NOT_RELEASED');
  }
  return revision;
}

async function loadSourceReport(
  client: pg.PoolClient,
  scope: Required<CanonicalAuditScope>,
  reportRunId: string,
): Promise<SourceReportRow> {
  const result = await client.query<SourceReportRow>(
    `SELECT id,report_type,name_snapshot,period_from,period_to,pack_id,pack_digest,summary,evidence_pack
       FROM mcp_audit_report_runs
      WHERE id=$1 AND workspace_key=$2 AND tenant_key=$3 AND environment=$4
        AND status='completed' AND verification_state='valid'
      FOR SHARE`,
    [reportRunId, scope.workspaceKey, scope.tenantKey, scope.environment],
  );
  const report = result.rows[0];
  if (!report || !report.summary || !report.evidence_pack) {
    throw new AiSystemRegistryError('A completed, verified audit report is required', 422, 'AI_DOSSIER_REPORT_NOT_VERIFIED');
  }
  const verification = verifyAuditEvidencePack(report.evidence_pack);
  if (verification.state !== 'valid'
    || report.pack_id !== report.evidence_pack.manifest.packId
    || report.pack_digest !== report.evidence_pack.packDigest) {
    throw new AiSystemRegistryError('Source evidence pack verification failed', 422, 'AI_DOSSIER_EVIDENCE_INVALID');
  }
  return report;
}

async function loadReleaseDecision(
  client: pg.PoolClient,
  revision: AiActSystemRevision,
): Promise<ReleaseDecisionRow> {
  const result = await client.query<ReleaseDecisionRow>(
    `SELECT decision.decision_id,decision.decision_json,event.event_id,event.event_hash
       FROM mcp_ai_system_governance_decisions decision
       JOIN mcp_canonical_audit_events event ON event.approval_id=decision.decision_id::text
      WHERE decision.ai_system_id=$1 AND decision.action='release' AND decision.result_revision=$2
        AND event.action='compliance.ai_system.released'
      ORDER BY decision.created_at DESC
      LIMIT 1
      FOR SHARE OF decision,event`,
    [revision.aiSystemId, revision.revision],
  );
  if (!result.rows[0]) throw new AiSystemRegistryError('Released revision has no canonical release decision', 422, 'AI_DOSSIER_RELEASE_EVIDENCE_MISSING');
  return result.rows[0];
}

async function createFrozenDossier(
  client: pg.PoolClient,
  context: AiComplianceDossierContext,
  scope: Required<CanonicalAuditScope>,
  aiSystemId: string,
  input: AiActComplianceDossierGenerationInput,
  now: Date,
): Promise<FrozenDossier> {
  const revision = await loadReleasedRevision(client, scope, aiSystemId, input);
  const report = await loadSourceReport(client, scope, input.sourceReportRunId);
  const release = await loadReleaseDecision(client, revision);
  if (!releaseReferencesSource(release.decision_json, report)
    && !sourcePackContainsRelease(report.evidence_pack, release, revision)) {
    throw new AiSystemRegistryError(
      'Source report is not cryptographically connected to the exact release decision',
      422,
      'AI_DOSSIER_SOURCE_NOT_RELEASE_BOUND',
    );
  }
  const dossierId = (context.uuid ?? randomUUID)();
  if (!UUID.test(dossierId)) throw new AiSystemRegistryError('dossierId must be a UUID');
  const generatedAt = now.toISOString();
  const readiness = evaluateAiSystemRegistrationReadiness(revision, { now });
  const controlLedger = await getAiSystemControlLedger(client, scope, revision.aiSystemId, { now, revision });
  const externalAnchorReceipts = await listExternalEvidenceAnchors(client as unknown as pg.Pool, [report.id]);
  const externalAnchors = externalAnchorReceipts.map(externalAnchorForDossier);
  const complianceMatrix = buildAiComplianceDossierMatrix({
    revision,
    controlLedger,
    generatedAt,
    sourceReport: { evidenceType: 'report', evidenceId: report.id, sha256: report.pack_digest },
    sourceEvidencePack: { evidenceType: 'evidence_pack', evidenceId: report.pack_id, sha256: report.pack_digest },
    releaseDecision: { evidenceType: 'canonical_event', evidenceId: release.event_id, sha256: release.event_hash },
    externalAnchors: externalAnchorReceipts,
  });
  const gaps = declaredGaps(report.evidence_pack, readiness, controlLedger, externalAnchorReceipts, complianceMatrix);
  const evidence: AiComplianceDossierEvidenceV2 = {
    schemaVersion: AI_COMPLIANCE_DOSSIER_VERSION,
    kind: 'argus.ai-compliance-dossier-evidence',
    dossierId,
    generatedAt,
    aiSystemRevision: revision,
    registrationReadiness: readiness,
    legalControlLedger: controlLedger,
    sourceReport: {
      reportRunId: report.id,
      reportType: report.report_type,
      name: report.name_snapshot,
      periodFrom: new Date(report.period_from).toISOString(),
      periodTo: new Date(report.period_to).toISOString(),
      summary: report.summary,
    },
    releaseDecision: {
      decisionId: release.decision_id,
      auditEventId: release.event_id,
      auditEventSha256: release.event_hash,
    },
    externalAnchorReceipts,
    sourceEvidencePack: report.evidence_pack,
    complianceMatrix,
  };
  const evidenceJson = canonicalBuffer(evidence);
  const signature = Buffer.from(report.evidence_pack.checkpoint.signature, 'base64url');
  if (signature.length === 0) throw new AiSystemRegistryError('Source checkpoint signature is malformed', 422, 'AI_DOSSIER_EVIDENCE_INVALID');
  const pdf = await dossierPdf(dossierId, revision, report, readiness, controlLedger, gaps, complianceMatrix, generatedAt);
  const prefix = `argus-ai-compliance-dossier-${dossierId}`;
  const unsignedManifest = {
    schemaVersion: AI_COMPLIANCE_DOSSIER_VERSION,
    kind: 'ai-compliance-dossier-manifest' as const,
    dossierId,
    dossierSha256: '0'.repeat(64),
    generatedAt,
    generatedBy: generatedBy(context),
    assessmentStatus: gaps.some(gap => gap.severity === 'critical' || gap.severity === 'high')
      ? 'controls_incomplete' as const
      : 'ready_for_independent_review' as const,
    aiSystem: {
      aiSystemId: revision.aiSystemId,
      revisionId: revision.revisionId,
      revision: revision.revision,
      revisionSha256: revision.revisionSha256,
      displayName: revision.displayName,
      classification: revision.classification.classification,
    },
    scope: {
      workspaceId: scope.workspaceKey,
      tenantId: scope.tenantKey,
      environments: [scope.environment],
      from: new Date(report.period_from).toISOString(),
      to: new Date(report.period_to).toISOString(),
    },
    sourceEvidencePack: {
      evidencePackId: report.pack_id,
      sha256: report.pack_digest,
      checkpointId: report.evidence_pack.checkpoint.checkpointId,
      verification: report.evidence_pack.manifest.declaredGaps.length > 0
        ? 'verified_with_declared_gaps' as const
        : 'verified' as const,
    },
    controlCoverage: controlLedger.coverage,
    sections: [
      {
        sectionId: 'identity-classification',
        title: 'System identity, intended purpose, roles and classification',
        state: 'complete' as const,
        evidenceCount: 1,
        gapCount: 0,
        evidence: [{ evidenceType: 'document' as const, evidenceId: revision.revisionId, sha256: revision.revisionSha256 }],
      },
      {
        sectionId: 'component-inventory',
        title: 'Pinned models, agents, workflows, tools and data categories',
        state: 'complete' as const,
        evidenceCount: revision.componentBindings.length,
        gapCount: 0,
        evidence: [{ evidenceType: 'document' as const, evidenceId: revision.revisionId, sha256: revision.revisionSha256 }],
      },
      {
        sectionId: 'release-governance',
        title: 'Release decision and four-eyes governance',
        state: 'complete' as const,
        evidenceCount: 1,
        gapCount: 0,
        evidence: [{ evidenceType: 'canonical_event' as const, evidenceId: release.event_id, sha256: release.event_hash }],
      },
      {
        sectionId: 'legal-control-ledger',
        title: 'Revision-bound EU AI Act control decisions',
        state: controlLedger.coverage.open || controlLedger.coverage.exceptions || controlLedger.coverage.expired ? 'complete_with_gaps' as const : 'complete' as const,
        evidenceCount: controlLedger.controls.filter(control => control.assessment).length,
        gapCount: controlLedger.coverage.open + controlLedger.coverage.exceptions + controlLedger.coverage.expired,
        evidence: controlLedger.controls.flatMap(control => control.assessment ? [{ evidenceType: 'document' as const, evidenceId: control.assessment.assessmentId, sha256: control.assessment.assessmentSha256 }] : []),
      },
      {
        sectionId: 'runtime-evidence',
        title: 'Signed runtime audit evidence',
        state: report.evidence_pack.manifest.declaredGaps.length > 0 ? 'complete_with_gaps' as const : 'complete' as const,
        evidenceCount: report.evidence_pack.manifest.eventCount,
        gapCount: report.evidence_pack.manifest.declaredGaps.length,
        evidence: [
          { evidenceType: 'report' as const, evidenceId: report.id, sha256: report.pack_digest },
          { evidenceType: 'evidence_pack' as const, evidenceId: report.pack_id, sha256: report.pack_digest },
        ],
      },
      {
        sectionId: 'external-evidence-anchors',
        title: 'External WORM and timestamp receipts',
        state: externalAnchorReceipts.some(anchor => anchor.anchorKind === 'worm_object') ? (externalAnchorReceipts.some(anchor => anchor.anchorKind === 'qualified_timestamp') ? 'complete' as const : 'complete_with_gaps' as const) : 'missing' as const,
        evidenceCount: externalAnchorReceipts.length,
        gapCount: Number(!externalAnchorReceipts.some(anchor => anchor.anchorKind === 'worm_object')) + Number(!externalAnchorReceipts.some(anchor => anchor.anchorKind === 'qualified_timestamp')),
        evidence: externalAnchorReceipts.map(anchor => ({ evidenceType: 'document' as const, evidenceId: anchor.anchorId, sha256: anchor.receiptSha256 })),
      },
      ...complianceMatrix.groups.map(group => ({
        sectionId: `obligations-${group.groupId}`,
        title: group.title,
        state: group.coverage.applicable === 0
          ? 'not_applicable' as const
          : group.coverage.missing > 0 || group.coverage.expired > 0
            ? 'missing' as const
            : group.coverage.partial > 0
              ? 'complete_with_gaps' as const
              : 'complete' as const,
        evidenceCount: new Set(group.requirements.flatMap(requirement => requirement.evidence.map(item => `${item.evidenceType}:${item.evidenceId}:${item.sha256}`))).size,
        gapCount: group.coverage.partial + group.coverage.missing + group.coverage.expired,
        evidence: group.requirements.flatMap(requirement => requirement.evidence),
      })),
    ],
    artifacts: [
      { format: 'json' as const, filename: `${prefix}-evidence.json`, mediaType: 'application/json', bytes: evidenceJson.length, sha256: sha256(evidenceJson) },
      { format: 'pdf' as const, filename: `${prefix}.pdf`, mediaType: 'application/pdf', bytes: pdf.length, sha256: sha256(pdf) },
      { format: 'signature' as const, filename: `${prefix}-source-checkpoint.sig`, mediaType: 'application/octet-stream', bytes: signature.length, sha256: sha256(signature) },
    ],
    externalAnchors,
    complianceMatrix,
    declaredGaps: gaps,
    claimBoundary: 'This dossier packages verified technical and governance evidence for independent review. It is not an automatic EU AI Act conformity declaration or legal certification.',
  };
  const manifest = aiActComplianceDossierManifestSchema.parse({
    ...unsignedManifest,
    dossierSha256: manifestDigest(unsignedManifest),
  });
  await client.query(
    `INSERT INTO mcp_ai_compliance_dossiers
       (dossier_id,ai_system_id,ai_system_revision,ai_system_revision_id,
        workspace_key,tenant_key,environment,source_report_run_id,source_pack_id,
        source_pack_digest,manifest_json,dossier_sha256,
        evidence_json_artifact,pdf_artifact,checkpoint_signature,
        generated_by_actor_type,generated_by_actor_id,generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18)`,
    [dossierId, revision.aiSystemId, revision.revision, revision.revisionId,
      scope.workspaceKey, scope.tenantKey, scope.environment, report.id, report.pack_id,
      report.pack_digest, JSON.stringify(manifest), manifest.dossierSha256,
      evidenceJson, pdf, signature, manifest.generatedBy.actorType, manifest.generatedBy.actorId, generatedAt],
  );
  return { manifest, evidenceJson, pdf, signature, sourceEvidencePack: report.evidence_pack, sourceReportRunId: report.id };
}

function mapRow(row: DossierRow): FrozenDossier {
  const evidenceJson = Buffer.from(row.evidence_json_artifact);
  let sourceEvidencePack: AuditEvidencePackV1;
  try {
    const evidence = JSON.parse(evidenceJson.toString('utf8')) as AiComplianceDossierEvidence;
    if (evidence.kind !== 'argus.ai-compliance-dossier-evidence' || !evidence.sourceEvidencePack) throw new Error('invalid dossier evidence kind');
    sourceEvidencePack = evidence.sourceEvidencePack;
  } catch {
    throw new AiSystemRegistryError('Stored dossier evidence JSON is malformed', 409, 'AI_DOSSIER_INTEGRITY_INVALID');
  }
  return {
    manifest: aiActComplianceDossierManifestSchema.parse(row.manifest_json),
    evidenceJson,
    pdf: Buffer.from(row.pdf_artifact),
    signature: Buffer.from(row.checkpoint_signature),
    sourceEvidencePack,
    sourceReportRunId: row.source_report_run_id,
  };
}

export function verifyAiComplianceDossier(dossier: FrozenDossier): AiComplianceDossierVerification {
  const reasons: string[] = [];
  const packVerification = verifyAuditEvidencePack(dossier.sourceEvidencePack);
  if (packVerification.state !== 'valid') reasons.push('source_evidence_pack_invalid');
  if (manifestDigest(dossier.manifest) !== dossier.manifest.dossierSha256) reasons.push('dossier_manifest_digest_invalid');
  if (dossier.manifest.sourceEvidencePack.sha256 !== dossier.sourceEvidencePack.packDigest) reasons.push('source_evidence_pack_digest_mismatch');
  const byFormat = new Map(dossier.manifest.artifacts.map(artifact => [artifact.format, artifact]));
  for (const [format, bytes] of [['json', dossier.evidenceJson], ['pdf', dossier.pdf], ['signature', dossier.signature]] as const) {
    const artifact = byFormat.get(format);
    if (!artifact || artifact.bytes !== bytes.length || artifact.sha256 !== sha256(bytes)) reasons.push(`${format}_artifact_invalid`);
  }
  const checkpointSignature = Buffer.from(dossier.sourceEvidencePack.checkpoint.signature, 'base64url');
  if (!checkpointSignature.equals(dossier.signature)) reasons.push('checkpoint_signature_artifact_invalid');
  try {
    const evidence = JSON.parse(dossier.evidenceJson.toString('utf8')) as AiComplianceDossierEvidence;
    if (evidence.kind !== 'argus.ai-compliance-dossier-evidence'
      || evidence.dossierId !== dossier.manifest.dossierId
      || evidence.aiSystemRevision.revisionSha256 !== dossier.manifest.aiSystem.revisionSha256
      || evidence.sourceEvidencePack.packDigest !== dossier.manifest.sourceEvidencePack.sha256) {
      reasons.push('evidence_json_binding_invalid');
    }
    if (dossier.manifest.schemaVersion === AI_COMPLIANCE_DOSSIER_VERSION) {
      if (evidence.schemaVersion !== AI_COMPLIANCE_DOSSIER_VERSION
        || stableAuditJson(evidence.complianceMatrix as unknown as AuditJsonValue) !== stableAuditJson(dossier.manifest.complianceMatrix as unknown as AuditJsonValue)) {
        reasons.push('compliance_matrix_binding_invalid');
      }
    }
    const manifestAnchors = dossier.manifest.externalAnchors;
    const receipts = Array.isArray(evidence.externalAnchorReceipts) ? evidence.externalAnchorReceipts : [];
    if (manifestAnchors.length !== receipts.length || manifestAnchors.some(anchor => !receipts.some(receipt =>
      receipt.verification === 'verified'
      && receipt.anchorKind === anchor.kind
      && receipt.provider === anchor.provider
      && receipt.reference === anchor.reference
      && receipt.anchoredAt === anchor.anchoredAt
      && receipt.packId === dossier.manifest.sourceEvidencePack.evidencePackId
      && receipt.packSha256 === dossier.manifest.sourceEvidencePack.sha256
    ))) reasons.push('external_anchor_receipt_binding_invalid');
  } catch {
    reasons.push('evidence_json_invalid');
  }
  return { state: reasons.length === 0 ? 'valid' : 'invalid', reasons: [...new Set(reasons)], sourceEvidencePackState: packVerification.state };
}

async function getFrozenDossier(
  executor: pg.Pool | pg.PoolClient,
  scope: Pick<Required<CanonicalAuditScope>, 'workspaceKey' | 'tenantKey'>,
  dossierId: string,
): Promise<FrozenDossier | null> {
  const result = await executor.query<DossierRow>(
    `SELECT dossier_id,source_report_run_id,source_pack_digest,
            manifest_json,evidence_json_artifact,pdf_artifact,checkpoint_signature
       FROM mcp_ai_compliance_dossiers
      WHERE dossier_id=$1 AND workspace_key=$2 AND tenant_key=$3`,
    [dossierId, scope.workspaceKey, scope.tenantKey],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function getAiComplianceDossier(
  pool: pg.Pool,
  scope: Pick<Required<CanonicalAuditScope>, 'workspaceKey' | 'tenantKey'>,
  dossierId: string,
): Promise<AiComplianceDossier | null> {
  const frozen = await getFrozenDossier(pool, scope, dossierId);
  return frozen ? { manifest: frozen.manifest, sourceReportRunId: frozen.sourceReportRunId, verification: verifyAiComplianceDossier(frozen) } : null;
}

export async function listAiComplianceDossiers(
  pool: pg.Pool,
  scope: Pick<Required<CanonicalAuditScope>, 'workspaceKey' | 'tenantKey'>,
  aiSystemId: string,
  limit = 100,
): Promise<AiComplianceDossier[]> {
  const result = await pool.query<{ dossier_id: string }>(
    `SELECT dossier_id FROM mcp_ai_compliance_dossiers
      WHERE workspace_key=$1 AND tenant_key=$2 AND ai_system_id=$3
      ORDER BY generated_at DESC,dossier_id DESC LIMIT $4`,
    [scope.workspaceKey, scope.tenantKey, aiSystemId, Math.min(Math.max(Math.floor(limit), 1), 200)],
  );
  const dossiers = await Promise.all(result.rows.map(row => getAiComplianceDossier(pool, scope, row.dossier_id)));
  return dossiers.filter((value): value is AiComplianceDossier => value !== null);
}

export async function generateAiComplianceDossierAudited(
  pool: pg.Pool,
  context: AiComplianceDossierContext,
  aiSystemId: string,
  input: AiActComplianceDossierGenerationInput,
): Promise<AiComplianceDossier & { replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  const scope = normalizedScope(context);
  const actor = generatedBy(context);
  const now = (context.now ?? (() => new Date()))();
  const result = await executeCanonicalAuditedMutation(
    pool,
    { name: 'compliance.ai-dossier.generate', eventId: context.producerEventId },
    scope,
    client => createFrozenDossier(client, context, scope, aiSystemId, input, now),
    dossier => ({
      occurredAt: now,
      ...scope,
      solution: 'argus.core',
      actor: context.actor,
      action: 'compliance.ai_dossier.generated',
      outcome: 'success',
      risk: 'critical',
      resource: { type: 'ai_compliance_dossier', id: dossier.manifest.dossierId, revision: dossier.manifest.dossierSha256 },
      policy: { id: 'argus.ai-act.dossier-generation', version: String(dossier.manifest.schemaVersion), decision: dossier.manifest.assessmentStatus },
      correlation: { requestId: context.requestId ?? context.producerEventId },
      payload: { after: {
        aiSystemId,
        aiSystemRevision: input.expectedRevision,
        sourceReportRunId: input.sourceReportRunId,
        sourcePackDigest: dossier.manifest.sourceEvidencePack.sha256,
        dossierSha256: dossier.manifest.dossierSha256,
        assessmentStatus: dossier.manifest.assessmentStatus,
        dossierSchemaVersion: dossier.manifest.schemaVersion,
        complianceMatrixSha256: dossier.manifest.schemaVersion === AI_COMPLIANCE_DOSSIER_VERSION ? dossier.manifest.complianceMatrix.matrixSha256 : null,
        generatedBy: actor,
      } },
      retentionClass: 'business-audit-ai-system',
    }),
    { now: () => now },
  );
  const frozen = result.result ?? await getFrozenDossier(pool, scope, result.event.resource.id);
  if (!frozen) throw new AiSystemRegistryError('Generated dossier could not be reloaded', 500, 'AI_DOSSIER_RELOAD_FAILED');
  return {
    manifest: frozen.manifest,
    sourceReportRunId: frozen.sourceReportRunId,
    verification: verifyAiComplianceDossier(frozen),
    replayed: result.replayed,
    auditEvent: result.event,
  };
}

export async function loadAiComplianceDossierArtifact(
  pool: pg.Pool,
  scope: Pick<Required<CanonicalAuditScope>, 'workspaceKey' | 'tenantKey'>,
  dossierId: string,
  format: AiComplianceDossierArtifactFormat,
): Promise<{ bytes: Buffer; filename: string; mediaType: string; dossier: AiComplianceDossier } | null> {
  const frozen = await getFrozenDossier(pool, scope, dossierId);
  if (!frozen) return null;
  const dossier = { manifest: frozen.manifest, sourceReportRunId: frozen.sourceReportRunId, verification: verifyAiComplianceDossier(frozen) };
  if (dossier.verification.state !== 'valid') throw new AiSystemRegistryError('Dossier integrity verification failed', 409, 'AI_DOSSIER_INTEGRITY_INVALID');
  const prefix = `argus-ai-compliance-dossier-${dossierId}`;
  if (format === 'manifest') return { bytes: canonicalBuffer(frozen.manifest), filename: `${prefix}-manifest.json`, mediaType: 'application/json', dossier };
  if (format === 'json') return { bytes: frozen.evidenceJson, filename: `${prefix}-evidence.json`, mediaType: 'application/json', dossier };
  if (format === 'pdf') return { bytes: frozen.pdf, filename: `${prefix}.pdf`, mediaType: 'application/pdf', dossier };
  return { bytes: frozen.signature, filename: `${prefix}-source-checkpoint.sig`, mediaType: 'application/octet-stream', dossier };
}

export async function recordAiComplianceDossierExport(
  pool: pg.Pool,
  dossier: AiComplianceDossier,
  format: AiComplianceDossierArtifactFormat,
  actor: CanonicalAuditActor,
  producerEventId: string,
  now = new Date(),
): Promise<{ replayed: boolean; eventId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await appendCanonicalAuditEvent(client, {
      producer: { name: 'compliance.ai-dossier.export', eventId: producerEventId },
      occurredAt: now,
      environment: dossier.manifest.scope.environments[0]!,
      workspaceKey: dossier.manifest.scope.workspaceId,
      tenantKey: dossier.manifest.scope.tenantId,
      solution: 'argus.core',
      actor,
      action: 'compliance.ai_dossier.exported',
      outcome: 'success',
      risk: 'critical',
      resource: { type: 'ai_compliance_dossier', id: dossier.manifest.dossierId, revision: dossier.manifest.dossierSha256 },
      policy: { id: 'argus.ai-act.dossier-export', version: String(dossier.manifest.schemaVersion), decision: 'allow' },
      payload: { after: { format, dossierSha256: dossier.manifest.dossierSha256 } },
      retentionClass: 'business-audit-ai-system',
    });
    await client.query('COMMIT');
    return { replayed: event.replayed, eventId: event.eventId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
