/**
 * Argus-owned LangGraph runtime.
 *
 * This intentionally implements only the internal Agent-Server-compatible
 * endpoints used by src/api/coding.ts. The workflow engine remains the
 * MIT-licensed @langchain/langgraph package, while thread/run metadata and
 * checkpoints are kept in the Argus PostgreSQL database.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { Command, type StateSnapshot } from '@langchain/langgraph';
import { Pool, type PoolClient } from 'pg';
import { assertRetryParent, retryExecutionInput } from './workflowRetry.js';
import { validateDevelopmentResume } from './developmentContract.js';
import { decisionRequest, validateDecisionReply } from './developmentDecisions.js';
import { verifiedPlanningHandoff } from './planningHandoff.js';
import { importRepositoryIssue, issueContext } from './repositoryIssue.js';
import { followUpCheckpointFromSource } from './followUpContract.js';
import { CancellationUnconfirmedError, WorkflowCancellation, hasPendingResult, runCooperatively } from './workflowCancellation.js';
import { codingCheckpointer, resolveCiBaseCommit, fetchGitCreds, workspaceExec } from './workflows/coding.js';
import { checkpointRetryNode, isStackSnapshotRecovery, isPreQaGrantRecovery, assertPreQaGrantTraces, assertCheckpointGrant, assertStoppedWorker, stoppedWorkerReceipt, workspaceRetryDigest, CheckpointRetryError, CHECKPOINT_PREDECESSOR, type RetryState } from './checkpointRetry.js';
import { qaBasis } from './qaAcceptance.js';
import { assertCodegenCurrent } from './codeGeneration.js';
import { isCodegenImportRecovery, previewCodegenImport, recoverCodegenImport } from './codegenRecovery.js';
import { stackHash, stackRequestSchema } from './stackEnvironment.js';
import { recheckQaResponse, prepareQaRetry, assertQaWorkspaceIdle } from './qaResponseRecovery.js';
import { decodePackExecutionGrant } from './executionGrant.js';
import { validateGitApproval } from './gitApproval.js';
import { isGitBrokerCodingGraph } from './gitBrokerWorkflows.js';
import { approvalRecoveryStage } from './gitApprovalRecovery.js';
import { publicCheckpointData } from './checkpointProjection.js';
import { selectCheckoutTarget } from './repositoryCheckout.js';
import { buildCloneUrl } from './gitProvider.js';
import { changedPathsFromGitStatus } from './projectTestRunner.js';
import { ARGUS_DEV_PACK_MANIFEST } from './packManifest.js';
import {
  DEFAULT_GRAPH_ID,
  getWorkflow,
  getWorkflowByGraphId,
  listRegisteredWorkflows,
  registerVisualWorkflow,
  workflowRunTitle,
} from './workflowRegistry.js';
import {
  A2A_AGENT_CARD_PATH,
  A2A_CONTENT_TYPE,
  A2A_VERSION,
  A2aProtocolError,
  a2aErrorBody,
  buildArgusDevAgentCard,
  cancelA2aTask,
  getA2aTask,
  sendA2aMessage,
  setupA2aTables,
  syncA2aTaskForThread,
  type CodingRuntimeAdapter,
} from './a2a.js';
import { evaluateWorkflowCompletion } from './workflowCatalog.js';
import { deliveryStatusForCi, externalCiIsPending, mergeCiRun } from './ciLifecycle.js';
import type { CiRun } from './state.js';
import { dispatchJenkins, jenkinsCallbackMatches, jenkinsTarget, makeJenkinsIntent, readJenkinsConfig } from './jenkinsDispatch.js';
import { authorizeJenkinsBundle, DevCiAuthorizationError } from './devCi.js';
import {
  buildVisualWorkflowGraph,
  parseVisualWorkflowSpec,
  visualWorkflowCatalogEntry,
  type VisualWorkflowSpec,
} from './visualWorkflow.js';
import {
  CiCanaryConfigurationError,
  CiCanaryRateLimitError,
  runConfiguredCiProviderCanaries,
} from './ciProviderCanary.js';

const PORT = Number.parseInt(process.env['PORT'] ?? '2025', 10);
const PG_URL = process.env['POSTGRES_CONNECTION_URL']
  ?? 'postgresql://aiops:aiops123@localhost:5432/aiops';
const RUNTIME_SECRET = process.env['WORKSPACE_SECRET'] ?? '';
const ARGUS_URL = process.env['ARGUS_URL'] ?? 'http://localhost:3000';
const MAX_BODY_BYTES = 1024 * 1024;
const PACK_DISCOVERY_TOKEN_FILE = process.env['ARGUS_PACK_DISCOVERY_TOKEN_FILE'] ?? '';
const A2A_PUBLIC_URL = process.env['ARGUS_A2A_PUBLIC_URL'] ?? `http://localhost:${PORT}`;
const PACK_DISCOVERY_TOKEN = (() => {
  if (!PACK_DISCOVERY_TOKEN_FILE) return '';
  const raw = readFileSync(PACK_DISCOVERY_TOKEN_FILE, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 8 * 1024) throw new Error('pack discovery credential exceeds the 8 KiB limit');
  const token = raw.trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('pack discovery credential is empty or malformed');
  return token;
})();

const pool = new Pool({ connectionString: PG_URL, max: 10 });
// Long-lived advisory leases must not exhaust the query/transaction pool.
const workspaceLeasePool = new Pool({ connectionString: PG_URL, max: 16, connectionTimeoutMillis: 1_000 });
const activeRuns = new Map<string, Promise<void>>();
const cancellationControls = new Map<string, WorkflowCancellation>();
const jenkinsDispatchConfig = readJenkinsConfig();
let jenkinsDispatchTimer: ReturnType<typeof setInterval> | undefined;
let jenkinsSweep: Promise<void> | undefined;

type JsonObject = Record<string, unknown>;
type RunKind = 'input' | 'resume' | 'continue';

interface ThreadRow {
  thread_id: string;
  graph_id: string;
  metadata: JsonObject;
  status: string;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RunRow {
  run_id: string;
  thread_id: string;
  kind: RunKind;
  payload: JsonObject;
  base_checkpoint_id: string | null;
  status: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function log(level: 'info' | 'warn' | 'error', message: string, fields: JsonObject = {}): void {
  const entry = { level, time: new Date().toISOString(), service: 'argus-langgraph-runtime', message, ...fields };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function checkpointId(snapshot: StateSnapshot | null): string | null {
  const configurable = snapshot?.config?.configurable as Record<string, unknown> | undefined;
  const value = configurable?.['checkpoint_id'];
  return typeof value === 'string' && value ? value : null;
}

function hasInterrupt(snapshot: StateSnapshot | null): boolean {
  return snapshot?.tasks.some(task => task.interrupts.length > 0) === true;
}

function hasInterruptStage(snapshot: StateSnapshot | null, stage: string): boolean {
  return snapshot?.tasks.some(task => task.interrupts.some(interrupt => {
    const value = interrupt.value;
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>)['stage'] === stage);
  })) === true;
}

async function pendingGitApprovalStage(thread: ThreadRow, snapshot: StateSnapshot | null) {
  if (activeRuns.has(thread.thread_id)) return null;
  const previous = thread.status === 'failed'
    ? (await pool.query<RunRow>(`SELECT run_id, thread_id, kind, payload, base_checkpoint_id, status
        FROM argus_langgraph_runs WHERE thread_id=$1 ORDER BY created_at DESC, run_id DESC LIMIT 1`,
      [thread.thread_id])).rows[0]
    : null;
  const failedTasks = snapshot?.tasks.filter(task => task.interrupts.length > 0 && task.error) ?? [];
  return approvalRecoveryStage({
    graphId: thread.graph_id, status: thread.status, checkpointId: checkpointId(snapshot),
    next: snapshot?.next ?? [], interrupted: hasInterrupt(snapshot), values: snapshot?.values ?? {},
    failedTask: failedTasks.length === 1 ? { name: failedTasks[0]!.name,
      interrupted: true, error: true } : null,
    previousRun: previous ? { kind: previous.kind, status: previous.status,
      baseCheckpointId: previous.base_checkpoint_id, payload: previous.payload } : null,
  });
}

function safeTasks(snapshot: StateSnapshot | null): Array<JsonObject> {
  return (snapshot?.tasks ?? []).map(task => ({
    id: task.id,
    name: task.name,
    interrupts: publicCheckpointData(task.interrupts),
    ...(task.error === undefined ? {} : { error: String(task.error) }),
    ...(task.result === undefined ? {} : { result: task.result && typeof task.result === 'object' && !Array.isArray(task.result)
      ? publicCheckpointData(task.result) : task.result }),
  }));
}

function safeStateValues(snapshot: StateSnapshot | null): JsonObject {
  const values = snapshot?.values && typeof snapshot.values === 'object' && !Array.isArray(snapshot.values)
    ? publicCheckpointData(snapshot.values) as JsonObject
    : {};
  return values;
}

function serializeState(row: ThreadRow, snapshot: StateSnapshot | null): JsonObject {
  const tasks = safeTasks(snapshot);
  return {
    thread_id: row.thread_id,
    graph_id: row.graph_id,
    status: row.status,
    error: row.error,
    metadata: row.metadata,
    values: safeStateValues(snapshot),
    next: snapshot?.next ?? [],
    tasks,
    interrupts: tasks.flatMap(task => Array.isArray(task['interrupts']) ? task['interrupts'] as unknown[] : []),
    checkpoint_metadata: publicCheckpointData(snapshot?.metadata ?? null),
    checkpoint_id: checkpointId(snapshot),
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function writeA2aJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': `${A2A_CONTENT_TYPE}; charset=utf-8`,
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'a2a-version': A2A_VERSION,
  });
  res.end(data);
}

function assertA2aRequest(req: IncomingMessage, requiresBody = false): void {
  const requestedVersion = String(req.headers['a2a-version'] ?? '');
  if (requestedVersion !== A2A_VERSION) {
    throw new A2aProtocolError(400, 'VERSION_NOT_SUPPORTED', `A2A-Version ${requestedVersion || '(missing)'} is not supported`);
  }
  if (requiresBody && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith(A2A_CONTENT_TYPE)) {
    throw new A2aProtocolError(415, 'CONTENT_TYPE_NOT_SUPPORTED', `Content-Type must be ${A2A_CONTENT_TYPE}`);
  }
  if (!packDiscoveryAuthorized(String(req.headers['authorization'] ?? ''))) {
    throw new A2aProtocolError(401, 'UNAUTHENTICATED', 'invalid A2A service credential');
  }
}

function secretMatches(value: string): boolean {
  if (!RUNTIME_SECRET) return process.env['NODE_ENV'] !== 'production';
  const expected = Buffer.from(RUNTIME_SECRET);
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function packDiscoveryAuthorized(value: string): boolean {
  if (!PACK_DISCOVERY_TOKEN) return true;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match) return false;
  const expected = Buffer.from(PACK_DISCOVERY_TOKEN);
  const actual = Buffer.from(match[1]!);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type TelemetryLifecycleEvent = 'started' | 'waiting' | 'completed' | 'failed' | 'cancelled';

/**
 * Mirror durable runtime lifecycle into Argus-owned native telemetry. This is
 * intentionally best-effort: a control-plane restart or telemetry outage must
 * never make an otherwise durable LangGraph run fail.
 */
