import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  A2aClientError,
  type A2aAgentCard,
  type A2aGateway,
  type A2aInvocationResult,
  type A2aTask,
} from '../a2a/client.js';

export const HERMES_DEV_PACK_ID = 'argus.dev';
export const HERMES_DEV_AGENT_ID = 'coding-orchestrator';
export const HERMES_DEV_WORKFLOW_ID = 'ticket-to-pull-request';

const stableId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/);
const callerSchema = z.object({
  userId: z.number().int().positive(),
  apiKeyPrefix: z.string().trim().min(1).max(64),
  allowedBundleIds: z.array(z.number().int().positive()).min(1).max(64),
  tenantKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/).default('default'),
  workspaceKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/).default('default'),
}).strict();
const startSchema = z.object({
  ticketId: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(20_000),
  originSessionRef: stableId.optional(),
}).strict();
const taskSchema = z.object({ taskId: stableId }).strict();

const TERMINAL_TASK_STATES = new Set<A2aTask['status']['state']>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

export interface HermesDevBridgeCaller {
  userId: number;
  apiKeyPrefix: string;
  /**
   * Exact Bundle projection assigned to the personal-Hermes API key. `null`
   * and an empty selection fail closed so a broadly privileged key cannot be
   * turned into an implicit development execution grant.
   */
  allowedBundleIds: number[];
  tenantKey?: string;
  workspaceKey?: string;
}

export interface HermesDevBridgeTaskRecord {
  taskId: string;
  contextId: string;
  principalUserId: number;
  apiKeyPrefix: string;
  rootTraceId: string;
  tenantKey?: string;
  workspaceKey?: string;
  originSessionRefHash: string | null;
  createdAt: string;
}

export interface HermesDevBridgeTaskStore {
  record(input: {
    taskId: string;
    contextId: string;
    principalUserId: number;
    apiKeyPrefix: string;
    rootTraceId: string;
    tenantKey?: string;
    workspaceKey?: string;
    originSessionRef?: string;
  }): Promise<void>;
  findOwned(
    taskId: string,
    principalUserId: number,
    apiKeyPrefix: string,
    tenantKey?: string,
    workspaceKey?: string,
  ): Promise<HermesDevBridgeTaskRecord | null>;
}

export class HermesDevBridgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HermesDevBridgeError';
  }
}

function originHash(value: string | undefined): string | null {
  return value ? createHash('sha256').update(value, 'utf8').digest('hex') : null;
}

