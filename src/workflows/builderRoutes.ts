/**
 * Phase 5 routes — templates, runs history, validation.
 *
 *   GET  /api/workflows/templates                   → list templates (source='template')
 *   POST /api/workflows/from-template               → clone template into a fresh workflow
 *   GET  /api/workflows/:id/runs                    → past executions (latest 50)
 *   GET  /api/workflows/:id/runs/:rid               → single execution with step_results
 *   POST /api/workflows/:id/validate                → lint workflow steps
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { getRbacUser, isAdmin } from './rbacHelpers.js';
import type { WorkflowAgentRequirement, WorkflowInputParam, WorkflowStep } from './types.js';
import { isAgentOutputContractName } from './agentOutputContracts.js';
import { buildWorkflowIntegrations, loadAccessibleWorkflowTools } from './integrationCatalog.js';
import { resolveWorkflowToolBindings } from './toolBindings.js';
import { findInlineWorkflowCredentials } from './inlineCredentialPolicy.js';
import { preflightWorkflowResources } from './resourcePreflight.js';
import { parseForEachItems, parseTableRows, parseVariables } from './dataTransforms.js';
import {
  buildVisualWorkflowSpec,
  VisualWorkflowSpecError,
  type ArgusWorkflowSpecV1,
  type VisualWorkflowSource,
} from './visualWorkflowSpec.js';
import type { A2aExecutionContext, A2aInvocationResult } from '../a2a/client.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import {
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
  type AuthorizedWorkspaceScope,
} from '../auth/workspaceScope.js';

interface TemplateRow {
  id: number;
  name: string;
  description: string;
  steps: WorkflowStep[];
  input_params: WorkflowInputParam[];
  canvas_state: Record<string, unknown>;
  trigger_config: Record<string, unknown>;
  block_definitions: unknown[];
  human_oversight_required: boolean;
  agent_requirements: WorkflowAgentRequirement[];
}

interface RunRow {
  id: number;
  workflow_id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  triggered_by: string | null;
  error_message: string | null;
  waiting_approval_id: number | null;
  waiting_step_id: string | null;
  trace_id: string | null;
  root_trace_id: string | null;
  retry_of_execution_id: number | null;
  retry_from_step_ids: string[];
  trigger_evidence: Record<string, unknown>;
}

interface RunDetailRow extends RunRow {
  input_args: Record<string, unknown>;
  step_results: Record<string, unknown>;
}

interface ChildExecutionDetailRow extends pg.QueryResultRow {
  id: number | string;
  workflow_id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  parent_step_id: string;
  parent_item_index: number | null;
  retry_of_execution_id: number | string | null;
  trace_id: string | null;
  root_trace_id: string | null;
}

interface PortableWorkflowRow extends VisualWorkflowSource {
  bundle_ids: number[];
}

export interface VisualWorkflowPackGateway {
  publish(spec: ArgusWorkflowSpecV1): Promise<Record<string, unknown>>;
  start(
    spec: ArgusWorkflowSpecV1,
    input: Record<string, unknown>,
    execution: A2aExecutionContext,
  ): Promise<A2aInvocationResult>;
  loadReplay?(spec: ArgusWorkflowSpecV1, traceId: string): Promise<Record<string, unknown>>;
  listReplays?(spec: ArgusWorkflowSpecV1, limit: number): Promise<Record<string, unknown>[]>;
  cancelReplay?(
    spec: ArgusWorkflowSpecV1,
    traceId: string,
    taskId: string,
  ): Promise<Record<string, unknown>>;
  resumeReplay?(
    spec: ArgusWorkflowSpecV1,
    traceId: string,
    decision: { approved: boolean; feedback: string },
  ): Promise<Record<string, unknown>>;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPLAY_STEP_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'skipped']);
const REPLAY_CANCELLABLE_STATUSES = new Set(['idle', 'queued', 'interrupted', 'waiting', 'waiting_approval', 'waiting_external_ci']);

interface ReplayTelemetryRow {
  id: string;
  status: string;
  agent_id: number | null;
  agent_name: string | null;
  model: string | null;
  provider: string | null;
  session_id: string | null;
  duration_ms: number | null;
  metadata: Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalPositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function replayApproval(state: Record<string, unknown>): { stage: string; message: string } | null {
  const interrupts = Array.isArray(state['interrupts']) ? state['interrupts'] : [];
  for (const rawInterrupt of interrupts) {
    const value = recordValue(recordValue(rawInterrupt)['value']);
    const stage = optionalString(value['stage']);
    if (!stage) continue;
    return {
      stage,
      message: optionalString(value['message']) ?? `Approval required for ${stage}`,
    };
  }
  return null;
}

function assertScopedReplay(state: Record<string, unknown>, spec: ArgusWorkflowSpecV1): void {
  const metadata = recordValue(state['metadata']);
  if (state['graph_id'] !== spec.graphId || metadata['workflow_id'] !== spec.id) {
    throw new PackWorkflowRouteError(404, 'workflow replay not found');
  }
}

/**
 * Join Pack-owned step state with Core-owned runtime telemetry. The Pack is
 * authoritative for control-flow and output; Core is authoritative for the
 * effective Agent, model and runtime that executed the step.
 */
