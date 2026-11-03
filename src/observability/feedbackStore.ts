import type pg from 'pg';

export type FeedbackSource = 'human' | 'model' | 'policy' | 'import';
export type FeedbackSentiment = 'positive' | 'neutral' | 'negative' | 'mixed';

export interface TraceFeedbackRow extends pg.QueryResultRow {
  id: number;
  trace_id: string;
  span_id: string | null;
  source: FeedbackSource;
  label: string;
  score: number | string | null;
  sentiment: FeedbackSentiment | null;
  comment: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  created_by_user_id: number | null;
  created_by_name: string | null;
  external_id: string | null;
  supersedes_id: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface HumanFeedbackInput {
  traceId: string;
  spanId?: string | null;
  label: string;
  score?: number | null;
  sentiment?: FeedbackSentiment | null;
  comment?: string | null;
  tags?: string[];
  /** Server-owned context used to bind specialized feedback to immutable evidence. */
  metadata?: Record<string, unknown>;
  userId: number;
}

export interface SystemFeedbackInput {
  traceId: string;
  spanId?: string | null;
  source: Exclude<FeedbackSource, 'human'>;
  label: string;
  score?: number | null;
  sentiment?: FeedbackSentiment | null;
  comment?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  externalId: string;
}

const returning = `RETURNING id, trace_id, span_id, source, label, score, sentiment,
  comment, tags, metadata, created_by_user_id, NULL::text AS created_by_name,
  external_id, supersedes_id, active, created_at, updated_at`;

export async function submitHumanFeedbackTransaction(
  client: Pick<pg.PoolClient, 'query'>,
  input: HumanFeedbackInput,
): Promise<TraceFeedbackRow> {
    const lockKey = `${input.traceId}:${input.spanId ?? 'trace'}:${input.label}:${input.userId}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
    const previous = await client.query<{ id: number }>(
      `SELECT id FROM mcp_observability_feedback
        WHERE trace_id=$1::uuid AND span_id IS NOT DISTINCT FROM $2::uuid
          AND source='human' AND label=$3 AND created_by_user_id=$4 AND active
        ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
      [input.traceId, input.spanId ?? null, input.label, input.userId],
    );
    const supersedesId = previous.rows[0]?.id ?? null;
    if (supersedesId != null) {
      await client.query(
        'UPDATE mcp_observability_feedback SET active=false, updated_at=now() WHERE id=$1',
        [supersedesId],
      );
    }
    const inserted = await client.query<TraceFeedbackRow>(
      `INSERT INTO mcp_observability_feedback
        (trace_id, span_id, source, label, score, sentiment, comment, tags, metadata,
         created_by_user_id, supersedes_id)
       VALUES ($1::uuid,$2::uuid,'human',$3,$4,$5,$6,$7::text[],$8::jsonb,$9,$10)
       ${returning}`,
      [
        input.traceId, input.spanId ?? null, input.label, input.score ?? null,
        input.sentiment ?? null, input.comment ?? null, input.tags ?? [],
        JSON.stringify(input.metadata ?? {}), input.userId, supersedesId,
      ],
    );
    return inserted.rows[0]!;
}

export async function submitHumanFeedback(pool: pg.Pool, input: HumanFeedbackInput): Promise<TraceFeedbackRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await submitHumanFeedbackTransaction(client, input);
    await client.query('COMMIT');
    return inserted;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertSystemFeedback(pool: pg.Pool, input: SystemFeedbackInput): Promise<TraceFeedbackRow> {
  const result = await pool.query<TraceFeedbackRow>(
    `INSERT INTO mcp_observability_feedback
      (trace_id, span_id, source, label, score, sentiment, comment, tags, metadata, external_id)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::text[],$9::jsonb,$10)
     ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE
       SET score=EXCLUDED.score, sentiment=EXCLUDED.sentiment,
           comment=EXCLUDED.comment, tags=EXCLUDED.tags,
           metadata=EXCLUDED.metadata, active=true, updated_at=now()
     ${returning}`,
    [
      input.traceId, input.spanId ?? null, input.source, input.label,
      input.score ?? null, input.sentiment ?? null, input.comment ?? null,
      input.tags ?? [], JSON.stringify(input.metadata ?? {}), input.externalId,
    ],
  );
  return result.rows[0]!;
}

export async function listTraceFeedback(pool: pg.Pool, traceId: string): Promise<TraceFeedbackRow[]> {
  const result = await pool.query<TraceFeedbackRow>(
    `SELECT feedback.*, user_account.display_name AS created_by_name
       FROM mcp_observability_feedback feedback
       LEFT JOIN mcp_users user_account ON user_account.id=feedback.created_by_user_id
      WHERE feedback.trace_id=$1::uuid AND feedback.active
      ORDER BY feedback.created_at DESC, feedback.id DESC
      LIMIT 500`,
    [traceId],
  );
  return result.rows;
}

export function summarizeTraceFeedback(rows: TraceFeedbackRow[]) {
  const scored = rows.filter(row => row.score != null);
  const sentiments = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  for (const row of rows) if (row.sentiment) sentiments[row.sentiment] += 1;
  const byLabel = new Map<string, { count: number; total: number; scored: number; human: number; model: number }>();
  for (const row of rows) {
    const aggregate = byLabel.get(row.label) ?? { count: 0, total: 0, scored: 0, human: 0, model: 0 };
    aggregate.count += 1;
    if (row.score != null) { aggregate.total += Number(row.score); aggregate.scored += 1; }
    if (row.source === 'human') aggregate.human += 1;
    if (row.source === 'model') aggregate.model += 1;
    byLabel.set(row.label, aggregate);
  }
  return {
    activeCount: rows.length,
    humanCount: rows.filter(row => row.source === 'human').length,
    modelCount: rows.filter(row => row.source === 'model').length,
    averageScore: scored.length
      ? scored.reduce((total, row) => total + Number(row.score), 0) / scored.length
      : null,
    sentiments,
    labels: [...byLabel.entries()].map(([label, aggregate]) => ({
      label,
      count: aggregate.count,
      humanCount: aggregate.human,
      modelCount: aggregate.model,
      averageScore: aggregate.scored ? aggregate.total / aggregate.scored : null,
    })).sort((left, right) => left.label.localeCompare(right.label)),
  };
}
