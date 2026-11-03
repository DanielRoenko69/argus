#!/usr/bin/env node
/** Behavioral gate for immutable, release-bound AI compliance dossiers. */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { createAuditCheckpointSigner } from '../dist/audit/checkpoints.js';
import { createAndGenerateAuditReport } from '../dist/audit/reportService.js';
import { AI_ACT_CONTROL_CATALOG } from '../dist/compliance/aiActControlCatalog.js';
import {
  generateAiComplianceDossierAudited,
  loadAiComplianceDossierArtifact,
  recordAiComplianceDossierExport,
} from '../dist/compliance/aiComplianceDossier.js';
import { AI_COMPLIANCE_DOSSIER_VERSION } from '../dist/compliance/aiActContracts.js';
import { recordAiSystemControlAssessment } from '../dist/compliance/aiSystemControlLedger.js';
import { classifyAiSystemAudited, releaseAiSystemAudited } from '../dist/compliance/aiSystemGovernance.js';
import { createAiSystemAudited } from '../dist/compliance/aiSystemRegistry.js';

const { Pool } = pg;
const databaseUrl = (process.env.AI_COMPLIANCE_DOSSIER_CERTIFICATION_DATABASE_URL || '').trim();
const required = process.env.AI_COMPLIANCE_DOSSIER_CERTIFICATION_REQUIRED === '1';
const reportPath = process.env.AI_COMPLIANCE_DOSSIER_CERTIFICATION_REPORT
  || 'test-results/ai-compliance-dossier-certification.json';

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500) || 'unknown error';
}
function assert(condition, message) { if (!condition) throw new Error(message); }
async function output(report) {
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
function human(stamp, actorId, event, time) {
  return {
    scope: { workspaceKey: 'ai-dossier-certification', tenantKey: 'certification-tenant', environment: 'certification' },
    actor: { type: 'human', id: actorId, ssoSubject: `oidc:${actorId}`, authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
    producerEventId: `ai-dossier-${stamp}-${event}`,
    requestId: `request-${stamp}-${event}`,
    mfaVerifiedAt: new Date(time.getTime() - 60_000).toISOString(),
    mfaMethod: 'otp', mfaMaxAgeSeconds: 600, now: () => time,
  };
}

async function main() {
  const report = { generated_at: new Date().toISOString(), status: 'not_run', database: 'explicit disposable database not configured', checks: {} };
  if (!databaseUrl) {
    await output(report);
    if (required) process.exitCode = 2;
    return;
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 10_000 });
  const stamp = Date.now();
  const scope = { workspaceKey: 'ai-dossier-certification', tenantKey: 'certification-tenant', environment: 'certification' };
  try {
    const created = await createAiSystemAudited(pool, {
      scope,
      actor: { type: 'system', id: 'ai-dossier-certification', authMethod: 'certification', effectiveRoles: ['platform_admin'] },
      producerEventId: `ai-dossier-${stamp}-create`, requestId: `request-${stamp}-create`,
      now: () => new Date('2026-09-10T09:50:00.000Z'),
    }, {
      displayName: `AI dossier certification ${stamp}`,
      intendedPurpose: 'Certify an immutable offline-verifiable dossier in an isolated technical environment.',
      prohibitedUses: ['Production use or decisions affecting natural persons'],
      targetUsers: ['Certification runner'], affectedGroups: [], regions: ['EU/EEA'],
      marketRoles: [{ role: 'provider', organisationId: 'argus-certification', organisationName: 'Argus Certification', rationale: 'Owns the isolated technical certification record.' }],
      prohibitedPracticeCheck: { decision: 'clear', articleRefs: ['Article 5'], rationale: 'The isolated test cannot affect a natural person.' },
      classification: {
        classification: 'out_of_scope', articleRefs: ['Article 2'], annexRefs: [],
        rationale: 'Synthetic technical certification only.', legalReviewRequired: false,
        nextReviewAt: '2027-09-10T10:00:00.000Z',
      },
      componentBindings: [{ resourceType: 'workflow', resourceId: 'dossier-certification-workflow', revision: '1', sha256: '1'.repeat(64) }],
      dataCategories: ['Synthetic certification data'],
      controlCatalog: {
        catalogId: AI_ACT_CONTROL_CATALOG.catalogId,
        catalogVersion: AI_ACT_CONTROL_CATALOG.catalogVersion,
        catalogSha256: AI_ACT_CONTROL_CATALOG.catalogSha256,
      },
    });
    const classified = await classifyAiSystemAudited(
      pool,
      human(stamp, 'classifier', 'classification', new Date('2026-09-10T10:00:00.000Z')),
      created.value.aiSystemId,
      {
        expectedRevision: created.value.revision,
        expectedRevisionSha256: created.value.revisionSha256,
        prohibitedPracticeCheck: { decision: 'clear', articleRefs: ['Article 5'], rationale: 'The isolated test contains no prohibited practice.' },
        classification: {
          classification: 'out_of_scope', articleRefs: ['Article 2'], annexRefs: [],
          rationale: 'Synthetic technical certification only.', legalReviewRequired: false,
          nextReviewAt: '2027-09-10T10:00:00.000Z',
        },
      },
    );
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const signer = createAuditCheckpointSigner(`dossier-cert-${stamp}`, privateKeyPem, 'external-secret');
    const sourceReport = await createAndGenerateAuditReport(pool, {
      ...scope, reportType: 'compliance', name: `AI release evidence ${stamp}`,
      triggerType: 'event', requestedBy: 'dossier-certification',
      periodFrom: new Date('2026-09-10T09:00:00.000Z'), periodTo: new Date('2026-09-10T10:04:00.000Z'),
      filters: { resourceType: 'ai_system', resourceId: created.value.aiSystemId },
    }, { signer, now: () => new Date('2026-09-10T10:05:00.000Z') });
    assert(sourceReport.verificationState === 'valid' && sourceReport.packId && sourceReport.packDigest, 'source report was not verified');
    const requiredControls = AI_ACT_CONTROL_CATALOG.controls.filter(control => control.blocksProduction && control.applicability !== 'high_risk');
    for (const [index, control] of requiredControls.entries()) {
      await recordAiSystemControlAssessment(
        pool,
        human(stamp, `control-reviewer-${index + 1}`, `control-${index + 1}`, new Date(`2026-09-10T10:0${6 + index}:00.000Z`)),
        created.value.aiSystemId,
        control.controlId,
        {
          expectedRevision: classified.value.revision,
          expectedRevisionSha256: classified.value.revisionSha256,
          status: 'satisfied',
          ownerParty: 'provider',
          ownerId: `control-owner-${index + 1}`,
          dueAt: null,
          reassessmentAt: '2027-09-10T10:00:00.000Z',
          rationale: 'The verified signed source report satisfies this control for the isolated certification scope.',
          evidence: [{ evidenceType: 'report', evidenceId: sourceReport.id, sha256: sourceReport.packDigest }],
          exception: null,
        },
      );
    }
    const released = await releaseAiSystemAudited(
      pool,
      human(stamp, 'releaser', 'release', new Date('2026-09-10T10:10:00.000Z')),
      created.value.aiSystemId,
      {
        expectedRevision: classified.value.revision,
        expectedRevisionSha256: classified.value.revisionSha256,
        decisionRationale: 'The signed source report is approved for this isolated release.',
        evidence: [{ evidenceType: 'report', evidenceId: sourceReport.id, sha256: sourceReport.packDigest }],
      },
    );
    const generated = await generateAiComplianceDossierAudited(
      pool,
      human(stamp, 'dossier-builder', 'generate', new Date('2026-09-10T10:15:00.000Z')),
      created.value.aiSystemId,
      {
        expectedRevision: released.value.revision,
        expectedRevisionSha256: released.value.revisionSha256,
        sourceReportRunId: sourceReport.id,
      },
    );
    const replay = await generateAiComplianceDossierAudited(
      pool,
      human(stamp, 'dossier-builder', 'generate', new Date('2026-09-10T10:15:00.000Z')),
      created.value.aiSystemId,
      {
        expectedRevision: released.value.revision,
        expectedRevisionSha256: released.value.revisionSha256,
        sourceReportRunId: sourceReport.id,
      },
    );
    const artifacts = {};
    for (const format of ['manifest', 'json', 'pdf', 'signature']) {
      artifacts[format] = await loadAiComplianceDossierArtifact(pool, scope, generated.manifest.dossierId, format);
      assert(artifacts[format]?.dossier.verification.state === 'valid', `${format} artifact failed dossier verification`);
    }
    const exportEvidence = await recordAiComplianceDossierExport(
      pool,
      artifacts.json.dossier,
      'json',
      human(stamp, 'auditor', 'export', new Date('2026-09-10T10:20:00.000Z')).actor,
      `ai-dossier-${stamp}-export`,
      new Date('2026-09-10T10:20:00.000Z'),
    );
    let updateBlocked = false;
    try {
      await pool.query(`UPDATE mcp_ai_compliance_dossiers SET generated_by_actor_id='tampered' WHERE dossier_id=$1`, [generated.manifest.dossierId]);
    } catch { updateBlocked = true; }
    let deleteBlocked = false;
    try { await pool.query(`DELETE FROM mcp_ai_compliance_dossiers WHERE dossier_id=$1`, [generated.manifest.dossierId]); }
    catch { deleteBlocked = true; }
    const canonical = await pool.query(
      `SELECT action FROM mcp_canonical_audit_events WHERE resource_id=$1 ORDER BY sequence`,
      [generated.manifest.dossierId],
    );
    assert(generated.verification.state === 'valid', 'generated dossier failed offline verification');
    assert(generated.manifest.schemaVersion === AI_COMPLIANCE_DOSSIER_VERSION, 'dossier did not use the current schema version');
    assert(generated.manifest.complianceMatrix?.groups.length === 4, 'dossier obligation groups are incomplete');
    assert(
      generated.manifest.complianceMatrix.groups.reduce((sum, group) => sum + group.requirements.length, 0) === 37,
      'dossier requirement matrix does not contain all 37 V2 requirements',
    );
    assert(generated.manifest.aiSystem.revisionSha256 === released.value.revisionSha256, 'dossier revision binding drifted');
    assert(generated.manifest.sourceEvidencePack.sha256 === sourceReport.packDigest, 'dossier source pack binding drifted');
    assert(generated.manifest.assessmentStatus === 'controls_incomplete', 'missing external anchor was not fail-visible');
    assert(replay.replayed && replay.manifest.dossierId === generated.manifest.dossierId, 'generation idempotency replay failed');
    assert(updateBlocked && deleteBlocked, 'append-only dossier storage accepted mutation');
    assert(canonical.rows.map(row => row.action).join(',') === 'compliance.ai_dossier.generated,compliance.ai_dossier.exported', 'canonical dossier evidence is incomplete');
    assert(exportEvidence.eventId, 'export audit event was not returned');
    report.status = 'passed';
    report.database = 'explicit disposable database';
    report.checks = {
      released_revision_pinned: true,
      verified_report_and_pack_required: true,
      release_decision_bound: true,
      legal_control_ledger_bound: true,
      dossier_manifest_digest_valid: true,
      dossier_v2_obligation_matrix_complete: true,
      source_checkpoint_signature_exported: true,
      json_pdf_signature_artifacts_verified: true,
      external_anchor_gap_fail_visible: true,
      idempotent_generation_replay: true,
      update_and_delete_blocked: true,
      generation_and_export_canonical_events: true,
      dossier_id: generated.manifest.dossierId,
      dossier_sha256: generated.manifest.dossierSha256,
    };
  } catch (error) {
    report.status = 'failed'; report.database = 'explicit disposable database'; report.error = safeError(error); process.exitCode = 2;
  } finally { await pool.end().catch(() => undefined); }
  await output(report);
}

try { await main(); }
catch (error) { await output({ generated_at: new Date().toISOString(), status: 'failed', error: safeError(error) }); process.exitCode = 2; }