async function buildReplayStepEvidence(
  pool: pg.Pool,
  rawSteps: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const traceIds = [...new Set(Object.values(rawSteps)
    .map(raw => optionalString(recordValue(raw)['traceId'] ?? recordValue(raw)['trace_id']))
    .filter((traceId): traceId is string => traceId != null && TRACE_ID_PATTERN.test(traceId)))];
  const telemetry = new Map<string, ReplayTelemetryRow>();

  if (traceIds.length > 0) {
    try {
      const { rows } = await pool.query<ReplayTelemetryRow>(
        `SELECT trace.id, trace.status, trace.agent_id, agent.name AS agent_name,
                trace.model, trace.provider, trace.session_id, trace.duration_ms, trace.metadata
           FROM mcp_observability_traces trace
           LEFT JOIN mcp_agents agent ON agent.id=trace.agent_id
          WHERE trace.id = ANY($1::uuid[])`,
        [traceIds],
      );
      rows.forEach(row => telemetry.set(row.id, row));
    } catch (error) {
      // Replay remains useful even if an older installation has not persisted
      // the matching native trace yet.
      logger.warn({ err: error, traceIds }, 'workflow replay telemetry enrichment failed');
    }
  }

  return Object.fromEntries(Object.entries(rawSteps).map(([id, raw]) => {
    const step = recordValue(raw);
    const traceId = optionalString(step['traceId'] ?? step['trace_id']);
    const evidence = traceId ? telemetry.get(traceId) : undefined;
    const metadata = recordValue(evidence?.metadata);
    const rawStatus = optionalString(step['status']) ?? 'pending';
    const duration = Number(step['durationMs'] ?? step['duration_ms'] ?? evidence?.duration_ms);
    const agentId = optionalPositiveInteger(step['agentId'] ?? step['agent_id'] ?? evidence?.agent_id);

    return [id, {
      label: optionalString(step['label']) ?? id,
      type: optionalString(step['type']) ?? 'unknown',
      status: REPLAY_STEP_STATUSES.has(rawStatus) ? rawStatus : 'pending',
      result: typeof step['result'] === 'string' ? step['result'] : '',
      durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
      selectedTarget: optionalString(step['selectedTarget'] ?? step['selected_target']),
      agentRole: optionalString(step['agentRole'] ?? step['agent_role'] ?? metadata['agent_role']),
      agentId,
      agentName: evidence?.agent_name ?? optionalString(metadata['agent_name']),
      traceId: traceId && TRACE_ID_PATTERN.test(traceId) ? traceId : null,
      sessionId: evidence?.session_id ?? optionalString(step['sessionId'] ?? step['session_id']),
      runtimeRunId: optionalString(step['runtimeRunId'] ?? step['runtime_run_id'] ?? metadata['runtime_run_id']),
      telemetryStatus: evidence?.status ?? null,
      model: evidence?.model ?? optionalString(metadata['model']),
      provider: evidence?.provider ?? null,
      runtimeType: optionalString(metadata['runtime_type'] ?? metadata['runtime']),
      runtimeProfile: optionalString(metadata['runtime_profile_name'] ?? metadata['runtime_profile']),
      reasoningEffort: optionalString(metadata['reasoning_effort']),
    }];
  }));
}

/** Result of linting a set of workflow steps. */
export interface WorkflowValidationResult {
  valid: boolean;
  errors: Array<{ stepId: string; issue: string }>;
  warnings: Array<{ stepId: string; issue: string }>;
}

/**
 * Pure validator for a set of workflow steps. Shared by the
 * POST /:id/validate route AND the copilot self-validate loop.
 * No DB / no side-effects — safe to call from anywhere.
 */
