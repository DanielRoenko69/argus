import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import {
  aiActClassificationDecisionInputSchema,
  aiActReleaseDecisionInputSchema,
  aiActRevisionDecisionInputSchema,
  aiActSystemRevisionSchema,
  type AiActSystemRevision,
} from '../aiActContracts.js';
import {
  classifyAiSystemAudited,
  releaseAiSystemAudited,
  reviseAiSystemAudited,
  type AiSystemGovernanceContext,
} from '../aiSystemGovernance.js';
import { AI_ACT_CONTROL_CATALOG } from '../aiActControlCatalog.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

const fixture = aiActSystemRevisionSchema.parse(JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/ai-act-compliance/ai-system-revision.v1.fixture.json',
), 'utf8')));

function ids(): () => string {
  let index = 0;
  return () => `40000000-0000-4000-8000-${String(++index).padStart(12, '0')}`;
}

function context(actorId: string): AiSystemGovernanceContext {
  return {
    scope: { workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'production' },
    actor: {
      type: 'human',
      id: actorId,
      authMethod: 'oidc',
      ssoSubject: `oidc:${actorId}`,
      effectiveRoles: ['platform_admin'],
    },
    producerEventId: `decision-${actorId}`,
    requestId: `request-${actorId}`,
    mfaVerifiedAt: '2026-09-09T11:58:00.000Z',
    mfaMethod: 'otp',
    mfaMaxAgeSeconds: 600,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
    uuid: ids(),
  };
}

