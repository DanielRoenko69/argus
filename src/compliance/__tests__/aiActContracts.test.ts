import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  aiActComplianceDossierManifestSchema,
  aiActControlCatalogSchema,
  aiActProductionRunBindingSchema,
  aiActRegistrationReadinessSchema,
  aiActSystemRevisionSchema,
} from '../aiActContracts.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/ai-act-compliance',
  name,
), 'utf8'));

describe('AI Act compliance enablement v1 contracts', () => {
  it('accepts all five handoff fixtures', () => {
    expect(aiActControlCatalogSchema.parse(fixture('control-catalog.v1.fixture.json')).controls).toHaveLength(8);
    expect(aiActSystemRevisionSchema.parse(fixture('ai-system-revision.v1.fixture.json')).revision).toBe(3);
    expect(aiActProductionRunBindingSchema.parse(fixture('production-run-binding.v1.fixture.json')).executionAuthorized).toBe(true);
    expect(aiActRegistrationReadinessSchema.parse(fixture('registration-readiness.v1.fixture.json')).state).toBe('controls_incomplete');
    expect(aiActComplianceDossierManifestSchema.parse(fixture('compliance-dossier-manifest.v1.fixture.json')).assessmentStatus).toBe('ready_for_independent_review');
  });

  it('accepts the additive dossier v2 fixture while retaining v1 compatibility', () => {
    const v1 = aiActComplianceDossierManifestSchema.parse(fixture('compliance-dossier-manifest.v1.fixture.json'));
    const v2 = aiActComplianceDossierManifestSchema.parse(fixture('compliance-dossier-manifest.v2.fixture.json'));
    expect(v1.schemaVersion).toBe(1);
    expect(v2.schemaVersion).toBe(2);
    if (v2.schemaVersion !== 2) throw new Error('expected dossier v2');
    expect(v2.complianceMatrix.groups).toHaveLength(4);
    expect(v2.complianceMatrix.coverage).toMatchObject({ applicable: 1, satisfied: 1, notApplicable: 3 });
  });

  it('rejects a dossier v2 matrix whose canonical digest was changed', () => {
    const dossier = fixture('compliance-dossier-manifest.v2.fixture.json') as Record<string, unknown>;
    const matrix = dossier.complianceMatrix as Record<string, unknown>;
    expect(aiActComplianceDossierManifestSchema.safeParse({
      ...dossier,
      complianceMatrix: { ...matrix, matrixSha256: '0'.repeat(64) },
    })).toMatchObject({ success: false });
  });

  it('rejects a duplicate control id', () => {
    const catalog = aiActControlCatalogSchema.parse(fixture('control-catalog.v1.fixture.json'));
    const duplicate = { ...catalog, controls: [...catalog.controls, catalog.controls[0]!] };
    expect(aiActControlCatalogSchema.safeParse(duplicate)).toMatchObject({ success: false });
  });

  it('requires an explicit legal basis for a high-risk classification', () => {
    const system = aiActSystemRevisionSchema.parse(fixture('ai-system-revision.v1.fixture.json'));
    const invalid = {
      ...system,
      classification: {
        ...system.classification,
        classification: 'high_risk',
        highRiskBasis: undefined,
      },
    };
    expect(aiActSystemRevisionSchema.safeParse(invalid)).toMatchObject({ success: false });
  });

  it('blocks authorization when the production release gate has blockers', () => {
    const binding = aiActProductionRunBindingSchema.parse(fixture('production-run-binding.v1.fixture.json'));
    const invalid = {
      ...binding,
      releaseGate: {
        ...binding.releaseGate,
        blockingReasons: ['Required evaluation expired.'],
      },
    };
    expect(aiActProductionRunBindingSchema.safeParse(invalid)).toMatchObject({ success: false });
  });

  it('requires SSO for humans and workload identity for automated production runs', () => {
    const binding = aiActProductionRunBindingSchema.parse(fixture('production-run-binding.v1.fixture.json'));
    expect(aiActProductionRunBindingSchema.safeParse({
      ...binding,
      effectiveIdentity: { ...binding.effectiveIdentity, authenticationMethod: 'local' },
    })).toMatchObject({ success: false });
    expect(aiActProductionRunBindingSchema.safeParse({
      ...binding,
      effectiveIdentity: {
        ...binding.effectiveIdentity,
        actorType: 'service',
        authenticationMethod: 'api_key',
      },
    })).toMatchObject({ success: false });
  });

  it('requires readiness and dossier coverage to account for every applicable control', () => {
    const readiness = aiActRegistrationReadinessSchema.parse(fixture('registration-readiness.v1.fixture.json'));
    expect(aiActRegistrationReadinessSchema.safeParse({
      ...readiness,
      evidenceCoverage: { ...readiness.evidenceCoverage, applicable: 19 },
    })).toMatchObject({ success: false });

    const dossier = aiActComplianceDossierManifestSchema.parse(fixture('compliance-dossier-manifest.v1.fixture.json'));
    expect(aiActComplianceDossierManifestSchema.safeParse({
      ...dossier,
      controlCoverage: { ...dossier.controlCoverage, satisfied: 15 },
    })).toMatchObject({ success: false });
  });

  it('does not permit an automatically derived compliant dossier state', () => {
    const dossier = fixture('compliance-dossier-manifest.v1.fixture.json') as Record<string, unknown>;
    expect(aiActComplianceDossierManifestSchema.safeParse({
      ...dossier,
      assessmentStatus: 'eu_compliant',
    })).toMatchObject({ success: false });
  });
});
