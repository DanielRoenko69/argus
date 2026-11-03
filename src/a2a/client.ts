import { randomBytes, randomUUID } from 'node:crypto';
import { codegenScope } from '../solutionPacks/codeGenerationContract.js';
import { z } from 'zod';
import {
  readSolutionPackServiceToken,
  type SolutionPackEndpoint,
  type SolutionPackRegistry,
} from '../solutionPacks/discovery.js';
import {
  ExecutionGrantError,
  type ExecutionGrantIssueInput,
  type ExecutionTargetReadiness,
} from '../solutionPacks/executionGrant.js';
import {
  resolveSolutionPackRuntimeSelection,
  type SolutionPackRuntimeMode,
  type SolutionPackRuntimeSelection,
  type WorkflowRuntimeContract,
} from '../solutionPacks/runtimeSelection.js';
import { recordSolutionPackRuntimeSelection } from '../solutionPacks/runtimeSelectionTelemetry.js';
import type { BundleCapabilityCheck } from '../solutionPacks/bundleCapabilities.js';
import type { ExecutionResourceScopeRequest } from '../solutionPacks/executionTargets.js';

export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_MEDIA_TYPE = 'application/a2a+json';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

const agentInterfaceSchema = z.object({
  url: z.string().url(),
  protocolBinding: z.string().min(1).max(256),
  protocolVersion: z.string().min(1).max(64),
}).passthrough();

export const a2aAgentCardSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).optional(),
  version: z.string().trim().min(1).max(100),
  supportedInterfaces: z.array(agentInterfaceSchema).min(1).max(16).refine(
    interfaces => interfaces.some(item => item.protocolBinding === 'HTTP+JSON'
      && item.protocolVersion === A2A_PROTOCOL_VERSION),
    'must advertise an HTTP+JSON v1.0 interface',
  ),
  capabilities: z.record(z.unknown()).default({}),
  defaultInputModes: z.array(z.string()).min(1).max(32),
  defaultOutputModes: z.array(z.string()).min(1).max(32),
  skills: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    tags: z.array(z.string()).max(64).optional(),
  }).passthrough()).min(1).max(128),
  securitySchemes: z.record(z.unknown()).optional(),
  securityRequirements: z.array(z.record(z.unknown())).optional(),
}).passthrough();

const partSchema = z.union([
  z.object({ text: z.string().max(100_000) }).passthrough(),
  z.object({ data: z.record(z.unknown()) }).passthrough(),
]);

