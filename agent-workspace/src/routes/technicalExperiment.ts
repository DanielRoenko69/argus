import { Router } from 'express';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
const MiB = 1024 * 1024;
export function snapshotLimits(env: Record<string, string | undefined> = process.env) {
  const read = (name: string, fallback: number, maximum: number) => {
    const raw = env[name] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) {
      throw new Error(`Invalid ${name}: expected integer MiB within 1-${maximum}`);
    }
    return Number(raw) * MiB;
  };
  const snapshotFileBytes = read('ARGUS_SNAPSHOT_FILE_MIB', 16, 32);
  const snapshotBytes = read('ARGUS_SNAPSHOT_TOTAL_MIB', 128, 256);
  if (snapshotFileBytes > snapshotBytes) throw new Error('Snapshot file limit must not exceed total limit');
  return { snapshotFileBytes, snapshotBytes };
}
export const EXPERIMENT_LIMITS = { wallMs: 30_000, cpuSeconds: 20, memoryBytes: 512 * 1024 * 1024,
  outputBytes: 32_768, scriptBytes: 24_000, ...snapshotLimits(), snapshotFiles: 3000 } as const;
type PreparationReason = 'snapshot_file_size_limit' | 'snapshot_total_size_limit' | 'snapshot_file_count_limit';
export class SnapshotPreparationError extends Error {
  constructor(readonly reason: PreparationReason, readonly actual: number, readonly limit: number, readonly filePath?: string) { super(reason); }
}
export type ExperimentPreparationFailure = Pick<ExperimentReceipt, 'version' | 'threadId' | 'baseCommitSha' | 'basisSha256' | 'requestSha256' | 'scriptSha256' | 'limits'> & {
  status: 'preparation_failed'; executionStarted: false; reason: PreparationReason; actual: number; limit: number; filePath?: string;
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
export type ExperimentRequest = { threadId: string; workspaceRoot: string; baseCommitSha: string;
  basisSha256: string; requestSha256: string; script: string };
export type ExperimentReceipt = { version: 1; threadId: string; baseCommitSha: string; basisSha256: string;
  requestSha256: string; scriptSha256: string; snapshotSha256: string; profile: 'python-bwrap-v1';
  status: 'completed' | 'failed' | 'timeout' | 'output_limit' | 'canceled';
  exitCode: number | null; stdout: string; stderr: string; outputSha256: string;
  startedAt: string; finishedAt: string; durationMs: number; limits: typeof EXPERIMENT_LIMITS;
  files: number; excludedFiles: number; pythonVersion: string };

export function parseExperimentRequest(value: unknown): ExperimentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_experiment_request');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'baseCommitSha,basisSha256,requestSha256,script,threadId,workspaceRoot'
    || typeof r.threadId !== 'string' || !uuid.test(r.threadId)
    || typeof r.workspaceRoot !== 'string' || !/^\/workspace\/[A-Za-z0-9-]{1,600}$/.test(r.workspaceRoot)
    || typeof r.baseCommitSha !== 'string' || !/^[a-f0-9]{40}$/.test(r.baseCommitSha)
    || typeof r.basisSha256 !== 'string' || !hash.test(r.basisSha256)
    || typeof r.requestSha256 !== 'string' || !hash.test(r.requestSha256)
    || typeof r.script !== 'string' || !r.script.trim() || Buffer.byteLength(r.script) > EXPERIMENT_LIMITS.scriptBytes
    || r.script.includes('\0')) throw new Error('invalid_experiment_request');
  return r as ExperimentRequest;
}

