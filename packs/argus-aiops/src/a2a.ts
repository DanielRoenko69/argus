import { randomUUID } from 'node:crypto';
import {
  buildInvestigationPlan,
  hashResolvedServiceContext,
  ResolvedServiceContextSchema,
  type ResolvedServiceContext,
} from './domain.js';
import { decodePackExecutionGrant, PackExecutionGrantError } from './executionGrant.js';
import type { A2aTask, TaskStore } from './taskStore.js';
import type { InvestigationExecutor } from './investigationRunner.js';
import { getWorkflow, workflowCatalog } from './workflowCatalog.js';

export const A2A_VERSION = '1.0';
export const A2A_CONTENT_TYPE = 'application/a2a+json';
export const A2A_AGENT_CARD_PATH = '/.well-known/agent-card.json';
const ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;

export class A2aProtocolError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message);
    this.name = 'A2aProtocolError';
  }
}

export function a2aErrorBody(error: A2aProtocolError): JsonObject {
  return { error: { code: error.reason, message: error.message } };
}

export function buildArgusAiopsAgentCard(publicUrl: string, secured: boolean): JsonObject {
  const url = new URL(publicUrl);
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('ARGUS_A2A_PUBLIC_URL must not contain a path');
  return {
    name: 'Argus AIOps Incident Orchestrator',
    description: 'Governed, evidence-first operational incident investigation.',
    version: '0.3.0',
    supportedInterfaces: [{ url: url.origin, protocolBinding: 'HTTP+JSON', protocolVersion: A2A_VERSION }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      aiopsServiceContextVersion: 1,
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [
      {
        id: 'aiops-preflight',
        name: 'AIOps investigation preflight',
        description: 'Checks the workflow, Core agent roles and provider-neutral MCP capability boundary.',
        tags: ['aiops', 'preflight', 'governance'],
      },
      ...workflowCatalog().map(workflow => ({
        id: workflow.id,
        name: workflow.label,
        description: workflow.description,
        tags: workflow.tags,
        'x-argus-workflow': workflow,
      })),
    ],
    ...(secured ? {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      securityRequirements: [{ bearerAuth: [] }],
    } : {}),
  };
}

function record(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new A2aProtocolError(400, 'INVALID_REQUEST', message);
  return value as JsonObject;
}

interface ParsedMessage {
  message: JsonObject;
  operation: 'workflow.preflight' | 'workflow.start';
  workflowId: string;
  input: JsonObject;
  coreBundleCapabilityPreflight?: JsonObject;
  resolvedServiceContext?: JsonObject;
}

function parseMessage(body: unknown): ParsedMessage {
  const root = record(body, 'request body must be an object');
  const message = record(root['message'], 'message is required');
  const messageId = message['messageId'];
  if (typeof messageId !== 'string' || !ID_PATTERN.test(messageId)) throw new A2aProtocolError(400, 'INVALID_REQUEST', 'messageId is invalid');
  if (message['role'] !== 'ROLE_USER') throw new A2aProtocolError(400, 'INVALID_REQUEST', 'message role must be ROLE_USER');
  const parts = message['parts'];
  if (!Array.isArray(parts) || parts.length === 0) throw new A2aProtocolError(400, 'INVALID_REQUEST', 'message parts are required');
  const data = parts
    .map(part => part && typeof part === 'object' && !Array.isArray(part) ? (part as JsonObject)['data'] : undefined)
    .find(value => value && typeof value === 'object' && !Array.isArray(value));
  const payload = record(data, 'a JSON data part is required');
  const operation = payload['operation'];
  if (operation !== 'workflow.preflight' && operation !== 'workflow.start') {
    throw new A2aProtocolError(400, 'UNSUPPORTED_OPERATION', 'operation must be workflow.preflight or workflow.start');
  }
  const workflowId = payload['workflowId'];
  if (typeof workflowId !== 'string' || !getWorkflow(workflowId)) throw new A2aProtocolError(400, 'UNKNOWN_WORKFLOW', 'workflowId is not registered');
  const input = payload['input'] === undefined ? {} : record(payload['input'], 'workflow input must be an object');
  const coreEvidence = payload['coreBundleCapabilityPreflight'];
  const serviceContext = payload['resolvedServiceContext'];
  return {
    message,
    operation,
    workflowId,
    input,
    ...(coreEvidence && typeof coreEvidence === 'object' && !Array.isArray(coreEvidence)
      ? { coreBundleCapabilityPreflight: coreEvidence as JsonObject }
      : {}),
    ...(serviceContext && typeof serviceContext === 'object' && !Array.isArray(serviceContext)
      ? { resolvedServiceContext: serviceContext as JsonObject }
      : {}),
  };
}

function sortedUnique<T extends string | number>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function assertProfileContextBound(
  rawContext: JsonObject | undefined,
  grant: ReturnType<typeof decodePackExecutionGrant>,
): ResolvedServiceContext | undefined {
  const reference = grant.claims.aiopsServiceContext;
  if (!rawContext && !reference) return undefined;
  if (!rawContext || !reference) {
    throw new A2aProtocolError(403, 'SERVICE_CONTEXT_SCOPE_MISMATCH', 'service context and signed grant reference must both be present');
  }
  const context = ResolvedServiceContextSchema.parse(rawContext);
  if (context.profile.id !== reference.profileId
    || context.profile.revision !== reference.revision
    || context.profile.sha256 !== reference.profileSha256
    || hashResolvedServiceContext(context) !== reference.resolvedContextSha256) {
    throw new A2aProtocolError(403, 'SERVICE_CONTEXT_SCOPE_MISMATCH', 'service profile identity or content hash does not match the signed grant');
  }
  const contextBundles = sortedUnique(context.evidence.lanes.map(lane => lane.bundleId));
  const contextTools = sortedUnique(context.evidence.lanes.flatMap(lane => lane.toolNames));
  if (JSON.stringify(contextBundles) !== JSON.stringify(sortedUnique(grant.claims.bundleIds))
    || JSON.stringify(contextTools) !== JSON.stringify(sortedUnique(grant.claims.toolNames ?? []))) {
    throw new A2aProtocolError(403, 'SERVICE_CONTEXT_SCOPE_MISMATCH', 'service profile bundle or tool scope does not match the signed grant');
  }
  const runtime = context.selectors.runtime;
  const scope = grant.claims.resourceScope;
  if (runtime && (!scope || runtime.backendId !== scope.backendId || runtime.targetId !== scope.targetId
    || runtime.cluster !== scope.cluster || runtime.namespace !== scope.namespace
    || context.service.environment !== scope.environment)) {
    throw new A2aProtocolError(403, 'EXECUTION_TARGET_SCOPE_MISMATCH', 'service profile runtime target does not match the signed grant');
  }
  if (!runtime && scope) {
    throw new A2aProtocolError(403, 'EXECUTION_TARGET_SCOPE_MISMATCH', 'a runtime target was granted outside the service profile');
  }
  return context;
}

function agentMessage(text: string): A2aTask['status']['message'] {
  return { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }] };
}

