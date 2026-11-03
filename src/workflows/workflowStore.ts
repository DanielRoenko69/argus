/**
 * Workflow Store — Database CRUD for workflows and execution history.
 */

import type pg from 'pg';
import type {
  WorkflowRow, WorkflowStep, WorkflowInputParam, WorkflowAgentRequirement,
  WorkflowExecutionRow, WorkflowStatus, StepResult,
} from './types.js';
import { normalizeWorkflowAgentRequirements } from './agentContracts.js';

export interface WorkflowScope {
  tenantKey: string;
  workspaceKey: string;
}

export const LEGACY_WORKFLOW_SCOPE: Readonly<WorkflowScope> = Object.freeze({
  tenantKey: 'default',
  workspaceKey: 'default',
});

/* ── Workflow CRUD ─────────────────────────────────────────── */

export async function loadWorkflows(
  pool: pg.Pool,
  allowedBundles?: number[] | null,
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<WorkflowRow[]> {
  let query = `
    SELECT w.*,
      COALESCE((SELECT array_agg(wb.bundle_id) FROM mcp_workflow_bundles wb WHERE wb.workflow_id = w.id), '{}') AS bundle_ids
    FROM mcp_workflows w
  `;
  const params: unknown[] = [scope.tenantKey, scope.workspaceKey];
  query += ' WHERE w.tenant_key = $1 AND w.workspace_key = $2';

  if (allowedBundles && allowedBundles.length > 0) {
    query += ` AND (
      NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = w.id)
      OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = w.id AND wb.bundle_id = ANY($3))
    )`;
    params.push(allowedBundles);
  }

  query += ' ORDER BY w.name';
  const { rows } = await pool.query<WorkflowRow>(query, params);
  return rows;
}

export async function getWorkflow(
  pool: pg.Pool,
  id: number,
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<WorkflowRow | null> {
  const { rows } = await pool.query<WorkflowRow>(
    `SELECT w.*,
      COALESCE((SELECT array_agg(wb.bundle_id) FROM mcp_workflow_bundles wb WHERE wb.workflow_id = w.id), '{}') AS bundle_ids
     FROM mcp_workflows w
     WHERE w.id = $1 AND w.tenant_key = $2 AND w.workspace_key = $3`,
    [id, scope.tenantKey, scope.workspaceKey],
  );
  return rows[0] ?? null;
}

export async function getWorkflowByName(
  pool: pg.Pool,
  name: string,
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<WorkflowRow | null> {
  const { rows } = await pool.query<WorkflowRow>(
    `SELECT w.*,
      COALESCE((SELECT array_agg(wb.bundle_id) FROM mcp_workflow_bundles wb WHERE wb.workflow_id = w.id), '{}') AS bundle_ids
     FROM mcp_workflows w
     WHERE w.name = $1 AND w.tenant_key = $2 AND w.workspace_key = $3`,
    [name, scope.tenantKey, scope.workspaceKey],
  );
  return rows[0] ?? null;
}

export async function createWorkflow(
  pool: pg.Pool,
  data: {
    name: string;
    description: string;
    steps?: WorkflowStep[];
    input_params?: WorkflowInputParam[];
    enabled?: boolean;
    created_by?: number | null;
    bundle_ids?: number[];
    human_oversight_required?: boolean;
    agent_requirements?: WorkflowAgentRequirement[];
    ai_act_governed?: boolean;
    ai_system_id?: string | null;
    ai_system_revision?: number | null;
  },
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<WorkflowRow> {
  const agentRequirements = normalizeWorkflowAgentRequirements(data.agent_requirements ?? []);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<WorkflowRow>(
      `INSERT INTO mcp_workflows
         (name, description, steps, input_params, enabled, created_by,
          human_oversight_required, agent_requirements, ai_act_governed,
          ai_system_id, ai_system_revision, tenant_key, workspace_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        data.name,
        data.description,
        JSON.stringify(data.steps ?? []),
        JSON.stringify(data.input_params ?? []),
        data.enabled ?? true,
        data.created_by ?? null,
        data.human_oversight_required ?? false,
        JSON.stringify(agentRequirements),
        data.ai_act_governed ?? false,
        data.ai_system_id ?? null,
        data.ai_system_revision ?? null,
        scope.tenantKey,
        scope.workspaceKey,
      ],
    );
    const workflow = rows[0];

    if (data.bundle_ids && data.bundle_ids.length > 0) {
      for (const bid of data.bundle_ids) {
        await client.query(
          'INSERT INTO mcp_workflow_bundles (workflow_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [workflow.id, bid],
        );
      }
    }

    await client.query('COMMIT');
    workflow.bundle_ids = data.bundle_ids ?? [];
    return workflow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateWorkflow(
  pool: pg.Pool,
  id: number,
  data: {
    description?: string;
    steps?: WorkflowStep[];
    input_params?: WorkflowInputParam[];
    enabled?: boolean;
    bundle_ids?: number[];
    human_oversight_required?: boolean;
    agent_requirements?: WorkflowAgentRequirement[];
    maintenance_window?: Record<string, unknown> | null;
    ai_act_governed?: boolean;
    ai_system_id?: string | null;
    ai_system_revision?: number | null;
  },
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<WorkflowRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;

    if (data.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(data.description); }
    if (data.steps !== undefined) { sets.push(`steps = $${idx++}`); vals.push(JSON.stringify(data.steps)); }
    if (data.input_params !== undefined) { sets.push(`input_params = $${idx++}`); vals.push(JSON.stringify(data.input_params)); }
    if (data.enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(data.enabled); }
    if (data.human_oversight_required !== undefined) { sets.push(`human_oversight_required = $${idx++}`); vals.push(data.human_oversight_required); }
    if (data.agent_requirements !== undefined) {
      sets.push(`agent_requirements = $${idx++}::jsonb`);
      vals.push(JSON.stringify(normalizeWorkflowAgentRequirements(data.agent_requirements)));
    }
    // audit M1: the builder's MaintenanceWindow control PUTs this; it was being
    // silently dropped, so the cron/webhook maintenance gate never saw a window.
    if (data.maintenance_window !== undefined) { sets.push(`maintenance_window = $${idx++}::jsonb`); vals.push(JSON.stringify(data.maintenance_window)); }
    if (data.ai_act_governed !== undefined) { sets.push(`ai_act_governed = $${idx++}`); vals.push(data.ai_act_governed); }
    if (data.ai_system_id !== undefined) { sets.push(`ai_system_id = $${idx++}`); vals.push(data.ai_system_id); }
    if (data.ai_system_revision !== undefined) { sets.push(`ai_system_revision = $${idx++}`); vals.push(data.ai_system_revision); }

    vals.push(id, scope.tenantKey, scope.workspaceKey);
    const ownershipQuery = sets.length > 0
      ? `UPDATE mcp_workflows SET ${sets.join(', ')}
           WHERE id = $${idx} AND tenant_key = $${idx + 1} AND workspace_key = $${idx + 2}
           RETURNING id`
      : `SELECT id FROM mcp_workflows
           WHERE id = $${idx} AND tenant_key = $${idx + 1} AND workspace_key = $${idx + 2}`;
    const owned = await client.query<{ id: number }>(ownershipQuery, vals);
    if (!owned.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    if (data.bundle_ids !== undefined) {
      await client.query('DELETE FROM mcp_workflow_bundles WHERE workflow_id = $1', [id]);
      for (const bid of data.bundle_ids) {
        await client.query(
          'INSERT INTO mcp_workflow_bundles (workflow_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, bid],
        );
      }
    }

    await client.query('COMMIT');
    return await getWorkflow(pool, id, scope);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteWorkflow(
  pool: pg.Pool,
  id: number,
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM mcp_workflows WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3',
    [id, scope.tenantKey, scope.workspaceKey],
  );
  return (rowCount ?? 0) > 0;
}

/* ── Execution History ─────────────────────────────────────── */

export async function createExecution(
  pool: pg.Pool,
  workflowId: number,
  triggeredBy: string | null,
  inputArgs: Record<string, unknown>,
  executionSnapshot: Record<string, unknown> = {},
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO mcp_workflow_executions
       (workflow_id, status, triggered_by, input_args, execution_snapshot, tenant_key, workspace_key)
     SELECT id, 'running', $2, $3, $4::jsonb, tenant_key, workspace_key
       FROM mcp_workflows
      WHERE id = $1 AND tenant_key = $5 AND workspace_key = $6
     RETURNING id`,
    [workflowId, triggeredBy, JSON.stringify(inputArgs), JSON.stringify(executionSnapshot), scope.tenantKey, scope.workspaceKey],
  );
  if (!rows[0]) throw new Error('workflow not found in selected scope');
  return rows[0].id;
}

export async function updateExecution(
  pool: pg.Pool,
  executionId: number,
  status: WorkflowStatus,
  stepResults: Record<string, StepResult>,
  errorMessage?: string,
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<void> {
  await pool.query(
    `UPDATE mcp_workflow_executions
     SET status = $1, completed_at = now(), step_results = $2, error_message = $3,
         duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
     WHERE id = $4 AND tenant_key = $5 AND workspace_key = $6`,
    [status, JSON.stringify(stepResults), errorMessage ?? null, executionId, scope.tenantKey, scope.workspaceKey],
  );
}

export async function getExecutionHistory(
  pool: pg.Pool,
  workflowId: number,
  limit = 50,
  offset = 0,
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<WorkflowExecutionRow[]> {
  const { rows } = await pool.query<WorkflowExecutionRow>(
    `SELECT * FROM mcp_workflow_executions
     WHERE workflow_id = $1 AND tenant_key = $2 AND workspace_key = $3
     ORDER BY started_at DESC LIMIT $4 OFFSET $5`,
    [workflowId, scope.tenantKey, scope.workspaceKey, limit, offset],
  );
  return rows;
}

export async function getExecution(
  pool: pg.Pool,
  executionId: number,
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<WorkflowExecutionRow | null> {
  const { rows } = await pool.query<WorkflowExecutionRow>(
    `SELECT * FROM mcp_workflow_executions
      WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`,
    [executionId, scope.tenantKey, scope.workspaceKey],
  );
  return rows[0] ?? null;
}
