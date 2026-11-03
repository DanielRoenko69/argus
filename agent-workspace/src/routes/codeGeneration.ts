import { Router } from 'express';
import { mkdir, open, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseQaRequest, qaSnapshot, type QaRequest } from './qaTests.js';
import { snapshotPathAllowed } from './technicalExperiment.js';
import { projectSnapshotPathAllowed, assertProjectSnapshotContent } from './projectSnapshot.js';
import { stackBroker, stackPublicError } from './stackTests.js';
import { codegenHash as hash, codegenBytesHash, codegenScope, parseCodegenCancel, parseCodegenRequest, parseCodegenFiles, validateCodegenReceipt, type CodegenRequest, type CodegenReceipt } from './codeGenerationContract.js';
import { importCodegenFiles } from './codeGenerationImport.js';
import { CODEGEN_STORE, assertCodegenNotCanceled, cancelCodegen } from './codeGenerationCancellation.js';
import { CodegenExecutionError, parseCodegenFailure } from './codeGenerationContract.js';
import { assertCodegenImportIdle } from './codeGenerationBarrier.js';

type Request = CodegenRequest & { threadId: string; workspaceRoot: string; allowedPaths: string[] };
export function codegenPublicError(error: unknown): string {
  const broker = stackPublicError(error);
  if (broker !== 'stack_unavailable_no_replay') return 'codegen_' + broker;
  return error instanceof Error && /^codegen_[a-z_]+$/.test(error.message)
    ? error.message : 'codegen_unavailable_no_replay';
}
export function parseWorkspaceCodegen(value: unknown): Request {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('codegen_request_invalid');
  const { threadId, workspaceRoot, allowedPaths, ...input } = value as Request;
  const scope = codegenScope(allowedPaths), parsed = parseCodegenRequest(input, scope);
  parseQaRequest({ action: 'inspect', threadId, workspaceRoot, baseCommitSha: parsed.baseCommitSha, basisSha256: parsed.basisSha256 });
  return { ...parsed, threadId, workspaceRoot, allowedPaths: scope };
}
async function durable(file: string, value: unknown) {
  const fd = await open(file, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  const dir = await open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
// No async scheduling between the final whole-source check and the import.
export function sourceNow(r: Pick<Request, 'workspaceRoot' | 'baseCommitSha' | 'executionMode'>, stagedPaths: readonly string[] = []) {
  const root = r.workspaceRoot;
  if (realpathSync(root) !== root) throw Error('codegen_unsafe_checkout');
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (git(['rev-parse', 'HEAD']).trim() !== r.baseCommitSha) throw Error('codegen_source_changed');
  // Internal-only exclusions supplied synchronously by the importer. They are
  // never accepted in a request or persisted as a broader snapshot policy.
  const staged = new Set(stagedPaths);
  const names = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')
    .filter(name => name && !staged.has(path.join(root, name))))].sort();
  if (names.length > 3000) throw Error('codegen_source_limit');
  const manifest: Array<[string, string]> = []; let size = 0;
  const deadline = Date.now() + 30000;
  for (const name of names) {
    if (Date.now() > deadline) throw Error('codegen_source_limit');
    if (!(r.executionMode === 'workspace-session-v1' ? projectSnapshotPathAllowed : snapshotPathAllowed)(name, '100644')) continue;
    const full = path.join(root, name); let st;
    try { st = lstatSync(full); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    if (r.executionMode === 'workspace-session-v1' && st.isSymbolicLink()) continue;
    if (!st.isFile() || st.nlink !== 1 || realpathSync(full) !== full) throw Error('codegen_unsafe_source');
    size += st.size;
    if (st.size > 16 * 1024 * 1024 || size > 128 * 1024 * 1024) throw Error('codegen_source_limit');
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = fstatSync(fd);
      if (actual.ino !== st.ino || actual.dev !== st.dev || actual.size !== st.size || actual.nlink !== 1) throw Error('codegen_source_changed');
      const bytes = readFileSync(fd);
      if (bytes.length !== st.size) throw Error('codegen_source_changed');
      if (r.executionMode === 'workspace-session-v1') assertProjectSnapshotContent(name, bytes);
      manifest.push([name, codegenBytesHash(bytes)]);
    } finally { closeSync(fd); }
  }
  return hash([r.baseCommitSha, manifest]);
}
let active = false;
async function absent(file: string) {
  try { await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw Error('codegen_recovery_already_consumed');
}
/** Inspect only completed generation + a wholly unapplied, source-bound import.
 * The controller lookup cannot execute, install, rebuild or create a worker. */
async function recoveryEvidence(r: Request, store: string, post: typeof stackBroker) {
  if (r.executionMode !== 'workspace-session-v1') throw Error('codegen_recovery_unavailable');
  assertCodegenNotCanceled(r.threadId, store); assertCodegenImportIdle();
  const requestSha256 = hash(r), job = path.join(store, r.threadId, requestSha256);
  for (const name of ['result.json', 'failure.json', 'recovery-intent.json']) await absent(path.join(job, name));
  const intent = JSON.parse(await readFile(path.join(job, 'intent.json'), 'utf8'));
  const application = JSON.parse(await readFile(path.join(job, 'application-intent.json'), 'utf8'));
  if (intent.requestSha256 !== requestSha256 || intent.sourceSha256 !== r.sourceSha256
    || application.requestSha256 !== requestSha256) throw Error('codegen_recovery_binding_changed');
  const source = { sourceFiles: [] as Array<{ path: string; content: string }>, projectFiles: true };
  const snapshot = await qaSnapshot({ action: 'inspect', threadId: r.threadId, workspaceRoot: r.workspaceRoot,
    baseCommitSha: r.baseCommitSha, basisSha256: r.basisSha256 }, undefined, source);
  if (snapshot.sourceSha256 !== r.sourceSha256) throw Error('codegen_source_changed');
  const broker = { version: 1, threadId: r.threadId, basisSha256: r.basisSha256, sourceSha256: r.sourceSha256,
    baseCommitSha: r.baseCommitSha, plan: r.plan, source: source.sourceFiles, executionMode: r.executionMode };
  const raw = await post('generate-result', broker);
  if (raw?.requestSha256 !== hash(['codegen-v1', broker]) || raw.sourceSha256 !== r.sourceSha256
    || raw.basisSha256 !== r.basisSha256 || raw.planSha256 !== hash(r.plan) || raw.executionMode !== r.executionMode
    || !/^sha256:[a-f0-9]{64}$/.test(raw.baseImage) || raw.status !== 'completed' || raw.exitCode !== 0 || raw.phase !== 'generate')
    throw Error('codegen_recovery_invalid_proof');
  const files = parseCodegenFiles(application.files, r.plan), completed = parseCodegenFiles(raw.outputs, r.plan);
  if (hash(files) !== hash(completed)) throw Error('codegen_recovery_binding_changed');
  const originals = new Map(source.sourceFiles.map(f => [f.path, f.content]));
  if (hash(application.originals) !== hash(files.map(f => ({ path: f.path, content: originals.get(f.path) ?? null }))))
    throw Error('codegen_recovery_binding_changed');
  for (const file of files) {
    const old = originals.get(file.path);
    if (file.beforeSha256 !== (old === undefined ? null : codegenBytesHash(Buffer.from(old, 'base64')))) throw Error('codegen_source_changed');
  }
  const recoveryDigest = hash(['codegen-import-recovery-v1', requestSha256, application, raw]);
  return { job, raw, source, files, recoveryDigest, requestSha256 };
}
export async function previewCodegenRecovery(value: unknown, store = CODEGEN_STORE, post = stackBroker) {
  const r = parseWorkspaceCodegen(value);
  if (active) throw Error('codegen_busy'); active = true;
  try {
    const e = await recoveryEvidence(r, store, post);
    return { version: 1, recoveryDigest: e.recoveryDigest, requestSha256: e.requestSha256,
      sourceSha256: r.sourceSha256, planSha256: hash(r.plan), brokerRequestSha256: e.raw.requestSha256 };
  } finally { active = false; }
}
/** Explicit, one-shot operator continuation. Never used by ordinary generate. */
export async function recoverCodegenImport(value: unknown, recoveryDigest: string, store = CODEGEN_STORE, post = stackBroker): Promise<CodegenReceipt> {
  const r = parseWorkspaceCodegen(value);
  if (!/^[a-f0-9]{64}$/.test(recoveryDigest)) throw Error('codegen_recovery_invalid_proof');
  if (active) throw Error('codegen_busy'); active = true;
  try {
    const e = await recoveryEvidence(r, store, post);
    if (e.recoveryDigest !== recoveryDigest) throw Error('codegen_recovery_binding_changed');
    await durable(path.join(e.job, 'recovery-intent.json'), { recoveryDigest, requestSha256: e.requestSha256 });
    importCodegenFiles(r.workspaceRoot, e.files, staged => {
      assertCodegenNotCanceled(r.threadId, store);
      if (sourceNow(r, staged) !== r.sourceSha256) throw Error('codegen_source_changed');
    });
    const manifest = new Map(e.source.sourceFiles.map(f => [f.path, codegenBytesHash(Buffer.from(f.content, 'base64'))]));
    for (const file of e.files) manifest.set(file.path, file.sha256);
    const resultSourceSha256 = hash([r.baseCommitSha, [...manifest].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
    if (sourceNow(r) !== resultSourceSha256) throw Error('codegen_import_incomplete');
    const result: CodegenReceipt = { version: 1, threadId: r.threadId, requestSha256: e.requestSha256,
      basisSha256: r.basisSha256, sourceSha256: r.sourceSha256, resultSourceSha256, planSha256: hash(r.plan),
      brokerRequestSha256: e.raw.requestSha256, baseImage: e.raw.baseImage, applied: true,
      outputs: e.files.map(({ content: _, ...file }) => file), finishedAt: new Date().toISOString(), executionMode: r.executionMode };
    await durable(path.join(e.job, 'result.json'), result);
    await durable(path.join(e.job, 'recovery-result.json'), { recoveryDigest, resultSha256: hash(result) });
    return result;
  } finally { active = false; }
}
export async function runCodeGeneration(value: unknown, store = CODEGEN_STORE, post = stackBroker): Promise<CodegenReceipt> {
  const r = parseWorkspaceCodegen(value);
  assertCodegenNotCanceled(r.threadId, store);
  if (active) throw Error('codegen_busy'); active = true;
  try {
    const requestSha256 = hash(r), job = path.join(store, r.threadId, requestSha256);
    const inspect: QaRequest = { action: 'inspect', threadId: r.threadId, workspaceRoot: r.workspaceRoot, baseCommitSha: r.baseCommitSha, basisSha256: r.basisSha256 };
    await mkdir(path.dirname(job), { recursive: true, mode: 0o700 });
    try { await mkdir(job, { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Keep the original bounded diagnostic on re-evaluation without dispatch.
      // An absent result/diagnostic still means uncertainty, never permission to run.
      let brokerError;
      try { brokerError = JSON.parse(await readFile(path.join(job, 'broker-error.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (brokerError?.requestSha256 === requestSha256 && typeof brokerError.code === 'string'
        && /^codegen_[a-z_]+$/.test(brokerError.code)) throw Error(brokerError.code);
      const receipt = validateCodegenReceipt(r, r.threadId, JSON.parse(await readFile(path.join(job, 'result.json'), 'utf8')));
      if (receipt.requestSha256 !== requestSha256 || sourceNow(r) !== receipt.resultSourceSha256) throw Error('codegen_source_changed');
      return receipt; // A missing result never reapplies files or repeats the generator.
    }
    const source = { sourceFiles: [] as Array<{ path: string; content: string }>, projectFiles: r.executionMode === 'workspace-session-v1' };
    const before = await qaSnapshot(inspect, undefined, source);
    if (before.sourceSha256 !== r.sourceSha256) throw Error('codegen_source_changed');
    // New generated files must participate in the same source snapshot. Never
    // write an ignored artifact and discover only afterwards that it is hidden.
    for (const name of r.plan.outputPaths) {
      if (!snapshotPathAllowed(name, '100644')) throw Error('codegen_scope_invalid');
      if (!source.sourceFiles.some(f => f.path === name)) {
        try {
          execFileSync('git', ['-c', 'core.fsmonitor=false', 'check-ignore', '-q', '--', name], { cwd: r.workspaceRoot, timeout: 10000, stdio: 'ignore' });
          throw Error('codegen_ignored_output');
        } catch (e) { if ((e as { status?: number }).status !== 1) throw e; }
      }
    }
    await durable(path.join(job, 'intent.json'), { requestSha256, sourceSha256: r.sourceSha256 });
    const brokerRequest = { version: 1, threadId: r.threadId, basisSha256: r.basisSha256, sourceSha256: r.sourceSha256,
      baseCommitSha: r.baseCommitSha, plan: r.plan, source: source.sourceFiles,
      ...(r.executionMode ? { executionMode: r.executionMode } : {}) };
    let raw;
    try { raw = await post('generate', brokerRequest); }
    catch (error) {
      const code = codegenPublicError(error);
      await durable(path.join(job, 'broker-error.json'), { version: 1, requestSha256,
        brokerRequestSha256: hash(['codegen-v1', brokerRequest]), code });
      throw Error(code);
    }
    assertCodegenNotCanceled(r.threadId, store);
    if (raw?.requestSha256 !== hash(['codegen-v1', brokerRequest]) || raw.sourceSha256 !== r.sourceSha256 || raw.planSha256 !== hash(r.plan)
      || raw.executionMode !== r.executionMode
      || !/^sha256:[a-f0-9]{64}$/.test(raw.baseImage))
      throw Error('codegen_generation_failed_no_import');
    if (raw.status !== 'completed' || raw.exitCode !== 0 || raw.phase !== 'generate') {
      const failure = parseCodegenFailure({ phase: raw.phase, status: raw.status, exitCode: raw.exitCode,
        stdout: raw.stdout, stderr: raw.stderr, durationMs: raw.durationMs, outputSha256: hash([raw.stdout, raw.stderr]) });
      await durable(path.join(job, 'failure.json'), failure);
      throw new CodegenExecutionError(failure);
    }
    const files = parseCodegenFiles(raw.outputs, r.plan);
    const originals = new Map(source.sourceFiles.map(f => [f.path, f.content]));
    for (const file of files) {
      const original = originals.get(file.path);
      if (file.beforeSha256 !== (original === undefined ? null : codegenBytesHash(Buffer.from(original, 'base64')))) throw Error('codegen_original_changed');
    }
    await durable(path.join(job, 'application-intent.json'), { requestSha256, files, originals: files.map(f => ({ path: f.path, content: originals.get(f.path) ?? null })) });
    const expectedSource = (stagedPaths?: readonly string[]) => { assertCodegenNotCanceled(r.threadId, store); if (sourceNow(r, stagedPaths) !== r.sourceSha256) throw Error('codegen_source_changed'); };
    importCodegenFiles(r.workspaceRoot, files, expectedSource);
    const expectedFiles = new Map(source.sourceFiles.map(f => [f.path, codegenBytesHash(Buffer.from(f.content, 'base64'))]));
    for (const file of files) expectedFiles.set(file.path, file.sha256);
    const resultSourceSha256 = hash([r.baseCommitSha, [...expectedFiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
    if (sourceNow(r) !== resultSourceSha256) throw Error('codegen_import_incomplete');
    const result: CodegenReceipt = { version: 1, threadId: r.threadId, requestSha256, basisSha256: r.basisSha256,
      sourceSha256: r.sourceSha256, resultSourceSha256, planSha256: hash(r.plan), brokerRequestSha256: raw.requestSha256,
      baseImage: raw.baseImage, applied: true, outputs: files.map(({ content: _, ...f }) => f), finishedAt: new Date().toISOString(),
      ...(r.executionMode ? { executionMode: r.executionMode } : {}) };
    await durable(path.join(job, 'result.json'), result);
    return result;
  } finally { active = false; }
}
export const codeGenerationRouter = Router();
codeGenerationRouter.post(['/recovery-preview', '/recover'], async (req, res) => {
  if (process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] !== 'true' || process.env['ARGUS_CODE_GENERATION_ENABLED'] !== 'true'
    || process.env['ARGUS_GENERAL_STACKS_ENABLED'] !== 'true') { res.status(503).json({ code: 'codegen_disabled' }); return; }
  try {
    if (req.path === '/recovery-preview') res.json(await previewCodegenRecovery(req.body));
    else {
      const { recoveryDigest, ...input } = req.body ?? {};
      res.json(await recoverCodegenImport(input, recoveryDigest));
    }
  } catch (error) { res.status(409).json({ code: error instanceof Error && /^codegen_[a-z_]+$/.test(error.message)
    ? error.message : 'codegen_recovery_unavailable' }); }
});
codeGenerationRouter.post('/', async (req, res) => {
  if (req.body?.executionMode && process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] !== 'true') { res.status(503).json({ code: 'stack_session_disabled' }); return; }
  if (process.env['ARGUS_CODE_GENERATION_ENABLED'] !== 'true' || process.env['ARGUS_GENERAL_STACKS_ENABLED'] !== 'true') { res.status(503).json({ code: 'codegen_disabled' }); return; }
  try {
    if (req.body?.action === 'cancel') {
      const { allowedPaths, threadId, workspaceRoot, ...body } = req.body;
      codegenScope(allowedPaths);
      const input = parseCodegenCancel(body);
      parseQaRequest({ ...input, threadId, workspaceRoot, action: 'inspect' });
      await cancelCodegen(threadId);
      res.json(await stackBroker('cancel', { threadId }));
    } else res.json(await runCodeGeneration(req.body));
  }
  catch (e) { const code = codegenPublicError(e);
    res.status(409).json({ code, ...(e instanceof CodegenExecutionError ? { failure: e.failure } : {}) }); }
});
