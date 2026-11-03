import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { resolveAgentId } from './argus.js';
import { experimentEvidence, type ExperimentState } from './technicalExperiment.js';
import { qaEvidence, type QaState } from './qaAcceptance.js';
import { decodePackExecutionGrant, type PackExecutionGrant } from './executionGrant.js';
import {
  DEFAULT_WORKFLOW_ID,
  evaluateWorkflowCompletion,
  getWorkflowDefinition as getWorkflow,
  validateWorkflowInput,
  workflowCatalog,
  type WorkflowCatalogEntry,
} from './workflowCatalog.js';

export const A2A_VERSION = '1.0';
export const A2A_CONTENT_TYPE = 'application/a2a+json';
export const A2A_AGENT_CARD_PATH = '/.well-known/agent-card.json';
const ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

type JsonObject = Record<string, unknown>;
type A2aOperation = 'workflow.preflight' | 'workflow.start' | 'coding.preflight' | 'coding.start';

interface StoredTaskRow {
  task: JsonObject;
  operation: A2aOperation;
  workflow_thread_id: string | null;
}

interface ParsedMessage {
  message: JsonObject;
  operation: A2aOperation;
  data: JsonObject;
}

export interface CodingRuntimeAdapter {
  start(input: JsonObject, context: {
    taskId: string;
    contextId: string;
    workflowId: string;
    preferredThreadId?: string;
    retry?: { sourceThreadId: string; sourceTaskId?: string; feedback: string };
    executionGrant: PackExecutionGrant;
  }): Promise<{ threadId: string }>;
  getState(threadId: string): Promise<JsonObject>;
  cancel(threadId: string): Promise<void>;
}

export class A2aProtocolError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message);
    this.name = 'A2aProtocolError';
  }
}

export function buildArgusDevAgentCard(publicUrl: string, secured: boolean): JsonObject {
  const url = new URL(publicUrl);
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('ARGUS_A2A_PUBLIC_URL must not contain a path');
  const card: JsonObject = {
    name: 'Argus Dev Coding Orchestrator',
    description: 'Governed coding workflow preflight and orchestration backed by LangGraph.',
    supportedInterfaces: [{
      url: url.origin,
      protocolBinding: 'HTTP+JSON',
      protocolVersion: A2A_VERSION,
    }],
    version: '0.4.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [
      {
        id: 'coding-preflight',
        name: 'Governed coding workflow preflight',
        description: 'Checks required Argus agents, durable storage, workflow identity and approval boundaries before a coding run.',
        tags: ['development', 'langgraph', 'governance', 'preflight'],
        examples: ['Check whether the ticket-to-pull-request workflow is ready.'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
      },
      ...workflowCatalog().map(workflow => ({
        id: workflow.id,
        name: workflow.label,
        description: workflow.description,
        tags: ['development', 'langgraph', 'human-in-the-loop', ...workflow.tags],
        examples: [`Start the governed ${workflow.label} workflow.`],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        'x-argus-workflow': workflow,
      })),
    ],
  };
  if (secured) {
    card['securitySchemes'] = {
      argusPackBearer: {
        httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'opaque' },
      },
    };
    card['securityRequirements'] = [{ schemes: { argusPackBearer: { list: [] } } }];
  }
  return card;
}

export function a2aErrorBody(status: number, reason: string, message: string, taskId?: string): JsonObject {
  return {
    error: {
      code: status,
      status: status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHENTICATED' : 'INVALID_ARGUMENT',
      message,
      details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason,
        domain: 'a2a-protocol.org',
        metadata: {
          ...(taskId ? { taskId } : {}),
          timestamp: new Date().toISOString(),
        },
      }],
    },
  };
}