function completedTask(input: {
  contextId: string;
  artifactName: string;
  artifactDescription: string;
  artifact: JsonObject;
  message: string;
  metadata: JsonObject;
  history: JsonObject[];
}): A2aTask {
  return {
    id: randomUUID(),
    contextId: input.contextId,
    status: {
      state: 'TASK_STATE_COMPLETED',
      timestamp: new Date().toISOString(),
      message: agentMessage(input.message),
    },
    artifacts: [{
      artifactId: randomUUID(),
      name: input.artifactName,
      description: input.artifactDescription,
      parts: [{ data: input.artifact }],
    }],
    history: input.history,
    metadata: input.metadata,
  };
}

export async function sendA2aMessage(
  store: TaskStore,
  body: unknown,
  headers: { executionGrant?: string; rootTraceId?: string },
  executor?: InvestigationExecutor,
): Promise<A2aTask> {
  const parsed = parseMessage(body);
  const workflow = getWorkflow(parsed.workflowId)!;
  const contextId = typeof parsed.message['contextId'] === 'string' && ID_PATTERN.test(parsed.message['contextId'])
    ? parsed.message['contextId']
    : randomUUID();
  const rootTraceId = headers.rootTraceId ?? '';
  const baseMetadata = {
    packId: 'argus.aiops',
    packAgentId: 'incident-orchestrator',
    workflowId: workflow.id,
    rootTraceId,
    readOnly: true,
  };

  if (parsed.operation === 'workflow.preflight') {
    const capabilityEvidence = parsed.coreBundleCapabilityPreflight;
    const task = completedTask({
      contextId,
      artifactName: 'AIOps workflow preflight',
      artifactDescription: 'Pack-owned evidence for the read-only incident investigation contract.',
      artifact: {
        kind: 'aiops-preflight',
        schemaVersion: 1,
        workflowId: workflow.id,
        requiredAgents: workflow.requiredAgents,
        requiredBundleCategories: workflow.requiredBundleCategories,
        recommendedBundleCategories: workflow.recommendedBundleCategories,
        requiredExecutionTargetKinds: workflow.requiredExecutionTargetKinds,
        coreBundleCapabilityPreflight: capabilityEvidence ?? null,
        ready: capabilityEvidence?.['ok'] === true,
      },
      message: capabilityEvidence?.['ok'] === true
        ? 'The read-only incident investigation contract is ready.'
        : 'The workflow contract is valid; Core capability evidence is incomplete.',
      metadata: baseMetadata,
      history: [parsed.message],
    });
    await store.save(task);
    return task;
  }

  if (!headers.executionGrant || !UUID_PATTERN.test(rootTraceId)) {
    throw new A2aProtocolError(401, 'EXECUTION_GRANT_REQUIRED', 'workflow.start requires a Core execution grant and root trace ID');
  }
  let grant;
  try {
    grant = decodePackExecutionGrant(headers.executionGrant, {
      packId: 'argus.aiops',
      agentId: 'incident-orchestrator',
      messageId: String(parsed.message['messageId']),
      rootTraceId,
    });
  } catch (cause) {
    throw new A2aProtocolError(401, 'INVALID_EXECUTION_GRANT', cause instanceof PackExecutionGrantError ? cause.message : 'execution grant is invalid');
  }
  let plan;
  try {
    const serviceContext = assertProfileContextBound(parsed.resolvedServiceContext, grant);
    if (!serviceContext && (!grant.claims.resourceScope
      || parsed.input['environment'] !== grant.claims.resourceScope.environment)) {
      throw new A2aProtocolError(
        403,
        'EXECUTION_TARGET_SCOPE_MISMATCH',
        'workflow environment must exactly match the environment signed by Argus Core',
      );
    }
    plan = buildInvestigationPlan(parsed.input, {
      selectedBundleIds: grant.claims.bundleIds,
      resourceScope: grant.claims.resourceScope,
      ...(serviceContext ? { serviceContext } : {}),
    });
  } catch (cause) {
    if (cause instanceof A2aProtocolError) throw cause;
    const message = cause instanceof Error ? cause.message : 'workflow input is invalid';
    throw new A2aProtocolError(400, 'INVALID_WORKFLOW_INPUT', message);
  }
  const task = completedTask({
    contextId,
    artifactName: 'Read-only incident investigation plan',
    artifactDescription: 'Normalized scope, evidence lanes and untested hypotheses. Provider execution is the next implementation stage.',
    artifact: plan as unknown as JsonObject,
    message: 'The incident has been scoped into a read-only, evidence-first investigation plan.',
    metadata: {
      ...baseMetadata,
      operation: 'workflow.start',
      grantId: grant.claims.jti,
      ...(grant.claims.aiopsServiceContext ? {
        serviceProfile: grant.claims.aiopsServiceContext,
      } : {}),
    },
    history: [parsed.message],
  });
  if (executor) {
    task.status = {
      state: 'TASK_STATE_WORKING',
      timestamp: new Date().toISOString(),
      message: agentMessage('The incident scope is valid. Read-only evidence collection is starting.'),
    };
    task.metadata = { ...task.metadata, currentStage: 'collect_evidence', implementationStage: 'agent-evidence' };
  }
  await store.save(task);
  executor?.start({ taskId: task.id, plan, grant });
  return task;
}

export async function cancelA2aTask(store: TaskStore, taskId: string): Promise<A2aTask> {
  const task = await store.get(taskId);
  if (!task) throw new A2aProtocolError(404, 'TASK_NOT_FOUND', 'task not found');
  if (['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(task.status.state)) {
    throw new A2aProtocolError(409, 'TASK_NOT_CANCELABLE', 'terminal task cannot be canceled');
  }
  const canceled: A2aTask = {
    ...task,
    status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString(), message: agentMessage('Task canceled.') },
  };
  await store.save(canceled);
  return canceled;
}
