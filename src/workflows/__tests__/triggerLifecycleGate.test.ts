import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type pg from 'pg';
import type { Express, RequestHandler, Request, Response } from 'express';

// Break the transitive langfuse / agentRunner chain that executor.ts pulls in.
jest.mock('../executor.js', () => ({
  executeWorkflow: jest.fn(async () => ({
    status: 'completed',
    stepResults: {},
    durationMs: 0,
    error: null,
  })),
  MAX_SUBWORKFLOW_DEPTH: 5,
}));

import { startTriggerWorker, registerWebhookTriggerRoute, normalizeScheduledWorkflowInputs } from '../triggerWorker.js';
import type { StepRunners } from '../executor.js';
import type { ToolRunner } from '../types.js';

/** Fake pool that records every SQL string and returns no rows. */
function recordingPool(): { pool: pg.Pool; sqls: string[] } {
  const sqls: string[] = [];
  const pool = {
    query: jest.fn(async (sql: string) => {
      sqls.push(sql);
      // Cross-replica cron-tick dedup claim (audit #3): the INSERT … RETURNING
      // must yield a row so THIS pod "wins" the tick and proceeds to the cron
      // SELECT. Without this the claim returns 0 rows → tick skipped.
      if (sql.includes('mcp_cron_ticks') && sql.includes('INSERT')) {
        return { rows: [{ tick_key: 'test-tick' }] };
      }
      return { rows: [] };
    }),
  } as unknown as pg.Pool;
  return { pool, sqls };
}

const noopToolRunner: ToolRunner = async () => ({ content: [{ type: 'text', text: '' }] });
// startTriggerWorker/registerWebhookTriggerRoute now take a per-execution
// ToolRunnerFactory (audit #1 hooked-runner wiring); these tests only assert
// the SQL lifecycle filter, so a constant factory is sufficient.
const noopFactory = () => noopToolRunner;
const noopRunners = {} as StepRunners;

describe('ITEM 6 — lifecycle gate on triggers (F3)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('cron query filters to lifecycle_status = production', async () => {
    const { pool, sqls } = recordingPool();
    const timer = startTriggerWorker(pool, noopFactory, noopRunners);
    // First interval fire triggers runCronTick → the cron SELECT.
    await jest.advanceTimersByTimeAsync(60_000);
    clearInterval(timer);

    const cronSql = sqls.find((s) => s.includes("trigger_config @> '{\"type\":\"cron\"}'::jsonb"));
    expect(cronSql).toBeDefined();
    // A 'draft' workflow must be excluded by the SQL itself.
    expect(cronSql).toContain("lifecycle_status = 'production'");
  });

  it('normalizes configured schedule inputs without accepting arrays', () => {
    expect(normalizeScheduledWorkflowInputs({
      type: 'cron',
      cron_expr: '* * * * *',
      static_inputs: { repository_owner: 'argus', issue_number: 7 },
    })).toEqual({ repository_owner: 'argus', issue_number: 7 });
    expect(normalizeScheduledWorkflowInputs({
      type: 'cron',
      cron_expr: '* * * * *',
      static_inputs: [] as unknown as Record<string, unknown>,
    })).toEqual({});
  });

  it('webhook lookup query filters to lifecycle_status = production', async () => {
    const { pool, sqls } = recordingPool();
    let handler: RequestHandler | undefined;
    const fakeApp = {
      // The route now registers [signature-middleware, handler]; capture the
      // LAST arg (the actual handler) so this SQL-filter test bypasses the HMAC.
      post: (_path: string, ...handlers: RequestHandler[]) => { handler = handlers[handlers.length - 1]; },
    } as unknown as Express;

    registerWebhookTriggerRoute(fakeApp, pool, noopFactory, noopRunners);
    expect(handler).toBeDefined();

    const req = { params: { slug: 'deploy' }, body: {} } as unknown as Request;
    const res = { status: () => res, json: () => res } as unknown as Response;
    await handler!(req, res, () => {});

    const webhookSql = sqls.find((s) => s.includes('trigger_config @> $1::jsonb'));
    expect(webhookSql).toBeDefined();
    expect(webhookSql).toContain("lifecycle_status = 'production'");
  });
});