async function notifyArgusTelemetry(
  thread: ThreadRow,
  event: TelemetryLifecycleEvent,
  input?: unknown,
  error?: string,
): Promise<void> {
  if (!RUNTIME_SECRET) return;
  try {
    const response = await fetch(`${ARGUS_URL}/api/internal/telemetry/langgraph`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-workspace-secret': RUNTIME_SECRET,
      },
      body: JSON.stringify({
        threadId: thread.thread_id,
        workflowType: thread.graph_id,
        event,
        input,
        metadata: thread.metadata,
        error,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      log('warn', 'Argus telemetry lifecycle rejected', {
        thread_id: thread.thread_id,
        event,
        status: response.status,
      });
    }
  } catch (cause) {
    log('warn', 'Argus telemetry lifecycle unavailable', {
      thread_id: thread.thread_id,
      event,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function readJson(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'JSON object required');
    }
    return parsed as JsonObject;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid JSON body');
  }
}

async function setupRuntimeTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS argus_langgraph_threads (
      thread_id UUID PRIMARY KEY,
      graph_id TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'idle',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_argus_langgraph_threads_updated
      ON argus_langgraph_threads (updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_argus_langgraph_threads_metadata
      ON argus_langgraph_threads USING GIN (metadata);

    CREATE TABLE IF NOT EXISTS argus_langgraph_runs (
      run_id UUID PRIMARY KEY,
      thread_id UUID NOT NULL REFERENCES argus_langgraph_threads(thread_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      base_checkpoint_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_argus_langgraph_runs_recovery
      ON argus_langgraph_runs (status, created_at);
  `);
}

async function setupVisualWorkflowTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS argus_visual_workflows (
      workflow_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL UNIQUE,
      source_workflow_id BIGINT NOT NULL,
      revision BIGINT NOT NULL,
      spec JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_argus_visual_workflows_source
      ON argus_visual_workflows (source_workflow_id, updated_at DESC);
  `);
}

function activateVisualWorkflow(spec: VisualWorkflowSpec): void {
  registerVisualWorkflow(visualWorkflowCatalogEntry(spec), buildVisualWorkflowGraph(spec));
}

async function loadVisualWorkflows(): Promise<void> {
  const result = await pool.query<{ spec: unknown }>(
    'SELECT spec FROM argus_visual_workflows ORDER BY updated_at',
  );
  for (const row of result.rows) {
    try {
      activateVisualWorkflow(parseVisualWorkflowSpec(row.spec));
    } catch (cause) {
      log('error', 'persisted visual workflow is invalid', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

async function publishVisualWorkflow(raw: unknown): Promise<VisualWorkflowSpec> {
  let spec: VisualWorkflowSpec;
  try {
    spec = parseVisualWorkflowSpec(raw);
  } catch (cause) {
    throw new HttpError(400, cause instanceof Error ? cause.message : 'invalid Argus Workflow Spec');
  }
  await pool.query(
    `INSERT INTO argus_visual_workflows
       (workflow_id, graph_id, source_workflow_id, revision, spec)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (workflow_id) DO UPDATE SET
       graph_id = EXCLUDED.graph_id,
       source_workflow_id = EXCLUDED.source_workflow_id,
       revision = EXCLUDED.revision,
       spec = EXCLUDED.spec,
       updated_at = NOW()`,
    [spec.id, spec.graphId, spec.source.workflowId, spec.revision, JSON.stringify(spec)],
  );
  activateVisualWorkflow(spec);
  return spec;
}

async function getThread(threadId: string, client: Pool | PoolClient = pool): Promise<ThreadRow | null> {
  const result = await client.query<ThreadRow>(
    `SELECT thread_id, graph_id, metadata, status, error, created_at, updated_at
       FROM argus_langgraph_threads WHERE thread_id = $1`,
    [threadId],
  );
  return result.rows[0] ?? null;
}

async function createThread(graphId: string, metadata: JsonObject, preferredThreadId?: string): Promise<ThreadRow> {
  if (!getWorkflowByGraphId(graphId)) throw new HttpError(400, `unknown graph '${graphId}'`);
  const threadId = preferredThreadId ?? randomUUID();
  const result = await pool.query<ThreadRow>(
    `INSERT INTO argus_langgraph_threads (thread_id, graph_id, metadata)
     VALUES ($1, $2, $3::jsonb)
     RETURNING thread_id, graph_id, metadata, status, error, created_at, updated_at`,
    [threadId, graphId, JSON.stringify(metadata)],
  );
  return result.rows[0]!;
}

async function getSnapshot(threadId: string, knownThread?: ThreadRow): Promise<StateSnapshot | null> {
  try {
    const thread = knownThread ?? await getThread(threadId);
    if (!thread) throw new Error(`thread ${threadId} not found`);
    const workflow = getWorkflowByGraphId(thread.graph_id);
    if (!workflow) throw new Error(`graph ${thread.graph_id} is not registered`);
    return await workflow.graph.getState({ configurable: { thread_id: threadId } });
  } catch (error) {
    log('warn', 'checkpoint lookup failed', {
      thread_id: threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function markRunFinished(
  runId: string,
  threadId: string,
  runStatus: 'completed' | 'interrupted' | 'failed' | 'canceled',
  threadStatus: 'completed' | 'interrupted' | 'failed' | 'canceled',
  error: string | null = null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE argus_langgraph_runs
          SET status = $2, error = $3, finished_at = NOW()
        WHERE run_id = $1`,
      [runId, runStatus, error],
    );
    await client.query(
      `UPDATE argus_langgraph_threads
          SET status = $2, error = $3, updated_at = NOW()
        WHERE thread_id = $1`,
      [threadId, threadStatus, error],
    );
    await client.query('COMMIT');
  } catch (error_) {
    await client.query('ROLLBACK');
    throw error_;
  } finally {
    client.release();
  }
}

async function executeRun(runId: string): Promise<void> {
  // Serialize claiming with cancellation. A canceled queue entry must never
  // transition back to running between the run and thread updates.
  const lookup = await pool.query<{ thread_id: string }>('SELECT thread_id FROM argus_langgraph_runs WHERE run_id = $1', [runId]);
  if (!lookup.rows[0]) return;
  const run = await withCiThreadLock(lookup.rows[0].thread_id, async () => {
    const thread = await getThread(lookup.rows[0]!.thread_id);
    if (!thread || thread.status !== 'queued') return null;
    const claimed = await pool.query<RunRow>(
      `UPDATE argus_langgraph_runs
          SET status = 'running', started_at = COALESCE(started_at, NOW()), error = NULL
        WHERE run_id = $1 AND status = 'queued'
        RETURNING run_id, thread_id, kind, payload, base_checkpoint_id, status`,
      [runId],
    );
    const claimedRun = claimed.rows[0];
    if (!claimedRun) return null;

    await pool.query(
      `UPDATE argus_langgraph_threads
          SET status = 'running', error = NULL, updated_at = NOW()
        WHERE thread_id = $1`,
      [claimedRun.thread_id],
    );
    return claimedRun;
  });
  if (!run) return;

  const thread = await getThread(run.thread_id);
  if (!thread) throw new Error(`thread ${run.thread_id} disappeared after run claim`);
  const workflow = getWorkflowByGraphId(thread.graph_id);
  if (!workflow) throw new Error(`graph ${thread.graph_id} is not registered`);
  await notifyArgusTelemetry(
    thread,
    'started',
    run.kind === 'input' ? run.payload['input'] : undefined,
  );

  const control = new WorkflowCancellation();
  cancellationControls.set(run.thread_id, control);
  const wasCanceled = async () => (await getThread(run.thread_id))?.status === 'canceling';
  const finishCancellation = async () => {
    await markRunFinished(run.run_id, run.thread_id, 'canceled', 'canceled');
    await syncThreadA2aTask(run.thread_id);
    await notifyArgusTelemetry(thread, 'cancelled');
  };
  let workspaceLease: PoolClient | undefined;
  try {
    const initial = await getSnapshot(run.thread_id, thread);
    const root = String(initial?.values?.['argus_workspace_root'] || (run.payload['input'] as JsonObject | undefined)?.['argus_workspace_root'] || '');
    if (root) workspaceLease = await claimWorkspace(root);
    const retry = run.payload['checkpointRetry'] as JsonObject | undefined;
    if (retry) {
      const state = { ...serializeState(thread, initial), values: { ...(initial?.values ?? {}) },
        status: retry['originalStatus'] === 'interrupted' ? 'interrupted' : 'failed', error: retry['originalError'] == null ? null : String(retry['originalError']) } as unknown as RetryState;
      const grant = decodePackExecutionGrant(String(retry['grant']), {
        packId: 'argus.dev', agentId: 'coding-orchestrator', messageId: String(retry['messageId']), rootTraceId: run.thread_id,
      });
      const retryNode = checkpointRetryNode(state);
      assertCheckpointGrant(state, grant);
      if (checkpointId(initial) !== run.base_checkpoint_id) throw new CheckpointRetryError('Checkpoint changed before continuation.');
      const checked = await inspectCheckpointWorkspace(state, grant.token);
      if (checked.digest !== retry['workspaceDigest']) throw new CheckpointRetryError('Workspace changed after the retry preview. Reload the preview.');
      const recovered = checked.codegen ? await recoverCodegenImport(state, grant.token, checked.codegen) : undefined;
      await workflow.graph.updateState({ configurable: { thread_id: run.thread_id } }, {
        argus_execution_grant: grant.token, bitbucket_creds: checked.creds,
        ...(recovered ? { code_generation_receipt: recovered, code_generation_recovery_count: 1,
          workflow_blockers: [], development_findings: [],
          qa_history: [{ phase: 'code_generation_recovery', receipt: recovered, checkpointId: run.base_checkpoint_id, runId,
            recoveryDigest: checked.codegen!.proof['recoveryDigest'] }] } : {}),
        ...(isStackSnapshotRecovery(state) ? { stack_snapshot_recovery_count: 1, stack_snapshot_recovery_pending: true } : {}),
        log: [{ step: recovered ? 'code_generation_recovery' : 'checkpoint_retry', summary: recovered
          ? 'Operator recovered the verified, previously completed generator output; no generator/model replay. Planning, Knowledge, QA design and Coder retained; tests and approvals still required.'
          : `Operator continued ${retryNode} from checkpoint ${run.base_checkpoint_id}; prior successful steps retained.` }],
      }, recovered ? 'code_generation' : isStackSnapshotRecovery(state) ? 'stack_environment' : CHECKPOINT_PREDECESSOR[retryNode]);
      const updated = await getSnapshot(run.thread_id, thread);
      if (updated?.next.join(',') !== (recovered ? 'stack_environment' : state.next!.join(',')) || recovered && hasInterrupt(updated)) throw new CheckpointRetryError('Checkpoint continuation would change the entry node; stopped safely.');
      await pool.query(`UPDATE argus_langgraph_threads SET metadata = metadata || $2::jsonb WHERE thread_id=$1`,
        [run.thread_id, JSON.stringify({ execution_grant_id: grant.claims.jti, checkpoint_retry_run_id: runId })]);
    }
    const qaRetry = run.payload['qaRetry'] as JsonObject | undefined;
    if (qaRetry) {
      const state = { ...serializeState(thread, initial), values: { ...(initial?.values ?? {}) }, status: 'interrupted' } as unknown as RetryState;
      const retained = prepareQaRetry(state);
      if (checkpointId(initial) !== run.base_checkpoint_id || retained.reviewDigest !== qaRetry['reviewDigest']) {
        throw new CheckpointRetryError('QA checkpoint or retained evidence changed before retry.');
      }
      const grant = decodePackExecutionGrant(String(qaRetry['grant']), {
        packId: 'argus.dev', agentId: 'coding-orchestrator', messageId: String(qaRetry['messageId']), rootTraceId: run.thread_id,
      });
      assertCheckpointGrant(state, grant);
      const checked = await inspectCheckpointWorkspace(state, grant.token, 'retry');
      if (checked.digest !== qaRetry['workspaceDigest']) throw new CheckpointRetryError('Workspace changed after QA retry preview.');
      await workflow.graph.updateState({ configurable: { thread_id: run.thread_id } }, {
        technical_response_failure: null, workflow_blockers: [], development_findings: [], technical_open_findings: [],
        qa_response_receipt: retained.retryKind === 'missing_reviews' ? retained.receipt : null,
        ...(retained.retryKind === 'missing_reviews' ? { qa_review_repair_count: 1, qa_review_repair_pending: true } : {}),
        design_refinement_pending: false,
        argus_execution_grant: grant.token, bitbucket_creds: checked.creds,
        technical_design_history: [{ phase: 'qa_retry', retryKind: retained.retryKind, missingDecisionIds: retained.missingDecisionIds, sourceTraceId: retained.receipt.traceId,
          responseSha256: retained.receipt.responseSha256, basisSha256: retained.receipt.basisSha256,
          checkpointId: run.base_checkpoint_id, runId, previousFailure: state.values?.['technical_response_failure'] }],
        log: [{ step: 'qa_retry', summary: retained.retryKind === 'missing_reviews'
          ? 'One QA omission correction reserved before inference; existing reviews and tests frozen. No automatic retry or approval.'
          : 'Operator requested a fresh independent QA call; plan, Knowledge and design budgets retained. The rejected response remains in its source checkpoint.', traceId: retained.receipt.traceId }],
      }, 'knowledge');
      const updated = await getSnapshot(run.thread_id, thread);
      if (updated?.next.join(',') !== 'test_design' || hasInterrupt(updated)) throw new CheckpointRetryError('QA retry did not produce the expected test-design entry point; stopped safely.');
      await pool.query(`UPDATE argus_langgraph_threads SET metadata = metadata || $2::jsonb WHERE thread_id=$1`,
        [run.thread_id, JSON.stringify({ execution_grant_id: grant.claims.jti, qa_retry_run_id: runId })]);
    }
    const qaRecovery = run.payload['qaResponseRecovery'] as JsonObject | undefined;
    if (qaRecovery) {
      const state = { ...serializeState(thread, initial), values: { ...(initial?.values ?? {}) }, status: 'interrupted' } as unknown as RetryState;
      const checkedResponse = recheckQaResponse(state);
      if (checkpointId(initial) !== run.base_checkpoint_id || checkedResponse.reviewDigest !== qaRecovery['reviewDigest']) {
        throw new CheckpointRetryError('QA checkpoint or response changed before continuation.');
      }
      const grant = decodePackExecutionGrant(String(qaRecovery['grant']), {
        packId: 'argus.dev', agentId: 'coding-orchestrator', messageId: String(qaRecovery['messageId']), rootTraceId: run.thread_id,
      });
      assertCheckpointGrant(state, grant);
      const checked = await inspectCheckpointWorkspace(state, grant.token, 'recheck');
      if (checked.digest !== qaRecovery['workspaceDigest']) throw new CheckpointRetryError('Workspace changed after QA recheck.');
      await workflow.graph.updateState({ configurable: { thread_id: run.thread_id } }, {
        ...checkedResponse.update, design_refinement_pending: false, qa_response_receipt: null,
        argus_execution_grant: grant.token, bitbucket_creds: checked.creds,
        technical_design_history: [...checkedResponse.update.technical_design_history, { phase: 'response_recovery',
          sourceTraceId: checkedResponse.receipt.traceId, responseSha256: checkedResponse.receipt.responseSha256,
          basisSha256: checkedResponse.receipt.basisSha256, checkpointId: run.base_checkpoint_id, runId,
          previousFailure: state.values?.['technical_response_failure'] }],
        log: [{ step: 'qa_response_recovery', summary: 'Operator explicitly continued after rechecking the retained QA response; no planning, investigation or QA model call repeated.', traceId: checkedResponse.receipt.traceId }],
      }, 'test_design');
      const updated = await getSnapshot(run.thread_id, thread);
      if (updated?.next.join(',') !== 'coder' || hasInterrupt(updated)) throw new CheckpointRetryError('QA recovery did not produce the expected Coder entry point; stopped safely.');
      await pool.query(`UPDATE argus_langgraph_threads SET metadata = metadata || $2::jsonb WHERE thread_id=$1`,
        [run.thread_id, JSON.stringify({ execution_grant_id: grant.claims.jti, qa_response_recovery_run_id: runId })]);
    }
    let approvalGrant: string | undefined;
    if (run.kind === 'resume' && run.payload['gitApproval']) {
      const snapshot = await getSnapshot(run.thread_id, thread);
      if (checkpointId(snapshot) !== run.base_checkpoint_id) throw new Error('Approval checkpoint changed before dispatch.');
      const failedTasks = snapshot?.tasks.filter(task => task.interrupts.length > 0 && task.error) ?? [];
      const stage = snapshot?.next.length === 1 ? snapshot.next[0]!
        : failedTasks.length === 1 ? failedTasks[0]!.name : '';
      if (!hasInterrupt(snapshot) || !['human_approval','human_approval_pr'].includes(stage)) {
        throw new Error('The saved approval interrupt is no longer current.');
      }
      const refreshed = validateGitApproval(run.payload['gitApproval'], { threadId: run.thread_id,
        checkpointId: checkpointId(snapshot), stage,
        principal: thread.metadata['execution_principal'], bundleIds: thread.metadata['execution_bundle_ids'],
        workspaceRoot: snapshot?.values?.['argus_workspace_root'] });
      approvalGrant = refreshed.token;
      await pool.query(`UPDATE argus_langgraph_threads SET metadata=metadata || $2::jsonb WHERE thread_id=$1`,
        [run.thread_id, JSON.stringify({ execution_grant_id: refreshed.claims.jti })]);
    }
    const config = {
      configurable: { thread_id: run.thread_id, execution_run_id: run.run_id, ...(approvalGrant ? { approvalGrant } : {}) },
      durability: 'sync' as const,
      interruptAfter: '*' as const,
    };
    await runCooperatively({
      control, isCancellationRequested: wasCanceled,
      snapshot: async () => (await getSnapshot(run.thread_id, thread))!,
      invoke: async first => {
        if (!first) {
          await workflow.graph.invoke(null, config);
        } else if (run.kind === 'resume') {
          await workflow.graph.invoke(new Command({ resume: run.payload['resume'] }), config);
        } else if (run.kind === 'continue') {
          // Provider callbacks resume only the external_ci interrupt. A regular
          // checkpoint continuation still uses a null input.
          const current = await getSnapshot(run.thread_id, thread);
          if (hasInterruptStage(current, 'external_ci')) {
            await workflow.graph.invoke(new Command({ resume: { source: 'external_ci_webhook' } }), config);
          } else {
            await workflow.graph.invoke(null, config);
          }
        } else {
          await workflow.graph.invoke((run.payload['input'] ?? {}) as JsonObject, config);
        }
      },
    });

    await withCiThreadLock(run.thread_id, async () => {
      if (await wasCanceled()) return finishCancellation();
      const snapshot = await getSnapshot(run.thread_id, thread);
      await finishRunFromSnapshot(run.run_id, thread, snapshot);
    });
  } catch (error) {
    await withCiThreadLock(run.thread_id, async () => {
      if (error instanceof CancellationUnconfirmedError) {
        log('warn', 'runtime cancellation requires reconciliation; no workflow replay', { thread_id: run.thread_id });
        return;
      }
      if (await wasCanceled()) return finishCancellation();
      const message = error instanceof Error ? error.message : String(error);
      log('error', 'workflow run failed', { run_id: run.run_id, thread_id: run.thread_id, error: message });
      await markRunFinished(run.run_id, run.thread_id, 'failed', 'failed', message.slice(0, 4000));
      // Preserve terminal proof before the runtime's short in-memory retention
      // expires. An empty registry or a failed HTTP call alone is never proof.
      try {
        const failed = await checkpointState(run.thread_id);
        const receipt = stoppedWorkerReceipt(failed, await checkpointWorkerStatuses());
        if (receipt) await pool.query(`UPDATE argus_langgraph_threads SET metadata=metadata || $2::jsonb WHERE thread_id=$1`,
          [run.thread_id, JSON.stringify({ checkpoint_worker_receipt: receipt })]);
      } catch { log('warn', 'checkpoint worker termination proof unavailable', { thread_id: run.thread_id }); }
      await syncThreadA2aTask(run.thread_id);
      await notifyArgusTelemetry(thread, 'failed', undefined, message);
    });
  } finally {
    if (workspaceLease) {
      await workspaceLease.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      workspaceLease.release();
    }
    cancellationControls.delete(run.thread_id);
  }
}

/** Keep an external CI handoff durable without pretending the workflow ended. */
async function markRunWaitingForCi(runId: string, threadId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE argus_langgraph_runs
          SET status = 'waiting_external_ci', error = NULL, finished_at = NULL
        WHERE run_id = $1`,
      [runId],
    );
    await client.query(
      `UPDATE argus_langgraph_threads
          SET status = 'waiting_external_ci', error = NULL, updated_at = NOW()
        WHERE thread_id = $1`,
      [threadId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Transition the latest durable run after an idempotent provider callback. */
async function reconcileDurableCiStatus(
  threadId: string,
  ciRun: CiRun,
  snapshot: StateSnapshot | null,
): Promise<void> {
  const thread = await getThread(threadId);
  if (!thread) return;
  // A late provider receipt is evidence, not authority to undo cancellation.
  if (thread.status === 'canceling' || thread.status === 'canceled') return;
  const waitingForApproval = hasInterrupt(snapshot) || (snapshot?.next.length ?? 0) > 0;
  // Recovery uses a separate provider gate node (`external_ci_retry`) but it
  // has the same durable callback semantics as the regular `external_ci`
  // gate. LangGraph can expose the pending node without retaining the
  // interrupt payload after an updateState, so inspect both node names.
  const waitingForExternalCi = hasInterruptStage(snapshot, 'external_ci')
    || snapshot?.next.includes('external_ci') === true
    || snapshot?.next.includes('external_ci_retry') === true;
  const stateValues = safeStateValues(snapshot);

  // A CI callback can arrive while the graph is still in its second human
  // gate. Keep that gate visible; only the external evidence changes here.
  if (ciRun.status === 'queued' || ciRun.status === 'running' || ciRun.status === 'unknown') {
    if (thread.status === 'completed' || thread.status === 'failed' || thread.status === 'canceled') return;
    if (!waitingForApproval && externalCiIsPending(stateValues)) {
      await pool.query(
        `UPDATE argus_langgraph_threads
            SET status = 'waiting_external_ci', error = NULL, updated_at = NOW()
          WHERE thread_id = $1 AND status IN ('running', 'queued')`,
        [threadId],
      );
    }
    return;
  }

  if (waitingForApproval && waitingForExternalCi) {
    if (ciRun.status === 'success') {
      await enqueueContinueRun(threadId);
    } else if (ciRun.status === 'failure' || ciRun.status === 'canceled') {
      // CI recovery deliberately consumes a terminal failure and routes back
      // into its diagnosis/fix loop. The normal coding workflow treats the
      // same provider result as a terminal failure before PR approval.
      if (thread.graph_id === 'ci_failure_recovery' && ciRun.status === 'failure') {
        await enqueueContinueRun(threadId);
        return;
      }
      const message = `External CI ${ciRun.status}: ${ciRun.conclusion || 'provider reported a terminal failure'}`;
      await pool.query(
        `UPDATE argus_langgraph_threads SET status = 'failed', error = $2, updated_at = NOW()
          WHERE thread_id = $1 AND status NOT IN ('completed', 'canceled')`,
        [threadId, message],
      );
      await pool.query(
        `UPDATE argus_langgraph_runs SET status = 'failed', error = $2, finished_at = NOW()
          WHERE run_id = (SELECT run_id FROM argus_langgraph_runs WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1)
            AND status NOT IN ('completed', 'failed', 'canceled')`,
        [threadId, message],
      );
    }
    return;
  }

  if (waitingForApproval) {
    // The run remains resumable by the human approval endpoint. A failed CI
    // result is still actionable evidence, but must not auto-complete the gate.
    if (ciRun.status === 'failure' || ciRun.status === 'canceled') {
      await pool.query(
        `UPDATE argus_langgraph_threads
            SET status = 'failed', error = $2, updated_at = NOW()
          WHERE thread_id = $1 AND status NOT IN ('completed', 'canceled')`,
        [threadId, `External CI ${ciRun.status}: ${ciRun.conclusion || 'provider reported a terminal failure'}`],
      );
      await pool.query(
        `UPDATE argus_langgraph_runs
            SET status = 'failed', error = $2, finished_at = NOW()
          WHERE run_id = (SELECT run_id FROM argus_langgraph_runs WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1)
            AND status NOT IN ('completed', 'failed', 'canceled')`,
        [threadId, `External CI ${ciRun.status}: ${ciRun.conclusion || 'provider reported a terminal failure'}`],
      );
    }
    return;
  }

  const workflow = getWorkflowByGraphId(thread.graph_id);
  if (!workflow) return;
  const completion = evaluateWorkflowCompletion(workflow, stateValues);
  if (ciRun.status === 'success' && completion.successful) {
    await pool.query(
      `UPDATE argus_langgraph_runs
          SET status = 'completed', error = NULL, finished_at = NOW()
        WHERE run_id = (SELECT run_id FROM argus_langgraph_runs WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1)
          AND status NOT IN ('completed', 'failed', 'canceled')`,
      [threadId],
    );
    await pool.query(
      `UPDATE argus_langgraph_threads SET status = 'completed', error = NULL, updated_at = NOW()
        WHERE thread_id = $1 AND status NOT IN ('failed', 'canceled')`,
      [threadId],
    );
    return;
  }

  const message = ciRun.status === 'success'
    ? `Workflow ended without satisfying completion criteria: ${completion.missing.join(', ')}`
    : `External CI ${ciRun.status}: ${ciRun.conclusion || 'provider reported a terminal failure'}`;
  await pool.query(
    `UPDATE argus_langgraph_runs
        SET status = 'failed', error = $2, finished_at = NOW()
      WHERE run_id = (SELECT run_id FROM argus_langgraph_runs WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1)
        AND status NOT IN ('completed', 'failed', 'canceled')`,
    [threadId, message.slice(0, 4000)],
  );
  await pool.query(
    `UPDATE argus_langgraph_threads SET status = 'failed', error = $2, updated_at = NOW()
      WHERE thread_id = $1 AND status NOT IN ('completed', 'canceled')`,
    [threadId, message.slice(0, 4000)],
  );
}

async function syncThreadA2aTask(threadId: string): Promise<void> {
  try {
    await syncA2aTaskForThread(pool, threadId, await threadState(threadId));
  } catch (error) {
    log('warn', 'failed to synchronize A2A task state', {
      thread_id: threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function finishRunFromSnapshot(
  runId: string,
  thread: ThreadRow,
  snapshot: StateSnapshot | null,
): Promise<void> {
  if (hasInterrupt(snapshot) || (snapshot?.next.length ?? 0) > 0) {
    await markRunFinished(runId, thread.thread_id, 'interrupted', 'interrupted');
    await syncThreadA2aTask(thread.thread_id);
    await notifyArgusTelemetry(thread, 'waiting');
    if (snapshot?.next.includes('external_ci')) void reconcileJenkinsDispatch(thread.thread_id).catch(() => {
      log('warn', 'Jenkins dispatch reconciliation unavailable', { thread_id: thread.thread_id });
    });
    return;
  }

  // A finished step whose writes were not folded into a checkpoint is not a
  // completed workflow. Fail with an explicit, resumable state instead of
  // judging completion criteria against stale values.
  if (snapshot && hasPendingResult(snapshot)) {
    const pending = snapshot.tasks.filter(task => task.result !== undefined).map(task => task.name);
    const message = `Workflow step ${pending.join(', ')} finished but its checkpoint was not committed. Continue from the last checkpoint; no step was replayed.`;
    log('warn', 'workflow step left uncommitted writes', { run_id: runId, thread_id: thread.thread_id, checkpoint_id: checkpointId(snapshot), pending });
    await markRunFinished(runId, thread.thread_id, 'failed', 'failed', message.slice(0, 4000));
    await syncThreadA2aTask(thread.thread_id);
    await notifyArgusTelemetry(thread, 'failed', undefined, message);
    return;
  }

  // The graph can finish its local work immediately after pushing a branch,
  // while the provider-owned CI pipeline is still asynchronous. Keep the
  // durable run open until the signed webhook supplies terminal evidence.
  if (externalCiIsPending(safeStateValues(snapshot))) {
    await markRunWaitingForCi(runId, thread.thread_id);
    await syncThreadA2aTask(thread.thread_id);
    await notifyArgusTelemetry(thread, 'waiting');
    return;
  }

  const workflow = getWorkflowByGraphId(thread.graph_id);
  if (!workflow) throw new Error(`graph ${thread.graph_id} is not registered`);
  const completion = evaluateWorkflowCompletion(workflow, safeStateValues(snapshot));
  if (!completion.successful) {
    const message = `Workflow ended without satisfying completion criteria: ${completion.missing.join(', ')}`;
    await markRunFinished(runId, thread.thread_id, 'failed', 'failed', message.slice(0, 4000));
    await syncThreadA2aTask(thread.thread_id);
    await notifyArgusTelemetry(thread, 'failed', undefined, message);
    return;
  }

  await markRunFinished(runId, thread.thread_id, 'completed', 'completed');
  await syncThreadA2aTask(thread.thread_id);
  await notifyArgusTelemetry(thread, 'completed');
}

/** Serialize provider projection and dispatch across Pack replicas/callbacks. */
async function withCiThreadLock<T>(threadId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`argus.dev.ci:${threadId}`]);
    return await action(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`argus.dev.ci:${threadId}`]).catch(() => undefined);
    client.release();
  }
}

async function reconcileJenkinsDispatch(threadId: string): Promise<void> {
  if (!jenkinsDispatchConfig) return;
  await withCiThreadLock(threadId, async client => {
    const thread = await getThread(threadId, client);
    if (!thread || !['interrupted', 'waiting_external_ci'].includes(thread.status)) return;
    const snapshot = await getSnapshot(threadId, thread);
    // Internal CI authorization needs the opaque execution grant. The public
    // checkpoint projection intentionally strips it and must not be used here.
    const values = (snapshot?.values ?? {}) as JsonObject;
    if (!snapshot?.next.includes('external_ci') || values['human_approved'] !== true || values['branch_pushed'] !== true
      || values['ci_provider'] !== 'jenkins' || !jenkinsTarget(jenkinsDispatchConfig, values['bitbucket_creds'] as any, String(values['ci_job'] || (values['ci_run'] as CiRun | undefined)?.workflow || ''))) return;
    const base = await resolveCiBaseCommit(values);
    const intent = makeJenkinsIntent(jenkinsDispatchConfig, values, base);
    if (!intent) return;
    const metadataKey = `ci_dispatch_${intent.key}`;
    const authorizeCi = async () => {
      await authorizeJenkinsBundle(values as unknown as Parameters<typeof authorizeJenkinsBundle>[0], threadId,
        values['bitbucket_creds'] as Parameters<typeof authorizeJenkinsBundle>[2], jenkinsDispatchConfig, intent.job, intent);
    };
    const ci = await dispatchJenkins(jenkinsDispatchConfig, intent, {
      claim: async receipt => {
        const claimed = await client.query(
          `UPDATE argus_langgraph_threads SET metadata = metadata || jsonb_build_object($2::text, $3::jsonb)
           WHERE thread_id = $1 AND status IN ('interrupted', 'waiting_external_ci') AND NOT (metadata ? $2) RETURNING thread_id`,
          [threadId, metadataKey, JSON.stringify(receipt)],
        );
        return claimed.rowCount === 1;
      },
      save: async receipt => {
        await client.query('UPDATE argus_langgraph_threads SET metadata = metadata || jsonb_build_object($2::text, $3::jsonb) WHERE thread_id = $1',
          [threadId, metadataKey, JSON.stringify(receipt)]);
      },
    }, fetch, authorizeCi).catch(error => {
      if (!(error instanceof DevCiAuthorizationError)) throw error;
      // Authorization failure is not a failed provider build. Surface the block
      // in run evidence, without consuming a write intent or bypassing approval.
      return { provider: 'jenkins' as const, status: 'unknown' as const, external_id: '',
        workflow: intent.job, branch: intent.branch, commit_sha: intent.commit,
        run_url: '', conclusion: `bundle_authorization_required: ${error.message}`, updated_at: new Date().toISOString() };
    });
    const previous = values['ci_run'] as CiRun;
    if (['status', 'external_id', 'workflow', 'run_url', 'conclusion'].every(key => previous?.[key as keyof CiRun] === ci[key as keyof CiRun])) return;
    const workflow = getWorkflowByGraphId(thread.graph_id)!;
    const mergedCiRun = mergeCiRun(previous, ci);
    await workflow.graph.updateState({ configurable: { thread_id: threadId } }, {
      ci_run: mergedCiRun, build_url: ci.run_url, base_commit_sha: base,
      delivery_status: ci.status === 'unknown' ? 'awaiting_ci' : deliveryStatusForCi(ci.status),
      log: [{ step: 'ci_dispatch', summary: `Jenkins ${intent.job}: ${ci.status}${ci.external_id ? ` #${ci.external_id}` : ''}${ci.conclusion ? ` (${ci.conclusion})` : ''}` }],
    });
    const providerFailed = ci.status === 'failure' || ci.status === 'canceled';
    if (providerFailed) await reconcileDurableCiStatus(threadId, mergedCiRun, await getSnapshot(threadId));
    await syncThreadA2aTask(threadId);
    await notifyArgusTelemetry(thread, providerFailed ? 'failed' : 'waiting', undefined,
      providerFailed ? `External CI ${ci.status}: ${ci.conclusion}` : undefined);
    log('info', 'Jenkins dispatch evidence updated', { thread_id: threadId, commit_sha: intent.commit, job: intent.job, status: ci.status, external_id: ci.external_id });
  });
}

async function reconcilePendingJenkins(): Promise<void> {
  if (!jenkinsDispatchConfig) return;
  const result = await pool.query<{ thread_id: string }>(
    `SELECT thread_id FROM argus_langgraph_threads WHERE status IN ('interrupted', 'waiting_external_ci') ORDER BY updated_at DESC LIMIT 100`,
  );
  for (const row of result.rows) await reconcileJenkinsDispatch(row.thread_id).catch(() => {
    log('warn', 'Jenkins dispatch reconciliation unavailable', { thread_id: row.thread_id });
  });
}

function scheduleRun(runId: string): void {
  if (activeRuns.has(runId)) return;
  const promise = executeRun(runId)
    .catch(error => log('error', 'run worker failed', {
      run_id: runId,
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => activeRuns.delete(runId));
  activeRuns.set(runId, promise);
}

async function claimWorkspace(root: string): Promise<PoolClient> {
  const client = await workspaceLeasePool.connect();
  try {
    const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`argus.dev.workspace:${root}`]);
    if (!result.rows[0]?.locked) throw new CheckpointRetryError('This workspace is already in use by another run.');
    return client;
  } catch (error) { client.release(); throw error; }
}

async function checkpointState(threadId: string): Promise<RetryState> {
  const row = await getThread(threadId);
  if (!row) throw new HttpError(404, 'thread not found');
  const snapshot = await getSnapshot(threadId, row);
  return { ...serializeState(row, snapshot), values: { ...(snapshot?.values ?? {}) } } as unknown as RetryState;
}

async function checkpointWorkerStatuses() {
  const url = process.env['AGENT_WORKSPACE_URL'] ?? 'http://agent-workspace:3001';
  return Promise.all(['codex', 'claude'].map(async provider => {
    const response = await fetch(`${url}/${provider}/status`, { headers: { 'x-workspace-secret': RUNTIME_SECRET }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new CheckpointRetryError('Worker status unavailable; cannot confirm safe continuation.');
    const body = await response.json() as { runs?: JsonObject[] };
    if (!Array.isArray(body.runs)) throw new CheckpointRetryError('Worker status is incomplete.');
    return { provider, runs: body.runs };
  }));
}

async function inspectCheckpointWorkspace(state: RetryState, freshGrant?: string, qaRecovery?: 'recheck' | 'retry') {
  const root = String(state.values?.['workspace_dir']);
  const statuses = await checkpointWorkerStatuses();
  if (qaRecovery) { (qaRecovery === 'retry' ? prepareQaRetry : recheckQaResponse)(state); assertQaWorkspaceIdle(state, statuses); }
  else if (isCodegenImportRecovery(state)) { assertQaWorkspaceIdle(state, statuses); }
  else if (isPreQaGrantRecovery(state)) {
    assertQaWorkspaceIdle(state, statuses);
    const traces = await pool.query<{ id: string; status: string }>(
      `SELECT id,status FROM mcp_observability_traces WHERE root_trace_id=$1 AND kind='agent'`, [state.thread_id]);
    assertPreQaGrantTraces(state, traces.rows);
  }
  else if (isStackSnapshotRecovery(state)) {
    if (statuses.some(s => s.runs?.some(r => !r['finishedAt']))) throw new CheckpointRetryError('A runtime is active; snapshot recovery requires idle workers.');
  } else assertStoppedWorker(state, statuses);
  let creds = state.values?.['bitbucket_creds'] as import('./state.js').GitCreds;
  if (freshGrant) {
    const candidates = await Promise.all((state.metadata['execution_bundle_ids'] as number[]).map(id => fetchGitCreds(id, 0, freshGrant, state.thread_id)));
    const fresh = selectCheckoutTarget(candidates.filter((item): item is NonNullable<typeof item> => Boolean(item)), String(state.values?.['repository'] ?? ''));
    if (!creds || buildCloneUrl(fresh) !== buildCloneUrl(creds) || fresh.target_branch !== creds.target_branch) {
      throw new CheckpointRetryError('The configured repository/target branch changed. Configure a new attempt.');
    }
    creds = fresh;
  }
  if (!creds?.base_url || !creds.repo_slug) throw new CheckpointRetryError('Repository identity is missing.');
  const exec = async (cmd: string) => {
    const result = await workspaceExec(root, cmd, 10);
    if (result.exit_code !== 0 || result.stdout.length > 100_000) throw new CheckpointRetryError('Workspace could not be verified without resetting it.');
    return result.stdout;
  };
  const head = await exec('git rev-parse HEAD');
  const origin = await exec('git remote get-url origin');
  const status = await exec('git status --porcelain --untracked-files=all');
  if ((qaRecovery || isPreQaGrantRecovery(state)) && status.trim()) throw new CheckpointRetryError('QA recovery requires the unchanged, clean pre-implementation workspace.');
  const expectedOrigin = buildCloneUrl(creds);
  // Validate paths before inserting any of them into the read-only hash command.
  workspaceRetryDigest(state, { head, origin, expectedOrigin, status, contentHashes: '' });
  const paths = changedPathsFromGitStatus(status);
  if (paths.length > 500) throw new CheckpointRetryError('Workspace is too large for bounded continuation verification.');
  const hashes: string[] = [];
  for (const path of paths) {
    hashes.push(await exec(`if test -e '${path}' || test -L '${path}'; then test -f '${path}' && test ! -L '${path}' && test ! -x '${path}' && git hash-object -- '${path}'; else echo deleted; fi`));
  }
  if (isStackSnapshotRecovery(state)) {
    const v = state.values!;
    const sourceSha256 = String((v['qa_history'] as JsonObject[]).at(-1)!['sourceSha256']);
    const response = await fetch(`${process.env['AGENT_WORKSPACE_URL'] ?? 'http://agent-workspace:3001'}/stack-tests/recovery-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-secret': RUNTIME_SECRET },
      // Match Core's schema-canonical field order: request hashes are byte-bound.
      body: JSON.stringify({ ...stackRequestSchema.parse({ action: 'project',
        baseCommitSha: v['base_commit_sha'], basisSha256: qaBasis(v), sourceSha256, stackPlan: v['stack_plan'] }),
        threadId: state.thread_id, workspaceRoot: root }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new CheckpointRetryError('The stopped stack snapshot is not reconciled or its one-shot recovery was already consumed.');
    const proof = await response.json() as JsonObject;
    if (proof['sourceSha256'] !== sourceSha256 || proof['planSha256'] !== stackHash(v['stack_plan']) || proof['testsStarted'] !== false
      || !/^[a-f0-9]{64}$/.test(String(proof['recoverySha256'])) || !/^sha256:[a-f0-9]{64}$/.test(String(proof['preparedImage']))) {
      throw new CheckpointRetryError('Snapshot recovery evidence is invalid.');
    }
    assertCodegenCurrent(v, qaBasis(v), sourceSha256);
    hashes.push(stackHash(proof));
  }
  const codegen = isCodegenImportRecovery(state) ? await previewCodegenImport(state) : undefined;
  if (codegen) hashes.push(stackHash(codegen.proof));
  return { digest: workspaceRetryDigest(state, { head, origin, expectedOrigin, status, contentHashes: hashes.join('\n') }), creds, codegen };
}

async function checkpointContext(threadId: string): Promise<JsonObject> {
  const state = await checkpointState(threadId);
  // Internal only: Core authenticates the historical grant and projects only
  // allow-listed eligibility fields to its authenticated browser caller.
  const provenance = { executionGrant: state.values?.['argus_execution_grant'], metadata: state.metadata, threadId };
  let lease: PoolClient | undefined;
  try {
    const node = checkpointRetryNode(state);
    lease = await claimWorkspace(String(state.values?.['workspace_dir']));
    const checked = await inspectCheckpointWorkspace(state);
    return { ...provenance, available: true, node, checkpointId: state.checkpoint_id, workspaceDigest: checked.digest };
  } catch (error) {
    return { ...provenance, available: false, reason: error instanceof CheckpointRetryError ? error.message : 'Checkpoint/workspace verification unavailable.' };
  } finally {
    if (lease) { await lease.query('SELECT pg_advisory_unlock_all()'); lease.release(); }
  }
}

async function qaResponseContext(threadId: string, retry = false): Promise<JsonObject> {
  const state = await checkpointState(threadId);
  const provenance = { executionGrant: state.values?.['argus_execution_grant'], metadata: state.metadata, threadId };
  let lease: PoolClient | undefined;
  try {
    const checkedResponse = retry ? prepareQaRetry(state) : recheckQaResponse(state);
    lease = await claimWorkspace(String(state.values?.['workspace_dir']));
    const checked = await inspectCheckpointWorkspace(state, undefined, retry ? 'retry' : 'recheck');
    const update = retry ? undefined : (checkedResponse as ReturnType<typeof recheckQaResponse>).update;
    const retryDetails = retry ? checkedResponse as ReturnType<typeof prepareQaRetry> : undefined;
    return { ...provenance, available: true, node: retry ? 'test_design' : 'coder', checkpointId: state.checkpoint_id,
      workspaceDigest: checked.digest, reviewDigest: checkedResponse.reviewDigest,
      sourceTraceId: checkedResponse.receipt.traceId, testPlan: update?.qa_test_plan,
      repairCount: update?.technical_design_history[0]!.responseRepairs.length,
      ...(retryDetails ? { retryKind: retryDetails.retryKind, missingDecisionIds: retryDetails.missingDecisionIds } : {}) };
  } catch (error) {
    return { ...provenance, available: false, reason: error instanceof CheckpointRetryError ? error.message : 'Saved QA response/workspace verification unavailable.' };
  } finally { if (lease) { await lease.query('SELECT pg_advisory_unlock_all()'); lease.release(); } }
}

async function enqueueRun(threadId: string, kind: RunKind, payload: JsonObject): Promise<string> {
  const snapshot = await getSnapshot(threadId);
  if (kind === 'resume') {
    const creds = snapshot?.values?.['bitbucket_creds'] as { reference?: unknown } | undefined;
    const thread = await getThread(threadId);
    const approvalStage = thread && isGitBrokerCodingGraph(thread.graph_id) && creds?.reference
      ? await pendingGitApprovalStage(thread, snapshot) : null;
    if (approvalStage) {
      validateGitApproval(payload['gitApproval'], { threadId, checkpointId: checkpointId(snapshot), stage: approvalStage,
        principal: thread?.metadata['execution_principal'], bundleIds: thread?.metadata['execution_bundle_ids'],
        workspaceRoot: snapshot?.values?.['argus_workspace_root'] });
    } else if (payload['gitApproval']) throw new HttpError(409, 'Git approval authority cannot resume another node.');
    try {
      if (hasInterruptStage(snapshot, 'requirements_input') && snapshot?.values?.['development_contract_version'] === 2) {
        validateDecisionReply(payload['resume'], decisionRequest(snapshot.values as any));
      } else validateDevelopmentResume(hasInterruptStage(snapshot, 'requirements_input'), payload['resume']);
    }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  }
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('SELECT thread_id FROM argus_langgraph_threads WHERE thread_id = $1 FOR UPDATE', [threadId]);
    const row = await getThread(threadId, client);
    if (!row) throw new HttpError(404, 'thread not found');
    if (kind === 'resume' && checkpointId(await getSnapshot(threadId)) !== checkpointId(snapshot)) {
      throw new HttpError(409, 'The paused checkpoint changed. Reload before answering.');
    }
    const retryableFailedCheckpoint = kind === 'continue'
      && row.status === 'failed'
      && checkpointId(snapshot) !== null
      && ((snapshot?.next.length ?? 0) > 0 || (snapshot !== null && hasPendingResult(snapshot)))
      && !hasInterrupt(snapshot);
    const recoverableQaResponse = kind === 'continue' && Boolean(payload['qaResponseRecovery'] || payload['qaRetry']) && row.status === 'interrupted';
    if (recoverableQaResponse) (payload['qaRetry'] ? prepareQaRetry : recheckQaResponse)({ ...serializeState(row, snapshot), values: { ...(snapshot?.values ?? {}) } } as unknown as RetryState);
    const recoverableCodegen = kind === 'continue' && Boolean(payload['checkpointRetry']) && row.status === 'interrupted'
      && isCodegenImportRecovery({ ...serializeState(row, snapshot), values: { ...(snapshot?.values ?? {}) } } as unknown as RetryState);
    const recoverableFailedApproval = kind === 'resume' && Boolean(payload['gitApproval'])
      && row.status === 'failed' && Boolean(await pendingGitApprovalStage(row, snapshot));
    const allowed = kind === 'input'
      ? row.status === 'idle'
      : kind === 'resume'
        ? row.status === 'interrupted' || recoverableFailedApproval
        : retryableFailedCheckpoint || recoverableQaResponse || recoverableCodegen;
    if (!allowed) {
      throw new HttpError(409, `thread is ${row.status}; cannot enqueue ${kind} run`);
    }
    await client.query(
      `INSERT INTO argus_langgraph_runs
         (run_id, thread_id, kind, payload, base_checkpoint_id, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'queued')`,
      [runId, threadId, kind, JSON.stringify(payload), checkpointId(snapshot)],
    );
    await client.query(
      `UPDATE argus_langgraph_threads
          SET status = 'queued', error = NULL, updated_at = NOW()
        WHERE thread_id = $1`,
      [threadId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  scheduleRun(runId);
  return runId;
}

/** Resume an asynchronous provider gate without exposing it as a human action. */
async function enqueueContinueRun(threadId: string): Promise<boolean> {
  const snapshot = await getSnapshot(threadId);
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    await client.query('BEGIN');
    const row = await getThread(threadId, client);
    // Provider callbacks can leave the durable row in `waiting_external_ci`
    // while the checkpoint exposes the pending recovery gate as its next
    // node. Both states are safe continuation points; never resume a running
    // or terminal thread.
    if (!row || !['interrupted', 'waiting_external_ci'].includes(row.status)) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO argus_langgraph_runs
         (run_id, thread_id, kind, payload, base_checkpoint_id, status)
       VALUES ($1, $2, 'continue', '{}'::jsonb, $3, 'queued')`,
      [runId, threadId, checkpointId(snapshot)],
    );
    await client.query(
      `UPDATE argus_langgraph_threads SET status = 'queued', error = NULL, updated_at = NOW()
        WHERE thread_id = $1 AND status IN ('interrupted', 'waiting_external_ci')`,
      [threadId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  scheduleRun(runId);
  return true;
}

async function recoverRuns(): Promise<void> {
  const result = await pool.query<RunRow>(
    `SELECT run_id, thread_id, kind, payload, base_checkpoint_id, status
       FROM argus_langgraph_runs
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC`,
  );
  for (const run of result.rows) {
    // A durable stop request survives restart. Never replay its checkpoint.
    if ((await getThread(run.thread_id))?.status === 'canceling') continue;
    if (run.status === 'running' && (run.payload['checkpointRetry'] || run.payload['qaResponseRecovery'] || run.payload['qaRetry'] || run.payload['gitApproval'])) {
      await markRunFinished(run.run_id, run.thread_id, 'failed', 'failed', 'Continuation interrupted by server restart; worker reconciliation required. No automatic replay.');
      continue;
    }
    if (run.status === 'queued') {
      await pool.query("UPDATE argus_langgraph_threads SET status = 'queued' WHERE thread_id = $1 AND status = 'running'", [run.thread_id]);
      scheduleRun(run.run_id);
      continue;
    }

    const snapshot = await getSnapshot(run.thread_id);
    const currentCheckpoint = checkpointId(snapshot);
    if (currentCheckpoint === run.base_checkpoint_id) {
      await pool.query("UPDATE argus_langgraph_threads SET status = 'queued' WHERE thread_id = $1 AND status = 'running'", [run.thread_id]);
      await pool.query(
        `UPDATE argus_langgraph_runs SET status = 'queued', started_at = NULL WHERE run_id = $1`,
        [run.run_id],
      );
      scheduleRun(run.run_id);
    } else if (hasInterrupt(snapshot)) {
      const thread = await getThread(run.thread_id);
      if (thread) await finishRunFromSnapshot(run.run_id, thread, snapshot);
    } else if ((snapshot?.next.length ?? 0) === 0) {
      const thread = await getThread(run.thread_id);
      if (thread) await finishRunFromSnapshot(run.run_id, thread, snapshot);
    } else {
      await pool.query("UPDATE argus_langgraph_threads SET status = 'queued' WHERE thread_id = $1 AND status = 'running'", [run.thread_id]);
      await pool.query(
        `UPDATE argus_langgraph_runs
            SET status = 'queued', kind = 'continue', payload = '{}'::jsonb, started_at = NULL
          WHERE run_id = $1`,
        [run.run_id],
      );
      scheduleRun(run.run_id);
    }
  }
  if (result.rowCount) log('info', 'recovered durable runs', { count: result.rowCount });
}

async function reconcileNonTerminalA2aTasks(): Promise<void> {
  const result = await pool.query<{ workflow_thread_id: string }>(
    `SELECT DISTINCT workflow_thread_id
       FROM argus_a2a_tasks
      WHERE workflow_thread_id IS NOT NULL
        AND state NOT IN ('TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED')`,
  );
  for (const row of result.rows) await syncThreadA2aTask(row.workflow_thread_id);
  if (result.rowCount) log('info', 'reconciled non-terminal A2A tasks', { count: result.rowCount });
}

async function reconcileCompletedWorkflowOutcomes(): Promise<void> {
  const result = await pool.query<ThreadRow>(
    `SELECT thread_id, graph_id, metadata, status, error, created_at, updated_at
       FROM argus_langgraph_threads
      WHERE status = 'completed'`,
  );
  let corrected = 0;
  for (const thread of result.rows) {
    const workflow = getWorkflowByGraphId(thread.graph_id);
    if (!workflow) continue;
    const snapshot = await getSnapshot(thread.thread_id, thread);
    if (!snapshot || hasInterrupt(snapshot) || snapshot.next.length > 0) continue;
    if (externalCiIsPending(safeStateValues(snapshot))) {
      await pool.query(
        `UPDATE argus_langgraph_threads SET status = 'waiting_external_ci', error = NULL, updated_at = NOW()
          WHERE thread_id = $1 AND status = 'completed'`,
        [thread.thread_id],
      );
      await pool.query(
        `UPDATE argus_langgraph_runs SET status = 'waiting_external_ci', error = NULL, finished_at = NULL
          WHERE run_id = (SELECT run_id FROM argus_langgraph_runs WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1)
            AND status = 'completed'`,
        [thread.thread_id],
      );
      continue;
    }
    const completion = evaluateWorkflowCompletion(workflow, safeStateValues(snapshot));
    if (completion.successful) continue;
    const message = `Workflow ended without satisfying completion criteria: ${completion.missing.join(', ')}`.slice(0, 4000);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE argus_langgraph_threads
            SET status = 'failed', error = $2, updated_at = NOW()
          WHERE thread_id = $1 AND status = 'completed'`,
        [thread.thread_id, message],
      );
      await client.query(
        `UPDATE argus_langgraph_runs
            SET status = 'failed', error = $2, finished_at = COALESCE(finished_at, NOW())
          WHERE run_id = (
            SELECT run_id FROM argus_langgraph_runs
             WHERE thread_id = $1
             ORDER BY created_at DESC LIMIT 1
          ) AND status = 'completed'`,
        [thread.thread_id, message],
      );
      await client.query('COMMIT');
      corrected += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await syncThreadA2aTask(thread.thread_id);
    await notifyArgusTelemetry({ ...thread, status: 'failed', error: message }, 'failed', undefined, message);
  }
  if (corrected) log('info', 'corrected completed workflows with incomplete delivery evidence', { count: corrected });
}

async function threadState(threadId: string): Promise<JsonObject> {
  const row = await getThread(threadId);
  if (!row) throw new HttpError(404, 'thread not found');
  return serializeState(row, await getSnapshot(threadId, row));
}

async function cancelCodingThread(threadId: string): Promise<void> {
  return withCiThreadLock(threadId, () => cancelCodingThreadLocked(threadId));
}

async function cancelCodingThreadLocked(threadId: string): Promise<void> {
  const client = await pool.connect();
  let thread: ThreadRow | null = null;
  try {
    await client.query('BEGIN');
    thread = await getThread(threadId, client);
    if (!thread) throw new A2aProtocolError(404, 'TASK_NOT_FOUND', 'workflow thread not found');
    if (thread.status === 'canceled' || thread.status === 'canceling') {
      await client.query('COMMIT');
      cancellationControls.get(threadId)?.request();
      return;
    }
    if (['completed', 'failed'].includes(thread.status)) {
      throw new A2aProtocolError(400, 'TASK_NOT_CANCELABLE', `workflow in state ${thread.status} is not cancelable`);
    }
    if (thread.status !== 'running') await client.query(
      `UPDATE argus_langgraph_runs
          SET status = 'canceled', error = 'canceled through A2A', finished_at = NOW()
        WHERE thread_id = $1 AND status IN ('queued', 'waiting_external_ci')`,
      [threadId],
    );
    await client.query(
      `UPDATE argus_langgraph_threads
          SET status = $2, error = NULL, updated_at = NOW()
        WHERE thread_id = $1`,
      [threadId, thread.status === 'running' ? 'canceling' : 'canceled'],
    );
    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally {
    client.release();
  }
  if (thread) {
    cancellationControls.get(threadId)?.request();
    await syncThreadA2aTask(thread.thread_id);
    if (thread.status !== 'running') await notifyArgusTelemetry(thread, 'cancelled');
  }
}

const a2aCodingRuntime: CodingRuntimeAdapter = {
  async start(input, context) {
    const workflow = getWorkflow(context.workflowId);
    if (!workflow) throw new HttpError(400, `unknown workflow '${context.workflowId}'`);
    if (context.executionGrant.claims.testEnvironmentPolicy === 'workspace-session-v1'
      && ['ARGUS_WORKSPACE_SESSIONS_ENABLED', 'ARGUS_GENERAL_STACKS_ENABLED', 'ARGUS_PROJECT_ENVIRONMENTS_ENABLED',
        'ARGUS_DEV_QA_TESTS_ENABLED', 'ARGUS_DEV_TECHNICAL_DESIGN_ENABLED'].some(key => process.env[key] !== 'true')) {
      throw new HttpError(503, 'Workspace-session policy is not enabled on this Dev service; no fallback was attempted.');
    }
    if (context.retry) {
      const parent = await getThread(context.retry.sourceThreadId);
      const principal = `${context.executionGrant.claims.principalKind}:${context.executionGrant.claims.principalId}`;
      try { assertRetryParent(parent, context.retry, principal); }
      catch { throw new HttpError(403, 'Restart requires a failed or fully canceled run owned by the same execution principal.'); }
    }
    let handoff: ReturnType<typeof verifiedPlanningHandoff> | undefined;
    if (input['planning_thread_id']) {
      const planningId = String(input['planning_thread_id']);
      if (!/^[0-9a-f-]{36}$/i.test(planningId)) throw new HttpError(400, 'Use the planning thread UUID, not its task URL.');
      const parent = await getThread(planningId);
      const snapshot = parent ? await getSnapshot(planningId, parent) : null;
      try {
        handoff = verifiedPlanningHandoff(parent, snapshot?.values ?? {},
          `${context.executionGrant.claims.principalKind}:${context.executionGrant.claims.principalId}`,
          context.executionGrant.claims.bundleIds, String(input['allowed_files'] || ''));
      } catch (error) { throw new HttpError(400, (error as Error).message); }
    }
    let followUpCheckpoint: ReturnType<typeof followUpCheckpointFromSource> | null = null;
    if (workflow.id === 'ticket-follow-up-image-pull-request') {
      const sourceId = String(input['source_thread_id'] ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new HttpError(400, 'Use the completed Dev workflow thread UUID.');
      const source = await getThread(sourceId);
      const snapshot = source ? await getSnapshot(sourceId, source) : null;
      if (!source || !snapshot) throw new HttpError(404, 'The source Dev checkpoint is unavailable.');
      try {
        followUpCheckpoint = followUpCheckpointFromSource(source, {
          checkpointId: checkpointId(snapshot), next: snapshot.next, values: snapshot.values,
        }, `${context.executionGrant.claims.principalKind}:${context.executionGrant.claims.principalId}`,
        context.executionGrant.claims.bundleIds);
      } catch (error) { throw new HttpError(409, (error as Error).message); }
      if (input['ci_provider'] !== 'jenkins') throw new HttpError(400, 'This follow-up keeps the original Jenkins provider.');
    }
    const sourceIssue = ['ticket-to-pull-request', 'ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(workflow.id)
      ? await importRepositoryIssue(input, context.executionGrant) : null;
    if (followUpCheckpoint && (!sourceIssue || sourceIssue.repository !== followUpCheckpoint.repository)) {
      throw new HttpError(409, 'The follow-up issue must belong to the source PR repository.');
    }
    const thread = await createThread(workflow.graphId, {
      workflow_input: input,
      ...(sourceIssue ? { source_issue: sourceIssue } : {}),
      ...(followUpCheckpoint ? { follow_up_checkpoint: followUpCheckpoint, parent_thread_id: followUpCheckpoint.sourceThreadId } : {}),
      ...(handoff ? { planning_provenance: handoff.planning_provenance } : {}),
      ...(context.retry ? { retry_of: context.retry.sourceThreadId, retry_feedback: context.retry.feedback } : {}),
      workflow_id: workflow.id,
      workflow_label: workflow.label,
      workflow_type: workflow.graphId,
      run_title: workflowRunTitle(workflow, input),
      run_description: workflow.descriptionField && typeof input[workflow.descriptionField] === 'string'
        ? input[workflow.descriptionField]
        : null,
      ticket_id: input['ticket_id'] ?? null,
      description: input['description'] ?? null,
      repository: followUpCheckpoint?.repository ?? sourceIssue?.repository ?? handoff?.repository ?? input['repository'] ?? null,
      pull_request_number: input['pull_request_number'] ?? null,
      source: 'a2a',
      a2a_task_id: context.taskId,
      a2a_context_id: context.contextId,
      execution_grant_id: context.executionGrant.claims.jti,
      execution_principal: `${context.executionGrant.claims.principalKind}:${context.executionGrant.claims.principalId}`,
      execution_bundle_ids: context.executionGrant.claims.bundleIds,
      execution_runtime_overrides: context.executionGrant.claims.runtimeProfileOverrides ?? [],
    }, context.preferredThreadId);
    const executionInput = retryExecutionInput(input, workflow.descriptionField, context.retry?.feedback ?? '');
    await enqueueRun(thread.thread_id, 'input', {
      input: {
        ...executionInput,
        ...(followUpCheckpoint ? { follow_up_checkpoint: followUpCheckpoint,
          repository: followUpCheckpoint.repository, source_branch: followUpCheckpoint.branch,
          branch_name: followUpCheckpoint.branch, ci_job: followUpCheckpoint.ciJob } : {}),
        ...handoff,
        ...(['ticket-to-pull-request', 'ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(workflow.id) ? {
          delivery_mode: ['ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(workflow.id)
            ? 'ticket-to-image-pull-request' : '',
          development_contract_version: 2,
          qa_acceptance_policy_version: workflow.id === 'ticket-to-pull-request' && process.env['ARGUS_DEV_QA_TESTS_ENABLED'] === 'true'
            && process.env['ARGUS_DEV_TECHNICAL_DESIGN_ENABLED'] === 'true' ? 1 : 0,
          qa_environment_policy_version: workflow.id === 'ticket-to-pull-request' && process.env['ARGUS_PROJECT_ENVIRONMENTS_ENABLED'] === 'true'
            && process.env['ARGUS_DEV_QA_TESTS_ENABLED'] === 'true' && process.env['ARGUS_DEV_TECHNICAL_DESIGN_ENABLED'] === 'true'
            ? process.env['ARGUS_GENERAL_STACKS_ENABLED'] === 'true' && context.executionGrant.claims.testEnvironmentPolicy
              ? context.executionGrant.claims.testEnvironmentPolicy === 'workspace-session-v1' ? 3 : 2 : 1 : 0,
          stack_plan: null, stack_result: null, stack_repair_count: 0, stack_needs_repair: false,
          // Fresh starts only: never raise the allowance of an existing checkpoint.
          stack_repair_policy_version: workflow.id === 'ticket-to-pull-request' && process.env['ARGUS_GENERAL_STACKS_ENABLED'] === 'true'
            && Boolean(context.executionGrant.claims.testEnvironmentPolicy) ? 1 : 0,
          stack_repair_started_at: 0, stack_repair_pending: false,
          stack_repair_source_sha256: '', stack_repair_basis_sha256: '',
          code_generation_policy_version: workflow.id === 'ticket-to-pull-request' && process.env['ARGUS_CODE_GENERATION_ENABLED'] === 'true'
            && process.env['ARGUS_GENERAL_STACKS_ENABLED'] === 'true' && process.env['ARGUS_PROJECT_ENVIRONMENTS_ENABLED'] === 'true'
            && process.env['ARGUS_DEV_QA_TESTS_ENABLED'] === 'true' && process.env['ARGUS_DEV_TECHNICAL_DESIGN_ENABLED'] === 'true'
            && context.executionGrant.claims.codeGeneration?.version === 1 ? 1 : 0,
          code_generation_decision: null, code_generation_receipt: null,
          // Frozen only at fresh dispatch. Existing paused codegen runs keep policy 0.
          code_generation_repair_policy_version: workflow.id === 'ticket-to-pull-request' && process.env['ARGUS_CODE_GENERATION_ENABLED'] === 'true' ? 1 : 0,
          code_generation_repair_count: 0, code_generation_needs_repair: false, code_generation_repair_pending: false,
          code_generation_failure: null, code_generation_failed_recipes: [],
          qa_artifact: null, qa_receipt: null, qa_history: [],
          // Roll out explicitly after provider-free certification; freeze policy per run.
          // Existing checkpoints never inherit a changed deployment default.
          technical_design_policy_version: workflow.id === 'ticket-to-pull-request' && process.env['ARGUS_DEV_TECHNICAL_DESIGN_ENABLED'] === 'true' ? 1 : 0,
          technical_decisions: [], technical_open_findings: [], technical_design_history: [], technical_resolution_evidence: [],
          technical_investigation_count: 0, technical_investigation_pending: false,
          technical_experiment_policy_version: workflow.id === 'ticket-to-pull-request' && process.env['ARGUS_DEV_TECHNICAL_DESIGN_ENABLED'] === 'true'
            && process.env['ARGUS_TECHNICAL_EXPERIMENTS_ENABLED'] === 'true' ? 1 : 0,
          technical_experiment_count: 0, technical_experiment_request: null, technical_experiment_result: null,
          issue_snapshot: sourceIssue,
          repository: followUpCheckpoint?.repository ?? sourceIssue?.repository ?? handoff?.repository ?? executionInput['repository'] ?? '',
          repository_scope_policy: 'development-v1',
          description: String(executionInput['description'] ?? '') + issueContext(sourceIssue),
        } : {}),
        ...(workflow.origin === 'visual-builder' ? { input } : {}),
        argus_execution_grant: context.executionGrant.token,
        argus_bundle_id: context.executionGrant.claims.bundleIds[0] ?? 0,
        argus_bundle_ids: context.executionGrant.claims.bundleIds,
        argus_workspace_root: context.executionGrant.claims.workspaceRoot ?? '',
      },
    });
    return { threadId: thread.thread_id };
  },
  getState: threadState,
  cancel: cancelCodingThread,
};

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://argus-langgraph.internal');

  if (method === 'GET' && url.pathname === '/healthz') {
    writeJson(res, 200, { ok: true, pack: 'argus.dev', runtime: 'langgraph' });
    return;
  }

  if (method === 'GET' && url.pathname === '/.well-known/argus-solution-pack.yaml') {
    if (!packDiscoveryAuthorized(String(req.headers['authorization'] ?? ''))) {
      throw new HttpError(401, 'invalid pack discovery credential');
    }
    writeJson(res, 200, ARGUS_DEV_PACK_MANIFEST);
    return;
  }

  if (method === 'GET' && url.pathname === A2A_AGENT_CARD_PATH) {
    if (!packDiscoveryAuthorized(String(req.headers['authorization'] ?? ''))) {
      throw new A2aProtocolError(401, 'UNAUTHENTICATED', 'invalid A2A service credential');
    }
    const card = buildArgusDevAgentCard(A2A_PUBLIC_URL, Boolean(PACK_DISCOVERY_TOKEN));
    const data = JSON.stringify(card);
    res.writeHead(200, {
      'content-type': `${A2A_CONTENT_TYPE}; charset=utf-8`,
      'content-length': Buffer.byteLength(data),
      'cache-control': 'private, max-age=60',
      etag: `"argus-dev-${String(card['version'])}"`,
    });
    res.end(data);
    return;
  }

  if (method === 'GET' && url.pathname === '/readyz') {
    if (!packDiscoveryAuthorized(String(req.headers['authorization'] ?? ''))) {
      throw new HttpError(401, 'invalid pack discovery credential');
    }
    try {
      await pool.query('SELECT 1');
      writeJson(res, 200, { ok: true, pack: 'argus.dev', runtime: 'langgraph', storage: 'postgres' });
    } catch {
      writeJson(res, 503, { ok: false, pack: 'argus.dev', error: 'database unavailable' });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/ok') {
    try {
      await pool.query('SELECT 1');
      writeJson(res, 200, { ok: true, runtime: 'argus-langgraph', storage: 'postgres' });
    } catch {
      writeJson(res, 503, { ok: false, error: 'database unavailable' });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/message:send') {
    assertA2aRequest(req, true);
    writeA2aJson(res, 200, await sendA2aMessage(
      pool,
      await readJson(req),
      String(req.headers['traceparent'] ?? ''),
      String(req.headers['x-argus-root-trace-id'] ?? ''),
      a2aCodingRuntime,
      String(req.headers['x-argus-execution-grant'] ?? ''),
    ));
    return;
  }

  const a2aCancelMatch = /^\/tasks\/([0-9a-f-]+):cancel$/i.exec(url.pathname);
  if (method === 'POST' && a2aCancelMatch) {
    assertA2aRequest(req, true);
    await readJson(req);
    writeA2aJson(res, 200, await cancelA2aTask(pool, a2aCancelMatch[1]!, a2aCodingRuntime));
    return;
  }

  const a2aTaskMatch = /^\/tasks\/([0-9a-f-]+)$/i.exec(url.pathname);
  if (method === 'GET' && a2aTaskMatch) {
    assertA2aRequest(req);
    writeA2aJson(res, 200, await getA2aTask(pool, a2aTaskMatch[1]!, a2aCodingRuntime));
    return;
  }

  if (!secretMatches(String(req.headers['x-workspace-secret'] ?? ''))) {
    throw new HttpError(401, 'invalid runtime secret');
  }

  if (method === 'POST' && url.pathname === '/visual-workflows/publish') {
    const body = await readJson(req);
    const spec = await publishVisualWorkflow(body['spec'] ?? body);
    writeJson(res, 200, {
      ok: true,
      workflowId: spec.id,
      graphId: spec.graphId,
      revision: spec.revision,
      publishedAt: new Date().toISOString(),
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/visual-workflows') {
    const workflows = listRegisteredWorkflows()
      .filter(workflow => workflow.origin === 'visual-builder')
      .map(({ graph: _graph, ...workflow }) => workflow);
    writeJson(res, 200, { workflows });
    return;
  }

  // Explicitly invoked, read-only live provider canaries. The endpoint is
  // internal-only and the runner enforces opt-in, token indirection and a
  // process-local minimum interval before making any external request.
  if (method === 'POST' && url.pathname === '/ci/canaries') {
    try {
      const results = await runConfiguredCiProviderCanaries();
      writeJson(res, 200, { generated_at: new Date().toISOString(), results });
    } catch (error) {
      if (error instanceof CiCanaryConfigurationError) throw new HttpError(400, error.message);
      if (error instanceof CiCanaryRateLimitError) throw new HttpError(429, error.message);
      throw error;
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/assistants/search') {
    writeJson(res, 200, listRegisteredWorkflows().map(({ graph: _graph, ...workflow }) => ({
      assistant_id: workflow.graphId,
      graph_id: workflow.graphId,
      name: workflow.label,
      metadata: { runtime: 'argus-native', workflow },
    })));
    return;
  }

  if (method === 'POST' && url.pathname === '/threads') {
    const body = await readJson(req);
    const metadata = body['metadata'];
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) {
      throw new HttpError(400, 'metadata must be an object');
    }
    const safeMetadata = (metadata ?? {}) as JsonObject;
    const graphId = typeof body['graph_id'] === 'string'
      ? body['graph_id']
      : typeof safeMetadata['workflow_type'] === 'string'
        ? safeMetadata['workflow_type']
        : DEFAULT_GRAPH_ID;
    const thread = await createThread(graphId, safeMetadata);
    writeJson(res, 200, serializeState(thread, null));
    return;
  }

  if (method === 'POST' && url.pathname === '/threads/search') {
    const body = await readJson(req);
    const rawLimit = Number(body['limit'] ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 50;
    const metadata = body['metadata'];
    const params: unknown[] = [];
    let where = '';
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      params.push(JSON.stringify(metadata));
      where = `WHERE metadata @> $${params.length}::jsonb`;
    }
    params.push(limit);
    const result = await pool.query<ThreadRow>(
      `SELECT thread_id, graph_id, metadata, status, error, created_at, updated_at
         FROM argus_langgraph_threads
         ${where}
        ORDER BY updated_at DESC
        LIMIT $${params.length}`,
      params,
    );
    const states = await Promise.all(result.rows.map(row => getSnapshot(row.thread_id, row)
      .then(snapshot => serializeState(row, snapshot))));
    writeJson(res, 200, states);
    return;
  }

  const stateMatch = /^\/threads\/([0-9a-f-]+)\/state$/i.exec(url.pathname);
  if (method === 'GET' && stateMatch) {
    writeJson(res, 200, await threadState(stateMatch[1]!));
    return;
  }

  const historyMatch = /^\/threads\/([0-9a-f-]+)\/checkpoints$/i.exec(url.pathname);
  if (method === 'GET' && historyMatch) {
    const thread = await getThread(historyMatch[1]!);
    if (!thread) throw new HttpError(404, 'thread not found');
    const workflow = getWorkflowByGraphId(thread.graph_id);
    if (!workflow) throw new HttpError(404, 'workflow graph not found');
    const requested = Number(url.searchParams.get('limit') ?? '30');
    const limit = Number.isSafeInteger(requested) ? Math.min(100, Math.max(1, requested)) : 30;
    const checkpoints: JsonObject[] = [];
    for await (const snapshot of workflow.graph.getStateHistory({ configurable: { thread_id: thread.thread_id } }, { limit })) {
      const metadata = snapshot.metadata && typeof snapshot.metadata === 'object' ? snapshot.metadata as Record<string, unknown> : {};
      const writes = metadata['writes'] && typeof metadata['writes'] === 'object' && !Array.isArray(metadata['writes'])
        ? Object.keys(metadata['writes'] as Record<string, unknown>).filter(name => /^[a-z_][a-z0-9_]{0,79}$/i.test(name)) : [];
      const parent = snapshot.parentConfig?.configurable as Record<string, unknown> | undefined;
      checkpoints.push({ checkpointId: checkpointId(snapshot),
        parentCheckpointId: typeof parent?.['checkpoint_id'] === 'string' ? parent['checkpoint_id'] : null,
        createdAt: snapshot.createdAt ?? null, step: typeof metadata['step'] === 'number' ? metadata['step'] : null,
        nodes: writes, next: snapshot.next.filter(name => /^[a-z_][a-z0-9_]{0,79}$/i.test(name)),
        interrupted: hasInterrupt(snapshot) });
    }
    writeJson(res, 200, { threadId: thread.thread_id, parentThreadId: thread.metadata['parent_thread_id'] ?? null,
      checkpoints });
    return;
  }

  const checkpointRetryMatch = /^\/threads\/([0-9a-f-]+)\/checkpoint-retry$/i.exec(url.pathname);
  if (checkpointRetryMatch && method === 'GET') {
    writeJson(res, 200, await checkpointContext(checkpointRetryMatch[1]!));
    return;
  }
  if (checkpointRetryMatch && method === 'POST') {
    const id = checkpointRetryMatch[1]!;
    const body = await readJson(req);
    const result = await withCiThreadLock(id, async () => {
      const state = await checkpointState(id);
      const node = checkpointRetryNode(state);
      if (state.checkpoint_id !== body['checkpointId']) throw new CheckpointRetryError('Checkpoint changed. Reload retry options.');
      const grant = decodePackExecutionGrant(String(body['grant'] ?? ''), {
        packId: 'argus.dev', agentId: 'coding-orchestrator', messageId: String(body['messageId']), rootTraceId: id,
      });
      assertCheckpointGrant(state, grant);
      const lease = await claimWorkspace(String(state.values?.['workspace_dir']));
      try {
        const checked = await inspectCheckpointWorkspace(state, grant.token);
        if (checked.digest !== body['workspaceDigest']) throw new CheckpointRetryError('Workspace changed. Reload retry options.');
        const runId = await enqueueRun(id, 'continue', { checkpointRetry: {
          grant: grant.token, messageId: grant.claims.messageId, workspaceDigest: checked.digest, originalError: state.error, originalStatus: state.status,
        } });
        await syncThreadA2aTask(id);
        return { thread_id: id, run_id: runId, node, status: 'queued' };
      } finally { await lease.query('SELECT pg_advisory_unlock_all()'); lease.release(); }
    });
    writeJson(res, 202, result);
    return;
  }

  const qaRecheckMatch = /^\/threads\/([0-9a-f-]+)\/(qa-response-recheck|qa-retry)$/i.exec(url.pathname);
  const qaRetryRequested = qaRecheckMatch?.[2] === 'qa-retry';
  if (qaRecheckMatch && method === 'GET') {
    writeJson(res, 200, await withCiThreadLock(qaRecheckMatch[1]!, () => qaResponseContext(qaRecheckMatch[1]!, qaRetryRequested)));
    return;
  }
  if (qaRecheckMatch && method === 'POST') {
    const id = qaRecheckMatch[1]!;
    const body = await readJson(req);
    if (Object.keys(body).sort().join(',') !== 'checkpointId,grant,messageId,reviewDigest,workspaceDigest') {
      throw new CheckpointRetryError('QA continuation accepts only reviewed fingerprints and fresh Core authority.');
    }
    const result = await withCiThreadLock(id, async () => {
      const state = await checkpointState(id);
      const checkedResponse = qaRetryRequested ? prepareQaRetry(state) : recheckQaResponse(state);
      if (state.checkpoint_id !== body['checkpointId'] || checkedResponse.reviewDigest !== body['reviewDigest']) throw new CheckpointRetryError('QA checkpoint or response changed. Recheck before continuing.');
      const grant = decodePackExecutionGrant(String(body['grant']), {
        packId: 'argus.dev', agentId: 'coding-orchestrator', messageId: String(body['messageId']), rootTraceId: id,
      });
      assertCheckpointGrant(state, grant);
      const lease = await claimWorkspace(String(state.values?.['workspace_dir']));
      try {
        const checked = await inspectCheckpointWorkspace(state, grant.token, qaRetryRequested ? 'retry' : 'recheck');
        if (checked.digest !== body['workspaceDigest']) throw new CheckpointRetryError('Workspace changed. Recheck before continuing.');
        const runId = await enqueueRun(id, 'continue', { [qaRetryRequested ? 'qaRetry' : 'qaResponseRecovery']: {
          grant: grant.token, messageId: grant.claims.messageId, reviewDigest: checkedResponse.reviewDigest, workspaceDigest: checked.digest,
        } });
        await syncThreadA2aTask(id);
        return { thread_id: id, run_id: runId, node: qaRetryRequested ? 'test_design' : 'coder', status: 'queued' };
      } finally { await lease.query('SELECT pg_advisory_unlock_all()'); lease.release(); }
    });
    writeJson(res, 202, result);
    return;
  }

  const ciMatch = /^\/threads\/([0-9a-f-]+)\/ci$/i.exec(url.pathname);
  if (method === 'POST' && ciMatch) {
    const threadId = ciMatch[1]!;
    await withCiThreadLock(threadId, async () => {
    const thread = await getThread(threadId);
    if (!thread) throw new HttpError(404, 'thread not found');
    const body = await readJson(req);
    const providers = new Set(['gitea', 'github', 'gitlab', 'jenkins', 'bitbucket', 'unknown']);
    const statuses = new Set(['queued', 'running', 'success', 'failure', 'canceled', 'unknown']);
    const provider = String(body['provider'] ?? 'unknown');
    const status = String(body['status'] ?? 'unknown');
    if (!providers.has(provider) || !statuses.has(status)) {
      throw new HttpError(400, 'provider or status is invalid');
    }
    const ciRun = {
      provider,
      external_id: String(body['external_id'] ?? '').slice(0, 256),
      workflow: String(body['workflow'] ?? '').slice(0, 256),
      status,
      conclusion: String(body['conclusion'] ?? '').slice(0, 128),
      branch: String(body['branch'] ?? '').slice(0, 256),
      commit_sha: String(body['commit_sha'] ?? '').slice(0, 128),
      run_url: String(body['run_url'] ?? '').slice(0, 2048),
      updated_at: String(body['updated_at'] ?? new Date().toISOString()).slice(0, 64),
    };
    const workflow = getWorkflowByGraphId(thread.graph_id);
    if (!workflow) throw new HttpError(404, `graph ${thread.graph_id} is not registered`);
    const before = await getSnapshot(threadId, thread);
    if (!jenkinsCallbackMatches(jenkinsDispatchConfig, safeStateValues(before), ciRun as CiRun)) {
      throw new HttpError(409, 'CI callback does not match the approved Jenkins job and immutable source');
    }
    const previous = safeStateValues(before)['ci_run'];
    const mergedCiRun = mergeCiRun(
      previous && typeof previous === 'object' && !Array.isArray(previous) ? previous as CiRun : null,
      ciRun as CiRun,
    );
    await workflow.graph.updateState(
      { configurable: { thread_id: threadId } },
      {
        ci_run: mergedCiRun,
        delivery_status: mergedCiRun.status === 'success' && typeof safeStateValues(before)['pr_url'] === 'string'
          && String(safeStateValues(before)['pr_url']).trim()
          ? 'pr_created'
          : deliveryStatusForCi(mergedCiRun.status),
      },
    );
    await pool.query('UPDATE argus_langgraph_threads SET updated_at = NOW() WHERE thread_id = $1', [threadId]);
    const after = await getSnapshot(threadId);
    await reconcileDurableCiStatus(threadId, mergedCiRun, after);
    await syncThreadA2aTask(threadId);
    writeJson(res, 200, { ok: true, thread_id: threadId, ci_run: mergedCiRun });
    });
    return;
  }

  const gitApprovalMatch = /^\/threads\/([0-9a-f-]+)\/git-approval-context$/i.exec(url.pathname);
  if (method === 'GET' && gitApprovalMatch) {
    const id = gitApprovalMatch[1]!;
    const thread = await getThread(id);
    if (!thread) throw new HttpError(404, 'thread not found');
    const snapshot = await getSnapshot(id, thread);
    const values = snapshot?.values ?? {};
    if (!isGitBrokerCodingGraph(thread.graph_id) || !(values['bitbucket_creds'] as { reference?: unknown } | undefined)?.reference) {
      writeJson(res, 200, { broker: false }); return;
    }
    const stage = await pendingGitApprovalStage(thread, snapshot);
    if (!stage) throw new HttpError(409, 'No pending Git approval');
    writeJson(res, 200, { broker: true, threadId: id, checkpointId: checkpointId(snapshot), stage,
      executionGrant: values['argus_execution_grant'], principal: thread.metadata['execution_principal'],
      grantId: thread.metadata['execution_grant_id'], ticketId: String(values['ticket_id'] ?? ''),
      branch: String(values['branch_name'] ?? ''), commitSha: String(values['commit_sha'] ?? ''),
      retryCount: values['retry_count'] ?? 0 });
    return;
  }

  const runMatch = /^\/threads\/([0-9a-f-]+)\/runs$/i.exec(url.pathname);
  if (method === 'POST' && runMatch) {
    const body = await readJson(req);
    const thread = await getThread(runMatch[1]!);
    if (!thread) throw new HttpError(404, 'thread not found');
    if (body['assistant_id'] !== undefined && body['assistant_id'] !== thread.graph_id) {
      throw new HttpError(400, `unknown assistant '${String(body['assistant_id'])}'`);
    }
    const command = body['command'];
    let kind: RunKind = 'input';
    let payload: JsonObject = { input: body['input'] ?? {} };
    if (body['retry_failed'] === true) {
      throw new CheckpointRetryError('Use the governed checkpoint-retry action with a fresh execution grant.');
    } else if (command && typeof command === 'object' && !Array.isArray(command)
      && Object.prototype.hasOwnProperty.call(command, 'resume')) {
      kind = 'resume';
      payload = { resume: (command as JsonObject)['resume'], ...(body['gitApproval'] ? { gitApproval: body['gitApproval'] } : {}) };
    }
    const runId = await enqueueRun(runMatch[1]!, kind, payload);
    writeJson(res, 200, { run_id: runId, thread_id: runMatch[1], status: 'queued' });
    return;
  }

  const threadMatch = /^\/threads\/([0-9a-f-]+)$/i.exec(url.pathname);
  if (method === 'GET' && threadMatch) {
    writeJson(res, 200, await threadState(threadMatch[1]!));
    return;
  }
  if (method === 'DELETE' && threadMatch) {
    const threadId = threadMatch[1]!;
    const row = await getThread(threadId);
    if (!row) throw new HttpError(404, 'thread not found');
    if (row.status === 'queued' || row.status === 'running' || row.status === 'canceling') {
      throw new HttpError(409, 'cannot delete an active thread');
    }
    await pool.query('DELETE FROM argus_langgraph_threads WHERE thread_id = $1', [threadId]);
    await codingCheckpointer.deleteThread(threadId);
    writeJson(res, 200, { ok: true });
    return;
  }

  throw new HttpError(404, 'route not found');
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch(error => {
    if (error instanceof A2aProtocolError) {
      if (!res.headersSent) writeA2aJson(res, error.status, a2aErrorBody(error.status, error.reason, error.message));
      else res.end();
      return;
    }
    const status = error instanceof HttpError || error instanceof CheckpointRetryError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'internal error';
    if (status >= 500) log('error', 'request failed', { method: req.method, path: req.url, error: message });
    if (!res.headersSent) writeJson(res, status, { error: message });
    else res.end();
  });
});

async function shutdown(signal: string): Promise<void> {
  log('info', 'runtime shutting down', { signal, active_runs: activeRuns.size });
  server.close();
  if (jenkinsDispatchTimer) clearInterval(jenkinsDispatchTimer);
  await Promise.race([
    Promise.allSettled([...activeRuns.values(), ...(jenkinsSweep ? [jenkinsSweep] : [])]),
    new Promise(resolve => setTimeout(resolve, 8_000)),
  ]);
  await pool.end();
  await workspaceLeasePool.end();
  await codingCheckpointer.end();
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production' && !RUNTIME_SECRET) {
    throw new Error('WORKSPACE_SECRET is required in production');
  }
  await setupRuntimeTables();
  await setupVisualWorkflowTables();
  await loadVisualWorkflows();
  await setupA2aTables(pool);
  await recoverRuns();
  await reconcileCompletedWorkflowOutcomes();
  await reconcileNonTerminalA2aTasks();
  server.listen(PORT, '0.0.0.0', () => {
    log('info', 'runtime ready', {
      port: PORT,
      graph_ids: listRegisteredWorkflows().map(workflow => workflow.graphId),
      persistence: 'postgres',
    });
  });
  if (jenkinsDispatchConfig) {
    const sweep = () => {
      if (jenkinsSweep) return;
      jenkinsSweep = reconcilePendingJenkins().catch(() => log('warn', 'Jenkins dispatch sweep unavailable'))
        .finally(() => { jenkinsSweep = undefined; });
    };
    jenkinsDispatchTimer = setInterval(sweep, 15_000);
    jenkinsDispatchTimer.unref();
    sweep();
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void main().catch(error => {
  log('error', 'runtime startup failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
