import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  IncidentAiopsFeedbackError,
  PostgresIncidentAiopsFeedbackStore,
} from '../incidentAiopsFeedback.js';

const binding = {
  id: '15',
  incident_id: '81',
  task_id: 'task-aiops-81',
  root_trace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  state: 'TASK_STATE_COMPLETED',
  result_json: { schemaVersion: 1, conclusion: 'confirmed' },
  execution_service: 'checkout-api',
  execution_environment: 'production',
  execution_bundle_ids: ['28'],
  service_profile_id: '12',
  service_profile_revision: '3',
  service_profile_sha256: 'd'.repeat(64),
};

describe('PostgresIncidentAiopsFeedbackStore', () => {
  it('returns active reviews bound to the task trace and immutable profile revision', async () => {
    const query = jest.fn<pg.Pool['query']>()
      .mockResolvedValueOnce({ rows: [binding] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: '51', trace_id: binding.root_trace_id, span_id: null, source: 'human', label: 'aiops.rca.15',
        score: '1.00000', sentiment: 'positive', comment: 'Evidence matched the incident.', tags: ['aiops'],
        metadata: { verdict: 'helpful', reason: 'accurate_root_cause', taskLinkId: 15 },
        created_by_user_id: '7', reviewer_name: 'Alex', created_by_name: 'Alex', external_id: null,
        supersedes_id: '49', active: true,
        created_at: '2026-09-09T10:10:00.000Z', updated_at: '2026-09-09T10:10:00.000Z',
      }, {
        id: '52', trace_id: binding.root_trace_id, span_id: null, source: 'human', label: 'aiops.rca.15',
        score: '0.50000', sentiment: 'mixed', comment: null, tags: ['aiops'],
        metadata: { verdict: 'partial', reason: 'incomplete_evidence', taskLinkId: 15 },
        created_by_user_id: '8', reviewer_name: 'Sam', created_by_name: 'Sam', external_id: null,
        supersedes_id: null, active: true,
        created_at: '2026-09-09T10:09:00.000Z', updated_at: '2026-09-09T10:09:00.000Z',
      }] } as never);
    const store = new PostgresIncidentAiopsFeedbackStore({ query } as unknown as pg.Pool);

    const result = await store.list(81, 15, { userId: 7, allowedBundleIds: [28] });

    expect(result).toMatchObject({
      incidentId: 81,
      taskLinkId: 15,
      taskId: 'task-aiops-81',
      rootTraceId: binding.root_trace_id,
      serviceProfile: { id: 12, revision: 3, sha256: 'd'.repeat(64) },
      currentUserFeedback: { id: 51, verdict: 'helpful', reason: 'accurate_root_cause', reviewer: { id: 7, name: 'Alex' } },
      summary: { reviews: 2, helpful: 1, partial: 1, incorrect: 0, helpfulPercent: 50 },
    });
    expect(String(query.mock.calls[1]?.[0])).toContain("feedback.label=$2");
    expect(query.mock.calls[1]?.[1]).toEqual([binding.root_trace_id, 'aiops.rca.15']);
  });

  it('rejects a reviewer outside the investigation bundle scope', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValueOnce({ rows: [binding] } as never);
    const store = new PostgresIncidentAiopsFeedbackStore({ query } as unknown as pg.Pool);

    await expect(store.list(81, 15, { userId: 7, allowedBundleIds: [9] }))
      .rejects.toMatchObject({ status: 403, code: 'feedback_forbidden' } satisfies Partial<IncidentAiopsFeedbackError>);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('requires a completed structured result and Root Trace before review', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValueOnce({
      rows: [{ ...binding, root_trace_id: null, state: 'TASK_STATE_WORKING', result_json: null }],
    } as never);
    const store = new PostgresIncidentAiopsFeedbackStore({ query } as unknown as pg.Pool);

    await expect(store.list(81, 15, { userId: 7, allowedBundleIds: null }))
      .rejects.toMatchObject({ status: 409, code: 'investigation_not_reviewable' } satisfies Partial<IncidentAiopsFeedbackError>);
  });
});