export async function setupA2aTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS argus_a2a_tasks (
      task_id UUID PRIMARY KEY,
      context_id UUID NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL DEFAULT 'coding.preflight',
      workflow_thread_id UUID,
      state TEXT NOT NULL,
      task JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE argus_a2a_tasks ADD COLUMN IF NOT EXISTS operation TEXT NOT NULL DEFAULT 'coding.preflight';
    ALTER TABLE argus_a2a_tasks ADD COLUMN IF NOT EXISTS workflow_thread_id UUID;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_argus_a2a_tasks_workflow_thread
      ON argus_a2a_tasks (workflow_thread_id) WHERE workflow_thread_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_argus_a2a_tasks_context_updated
      ON argus_a2a_tasks (context_id, updated_at DESC);
  `);
}

function object(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new A2aProtocolError(400, 'INVALID_REQUEST', message);
  return value as JsonObject;
}

function parseMessage(body: JsonObject): ParsedMessage {
  const message = object(body['message'], 'message object is required');
  if (message['role'] !== 'ROLE_USER') throw new A2aProtocolError(400, 'INVALID_REQUEST', 'message role must be ROLE_USER');
  if (typeof message['messageId'] !== 'string' || !ID_PATTERN.test(message['messageId'])) {
    throw new A2aProtocolError(400, 'INVALID_REQUEST', 'messageId must be a stable 1-128 character identifier');
  }
  if (message['taskId'] !== undefined) {
    throw new A2aProtocolError(400, 'UNSUPPORTED_OPERATION', 'task follow-up messages are not enabled; approvals must pass through Argus Core');
  }
  const parts = message['parts'];
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 64) {
    throw new A2aProtocolError(400, 'INVALID_REQUEST', 'message parts must contain 1-64 entries');
  }
  let operation = 'coding.preflight';
  let data: JsonObject = {};
  for (const rawPart of parts) {
    const part = object(rawPart, 'each message part must be an object');
    if (typeof part['text'] === 'string' && part['text'].length > 100_000) {
      throw new A2aProtocolError(400, 'INVALID_REQUEST', 'text part exceeds 100000 characters');
    }
    if (part['data'] !== undefined) {
      data = object(part['data'], 'data part must contain an object');
      if (data['operation'] !== undefined) operation = String(data['operation']);
    }
    if (typeof part['text'] !== 'string' && part['data'] === undefined) {
      throw new A2aProtocolError(400, 'CONTENT_TYPE_NOT_SUPPORTED', 'only text and structured data parts are supported');
    }
  }
  if (!['workflow.preflight', 'workflow.start', 'coding.preflight', 'coding.start'].includes(operation)) {
    throw new A2aProtocolError(400, 'UNSUPPORTED_OPERATION', `unsupported Argus Dev operation '${operation}'`);
  }
  const contextId = message['contextId'];
  if (contextId !== undefined && (typeof contextId !== 'string' || !UUID_PATTERN.test(contextId))) {
    throw new A2aProtocolError(400, 'INVALID_REQUEST', 'contextId must be a UUID');
  }
  return { message, operation, data } as ParsedMessage;
}

function workflowRequest(parsed: ParsedMessage): { workflow: WorkflowCatalogEntry; input: JsonObject } {
  const workflowId = parsed.operation === 'coding.start'
    ? DEFAULT_WORKFLOW_ID
    : typeof parsed.data['workflowId'] === 'string'
      ? parsed.data['workflowId']
      : '';
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new A2aProtocolError(400, 'INVALID_REQUEST', `unknown Argus Dev workflow '${workflowId}'`);
  try {
    return {
      workflow,
      input: validateWorkflowInput(workflow, object(parsed.data['input'], 'workflow.start requires a structured input object')),
    };
  } catch (cause) {
    throw new A2aProtocolError(400, 'INVALID_REQUEST', cause instanceof Error ? cause.message : 'invalid workflow input');
  }
}

function safeTrace(message: JsonObject, traceparent: string, rootTraceHeader: string): JsonObject {
  const parentMatch = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(traceparent);
  const metadata = message['metadata'];
  const messageRoot = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as JsonObject)['argusRootTraceId']
    : undefined;
  const rootTraceId = UUID_PATTERN.test(rootTraceHeader) && messageRoot === rootTraceHeader
    ? rootTraceHeader
    : undefined;
  return {
    ...(rootTraceId ? { argusRootTraceId: rootTraceId } : {}),
    ...(parentMatch && TRACE_ID_PATTERN.test(parentMatch[1]!) ? { traceparent } : {}),
    argusPackId: 'argus.dev',
    argusAgentId: 'coding-orchestrator',
  };
}

async function existingTask(pool: Pool | PoolClient, messageId: string): Promise<StoredTaskRow | null> {
  const result = await pool.query<StoredTaskRow>(
    'SELECT task, operation, workflow_thread_id FROM argus_a2a_tasks WHERE message_id = $1',
    [messageId],
  );
  return result.rows[0] ?? null;
}

async function storeTask(
  pool: Pool | PoolClient,
  taskId: string,
  state: string,
  task: JsonObject,
  workflowThreadId?: string,
): Promise<void> {
  await pool.query(
    `UPDATE argus_a2a_tasks
        SET state = $2, task = $3::jsonb,
            workflow_thread_id = COALESCE($4::uuid, workflow_thread_id), updated_at = NOW()
      WHERE task_id = $1`,
    [taskId, state, JSON.stringify(task), workflowThreadId ?? null],
  );
}

function agentMessage(text: string): JsonObject {
  return { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }] };
}

function currentWorkflowStage(state: JsonObject, workflow: WorkflowCatalogEntry): string {
  const next = state['next'];
  if (Array.isArray(next) && typeof next[0] === 'string') return next[0];
  const interrupts = state['interrupts'];
  if (Array.isArray(interrupts)) {
    for (const interrupt of interrupts) {
      if (!interrupt || typeof interrupt !== 'object' || Array.isArray(interrupt)) continue;
      const value = (interrupt as JsonObject)['value'];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if ((value as JsonObject)['stage'] === 'pr_approval') return 'human_approval_pr';
      if ((value as JsonObject)['stage'] === 'external_ci') return 'external_ci';
      if (typeof (value as JsonObject)['stage'] === 'string'
        && workflow.stages.some(stage => stage.id === (value as JsonObject)['stage'])) {
        return String((value as JsonObject)['stage']);
      }
      return 'human_approval';
    }
  }
  if (state['status'] === 'completed') return 'completed';
  const values = state['values'];
  if (values && typeof values === 'object' && !Array.isArray(values)
    && (values as JsonObject)['delivery_status'] === 'awaiting_ci') return 'external_ci';
  if (values && typeof values === 'object' && !Array.isArray(values)
    && (values as JsonObject)['delivery_status'] === 'ci_running') return 'external_ci';
  return workflow.stages[0]?.id ?? 'starting';
}

function workflowEvidence(state: JsonObject, workflow: WorkflowCatalogEntry): JsonObject {
  const values = state['values'] && typeof state['values'] === 'object' && !Array.isArray(state['values'])
    ? state['values'] as JsonObject
    : {};
  const fileDiffs = Array.isArray(values['file_diffs']) ? values['file_diffs'] : [];
  const annotations = Array.isArray(values['review_annotations']) ? values['review_annotations'] : [];
  const revisionHistory = Array.isArray(values['revision_history']) ? values['revision_history'] : [];
  return {
    workflowId: workflow.id,
    workflowLabel: workflow.label,
    runTitle: typeof values[workflow.titleField] === 'string' || typeof values[workflow.titleField] === 'number'
      ? `${workflow.titlePrefix ?? ''}${String(values[workflow.titleField])}`
      : workflow.label,
    ticketId: typeof values['ticket_id'] === 'string' ? values['ticket_id'] : null,
    repository: typeof values['repository'] === 'string' ? values['repository'] : '',
    pullRequestNumber: Number(values['pull_request_number'] ?? 0) || null,
    branchName: typeof values['branch_name'] === 'string' ? values['branch_name'] : '',
    commitSha: typeof values['commit_sha'] === 'string' ? values['commit_sha'] : '',
    ciFailureContext: typeof values['ci_failure_context'] === 'string' ? values['ci_failure_context'].slice(0, 20_000) : '',
    ciRecoveryCompleted: values['ci_recovery_completed'] === true,
    releaseId: typeof values['release_id'] === 'string' ? values['release_id'] : '',
    releaseVersion: typeof values['release_version'] === 'string' ? values['release_version'] : '',
    releaseScope: typeof values['release_scope'] === 'string' ? values['release_scope'].slice(0, 20_000) : '',
    releaseGoal: typeof values['release_goal'] === 'string' ? values['release_goal'].slice(0, 20_000) : '',
    releaseNotes: typeof values['release_notes'] === 'string' ? values['release_notes'].slice(0, 20_000) : '',
    releaseCompleted: values['release_completed'] === true,
    backlogId: typeof values['backlog_id'] === 'string' ? values['backlog_id'] : '',
    issueTitle: typeof values['issue_title'] === 'string' ? values['issue_title'] : '',
    issueBody: typeof values['issue_body'] === 'string' ? values['issue_body'].slice(0, 20_000) : '',
    backlogTasks: typeof values['backlog_tasks'] === 'string' ? values['backlog_tasks'].slice(0, 60_000) : '',
    backlogConstraints: typeof values['backlog_constraints'] === 'string' ? values['backlog_constraints'].slice(0, 20_000) : '',
    backlogCompleted: values['backlog_completed'] === true,
    currentStage: currentWorkflowStage(state, workflow),
    plan: typeof values['plan'] === 'string' ? values['plan'].slice(0, 20_000) : '',
    qaTestPlan: typeof values['qa_test_plan'] === 'string' ? values['qa_test_plan'].slice(0, 30_000) : '',
    technicalExperiment: experimentEvidence(values as ExperimentState),
    qaAcceptance: qaEvidence(values as QaState),
    workflowBlockers: Array.isArray(values['workflow_blockers']) ? values['workflow_blockers'] : [],
    planningThreadId: typeof values['planning_thread_id'] === 'string' ? values['planning_thread_id'] : '',
    allowedFiles: typeof values['allowed_files'] === 'string' ? values['allowed_files'] : '',
    sourceIssue: values['issue_snapshot'] ?? null,
    testsPassed: values['tests_passed'] === true,
    verificationMode: values['delivery_mode'] === 'ticket-to-image-pull-request' ? 'review-only-image' : 'automated-tests',
    testOutput: typeof values['test_output'] === 'string' ? values['test_output'].slice(0, 20_000) : '',
    testProfiles: Array.isArray(values['test_profiles']) ? values['test_profiles'].slice(0, 8) : [],
    reviewPassed: values['review_passed'] === true,
    review: typeof values['review'] === 'string' ? values['review'].slice(0, 20_000) : '',
    fixOutput: typeof values['fix_output'] === 'string' ? values['fix_output'].slice(0, 20_000) : '',
    fixApplied: values['fix_applied'] === true,
    retryCount: Number(values['retry_count'] ?? 0) || 0,
    humanChangeRequest: typeof values['human_change_request'] === 'string'
      ? values['human_change_request'].slice(0, 20_000)
      : '',
    humanApproved: values['human_approved'] === true,
    branchPushed: values['branch_pushed'] === true,
    buildUrl: typeof values['build_url'] === 'string' ? values['build_url'] : '',
    deliveryStatus: typeof values['delivery_status'] === 'string' ? values['delivery_status'] : 'not_started',
    ciRun: values['ci_run'] && typeof values['ci_run'] === 'object' && !Array.isArray(values['ci_run'])
      ? values['ci_run']
      : null,
    prApproved: values['pr_approved'] === true,
    prUrl: typeof values['pr_url'] === 'string' ? values['pr_url'] : '',
    deliverySummary: typeof values['delivery_summary'] === 'string' ? values['delivery_summary'].slice(0, 20_000) : '',
    fileDiffs: fileDiffs.slice(0, 100),
    reviewAnnotations: annotations.slice(0, 100),
    revisionHistory: revisionHistory.slice(-20),
    visualCompleted: values['visual_completed'] === true,
    stepResults: values['step_results'] && typeof values['step_results'] === 'object'
      && !Array.isArray(values['step_results']) ? values['step_results'] : {},
    agentOutputs: Array.isArray(values['agent_outputs']) ? values['agent_outputs'].slice(-100) : [],
  };
}

export function projectWorkflowTask(task: JsonObject, state: JsonObject, workflowId?: string): { task: JsonObject; state: string } {
  const runtimeStatus = String(state['status'] ?? 'running');
  const timestamp = new Date().toISOString();
  const metadata = object(task['metadata'], 'stored task metadata is invalid');
  const resolvedWorkflowId = workflowId
    ?? (typeof metadata['workflowId'] === 'string' ? metadata['workflowId'] : DEFAULT_WORKFLOW_ID);
  const workflow = getWorkflow(resolvedWorkflowId) ?? getWorkflow(DEFAULT_WORKFLOW_ID)!;
  const values = state['values'] && typeof state['values'] === 'object' && !Array.isArray(state['values'])
    ? state['values'] as JsonObject
    : {};
  const completion = evaluateWorkflowCompletion(workflow, values);
  let a2aState = 'TASK_STATE_WORKING';
  let statusMessage: JsonObject | undefined;
  const externalCiWaiting = runtimeStatus === 'interrupted'
    && ((Array.isArray(state['next']) && state['next'].includes('external_ci'))
      || (Array.isArray(state['interrupts'])
        && (state['interrupts'] as unknown[]).some(item => item && typeof item === 'object'
          && !Array.isArray(item)
          && ((item as JsonObject)['value'] as JsonObject | undefined)?.['stage'] === 'external_ci')));
  if (runtimeStatus === 'canceling') {
    statusMessage = agentMessage('Cancellation requested. Stopping this workflow’s active runtime; non-interruptible operations must settle before cancellation is confirmed.');
  } else if (externalCiWaiting) {
    a2aState = 'TASK_STATE_WORKING';
    statusMessage = agentMessage('Waiting for external CI/CD evidence. Argus will resume the workflow from the authenticated provider webhook.');
  } else if (runtimeStatus === 'interrupted') {
    a2aState = 'TASK_STATE_INPUT_REQUIRED';
    statusMessage = agentMessage(currentWorkflowStage(state, workflow) === 'requirements_input'
      ? 'Requirements or environment clarification is needed. No code retry or approval has been issued.'
      : 'Human approval is required in Argus Core before this coding task can continue.');
  } else if (runtimeStatus === 'waiting_external_ci') {
    a2aState = 'TASK_STATE_WORKING';
    statusMessage = agentMessage('Waiting for external CI/CD evidence. Argus will update this task from the authenticated provider webhook.');
  } else if (runtimeStatus === 'completed') {
    if (completion.successful) {
      a2aState = 'TASK_STATE_COMPLETED';
    } else {
      a2aState = 'TASK_STATE_FAILED';
      statusMessage = agentMessage(
        `The Argus Dev workflow ended without satisfying its completion criteria: ${completion.missing.join(', ')}.`,
      );
    }
  } else if (runtimeStatus === 'failed') {
    a2aState = 'TASK_STATE_FAILED';
    statusMessage = agentMessage('The Argus Dev coding workflow failed. Inspect the governed run evidence in Argus Core.');
  } else if (runtimeStatus === 'canceled' || runtimeStatus === 'cancelled') {
    a2aState = 'TASK_STATE_CANCELED';
  }
  const evidence = workflowEvidence(state, workflow);
  const projected = {
    ...task,
    status: { state: a2aState, timestamp, ...(statusMessage ? { message: statusMessage } : {}) },
    artifacts: [{
      artifactId: String(metadata['resultArtifactId']),
      name: `Argus Dev ${workflow.label} evidence`,
      parts: [{ data: evidence }],
    }],
    metadata: {
      ...metadata,
      runtimeStatus,
      completionCriteriaSatisfied: completion.successful,
      completionCriteriaMissing: completion.missing,
    },
  };
  return { task: projected, state: a2aState };
}

export async function syncA2aTaskForThread(
  pool: Pool,
  workflowThreadId: string,
  runtimeState: JsonObject,
): Promise<void> {
  const result = await pool.query<StoredTaskRow & { task_id: string }>(
    `SELECT task_id, task, operation, workflow_thread_id
       FROM argus_a2a_tasks
      WHERE workflow_thread_id = $1
      ORDER BY updated_at DESC`,
    [workflowThreadId],
  );
  for (const row of result.rows) {
    if (!['coding.start', 'workflow.start'].includes(row.operation)) continue;
    const metadata = object(row.task['metadata'], 'stored task metadata is invalid');
    const workflowId = typeof metadata['workflowId'] === 'string' ? metadata['workflowId'] : DEFAULT_WORKFLOW_ID;
    const projected = projectWorkflowTask(row.task, runtimeState, workflowId);
    await storeTask(pool, row.task_id, projected.state, projected.task, workflowThreadId);
  }
}

export function projectCodingWorkflowTask(task: JsonObject, state: JsonObject): { task: JsonObject; state: string } {
  return projectWorkflowTask(task, state, DEFAULT_WORKFLOW_ID);
}

async function runPreflight(pool: Pool): Promise<JsonObject> {
  const workflows = workflowCatalog();
  const requiredAgentNames = [...new Set(workflows.flatMap(workflow => workflow.requiredAgents))];
  const resolvedAgents = await Promise.all(requiredAgentNames.map(async name => ({
    name,
    id: await resolveAgentId(name),
  })));
  await pool.query('SELECT 1');
  return {
    ready: true,
    packId: 'argus.dev',
    agentId: 'coding-orchestrator',
    workflowId: DEFAULT_WORKFLOW_ID,
    graphId: getWorkflow(DEFAULT_WORKFLOW_ID)!.graphId,
    workflows,
    engine: 'langgraph',
    requiredAgents: resolvedAgents,
    toolTransport: 'MCP',
    approvalGates: [...new Set(workflows.flatMap(workflow => workflow.approvalGates))],
    persistence: 'postgres',
  };
}

export async function sendA2aMessage(
  pool: Pool,
  rawBody: JsonObject,
  traceparent: string,
  rootTraceHeader: string,
  runtime: CodingRuntimeAdapter,
  rawExecutionGrant = '',
): Promise<JsonObject> {
  const parsed = parseMessage(rawBody);
  const messageId = String(parsed.message['messageId']);
  const duplicate = await existingTask(pool, messageId);
  if (duplicate) return { task: duplicate.task };

  const taskId = randomUUID();
  const contextId = typeof parsed.message['contextId'] === 'string' ? parsed.message['contextId'] : randomUUID();
  const timestamp = new Date().toISOString();
  const trace = safeTrace(parsed.message, traceparent, rootTraceHeader);
  const preflightOperation = parsed.operation === 'coding.preflight' || parsed.operation === 'workflow.preflight';
  const initialState = preflightOperation ? 'TASK_STATE_SUBMITTED' : 'TASK_STATE_WORKING';
  let task: JsonObject = {
    id: taskId,
    contextId,
    status: { state: initialState, timestamp },
    history: [parsed.message],
    metadata: { ...trace, operation: parsed.operation, resultArtifactId: randomUUID() },
  };
  const inserted = await pool.query<StoredTaskRow>(
    `INSERT INTO argus_a2a_tasks (task_id, context_id, message_id, operation, state, task)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING task, operation, workflow_thread_id`,
    [taskId, contextId, messageId, parsed.operation, initialState, JSON.stringify(task)],
  );
  if (!inserted.rows[0]) return { task: (await existingTask(pool, messageId))!.task };

  try {
    if (preflightOperation) {
      const evidence = await runPreflight(pool);
      task = {
        ...task,
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
        artifacts: [{
          artifactId: String(object(task['metadata'], 'stored task metadata is invalid')['resultArtifactId']),
          name: 'Argus Dev coding preflight',
          description: 'Provider-neutral readiness evidence for the external coding orchestrator.',
          parts: [{ data: evidence }],
        }],
      };
      await storeTask(pool, taskId, 'TASK_STATE_COMPLETED', task);
      return { task };
    }

    const request = workflowRequest(parsed);
    const input = request.input;
    const preferredThreadId = typeof trace['argusRootTraceId'] === 'string' ? trace['argusRootTraceId'] : undefined;
    if (!preferredThreadId || !rawExecutionGrant) {
      throw new A2aProtocolError(401, 'UNAUTHENTICATED', 'workflow.start requires a trace-bound Core execution grant');
    }
    let executionGrant: PackExecutionGrant;
    try {
      executionGrant = decodePackExecutionGrant(rawExecutionGrant, {
        packId: 'argus.dev',
        agentId: 'coding-orchestrator',
        messageId,
        rootTraceId: preferredThreadId,
      });
    } catch (cause) {
      throw new A2aProtocolError(401, 'UNAUTHENTICATED', cause instanceof Error ? cause.message : 'invalid execution grant');
    }
    const retryRaw = parsed.data['retry'];
    let retry: { sourceThreadId: string; sourceTaskId?: string; feedback: string } | undefined;
    if (retryRaw !== undefined) {
      const value = object(retryRaw, 'retry must be an object');
      if (typeof value['sourceThreadId'] !== 'string' || !UUID_PATTERN.test(value['sourceThreadId'])
        || (value['sourceTaskId'] !== undefined && (typeof value['sourceTaskId'] !== 'string' || !UUID_PATTERN.test(value['sourceTaskId'])))
        || typeof value['feedback'] !== 'string' || value['feedback'].length > 12_000
        || Object.keys(value).some(key => !['sourceThreadId', 'sourceTaskId', 'feedback'].includes(key))) {
        throw new A2aProtocolError(400, 'INVALID_REQUEST', 'invalid retry context');
      }
      retry = { sourceThreadId: value['sourceThreadId'], feedback: value['feedback'].trim(),
        ...(typeof value['sourceTaskId'] === 'string' ? { sourceTaskId: value['sourceTaskId'] } : {}) };
    }
    const started = await runtime.start(input, {
      taskId,
      contextId,
      workflowId: request.workflow.id,
      preferredThreadId,
      executionGrant,
      retry,
    });
    task = {
      ...task,
      metadata: {
        ...object(task['metadata'], 'stored task metadata is invalid'),
        workflowThreadId: started.threadId,
        workflowId: request.workflow.id,
        workflowLabel: request.workflow.label,
        graphId: request.workflow.graphId,
        approvalAuthority: 'argus.core',
        ...(retry ? { retryOf: retry.sourceThreadId } : {}),
        executionGrantId: executionGrant.claims.jti,
        executionPrincipal: `${executionGrant.claims.principalKind}:${executionGrant.claims.principalId}`,
        executionBundleIds: executionGrant.claims.bundleIds,
        executionRuntimeOverrides: executionGrant.claims.runtimeProfileOverrides ?? [],
        executionGrantExpiresAt: new Date(executionGrant.claims.exp * 1000).toISOString(),
      },
    };
    await storeTask(pool, taskId, 'TASK_STATE_WORKING', task, started.threadId);
    return { task };
  } catch (cause) {
    task = {
      ...task,
      status: {
        state: 'TASK_STATE_FAILED',
        timestamp: new Date().toISOString(),
        message: agentMessage(preflightOperation
          ? 'Argus Dev coding preflight failed because a required runtime dependency is unavailable.'
          : 'Argus Dev could not start the governed coding workflow.'),
      },
      metadata: { ...object(task['metadata'], 'stored task metadata is invalid'), failureClass: cause instanceof Error ? cause.name : 'Error' },
    };
    await storeTask(pool, taskId, 'TASK_STATE_FAILED', task);
    return { task };
  }
}

export async function getA2aTask(pool: Pool, taskId: string, runtime: CodingRuntimeAdapter): Promise<JsonObject> {
  if (!UUID_PATTERN.test(taskId)) throw new A2aProtocolError(404, 'TASK_NOT_FOUND', 'task not found');
  const result = await pool.query<StoredTaskRow>(
    'SELECT task, operation, workflow_thread_id FROM argus_a2a_tasks WHERE task_id = $1',
    [taskId],
  );
  const row = result.rows[0];
  if (!row) throw new A2aProtocolError(404, 'TASK_NOT_FOUND', 'task not found');
  if (!['coding.start', 'workflow.start'].includes(row.operation) || !row.workflow_thread_id
    || TERMINAL_STATES.has(String(object(row.task['status'], 'stored task status is invalid')['state']))) {
    return row.task;
  }
  const metadata = object(row.task['metadata'], 'stored task metadata is invalid');
  const workflowId = typeof metadata['workflowId'] === 'string' ? metadata['workflowId'] : DEFAULT_WORKFLOW_ID;
  const projected = projectWorkflowTask(row.task, await runtime.getState(row.workflow_thread_id), workflowId);
  await storeTask(pool, taskId, projected.state, projected.task, row.workflow_thread_id);
  return projected.task;
}

export async function cancelA2aTask(pool: Pool, taskId: string, runtime: CodingRuntimeAdapter): Promise<JsonObject> {
  if (!UUID_PATTERN.test(taskId)) throw new A2aProtocolError(404, 'TASK_NOT_FOUND', 'task not found');
  const current = await getA2aTask(pool, taskId, runtime);
  const status = object(current['status'], 'stored task status is invalid');
  const state = String(status['state'] ?? '');
  if (state === 'TASK_STATE_CANCELED') return current;
  if (TERMINAL_STATES.has(state)) {
    throw new A2aProtocolError(400, 'TASK_NOT_CANCELABLE', `task in state ${state} is not cancelable`);
  }
  const metadata = object(current['metadata'], 'stored task metadata is invalid');
  const workflowThreadId = typeof metadata['workflowThreadId'] === 'string' ? metadata['workflowThreadId'] : null;
  if (workflowThreadId) {
    await runtime.cancel(workflowThreadId);
    const projected = projectWorkflowTask(current, await runtime.getState(workflowThreadId), typeof metadata['workflowId'] === 'string' ? metadata['workflowId'] : undefined);
    await storeTask(pool, taskId, projected.state, projected.task, workflowThreadId);
    return projected.task;
  }
  const canceled = {
    ...current,
    status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() },
    metadata: { ...metadata, runtimeStatus: workflowThreadId ? 'canceled' : metadata['runtimeStatus'] },
  };
  await storeTask(pool, taskId, 'TASK_STATE_CANCELED', canceled, workflowThreadId ?? undefined);
  return canceled;
}
