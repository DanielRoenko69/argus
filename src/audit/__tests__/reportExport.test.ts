import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { auditReportArtifact, auditReportPdf } from '../reportExport.js';
import type { AuditReportRun } from '../reportTypes.js';

const run = {
  id: '11111111-1111-4111-8111-111111111111', definitionId: null,
  workspaceKey: 'default', tenantKey: 'default', environment: 'production', reportType: 'governance',
  name: 'General platform governance report', triggerType: 'manual', requestedBy: '7', status: 'completed',
  periodFrom: '2026-08-01T00:00:00.000Z', periodTo: '2026-09-01T00:00:00.000Z', filters: {},
  checkpointId: 'checkpoint-1', packId: 'pack-1', packDigest: 'a'.repeat(64), verificationState: 'valid',
  eventCount: 3, chainEntryCount: 3, gapCodes: ['external_timestamp_missing'],
  summary: {
    title: 'General platform governance report', period: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    eventCount: 3, actorCount: 2, successCount: 2, deniedCount: 1, failureCount: 0, criticalRiskCount: 0,
    topActions: [{ action: 'approval.runtime.approved', count: 2 }],
    controlCoverage: [{ framework: 'EU AI Act', control: 'Article 12', evidence: 'Canonical event chain' }],
    gapCodes: ['external_timestamp_missing'],
  },
  evidencePack: {
    schemaVersion: 1,
    manifest: { declaredGaps: [{ code: 'external_timestamp_missing', description: 'No external timestamp authority configured.' }] },
    verificationKey: { keyId: 'key-1' },
    artifacts: { eventsJsonl: '{"id":"event-1"}\n', eventsCsv: 'id,action\nevent-1,approval.runtime.approved\n' },
  },
  errorCode: null, errorMessage: null, startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  reviews: [{ id: 'review-added-later', decision: 'approved', actorId: '7', actorAuthMethod: 'oidc', occurredAt: '2026-09-01T01:00:00.000Z', auditEventId: 'review-event' }],
} as unknown as AuditReportRun;

describe('audit report exports', () => {
  it('keeps JSON deterministic by excluding the append-only review ledger', () => {
    const first = auditReportArtifact(run, 'json');
    const second = auditReportArtifact({ ...run, reviews: [] }, 'json');
    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({ schemaVersion: 1, report: { id: run.id }, evidencePack: { schemaVersion: 1 } });
    expect(JSON.parse(first).report.reviews).toBeUndefined();
  });

  it('returns the exact immutable Evidence Pack event projections for JSONL and CSV', () => {
    expect(auditReportArtifact(run, 'jsonl')).toBe('{"id":"event-1"}\n');
    expect(auditReportArtifact(run, 'csv')).toBe('id,action\nevent-1,approval.runtime.approved\n');
  });

  it('renders a byte-stable PDF with a valid signature', async () => {
    const first = await auditReportPdf(run);
    const second = await auditReportPdf(run);
    expect(first.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(createHash('sha256').update(first).digest('hex')).toBe(createHash('sha256').update(second).digest('hex'));
  });
});
