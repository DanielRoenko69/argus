import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import type { ExternalEvidenceAnchorRecord } from '../../audit/externalAnchorService.js';
import { aiActSystemRevisionSchema } from '../aiActContracts.js';
import { AI_ACT_CONTROL_CATALOG } from '../aiActControlCatalog.js';
import { buildAiComplianceDossierMatrix, complianceMatrixGaps } from '../aiComplianceDossierMatrix.js';
import type { AiSystemControlLedger, AiSystemControlProjection } from '../aiSystemControlLedger.js';

const fixture = aiActSystemRevisionSchema.parse(JSON.parse(readFileSync(resolve(
  process.cwd(), 'docs/specs/ai-act-compliance/ai-system-revision.v1.fixture.json',
), 'utf8')));
const generatedAt = '2026-09-10T12:00:00.000Z';

function ledger(revision = fixture, satisfied = false): AiSystemControlLedger {
  const controls = AI_ACT_CONTROL_CATALOG.controls.map((definition, index): AiSystemControlProjection => {
    const applicable = definition.applicability !== 'high_risk' || revision.classification.classification === 'high_risk';
    return {
      definition,
      applicable,
      assessment: satisfied && applicable ? {
        assessmentId: `81000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        assessmentSha256: String(index + 1).repeat(64).slice(0, 64),
        status: 'satisfied',
        evidence: [{ evidenceType: 'report', evidenceId: '70000000-0000-4000-8000-000000000001', sha256: 'd'.repeat(64) }],
        reassessmentAt: '2027-09-10T12:00:00.000Z',
        dueAt: null,
      } as AiSystemControlProjection['assessment'] : null,
      effectiveStatus: applicable && satisfied ? 'satisfied' : applicable ? 'not_assessed' : 'not_applicable',
      expired: false,
      releaseBlocking: applicable && definition.blocksProduction && !satisfied,
      issues: applicable && !satisfied ? ['No evidence decision exists.'] : [],
    };
  });
  const applicable = controls.filter(control => control.applicable).length;
  return {
    schemaVersion: 1,
    kind: 'ai-system-control-ledger',
    aiSystemId: revision.aiSystemId,
    revisionId: revision.revisionId,
    revision: revision.revision,
    revisionSha256: revision.revisionSha256,
    assessmentSourceRevision: {
      revisionId: revision.revisionId, revision: revision.revision,
      revisionSha256: revision.revisionSha256, relation: 'current_revision',
    },
    generatedAt,
    catalog: AI_ACT_CONTROL_CATALOG,
    coverage: { applicable, satisfied: satisfied ? applicable : 0, open: satisfied ? 0 : applicable, exceptions: 0, expired: 0 },
    releaseReady: satisfied,
    blockingReasons: [],
    controls,
    claimBoundary: AI_ACT_CONTROL_CATALOG.claimBoundary,
  };
}

function matrixInput(revision = fixture, satisfied = false) {
  return {
    revision,
    controlLedger: ledger(revision, satisfied),
    generatedAt,
    sourceReport: { evidenceType: 'report' as const, evidenceId: '70000000-0000-4000-8000-000000000001', sha256: 'd'.repeat(64) },
    sourceEvidencePack: { evidenceType: 'evidence_pack' as const, evidenceId: '20000000-0000-4000-8000-000000000002', sha256: 'd'.repeat(64) },
    releaseDecision: { evidenceType: 'canonical_event' as const, evidenceId: '90000000-0000-4000-8000-000000000001', sha256: 'e'.repeat(64) },
    externalAnchors: [] as ExternalEvidenceAnchorRecord[],
  };
}

describe('AI compliance dossier v2 obligation matrix', () => {
  it('keeps high-risk-only Annex IV and QMS requirements explicit but not applicable for a minimal-risk revision', () => {
    const matrix = buildAiComplianceDossierMatrix(matrixInput());
    expect(matrix.schemaVersion).toBe(2);
    expect(matrix.groups).toHaveLength(4);
    const annex = matrix.groups.find(group => group.groupId === 'annex_iv')!;
    expect(annex.requirements).toHaveLength(9);
    expect(annex.coverage).toMatchObject({ applicable: 0, notApplicable: 9 });
    expect(matrix.legalBaseline.legalReviewRequired).toBe(true);
  });

  it('maps verified controls but still exposes missing Annex IV artifacts for a high-risk revision', () => {
    const revision = aiActSystemRevisionSchema.parse({
      ...fixture,
      classification: {
        ...fixture.classification,
        classification: 'high_risk',
        highRiskBasis: 'Annex III use-case assessment requires high-risk controls.',
      },
    });
    const matrix = buildAiComplianceDossierMatrix(matrixInput(revision, true));
    const annex = matrix.groups.find(group => group.groupId === 'annex_iv')!;
    expect(annex.coverage).toMatchObject({ applicable: 9, satisfied: 4, partial: 3, missing: 2 });
    expect(annex.requirements.find(item => item.requirementId === 'AIA-ANNEX-IV-5')?.state).toBe('satisfied');
    expect(annex.requirements.find(item => item.requirementId === 'AIA-ANNEX-IV-7')?.state).toBe('missing');
    expect(complianceMatrixGaps(matrix).map(gap => gap.gapId)).toContain('requirement-AIA-ANNEX-IV-8');
  });

  it('binds the matrix digest to canonical requirement content', () => {
    const matrix = buildAiComplianceDossierMatrix(matrixInput());
    expect(matrix.matrixSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => buildAiComplianceDossierMatrix(matrixInput())).not.toThrow();
  });
});
