import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { describeLiveDb } from '../../__tests__/helpers/liveDb.js';
import pg from 'pg';
import { createWorkflow, deleteWorkflow } from '../workflowStore.js';

// Regression: POST /api/admin/workflows used to 500 with
// "null value in column \"steps\" violates not-null constraint" when the
// create payload omitted `steps`/`input_params` (the in-builder "New Workflow"
// + the list create both send only name/description). createWorkflow must
// default both JSONB columns to [].
describeLiveDb('createWorkflow — minimal payload defaults', () => {
  let pool: pg.Pool;
  let createdId: number | undefined;

  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env['POSTGRES_CONNECTION_URL']
        ?? 'postgresql://aiops:aiops123@localhost:5432/aiops',
    });
  });

  afterAll(async () => {
    if (createdId) { await deleteWorkflow(pool, createdId).catch(() => {}); }
    await pool.end();
  });

  it('defaults steps + input_params to [] when omitted (no NOT-NULL violation)', async () => {
    const wf = await createWorkflow(pool, {
      name: 'test_minimal_create_' + Date.now(),
      description: '',
    });
    createdId = wf.id;
    expect(wf.id).toBeGreaterThan(0);
    expect(Array.isArray(wf.steps)).toBe(true);
    expect(wf.steps).toHaveLength(0);
    expect(Array.isArray(wf.input_params)).toBe(true);
    expect(wf.input_params).toHaveLength(0);
  });
});
