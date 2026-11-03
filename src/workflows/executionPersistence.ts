import type pg from 'pg';
import type { ExecuteWorkflowResult } from './executor.js';

export async function persistExecutionResult(
  pool: pg.Pool,
  executionId: number,
  result: ExecuteWorkflowResult,
): Promise<void> {
  await pool.query(
    `UPDATE mcp_workflow_executions
     SET status = $2::varchar(32),
         completed_at = CASE WHEN $2::text = 'waiting_for_approval' THEN NULL ELSE now() END,
         step_results = $3::jsonb,
         duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
         error_message = $4,
         waiting_approval_id = $5,
         waiting_step_id = $6
     WHERE id = $1`,
    [
      executionId,
      result.status,
      JSON.stringify(result.stepResults),
      result.error ?? null,
      result.approvalRequestId ?? null,
      result.waitingStepId ?? null,
    ],
  );
}
