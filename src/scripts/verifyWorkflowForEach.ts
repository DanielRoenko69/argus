import 'dotenv/config';
import pg from 'pg';
import { executeWorkflow } from '../workflows/executor.js';
import { persistExecutionResult } from '../workflows/executionPersistence.js';
import type { WorkflowInputParam, WorkflowRow, WorkflowStep } from '../workflows/types.js';
import { flushTelemetryWrites, workflowTelemetryTraceId } from '../observability/telemetryStore.js';
import { setSharedPool } from '../lib/sharedPool.js';

const TEMPLATE_NAME = 'tpl_for_each_pipeline';
const INPUTS = {
  environment: 'prototype',
  services_csv: 'checkout-api,payments-worker,portal-web',
};

interface TemplateRow extends pg.QueryResultRow {
  id: number;
  name: string;
  description: string;
  steps: WorkflowStep[];
  input_params: WorkflowInputParam[];
  enabled: boolean;
}

async function main(): Promise<void> {
  const connectionString = process.env['POSTGRES_CONNECTION_URL'];
  if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL is required');

  const pool = new pg.Pool({ connectionString });
  setSharedPool(pool);
  try {
    const templateResult = await pool.query<TemplateRow>(
      `SELECT id, name, description, steps, input_params, enabled
         FROM mcp_workflows
        WHERE name=$1 AND source='template'`,
      [TEMPLATE_NAME],
    );
    const template = templateResult.rows[0];
    if (!template) throw new Error(`Workflow template '${TEMPLATE_NAME}' is not installed`);

    const executionResult = await pool.query<{ id: number }>(
      `INSERT INTO mcp_workflow_executions
         (workflow_id, status, triggered_by, input_args, execution_snapshot)
       VALUES ($1, 'running', 'verification:for-each', $2::jsonb, '{}'::jsonb)
       RETURNING id`,
      [template.id, JSON.stringify(INPUTS)],
    );
    const executionId = executionResult.rows[0]!.id;
    const workflow: WorkflowRow = {
      ...template,
      bundle_ids: [],
      created_by: null,
      created_at: '',
      updated_at: '',
    };
    const result = await executeWorkflow({
      workflow,
      inputs: INPUTS,
      toolRunner: async () => {
        throw new Error('For Each verification must not call tools');
      },
      executionId,
      triggeredBy: 'verification:for-each',
    });
    await persistExecutionResult(pool, executionId, result);
    await flushTelemetryWrites();

    const response = result.stepResults['response']?.result as {
      total?: number;
      succeeded?: number;
      failed?: number;
      values?: unknown[];
    } | undefined;
    if (result.status !== 'completed') {
      throw new Error(`Verification execution #${executionId} ${result.status}: ${result.error ?? 'unknown error'}`);
    }
    if (response?.total !== 3 || response.succeeded !== 3 || response.failed !== 0) {
      throw new Error(`Verification execution #${executionId} returned unexpected For Each counters`);
    }
    const expected = [
      { position: 1, service: 'checkout-api', environment: 'prototype', health_path: '/health/checkout-api', correlation_key: 'prototype:checkout-api' },
      { position: 2, service: 'payments-worker', environment: 'prototype', health_path: '/health/payments-worker', correlation_key: 'prototype:payments-worker' },
      { position: 3, service: 'portal-web', environment: 'prototype', health_path: '/health/portal-web', correlation_key: 'prototype:portal-web' },
    ];
    if (JSON.stringify(response.values) !== JSON.stringify(expected)) {
      throw new Error(`Verification execution #${executionId} did not retain ordered item results`);
    }

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      templateId: template.id,
      executionId,
      traceId: workflowTelemetryTraceId(executionId),
      inputs: INPUTS,
      response,
    }, null, 2)}\n`);
  } finally {
    setSharedPool(null);
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
