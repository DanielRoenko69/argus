import 'dotenv/config';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pg from 'pg';
import type { Config } from '../config/env.js';
import { flushTelemetryWrites, workflowTelemetryTraceId } from '../observability/telemetryStore.js';
import { setSharedPool } from '../lib/sharedPool.js';
import { buildRealRunners, registerExecuteRoutes } from '../workflows/executeRoutes.js';
import { executeWorkflow } from '../workflows/executor.js';
import { persistExecutionResult } from '../workflows/executionPersistence.js';
import type { ToolRunner, WorkflowRow, WorkflowStep } from '../workflows/types.js';

const CHILD_NAME = 'verify_for_each_child_worker';
const PARENT_NAME = 'verify_for_each_parent';

interface WorkflowIdentity extends pg.QueryResultRow {
  id: number | string;
}

interface ChildExecutionRow extends pg.QueryResultRow {
  id: number | string;
  workflow_id: number;
  status: string;
  parent_execution_id: number | string;
  parent_step_id: string;
  parent_item_index: number;
}

interface RetryExecutionRow extends ChildExecutionRow {
  retry_of_execution_id: number | string | null;
  error_message: string | null;
}

const noTools: ToolRunner = async () => {
  throw new Error('Child-run verification must not call MCP tools');
};

async function waitForTerminalExecution(pool: pg.Pool, executionId: number): Promise<RetryExecutionRow> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = (await pool.query<RetryExecutionRow>(
      `SELECT id, workflow_id, status, parent_execution_id, parent_step_id,
              parent_item_index, retry_of_execution_id, error_message
         FROM mcp_workflow_executions
        WHERE id=$1`,
      [executionId],
    )).rows[0];
    if (row && !['running', 'waiting_for_approval'].includes(row.status)) return row;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Child retry execution #${executionId} did not settle within 10 seconds`);
}