function clientFor(current: AiActSystemRevision, createdByActorId = 'author', evidenceFound = true) {
  const query = jest.fn<TestQuery>(async sql => {
    if (/SELECT system\.current_revision/i.test(sql)) {
      return {
        rows: [{
          current_revision: current.revision,
          lifecycle_state: current.lifecycleState,
          revision_json: current,
          created_by_actor_id: createdByActorId,
        }],
        rowCount: 1,
      };
    }
    if (/SELECT DISTINCT ON \(control_id\) assessment_json/i.test(sql)) {
      return {
        rows: AI_ACT_CONTROL_CATALOG.controls.map(definition => ({
          assessment_json: {
            controlId: definition.controlId,
            status: 'satisfied',
            reassessmentAt: '2027-09-09T12:00:00.000Z',
            exception: null,
          },
        })),
        rowCount: AI_ACT_CONTROL_CATALOG.controls.length,
      };
    }
    if (/SELECT 1 FROM mcp_canonical_audit_events/i.test(sql)) {
      return evidenceFound
        ? { rows: [{ '?column?': 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  return { query };
}

function executeMutation(client: ReturnType<typeof clientFor>): void {
  executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
    const result = await mutate(client as unknown as pg.PoolClient);
    const event = eventFor(result);
    return { event: event as never, replayed: false, result };
  });
}

const revisionInput = aiActRevisionDecisionInputSchema.parse({
  expectedRevision: fixture.revision,
  expectedRevisionSha256: fixture.revisionSha256,
  changeSummary: 'Move the governed workflow to a new immutable component revision.',
  displayName: fixture.displayName,
  intendedPurpose: fixture.intendedPurpose,
  prohibitedUses: fixture.prohibitedUses,
  targetUsers: fixture.targetUsers,
  affectedGroups: fixture.affectedGroups,
  regions: fixture.regions,
  marketRoles: fixture.marketRoles.map(({ confirmedBy: _confirmedBy, confirmedAt: _confirmedAt, ...role }) => role),
  componentBindings: fixture.componentBindings,
  dataCategories: fixture.dataCategories,
  controlCatalog: fixture.controlCatalog,
});

const classificationInput = aiActClassificationDecisionInputSchema.parse({
  expectedRevision: fixture.revision,
  expectedRevisionSha256: fixture.revisionSha256,
  prohibitedPracticeCheck: {
    decision: 'clear',
    articleRefs: ['Article 5'],
    rationale: 'The bounded coding purpose does not contain a prohibited practice.',
  },
  classification: {
    classification: 'minimal_or_no_risk',
    articleRefs: ['Article 6'],
    annexRefs: [],
    rationale: 'The bounded coding purpose is outside Annex III decision use cases.',
    legalReviewRequired: true,
    nextReviewAt: '2026-12-09T12:00:00.000Z',
  },
});

const releaseInput = aiActReleaseDecisionInputSchema.parse({
  expectedRevision: fixture.revision,
  expectedRevisionSha256: fixture.revisionSha256,
  decisionRationale: 'The independent evidence review is complete.',
  evidence: [{
    evidenceType: 'canonical_event',
    evidenceId: '50000000-0000-4000-8000-000000000001',
    sha256: '7'.repeat(64),
  }],
});

beforeEach(() => { jest.clearAllMocks(); });

describe('AI-system governance decisions', () => {
  it('creates a new immutable reassessment revision and canonical evidence', async () => {
    const client = clientFor(fixture);
    executeMutation(client);

    const result = await reviseAiSystemAudited({} as pg.Pool, context('editor'), fixture.aiSystemId, revisionInput);

    expect(result.value).toMatchObject({
      revision: fixture.revision + 1,
      lifecycleState: 'assessment_in_progress',
      prohibitedPracticeCheck: { decision: 'external_review_required' },
      classification: { classification: 'assessment_required' },
    });
    expect(result.value.revisionSha256).not.toBe(fixture.revisionSha256);
    expect(client.query.mock.calls.some(call => /INSERT INTO mcp_ai_system_governance_decisions/i.test(String(call[0])))).toBe(true);
    expect(client.query.mock.calls.some(call => /UPDATE mcp_ai_systems/i.test(String(call[0])))).toBe(true);
  });

  it('forbids the revision author from classifying their own revision', async () => {
    const client = clientFor(fixture, 'reviewer');
    executeMutation(client);

    await expect(classifyAiSystemAudited(
      {} as pg.Pool,
      context('reviewer'),
      fixture.aiSystemId,
      classificationInput,
    )).rejects.toMatchObject({ code: 'AI_SYSTEM_FOUR_EYES_REQUIRED', status: 403 });
    expect(client.query.mock.calls.some(call => /INSERT INTO mcp_ai_system_governance_decisions/i.test(String(call[0])))).toBe(false);
  });

  it('lets a distinct classifier create the independent-review revision', async () => {
    const client = clientFor(fixture, 'author');
    executeMutation(client);

    const result = await classifyAiSystemAudited(
      {} as pg.Pool,
      context('classifier'),
      fixture.aiSystemId,
      classificationInput,
    );

    expect(result.value).toMatchObject({
      revision: fixture.revision + 1,
      lifecycleState: 'ready_for_independent_review',
      classification: { assessedBy: { actorType: 'user', actorId: 'classifier' } },
    });
  });

  it('forbids the classifier from releasing the same revision', async () => {
    const classified = aiActSystemRevisionSchema.parse({
      ...fixture,
      classification: {
        ...fixture.classification,
        assessedBy: { actorType: 'user', actorId: 'classifier' },
      },
    });
    const client = clientFor(classified, 'author');
    executeMutation(client);

    await expect(releaseAiSystemAudited(
      {} as pg.Pool,
      context('classifier'),
      fixture.aiSystemId,
      releaseInput,
    )).rejects.toMatchObject({ code: 'AI_SYSTEM_FOUR_EYES_REQUIRED', status: 403 });
  });

  it('releases only after server-side verification of content-addressed evidence', async () => {
    const client = clientFor(fixture, 'author');
    executeMutation(client);

    const result = await releaseAiSystemAudited(
      {} as pg.Pool,
      context('releaser'),
      fixture.aiSystemId,
      releaseInput,
    );

    expect(result.value).toMatchObject({
      revision: fixture.revision + 1,
      lifecycleState: 'released',
      releasedAt: '2026-09-09T12:00:00.000Z',
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('mcp_canonical_audit_events'),
      [releaseInput.evidence[0]!.evidenceId, releaseInput.evidence[0]!.sha256, 'default', 'tenant-a', 'production'],
    );
    expect(client.query.mock.calls.some(call => /INSERT INTO mcp_ai_system_assessments/i.test(String(call[0])))).toBe(false);
  });

  it('fails closed when release evidence cannot be resolved in the authorized scope', async () => {
    const client = clientFor(fixture, 'author', false);
    executeMutation(client);

    await expect(releaseAiSystemAudited(
      {} as pg.Pool,
      context('releaser'),
      fixture.aiSystemId,
      releaseInput,
    )).rejects.toMatchObject({ code: 'AI_SYSTEM_RELEASE_EVIDENCE_UNVERIFIED', status: 422 });
    expect(client.query.mock.calls.some(call => /INSERT INTO mcp_ai_system_governance_decisions/i.test(String(call[0])))).toBe(false);
  });

  it('fails closed when MFA assurance is stale', async () => {
    const stale = context('reviewer');
    stale.mfaVerifiedAt = '2026-09-09T10:00:00.000Z';

    await expect(classifyAiSystemAudited(
      {} as pg.Pool,
      stale,
      fixture.aiSystemId,
      classificationInput,
    )).rejects.toMatchObject({ code: 'MFA_STEP_UP_REQUIRED', status: 428 });
    expect(executeMock).not.toHaveBeenCalled();
  });
});
