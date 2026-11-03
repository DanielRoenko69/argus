import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { aiActSystemRevisionSchema } from '../aiActContracts.js';
import { AI_ACT_CONTROL_CATALOG } from '../aiActControlCatalog.js';
import { aiSystemControlAssessmentInputSchema, getAiSystemControlLedger } from '../aiSystemControlLedger.js';

type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
const revision = aiActSystemRevisionSchema.parse(JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/ai-act-compliance/ai-system-revision.v1.fixture.json',
), 'utf8')));

function queryable(assessments: unknown[] = [], releaseSource: unknown | null = null) {
  return {
    query: jest.fn<TestQuery>(async sql => {
      if (/source_revision_json/i.test(sql)) return { rows: releaseSource ? [{ source_revision_json: releaseSource }] : [], rowCount: releaseSource ? 1 : 0 };
      if (/revision\.revision_json/i.test(sql)) return { rows: [{ revision_json: revision }], rowCount: 1 };
      if (/SELECT DISTINCT ON \(control_id\)/i.test(sql)) return { rows: assessments.map(assessment_json => ({ assessment_json })), rowCount: assessments.length };
      return { rows: [], rowCount: 0 };
    }),
  };
}

describe('AI-system legal control ledger', () => {
  it('fails closed when production-blocking controls have no assessment', async () => {
    const ledger = await getAiSystemControlLedger(queryable() as unknown as pg.Pool, { workspaceKey: 'default', tenantKey: 'default' }, revision.aiSystemId, { now: new Date('2026-09-09T12:00:00.000Z') });
    expect(ledger.releaseReady).toBe(false);
    expect(ledger.blockingReasons).toEqual(expect.arrayContaining([
      expect.stringContaining('AIA-ART5-PROHIBITED-PRACTICES'),
      expect.stringContaining('AIA-ART50-TRANSPARENCY'),
    ]));
    expect(ledger.coverage).toEqual({ applicable: 2, satisfied: 0, open: 2, exceptions: 0, expired: 0 });
  });

  it('becomes release-ready only when all applicable production gates are satisfied and current', async () => {
    const assessments = AI_ACT_CONTROL_CATALOG.controls.map(control => ({
      controlId: control.controlId,
      status: 'satisfied',
      reassessmentAt: '2027-09-09T12:00:00.000Z',
      exception: null,
    }));
    const ledger = await getAiSystemControlLedger(queryable(assessments) as unknown as pg.Pool, { workspaceKey: 'default', tenantKey: 'default' }, revision.aiSystemId, { now: new Date('2026-09-09T12:00:00.000Z') });
    expect(ledger.releaseReady).toBe(true);
    expect(ledger.coverage).toEqual({ applicable: 2, satisfied: 2, open: 0, exceptions: 0, expired: 0 });
  });

  it('retains explicit assessment provenance when release creates a new immutable revision', async () => {
    const assessments = AI_ACT_CONTROL_CATALOG.controls.map(control => ({
      controlId: control.controlId,
      status: 'satisfied',
      reassessmentAt: '2027-09-09T12:00:00.000Z',
      exception: null,
    }));
    const released = aiActSystemRevisionSchema.parse({
      ...revision,
      revisionId: 'b0000000-0000-4000-8000-000000000002',
      revision: revision.revision + 1,
      revisionSha256: 'b'.repeat(64),
      lifecycleState: 'released',
      releasedAt: '2026-09-09T11:59:00.000Z',
    });
    const database = queryable(assessments, revision);
    const ledger = await getAiSystemControlLedger(database as unknown as pg.Pool, { workspaceKey: 'default', tenantKey: 'default' }, released.aiSystemId, { revision: released, now: new Date('2026-09-09T12:00:00.000Z') });

    expect(ledger.revision).toBe(released.revision);
    expect(ledger.assessmentSourceRevision).toEqual({
      revisionId: revision.revisionId,
      revision: revision.revision,
      revisionSha256: revision.revisionSha256,
      relation: 'release_source',
    });
    expect(ledger.releaseReady).toBe(true);
    const assessmentQuery = database.query.mock.calls.find(call => /SELECT DISTINCT ON \(control_id\)/i.test(String(call[0])));
    expect(assessmentQuery?.[1]).toEqual([released.aiSystemId, revision.revision]);
  });

  it('fails closed when a released revision has no immutable release source', async () => {
    const released = aiActSystemRevisionSchema.parse({
      ...revision,
      revisionId: 'b0000000-0000-4000-8000-000000000003',
      revision: revision.revision + 1,
      revisionSha256: 'c'.repeat(64),
      lifecycleState: 'released',
      releasedAt: '2026-09-09T11:59:00.000Z',
    });
    await expect(getAiSystemControlLedger(queryable() as unknown as pg.Pool, { workspaceKey: 'default', tenantKey: 'default' }, released.aiSystemId, { revision: released })).rejects.toMatchObject({
      status: 422,
      code: 'AI_CONTROL_RELEASE_SOURCE_MISSING',
    });
  });

  it('rejects status claims that omit their mandatory evidence or exception record', () => {
    const base = { expectedRevision: 1, expectedRevisionSha256: 'a'.repeat(64), ownerParty: 'provider', ownerId: 'owner-1', dueAt: null, reassessmentAt: null, rationale: 'Reviewed decision.', evidence: [], exception: null };
    expect(aiSystemControlAssessmentInputSchema.safeParse({ ...base, status: 'satisfied' }).success).toBe(false);
    expect(aiSystemControlAssessmentInputSchema.safeParse({ ...base, status: 'exception' }).success).toBe(false);
    expect(aiSystemControlAssessmentInputSchema.safeParse({ ...base, status: 'in_progress' }).success).toBe(true);
  });
});
