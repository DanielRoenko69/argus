import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
  appendCanonicalAuditEvent: jest.fn(),
}));
jest.mock('../../audit/evidencePack.js', () => ({
  verifyAuditEvidencePack: jest.fn(() => ({
    state: 'valid', packId: '20000000-0000-4000-8000-000000000002',
    verifiedEvents: 1, verifiedChainEntries: 1, reasons: [],
  })),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import type { AuditEvidencePackV1 } from '../../audit/evidencePack.js';
import { aiActSystemRevisionSchema } from '../aiActContracts.js';
import { AI_ACT_CONTROL_CATALOG } from '../aiActControlCatalog.js';
import { generateAiComplianceDossierAudited, type AiComplianceDossierContext } from '../aiComplianceDossier.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
const baseRevision = aiActSystemRevisionSchema.parse(JSON.parse(readFileSync(resolve(
  process.cwd(), 'docs/specs/ai-act-compliance/ai-system-revision.v1.fixture.json',
), 'utf8')));
const sourceRevision = aiActSystemRevisionSchema.parse({
  ...baseRevision,
  lifecycleState: 'ready_for_independent_review',
});
const revision = aiActSystemRevisionSchema.parse({
  ...baseRevision,
  revisionId: '10000000-0000-4000-8000-000000000009',
  revision: baseRevision.revision + 1,
  revisionSha256: '9'.repeat(64),
  lifecycleState: 'released',
  releasedAt: '2026-09-09T11:30:00.000Z',
});

const summary = {
  title: 'AI release evidence',
  period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-09T11:00:00.000Z' },
  eventCount: 1, actorCount: 1, successCount: 1, deniedCount: 0, failureCount: 0,
  criticalRiskCount: 1, topActions: [{ action: 'audit.evidence_pack.exported', count: 1 }],
  controlCoverage: [{ framework: 'EU AI Act', control: 'Article 12', evidence: 'signed canonical audit chain' }],
  gapCodes: [],
};

const pack = {
  schemaVersion: 1,
  kind: 'argus.audit.evidence-pack',
  manifest: {
    packId: '20000000-0000-4000-8000-000000000002',
    generatedAt: '2026-09-09T11:05:00.000Z',
    generatedBy: { actorId: 'reviewer', authMethod: 'oidc' },
    scope: { workspaceKey: 'default', tenantKey: 'default', environment: 'production' },
    selection: { from: null, to: null, actorId: null, action: null, resourceType: null, resourceId: null, throughCheckpointSequence: 1 },
    eventCount: 1, chainEntryCount: 1, formats: ['json', 'jsonl', 'csv'],
    controlMapping: [], declaredGaps: [],
  },
  checkpoint: {
    checkpointId: '20000000-0000-4000-8000-000000000003',
    schemaVersion: 1, checkpointSequence: 1, createdAt: '2026-09-09T11:04:00.000Z',
    workspaceKey: 'default', tenantKey: 'default', environment: 'production',
    lastSequence: 1, lastEventId: '30000000-0000-4000-8000-000000000001',
    lastEventHash: 'a'.repeat(64), previousCheckpointDigest: '', eventCount: 1,
    keyId: 'test-key', algorithm: 'Ed25519', publicKeyFingerprint: 'b'.repeat(64),
    checkpointDigest: 'c'.repeat(64), signature: Buffer.from('signed-checkpoint').toString('base64url'), replayed: false,
  },
  verificationKey: { keyId: 'test-key', algorithm: 'Ed25519', publicKeyFingerprint: 'b'.repeat(64), publicKeyPem: 'public-key' },
  chain: [], chainEvents: [], events: [], schemaDictionary: {},
  artifacts: { eventsJsonl: '', eventsCsv: '' },
  packDigest: 'd'.repeat(64),
} as unknown as AuditEvidencePackV1;

function context(): AiComplianceDossierContext {
  return {
    scope: { workspaceKey: 'default', tenantKey: 'default', environment: 'production' },
    actor: { type: 'human', id: 'alex', ssoSubject: 'oidc:alex', authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
    producerEventId: 'dossier-generate-1', requestId: 'request-1',
    now: () => new Date('2026-09-09T12:00:00.000Z'),
    uuid: () => '60000000-0000-4000-8000-000000000001',
  };
}

function client(bound = true) {
  const inserts: unknown[][] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/source_revision_json/i.test(sql)) return { rows: [{ source_revision_json: sourceRevision }], rowCount: 1 };
    if (/SELECT revision\.revision_json/i.test(sql)) return { rows: [{ revision_json: revision }], rowCount: 1 };
    if (/FROM mcp_audit_report_runs/i.test(sql)) return { rows: [{
      id: '70000000-0000-4000-8000-000000000001', report_type: 'compliance', name_snapshot: 'Release evidence',
      period_from: '2026-09-01T00:00:00.000Z', period_to: '2026-09-09T11:00:00.000Z',
      pack_id: pack.manifest.packId, pack_digest: pack.packDigest, summary, evidence_pack: pack,
    }], rowCount: 1 };
    if (/FROM mcp_ai_system_governance_decisions/i.test(sql)) return { rows: [{
      decision_id: '80000000-0000-4000-8000-000000000001',
      decision_json: { evidence: bound ? [{ evidenceType: 'report', evidenceId: '70000000-0000-4000-8000-000000000001', sha256: pack.packDigest }] : [] },
      event_id: '90000000-0000-4000-8000-000000000001', event_hash: 'e'.repeat(64),
    }], rowCount: 1 };
    if (/SELECT DISTINCT ON \(control_id\) assessment_json/i.test(sql)) return {
      rows: AI_ACT_CONTROL_CATALOG.controls.map((control, index) => ({ assessment_json: {
        assessmentId: `81000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        assessmentSha256: String(index + 1).repeat(64).slice(0, 64),
        controlId: control.controlId,
        status: 'satisfied',
        reassessmentAt: '2027-09-09T12:00:00.000Z',
        exception: null,
      } })),
      rowCount: AI_ACT_CONTROL_CATALOG.controls.length,
    };
    if (/INSERT INTO mcp_ai_compliance_dossiers/i.test(sql)) { inserts.push(params); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  });
  return { query, inserts };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('AI compliance dossier builder', () => {
  it('freezes a released revision and release-bound verified pack into an immutable manifest', async () => {
    const database = client();
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(database as unknown as pg.PoolClient);
      const event = eventFor(result);
      return { event: { ...event, eventId: 'a0000000-0000-4000-8000-000000000001', eventHash: 'f'.repeat(64) } as never, replayed: false, result };
    });

    const result = await generateAiComplianceDossierAudited({} as pg.Pool, context(), revision.aiSystemId, {
      expectedRevision: revision.revision,
      expectedRevisionSha256: revision.revisionSha256,
      sourceReportRunId: '70000000-0000-4000-8000-000000000001',
    });

    expect(result.verification).toEqual({ state: 'valid', reasons: [], sourceEvidencePackState: 'valid' });
    expect(result.manifest).toMatchObject({
      schemaVersion: 2,
      dossierId: '60000000-0000-4000-8000-000000000001',
      assessmentStatus: 'controls_incomplete',
      aiSystem: { aiSystemId: revision.aiSystemId, revision: revision.revision },
      sourceEvidencePack: { evidencePackId: pack.manifest.packId, sha256: pack.packDigest },
      controlCoverage: { applicable: 2, satisfied: 2, open: 0, exceptions: 0, expired: 0 },
      complianceMatrix: {
        schemaVersion: 2,
        kind: 'argus.ai-compliance-obligation-matrix',
        legalBaseline: { legalReviewRequired: true },
      },
    });
    expect(result.manifest.sections.map(item => item.sectionId)).toContain('legal-control-ledger');
    expect(result.manifest.artifacts.map(item => item.format)).toEqual(['json', 'pdf', 'signature']);
    expect(result.manifest.declaredGaps.map(item => item.gapId)).toEqual(expect.arrayContaining([
      'external-worm-anchor-not-configured',
      'qualified-timestamp-not-configured',
    ]));
    expect(database.inserts).toHaveLength(1);
  });

  it('rejects a valid report that is not connected to the exact release decision', async () => {
    const database = client(false);
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate) => {
      const result = await mutate(database as unknown as pg.PoolClient);
      return { event: {} as never, replayed: false, result };
    });

    await expect(generateAiComplianceDossierAudited({} as pg.Pool, context(), revision.aiSystemId, {
      expectedRevision: revision.revision,
      expectedRevisionSha256: revision.revisionSha256,
      sourceReportRunId: '70000000-0000-4000-8000-000000000001',
    })).rejects.toMatchObject({ code: 'AI_DOSSIER_SOURCE_NOT_RELEASE_BOUND', status: 422 });
    expect(database.inserts).toHaveLength(0);
  });

  it('requires SSO identity even when a caller reached the service directly', async () => {
    const invalid = context();
    invalid.actor = { ...invalid.actor, authMethod: 'session', ssoSubject: null };
    await expect(generateAiComplianceDossierAudited({} as pg.Pool, invalid, revision.aiSystemId, {
      expectedRevision: revision.revision,
      expectedRevisionSha256: revision.revisionSha256,
      sourceReportRunId: '70000000-0000-4000-8000-000000000001',
    })).rejects.toMatchObject({ code: 'AI_DOSSIER_SSO_REQUIRED', status: 403 });
    expect(executeMock).not.toHaveBeenCalled();
  });
});