async function upsertWorkflow(
  pool: pg.Pool,
  name: string,
  description: string,
  steps: WorkflowStep[],
): Promise<number> {
  const result = await pool.query<WorkflowIdentity>(
    `INSERT INTO mcp_workflows (
       name, description, steps, input_params, enabled, source,
       human_oversight_required, agent_requirements
     )
     VALUES ($1, $2, $3::jsonb, '[]'::jsonb, true, 'workflow', false, '[]'::jsonb)
     ON CONFLICT (tenant_key, workspace_key, name) DO UPDATE SET
       description=EXCLUDED.description,
       steps=EXCLUDED.steps,
       enabled=true,
       source='workflow',
       human_oversight_required=false,
       agent_requirements='[]'::jsonb
     RETURNING id`,
    [name, description, JSON.stringify(steps)],
  );
  const id = Number(result.rows[0]!.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Workflow '${name}' returned an invalid id`);
  return id;
}

async function main(): Promise<void> {
  const connectionString = process.env['POSTGRES_CONNECTION_URL'];
  if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL is required');

  const pool = new pg.Pool({ connectionString });
  let retryServer: Server | undefined;
  setSharedPool(pool);
  try {
    const childId = await upsertWorkflow(pool, CHILD_NAME, '[Verification] Tool-free child used to prove persisted For Each lineage.', [
      { id: 'start', label: 'Child input', type: 'trigger.manual', args: {} },
      {
        id: 'transform', label: 'Normalize child item', type: 'logic.function', depends_on: ['start'], args: {},
        function_code: 'return { position: input.index + 1, service: String(input.item), parent_environment: input.parent_input.environment };',
      },
      { id: 'response', label: 'Child result', type: 'logic.response', depends_on: ['transform'], args: { value: '{{ steps.transform.result }}' } },
    ]);
    const parentId = await upsertWorkflow(pool, PARENT_NAME, '[Verification] Parent fan-out with clickable persisted child executions.', [
      { id: 'start', label: 'Parent input', type: 'trigger.manual', args: {} },
      {
        id: 'foreach', label: 'Run child per service', type: 'logic.for_each', depends_on: ['start'],
        args: {
          mode: 'subworkflow', items: '{{ input.services }}', target_workflow_id: childId,
          child_inputs: {}, concurrency: 2, retries: 0, on_item_error: 'stop',
        },
      },
      { id: 'response', label: 'Child run evidence', type: 'logic.response', depends_on: ['foreach'], args: { value: '{{ steps.foreach.result }}' } },
    ]);

    const inputs = { environment: 'prototype', services: ['checkout-api', 'payments-worker', 'portal-web'] };
    const execution = await pool.query<WorkflowIdentity>(
      `INSERT INTO mcp_workflow_executions
         (workflow_id, status, triggered_by, input_args, execution_snapshot)
       VALUES ($1, 'running', 'verification:child-runs', $2::jsonb, '{}'::jsonb)
       RETURNING id`,
      [parentId, JSON.stringify(inputs)],
    );
    const executionId = Number(execution.rows[0]!.id);
    if (!Number.isSafeInteger(executionId) || executionId <= 0) {
      throw new Error('Parent workflow returned an invalid execution id');
    }
    const parentWorkflow: WorkflowRow = {
      id: parentId,
      name: PARENT_NAME,
      description: 'Persisted child execution verification',
      steps: [
        { id: 'start', label: 'Parent input', type: 'trigger.manual', args: {} },
        {
          id: 'foreach', label: 'Run child per service', type: 'logic.for_each', depends_on: ['start'],
          args: {
            mode: 'subworkflow', items: '{{ input.services }}', target_workflow_id: childId,
            child_inputs: {}, concurrency: 2, retries: 0, on_item_error: 'stop',
          },
        },
        { id: 'response', label: 'Child run evidence', type: 'logic.response', depends_on: ['foreach'], args: { value: '{{ steps.foreach.result }}' } },
      ],
      input_params: [],
      enabled: true,
      bundle_ids: [],
      created_by: null,
      created_at: '',
      updated_at: '',
      human_oversight_required: false,
      agent_requirements: [],
    };
    const runners = buildRealRunners(pool, {} as Config, noTools, new Set([parentId]));
    const result = await executeWorkflow({
      workflow: parentWorkflow,
      inputs,
      toolRunner: noTools,
      runners,
      executionId,
      triggeredBy: 'verification:child-runs',
    });
    await persistExecutionResult(pool, executionId, result);
    await flushTelemetryWrites();
    if (result.status !== 'completed') {
      throw new Error(`Parent execution #${executionId} ${result.status}: ${result.error ?? 'unknown error'}`);
    }

    const children = await pool.query<ChildExecutionRow>(
      `SELECT id, workflow_id, status, parent_execution_id, parent_step_id, parent_item_index
         FROM mcp_workflow_executions
        WHERE parent_execution_id=$1
        ORDER BY parent_item_index, id`,
      [executionId],
    );
    const normalizedChildren = children.rows.map(row => ({
      ...row,
      id: Number(row.id),
      parent_execution_id: Number(row.parent_execution_id),
      parent_item_index: Number(row.parent_item_index),
    }));
    if (normalizedChildren.length !== inputs.services.length) {
      throw new Error(`Expected ${inputs.services.length} child executions, found ${normalizedChildren.length}`);
    }
    if (normalizedChildren.some((row, index) => row.workflow_id !== childId
      || row.status !== 'completed'
      || row.parent_execution_id !== executionId
      || row.parent_step_id !== 'foreach'
      || row.parent_item_index !== index)) {
      throw new Error('Persisted child execution lineage did not match parent step/item ordering');
    }

    const forEach = result.stepResults['foreach']?.result as {
      total?: number;
      succeeded?: number;
      results?: Array<{ evidence?: { execution_id?: number; trace_id?: string } }>;
    } | undefined;
    const evidenceIds = forEach?.results?.map(item => item.evidence?.execution_id) ?? [];
    if (forEach?.total !== 3 || forEach.succeeded !== 3 || JSON.stringify(evidenceIds) !== JSON.stringify(normalizedChildren.map(row => row.id))) {
      throw new Error('Parent For Each output does not reference every persisted child execution');
    }

    // Prove the actual HTTP recovery route against PostgreSQL. The parent is
    // immutable and completed with one failed item; only that child is retried.
    const failedItemIndex = 1;
    const failedItemInput = {
      item: inputs.services[failedItemIndex],
      index: failedItemIndex,
      parent_input: inputs,
    };
    const failedParentResult = {
      total: inputs.services.length,
      succeeded: inputs.services.length - 1,
      failed: 1,
      values: ['processed-checkout', null, 'processed-portal'],
      results: [
        { index: 0, status: 'completed', attempts: 1, value: 'processed-checkout' },
        { index: failedItemIndex, status: 'failed', attempts: 1, error: 'synthetic transient child failure' },
        { index: 2, status: 'completed', attempts: 1, value: 'processed-portal' },
      ],
    };
    const retryParent = await pool.query<WorkflowIdentity>(
      `INSERT INTO mcp_workflow_executions
         (workflow_id, status, triggered_by, input_args, execution_snapshot,
          step_results, completed_at)
       VALUES ($1, 'completed', 'verification:child-retry', $2::jsonb, '{}'::jsonb,
               $3::jsonb, now())
       RETURNING id`,
      [parentId, JSON.stringify(inputs), JSON.stringify({
        foreach: { status: 'completed', duration_ms: 1, result: failedParentResult },
      })],
    );
    const retryParentExecutionId = Number(retryParent.rows[0]!.id);
    const failedChild = await pool.query<WorkflowIdentity>(
      `INSERT INTO mcp_workflow_executions
         (workflow_id, status, triggered_by, input_args, execution_snapshot,
          parent_execution_id, parent_step_id, parent_item_index,
          error_message, completed_at)
       VALUES ($1, 'failed', 'verification:child-retry-source', $2::jsonb, '{}'::jsonb,
               $3, 'foreach', $4, 'synthetic transient child failure', now())
       RETURNING id`,
      [childId, JSON.stringify(failedItemInput), retryParentExecutionId, failedItemIndex],
    );
    const failedChildExecutionId = Number(failedChild.rows[0]!.id);

    const app = express();
    app.use(express.json());
    registerExecuteRoutes(app, pool, {} as Config, (_req, _res, next) => next(), noTools);
    retryServer = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    const retryAddress = retryServer.address() as AddressInfo;
    const retryResponse = await fetch(
      `http://127.0.0.1:${retryAddress.port}/api/workflows/${parentId}/runs/${retryParentExecutionId}/steps/foreach/items/${failedItemIndex}/retry`,
      { method: 'POST' },
    );
    const retryPayload = await retryResponse.json() as { executionId?: number; error?: string };
    if (retryResponse.status !== 202 || !Number.isSafeInteger(retryPayload.executionId)) {
      throw new Error(`Child retry route returned ${retryResponse.status}: ${retryPayload.error ?? JSON.stringify(retryPayload)}`);
    }
    const retriedChild = await waitForTerminalExecution(pool, retryPayload.executionId!);
    await flushTelemetryWrites();
    if (retriedChild.status !== 'completed'
      || Number(retriedChild.parent_execution_id) !== retryParentExecutionId
      || retriedChild.parent_step_id !== 'foreach'
      || Number(retriedChild.parent_item_index) !== failedItemIndex
      || Number(retriedChild.retry_of_execution_id) !== failedChildExecutionId) {
      throw new Error(`Targeted child retry lineage/status is invalid: ${JSON.stringify(retriedChild)}`);
    }

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      parentWorkflowId: parentId,
      childWorkflowId: childId,
      parentExecutionId: executionId,
      parentTraceId: workflowTelemetryTraceId(executionId),
      children: normalizedChildren.map(row => ({
        executionId: row.id,
        itemIndex: row.parent_item_index,
        traceId: workflowTelemetryTraceId(row.id),
      })),
      targetedRetry: {
        parentExecutionId: retryParentExecutionId,
        failedChildExecutionId,
        retryChildExecutionId: Number(retriedChild.id),
        retryOfExecutionId: Number(retriedChild.retry_of_execution_id),
        itemIndex: Number(retriedChild.parent_item_index),
        status: retriedChild.status,
        traceId: workflowTelemetryTraceId(Number(retriedChild.id)),
      },
    }, null, 2)}\n`);
  } finally {
    if (retryServer) {
      await new Promise<void>((resolve, reject) => retryServer!.close(error => error ? reject(error) : resolve()));
    }
    setSharedPool(null);
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
