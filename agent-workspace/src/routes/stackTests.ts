import { Router } from 'express';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseQaRequest, qaSnapshot, qaPytestProbe, parseQaPytestEvidence, type QaRequest } from './qaTests.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Plan = { version: 1; summary: string; setup: string; start: string; test: string; python: string };
type StackRequest = Omit<QaRequest, 'action'> & { action: 'inspect' | 'project' | 'run' | 'cancel'; stackPlan?: Plan; preparedImage?: string;
  executionMode?: 'workspace-session-v1'; preparedSession?: string };
export function parseStackRequest(value: unknown): StackRequest {
  const r = value as StackRequest;
  if (!r || typeof r !== 'object' || !['inspect', 'project', 'run', 'cancel'].includes(r.action)) throw new Error('stack_invalid_request');
  if (r.executionMode !== undefined && r.executionMode !== 'workspace-session-v1') throw new Error('stack_invalid_request');
  const allowed = ['action', 'threadId', 'workspaceRoot', 'baseCommitSha', 'basisSha256', 'executionMode',
    ...(['project', 'run'].includes(r.action) ? ['sourceSha256', 'stackPlan'] : []), ...(r.action === 'run' ? ['files', 'preparedImage', 'preparedSession'] : [])];
  if (Object.keys(r).some(k => !allowed.includes(k))) throw new Error('stack_invalid_request');
  parseQaRequest({ action: r.action === 'run' ? 'run' : 'inspect', threadId: r.threadId, workspaceRoot: r.workspaceRoot,
    baseCommitSha: r.baseCommitSha, basisSha256: r.basisSha256,
    ...(r.action === 'run' ? { sourceSha256: r.sourceSha256, files: r.files } : {}) });
  if (r.action === 'project' || r.action === 'run') {
    const p = r.stackPlan;
    if (!p || Object.keys(p).sort().join(',') !== 'python,setup,start,summary,test,version' || p.version !== 1
      || ['summary', 'setup', 'start', 'test', 'python'].some(k => typeof p[k as keyof Plan] !== 'string'
        || Buffer.byteLength(String(p[k as keyof Plan])) > (k === 'summary' ? 2000 : 24000) || String(p[k as keyof Plan]).includes('\0'))
      || !p.summary.trim() || !p.setup.trim() || !p.test.trim() || !/^\/(?:[A-Za-z0-9_.+-]+\/)*[A-Za-z0-9_.+-]+$/.test(p.python)
      || p.python.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(r.sourceSha256 ?? '')
      || (r.action === 'run' && (r.executionMode ? !/^[a-f0-9]{64}$/.test(r.preparedSession ?? '') || r.preparedImage !== undefined
        : !/^sha256:[a-f0-9]{64}$/.test(r.preparedImage ?? '') || r.preparedSession !== undefined))) throw new Error('stack_invalid_request');
  }
  return r;
}
function snapshotRequest(r: StackRequest): QaRequest {
  return { action: 'inspect', threadId: r.threadId, workspaceRoot: r.workspaceRoot, baseCommitSha: r.baseCommitSha, basisSha256: r.basisSha256 };
}
export const STACK_BROKER_TIMEOUT_MS = 2_520_000; // setup 900s + snapshot 900s + tests 600s + 120s control grace
const snapshotErrors = new Set(['stack_snapshot_timeout_no_replay', 'stack_snapshot_unavailable_no_replay', 'stack_snapshot_worker_not_stopped', 'stack_snapshot_reconciliation_required',
  'stack_session_disabled', 'stack_session_capacity', 'stack_session_capacity_config_invalid', 'stack_session_missing', 'stack_session_binding_changed', 'stack_session_evidence_stale',
  'stack_session_still_running', 'stack_session_sync_failed', 'stack_session_marker_invalid', 'stack_interrupted_no_replay', 'stack_session_stop_unconfirmed',
  'stack_database_policy_required', 'stack_database_binding_changed', 'stack_database_unavailable', 'stack_database_stop_unconfirmed', 'stack_database_secret_in_output']);
