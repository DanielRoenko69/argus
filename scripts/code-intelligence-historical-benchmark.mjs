#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MANIFEST = 'demo/code-intelligence/pino-historical-benchmark.json';
const DEFAULT_UPSTREAM = 'test-results/benchmarks/pino-upstream';
const RESULT_ROOT = path.resolve('test-results/code-intelligence-historical-benchmark');
const PREPARED_ROOT = path.resolve('test-results/benchmarks/prepared');
const SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,127}$/;
const SAFE_PATH = /^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\u0000]+$/;

function executable(command, args) {
  if (command !== 'npm') return { command, args };
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error('npm_execpath is required to execute benchmark npm commands without a shell');
  }
  return { command: process.execPath, args: [npmCli, ...args] };
}

function safeChildEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    PATHEXT: process.env.PATHEXT ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    COMSPEC: process.env.COMSPEC ?? process.env.ComSpec ?? '',
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    CI: 'true',
    NO_COLOR: '1',
    ...overrides,
  };
}

function run(command, args, options = {}) {
  const invocation = executable(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: safeChildEnvironment(options.env),
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture === false ? 'inherit' : 'pipe',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? ''),
  };
}

async function isolatedEnvironment(target, sharedRoot) {
  const home = path.join(target, '.argus-benchmark-home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const npmrc = path.join(home, '.npmrc');
  await mkdir(appData, { recursive: true });
  await mkdir(localAppData, { recursive: true });
  await writeFile(npmrc, '', 'utf8');
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    npm_config_userconfig: npmrc,
    npm_config_cache: path.join(sharedRoot, '.npm-cache'),
    npm_config_update_notifier: 'false',
  };
}