export class PostgresHermesDevBridgeTaskStore implements HermesDevBridgeTaskStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async record(input: {
    taskId: string;
    contextId: string;
    principalUserId: number;
    apiKeyPrefix: string;
    rootTraceId: string;
    tenantKey?: string;
    workspaceKey?: string;
    originSessionRef?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO mcp_hermes_dev_bridge_tasks (
         task_id, context_id, principal_user_id, api_key_prefix,
         root_trace_id, tenant_key, workspace_key, origin_session_ref_hash
       ) VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8)
       ON CONFLICT (task_id) DO NOTHING`,
      [
        input.taskId,
        input.contextId,
        input.principalUserId,
        input.apiKeyPrefix,
        input.rootTraceId,
        input.tenantKey ?? 'default',
        input.workspaceKey ?? 'default',
        originHash(input.originSessionRef),
      ],
    );
  }

  async findOwned(
    taskId: string,
    principalUserId: number,
    apiKeyPrefix: string,
    tenantKey = 'default',
    workspaceKey = 'default',
  ): Promise<HermesDevBridgeTaskRecord | null> {
    const result = await this.pool.query<{
      task_id: string;
      context_id: string;
      principal_user_id: number;
      api_key_prefix: string;
      root_trace_id: string;
      tenant_key: string;
      workspace_key: string;
      origin_session_ref_hash: string | null;
      created_at: Date;
    }>(
      `SELECT task_id, context_id, principal_user_id, api_key_prefix,
              root_trace_id::text, tenant_key, workspace_key,
              origin_session_ref_hash, created_at
         FROM mcp_hermes_dev_bridge_tasks
        WHERE task_id = $1 AND principal_user_id = $2 AND api_key_prefix = $3
          AND tenant_key = $4 AND workspace_key = $5`,
      [taskId, principalUserId, apiKeyPrefix, tenantKey, workspaceKey],
    );
    const row = result.rows[0];
    return row ? {
      taskId: row.task_id,
      contextId: row.context_id,
      principalUserId: row.principal_user_id,
      apiKeyPrefix: row.api_key_prefix,
      rootTraceId: row.root_trace_id,
      tenantKey: row.tenant_key,
      workspaceKey: row.workspace_key,
      originSessionRefHash: row.origin_session_ref_hash,
      createdAt: row.created_at.toISOString(),
    } : null;
  }
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function workflowDefinition(card: A2aAgentCard): Record<string, unknown> | null {
  const skill = card.skills.find(candidate => candidate.id === HERMES_DEV_WORKFLOW_ID);
  if (!skill) return null;
  const raw = skill['x-argus-workflow'];
  const definition = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    id: HERMES_DEV_WORKFLOW_ID,
    name: boundedString(skill.name, 200) ?? 'Ticket to pull request',
    description: boundedString(skill.description, 2_000),
    inputSchema: Array.isArray(definition['inputSchema']) ? definition['inputSchema'].slice(0, 32) : [
      { name: 'ticket_id', type: 'text', required: true },
      { name: 'description', type: 'textarea', required: true },
    ],
    stages: Array.isArray(definition['stages']) ? definition['stages'].slice(0, 32) : [],
    approvalGates: Array.isArray(definition['approvalGates']) ? definition['approvalGates'].slice(0, 16) : [],
    requiredBundleCategories: Array.isArray(definition['requiredBundleCategories'])
      ? definition['requiredBundleCategories'].slice(0, 32)
      : [],
  };
}

function evidence(task: A2aTask): Record<string, unknown> | null {
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts) {
      if (!('data' in part) || !part.data || typeof part.data !== 'object' || Array.isArray(part.data)) continue;
      const data = part.data as Record<string, unknown>;
      if (data['workflowId'] === HERMES_DEV_WORKFLOW_ID || typeof data['currentStage'] === 'string') return data;
    }
  }
  return null;
}

function boundedEvidenceItems(value: unknown, maxItems: number, maxItemBytes: number): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map(item => {
    if (typeof item === 'string') return item.slice(0, maxItemBytes);
    try {
      const serialized = JSON.stringify(item);
      if (serialized.length <= maxItemBytes) return item;
      return { truncated: true, preview: serialized.slice(0, maxItemBytes) };
    } catch {
      return { unavailable: true };
    }
  });
}

function workspaceEvidence(task: A2aTask, rootTraceId: string): Record<string, unknown> {
  const data = evidence(task) ?? {};
  return {
    taskId: task.id,
    contextId: task.contextId,
    rootTraceId,
    workflowId: HERMES_DEV_WORKFLOW_ID,
    state: task.status.state,
    currentStage: boundedString(data['currentStage'], 128),
    repository: boundedString(data['repository'], 1_000),
    branchName: boundedString(data['branchName'], 512),
    pullRequestNumber: typeof data['pullRequestNumber'] === 'number' ? data['pullRequestNumber'] : null,
    plan: boundedString(data['plan'], 12_000),
    fileDiffs: boundedEvidenceItems(data['fileDiffs'], 64, 24_000),
    testsPassed: typeof data['testsPassed'] === 'boolean' ? data['testsPassed'] : null,
    testOutput: boundedString(data['testOutput'], 24_000),
    testProfiles: boundedEvidenceItems(data['testProfiles'], 32, 2_000),
    reviewPassed: typeof data['reviewPassed'] === 'boolean' ? data['reviewPassed'] : null,
    review: boundedString(data['review'], 12_000),
    revisionHistory: boundedEvidenceItems(data['revisionHistory'], 16, 12_000),
    // This projection intentionally never exposes a filesystem path, shell,
    // credential, arbitrary file reader or raw workspace transport.
    scope: 'owned-run-bounded-evidence',
  };
}

function normalizedRun(
  task: A2aTask,
  rootTraceId: string,
  includeArtifacts: boolean,
): Record<string, unknown> {
  const workflowEvidence = evidence(task);
  const state = task.status.state;
  return {
    taskId: task.id,
    contextId: task.contextId,
    rootTraceId,
    workflowId: HERMES_DEV_WORKFLOW_ID,
    state,
    currentStage: boundedString(workflowEvidence?.['currentStage'], 128),
    approvalRequired: state === 'TASK_STATE_INPUT_REQUIRED',
    terminal: TERMINAL_TASK_STATES.has(state),
    successful: state === 'TASK_STATE_COMPLETED',
    statusMessage: task.status.message ?? null,
    ...(includeArtifacts ? { artifacts: task.artifacts ?? [] } : {}),
  };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HermesDevBridgeError(400, code, 'Hermes Argus Dev bridge input is invalid');
  return parsed.data;
}

export class HermesDevBridge {
  constructor(
    private readonly gateway: A2aGateway,
    private readonly tasks: HermesDevBridgeTaskStore,
  ) {}

  private caller(raw: HermesDevBridgeCaller): HermesDevBridgeCaller {
    const parsed = parseOrThrow(callerSchema, raw, 'invalid_bridge_principal');
    return { ...parsed, allowedBundleIds: [...new Set(parsed.allowedBundleIds)] };
  }

  private async ownedTask(
    rawCaller: HermesDevBridgeCaller,
    rawTask: { taskId: string },
  ): Promise<{ caller: HermesDevBridgeCaller; record: HermesDevBridgeTaskRecord }> {
    const caller = this.caller(rawCaller);
    const { taskId } = parseOrThrow(taskSchema, rawTask, 'invalid_bridge_task');
    const record = await this.tasks.findOwned(
      taskId,
      caller.userId,
      caller.apiKeyPrefix,
      caller.tenantKey,
      caller.workspaceKey,
    );
    // Return 404 for both missing and foreign tasks so task IDs cannot be used
    // as an ownership oracle across personal Hermes profiles.
    if (!record) throw new HermesDevBridgeError(404, 'bridge_task_not_found', 'Argus Dev run was not found');
    return { caller, record };
  }

  async capabilities(rawCaller: HermesDevBridgeCaller): Promise<Record<string, unknown>> {
    const caller = this.caller(rawCaller);
    const card = await this.gateway.getAgentCard(HERMES_DEV_PACK_ID, HERMES_DEV_AGENT_ID);
    const workflow = workflowDefinition(card);
    if (!workflow) {
      throw new HermesDevBridgeError(409, 'argus_dev_workflow_unavailable', 'The standard Argus Dev workflow is not advertised');
    }
    return {
      bridgeVersion: 'v1',
      direction: 'hermes-personal-to-argus-dev',
      packId: HERMES_DEV_PACK_ID,
      agentId: HERMES_DEV_AGENT_ID,
      workflow,
      projectedBundleIds: caller.allowedBundleIds,
      tenantKey: caller.tenantKey,
      workspaceKey: caller.workspaceKey,
      workerRecursion: 'blocked-by-separate-mcp-catalog',
      workspaceEvidence: 'owned-run-bounded-read-only',
    };
  }

  async preflight(rawCaller: HermesDevBridgeCaller): Promise<Record<string, unknown>> {
    const caller = this.caller(rawCaller);
    const result = await this.gateway.sendMessage(
      HERMES_DEV_PACK_ID,
      HERMES_DEV_AGENT_ID,
      {
        text: 'Check the standard governed Argus Dev workflow for this connected personal Hermes.',
        data: { operation: 'coding.preflight' },
      },
      {
        principalKind: 'user',
        principalId: String(caller.userId),
        tenantKey: caller.tenantKey,
        workspaceKey: caller.workspaceKey,
        principalAllowedBundleIds: caller.allowedBundleIds,
        requestedBundleIds: caller.allowedBundleIds,
      },
    );
    return normalizedRun(result.task, result.rootTraceId, true);
  }

  async start(
    rawCaller: HermesDevBridgeCaller,
    rawInput: { ticketId: string; description: string; originSessionRef?: string },
  ): Promise<Record<string, unknown>> {
    const caller = this.caller(rawCaller);
    const input = parseOrThrow(startSchema, rawInput, 'invalid_bridge_start');
    const result: A2aInvocationResult = await this.gateway.sendMessage(
      HERMES_DEV_PACK_ID,
      HERMES_DEV_AGENT_ID,
      {
        text: 'Start the standard governed Argus Dev workflow from a connected personal Hermes.',
        data: {
          operation: 'coding.start',
          input: { ticket_id: input.ticketId, description: input.description },
        },
      },
      {
        principalKind: 'user',
        principalId: String(caller.userId),
        tenantKey: caller.tenantKey,
        workspaceKey: caller.workspaceKey,
        principalAllowedBundleIds: caller.allowedBundleIds,
        requestedBundleIds: caller.allowedBundleIds,
      },
    );
    try {
      await this.tasks.record({
        taskId: result.task.id,
        contextId: result.task.contextId,
        principalUserId: caller.userId,
        apiKeyPrefix: caller.apiKeyPrefix,
        rootTraceId: result.rootTraceId,
        tenantKey: caller.tenantKey,
        workspaceKey: caller.workspaceKey,
        ...(input.originSessionRef ? { originSessionRef: input.originSessionRef } : {}),
      });
    } catch {
      // A started task without a durable Core owner must not keep running. The
      // remote start cannot participate in our DB transaction, so compensate
      // immediately and fail closed if the ownership write is unavailable.
      await this.gateway.cancelTask(
        HERMES_DEV_PACK_ID,
        HERMES_DEV_AGENT_ID,
        result.task.id,
      ).catch(() => undefined);
      throw new HermesDevBridgeError(
        503,
        'bridge_task_binding_failed',
        'Argus Dev run ownership could not be recorded',
      );
    }
    return normalizedRun(result.task, result.rootTraceId, true);
  }

  async getRun(rawCaller: HermesDevBridgeCaller, rawTask: { taskId: string }): Promise<Record<string, unknown>> {
    const { record } = await this.ownedTask(rawCaller, rawTask);
    const task = await this.gateway.getTask(HERMES_DEV_PACK_ID, HERMES_DEV_AGENT_ID, record.taskId);
    return normalizedRun(task, record.rootTraceId, false);
  }

  async getResult(rawCaller: HermesDevBridgeCaller, rawTask: { taskId: string }): Promise<Record<string, unknown>> {
    const { record } = await this.ownedTask(rawCaller, rawTask);
    const task = await this.gateway.getTask(HERMES_DEV_PACK_ID, HERMES_DEV_AGENT_ID, record.taskId);
    if (!TERMINAL_TASK_STATES.has(task.status.state)) {
      throw new HermesDevBridgeError(409, 'bridge_result_not_ready', 'Argus Dev run has not reached a terminal state');
    }
    return normalizedRun(task, record.rootTraceId, true);
  }

  async getWorkspaceEvidence(rawCaller: HermesDevBridgeCaller, rawTask: { taskId: string }): Promise<Record<string, unknown>> {
    const { record } = await this.ownedTask(rawCaller, rawTask);
    const task = await this.gateway.getTask(HERMES_DEV_PACK_ID, HERMES_DEV_AGENT_ID, record.taskId);
    return workspaceEvidence(task, record.rootTraceId);
  }

  async cancel(rawCaller: HermesDevBridgeCaller, rawTask: { taskId: string }): Promise<Record<string, unknown>> {
    const { record } = await this.ownedTask(rawCaller, rawTask);
    const task = await this.gateway.cancelTask(HERMES_DEV_PACK_ID, HERMES_DEV_AGENT_ID, record.taskId);
    return normalizedRun(task, record.rootTraceId, false);
  }
}

function mcpResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function mcpFailure(cause: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (cause instanceof HermesDevBridgeError || cause instanceof A2aClientError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: cause.code, message: cause.message } }) }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: 'argus_dev_bridge_failed', message: 'Argus Dev bridge request failed' } }) }],
    isError: true,
  };
}

export function registerHermesDevBridgeTools(
  server: McpServer,
  bridge: HermesDevBridge,
  caller: HermesDevBridgeCaller,
): void {
  server.tool(
    'argus_dev_capabilities',
    'Discover the governed Argus Dev coding workflow, required inputs, approval gates and projected MCP Bundle scope.',
    {},
    async () => {
      try { return mcpResult(await bridge.capabilities(caller)); } catch (cause) { return mcpFailure(cause); }
    },
  );
  server.tool(
    'argus_dev_preflight',
    'Check whether the standard Argus Dev workflow and this personal Hermes Bundle projection are ready. Does not start coding.',
    {},
    async () => {
      try { return mcpResult(await bridge.preflight(caller)); } catch (cause) { return mcpFailure(cause); }
    },
  );
  server.tool(
    'argus_dev_start_workflow',
    'Start the standard governed Argus Dev ticket-to-pull-request workflow. External writes and delivery remain subject to Argus approvals.',
    {
      ticket_id: z.string().trim().min(1).max(128).describe('Stable ticket or task identifier'),
      description: z.string().trim().min(1).max(20_000).describe('Implementation goal, constraints and acceptance criteria'),
      origin_session_ref: stableId.optional().describe('Opaque stable reference to the personal Hermes session; stored only as a hash'),
    },
    async args => {
      try {
        return mcpResult(await bridge.start(caller, {
          ticketId: args.ticket_id,
          description: args.description,
          ...(args.origin_session_ref ? { originSessionRef: args.origin_session_ref } : {}),
        }));
      } catch (cause) { return mcpFailure(cause); }
    },
  );
  server.tool(
    'argus_dev_get_run',
    'Read the normalized live state, current stage, approval state and root trace ID of a run started by this Hermes identity.',
    { task_id: stableId },
    async args => {
      try { return mcpResult(await bridge.getRun(caller, { taskId: args.task_id })); } catch (cause) { return mcpFailure(cause); }
    },
  );
  server.tool(
    'argus_dev_get_result',
    'Read bounded result artifacts after an Argus Dev run reaches a terminal state.',
    { task_id: stableId },
    async args => {
      try { return mcpResult(await bridge.getResult(caller, { taskId: args.task_id })); } catch (cause) { return mcpFailure(cause); }
    },
  );
  server.tool(
    'argus_dev_get_workspace_evidence',
    'Read bounded repository, diff, test and review evidence from a run owned by this Hermes identity. This is not arbitrary filesystem or shell access.',
    { task_id: stableId },
    async args => {
      try { return mcpResult(await bridge.getWorkspaceEvidence(caller, { taskId: args.task_id })); } catch (cause) { return mcpFailure(cause); }
    },
  );
  server.tool(
    'argus_dev_cancel_run',
    'Request cancellation of a run started by this Hermes identity through the canonical Argus Dev lifecycle.',
    { task_id: stableId },
    async args => {
      try { return mcpResult(await bridge.cancel(caller, { taskId: args.task_id })); } catch (cause) { return mcpFailure(cause); }
    },
  );
}