const messageSchema = z.object({
  messageId: z.string().min(1).max(128),
  role: z.enum(['ROLE_USER', 'ROLE_AGENT']),
  parts: z.array(partSchema).min(1).max(64),
  contextId: z.string().max(128).optional(),
  taskId: z.string().max(128).optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

export const a2aTaskSchema = z.object({
  id: z.string().min(1).max(128),
  contextId: z.string().min(1).max(128),
  status: z.object({
    state: z.enum([
      'TASK_STATE_SUBMITTED',
      'TASK_STATE_WORKING',
      'TASK_STATE_COMPLETED',
      'TASK_STATE_FAILED',
      'TASK_STATE_CANCELED',
      'TASK_STATE_REJECTED',
      'TASK_STATE_INPUT_REQUIRED',
      'TASK_STATE_AUTH_REQUIRED',
    ]),
    timestamp: z.string().optional(),
    message: messageSchema.optional(),
  }).passthrough(),
  artifacts: z.array(z.object({
    artifactId: z.string().min(1).max(128),
    parts: z.array(partSchema).min(1).max(64),
  }).passthrough()).max(128).optional(),
  history: z.array(messageSchema).max(256).optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

const sendResponseSchema = z.object({ task: a2aTaskSchema }).passthrough();
const taskListEntrySchema = z.object({
  task: a2aTaskSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
const taskListResponseSchema = z.object({
  tasks: z.array(taskListEntrySchema).max(50),
  nextCursor: z.string().min(1).max(512).nullable().optional(),
});

export type A2aAgentCard = z.infer<typeof a2aAgentCardSchema>;
export type A2aTask = z.infer<typeof a2aTaskSchema>;
export type A2aTaskListEntry = z.infer<typeof taskListEntrySchema>;

export interface A2aTaskListPage {
  tasks: A2aTaskListEntry[];
  nextCursor: string | null;
}

export interface A2aSendInput {
  text?: string;
  data?: Record<string, unknown>;
  contextId?: string;
}

export interface A2aInvocationResult {
  rootTraceId: string;
  agentCard: A2aAgentCard;
  task: A2aTask;
}

export interface A2aExecutionContext {
  principalKind: ExecutionGrantIssueInput['principalKind'];
  principalId: string;
  tenantKey?: string;
  workspaceKey?: string;
  principalAllowedBundleIds: number[] | null;
  requestedBundleIds: number[];
  /** Core-resolved subset of tools available to this task. Never accepted from browser routes. */
  requestedToolNames?: string[];
  /** Profile-derived capability contract; replaces the Pack's generic workflow defaults. */
  requiredBundleCategories?: string[];
  /** Immutable AIOps profile/context reference signed into the execution grant. */
  aiopsServiceContext?: ExecutionGrantIssueInput['aiopsServiceContext'];
  requestedResourceScope?: ExecutionResourceScopeRequest;
  runtimeMode?: SolutionPackRuntimeMode;
}

export interface A2aExecutionGrantIssuer {
  issue(input: ExecutionGrantIssueInput): Promise<string>;
  assertRepositoryCheckout?(bundleIds: number[], repository?: string): Promise<void>;
  checkBundleCapabilities?(
    bundleIds: number[],
    requiredCategories: string[],
    requiredToolNames?: string[],
  ): Promise<BundleCapabilityCheck>;
  assertRuntimeSelection?(
    packId: string,
    bundleIds: number[],
    runtimeMode: Exclude<SolutionPackRuntimeMode, 'auto'> | undefined,
  ): Promise<void>;
  checkExecutionTargetReadiness?(
    packId: string,
    bundleIds: number[],
    requestedResourceScope: ExecutionResourceScopeRequest,
  ): Promise<ExecutionTargetReadiness>;
  finalizeRootTrace?(rootTraceId: string, status: 'completed' | 'failed' | 'cancelled', output: Record<string, unknown>): Promise<void>;
}

export function codingGenerationScope(input: A2aSendInput): string[] {
  const raw = input.data?.['input'] as Record<string, unknown> | undefined;
  const value = raw?.['allowed_files'];
  if (value !== undefined && typeof value !== 'string') throw new ExecutionGrantError(400, 'codegen_scope_invalid', 'Invalid allowed change paths');
  const paths = String(value ?? '').split(/[\n,]/).map(p => p.trim()).filter(Boolean);
  try { return codegenScope([...new Set(paths)]); }
  catch { throw new ExecutionGrantError(400, 'codegen_scope_invalid', 'Generator scope requires ordinary exact repository-relative file paths'); }
}

export function codingWorkspaceRoot(input: A2aSendInput, attemptId?: string): string | undefined {
  const data = input.data;
  if (!data || !['coding.start', 'workflow.start'].includes(String(data['operation'] ?? ''))) return undefined;
  const rawInput = data['input'];
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined;
  // Backlog Planning seeds ticket_id from backlog_id inside the Pack, after
  // this grant is issued. Bind the same identifier now; a supplied ticket_id
  // must not override the workspace the graph will actually provision.
  const workspaceIdField = data['operation'] === 'workflow.start' && data['workflowId'] === 'backlog-grooming'
    ? 'backlog_id'
    : 'ticket_id';
  const ticketId = (rawInput as Record<string, unknown>)[workspaceIdField];
  if (typeof ticketId === 'string' && ticketId.trim()) {
    const safe = ticketId.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const retrySuffix = data['retry'] && attemptId && /^[a-f0-9-]{36}$/i.test(attemptId) ? `-retry-${attemptId}` : '';
    return `/workspace/${safe || 'untitled'}${retrySuffix}`;
  }
  // Visual Agent chains are a prototype runtime over the already sandboxed
  // workspace volume. They do not yet own repository checkout/provisioning,
  // but their execution grant must still explicitly bind that boundary.
  const workflowId = data['workflowId'];
  return typeof workflowId === 'string' && /^visual-[A-Za-z0-9-]{1,120}$/.test(workflowId)
    ? `/workspace/${workflowId}`
    : undefined;
}

function requiredBundleCategories(
  card: A2aAgentCard,
  input: A2aSendInput,
): string[] {
  const operation = typeof input.data?.['operation'] === 'string' ? input.data['operation'] : '';
  if (!['coding.start', 'workflow.start', 'coding.preflight', 'workflow.preflight'].includes(operation)) return [];
  const workflowId = operation === 'coding.start' || operation === 'coding.preflight'
    ? 'ticket-to-pull-request'
    : typeof input.data?.['workflowId'] === 'string' ? input.data['workflowId'] : '';
  const skill = card.skills.find(item => item.id === workflowId);
  const definition = skill?.['x-argus-workflow'];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return [];
  const categories = (definition as Record<string, unknown>)['requiredBundleCategories'];
  if (!Array.isArray(categories)) return [];
  return [...new Set(categories.filter((value): value is string => typeof value === 'string'))];
}

function workflowRuntimeContract(card: A2aAgentCard, input: A2aSendInput): WorkflowRuntimeContract | null {
  const operation = typeof input.data?.['operation'] === 'string' ? input.data['operation'] : '';
  if (!['coding.start', 'workflow.start', 'coding.preflight', 'workflow.preflight'].includes(operation)) return null;
  const workflowId = operation === 'coding.start' || operation === 'coding.preflight'
    ? 'ticket-to-pull-request'
    : typeof input.data?.['workflowId'] === 'string' ? input.data['workflowId'] : '';
  const definition = card.skills.find(item => item.id === workflowId)?.['x-argus-workflow'];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null;
  return { id: workflowId, ...(definition as Record<string, unknown>) };
}

function requiredExecutionTargetKinds(card: A2aAgentCard, input: A2aSendInput): string[] {
  const operation = typeof input.data?.['operation'] === 'string' ? input.data['operation'] : '';
  if (!['workflow.start', 'workflow.preflight'].includes(operation)) return [];
  const workflowId = typeof input.data?.['workflowId'] === 'string' ? input.data['workflowId'] : '';
  const definition = card.skills.find(item => item.id === workflowId)?.['x-argus-workflow'];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return [];
  const kinds = (definition as Record<string, unknown>)['requiredExecutionTargetKinds'];
  return Array.isArray(kinds)
    ? [...new Set(kinds.filter((value): value is string => typeof value === 'string'))]
    : [];
}

export interface A2aGateway {
  getAgentCard(packId: string, agentId: string): Promise<A2aAgentCard>;
  sendMessage(
    packId: string,
    agentId: string,
    input: A2aSendInput,
    execution?: A2aExecutionContext,
  ): Promise<A2aInvocationResult>;
  listTasks(packId: string, agentId: string, input?: { limit?: number; cursor?: string }): Promise<A2aTaskListPage>;
  getTask(packId: string, agentId: string, taskId: string): Promise<A2aTask>;
  cancelTask(packId: string, agentId: string, taskId: string): Promise<A2aTask>;
}

export interface A2aClientOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  readTokenFile?: (filename: string) => Promise<string>;
  executionGrantIssuer?: A2aExecutionGrantIssuer;
  managedHermesAvailable?: () => Promise<boolean>;
}

export class A2aClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'A2aClientError';
  }
}

interface ResolvedAgent {
  endpoint: SolutionPackEndpoint;
  cardPath: string;
  coreAgentNames: string[];
}

function taskId(value: string): string {
  if (!TASK_ID_PATTERN.test(value)) throw new A2aClientError(400, 'invalid_task_id', 'invalid A2A task id');
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new A2aClientError(502, 'response_too_large', 'A2A response exceeds 1 MiB');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new A2aClientError(502, 'response_too_large', 'A2A response exceeds 1 MiB');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new A2aClientError(502, 'invalid_response', 'A2A peer returned invalid JSON');
  }
}

export class A2aHttpJsonClient implements A2aGateway {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly readTokenFile: (filename: string) => Promise<string>;
  private readonly executionGrantIssuer?: A2aExecutionGrantIssuer;
  private readonly managedHermesAvailable?: () => Promise<boolean>;

  constructor(
    private readonly registry: SolutionPackRegistry,
    options: A2aClientOptions = {},
  ) {
    this.timeoutMs = Math.min(60_000, Math.max(250, options.timeoutMs ?? 10_000));
    this.fetchFn = options.fetchFn ?? fetch;
    this.readTokenFile = options.readTokenFile ?? readSolutionPackServiceToken;
    this.executionGrantIssuer = options.executionGrantIssuer;
    this.managedHermesAvailable = options.managedHermesAvailable;
  }

  private resolveAgent(packId: string, agentId: string): ResolvedAgent {
    const discovered = this.registry.get(packId);
    const endpoint = this.registry.getEndpoint(packId);
    if (!discovered || !endpoint) throw new A2aClientError(404, 'pack_not_found', `solution pack '${packId}' is not configured`);
    if (discovered.state !== 'ready' || !discovered.manifest) {
      throw new A2aClientError(409, 'pack_not_ready', `solution pack '${packId}' is ${discovered.state}`);
    }
    const agent = discovered.manifest.spec.components.agents.find(item => item.id === agentId);
    if (!agent) throw new A2aClientError(404, 'agent_not_found', `pack agent '${agentId}' was not declared`);
    if (agent.runtime !== 'a2a' || !agent.a2aAgentCardPath) {
      throw new A2aClientError(409, 'agent_not_a2a', `pack agent '${agentId}' does not expose A2A`);
    }
    return { endpoint, cardPath: agent.a2aAgentCardPath, coreAgentNames: agent.coreAgents };
  }

  private async headers(endpoint: SolutionPackEndpoint): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: A2A_MEDIA_TYPE,
      'a2a-version': A2A_PROTOCOL_VERSION,
    };
    if (endpoint.tokenFile) headers.authorization = `Bearer ${await this.readTokenFile(endpoint.tokenFile)}`;
    return headers;
  }

  private async request(endpoint: SolutionPackEndpoint, path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${endpoint.endpoint}${path}`, {
        ...init,
        headers: { ...await this.headers(endpoint), ...init.headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      if (cause instanceof A2aClientError) throw cause;
      throw new A2aClientError(502, 'peer_unavailable', cause instanceof Error ? cause.message : String(cause));
    }
    const body = await boundedJson(response);
    if (!response.ok) {
      const peerError = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)['error']
        : undefined;
      const peerMessage = peerError && typeof peerError === 'object' && !Array.isArray(peerError)
        && typeof (peerError as Record<string, unknown>)['message'] === 'string'
        ? String((peerError as Record<string, unknown>)['message'])
        : `HTTP ${response.status}`;
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw new A2aClientError(status, 'peer_rejected', `A2A peer rejected request: ${peerMessage}`);
    }
    return body;
  }

  private async loadAgentCard(resolved: ResolvedAgent): Promise<A2aAgentCard> {
    const body = await this.request(resolved.endpoint, resolved.cardPath, { method: 'GET' });
    const result = a2aAgentCardSchema.safeParse(body);
    if (!result.success) throw new A2aClientError(502, 'invalid_agent_card', 'A2A peer returned an invalid v1 Agent Card');
    const selected = result.data.supportedInterfaces.find(item => item.protocolBinding === 'HTTP+JSON'
      && item.protocolVersion === A2A_PROTOCOL_VERSION)!;
    const selectedUrl = new URL(selected.url);
    if (selectedUrl.origin !== resolved.endpoint.endpoint
      || (selectedUrl.pathname !== '/' && selectedUrl.pathname !== '')
      || selectedUrl.search || selectedUrl.hash) {
      throw new A2aClientError(
        502,
        'agent_card_endpoint_mismatch',
        'A2A Agent Card interface does not match the operator-configured Pack endpoint',
      );
    }
    return result.data;
  }

  async getAgentCard(packId: string, agentId: string): Promise<A2aAgentCard> {
    return this.loadAgentCard(this.resolveAgent(packId, agentId));
  }

  async sendMessage(
    packId: string,
    agentId: string,
    input: A2aSendInput,
    execution?: A2aExecutionContext,
  ): Promise<A2aInvocationResult> {
    if ((!input.text || !input.text.trim()) && !input.data) {
      throw new A2aClientError(400, 'message_required', 'text or data is required');
    }
    if (input.contextId !== undefined && !TASK_ID_PATTERN.test(input.contextId)) {
      throw new A2aClientError(400, 'invalid_context_id', 'invalid A2A context id');
    }
    const operation = typeof input.data?.['operation'] === 'string' ? input.data['operation'] : 'coding.preflight';
    const startsWorkflow = operation === 'coding.start' || operation === 'workflow.start';
    const isPreflight = operation === 'coding.preflight' || operation === 'workflow.preflight';
    if (startsWorkflow && !execution) {
      throw new A2aClientError(400, 'execution_scope_required', 'writing Pack tasks require a Core execution scope');
    }
    if (startsWorkflow && !this.executionGrantIssuer) {
      throw new A2aClientError(503, 'execution_grants_unavailable', 'Core execution grants are not configured');
    }
    const resolved = this.resolveAgent(packId, agentId);
    const agentCard = await this.loadAgentCard(resolved);
    if (execution && (startsWorkflow || isPreflight)) {
      if (execution.principalAllowedBundleIds !== null
        && execution.requestedBundleIds.some(id => !execution.principalAllowedBundleIds!.includes(id))) {
        throw new A2aClientError(403, 'bundle_scope_denied', 'Selected bundles are outside the calling principal scope');
      }
      if (packId === 'argus.dev' && requiredBundleCategories(agentCard, input).includes('repository-checkout')
        && execution.requestedBundleIds.length > 0 && this.executionGrantIssuer?.assertRepositoryCheckout) {
        const raw = input.data?.['input'];
        const repository = raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)['repository'] : undefined;
        try {
          await this.executionGrantIssuer.assertRepositoryCheckout(execution.requestedBundleIds,
            typeof repository === 'string' ? repository : undefined);
        } catch (cause) {
          if (cause instanceof ExecutionGrantError) throw new A2aClientError(cause.status, cause.code, cause.message);
          throw cause;
        }
      }
    }
    const rootTraceId = randomUUID();
    const traceHex = rootTraceId.replaceAll('-', '');
    const spanHex = randomBytes(8).toString('hex');
    const messageId = randomUUID();
    let executionGrant: string | undefined;
    let coreCapabilityEvidence: BundleCapabilityCheck | undefined;
    let coreExecutionTargetEvidence: ExecutionTargetReadiness | undefined;
    let coreRuntimeSelection: SolutionPackRuntimeSelection | undefined;
    if (execution && (startsWorkflow || isPreflight)) {
      if (execution.runtimeMode === 'auto' && packId !== 'argus.dev') {
        throw new A2aClientError(400, 'invalid_runtime_mode', 'automatic runtime selection is available only to Argus Dev');
      }
      const workflow = workflowRuntimeContract(agentCard, input);
      if (!workflow && execution.runtimeMode === 'auto') {
        throw new A2aClientError(409, 'runtime_contract_missing', 'workflow runtime contract is unavailable');
      }
      const workflowId = operation === 'coding.start' || operation === 'coding.preflight'
        ? 'ticket-to-pull-request'
        : typeof input.data?.['workflowId'] === 'string' ? input.data['workflowId'] : 'unknown-workflow';
      const hermesDiscovery = execution.runtimeMode === 'auto'
        ? await this.registry.refreshPack('argus.hermes')
        : this.registry.get('argus.hermes');
      const managedHermesAvailable = hermesDiscovery?.state === 'ready'
        && (execution.runtimeMode !== 'auto' || !this.managedHermesAvailable
          ? true
          : await this.managedHermesAvailable().catch(() => false));
      coreRuntimeSelection = resolveSolutionPackRuntimeSelection(execution.runtimeMode, workflow ?? { id: workflowId }, {
        managedHermesAvailable,
      });
      recordSolutionPackRuntimeSelection(coreRuntimeSelection, {
        rootTraceId,
        packId,
        agentId,
        operation,
      });
    }
    if (execution && (startsWorkflow || isPreflight) && this.executionGrantIssuer?.assertRuntimeSelection) {
      try {
        await this.executionGrantIssuer.assertRuntimeSelection(
          packId,
          execution.requestedBundleIds,
          coreRuntimeSelection?.effectiveMode,
        );
      } catch (cause) {
        if (cause instanceof ExecutionGrantError) {
          throw new A2aClientError(cause.status, cause.code, cause.message);
        }
        throw cause;
      }
    }
    if (execution && startsWorkflow) {
      const requiredCategories = execution.requiredBundleCategories
        ?? requiredBundleCategories(agentCard, input);
      const requiredTargetKinds = execution.aiopsServiceContext
        ? []
        : requiredExecutionTargetKinds(agentCard, input);
      if (requiredTargetKinds.length > 0
        && (!execution.requestedResourceScope
          || !requiredTargetKinds.includes(execution.requestedResourceScope.kind))) {
        throw new A2aClientError(
          409,
          'execution_target_required',
          `Workflow requires a Core-selected execution target: ${requiredTargetKinds.join(', ')}`,
        );
      }
      if (requiredCategories.length > 0 && this.executionGrantIssuer?.checkBundleCapabilities) {
        const capabilityCheck = await this.executionGrantIssuer.checkBundleCapabilities(
          execution.requestedBundleIds,
          requiredCategories,
          execution.requestedToolNames,
        );
        if (!capabilityCheck.ok) {
          const operationalBlockers = capabilityCheck.operationalBlockers ?? [];
          throw new A2aClientError(
            409,
            operationalBlockers.length > 0 ? 'bundle_connections_not_ready' : 'bundle_capabilities_missing',
            operationalBlockers.length > 0
              ? `Selected MCP bundles are not operational: ${operationalBlockers.join('; ')}`
              : `Selected MCP bundles do not provide the required workflow capabilities: ${capabilityCheck.missing.join(', ')}`,
            {
              missing: capabilityCheck.missing,
              operationalIssues: capabilityCheck.operationalIssues ?? [],
            },
          );
        }
      }
      try {
        executionGrant = await this.executionGrantIssuer!.issue({
          packId,
          agentId,
          principalKind: execution.principalKind,
          principalId: execution.principalId,
          tenantKey: execution.tenantKey ?? 'default',
          workspaceKey: execution.workspaceKey ?? 'default',
          principalAllowedBundleIds: execution.principalAllowedBundleIds,
          requestedBundleIds: execution.requestedBundleIds,
          requestedToolNames: execution.requestedToolNames,
          aiopsServiceContext: execution.aiopsServiceContext,
          coreAgentNames: resolved.coreAgentNames,
          messageId,
          rootTraceId,
          workspaceRoot: codingWorkspaceRoot(input, rootTraceId),
          ...(packId === 'argus.dev' && agentId === 'coding-orchestrator' && coreRuntimeSelection?.workflowId === 'ticket-to-pull-request'
            && process.env['ARGUS_GENERAL_STACKS_ENABLED'] === 'true' ? { testEnvironmentPolicy: process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] === 'true'
              ? 'workspace-session-v1' as const : 'general-stack-v1' as const } : {}),
          ...(packId === 'argus.dev' && agentId === 'coding-orchestrator' && coreRuntimeSelection?.workflowId === 'ticket-to-pull-request'
            && process.env['ARGUS_GENERAL_STACKS_ENABLED'] === 'true' && process.env['ARGUS_CODE_GENERATION_ENABLED'] === 'true'
            ? { codeGeneration: { version: 1 as const, allowedPaths: codingGenerationScope(input) } } : {}),
          requestedResourceScope: execution.requestedResourceScope,
          runtimeMode: coreRuntimeSelection?.effectiveMode,
          runtimeSelection: coreRuntimeSelection,
        });
      } catch (cause) {
        if (cause instanceof ExecutionGrantError) {
          throw new A2aClientError(cause.status, cause.code, cause.message);
        }
        throw cause;
      }
    }
    // A read-only preflight may be requested before the operator has selected
    // an execution scope. An empty bundle selection means "not applicable",
    // not "missing every required capability". Workflow starts remain strict
    // above and always require the selected bundles to satisfy the contract.
    if (isPreflight && execution && execution.requestedBundleIds.length > 0 && this.executionGrantIssuer?.checkBundleCapabilities) {
      coreCapabilityEvidence = await this.executionGrantIssuer.checkBundleCapabilities(
        execution.requestedBundleIds,
        requiredBundleCategories(agentCard, input),
        execution.requestedToolNames,
      );
      if (!coreCapabilityEvidence.ok) {
        const operationalBlockers = coreCapabilityEvidence.operationalBlockers ?? [];
        throw new A2aClientError(
          409,
          operationalBlockers.length > 0 ? 'bundle_connections_not_ready' : 'bundle_capabilities_missing',
          operationalBlockers.length > 0
            ? `Selected MCP bundles are not operational: ${operationalBlockers.join('; ')}`
            : `Selected MCP bundles do not provide the required workflow capabilities: ${coreCapabilityEvidence.missing.join(', ')}`,
          {
            missing: coreCapabilityEvidence.missing,
            operationalIssues: coreCapabilityEvidence.operationalIssues ?? [],
          },
        );
      }
    }
    if (isPreflight && execution) {
      const requiredTargetKinds = requiredExecutionTargetKinds(agentCard, input);
      if (requiredTargetKinds.length > 0 && (!execution.requestedResourceScope
        || !requiredTargetKinds.includes(execution.requestedResourceScope.kind))) {
        throw new A2aClientError(
          409,
          'execution_target_required',
          `Workflow requires a Core-selected execution target: ${requiredTargetKinds.join(', ')}`,
        );
      }
      if (execution.requestedResourceScope && this.executionGrantIssuer?.checkExecutionTargetReadiness) {
        try {
          coreExecutionTargetEvidence = await this.executionGrantIssuer.checkExecutionTargetReadiness(
            packId,
            execution.requestedBundleIds,
            execution.requestedResourceScope,
          );
        } catch (cause) {
          if (cause instanceof ExecutionGrantError) {
            throw new A2aClientError(cause.status, cause.code, cause.message);
          }
          throw cause;
        }
      }
    }
    const parts: Array<Record<string, unknown>> = [];
    if (input.text?.trim()) parts.push({ text: input.text.trim() });
    if (input.data) {
      parts.push({ data: {
        ...input.data,
        ...(coreCapabilityEvidence ? { coreBundleCapabilityPreflight: { source: 'argus.core', kind: 'bundle-capability-preflight', selectedBundleIds: execution?.requestedBundleIds ?? [], ...coreCapabilityEvidence } } : {}),
        ...(coreExecutionTargetEvidence ? { coreExecutionTargetPreflight: coreExecutionTargetEvidence } : {}),
        ...(coreRuntimeSelection ? { coreRuntimeSelection } : {}),
      } });
    }
    const body = {
      message: {
        messageId,
        role: 'ROLE_USER',
        parts,
        ...(input.contextId ? { contextId: input.contextId } : {}),
        metadata: {
          argusRootTraceId: rootTraceId,
          argusPackId: packId,
          argusAgentId: agentId,
        },
      },
    };
    const response = await this.request(resolved.endpoint, '/message:send', {
      method: 'POST',
      headers: {
        'content-type': A2A_MEDIA_TYPE,
        traceparent: `00-${traceHex}-${spanHex}-01`,
        'x-argus-root-trace-id': rootTraceId,
        ...(executionGrant ? { 'x-argus-execution-grant': executionGrant } : {}),
      },
      body: JSON.stringify(body),
    });
    const parsed = sendResponseSchema.safeParse(response);
    if (!parsed.success) throw new A2aClientError(502, 'invalid_task', 'A2A peer returned an invalid task response');
    let task = parsed.data.task;
    if (coreRuntimeSelection) {
      task = {
        ...task,
        metadata: { ...(task.metadata ?? {}), coreRuntimeSelection },
        artifacts: [
          ...(task.artifacts ?? []),
          {
            artifactId: randomUUID(),
            name: 'Argus Core runtime selection',
            description: 'Core-owned deterministic runtime-routing evidence for this workflow.',
            parts: [{ data: { ...coreRuntimeSelection } }],
          },
        ],
      };
    }
    if (coreCapabilityEvidence) {
      const hasPersistedEvidence = (task.artifacts ?? []).some(artifact => artifact.parts.some(part => {
        const data = 'data' in part && part.data && typeof part.data === 'object' && !Array.isArray(part.data)
          ? part.data as Record<string, unknown>
          : undefined;
        if (!data) return false;
        if (data['kind'] === 'bundle-capability-preflight') return true;
        const nested = data['coreBundleCapabilityPreflight'];
        return Boolean(nested && typeof nested === 'object' && !Array.isArray(nested)
          && (nested as Record<string, unknown>)['kind'] === 'bundle-capability-preflight');
      }));
      if (!hasPersistedEvidence) {
        task = {
          ...task,
          artifacts: [
            ...(task.artifacts ?? []),
            {
              artifactId: randomUUID(),
              name: 'Argus Core bundle capability preflight',
              description: 'Core-owned evidence that the selected MCP bundles satisfy the workflow contract.',
              parts: [{ data: { source: 'argus.core', kind: 'bundle-capability-preflight', selectedBundleIds: execution?.requestedBundleIds ?? [], ...coreCapabilityEvidence } }],
            },
          ],
        };
      }
    }
    if (coreExecutionTargetEvidence) {
      task = {
        ...task,
        artifacts: [
          ...(task.artifacts ?? []),
          {
            artifactId: randomUUID(),
            name: 'Argus Core execution target preflight',
            description: 'Core-owned connector certification and resource-scope evidence.',
            parts: [{ data: { ...coreExecutionTargetEvidence } }],
          },
        ],
      };
    }
    return { rootTraceId, agentCard, task };
  }

  async getTask(packId: string, agentId: string, rawTaskId: string): Promise<A2aTask> {
    const resolved = this.resolveAgent(packId, agentId);
    const body = await this.request(resolved.endpoint, `/tasks/${encodeURIComponent(taskId(rawTaskId))}`, { method: 'GET' });
    const parsed = a2aTaskSchema.safeParse(body);
    if (!parsed.success) throw new A2aClientError(502, 'invalid_task', 'A2A peer returned an invalid task');
    await this.finalizeTaskTrace(parsed.data);
    return parsed.data;
  }

  async listTasks(
    packId: string,
    agentId: string,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<A2aTaskListPage> {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new A2aClientError(400, 'invalid_task_limit', 'task limit must be an integer from 1 to 50');
    }
    if (input.cursor !== undefined && (input.cursor.length < 1 || input.cursor.length > 512
      || !/^[A-Za-z0-9_-]+$/.test(input.cursor))) {
      throw new A2aClientError(400, 'invalid_task_cursor', 'task cursor is malformed');
    }
    const resolved = this.resolveAgent(packId, agentId);
    const params = new URLSearchParams({ limit: String(limit) });
    if (input.cursor) params.set('cursor', input.cursor);
    const body = await this.request(resolved.endpoint, `/tasks?${params.toString()}`, { method: 'GET' });
    const parsed = taskListResponseSchema.safeParse(body);
    if (!parsed.success) throw new A2aClientError(502, 'invalid_task_catalog', 'A2A peer returned an invalid task catalog');
    return { tasks: parsed.data.tasks, nextCursor: parsed.data.nextCursor ?? null };
  }

  async cancelTask(packId: string, agentId: string, rawTaskId: string): Promise<A2aTask> {
    const resolved = this.resolveAgent(packId, agentId);
    const body = await this.request(resolved.endpoint, `/tasks/${encodeURIComponent(taskId(rawTaskId))}:cancel`, {
      method: 'POST',
      headers: { 'content-type': A2A_MEDIA_TYPE },
      body: '{}',
    });
    const parsed = a2aTaskSchema.safeParse(body);
    if (!parsed.success) throw new A2aClientError(502, 'invalid_task', 'A2A peer returned an invalid canceled task');
    await this.finalizeTaskTrace(parsed.data);
    return parsed.data;
  }

  private async finalizeTaskTrace(task: A2aTask): Promise<void> {
    const rootTraceId = typeof task.metadata?.['rootTraceId'] === 'string'
      ? task.metadata['rootTraceId']
      : typeof task.metadata?.['argusRootTraceId'] === 'string'
        ? task.metadata['argusRootTraceId']
        : null;
    const status = task.status.state === 'TASK_STATE_COMPLETED'
      ? 'completed'
      : task.status.state === 'TASK_STATE_CANCELED'
        ? 'cancelled'
        : ['TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(task.status.state)
          ? 'failed'
          : null;
    if (rootTraceId && status && this.executionGrantIssuer?.finalizeRootTrace) {
      await this.executionGrantIssuer.finalizeRootTrace(rootTraceId, status, {
        taskId: task.id,
        state: task.status.state,
        message: task.status.message?.parts.flatMap(part => 'text' in part ? [part.text] : []).join(' ') ?? null,
      });
    }
  }
}
