import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  submitHumanFeedback,
  summarizeTraceFeedback,
  upsertSystemFeedback,
  type TraceFeedbackRow,
} from '../feedbackStore.js';

const baseRow = (overrides: Partial<TraceFeedbackRow> = {}): TraceFeedbackRow => ({
  id: 1,
  trace_id: '11111111-1111-4111-8111-111111111111',
  span_id: null,
  source: 'human',
  label: 'overall',
  score: '1.00000',
  sentiment: 'positive',
  comment: 'Correct result',
  tags: ['accurate'],
  metadata: {},
  created_by_user_id: 7,
  created_by_name: 'Reviewer',
  external_id: null,
  supersedes_id: null,
  active: true,
  created_at: '2026-08-01T10:00:00.000Z',
  updated_at: '2026-08-01T10:00:00.000Z',
  ...overrides,
});

describe('native trace feedback store', () => {
  it('aggregates human and model quality dimensions', () => {
    const result = summarizeTraceFeedback([
      baseRow(),
      baseRow({ id: 2, source: 'model', label: 'helpfulness', score: '0.80000', sentiment: 'positive', created_by_user_id: null }),
      baseRow({ id: 3, source: 'model', label: 'groundedness', score: '0.40000', sentiment: 'negative', created_by_user_id: null }),
    ]);

    expect(result.activeCount).toBe(3);
    expect(result.humanCount).toBe(1);
    expect(result.modelCount).toBe(2);
    expect(result.averageScore).toBeCloseTo(0.7333, 3);
    expect(result.sentiments).toEqual({ positive: 2, neutral: 0, negative: 1, mixed: 0 });
    expect(result.labels.find(label => label.label === 'helpfulness')).toMatchObject({ modelCount: 1, averageScore: 0.8 });
  });

  it('retains a human revision and makes only the new row active', async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT id FROM mcp_observability_feedback')) return { rows: [{ id: 41 }] };
        if (sql.includes('INSERT INTO mcp_observability_feedback')) return { rows: [baseRow({ id: 42, supersedes_id: 41 })] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;

    const inserted = await submitHumanFeedback(pool, {
      traceId: baseRow().trace_id,
      label: 'overall',
      score: 1,
      sentiment: 'positive',
      comment: 'Correct result',
      tags: ['accurate'],
      metadata: { kind: 'aiops_rca_review', taskLinkId: 15 },
      userId: 7,
    });

    expect(inserted.supersedes_id).toBe(41);
    expect(queries.some(call => call.sql.includes('SET active=false') && call.params?.[0] === 41)).toBe(true);
    expect(queries.find(call => call.sql.includes('INSERT INTO mcp_observability_feedback'))?.params?.[7])
      .toBe(JSON.stringify({ kind: 'aiops_rca_review', taskLinkId: 15 }));
    expect(queries.map(call => call.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'SELECT', 'UPDATE', 'INSERT', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('upserts model feedback with a producer-owned idempotency key', async () => {
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain('ON CONFLICT (external_id)');
      expect(params?.[9]).toBe('continuous-eval:11111111-1111-4111-8111-111111111111:overall');
      return { rows: [baseRow({ source: 'model', external_id: String(params?.[9]), created_by_user_id: null })] };
    });
    const pool = { query } as unknown as pg.Pool;

    const inserted = await upsertSystemFeedback(pool, {
      traceId: baseRow().trace_id,
      source: 'model',
      label: 'overall',
      score: 0.9,
      sentiment: 'positive',
      externalId: 'continuous-eval:11111111-1111-4111-8111-111111111111:overall',
    });

    expect(inserted.source).toBe('model');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
