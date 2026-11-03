/** Independent QA artifacts: never grant an agent a general write/exec tool. */
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeSandbox, snapshotPathAllowed, EXPERIMENT_LIMITS } from './technicalExperiment.js';
import { projectSnapshotPathAllowed, assertProjectSnapshotContent } from './projectSnapshot.js';
import { planEnvironment, readCatalog, manifestLanguage, environmentHash } from '../environments/catalog.js';
import { prepareEnvironment, pythonRuntime, type EnvironmentReceipt } from '../environments/prepare.js';
import { dynamicEnvironments, parseRequirements, planResolvedEnvironment, type EnvironmentRequirement, type ResolverInput } from '../environments/resolver.js';

const exec = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' };
export type QaTestFile = { id: string; content: string };
export type QaRequest = { action: 'inspect' | 'run'; threadId: string; workspaceRoot: string; baseCommitSha: string;
  basisSha256: string; sourceSha256?: string; files?: QaTestFile[]; environmentPolicyVersion?: 1; environmentPlanSha256?: string;
  environmentRequirements?: EnvironmentRequirement[] };
export function parseQaRequest(value: unknown): QaRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('qa_invalid_request');
  const r = value as QaRequest;
  if (Object.keys(r).some(k => !['action', 'threadId', 'workspaceRoot', 'baseCommitSha', 'basisSha256', 'sourceSha256', 'files', 'environmentPolicyVersion', 'environmentPlanSha256', 'environmentRequirements'].includes(k))
    || !['inspect', 'run'].includes(r.action) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.threadId)
    || !/^\/workspace\/[A-Za-z0-9-]{1,600}$/.test(r.workspaceRoot) || !/^[a-f0-9]{40}$/.test(r.baseCommitSha)
    || !digest.test(r.basisSha256)) throw new Error('qa_invalid_request');
  if (r.environmentPolicyVersion !== undefined && r.environmentPolicyVersion !== 1) throw new Error('qa_invalid_request');
  if (r.environmentRequirements !== undefined) {
    if (r.environmentPolicyVersion !== 1) throw new Error('qa_invalid_request');
    parseRequirements(r.environmentRequirements);
  }
  if ((r.environmentPlanSha256 !== undefined && (r.environmentPolicyVersion !== 1 || r.action !== 'run' || !digest.test(r.environmentPlanSha256)))
    || (r.action === 'run' && r.environmentPolicyVersion === 1 && !digest.test(r.environmentPlanSha256 ?? ''))) throw new Error('qa_invalid_request');
  if (r.action === 'inspect') {
    if (r.files !== undefined || r.sourceSha256 !== undefined) throw new Error('qa_invalid_request');
  } else if (!digest.test(r.sourceSha256 ?? '') || !Array.isArray(r.files) || r.files.length < 1 || r.files.length > 12
    || r.files.some(f => !f || typeof f !== 'object' || Object.keys(f).sort().join(',') !== 'content,id'
      || !/^[a-z][a-z0-9_]{0,47}$/.test(f.id) || typeof f.content !== 'string' || !f.content.trim() || f.content.includes('\0')
      || Buffer.byteLength(f.content) > 16_000)
    || new Set(r.files.map(f => f.id)).size !== r.files.length
    || Buffer.byteLength(JSON.stringify(r.files)) > 72_000) throw new Error('qa_invalid_request');
  return r;
}
async function git(root: string, args: string[]) {
  return (await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: root, env: cleanEnv, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
/** Capture ordinary current source, including new Coder files, not just committed HEAD.
 * No execution of repository scripts/Git filters, ignored dependencies or symlinks.
 * Only the internal workspace-session caller enables hidden project inputs. */
export async function qaSnapshot(r: QaRequest, target?: string, internal?: { resolverInput?: ResolverInput; sourceFiles?: Array<{ path: string; content: string }>; projectFiles?: boolean }) {
  if (await realpath(r.workspaceRoot) !== r.workspaceRoot || !(await lstat(path.join(r.workspaceRoot, '.git'))).isDirectory()
    || (await git(r.workspaceRoot, ['rev-parse', 'HEAD'])).trim() !== r.baseCommitSha) throw new Error('qa_workspace_changed');
  const names = [...new Set((await git(r.workspaceRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))].sort();
  if (names.length > EXPERIMENT_LIMITS.snapshotFiles) throw new Error('qa_snapshot_limit');
  const manifest: Array<[string, string]> = [];
  const manifests: Record<string, string> = {};
  let bytes = 0, excluded = 0;
  const deadline = Date.now() + 30_000;
  if (target) await mkdir(target, { mode: 0o700 });
  for (const name of names) {
    if (Date.now() > deadline) throw new Error('qa_snapshot_limit');
    if (!(internal?.projectFiles ? projectSnapshotPathAllowed : snapshotPathAllowed)(name, '100644')) { excluded++; continue; }
    const full = path.join(r.workspaceRoot, name);
    let stat;
    try { stat = await lstat(full); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    // Installed frameworks can add hidden skill links into ignored .venv trees.
    // A session input excludes links without following them; one such link must
    // not make otherwise ordinary hidden project inputs unusable.
    if (internal?.projectFiles && stat.isSymbolicLink()) { excluded++; continue; }
    if (!stat.isFile() || stat.nlink !== 1 || await realpath(full) !== full) throw new Error('qa_unsafe_source');
    bytes += stat.size;
    if (stat.size > EXPERIMENT_LIMITS.snapshotFileBytes || bytes > EXPERIMENT_LIMITS.snapshotBytes) throw new Error('qa_snapshot_limit');
    const fd = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: Buffer;
    try {
      const opened = await fd.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error('qa_workspace_changed');
      content = await fd.readFile();
    } finally { await fd.close(); }
    if (content.length !== stat.size) throw new Error('qa_workspace_changed');
    if (internal?.projectFiles) assertProjectSnapshotContent(name, content);
    manifest.push([name, hash(content)]);
    internal?.sourceFiles?.push({ path: name, content: content.toString('base64') });
    if (r.environmentPolicyVersion === 1 && dynamicEnvironments() && manifestLanguage(name) === 'python') {
      if (content.length > 131072) throw new Error('environment_manifest_limit');
      manifests[name] = content.toString('utf8');
    }
    if (target) {
      const dest = path.join(target, name);
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, content, { flag: 'wx', mode: 0o400 });
    }
  }
  let environment;
  if (r.environmentPolicyVersion === 1) {
    let runtime = 'unavailable';
    try { runtime = await pythonRuntime(); } catch { /* unsupported host fails closed */ }
    if (dynamicEnvironments()) {
      const input: ResolverInput = { version: 1, runtime, namespace: environmentHash([r.threadId, r.basisSha256]), manifests, supplements: r.environmentRequirements ?? [] };
      environment = await planResolvedEnvironment(manifest, input);
      if (internal) internal.resolverInput = input;
    } else {
      if (r.environmentRequirements?.length) throw new Error('environment_supplements_unavailable');
      let profiles: Awaited<ReturnType<typeof readCatalog>> = [], available = true;
      try { profiles = await readCatalog(); } catch { available = false; }
      environment = planEnvironment(manifest, runtime, profiles, available);
    }
  }
  return { sourceSha256: hash(JSON.stringify([r.baseCommitSha, manifest])), files: manifest.length, excludedFiles: excluded,
    ...(environment ? { environment } : {}),
    python: names.some(n => ['pyproject.toml', 'setup.py', 'requirements.txt'].includes(n)) };
}

/** Fixed invocation, no caller-supplied command/flags. Pytest runs outside repository
 * conftest/plugin configuration. Collection, call and teardown must all complete. */
export function qaPytestProbe(files: QaTestFile[]): string {
  const artifacts = Object.fromEntries(files.map(f => [`test_${f.id}.py`, f.content]));
  return `import os, sys, json, pathlib
os.environ['PYTEST_DISABLE_PLUGIN_AUTOLOAD'] = '1'
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True
root = pathlib.Path('/tmp/argus_qa')
root.mkdir()
files = json.loads(${JSON.stringify(JSON.stringify(artifacts))})
for name, source in files.items():
 (root / name).write_text(source, encoding='utf-8')
import pytest
class Evidence:
 def __init__(self): self.nodes = []; self.reports = []; self.collection_errors = 0; self.missing = set()
 def remember(self, call):
  error = call.excinfo.value if call.excinfo else None
  seen = set()
  while error is not None and id(error) not in seen:
   seen.add(id(error))
   if isinstance(error, ModuleNotFoundError) and error.name: self.missing.add(error.name)
   error = error.__cause__ or error.__context__
 @pytest.hookimpl(hookwrapper=True)
 def pytest_runtest_makereport(self, item, call):
  self.remember(call)
  yield
 def pytest_exception_interact(self, node, call, report): self.remember(call)
 def pytest_collection_finish(self, session): self.nodes = [i.nodeid for i in session.items]
 def pytest_collectreport(self, report):
  if report.failed: self.collection_errors += 1
 def pytest_runtest_logreport(self, report): self.reports.append({'node': report.nodeid, 'when': report.when, 'outcome': report.outcome, 'xfail': hasattr(report, 'wasxfail')})
evidence = Evidence()
code = pytest.main(['-q', '-c', '/dev/null', '--noconftest', '-p', 'no:cacheprovider', '--rootdir', str(root), str(root)], plugins=[evidence])
print('ARGUS_QA_RESULT=' + json.dumps({'exitCode': int(code), 'nodes': evidence.nodes, 'reports': evidence.reports, 'collectionErrors': evidence.collection_errors, 'missingModules': sorted(evidence.missing)[:12]}), flush=True)
sys.exit(code)
`;
}
export function parseQaPytestEvidence(stdout: string, files: QaTestFile[]) {
  const lines = stdout.split('\n').filter(l => l.startsWith('ARGUS_QA_RESULT='));
  if (lines.length !== 1) throw new Error('qa_result_missing');
  const value = JSON.parse(lines[0]!.slice('ARGUS_QA_RESULT='.length));
  if (!value || !Number.isInteger(value.exitCode) || !Number.isInteger(value.collectionErrors)
    || !Array.isArray(value.nodes) || !Array.isArray(value.reports) || value.nodes.length > 256 || value.reports.length > 768
    || value.nodes.some((n: unknown) => typeof n !== 'string' || n.length > 512)
    || new Set(value.nodes).size !== value.nodes.length
    || value.reports.some((r: { node?: unknown; when?: unknown; outcome?: unknown; xfail?: unknown }) => !r || typeof r.xfail !== 'boolean' || !value.nodes.includes(r.node)
      || !['setup', 'call', 'teardown'].includes(String(r.when)) || !['passed', 'failed', 'skipped'].includes(String(r.outcome)))) throw new Error('qa_result_invalid');
  const covered = files.every(f => value.nodes.some((n: string) => n.startsWith(`test_${f.id}.py::`)));
  const complete = covered && value.nodes.length > 0 && value.collectionErrors === 0
    && value.nodes.every((node: string) => ['setup', 'call', 'teardown'].every(when => {
      const reports = value.reports.filter((r: { node: string; when: string }) => r.node === node && r.when === when);
      return reports.length === 1 && !reports[0].xfail && reports[0].outcome !== 'skipped'
        && (when === 'call' || reports[0].outcome === 'passed');
    }));
  const passed = complete && value.exitCode === 0 && value.reports.every((r: { outcome: string }) => r.outcome === 'passed');
  // A test-call failure is feedback, not proof that its expectation is correct.
  // Collection/setup/skip/missing evidence is a QA/environment stop, not a product fix.
  const assertionFailed = complete && value.exitCode === 1
    && value.reports.some((r: { when: string; outcome: string }) => r.when === 'call' && r.outcome === 'failed');
  const missingModules = value.missingModules ?? [];
  if (!Array.isArray(missingModules) || missingModules.length > 12 || missingModules.some((m: unknown) => typeof m !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(m))) throw new Error('qa_result_invalid');
  return { passed, assertionFailed: assertionFailed && !missingModules.length, collected: value.nodes.length, nodes: value.nodes as string[], missingModules };
}

const active = new Set<string>();
async function syncDirectory(dir: string) {
  const fd = await open(dir, constants.O_RDONLY);
  try { await fd.sync(); } finally { await fd.close(); }
}
export async function runQaTests(r: QaRequest, signal?: AbortSignal, store = '/runtime/technical-experiments/qa-tests') {
  r = parseQaRequest(r);
  if (r.action !== 'run') throw new Error('qa_invalid_request');
  if (r.environmentPolicyVersion === 1 && process.env['ARGUS_PROJECT_ENVIRONMENTS_ENABLED'] !== 'true') throw new Error('environment_disabled');
  if (active.size) throw new Error('qa_busy');
  active.add(r.threadId);
  const files = r.files!;
  const testSha256 = hash(JSON.stringify(files));
  const requestSha256 = hash(JSON.stringify(r));
  const job = path.join(store, r.threadId, requestSha256);
  try {
    await mkdir(path.dirname(job), { recursive: true, mode: 0o700 });
    try { await mkdir(job, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const result = JSON.parse(await readFile(path.join(job, 'result.json'), 'utf8'));
      const current = await qaSnapshot(r);
      if (current.sourceSha256 !== r.sourceSha256 || (r.environmentPolicyVersion === 1 && current.environment?.planSha256 !== r.environmentPlanSha256)) throw new Error('qa_workspace_changed');
      return result;
    }
    // Persist before any execution; incomplete attempts are never replayed.
    const intent = await open(path.join(job, 'intent.json'), 'wx', 0o600);
    try { await intent.writeFile(JSON.stringify(r)); await intent.sync(); } finally { await intent.close(); }
    await syncDirectory(job);
    await syncDirectory(path.dirname(job));
    await syncDirectory(store);
    try {
      const internal: { resolverInput?: ResolverInput } = {};
      const snapshot = await qaSnapshot(r, path.join(job, 'snapshot'), internal);
      if (!snapshot.python) throw new Error('qa_python_required');
      if (snapshot.sourceSha256 !== r.sourceSha256 || (await qaSnapshot(r)).sourceSha256 !== snapshot.sourceSha256) throw new Error('qa_workspace_changed');
      await writeFile(path.join(job, 'probe.py'), qaPytestProbe(files), { flag: 'wx', mode: 0o400 });
      const version = (await exec('/usr/bin/python3', ['-I', '-S', '-c', 'import sys; print("%s.%s" % sys.version_info[:2])'], { env: cleanEnv, timeout: 2000 })).stdout.trim();
      if (!/^3\.\d+$/.test(version)) throw new Error('qa_python_required');
      let deps: string | null = `/home/node/.local/lib/python${version}/site-packages`;
      let environment: EnvironmentReceipt | undefined;
      const started = Date.now();
      if (r.environmentPolicyVersion === 1) {
        if (!snapshot.environment || snapshot.environment.planSha256 !== r.environmentPlanSha256) throw new Error('environment_plan_changed');
        const prepared = await prepareEnvironment(snapshot.environment, job, signal, internal.resolverInput);
        environment = prepared.receipt; deps = prepared.deps;
      } else if (await realpath(deps) !== deps) throw new Error('qa_dependencies_unavailable');
      const execution = environment?.status === 'blocked'
        ? { status: 'preparation_failed' as const, exitCode: null, stdout: '', stderr: '', durationMs: Date.now() - started }
        : await executeSandbox(job, deps, signal);
      if ((await qaSnapshot(r)).sourceSha256 !== snapshot.sourceSha256) throw new Error('qa_workspace_changed');
      let evidence = { passed: false, assertionFailed: false, collected: 0, nodes: [] as string[], missingModules: [] as string[] };
      if (['completed', 'failed'].includes(execution.status)) {
        try { evidence = parseQaPytestEvidence(execution.stdout, files); } catch { /* not a passing or repairable result */ }
      }
      const result = { version: 1, threadId: r.threadId, basisSha256: r.basisSha256, sourceSha256: snapshot.sourceSha256,
        testSha256, requestSha256, profile: 'python-bwrap-v1', ...execution,
        collected: evidence.collected, nodes: evidence.nodes,
        ...(r.environmentPolicyVersion === 1 ? { missingModules: evidence.missingModules } : {}),
        ...(environment ? { environment, executionStarted: environment.status === 'ready' } : {}),
        passed: execution.status === 'completed' && execution.exitCode === 0 && evidence.passed,
        assertionFailed: execution.status === 'failed' && execution.exitCode === 1 && evidence.assertionFailed,
        outputSha256: hash(JSON.stringify([execution.stdout, execution.stderr])), finishedAt: new Date().toISOString() };
      const receipt = await open(path.join(job, 'result.pending.json'), 'wx', 0o600);
      try { await receipt.writeFile(JSON.stringify(result)); await receipt.sync(); } finally { await receipt.close(); }
      await rename(path.join(job, 'result.pending.json'), path.join(job, 'result.json'));
      await syncDirectory(job);
      return result;
    } finally {
      await rm(path.join(job, 'snapshot'), { recursive: true, force: true });
      if (r.environmentPolicyVersion === 1) {
        await rm(path.join(job, 'environment-preparation'), { recursive: true, force: true });
        await rm(path.join(job, 'environment-preflight'), { recursive: true, force: true });
      }
    }
  } finally { active.delete(r.threadId); }
}

export const qaTestsRouter = Router();
qaTestsRouter.post('/', async (req, res) => {
  if (process.env['ARGUS_DEV_QA_TESTS_ENABLED'] !== 'true') { res.status(503).json({ error: 'qa_disabled' }); return; }
  const abort = new AbortController();
  const close = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', close);
  try {
    const r = parseQaRequest(req.body);
    if (r.environmentPolicyVersion === 1 && process.env['ARGUS_PROJECT_ENVIRONMENTS_ENABLED'] !== 'true') {
      res.status(503).json({ error: 'environment_disabled' }); return;
    }
    res.json(r.action === 'inspect' ? await qaSnapshot(r) : await runQaTests(r, abort.signal));
  } catch { res.status(409).json({ error: 'qa_unavailable_or_changed', message: 'QA evidence unavailable; no automatic replay.' }); }
  finally { res.off('close', close); }
});