function git(upstream, args, encoding = 'utf8') {
  return execFileSync('git', ['-c', `safe.directory=${upstream}`, '-C', upstream, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function normalizedLines(value) {
  return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean).sort();
}

function assertArray(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value.map(item => item.trim());
}

function validatePathList(value, name) {
  const paths = assertArray(value, name);
  for (const item of paths) {
    if (!SAFE_PATH.test(item) || item.includes('\\')) throw new Error(`${name} contains unsafe path '${item}'`);
  }
  return paths;
}

async function loadManifest(manifestPath) {
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (parsed?.schema !== 'argus.code-intelligence-historical-benchmark.v1') {
    throw new Error('unsupported historical benchmark schema');
  }
  if (!SAFE_ID.test(parsed.id ?? '')) throw new Error('benchmark id is invalid');
  if (!parsed.repository?.key || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(parsed.repository.url ?? '')) {
    throw new Error('benchmark repository must be an exact public GitHub HTTPS clone URL');
  }
  if (parsed.repository.license !== 'MIT') throw new Error('the initial benchmark repository must retain its declared MIT license');
  const lockCommand = assertArray(parsed.lockCommand, 'lockCommand');
  const installCommand = assertArray(parsed.installCommand, 'installCommand');
  if (!Array.isArray(parsed.cases) || parsed.cases.length < 1 || parsed.cases.length > 100) {
    throw new Error('benchmark requires 1-100 cases');
  }
  const ids = new Set();
  const cases = parsed.cases.map((item, index) => {
    if (!SAFE_ID.test(item?.id ?? '') || ids.has(item.id)) throw new Error(`case ${index} has an invalid or duplicate id`);
    if (!SHA.test(item.baseCommit ?? '') || !SHA.test(item.fixCommit ?? '') || item.baseCommit === item.fixCommit) {
      throw new Error(`case '${item.id}' has invalid immutable commits`);
    }
    if (typeof item.ticket !== 'string' || item.ticket.trim().length < 80 || item.ticket.length > 4_000) {
      throw new Error(`case '${item.id}' has an invalid ticket`);
    }
    if (!/^https:\/\/github\.com\/pinojs\/pino\/(?:issues|pull)\/\d+$/u.test(item.sourceUrl ?? '')) {
      throw new Error(`case '${item.id}' has an invalid source URL`);
    }
    ids.add(item.id);
    return {
      ...item,
      retrievalExpectedFiles: validatePathList(item.retrievalExpectedFiles, `${item.id}.retrievalExpectedFiles`),
      goldChangedFiles: validatePathList(item.goldChangedFiles, `${item.id}.goldChangedFiles`),
      oraclePaths: validatePathList(item.oraclePaths, `${item.id}.oraclePaths`),
      testCommand: assertArray(item.testCommand, `${item.id}.testCommand`),
    };
  });
  return { ...parsed, lockCommand, installCommand, cases };
}

function assertUpstream(upstream, manifest) {
  if (!existsSync(path.join(upstream, '.git'))) throw new Error(`upstream Git clone not found at ${upstream}`);
  const origin = git(upstream, ['config', '--get', 'remote.origin.url']).trim().replace(/\.git$/u, '');
  if (origin.toLowerCase() !== manifest.repository.url.replace(/\.git$/u, '').toLowerCase()) {
    throw new Error(`upstream origin '${origin}' does not match manifest repository`);
  }
}

function validateCaseAgainstGit(upstream, benchmarkCase) {
  git(upstream, ['cat-file', '-e', `${benchmarkCase.baseCommit}^{commit}`]);
  git(upstream, ['cat-file', '-e', `${benchmarkCase.fixCommit}^{commit}`]);
  const parents = git(upstream, ['show', '-s', '--format=%P', benchmarkCase.fixCommit]).trim().split(/\s+/u);
  if (parents.length !== 1 || parents[0] !== benchmarkCase.baseCommit) {
    throw new Error(`case '${benchmarkCase.id}' fix must be a direct, non-merge child of its base commit`);
  }
  const actualChanged = normalizedLines(git(upstream, [
    'diff', '--name-only', '--no-renames', benchmarkCase.baseCommit, benchmarkCase.fixCommit,
  ]));
  const declaredChanged = [...benchmarkCase.goldChangedFiles].sort();
  if (JSON.stringify(actualChanged) !== JSON.stringify(declaredChanged)) {
    throw new Error(`case '${benchmarkCase.id}' changed files do not match the immutable upstream patch`);
  }
  for (const file of benchmarkCase.retrievalExpectedFiles) {
    git(upstream, ['cat-file', '-e', `${benchmarkCase.baseCommit}:${file}`]);
  }
  for (const file of benchmarkCase.oraclePaths) {
    if (!actualChanged.includes(file)) throw new Error(`case '${benchmarkCase.id}' oracle '${file}' is outside the gold patch`);
    git(upstream, ['cat-file', '-e', `${benchmarkCase.fixCommit}:${file}`]);
  }
  return { changedFiles: actualChanged };
}

async function materializeTree(upstream, commit, target) {
  await mkdir(target, { recursive: true });
  const archive = path.join(path.dirname(target), `${path.basename(target)}.tar`);
  const archived = run('git', [
    '-c', `safe.directory=${upstream}`, '-C', upstream,
    'archive', '--format=tar', '-o', archive, commit,
  ]);
  if (archived.status !== 0) throw new Error(`git archive failed: ${archived.stderr}`);
  const extracted = run('tar', ['-xf', archive, '-C', target]);
  await rm(archive, { force: true });
  if (extracted.status !== 0) throw new Error(`tar extraction failed: ${extracted.stderr}`);
}

async function overlayOracle(upstream, benchmarkCase, target) {
  for (const relative of benchmarkCase.oraclePaths) {
    const destination = path.resolve(target, relative);
    if (destination !== target && !destination.startsWith(`${target}${path.sep}`)) {
      throw new Error(`oracle path escapes benchmark root: ${relative}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const contents = git(upstream, ['show', `${benchmarkCase.fixCommit}:${relative}`], null);
    await writeFile(destination, contents);
  }
}

function boundedLog(value) {
  const limit = 24_000;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;
}

async function createDependencyLock(manifest, upstream, benchmarkCase, root) {
  const target = path.join(root, 'dependency-lock');
  await materializeTree(upstream, benchmarkCase.baseCommit, target);
  const env = await isolatedEnvironment(target, root);
  const generated = run(manifest.lockCommand[0], manifest.lockCommand.slice(1), { cwd: target, env });
  if (generated.status !== 0) {
    throw new Error(`dependency lock generation failed:\n${boundedLog(generated.stderr || generated.stdout)}`);
  }
  const lock = await readFile(path.join(target, 'package-lock.json'));
  return {
    contents: lock,
    sha256: createHash('sha256').update(lock).digest('hex'),
  };
}

async function executeVariant(manifest, upstream, benchmarkCase, commit, variant, root, dependencyLock) {
  const target = path.join(root, variant);
  await materializeTree(upstream, commit, target);
  await overlayOracle(upstream, benchmarkCase, target);
  await writeFile(path.join(target, 'package-lock.json'), dependencyLock.contents);
  const env = await isolatedEnvironment(target, root);
  const install = run(manifest.installCommand[0], manifest.installCommand.slice(1), { cwd: target, env });
  if (install.status !== 0) {
    throw new Error(`${variant} dependency installation failed:\n${boundedLog(install.stderr || install.stdout)}`);
  }
  const test = run(benchmarkCase.testCommand[0], benchmarkCase.testCommand.slice(1), { cwd: target, env });
  return {
    variant,
    commit,
    passed: test.status === 0,
    exitCode: test.status,
    stdout: boundedLog(test.stdout),
    stderr: boundedLog(test.stderr),
  };
}

async function calibrate(manifest, upstream, benchmarkCase, configuredWorkRoot) {
  await mkdir(RESULT_ROOT, { recursive: true });
  const workRoot = path.resolve(configuredWorkRoot ?? RESULT_ROOT);
  await mkdir(workRoot, { recursive: true });
  const root = await mkdtemp(path.join(workRoot, `${benchmarkCase.id}-`));
  try {
    const dependencyLock = await createDependencyLock(manifest, upstream, benchmarkCase, root);
    const baseline = await executeVariant(manifest, upstream, benchmarkCase, benchmarkCase.baseCommit, 'baseline', root, dependencyLock);
    const gold = await executeVariant(manifest, upstream, benchmarkCase, benchmarkCase.fixCommit, 'gold', root, dependencyLock);
    const passed = !baseline.passed && gold.passed;
    const report = {
      schema: 'argus.code-intelligence-historical-calibration.v1',
      generatedAt: new Date().toISOString(),
      benchmarkId: manifest.id,
      repository: manifest.repository.key,
      caseId: benchmarkCase.id,
      sourceUrl: benchmarkCase.sourceUrl,
      oraclePaths: benchmarkCase.oraclePaths,
      dependencyLockSha256: dependencyLock.sha256,
      passed,
      baseline,
      gold,
    };
    const reportPath = path.join(RESULT_ROOT, `${benchmarkCase.id}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
      schema: report.schema,
      passed,
      caseId: benchmarkCase.id,
      baselinePassed: baseline.passed,
      goldPassed: gold.passed,
      report: path.relative(process.cwd(), reportPath).replaceAll('\\', '/'),
    }, null, 2)}\n`);
    if (!passed) process.exitCode = 2;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function prepareCase(upstream, benchmarkCase, configuredOutput) {
  await mkdir(PREPARED_ROOT, { recursive: true });
  const target = path.resolve(configuredOutput ?? path.join(PREPARED_ROOT, benchmarkCase.id));
  if (target !== PREPARED_ROOT && !target.startsWith(`${PREPARED_ROOT}${path.sep}`)) {
    throw new Error('prepared repository output must stay below test-results/benchmarks/prepared');
  }
  if (existsSync(target)) throw new Error(`prepared repository output already exists: ${target}`);
  const staging = await mkdtemp(path.join(PREPARED_ROOT, '.prepare-'));
  const repository = path.join(staging, 'repository');
  try {
    await materializeTree(upstream, benchmarkCase.baseCommit, repository);
    const authoredAt = git(upstream, ['show', '-s', '--format=%aI', benchmarkCase.baseCommit]).trim();
    const commitEnv = {
      GIT_AUTHOR_NAME: 'Argus Benchmark',
      GIT_AUTHOR_EMAIL: 'benchmark@argus.local',
      GIT_COMMITTER_NAME: 'Argus Benchmark',
      GIT_COMMITTER_EMAIL: 'benchmark@argus.local',
      GIT_AUTHOR_DATE: authoredAt,
      GIT_COMMITTER_DATE: authoredAt,
    };
    for (const [command, args] of [
      ['git', ['init', '-b', 'main']],
      ['git', ['add', '--all']],
      ['git', ['commit', '-m', `Argus benchmark base: ${benchmarkCase.id}\n\nUpstream-Base: ${benchmarkCase.baseCommit}`]],
    ]) {
      const result = run(command, args, { cwd: repository, env: commitEnv });
      if (result.status !== 0) throw new Error(`history-free repository preparation failed: ${result.stderr || result.stdout}`);
    }
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: repository, env: commitEnv });
    const commitCount = run('git', ['rev-list', '--count', 'HEAD'], { cwd: repository, env: commitEnv });
    if (commit.status !== 0 || commitCount.stdout.trim() !== '1') {
      throw new Error('prepared repository must contain exactly one synthetic commit');
    }
    await rename(repository, target);
    process.stdout.write(`${JSON.stringify({
      schema: 'argus.code-intelligence-prepared-benchmark.v1',
      caseId: benchmarkCase.id,
      upstreamBaseCommit: benchmarkCase.baseCommit,
      localCommit: commit.stdout.trim(),
      output: path.relative(process.cwd(), target).replaceAll('\\', '/'),
      historyCommits: 1,
    }, null, 2)}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const action = process.argv[2] ?? 'validate';
const manifestPath = path.resolve(option('--manifest', DEFAULT_MANIFEST));
const upstream = path.resolve(option('--upstream', process.env.ARGUS_CODE_BENCHMARK_UPSTREAM ?? DEFAULT_UPSTREAM));
const manifest = await loadManifest(manifestPath);
assertUpstream(upstream, manifest);
const selectedId = option('--case');
const selectedCases = selectedId ? manifest.cases.filter(item => item.id === selectedId) : manifest.cases;
if (selectedCases.length === 0) throw new Error(`benchmark case '${selectedId}' was not found`);
const validations = selectedCases.map(benchmarkCase => ({
  id: benchmarkCase.id,
  ...validateCaseAgainstGit(upstream, benchmarkCase),
}));

if (action === 'validate') {
  process.stdout.write(`${JSON.stringify({
    schema: manifest.schema,
    benchmarkId: manifest.id,
    repository: manifest.repository.key,
    cases: validations,
  }, null, 2)}\n`);
} else if (action === 'calibrate') {
  if (selectedCases.length !== 1) throw new Error('calibrate requires exactly one --case');
  await calibrate(
    manifest,
    upstream,
    selectedCases[0],
    option('--work-root', process.env.ARGUS_CODE_BENCHMARK_WORK_ROOT ?? RESULT_ROOT),
  );
} else if (action === 'prepare') {
  if (selectedCases.length !== 1) throw new Error('prepare requires exactly one --case');
  await prepareCase(upstream, selectedCases[0], option('--output'));
} else {
  throw new Error(`unknown action '${action}'; use validate, calibrate or prepare`);
}