// The job receives a copied committed tree, never a live workspace, .git,
// runtime home, service environment, Unix socket or host /proc mount.
export function snapshotPathAllowed(file: string, mode: string): boolean {
  return ['100644', '100755'].includes(mode) && file.length <= 400 && !file.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(file) && file.split('/').every(part => part && !part.startsWith('.'))
    && !file.split('/').some(part => ['node_modules', 'secrets', 'graphify-out', '__pycache__'].includes(part));
}
const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' };
async function git(root: string, args: string[], maxBuffer = 4 * 1024 * 1024) {
  return (await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: root, env: cleanEnv, timeout: 10_000, maxBuffer, encoding: 'buffer' })).stdout;
}
async function checkWorkspace(r: ExperimentRequest) {
  if (await realpath(r.workspaceRoot) !== r.workspaceRoot || !(await lstat(path.join(r.workspaceRoot, '.git'))).isDirectory()) {
    throw new Error('workspace_not_exact');
  }
  if ((await git(r.workspaceRoot, ['rev-parse', 'HEAD'])).toString().trim() !== r.baseCommitSha
    || (await git(r.workspaceRoot, ['status', '--porcelain', '--untracked-files=all'])).length) {
    throw new Error('workspace_changed');
  }
}
/** Read-only, whole-tree limit check before any job/intent or blob copy. */
export async function inspectExperimentSnapshot(r: ExperimentRequest) {
  await checkWorkspace(r);
  const entries = (await git(r.workspaceRoot, ['ls-tree', '-r', '-l', '-z', r.baseCommitSha])).toString().split('\0').filter(Boolean);
  return planSnapshot(entries);
}
export function planSnapshot(entries: string[], limits = EXPERIMENT_LIMITS) {
  if (entries.length > limits.snapshotFiles) throw new SnapshotPreparationError('snapshot_file_count_limit', entries.length, limits.snapshotFiles);
  let bytes = 0, excludedFiles = 0;
  const files: Array<{ file: string; oid: string; size: number }> = [];
  for (const entry of entries) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\s+(\d+|-)\t(.+)$/.exec(entry);
    if (!match) throw new Error('snapshot_tree_invalid');
    const [, mode, type, oid, sizeText, file] = match;
    if (type !== 'blob' || !snapshotPathAllowed(file!, mode!)) { excludedFiles++; continue; }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('snapshot_tree_invalid');
    bytes += size;
    if (size > limits.snapshotFileBytes) throw new SnapshotPreparationError('snapshot_file_size_limit', size, limits.snapshotFileBytes, file!);
    if (bytes > limits.snapshotBytes) throw new SnapshotPreparationError('snapshot_total_size_limit', bytes, limits.snapshotBytes);
    files.push({ file: file!, oid: oid!, size });
  }
  return { files, bytes, excludedFiles };
}
async function snapshot(r: ExperimentRequest, target: string, plan: ReturnType<typeof planSnapshot>) {
  await checkWorkspace(r);
  const manifest: Array<[string, string]> = [];
  await mkdir(target, { mode: 0o700 });
  const deadline = Date.now() + 30_000;
  for (const { file, oid, size } of plan.files) {
    if (Date.now() > deadline) throw new Error('snapshot_timeout');
    // Read the Git object, not a potentially racing worktree path/symlink.
    const content = await git(r.workspaceRoot, ['cat-file', 'blob', oid], EXPERIMENT_LIMITS.snapshotFileBytes + 1);
    if (content.length !== size || createHash('sha1').update(`blob ${size}\0`).update(content).digest('hex') !== oid) {
      throw new Error('snapshot_blob_changed');
    }
    await mkdir(path.dirname(path.join(target, file!)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(target, file!), content, { flag: 'wx', mode: 0o400 });
    manifest.push([file!, oid!]);
  }
  await checkWorkspace(r);
  return { snapshotSha256: sha(JSON.stringify(manifest)), files: manifest.length, excludedFiles: plan.excludedFiles };
}

const launcher = (preparation = false) => `import resource, sys, runpy, ctypes
resource.setrlimit(resource.RLIMIT_CPU, (${preparation ? 40 : 20}, ${preparation ? 40 : 20}))
resource.setrlimit(resource.RLIMIT_AS, (${preparation ? 1073741824 : 536870912}, ${preparation ? 1073741824 : 536870912}))
resource.setrlimit(resource.RLIMIT_FSIZE, (${preparation ? 67108864 : 16777216}, ${preparation ? 67108864 : 16777216}))
resource.setrlimit(resource.RLIMIT_NPROC, (1, 1))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
# Install an irreversible filter BEFORE any repository/dependency import.
# Namespace and readonly mounts provide the filesystem boundary; this prevents
# creating processes/threads, new namespaces, mounts or network sockets.
sec = ctypes.CDLL('libseccomp.so.2')
sec.seccomp_init.argtypes = [ctypes.c_uint32]
sec.seccomp_init.restype = ctypes.c_void_p
sec.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
sec.seccomp_syscall_resolve_name.restype = ctypes.c_int
sec.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
sec.seccomp_load.argtypes = [ctypes.c_void_p]
sec.seccomp_release.argtypes = [ctypes.c_void_p]
ctx = sec.seccomp_init(0x7fff0000)
if not ctx: raise RuntimeError('seccomp_init_failed')
for name in 'clone clone3 fork vfork execve execveat unshare setns mount umount2 pivot_root chroot fsopen fsconfig fsmount fspick open_tree move_mount mount_setattr ptrace process_vm_readv process_vm_writev open_by_handle_at bpf perf_event_open keyctl add_key request_key io_uring_setup socket socketpair connect bind listen accept accept4'.split():
 nr = sec.seccomp_syscall_resolve_name(name.encode())
 if nr == -1 or sec.seccomp_rule_add_array(ctx, 0x00050001, nr, 0, None) != 0: raise RuntimeError('seccomp_rule_failed')
if sec.seccomp_load(ctx) != 0: raise RuntimeError('seccomp_load_failed')
sec.seccomp_release(ctx)
sys.path[:0] = ['/repo/src', '/repo', '/deps']
runpy.run_path('/experiment/probe.py', run_name='__main__')
`;
/** Preparation is a server-owned offline recipe, never a caller-supplied command or mount. */
export function sandboxArgs(job: string, deps: string | null, preparation = false, snapshot = path.join(job, 'snapshot')): string[] {
  return ['--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--clearenv', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/bin', '/bin',
    '--dir', '/etc', '--dir', '/home', '--dir', '/repo', '--dir', '/experiment', '--dir', '/deps',
    // No procfs at all: nested Docker user namespaces may not mount it and
    // experiments do not need process introspection. Never bind host /proc.
    '--dir', '/proc', '--dev', '/dev', '--size', preparation ? '536870912' : '33554432', '--tmpfs', '/tmp',
    '--ro-bind', snapshot, '/repo', '--ro-bind', path.join(job, 'probe.py'), '/experiment/probe.py',
    ...(deps ? [preparation ? '--bind' : '--ro-bind', deps, '/deps'] : []),
    ...(preparation ? ['--dir', '/wheelhouse', '--ro-bind', path.join(job, 'wheels'), '/wheelhouse',
      '--dir', '/environment-tools', '--ro-bind', '/opt/argus-environment-tools', '/environment-tools'] : []),
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'MPLCONFIGDIR', '/tmp/matplotlib', '--setenv', 'XDG_CACHE_HOME', '/tmp/cache',
    '--setenv', 'OPENBLAS_NUM_THREADS', '1', '--setenv', 'OMP_NUM_THREADS', '1', '--setenv', 'MKL_NUM_THREADS', '1',
    '--chdir', '/repo', '--', '/usr/bin/python3', '-I', '-S', '-u', '-c', launcher(preparation)];
}
export async function executeSandbox(job: string, deps: string | null, signal?: AbortSignal, preparation = false, snapshot?: string): Promise<Pick<ExperimentReceipt, 'status' | 'exitCode' | 'stdout' | 'stderr' | 'durationMs'>> {
  if (signal?.aborted) return { status: 'canceled', exitCode: null, stdout: '', stderr: '', durationMs: 0 };
  const started = Date.now();
  const child = spawn('/usr/bin/bwrap', sandboxArgs(job, deps, preparation, snapshot), { env: cleanEnv, cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), bytes = 0;
  let stop: 'timeout' | 'output_limit' | 'canceled' | undefined;
  const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } };
  const collect = (which: 'stdout' | 'stderr', chunk: Buffer) => {
    const part = chunk.subarray(0, Math.max(0, EXPERIMENT_LIMITS.outputBytes - bytes));
    if (which === 'stdout') stdout = Buffer.concat([stdout, part]); else stderr = Buffer.concat([stderr, part]);
    bytes += chunk.length;
    if (bytes > EXPERIMENT_LIMITS.outputBytes) { stop ??= 'output_limit'; kill(); }
  };
  child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
  const cancel = () => { stop ??= 'canceled'; kill(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { stop ??= 'timeout'; kill(); }, preparation ? 60_000 : EXPERIMENT_LIMITS.wallMs);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { status: stop ?? (exitCode === 0 ? 'completed' : 'failed'), exitCode,
      stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), durationMs: Date.now() - started };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); kill(); }
}