export function validateWorkflowSteps(steps: WorkflowStep[]): WorkflowValidationResult {
  const errors:   Array<{ stepId: string; issue: string }> = [];
  const warnings: Array<{ stepId: string; issue: string }> = [];

  // 1. Cycles
  if (hasCycle(steps)) {
    errors.push({ stepId: '*', issue: 'cycle detected — workflow has circular dependencies' });
  }

  // 2. dangling depends_on
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    for (const dep of s.depends_on ?? []) {
      if (!ids.has(dep)) {
        errors.push({ stepId: s.id, issue: `depends_on '${dep}' points to non-existent step` });
      }
    }
  }

  // 3. type-specific required fields
  for (const s of steps) {
    const t = s.type ?? 'argus.tool';
    if ((t === 'argus.tool' || t === 'tool') && !s.tool) {
      errors.push({ stepId: s.id, issue: 'argus.tool step missing `tool` name' });
    }
    if (t === 'argus.agent') {
      const role = typeof s.agent_role === 'string' ? s.agent_role.trim().toLowerCase() : '';
      const agentIdValid = Number.isSafeInteger(s.agent_id) && Number(s.agent_id) > 0;
      if (!agentIdValid && !role) {
        errors.push({ stepId: s.id, issue: 'argus.agent step needs `agent_role` or `agent_id`' });
      }
      if (role && !/^[a-z0-9][a-z0-9_.:-]{1,127}$/.test(role)) {
        errors.push({ stepId: s.id, issue: 'argus.agent step has invalid `agent_role`' });
      }
      if (s.output_contract != null && !isAgentOutputContractName(s.output_contract)) {
        errors.push({ stepId: s.id, issue: 'argus.agent step has invalid `output_contract`' });
      }
      if (s.output_contract_retries != null && (
        !Number.isInteger(s.output_contract_retries)
        || s.output_contract_retries < 0
        || s.output_contract_retries > 2
      )) {
        errors.push({ stepId: s.id, issue: 'argus.agent step `output_contract_retries` must be an integer from 0 to 2' });
      }
    }
    if (t === 'argus.approval') {
      warnings.push({ stepId: s.id, issue: 'explicit approval executes through the Argus.Dev Pack runtime' });
    }
    if (t === 'argus.skill' && !s.skill_id) {
      errors.push({ stepId: s.id, issue: 'argus.skill step missing `skill_id`' });
    }
    if (t === 'logic.function' && !s.function_code) {
      errors.push({ stepId: s.id, issue: 'logic.function step missing `function_code`' });
    }
    if (t === 'logic.variables') {
      const value = s.args?.['variables'];
      if (!(typeof value === 'string' && value.includes('{{'))) {
        try {
          parseVariables(value);
        } catch (error) {
          errors.push({ stepId: s.id, issue: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    if (t === 'logic.table') {
      const value = s.args?.['rows'];
      if (!(typeof value === 'string' && value.includes('{{'))) {
        try {
          parseTableRows(value);
        } catch (error) {
          errors.push({ stepId: s.id, issue: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    if (t === 'logic.for_each') {
      const mode = String(s.args?.['mode'] ?? 'transform').trim().toLowerCase();
      const items = s.args?.['items'];
      if (!(typeof items === 'string' && items.includes('{{'))) {
        try {
          parseForEachItems(items);
        } catch (error) {
          errors.push({ stepId: s.id, issue: error instanceof Error ? error.message : String(error) });
        }
      }
      if (mode !== 'transform' && mode !== 'subworkflow') {
        errors.push({ stepId: s.id, issue: `For Each mode must be 'transform' or 'subworkflow'` });
      } else if (mode === 'transform' && !s.function_code?.trim()) {
        errors.push({ stepId: s.id, issue: 'For Each transform mode missing `function_code`' });
      } else if (mode === 'subworkflow') {
        const targetId = Number(s.args?.['target_workflow_id']);
        if (!Number.isSafeInteger(targetId) || targetId <= 0) {
          errors.push({ stepId: s.id, issue: 'For Each subworkflow mode missing valid `target_workflow_id`' });
        }
        const childInputs = s.args?.['child_inputs'];
        if (childInputs != null && childInputs !== '' && !(typeof childInputs === 'string' && childInputs.includes('{{'))) {
          try {
            parseVariables(childInputs);
          } catch (error) {
            errors.push({ stepId: s.id, issue: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const concurrency = Number(s.args?.['concurrency'] ?? 4);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
        errors.push({ stepId: s.id, issue: 'For Each concurrency must be an integer from 1 to 16' });
      }
      const retries = Number(s.args?.['retries'] ?? 0);
      if (!Number.isInteger(retries) || retries < 0 || retries > 3) {
        errors.push({ stepId: s.id, issue: 'For Each retries must be an integer from 0 to 3' });
      }
      const onItemError = String(s.args?.['on_item_error'] ?? 'stop').trim().toLowerCase();
      if (onItemError !== 'stop' && onItemError !== 'continue') {
        errors.push({ stepId: s.id, issue: `For Each on_item_error must be 'stop' or 'continue'` });
      }
      if (mode === 'subworkflow' && retries > 0) {
        warnings.push({
          stepId: s.id,
          issue: 'For Each sub-workflow retries require an idempotent child workflow',
        });
      }
    }
    if (t === 'logic.condition' && !s.condition) {
      warnings.push({ stepId: s.id, issue: 'logic.condition step has no condition — always passes' });
    }
  }

  // Provider authentication belongs to MCP Fabric. Keeping raw tokens out of
  // workflow JSON also keeps them out of versions, exports, traces and logs.
  errors.push(...findInlineWorkflowCredentials(steps).map(({ stepId, issue }) => ({ stepId, issue })));

  // 4. dangling nodes (no in + no out): probably forgotten
  const hasOutgoing = new Set<string>();
  const hasIncoming = new Set<string>();
  for (const s of steps) {
    for (const dep of s.depends_on ?? []) {
      hasOutgoing.add(dep);
      hasIncoming.add(s.id);
    }
  }
  for (const s of steps) {
    const isTrigger = (s.type ?? '').startsWith('trigger.');
    const isResponse = s.type === 'logic.response';
    const isNote = s.type === 'logic.note';
    if (!isNote && !isTrigger && !hasIncoming.has(s.id)) {
      warnings.push({ stepId: s.id, issue: 'step has no incoming edge — unreachable' });
    }
    if (!isNote && !isResponse && !hasOutgoing.has(s.id) && steps.length > 1) {
      warnings.push({ stepId: s.id, issue: 'step has no outgoing edge — dead-end' });
    }
  }

  // 5. has at least one trigger
  if (!steps.some((s) => (s.type ?? '').startsWith('trigger.'))) {
    warnings.push({ stepId: '*', issue: 'no trigger step — workflow can only be run manually via API' });
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function registerBuilderRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
  packGateway?: VisualWorkflowPackGateway,
): void {
  // ── GET /api/workflows/templates ───────────────────────────────
  app.get('/api/workflows/templates', requireAuth, async (req, res) => {
    try {
      const scope = requestWorkflowScope(req);
      const { rows } = await pool.query<TemplateRow>(
        `SELECT id, name, description, steps, input_params, canvas_state,
                trigger_config, block_definitions, human_oversight_required,
                agent_requirements
         FROM mcp_workflows
         WHERE source = 'template' AND tenant_key = $1 AND workspace_key = $2
         ORDER BY name`,
        [scope.tenantKey, scope.workspaceKey],
      );
      const user = getRbacUser(req);
      const admin = isAdmin(user);
      const tools = await loadAccessibleWorkflowTools(pool, admin ? null : (user.allowed_bundles ?? []));
      const integrations = new Map(buildWorkflowIntegrations(tools, admin).map(integration => [integration.id, integration]));
      const templates = rows.map(template => {
        const binding = resolveWorkflowToolBindings(template.steps, template.block_definitions, tools);
        return {
          ...template,
          integration_readiness: {
            ready: binding.ready,
            requirements: binding.resolutions.map(requirement => ({
              ...requirement,
              configureHref: integrations.get(requirement.integrationId)?.configure_href ?? '/mcp-fabric?new=mcp',
            })),
          },
        };
      });
      res.json({ templates });
    } catch (err) {
      if (sendWorkspaceScopeError(res, err)) return;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'templates:list failed');
      res.status(500).json({ error: 'database error' });
    }
  });

  // ── POST /api/workflows/from-template ───────────────────────────
  // Clones a template into a new workflow owned by the requesting user.
  app.post('/api/workflows/from-template', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { template_id?: number; name?: string };
    const templateId = Number(body.template_id ?? 0);
    if (!templateId) {
      res.status(400).json({ error: 'template_id required' });
      return;
    }
    const user = getRbacUser(req);

    try {
      const scope = requestWorkflowScope(req);
      const { rows: tpls } = await pool.query<TemplateRow>(
        `SELECT id, name, description, steps, input_params, canvas_state,
                trigger_config, block_definitions, human_oversight_required,
                agent_requirements
         FROM mcp_workflows
         WHERE id = $1 AND source = 'template' AND tenant_key = $2 AND workspace_key = $3`,
        [templateId, scope.tenantKey, scope.workspaceKey]
      );
      const tpl = tpls[0];
      if (!tpl) {
        res.status(404).json({ error: 'template not found' });
        return;
      }
      const admin = isAdmin(user);
      const tools = await loadAccessibleWorkflowTools(pool, admin ? null : (user.allowed_bundles ?? []));
      const toolBindings = resolveWorkflowToolBindings(tpl.steps, tpl.block_definitions, tools);
      if (!toolBindings.ready) {
        const integrations = new Map(buildWorkflowIntegrations(tools, admin).map(integration => [integration.id, integration]));
        res.status(409).json({
          error: 'Template integrations are not ready',
          requirements: toolBindings.resolutions.map(requirement => ({
            ...requirement,
            configureHref: integrations.get(requirement.integrationId)?.configure_href ?? '/mcp-fabric?new=mcp',
          })),
        });
        return;
      }
      const newName = (body.name ?? `${tpl.name.replace(/^tpl_/, '')}_copy_${Date.now()}`)
        .toLowerCase().replace(/[^a-z0-9_]/g, '_');

      const { rows: inserted } = await pool.query<{ id: number }>(
        `INSERT INTO mcp_workflows
           (name, description, steps, input_params, canvas_state, trigger_config,
            block_definitions, source, enabled, created_by,
            human_oversight_required, agent_requirements, tenant_key, workspace_key)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb,
                 $7::jsonb, 'visual', true, $8, $9, $10::jsonb, $11, $12)
         RETURNING id`,
        [
          newName,
          `Copy of ${tpl.name}: ${tpl.description}`,
          JSON.stringify(toolBindings.steps),
          JSON.stringify(tpl.input_params ?? []),
          JSON.stringify(tpl.canvas_state),
          JSON.stringify(tpl.trigger_config ?? {}),
          JSON.stringify(toolBindings.blockDefinitions),
          user.id ?? null,
          tpl.human_oversight_required ?? false,
          JSON.stringify(tpl.agent_requirements ?? []),
          scope.tenantKey,
          scope.workspaceKey,
        ]
      );
      res.json({ id: inserted[0]!.id, name: newName });
    } catch (err) {
      if (sendWorkspaceScopeError(res, err)) return;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, templateId }, 'from-template failed');
      res.status(500).json({ error: msg });
    }
  });

  /**
   * Shared read predicate for workflow runs: tenant ownership is always
   * enforced and Bundle RBAC is an additional check. List, detail and child
   * summaries must all use this so a direct id lookup cannot bypass the list.
   */
  const isWorkflowRunVisible = async (
    wfId: number,
    scope: AuthorizedWorkspaceScope,
    user: ReturnType<typeof getRbacUser>,
  ): Promise<boolean> => {
    const visibilityParams: unknown[] = [wfId, scope.tenantKey, scope.workspaceKey];
    let visibilitySql = `SELECT id FROM mcp_workflows
      WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`;
    if (!isAdmin(user)) {
      visibilitySql += ` AND (
        NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = $1)
        OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = $1 AND wb.bundle_id = ANY($4::int[]))
      )`;
      visibilityParams.push(user.allowed_bundles ?? []);
    }
    const { rows } = await pool.query<{ id: number }>(visibilitySql, visibilityParams);
    return rows.length > 0;
  };

  // ── GET /api/workflows/:id/runs ────────────────────────────────
  app.get('/api/workflows/:id/runs', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    if (!Number.isInteger(wfId) || wfId <= 0) {
      res.status(400).json({ error: 'invalid workflow id' });
      return;
    }
    const user = getRbacUser(req);
    let scope: AuthorizedWorkspaceScope;
    try {
      scope = requestWorkflowScope(req);
    } catch (error) {
      if (sendWorkspaceScopeError(res, error)) return;
      throw error;
    }

    if (!await isWorkflowRunVisible(wfId, scope, user)) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }

    try {
      const { rows } = await pool.query<RunRow>(
        `SELECT execution.id, execution.workflow_id, execution.status,
                execution.started_at, execution.completed_at,
                execution.duration_ms, execution.triggered_by, execution.error_message,
                execution.waiting_approval_id, execution.waiting_step_id,
                execution.retry_of_execution_id, execution.retry_from_step_ids,
                execution.trigger_evidence,
                telemetry.trace_id, telemetry.root_trace_id
         FROM mcp_workflow_executions execution
         LEFT JOIN LATERAL (
           SELECT trace.id::text AS trace_id, trace.root_trace_id::text AS root_trace_id
           FROM mcp_observability_traces trace
           WHERE trace.workflow_execution_id = execution.id
             AND trace.kind = 'workflow'
           ORDER BY trace.started_at DESC
           LIMIT 1
         ) telemetry ON true
         WHERE execution.workflow_id = $1
           AND execution.tenant_key = $2 AND execution.workspace_key = $3
         ORDER BY execution.started_at DESC
         LIMIT 50`,
        [wfId, scope.tenantKey, scope.workspaceKey]
      );
      res.json({ runs: rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, wfId }, 'runs:list failed');
      res.status(500).json({ error: 'database error' });
    }
  });

  // ── GET /api/workflows/:id/runs/:rid ───────────────────────────
  app.get('/api/workflows/:id/runs/:rid', requireAuth, async (req, res) => {
    const wfId  = Number(req.params['id']);
    const runId = Number(req.params['rid']);
    if (!Number.isInteger(wfId) || !Number.isInteger(runId)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    try {
      const scope = requestWorkflowScope(req);
      const user = getRbacUser(req);
      if (!await isWorkflowRunVisible(wfId, scope, user)) {
        res.status(404).json({ error: 'run not found' });
        return;
      }
      const childBundleFilter = isAdmin(user)
        ? ''
        : `AND (
            NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = child.workflow_id)
            OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb
                        WHERE wb.workflow_id = child.workflow_id AND wb.bundle_id = ANY($4::int[]))
          )`;
      const { rows } = await pool.query<RunDetailRow>(
        `SELECT execution.id, execution.workflow_id, execution.status,
                execution.started_at, execution.completed_at, execution.duration_ms,
                execution.triggered_by, execution.input_args, execution.step_results,
                execution.error_message, execution.waiting_approval_id, execution.waiting_step_id,
                execution.retry_of_execution_id, execution.retry_from_step_ids,
                execution.trigger_evidence,
                telemetry.trace_id, telemetry.root_trace_id
         FROM mcp_workflow_executions execution
         LEFT JOIN LATERAL (
           SELECT trace.id::text AS trace_id, trace.root_trace_id::text AS root_trace_id
           FROM mcp_observability_traces trace
           WHERE trace.workflow_execution_id = execution.id
             AND trace.kind = 'workflow'
           ORDER BY trace.started_at DESC
           LIMIT 1
         ) telemetry ON true
         WHERE execution.id = $1 AND execution.workflow_id = $2
           AND execution.tenant_key = $3 AND execution.workspace_key = $4`,
        [runId, wfId, scope.tenantKey, scope.workspaceKey]
      );
      const r = rows[0];
      if (!r) {
        res.status(404).json({ error: 'run not found' });
        return;
      }
      const childRows = await pool.query<ChildExecutionDetailRow>(
        `SELECT child.id, child.workflow_id, child.status,
                child.started_at, child.completed_at, child.error_message,
                child.parent_step_id, child.parent_item_index,
                child.retry_of_execution_id,
                telemetry.trace_id, telemetry.root_trace_id
           FROM mcp_workflow_executions child
           LEFT JOIN LATERAL (
             SELECT trace.id::text AS trace_id, trace.root_trace_id::text AS root_trace_id
             FROM mcp_observability_traces trace
             WHERE trace.workflow_execution_id = child.id
               AND trace.kind = 'workflow'
             ORDER BY trace.started_at DESC
             LIMIT 1
           ) telemetry ON true
          WHERE child.parent_execution_id = $1
            AND child.tenant_key = $2 AND child.workspace_key = $3
            ${childBundleFilter}
          ORDER BY child.parent_step_id, child.parent_item_index, child.started_at, child.id`,
        isAdmin(user)
          ? [runId, scope.tenantKey, scope.workspaceKey]
          : [runId, scope.tenantKey, scope.workspaceKey, user.allowed_bundles ?? []],
      );
      const childExecutions = childRows.rows.reduce<Record<string, Array<Record<string, unknown>>>>((groups, child) => {
        const executionId = Number(child.id);
        const retryOfExecutionId = child.retry_of_execution_id == null ? null : Number(child.retry_of_execution_id);
        const itemIndex = child.parent_item_index == null ? null : Number(child.parent_item_index);
        (groups[child.parent_step_id] ??= []).push({
          workflow_id: child.workflow_id,
          execution_id: executionId,
          status: child.status,
          started_at: child.started_at,
          completed_at: child.completed_at,
          error: child.error_message,
          parent_item_index: itemIndex,
          retry_of_execution_id: retryOfExecutionId,
          trace_id: child.trace_id,
          root_trace_id: child.root_trace_id ?? child.trace_id,
        });
        return groups;
      }, {});
      res.json({ ...r, child_executions: childExecutions });
    } catch (err) {
      if (sendWorkspaceScopeError(res, err)) return;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, runId }, 'runs:detail failed');
      res.status(500).json({ error: 'database error' });
    }
  });

  // ── POST /api/workflows/:id/validate ───────────────────────────
  // Lint steps for cycles, missing required refs, dangling configs.
  app.post('/api/workflows/:id/validate', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { steps?: WorkflowStep[] };
    const steps = Array.isArray(body.steps) ? body.steps : null;
    if (!steps) {
      res.status(400).json({ error: 'steps[] required in body' });
      return;
    }
    res.json(validateWorkflowSteps(steps));
  });

  // Fresh, identity-scoped readiness for the saved graph. This intentionally
  // reloads the MCP catalog instead of trusting stale browser state.
  app.get('/api/workflows/:id/preflight', requireAuth, async (req, res) => {
    try {
      const workflow = await loadPortableWorkflow(pool, req);
      const user = getRbacUser(req);
      const admin = isAdmin(user);
      const allowedBundleIds = admin ? null : (user.allowed_bundles ?? []);
      const tools = await loadAccessibleWorkflowTools(pool, allowedBundleIds);
      const integrations = buildWorkflowIntegrations(tools, admin);
      res.json(preflightWorkflowResources({
        workflowId: workflow.id,
        workflowName: workflow.name,
        steps: workflow.steps,
        validation: validateWorkflowSteps(workflow.steps),
        tools,
        integrations,
        allowedBundleIds,
      }));
    } catch (error) {
      if (error instanceof PackWorkflowRouteError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message }, 'workflow resource preflight failed');
      res.status(500).json({ error: 'Workflow resource preflight failed' });
    }
  });

  // Publish a saved visual graph as a portable, versioned Argus Workflow
  // Spec. The external Pack owns execution; Core remains the source of truth
  // for identity, Agent contracts, MCP bundles and short-lived grants.
  app.post('/api/workflows/:id/publish-to-pack', requireAuth, async (req, res) => {
    try {
      if (!packGateway) {
        res.status(503).json({ error: 'Argus Dev workflow publishing is not configured' });
        return;
      }
      const row = await loadPortableWorkflow(pool, req);
      const spec = buildVisualWorkflowSpec(row);
      const publication = await packGateway.publish(spec);
      res.json({ spec, publication });
    } catch (error) {
      sendPackWorkflowError(res, error);
    }
  });

  // A Pack run always republishes the latest saved revision first. This keeps
  // the button deterministic: the graph visible in Core is exactly the graph
  // accepted by Argus.Dev for this task.
  app.post('/api/workflows/:id/pack-run', requireAuth, async (req, res) => {
    try {
      if (!packGateway) {
        res.status(503).json({ error: 'Argus Dev workflow execution is not configured' });
        return;
      }
      const row = await loadPortableWorkflow(pool, req);
      const spec = buildVisualWorkflowSpec(row);
      const publication = await packGateway.publish(spec);
      const body = (req.body ?? {}) as { input?: Record<string, unknown> };
      const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input)
        ? body.input
        : {};
      const user = getRbacUser(req);
      const invocation = await packGateway.start(spec, input, {
        principalKind: 'user',
        principalId: String(user.id ?? user.username ?? 'workflow-builder'),
        principalAllowedBundleIds: user.allowed_bundles,
        requestedBundleIds: row.bundle_ids,
      });
      res.json({
        spec,
        publication,
        ...invocation,
        // Keep the complete A2A task for protocol-aware clients while also
        // exposing the identifiers a generic workflow client needs without
        // understanding the A2A response envelope.
        taskId: invocation.task.id,
        rootTraceId: invocation.rootTraceId,
        workflowThreadId: invocation.rootTraceId,
        status: invocation.task.status.state,
      });
    } catch (error) {
      sendPackWorkflowError(res, error);
    }
  });

  // A replay is resolved through Core instead of letting the browser address a
  // Pack directly. Core enforces workflow RBAC, verifies the external thread's
  // workflow identity and returns only the evidence required by the canvas.
  app.get('/api/workflows/:id/replay/:traceId', requireAuth, async (req, res) => {
    try {
      if (!packGateway?.loadReplay) {
        res.status(503).json({ error: 'Argus Dev workflow replay is not configured' });
        return;
      }
      const traceId = String(req.params['traceId'] ?? '').trim();
      if (!TRACE_ID_PATTERN.test(traceId)) {
        res.status(400).json({ error: 'invalid replay trace id' });
        return;
      }
      const row = await loadPortableWorkflow(pool, req);
      const spec = buildVisualWorkflowSpec(row);
      const state = await packGateway.loadReplay(spec, traceId);
      assertScopedReplay(state, spec);
      const values = recordValue(state['values']);
      const stepResults = await buildReplayStepEvidence(pool, recordValue(values['step_results']));
      const status = optionalString(state['status']) ?? 'unknown';
      res.json({
        thread_id: traceId,
        graph_id: state['graph_id'],
        status,
        error: state['error'] ?? null,
        approval: replayApproval(state),
        can_cancel: REPLAY_CANCELLABLE_STATUSES.has(status),
        values: {
          current_stage: values['current_stage'] ?? null,
          visual_completed: values['visual_completed'] === true,
          step_results: stepResults,
        },
      });
    } catch (error) {
      sendPackWorkflowError(res, error);
    }
  });

  // Visual workflow history remains owned by the Pack's durable checkpointer.
  // Core multiplexes a workflow-scoped, sanitized projection for the Builder.
  app.get('/api/workflows/:id/pack-runs', requireAuth, async (req, res) => {
    try {
      if (!packGateway?.listReplays) {
        res.status(503).json({ error: 'Argus Dev workflow history is not configured' });
        return;
      }
      const row = await loadPortableWorkflow(pool, req);
      const spec = buildVisualWorkflowSpec(row);
      const requestedLimit = Number(req.query['limit'] ?? 25);
      const limit = Number.isFinite(requestedLimit) ? Math.min(50, Math.max(1, Math.trunc(requestedLimit))) : 25;
      const states = await packGateway.listReplays(spec, limit);
      const runs = states.flatMap(state => {
        const metadata = recordValue(state['metadata']);
        if (state['graph_id'] !== spec.graphId || metadata['workflow_id'] !== spec.id) return [];
        const traceId = optionalString(state['thread_id']);
        if (!traceId || !TRACE_ID_PATTERN.test(traceId)) return [];
        const values = recordValue(state['values']);
        const steps = Object.values(recordValue(values['step_results'])).map(recordValue);
        const status = optionalString(state['status']) ?? 'unknown';
        const approval = replayApproval(state);
        const taskId = optionalString(metadata['a2a_task_id']);
        const createdAt = optionalString(state['created_at']);
        const updatedAt = optionalString(state['updated_at']);
        const start = createdAt ? Date.parse(createdAt) : Number.NaN;
        const end = updatedAt ? Date.parse(updatedAt) : Number.NaN;
        return [{
          traceId,
          taskId,
          title: optionalString(metadata['run_title']) ?? spec.label,
          status,
          error: optionalString(state['error']),
          currentStage: optionalString(values['current_stage']),
          completed: values['visual_completed'] === true,
          stepCount: steps.length,
          agentStepCount: steps.filter(step => step['type'] === 'argus.agent').length,
          createdAt,
          updatedAt,
          durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
          canCancel: Boolean(taskId && TRACE_ID_PATTERN.test(taskId) && REPLAY_CANCELLABLE_STATUSES.has(status)),
          canResume: status === 'interrupted' && approval != null,
          approvalStage: approval?.stage ?? null,
          replayHref: `/build/workflows/studio/${row.id}?replay=${encodeURIComponent(traceId)}`,
        }];
      });
      res.json({ runs });
    } catch (error) {
      sendPackWorkflowError(res, error);
    }
  });

  app.post('/api/workflows/:id/replay/:traceId/cancel', requireAuth, async (req, res) => {
    try {
      if (!packGateway?.loadReplay || !packGateway.cancelReplay) {
        res.status(503).json({ error: 'Argus Dev workflow cancellation is not configured' });
        return;
      }
      const traceId = String(req.params['traceId'] ?? '').trim();
      if (!TRACE_ID_PATTERN.test(traceId)) {
        res.status(400).json({ error: 'invalid replay trace id' });
        return;
      }
      const row = await loadPortableWorkflow(pool, req);
      const spec = buildVisualWorkflowSpec(row);
      const state = await packGateway.loadReplay(spec, traceId);
      assertScopedReplay(state, spec);
      const status = optionalString(state['status']) ?? 'unknown';
      if (!REPLAY_CANCELLABLE_STATUSES.has(status)) {
        throw new PackWorkflowRouteError(409, status === 'running'
          ? 'the active Agent step must settle before this run can be cancelled safely'
          : `workflow run in state ${status} cannot be cancelled`);
      }
      const taskId = optionalString(recordValue(state['metadata'])['a2a_task_id']);
      if (!taskId || !TRACE_ID_PATTERN.test(taskId)) {
        throw new PackWorkflowRouteError(409, 'workflow run has no cancellable A2A task');
      }
      const task = await packGateway.cancelReplay(spec, traceId, taskId);
      res.json({ ok: true, traceId, taskId, task });
    } catch (error) {
      sendPackWorkflowError(res, error);
    }
  });

  app.post('/api/workflows/:id/replay/:traceId/resume', requireAuth, async (req, res) => {
    try {
      if (!packGateway?.loadReplay || !packGateway.resumeReplay) {
        res.status(503).json({ error: 'Argus Dev workflow resume is not configured' });
        return;
      }
      const traceId = String(req.params['traceId'] ?? '').trim();
      if (!TRACE_ID_PATTERN.test(traceId)) {
        res.status(400).json({ error: 'invalid replay trace id' });
        return;
      }
      const row = await loadPortableWorkflow(pool, req);
      const spec = buildVisualWorkflowSpec(row);
      const state = await packGateway.loadReplay(spec, traceId);
      assertScopedReplay(state, spec);
      const status = optionalString(state['status']) ?? 'unknown';
      const approval = replayApproval(state);
      if (status !== 'interrupted' || !approval) {
        throw new PackWorkflowRouteError(409, 'workflow run is not waiting at an approval checkpoint');
      }
      const body = recordValue(req.body);
      const decision = optionalString(body['decision']);
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new PackWorkflowRouteError(400, "decision must be 'approved' or 'rejected'");
      }
      const feedback = typeof body['feedback'] === 'string' ? body['feedback'].trim().slice(0, 4_000) : '';
      const run = await packGateway.resumeReplay(spec, traceId, {
        approved: decision === 'approved',
        feedback,
      });
      res.json({ ok: true, traceId, decision, approvalStage: approval.stage, run });
    } catch (error) {
      sendPackWorkflowError(res, error);
    }
  });
}

async function loadPortableWorkflow(pool: pg.Pool, req: Request): Promise<PortableWorkflowRow> {
  const workflowId = Number(req.params['id']);
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0) {
    throw new PackWorkflowRouteError(400, 'invalid workflow id');
  }
  const scope = requestWorkflowScope(req);
  const { rows } = await pool.query<PortableWorkflowRow>(
    `SELECT w.id, w.name, w.description, w.steps, w.input_params,
            w.agent_requirements, w.updated_at,
            COALESCE(array_agg(wb.bundle_id) FILTER (WHERE wb.bundle_id IS NOT NULL), '{}')::int[] AS bundle_ids
       FROM mcp_workflows w
       LEFT JOIN mcp_workflow_bundles wb ON wb.workflow_id = w.id
      WHERE w.id = $1 AND w.source <> 'template'
        AND w.tenant_key = $2 AND w.workspace_key = $3
      GROUP BY w.id`,
    [workflowId, scope.tenantKey, scope.workspaceKey],
  );
  const row = rows[0];
  if (!row) throw new PackWorkflowRouteError(404, 'workflow not found');
  const user = getRbacUser(req);
  if (!isAdmin(user) && row.bundle_ids.length > 0
    && !row.bundle_ids.some(bundleId => user.allowed_bundles?.includes(bundleId))) {
    throw new PackWorkflowRouteError(404, 'workflow not found');
  }
  return row;
}

function requestWorkflowScope(req: Request): AuthorizedWorkspaceScope {
  try {
    return resolveAuthorizedWorkspaceScope(req, (req as AuthenticatedRequest).user!);
  } catch (error) {
    if (error instanceof WorkspaceScopeAccessError) {
      throw new PackWorkflowRouteError(404, 'workflow not found');
    }
    throw error;
  }
}

function sendWorkspaceScopeError(res: Response, error: unknown): boolean {
  if (!(error instanceof PackWorkflowRouteError)) return false;
  res.status(error.status).json({ error: error.message });
  return true;
}

class PackWorkflowRouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendPackWorkflowError(res: Response, error: unknown): void {
  if (error instanceof PackWorkflowRouteError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof VisualWorkflowSpecError) {
    res.status(422).json({ error: 'workflow is not Pack-compatible', issues: error.issues });
    return;
  }
  const status = typeof error === 'object' && error !== null && 'status' in error
    && Number.isInteger(Number((error as { status?: unknown }).status))
    ? Math.min(599, Math.max(400, Number((error as { status: unknown }).status)))
    : 502;
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: message }, 'visual workflow Pack bridge failed');
  res.status(status).json({ error: message });
}

function hasCycle(steps: WorkflowStep[]): boolean {
  // DFS with white/gray/black coloring.
  const color = new Map<string, 0 | 1 | 2>(); // 0=white, 1=gray, 2=black
  const adj = new Map<string, string[]>();
  for (const s of steps) {
    adj.set(s.id, [...(s.depends_on ?? [])]);
    color.set(s.id, 0);
  }
  function dfs(u: string): boolean {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === 1) return true;
      if (color.get(v) === 0 && dfs(v)) return true;
    }
    color.set(u, 2);
    return false;
  }
  for (const s of steps) {
    if (color.get(s.id) === 0 && dfs(s.id)) return true;
  }
  return false;
}