export class StackBrokerError extends Error {}
export function parseStackBrokerResponse(status: number | undefined, text: string): unknown {
  if (status === 200) return JSON.parse(text);
  let value: { error?: unknown } | null = null;
  try { value = JSON.parse(text); } catch { /* never expose malformed upstream output */ }
  throw new StackBrokerError(typeof value?.error === 'string' && snapshotErrors.has(value.error)
    ? value.error : 'stack_unavailable_no_replay');
}
export function stackPublicError(error: unknown): string {
  return error instanceof StackBrokerError && snapshotErrors.has(error.message) ? error.message : 'stack_unavailable_no_replay';
}
export async function stackBroker(action: 'run' | 'cancel' | 'generate' | 'generate-result' | 'recovery-preview', input: unknown) {
  const secret = (await readFile('/run/secrets/stack_runner', 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('stack_unavailable');
  const body = JSON.stringify(input);
  return new Promise<any>((resolve, reject) => {
    const request = httpRequest(`http://stack-runner:8093/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-stack-secret': secret } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > (action.startsWith('generate') ? 6 * 1024 * 1024 : 128000)) request.destroy(new Error('stack_receipt_limit')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(parseStackBrokerResponse(response.statusCode, Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('stack_timeout_no_replay')),
      action === 'cancel' || action === 'generate-result' ? 55000 : action === 'generate' ? 1740000 : STACK_BROKER_TIMEOUT_MS);
    request.once('close', () => clearTimeout(timer)); request.once('error', reject); request.end(body);
  });
}
async function durable(file: string, data: unknown) {
  const fd = await open(file, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(data)); await fd.sync(); } finally { await fd.close(); }
  const dir = await open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
const active = new Set<string>();
export function stackBrokerRequest(r: StackRequest, sourceFiles: Array<{ path: string; content: string }>) {
  return { version: 1, threadId: r.threadId, basisSha256: r.basisSha256,
    sourceSha256: r.sourceSha256, baseCommitSha: r.baseCommitSha, plan: r.stackPlan!,
    phase: r.action === 'run' ? 'qa' : 'project', source: sourceFiles,
    probe: r.action === 'run' ? "import sys\nsys.path[:0] = ['/repo/src', '/repo']\n" + qaPytestProbe(r.files!) : '', preparedImage: r.preparedImage ?? null,
    ...(r.executionMode ? { executionMode: r.executionMode, preparedSession: r.preparedSession ?? null } : {}) };
}
export function validateStackRecoveryProof(r: StackRequest, brokerRequest: unknown, proof: any) {
  if (!proof || Object.keys(proof).sort().join(',') !== 'containerId,planSha256,preparedImage,recoverySha256,requestSha256,sourceSha256,testsStarted,version'
    || proof.version !== 1 || proof.testsStarted !== false || proof.requestSha256 !== hash(brokerRequest)
    || proof.sourceSha256 !== r.sourceSha256 || proof.planSha256 !== hash(r.stackPlan)
    || !/^sha256:[a-f0-9]{64}$/.test(proof.preparedImage) || !/^[a-f0-9]{64}$/.test(proof.containerId)
    || !/^[a-f0-9]{64}$/.test(proof.recoverySha256)) throw new Error('stack_recovery_invalid_proof');
  return proof as { recoverySha256: string; requestSha256: string; sourceSha256: string; planSha256: string; preparedImage: string };
}
async function absent(file: string) {
  try { await readFile(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw new Error('stack_recovery_already_consumed');
}
export async function stackRecoveryPreview(input: unknown, store = '/runtime/technical-experiments/stack-tests', post = stackBroker) {
  const r = parseStackRequest(input);
  if (r.action !== 'project' || r.executionMode || active.size) throw new Error('stack_recovery_unavailable');
  const job = path.join(store, r.threadId, hash(r));
  await absent(path.join(job, 'result.json'));
  await absent(path.join(job, 'recovery-started.json'));
  const intent = JSON.parse(await readFile(path.join(job, 'intent.json'), 'utf8'));
  if (intent.requestSha256 !== hash(r) || intent.sourceSha256 !== r.sourceSha256) throw new Error('stack_recovery_binding_changed');
  const internal = { sourceFiles: [] as Array<{ path: string; content: string }> };
  const snapshot = await qaSnapshot(snapshotRequest(r), undefined, internal);
  if (snapshot.sourceSha256 !== r.sourceSha256) throw new Error('stack_source_changed');
  const broker = stackBrokerRequest(r, internal.sourceFiles);
  return validateStackRecoveryProof(r, broker, await post('recovery-preview', broker));
}
/** Keep controller causes intact even when the public phase is preparation_failed. */
export function stackExecutionMetadata(raw: { status: string; outputCapture?: unknown; testStarted?: unknown }) {
  if (!['completed', 'failed', 'timeout', 'output_limit', 'canceled', 'interrupted', 'disk_limit'].includes(raw.status))
    throw new Error('stack_invalid_receipt');
  const capture = raw.outputCapture as Record<string, unknown> | undefined;
  if (capture !== undefined && (!capture || Object.keys(capture).sort().join(',') !== 'stderrBytes,stderrTruncated,stdoutBytes,stdoutTruncated,version'
    || capture.version !== 1 || !['stdoutBytes', 'stderrBytes'].every(k => Number.isSafeInteger(capture[k]) && Number(capture[k]) >= 0)
    || !['stdoutTruncated', 'stderrTruncated'].every(k => typeof capture[k] === 'boolean'))) throw new Error('stack_invalid_receipt');
  if (raw.testStarted !== undefined && typeof raw.testStarted !== 'boolean') throw new Error('stack_invalid_receipt');
  return { executionStatus: raw.status, ...(capture ? { outputCapture: capture } : {}),
    ...(typeof raw.testStarted === 'boolean' ? { testStarted: raw.testStarted } : {}) };
}
export async function runStackTests(r: StackRequest, store = '/runtime/technical-experiments/stack-tests', post = stackBroker) {
  r = parseStackRequest(r);
  if (r.action === 'cancel') return post('cancel', { threadId: r.threadId });
  if (r.action === 'inspect') return qaSnapshot(snapshotRequest(r), undefined, { projectFiles: r.executionMode === 'workspace-session-v1' });
  if (active.size) throw new Error('stack_busy');
  active.add(r.threadId);
  try {
    const requestSha256 = hash(r), job = path.join(store, r.threadId, requestSha256);
    const internal = { sourceFiles: [] as Array<{ path: string; content: string }>, projectFiles: r.executionMode === 'workspace-session-v1' };
    const snapshot = await qaSnapshot(snapshotRequest(r), undefined, internal);
    if (snapshot.sourceSha256 !== r.sourceSha256) throw new Error('stack_source_changed');
    await mkdir(path.dirname(job), { recursive: true, mode: 0o700 });
    try { await mkdir(job, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { return JSON.parse(await readFile(path.join(job, 'result.json'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      // Only a separately operator-reconciled, pre-test image may continue.
      // Keep the original intent; reserve once before any dispatch.
      if (r.action !== 'project' || r.executionMode) throw new Error('stack_unavailable_no_replay');
      await absent(path.join(job, 'recovery-started.json'));
      const intent = JSON.parse(await readFile(path.join(job, 'intent.json'), 'utf8'));
      if (intent.requestSha256 !== requestSha256 || intent.sourceSha256 !== r.sourceSha256) throw new Error('stack_recovery_binding_changed');
      const broker = stackBrokerRequest(r, internal.sourceFiles);
      const proof = validateStackRecoveryProof(r, broker, await post('recovery-preview', broker));
      await durable(path.join(job, 'recovery-started.json'), proof);
    }
    try { await durable(path.join(job, 'intent.json'), { requestSha256, sourceSha256: r.sourceSha256 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const brokerRequest = stackBrokerRequest(r, internal.sourceFiles);
    const raw = await post('run', brokerRequest);
    if (r.executionMode ? raw.executionMode !== r.executionMode || !/^[a-f0-9]{64}$/.test(raw.sessionId)
      || raw.preparedImage !== null || !(raw.preparedSession === null || /^[a-f0-9]{64}$/.test(raw.preparedSession))
      : raw.executionMode !== undefined || raw.preparedSession !== undefined || raw.sessionId !== undefined) throw new Error('stack_invalid_receipt');
    const db = raw.workspaceDatabase;
    if (db !== undefined && (!r.executionMode || !db || typeof db !== 'object' || Array.isArray(db)
      || Object.keys(db).sort().join(',') !== 'engine,reset,scopeSha256,serverMajor,version'
      || db.version !== 1 || db.engine !== 'postgresql' || db.reset !== 'before-phase'
      || !Number.isInteger(db.serverMajor) || db.serverMajor < 16 || db.serverMajor > 99
      || !/^[a-f0-9]{64}$/.test(db.scopeSha256))) throw new Error('stack_invalid_receipt');
    if (raw.requestSha256 !== hash(brokerRequest) || raw.sourceSha256 !== r.sourceSha256 || raw.planSha256 !== hash(r.stackPlan)
      || !['setup', 'qa', 'project'].includes(raw.phase) || !/^sha256:[a-f0-9]{64}$/.test(raw.baseImage)
      || (raw.preparedImage !== null && !/^sha256:[a-f0-9]{64}$/.test(raw.preparedImage))
      || !['completed', 'failed', 'timeout', 'output_limit', 'canceled', 'interrupted', 'disk_limit'].includes(raw.status)
      || ![raw.stdout, raw.stderr].every(v => typeof v === 'string' && Buffer.byteLength(v) <= 32768)
      || !Number.isFinite(raw.durationMs) || (raw.exitCode !== null && !Number.isInteger(raw.exitCode))) throw new Error('stack_invalid_receipt');
    if ((await qaSnapshot(snapshotRequest(r), undefined, { projectFiles: r.executionMode === 'workspace-session-v1' })).sourceSha256 !== r.sourceSha256) throw new Error('stack_source_changed');
    const metadata = stackExecutionMetadata(raw);
    const started = raw.phase !== 'setup' && metadata.testStarted !== false;
    if (raw.phase === 'setup' && metadata.testStarted === true) throw new Error('stack_invalid_receipt');
    let evidence = { passed: false, assertionFailed: false, collected: 0, nodes: [] as string[], missingModules: [] as string[] };
    if (started && r.action === 'run' && raw.phase === 'qa' && ['completed', 'failed'].includes(raw.status)) {
      try { evidence = parseQaPytestEvidence(raw.stdout, r.files!); } catch { /* invalid evidence cannot pass */ }
    }
    if (raw.phase === 'qa' && raw.status === 'completed'
      && (metadata.outputCapture?.stdoutTruncated || metadata.outputCapture?.stderrTruncated)) throw new Error('stack_incomplete_qa_evidence');
    const status = !started ? 'preparation_failed' : ['interrupted', 'disk_limit'].includes(raw.status) ? 'failed' : raw.status;
    const result = { version: 1, threadId: r.threadId, basisSha256: r.basisSha256, sourceSha256: r.sourceSha256,
      testSha256: hash(r.action === 'run' ? r.files : r.stackPlan!.test), requestSha256, profile: r.executionMode ?? 'stack-container-v1',
      status, exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr, durationMs: raw.durationMs,
      stackEnvironment: { version: 1, planSha256: raw.planSha256, baseImage: raw.baseImage, preparedImage: raw.preparedImage,
        phase: raw.phase, brokerRequestSha256: raw.requestSha256, ...metadata,
        ...(db ? { workspaceDatabase: db } : {}),
        ...(r.executionMode ? { executionMode: r.executionMode, sessionId: raw.sessionId, preparedSession: raw.preparedSession } : {}) }, executionStarted: started,
      ...evidence, passed: status === 'completed' && raw.exitCode === 0 && (r.action === 'project' || evidence.passed),
      assertionFailed: status === 'failed' && raw.exitCode === 1 && evidence.assertionFailed,
      outputSha256: hash([raw.stdout, raw.stderr]), finishedAt: new Date().toISOString() };
    await durable(path.join(job, 'result.pending.json'), result);
    await rename(path.join(job, 'result.pending.json'), path.join(job, 'result.json'));
    return result;
  } finally { active.delete(r.threadId); }
}
export const stackTestsRouter = Router();
stackTestsRouter.post('/recovery-preview', async (req, res) => {
  if (process.env['ARGUS_GENERAL_STACKS_ENABLED'] !== 'true') { res.status(503).json({ error: 'stack_disabled' }); return; }
  try { res.json(await stackRecoveryPreview(req.body)); }
  catch { res.status(409).json({ error: 'stack_recovery_unavailable' }); }
});
stackTestsRouter.post('/', async (req, res) => {
  if (process.env['ARGUS_GENERAL_STACKS_ENABLED'] !== 'true') { res.status(503).json({ error: 'stack_disabled' }); return; }
  if (req.body?.executionMode && process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] !== 'true') { res.status(503).json({ error: 'stack_session_disabled' }); return; }
  try { res.json(await runStackTests(parseStackRequest(req.body))); }
  catch (error) { res.status(409).json({ error: stackPublicError(error) }); }
});