const active = new Set<string>();
async function syncDirectory(dir: string) {
  const fd = await open(dir, 'r');
  try { await fd.sync(); } finally { await fd.close(); }
}
async function durableJson(file: string, value: unknown) {
  const fd = await open(file, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  await syncDirectory(path.dirname(file));
}
export async function runExperiment(r: ExperimentRequest, signal?: AbortSignal, store = '/runtime/technical-experiments'): Promise<ExperimentReceipt | ExperimentPreparationFailure> {
  if (active.has(r.threadId) || active.size >= 1) throw new Error('experiment_busy');
  active.add(r.threadId);
  const job = path.join(store, r.threadId);
  try {
    await mkdir(store, { recursive: true, mode: 0o700 });
    const intent = { ...r, scriptSha256: sha(r.script) };
    const replay = async () => {
      const previous = JSON.parse(await readFile(path.join(job, 'intent.json'), 'utf8'));
      if (JSON.stringify(previous) !== JSON.stringify(intent)) throw new Error('experiment_identity_changed');
      // A persisted intent without a terminal receipt never executes again.
      try { return JSON.parse(await readFile(path.join(job, 'result.json'), 'utf8')) as ExperimentReceipt; }
      catch { throw new Error('experiment_interrupted_no_replay'); }
    };
    // Check old intent FIRST: a new limit/config must never replay uncertain work.
    let jobExists = false;
    try { await lstat(job); jobExists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (jobExists) return await replay();
    let plan: ReturnType<typeof planSnapshot>;
    try { plan = await inspectExperimentSnapshot(r); }
    catch (error) {
      if (!(error instanceof SnapshotPreparationError)) throw error;
      return { version: 1, threadId: r.threadId, baseCommitSha: r.baseCommitSha,
        basisSha256: r.basisSha256, requestSha256: r.requestSha256, scriptSha256: sha(r.script),
        status: 'preparation_failed', executionStarted: false, reason: error.reason, actual: error.actual,
        limit: error.limit, ...(error.filePath ? { filePath: error.filePath } : {}), limits: EXPERIMENT_LIMITS };
    }
    try { await mkdir(job, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return await replay(); }
    await syncDirectory(store);
    await durableJson(path.join(job, 'intent.json'), intent);
    const startedAt = new Date().toISOString();
    try {
      await access('/usr/bin/bwrap', constants.X_OK);
      const tree = await snapshot(r, path.join(job, 'snapshot'), plan);
      await writeFile(path.join(job, 'probe.py'), r.script, { flag: 'wx', mode: 0o400 });
      const pythonVersion = (await exec('/usr/bin/python3', ['-I', '-S', '-c', 'import sys; print(".".join(map(str,sys.version_info[:3])))'], { env: cleanEnv, timeout: 2000 })).stdout.trim();
      if (!/^3\.\d+\.\d+$/.test(pythonVersion)) throw new Error('python_unavailable');
      const candidateDeps = `/home/node/.local/lib/python${pythonVersion.split('.').slice(0, 2).join('.')}/site-packages`;
      let deps: string | null = null;
      try { if (await realpath(candidateDeps) === candidateDeps && (await lstat(candidateDeps)).isDirectory()) deps = candidateDeps; } catch { /* optional */ }
      const result = await executeSandbox(job, deps, signal);
      await checkWorkspace(r);
      const receipt: ExperimentReceipt = { version: 1, threadId: r.threadId, baseCommitSha: r.baseCommitSha,
        basisSha256: r.basisSha256, requestSha256: r.requestSha256, scriptSha256: sha(r.script),
        ...tree, profile: 'python-bwrap-v1', ...result, outputSha256: sha(JSON.stringify([result.stdout, result.stderr])),
        startedAt, finishedAt: new Date().toISOString(), limits: EXPERIMENT_LIMITS, pythonVersion };
      await durableJson(path.join(job, 'result.pending.json'), receipt);
      await rename(path.join(job, 'result.pending.json'), path.join(job, 'result.json'));
      await syncDirectory(job);
      return receipt;
    } finally {
      // Only server-created, non-symlink snapshot data. Preserve intent/script/result.
      await rm(path.join(job, 'snapshot'), { recursive: true, force: true });
    }
  } finally { active.delete(r.threadId); }
}

export const technicalExperimentRouter = Router();
technicalExperimentRouter.post('/run', async (req, res) => {
  if (process.env['ARGUS_TECHNICAL_EXPERIMENTS_ENABLED'] !== 'true') { res.status(503).json({ error: 'experiments_disabled' }); return; }
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);
  try { res.json(await runExperiment(parseExperimentRequest(req.body), controller.signal)); }
  catch (error) {
    const allowed = new Set(['invalid_experiment_request', 'experiment_busy', 'workspace_not_exact', 'workspace_changed',
      'snapshot_file_limit', 'snapshot_size_limit', 'snapshot_timeout', 'experiment_identity_changed', 'experiment_interrupted_no_replay']);
    const message = error instanceof Error && allowed.has(error.message) ? error.message : 'experiment_unavailable';
    res.status(message === 'invalid_experiment_request' ? 400 : 409).json({ error: message });
  } finally { res.off('close', onClose); }
});
