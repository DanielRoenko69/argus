import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AiComplianceDossier } from '../types';
import { DossierCard } from './ComplianceDossiers';

const coverage = { applicable: 1, satisfied: 0, partial: 1, missing: 0, expired: 0, notApplicable: 0 };
const dossier: AiComplianceDossier = {
  sourceReportRunId: '20000000-0000-4000-8000-000000000001',
  verification: { state: 'valid', reasons: [], sourceEvidencePackState: 'valid' },
  manifest: {
    schemaVersion: 2,
    kind: 'ai-compliance-dossier-manifest',
    dossierId: '40000000-0000-4000-8000-000000000001',
    dossierSha256: 'a'.repeat(64),
    generatedAt: '2026-09-10T10:00:00.000Z',
    generatedBy: { actorType: 'user', actorId: 'alex' },
    assessmentStatus: 'controls_incomplete',
    aiSystem: { aiSystemId: '10000000-0000-4000-8000-000000000001', revisionId: '10000000-0000-4000-8000-000000000002', revision: 4, revisionSha256: 'b'.repeat(64), displayName: 'Claims copilot', classification: 'high_risk' },
    scope: { workspaceId: 'default', tenantId: 'default', environments: ['production'], from: '2026-09-01T00:00:00.000Z', to: '2026-09-10T09:59:59.999Z' },
    sourceEvidencePack: { evidencePackId: '20000000-0000-4000-8000-000000000002', sha256: 'c'.repeat(64), checkpointId: '20000000-0000-4000-8000-000000000003', verification: 'verified' },
    controlCoverage: { applicable: 8, satisfied: 7, open: 1, exceptions: 0, expired: 0 },
    sections: [],
    artifacts: [
      { format: 'json', filename: 'evidence.json', mediaType: 'application/json', bytes: 4096, sha256: 'd'.repeat(64) },
      { format: 'pdf', filename: 'dossier.pdf', mediaType: 'application/pdf', bytes: 8192, sha256: 'e'.repeat(64) },
    ],
    externalAnchors: [],
    complianceMatrix: {
      schemaVersion: 2,
      kind: 'argus.ai-compliance-obligation-matrix',
      matrixSha256: 'f'.repeat(64),
      legalBaseline: {
        regulation: 'Regulation (EU) 2024/1689',
        officialJournalUrl: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
        annexIvUrl: 'https://ai-act-service-desk.ec.europa.eu/en/ai-act/annex-4',
        qualityManagementUrl: 'https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-17',
        assessedAt: '2026-09-10T10:00:00.000Z',
        legalReviewRequired: true,
        applicabilityRationale: 'High-risk requirements are applicable to this immutable revision.',
      },
      coverage,
      groups: [{
        groupId: 'annex_iv', title: 'Annex IV technical documentation', legalRefs: ['Article 11', 'Annex IV'], coverage,
        requirements: [{
          requirementId: 'AIA-ANNEX-IV-1', legalRefs: ['Annex IV(1)'], title: 'General system description and instructions',
          description: 'Identity, intended purpose, versions, interfaces and instructions.', applicability: 'high_risk', state: 'partial', ownerRole: 'provider',
          expectedEvidence: ['System description', 'Instructions for use'], controlIds: [], evidence: [{ evidenceType: 'document', evidenceId: 'revision-4', sha256: 'b'.repeat(64) }],
          findings: ['Instructions for use are not yet attached.'], assessedAt: '2026-09-10T10:00:00.000Z', nextReviewAt: null,
        }],
      }],
    },
    declaredGaps: [{ gapId: 'requirement-AIA-ANNEX-IV-1', severity: 'medium', description: 'Instructions for use are not yet attached.', ownerRole: 'provider', dueAt: null }],
    claimBoundary: 'Evidence support, not an automatic legal conformity declaration.',
  },
};

describe('Compliance dossier V2 card', () => {
  it('shows the obligation matrix, legal references, evidence expectation and explicit finding', () => {
    render(<DossierCard dossier={dossier} downloading={undefined} onDownload={vi.fn()} />);
    expect(screen.getByText(/DOSSIER V2/)).toBeInTheDocument();
    const matrixSummary = screen.getByText('AI Act obligation matrix').closest('summary');
    expect(matrixSummary).not.toBeNull();
    fireEvent.click(matrixSummary!);
    expect(screen.getByText('Annex IV technical documentation')).toBeInTheDocument();
    expect(screen.getByText('General system description and instructions')).toBeInTheDocument();
    expect(screen.getAllByText('Instructions for use are not yet attached.')).toHaveLength(2);
    expect(screen.getByText(/Expected: System description, Instructions for use/)).toBeInTheDocument();
    expect(screen.getByText(/legal review remains required/)).toBeInTheDocument();
  });
});
