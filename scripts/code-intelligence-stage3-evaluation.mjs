#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { ExecutionGrantIssuer } from '../dist/solutionPacks/executionGrant.js';

dotenv.config();

const MANIFEST_PATH = path.resolve('demo/code-intelligence/pino-historical-benchmark.json');
const RESULT_ROOT = path.resolve('test-results/benchmarks/stage3');
const DEFAULT_CASE = 'pino-multistream-string-level';
const DEFAULT_TIMEOUT_MINUTES = 30;
const GITEA_BRANCH_READ_ATTEMPTS = 10;
const A2A_HEADERS = Object.freeze({
  accept: 'application/a2a+json',
  'content-type': 'application/a2a+json',
  'a2a-version': '1.0',
});
const FINALIZATION_GRACE_MS = 60_000;

function boundedText(value, maximum = 24_000) {
  const text = String(value ?? '').replaceAll('\r\n', '\n');
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n[truncated]`;
}

function diagnosticText(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function safeChildEnvironment(extra = {}) {
  const keys = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'LANG', 'LC_ALL', 'TZ',
  ];
  const env = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? safeChildEnvironment(),
    encoding: options.encoding ?? 'utf8',
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout ?? 10 * 60 * 1_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function mustRun(command, args, options = {}, label = command) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}): ${boundedText(result.stderr || result.stdout, 4_000)}`);
  }
  return result.stdout.trim();
}

export function stage3SafeGitArgs(repository, args) {
  const safeRepository = path.resolve(repository).replaceAll('\\', '/');
  return ['-c', `safe.directory=${safeRepository}`, ...args];
}

function mustRunInGitRepository(repository, args, options = {}, label = 'git') {
  return mustRun(
    'git',
    stage3SafeGitArgs(repository, args),
    { ...options, cwd: repository },
    label,
  );
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function parseStage3Options(argv) {
  const variant = option(argv, '--variant', 'both');
  if (!['baseline', 'candidate', 'both'].includes(variant)) {
    throw new Error('--variant must be baseline, candidate, or both');
  }
  const caseId = option(argv, '--case', DEFAULT_CASE);
  if (!/^[a-z0-9][a-z0-9-]{2,127}$/u.test(caseId)) throw new Error('--case contains unsafe characters');
  const repetitions = positiveInteger(option(argv, '--repetitions', '1'), '--repetitions', 1, 10);
  const timeoutMinutes = positiveInteger(
    option(argv, '--timeout-minutes', String(DEFAULT_TIMEOUT_MINUTES)),
    '--timeout-minutes',
    5,
    90,
  );
  const reportTag = option(argv, '--report-tag');
  if (reportTag !== null && !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(reportTag)) {
    throw new Error('--report-tag must contain 2-64 lowercase letters, digits, or hyphens');
  }
  const resumeReport = argv.includes('--resume-report');
  if (resumeReport && reportTag === null) {
    throw new Error('--resume-report requires --report-tag to protect the default report');
  }
  const variants = variant === 'both' ? ['baseline', 'candidate'] : [variant];
  return { caseId, repetitions, timeoutMinutes, variants, reportTag, resumeReport };
}

function stage3ReportFilename(reportTag) {
  return reportTag ? `evaluation-report-${reportTag}.json` : 'evaluation-report.json';
}

function stage3PartialFilename(reportTag) {
  return reportTag ? `latest-partial-${reportTag}.json` : 'latest-partial.json';
}

/** Alternate pair order so a warm runtime cannot systematically favor one arm. */
export function stage3VariantOrder(repetition, selected) {
  if (selected.length !== 2) return [...selected];
  return repetition % 2 === 0 ? [...selected] : [...selected].reverse();
}

export function stage3ResumeState(report, options, caseId) {
  const normalized = report?.schema === undefined && Array.isArray(report?.runs)
    ? {
        schema: 'argus.code-intelligence-stage3-evaluation.v2',
        benchmark: { caseId },
        controls: { variants: [...options.variants] },
        runs: report.runs,
      }
    : report;
  if (normalized?.schema !== 'argus.code-intelligence-stage3-evaluation.v2'
    || normalized?.benchmark?.caseId !== caseId
    || !Array.isArray(normalized?.runs)) {
    throw new Error('resume report does not match the selected Stage-3 benchmark case');
  }
  const existingVariants = [...(normalized.controls?.variants ?? [])].sort();
  const selectedVariants = [...options.variants].sort();
  if (JSON.stringify(existingVariants) !== JSON.stringify(selectedVariants)) {
    throw new Error('resume report variants do not match the selected variants');
  }
  const runKeys = new Set();
  let maximumRepetition = 0;
  for (const run of normalized.runs) {
    const repetition = Number(run.repetition);
    if (!Number.isSafeInteger(repetition) || repetition < 1 || !selectedVariants.includes(run.variant)) {
      throw new Error('resume report contains an invalid run identity');
    }
    const key = `${repetition}:${run.variant}`;
    if (runKeys.has(key)) throw new Error(`resume report contains duplicate run ${key}`);
    runKeys.add(key);
    maximumRepetition = Math.max(maximumRepetition, repetition);
  }
  let completedRepetitions = 0;
  let partialRepetition = null;
  for (let repetition = 1; repetition <= maximumRepetition; repetition += 1) {
    const present = selectedVariants.filter(variant => runKeys.has(`${repetition}:${variant}`));
    if (present.length === selectedVariants.length) {
      if (partialRepetition !== null) {
        throw new Error(`resume report contains runs after incomplete pair ${partialRepetition}`);
      }
      completedRepetitions = repetition;
      continue;
    }
    if (present.length === 0 || repetition !== maximumRepetition) {
      throw new Error(`resume report contains an incomplete pair at repetition ${repetition}`);
    }
    partialRepetition = repetition;
  }
  if (options.repetitions < maximumRepetition
    || (partialRepetition === null && options.repetitions <= completedRepetitions)) {
    throw new Error(`--repetitions must exceed the ${completedRepetitions} completed repetitions`);
  }
  return { runs: [...normalized.runs], completedRepetitions };
}

function safeRelativeFile(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.split('/').includes('..')
    && !value.includes('\0');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function recall(expected, actual) {
  const wanted = [...new Set(expected)];
  const found = new Set(actual);
  return wanted.length === 0 ? 1 : wanted.filter(item => found.has(item)).length / wanted.length;
}

export function stage3EvidenceAdmission(workspace) {
  const changedFiles = Array.isArray(workspace?.changedFiles) ? workspace.changedFiles : [];
  const generatedInfrastructureFiles = changedFiles.filter(file => (
    file === 'graphify-out'
    || file.startsWith('graphify-out/')
    || file === '.argus-stage3'
    || file.startsWith('.argus-stage3/')
  ));
  const reasons = [];
  if (workspace?.captureError) reasons.push('workspace_capture_failed');
  if (generatedInfrastructureFiles.length > 0) reasons.push('generated_infrastructure_in_patch');
  return {
    admitted: reasons.length === 0,
    reasons,
    generatedInfrastructureFiles,
  };
}

export function scoreStage3Run(input) {
  const implementationGold = input.goldChangedFiles.filter(file => !input.oraclePaths.includes(file));
  const implementationRecall = recall(implementationGold, input.changedFiles);
  const goldFileRecall = recall(input.goldChangedFiles, input.changedFiles);
  const changedFiles = [...new Set(input.changedFiles)];
  const goldFiles = new Set(input.goldChangedFiles);
  const goldFilePrecision = changedFiles.length === 0
    ? 0
    : changedFiles.filter(file => goldFiles.has(file)).length / changedFiles.length;
  const unrelatedFileCount = changedFiles.filter(file => !goldFiles.has(file)).length;
  const checks = {
    approval_gate_reached: input.reachedApproval,
    workflow_tests_passed: input.workflowTestsPassed,
    reviewer_passed: input.reviewPassed,
    hidden_oracle_passed: input.oraclePassed,
    implementation_file_recall: implementationRecall,
    gold_file_recall: goldFileRecall,
    gold_file_precision: goldFilePrecision,
    unrelated_file_count: unrelatedFileCount,
    trace_correlated: input.traceCorrelated,
    remote_unchanged: input.remoteUnchanged,
  };
  const score = (
    Number(checks.approval_gate_reached) * 0.10
    + Number(checks.workflow_tests_passed) * 0.10
    + Number(checks.reviewer_passed) * 0.10
    + Number(checks.hidden_oracle_passed) * 0.35
    + implementationRecall * 0.10
    + goldFileRecall * 0.05
    + goldFilePrecision * 0.05
    + Number(checks.trace_correlated) * 0.10
    + Number(checks.remote_unchanged) * 0.05
  );
  return { score: Number(score.toFixed(4)), checks };
}

export function summarizeStage3Runs(runs, repetitions) {
  const variants = {};
  for (const variant of ['baseline', 'candidate']) {
    const selected = runs
      .filter(run => run.variant === variant)
      .sort((left, right) => Number(left.repetition ?? 0) - Number(right.repetition ?? 0));
    if (selected.length === 0) continue;
    const mean = field => selected.reduce((sum, run) => sum + Number(field(run)), 0) / selected.length;
    const durations = selected
      .map(run => {
        const started = Date.parse(run.startedAt ?? '');
        const finished = Date.parse(run.finishedAt ?? '');
        return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
          ? (finished - started) / 1_000
          : null;
      })
      .filter(value => value !== null)
      .sort((left, right) => left - right);
    const p95Duration = durations.length > 0
      ? durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)]
      : null;
    variants[variant] = {
      runs: selected.length,
      mean_score: Number(mean(run => run.scoring.score).toFixed(4)),
      approval_rate: Number(mean(run => Number(run.scoring.checks.approval_gate_reached)).toFixed(4)),
      full_suite_rate: Number(mean(run => Number(run.scoring.checks.workflow_tests_passed)).toFixed(4)),
      reviewer_pass_rate: Number(mean(run => Number(run.scoring.checks.reviewer_passed)).toFixed(4)),
      hidden_oracle_rate: Number(mean(run => Number(run.scoring.checks.hidden_oracle_passed)).toFixed(4)),
      mean_runtime_file_recall: Number(mean(run => run.scoring.checks.implementation_file_recall).toFixed(4)),
      mean_scope_precision: Number(mean(run => run.scoring.checks.gold_file_precision ?? 0).toFixed(4)),
      exact_gold_scope_rate: Number(mean(run => Number(
        (run.scoring.checks.gold_file_precision ?? 0) === 1
        && (run.scoring.checks.unrelated_file_count ?? 0) === 0,
      )).toFixed(4)),
      mean_changed_files: Number(mean(run => run.patch?.changedFiles?.length ?? 0).toFixed(2)),
      mean_unrelated_files: Number(mean(run => run.scoring.checks.unrelated_file_count ?? 0).toFixed(2)),
      mean_retries: Number(mean(run => run.workflow.retryCount).toFixed(2)),
      mean_wall_clock_seconds: durations.length > 0
        ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2))
        : null,
      p95_wall_clock_seconds: p95Duration === null ? null : Number(p95Duration.toFixed(2)),
      mean_input_tokens: Number(mean(run => run.trace?.inputTokens ?? 0).toFixed(0)),
      mean_output_tokens: Number(mean(run => run.trace?.outputTokens ?? 0).toFixed(0)),
    };
  }
  const paired = variants.baseline && variants.candidate;
  const delta = paired
    ? Number((variants.candidate.mean_score - variants.baseline.mean_score).toFixed(4))
    : null;
  const pairedScoreOutcomes = { candidate_wins: 0, baseline_wins: 0, ties: 0, pairs: 0 };
  if (paired) {
    const baselineRuns = runs
      .filter(run => run.variant === 'baseline')
      .sort((left, right) => Number(left.repetition ?? 0) - Number(right.repetition ?? 0));
    const candidateRuns = runs
      .filter(run => run.variant === 'candidate')
      .sort((left, right) => Number(left.repetition ?? 0) - Number(right.repetition ?? 0));
    pairedScoreOutcomes.pairs = Math.min(baselineRuns.length, candidateRuns.length);
    for (let index = 0; index < pairedScoreOutcomes.pairs; index += 1) {
      const difference = candidateRuns[index].scoring.score - baselineRuns[index].scoring.score;
      if (difference > 0) pairedScoreOutcomes.candidate_wins += 1;
      else if (difference < 0) pairedScoreOutcomes.baseline_wins += 1;
      else pairedScoreOutcomes.ties += 1;
    }
  }
  const pairedDeltas = paired ? {
    mean_score: delta,
    mean_wall_clock_seconds: variants.baseline.mean_wall_clock_seconds === null
      || variants.candidate.mean_wall_clock_seconds === null
      ? null
      : Number((variants.candidate.mean_wall_clock_seconds - variants.baseline.mean_wall_clock_seconds).toFixed(2)),
    mean_input_tokens: variants.candidate.mean_input_tokens - variants.baseline.mean_input_tokens,
    mean_output_tokens: variants.candidate.mean_output_tokens - variants.baseline.mean_output_tokens,
  } : null;
  const inputTokenReduction = paired && variants.baseline.mean_input_tokens > 0
    ? (variants.baseline.mean_input_tokens - variants.candidate.mean_input_tokens) / variants.baseline.mean_input_tokens
    : null;
  const outputTokenReduction = paired && variants.baseline.mean_output_tokens > 0
    ? (variants.baseline.mean_output_tokens - variants.candidate.mean_output_tokens) / variants.baseline.mean_output_tokens
    : null;
  const p95RuntimeRatio = paired
    && variants.baseline.p95_wall_clock_seconds !== null
    && variants.baseline.p95_wall_clock_seconds > 0
    && variants.candidate.p95_wall_clock_seconds !== null
    ? variants.candidate.p95_wall_clock_seconds / variants.baseline.p95_wall_clock_seconds
    : null;
  return {
    variants,
    candidate_minus_baseline: delta,
    paired_score_outcomes: paired ? pairedScoreOutcomes : null,
    paired_deltas: pairedDeltas,
    observed_gate_checks: paired ? {
      hidden_oracle_non_regression: variants.candidate.hidden_oracle_rate >= variants.baseline.hidden_oracle_rate,
      scope_precision_non_regression: variants.candidate.mean_scope_precision >= variants.baseline.mean_scope_precision,
      p95_runtime_ratio: p95RuntimeRatio === null ? null : Number(p95RuntimeRatio.toFixed(4)),
      p95_runtime_within_1_5x: p95RuntimeRatio !== null && p95RuntimeRatio <= 1.5,
      mean_input_token_reduction: inputTokenReduction === null ? null : Number(inputTokenReduction.toFixed(4)),
      mean_output_token_reduction: outputTokenReduction === null ? null : Number(outputTokenReduction.toFixed(4)),
      token_reduction_at_least_20_percent: Math.max(inputTokenReduction ?? 0, outputTokenReduction ?? 0) >= 0.2,
    } : null,
    interpretation: repetitions < 3
      ? 'infrastructure-pilot-only'
      : 'replicated-directional-evidence',
    promotion_decision_allowed: repetitions >= 3 && Boolean(paired),
  };
}

export function rescoreStage3Report(report, benchmarkCase, rescoredAt = new Date().toISOString()) {
  const runs = report.runs.map(run => {
    const checks = run.scoring?.checks ?? {};
    return {
      ...run,
      scoring: scoreStage3Run({
        goldChangedFiles: benchmarkCase.goldChangedFiles,
        oraclePaths: benchmarkCase.oraclePaths,
        changedFiles: run.patch?.changedFiles ?? [],
        reachedApproval: checks.approval_gate_reached === true,
        workflowTestsPassed: checks.workflow_tests_passed === true,
        reviewPassed: checks.reviewer_passed === true,
        oraclePassed: checks.hidden_oracle_passed === true,
        traceCorrelated: checks.trace_correlated === true,
        remoteUnchanged: checks.remote_unchanged === true,
      }),
    };
  });
  const repetitions = Number(report.controls?.repetitions ?? 1);
  return {
    ...report,
    schema: 'argus.code-intelligence-stage3-evaluation.v2',
    rescoredAt,
    benchmark: {
      ...report.benchmark,
      goldChangedFiles: benchmarkCase.goldChangedFiles,
    },
    controls: {
      ...report.controls,
      scoringModel: 'stage3-v2-scope-aware',
    },
    summary: summarizeStage3Runs(runs, repetitions),
    runs,
  };
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${boundedText(diagnosticText(body?.error ?? text), 1_000)}`);
  }
  return body;
}

async function workspaceRequest(baseUrl, secret, route, body, timeoutMs = 60_000) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workspace-secret': secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return responseJson(response, `agent-workspace ${route}`);
}

async function workspaceExec(config, cwd, cmd, timeoutSec = 60) {
  const result = await workspaceRequest(config.workspaceUrl, config.workspaceSecret, '/exec', {
    cwd,
    cmd,
    timeoutSec,
  }, (timeoutSec + 30) * 1_000);
  return {
    stdout: String(result.stdout ?? '').replaceAll('\r\n', '\n'),
    stderr: String(result.stderr ?? '').replaceAll('\r\n', '\n'),
    exitCode: Number(result.exit_code ?? -1),
    truncated: result.truncated === true,
  };
}

async function workspaceWrite(config, target, content, encoding = 'utf-8') {
  return workspaceRequest(config.workspaceUrl, config.workspaceSecret, '/write', {
    path: target,
    content,
    encoding,
  });
}

async function workspaceRead(config, target, encoding = 'utf-8') {
  return workspaceRequest(config.workspaceUrl, config.workspaceSecret, '/read', {
    path: target,
    encoding,
  });
}

async function loadManifest(caseId) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (manifest.schema !== 'argus.code-intelligence-historical-benchmark.v1') {
    throw new Error('historical benchmark manifest has an unsupported schema');
  }
  const benchmarkCase = manifest.cases?.find(item => item.id === caseId);
  if (!benchmarkCase) throw new Error(`benchmark case '${caseId}' was not found`);
  for (const field of ['retrievalExpectedFiles', 'goldChangedFiles', 'oraclePaths', 'testCommand']) {
    if (!Array.isArray(benchmarkCase[field]) || benchmarkCase[field].length === 0) {
      throw new Error(`benchmark case '${caseId}' requires ${field}`);
    }
  }
  for (const file of [...benchmarkCase.goldChangedFiles, ...benchmarkCase.oraclePaths]) {
    if (!safeRelativeFile(file)) throw new Error(`benchmark path is unsafe: ${String(file)}`);
  }
  return { manifest, benchmarkCase };
}

async function prepareSeed(manifest, benchmarkCase) {
  const prepared = path.resolve('test-results/benchmarks/prepared', benchmarkCase.id);
  if (!existsSync(path.join(prepared, '.git'))) {
    throw new Error(`prepared history-free repository is missing; run: npm run benchmark:code-intelligence:prepare -- --case ${benchmarkCase.id}`);
  }
  const caseRoot = path.join(RESULT_ROOT, benchmarkCase.id);
  const seed = path.join(caseRoot, 'seed-repository');
  const metadataPath = path.join(caseRoot, 'seed-metadata.json');
  await mkdir(caseRoot, { recursive: true });
  if (!existsSync(path.join(seed, '.git'))) {
    const safePrepared = prepared.replaceAll('\\', '/');
    mustRun('git', ['-c', `safe.directory=${safePrepared}`, 'clone', '--no-local', prepared, seed], {}, 'benchmark seed clone');
  }
  let historyCommits = Number(mustRunInGitRepository(seed, ['rev-list', '--count', 'HEAD'], {}, 'count seed history'));
  if (historyCommits === 1) {
    // Resume safely when preparation was interrupted after cloning but before
    // the dependency-lock commit. The source commit itself stays immutable.
    if (!existsSync(path.join(seed, 'package-lock.json'))) {
      const npmCli = process.env.npm_execpath?.trim();
      if (!npmCli || !existsSync(npmCli)) {
        throw new Error('npm_execpath is required to generate the Stage-3 dependency lock');
      }
      mustRun(process.execPath, [npmCli, ...manifest.lockCommand.slice(1)], {
        cwd: seed,
        env: safeChildEnvironment({ npm_config_audit: 'false', npm_config_fund: 'false' }),
        timeout: 10 * 60 * 1_000,
      }, 'locked dependency manifest generation');
    }
    mustRunInGitRepository(seed, ['add', '-f', '--', 'package-lock.json'], {}, 'stage benchmark lock');
    mustRunInGitRepository(seed, [
      '-c', 'user.name=Argus Benchmark',
      '-c', 'user.email=benchmark@argus.local',
      'commit', '-m', `Add locked dependencies for ${benchmarkCase.id}`,
    ], {}, 'commit benchmark lock');
    historyCommits = 2;
  }
  const sourceSyntheticCommit = mustRunInGitRepository(seed, ['rev-parse', 'HEAD^'], {}, 'resolve synthetic source commit');
  const stage3Commit = mustRunInGitRepository(seed, ['rev-parse', 'HEAD'], {}, 'resolve Stage-3 seed commit');
  if (historyCommits !== 2) throw new Error('Stage-3 seed must contain exactly source + dependency-lock commits');
  const dirty = mustRunInGitRepository(seed, ['status', '--porcelain=v1'], {}, 'verify Stage-3 seed cleanliness');
  if (dirty) throw new Error(`Stage-3 seed contains uncommitted files: ${boundedText(dirty, 1_000)}`);
  const lock = await readFile(path.join(seed, 'package-lock.json'));
  const metadata = {
    schema: 'argus.code-intelligence-stage3-seed.v1',
    caseId: benchmarkCase.id,
    upstreamBaseCommit: benchmarkCase.baseCommit,
    sourceSyntheticCommit,
    stage3Commit,
    historyCommits,
    dependencyLockSha256: sha256(lock),
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { seed, caseRoot, metadata };
}

function hostGiteaUrl(configured) {
  const url = new URL(configured || 'http://127.0.0.1:3005');
  if (url.hostname === 'gitea') {
    url.hostname = '127.0.0.1';
    url.port = '3005';
  }
  return url.toString().replace(/\/$/u, '');
}

async function giteaRequest(config, route, init = {}) {
  const response = await fetch(`${config.giteaHostUrl}${route}`, {
    ...init,
    headers: {
      accept: 'application/json',
      Authorization: `token ${config.giteaToken}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  return response;
}

async function readGiteaBranch(config, route, label) {
  for (let attempt = 1; attempt <= GITEA_BRANCH_READ_ATTEMPTS; attempt += 1) {
    const response = await giteaRequest(config, route);
    if (response.ok) return responseJson(response, label);
    const retryable = [404, 500, 502, 503].includes(response.status);
    if (!retryable || attempt === GITEA_BRANCH_READ_ATTEMPTS) {
      return responseJson(response, label);
    }
    await response.arrayBuffer();
    process.stderr.write(`[stage3] ${label} returned HTTP ${response.status}; retrying (${attempt}/${GITEA_BRANCH_READ_ATTEMPTS})\n`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} exhausted its bounded retry budget`);
}

async function ensureRemoteRepository(config, seed, stage3Commit, caseId) {
  const encodedOwner = encodeURIComponent(config.giteaOwner);
  const encodedRepo = encodeURIComponent(config.giteaRepo);
  const route = `/api/v1/repos/${encodedOwner}/${encodedRepo}`;
  let response = await giteaRequest(config, route);
  let created = false;
  let repository = null;
  if (response.status === 404) {
    response = await giteaRequest(config, '/api/v1/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: config.giteaRepo,
        description: `History-minimized Argus Stage-3 benchmark seed for ${caseId}`,
        private: true,
        auto_init: false,
        default_branch: 'main',
      }),
    });
    repository = await responseJson(response, 'create Stage-3 Gitea repository');
    created = true;
  } else {
    repository = await responseJson(response, 'inspect Stage-3 Gitea repository');
  }

  const remote = `${config.giteaHostUrl}/${encodeURIComponent(config.giteaOwner)}/${encodeURIComponent(config.giteaRepo)}.git`;
  if (created || repository?.empty === true) {
    mustRunInGitRepository(seed, ['push', remote, 'HEAD:refs/heads/main'], {
      env: safeChildEnvironment({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: token ${config.giteaToken}`,
      }),
    }, 'push immutable Stage-3 seed');
  }
  const branch = await readGiteaBranch(config, `${route}/branches/main`, 'inspect Stage-3 main branch');
  const remoteCommit = String(branch.commit?.id ?? branch.commit?.commit?.id ?? '');
  if (remoteCommit !== stage3Commit) {
    throw new Error(`Stage-3 remote main is immutable and differs from the local seed (${remoteCommit || 'missing'} != ${stage3Commit})`);
  }
  return { created, remote, commit: remoteCommit };
}

async function ensureStage3Bundle(pool, config) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bundle = await client.query(
      `INSERT INTO mcp_service_bundles (name, label, description, icon)
       VALUES ($1, 'Argus.Dev Stage-3 Pino',
               'Isolated, history-minimized Gitea repository for repeatable Code Intelligence A/B evaluation.',
               'code')
       ON CONFLICT (name) DO UPDATE SET description=EXCLUDED.description, updated_at=NOW()
       RETURNING id`,
      [config.bundleName],
    );
    const backend = await client.query(
      `INSERT INTO mcp_backends (
         name, description, base_url, auth_type, auth_value, health_path,
         default_headers, timeout_ms, tls_skip_verify, enabled, backend_type,
         mcp_endpoint, builtin_key, config
       )
       SELECT $1,
              'Dedicated Gitea connection for the blinded Argus Stage-3 benchmark.',
              base_url, auth_type, auth_value, health_path, default_headers,
              timeout_ms, tls_skip_verify, true, backend_type, mcp_endpoint, NULL,
              config || jsonb_build_object('owner', $2::text, 'repo_slug', $3::text,
                                            'repo', $3::text, 'default_target_branch', 'main')
         FROM mcp_backends WHERE name='gitea_local'
       ON CONFLICT (name) DO UPDATE SET
         description=EXCLUDED.description, base_url=EXCLUDED.base_url,
         auth_type=EXCLUDED.auth_type, auth_value=EXCLUDED.auth_value,
         health_path=EXCLUDED.health_path, default_headers=EXCLUDED.default_headers,
         timeout_ms=EXCLUDED.timeout_ms, tls_skip_verify=EXCLUDED.tls_skip_verify,
         enabled=true, backend_type=EXCLUDED.backend_type, config=EXCLUDED.config,
         updated_at=NOW()
       RETURNING id`,
      [config.backendName, config.giteaOwner, config.giteaRepo],
    );
    if (!backend.rows[0]) throw new Error("local backend 'gitea_local' is required before Stage 3");
    const bundleId = Number(bundle.rows[0].id);
    const backendId = Number(backend.rows[0].id);
    await client.query(
      `INSERT INTO mcp_backend_bundles (backend_id, bundle_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [backendId, bundleId],
    );
    await client.query(
      `INSERT INTO mcp_bundle_backend_tool_policies (backend_id, bundle_id, mode, allowed_tool_names)
       VALUES ($1, $2, 'all', '{}')
       ON CONFLICT (backend_id, bundle_id) DO UPDATE SET mode='all', allowed_tool_names='{}', updated_at=NOW()`,
      [backendId, bundleId],
    );
    await client.query('COMMIT');
    return bundleId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function resolveGrantBundles(pool, bundleId) {
  const names = ['argus-code-intelligence-read', 'argus-code-intelligence-index'];
  const result = await pool.query('SELECT id, name FROM mcp_service_bundles WHERE name=ANY($1::text[])', [names]);
  const byName = new Map(result.rows.map(row => [row.name, Number(row.id)]));
  const missing = names.filter(name => !byName.has(name));
  if (missing.length) throw new Error(`required Code Intelligence bundles are missing: ${missing.join(', ')}`);
  return [bundleId, ...names.map(name => byName.get(name))];
}

async function startWorkflow(pool, issuer, config, benchmarkCase, bundleIds, variant) {
  const ticketId = `ARGUS-STAGE3-${randomBytes(6).toString('hex').toUpperCase()}`;
  const workspaceRoot = `/workspace/${ticketId}`;
  const rootTraceId = randomUUID();
  const messageId = randomUUID();
  const grant = await issuer.issue({
    packId: 'argus.dev',
    agentId: 'coding-orchestrator',
    principalKind: 'service',
    principalId: 'stage3-evaluation',
    principalAllowedBundleIds: null,
    requestedBundleIds: bundleIds,
    coreAgentNames: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'],
    messageId,
    rootTraceId,
    workspaceRoot,
    codeContextVariant: variant,
  });
  const spanId = randomBytes(8).toString('hex');
  const response = await fetch(`${config.langgraphUrl}/message:send`, {
    method: 'POST',
    headers: {
      ...A2A_HEADERS,
      traceparent: `00-${rootTraceId.replaceAll('-', '')}-${spanId}-01`,
      'x-argus-root-trace-id': rootTraceId,
      'x-argus-execution-grant': grant,
    },
    body: JSON.stringify({
      message: {
        messageId,
        role: 'ROLE_USER',
        parts: [{ data: {
          operation: 'workflow.start',
          workflowId: 'ticket-to-pull-request',
          input: { ticket_id: ticketId, description: benchmarkCase.ticket },
        } }],
        metadata: {
          argusRootTraceId: rootTraceId,
          argusPackId: 'argus.dev',
          argusAgentId: 'coding-orchestrator',
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await responseJson(response, 'start Stage-3 workflow');
  if (!body.task?.id) throw new Error('Stage-3 workflow returned no A2A task');
  return {
    ticketId,
    workspaceRoot,
    rootTraceId,
    taskId: String(body.task.id),
    workflowThreadId: String(body.task.metadata?.workflowThreadId ?? rootTraceId),
  };
}

function taskEvidence(task) {
  const artifact = Array.isArray(task.artifacts) ? task.artifacts[0] : null;
  const part = Array.isArray(artifact?.parts) ? artifact.parts[0] : null;
  return part?.data && typeof part.data === 'object' ? part.data : {};
}

async function pollTask(config, taskId, timeoutMinutes) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let lastState = '';
  const pollOnce = async () => {
    const response = await fetch(`${config.langgraphUrl}/tasks/${taskId}`, {
      method: 'GET',
      headers: { accept: A2A_HEADERS.accept, 'a2a-version': A2A_HEADERS['a2a-version'] },
      signal: AbortSignal.timeout(30_000),
    });
    const task = await responseJson(response, 'poll Stage-3 task');
    const state = String(task.status?.state ?? 'TASK_STATE_UNKNOWN');
    if (state !== lastState) {
      process.stderr.write(`[stage3] task=${taskId.slice(0, 8)} state=${state}\n`);
      lastState = state;
    }
    if (['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_FAILED', 'TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED'].includes(state)) {
      return { terminal: { task, state, evidence: taskEvidence(task) } };
    }
    return { terminal: null };
  };
  while (Date.now() < deadline) {
    const result = await pollOnce();
    if (result.terminal) return result.terminal;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  process.stderr.write(`[stage3] task=${taskId.slice(0, 8)} entered ${FINALIZATION_GRACE_MS / 1_000}s finalization grace\n`);
  const graceDeadline = Date.now() + FINALIZATION_GRACE_MS;
  while (Date.now() < graceDeadline) {
    const result = await pollOnce();
    if (result.terminal) return result.terminal;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  throw new Error(`Stage-3 task ${taskId} exceeded ${timeoutMinutes} minutes`);
}

async function captureWorkspace(config, workspaceRoot) {
  const [patch, names, numstat, status] = await Promise.all([
    workspaceExec(config, workspaceRoot, 'git diff --binary HEAD', 30),
    workspaceExec(config, workspaceRoot, 'git diff --name-only HEAD', 30),
    workspaceExec(config, workspaceRoot, 'git diff --numstat HEAD', 30),
    workspaceExec(config, workspaceRoot, 'git status --porcelain=v1 --untracked-files=all', 30),
  ]);
  for (const result of [patch, names, numstat, status]) {
    if (result.exitCode !== 0) throw new Error(`workspace evidence capture failed: ${boundedText(result.stderr, 1_000)}`);
    if (result.truncated) throw new Error('workspace evidence capture exceeded the bounded sidecar output');
  }
  const tracked = names.stdout.split('\n').map(value => value.trim()).filter(Boolean);
  const untracked = status.stdout.split('\n')
    .filter(line => line.startsWith('?? '))
    .map(line => line.slice(3).trim());
  const changedFiles = [...new Set([...tracked, ...untracked])];
  if (changedFiles.some(file => !safeRelativeFile(file))) throw new Error('workspace returned an unsafe changed path');
  return {
    patch: patch.stdout,
    patchSha256: sha256(patch.stdout),
    changedFiles,
    untracked,
    numstat: numstat.stdout.trim().split('\n').filter(Boolean).slice(0, 100),
    captureError: null,
  };
}

async function captureWorkspaceSafely(config, workspaceRoot) {
  try {
    return await captureWorkspace(config, workspaceRoot);
  } catch (error) {
    return {
      patch: '',
      patchSha256: sha256(''),
      changedFiles: [],
      untracked: [],
      numstat: [],
      captureError: boundedText(error instanceof Error ? error.message : String(error), 1_000),
    };
  }
}

async function oracleContents(upstream, benchmarkCase) {
  const safeUpstream = upstream.replaceAll('\\', '/');
  const files = new Map();
  for (const relative of benchmarkCase.oraclePaths) {
    const result = run('git', [
      '-c', `safe.directory=${safeUpstream}`,
      '-C', upstream,
      'show', `${benchmarkCase.fixCommit}:${relative}`,
    ]);
    if (result.status !== 0) {
      throw new Error(`could not load hidden oracle ${relative}: ${boundedText(result.stderr, 500)}`);
    }
    files.set(relative, result.stdout);
  }
  return files;
}

async function evaluateHiddenOracle(config, runIdentity, benchmarkCase, workspace, oracleFiles) {
  const evaluator = `/workspace/argus-stage3-eval-${runIdentity.taskId.slice(0, 12)}`;
  const patchPath = `/workspace/.argus-stage3/${runIdentity.taskId}.patch`;
  const add = await workspaceExec(
    config,
    '/workspace',
    `git -C ${shellQuote(runIdentity.workspaceRoot)} worktree add --detach ${shellQuote(evaluator)} HEAD`,
    120,
  );
  if (add.exitCode !== 0) throw new Error(`hidden evaluator worktree failed: ${boundedText(add.stderr, 1_000)}`);
  try {
    if (workspace.patch) {
      await workspaceWrite(config, patchPath, workspace.patch);
      const applied = await workspaceExec(config, evaluator, `git apply --binary --whitespace=nowarn ${shellQuote(patchPath)}`, 60);
      if (applied.exitCode !== 0) throw new Error(`agent patch could not be applied to evaluator: ${boundedText(applied.stderr, 1_000)}`);
    }
    for (const relative of workspace.untracked) {
      const source = await workspaceRead(config, `${runIdentity.workspaceRoot}/${relative}`, 'base64');
      await workspaceWrite(config, `${evaluator}/${relative}`, String(source.content ?? ''), 'base64');
    }
    for (const [relative, contents] of oracleFiles) {
      await workspaceWrite(config, `${evaluator}/${relative}`, contents);
    }
    const link = await workspaceExec(
      config,
      '/workspace',
      `if [ -d ${shellQuote(`${runIdentity.workspaceRoot}/node_modules`)} ]; then ln -s ${shellQuote(`${runIdentity.workspaceRoot}/node_modules`)} ${shellQuote(`${evaluator}/node_modules`)}; fi`,
      30,
    );
    if (link.exitCode !== 0) throw new Error(`dependency link failed: ${boundedText(link.stderr, 1_000)}`);
    const command = benchmarkCase.testCommand.map(shellQuote).join(' ');
    const test = await workspaceExec(config, evaluator, command, 300);
    return {
      passed: test.exitCode === 0,
      exitCode: test.exitCode,
      stdout: boundedText(test.stdout, 12_000),
      stderr: boundedText(test.stderr, 12_000),
      evaluator,
    };
  } finally {
    const remove = await workspaceExec(
      config,
      '/workspace',
      `git -C ${shellQuote(runIdentity.workspaceRoot)} worktree remove --force ${shellQuote(evaluator)}`,
      60,
    );
    if (remove.exitCode !== 0) {
      process.stderr.write(`[stage3] warning: evaluator cleanup failed: ${boundedText(remove.stderr, 300)}\n`);
    }
  }
}

async function traceEvidence(pool, rootTraceId, variant) {
  const traceResult = await pool.query(
    `SELECT id, name, kind, status, duration_ms, input_tokens, output_tokens, metadata
       FROM mcp_observability_traces
      WHERE root_trace_id=$1::uuid
      ORDER BY started_at, id`,
    [rootTraceId],
  );
  const traces = traceResult.rows.map(row => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    retrievalVariant: row.metadata?.retrieval_variant ?? row.metadata?.code_context_variant ?? null,
    agentName: row.metadata?.agent_name ?? null,
  }));
  const spanResult = await pool.query(
    `SELECT s.id, s.name, s.kind, s.status, s.duration_ms, s.metadata
       FROM mcp_observability_spans s
       JOIN mcp_observability_traces t ON t.id=s.trace_id
      WHERE t.root_trace_id=$1::uuid
      ORDER BY s.started_at, s.id`,
    [rootTraceId],
  );
  const spans = spanResult.rows.map(row => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    retrievalVariant: row.metadata?.retrieval_variant ?? null,
  }));
  const contexts = spans.filter(row => row.name === 'code_intelligence.context');
  return {
    correlated: traces.length > 0 && contexts.length >= 1
      && contexts.every(row => row.retrievalVariant === variant),
    traceCount: traces.length,
    spanCount: spans.length,
    codeContextCount: contexts.length,
    inputTokens: traces.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: traces.reduce((sum, row) => sum + row.outputTokens, 0),
    traces,
    codeContextSpans: contexts,
  };
}

async function verifyRemoteInvariant(config, expectedCommit) {
  const route = `/api/v1/repos/${encodeURIComponent(config.giteaOwner)}/${encodeURIComponent(config.giteaRepo)}`;
  const [branch, branchesResponse] = await Promise.all([
    readGiteaBranch(config, `${route}/branches/main`, 'verify Stage-3 main branch'),
    giteaRequest(config, `${route}/branches?limit=50`),
  ]);
  const branches = await responseJson(branchesResponse, 'verify Stage-3 branch list');
  const commit = String(branch.commit?.id ?? branch.commit?.commit?.id ?? '');
  const names = Array.isArray(branches) ? branches.map(item => String(item.name ?? '')) : [];
  return { unchanged: commit === expectedCommit && names.length === 1 && names[0] === 'main', commit, branches: names };
}

async function cancelTask(config, taskId) {
  const response = await fetch(`${config.langgraphUrl}/tasks/${taskId}:cancel`, {
    method: 'POST',
    headers: A2A_HEADERS,
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  return responseJson(response, 'cancel Stage-3 task after evidence capture');
}

async function executeRun(pool, issuer, config, benchmarkCase, seedMetadata, bundleIds, variant, repetition, oracleFiles) {
  process.stderr.write(`[stage3] repetition=${repetition + 1} variant=${variant} starting\n`);
  const startedAt = new Date().toISOString();
  const identity = await startWorkflow(pool, issuer, config, benchmarkCase, bundleIds, variant);
  let cancellation = null;
  let projected = null;
  try {
    projected = await pollTask(config, identity.taskId, config.timeoutMinutes);
    const evidence = projected.evidence;
    const reachedApproval = projected.state === 'TASK_STATE_INPUT_REQUIRED'
      && evidence.currentStage === 'human_approval';
    const workspace = await captureWorkspaceSafely(config, identity.workspaceRoot);
    const admission = stage3EvidenceAdmission(workspace);
    if (!admission.admitted) {
      throw new Error(
        `Stage-3 evidence rejected (${admission.reasons.join(', ')}): ${admission.generatedInfrastructureFiles.join(', ') || workspace.captureError}`,
      );
    }
    const oracle = reachedApproval
      ? await evaluateHiddenOracle(config, identity, benchmarkCase, workspace, oracleFiles)
      : { passed: false, exitCode: null, stdout: '', stderr: 'workflow did not reach the code approval gate', evaluator: null };
    const trace = await traceEvidence(pool, identity.rootTraceId, variant);
    const remote = await verifyRemoteInvariant(config, seedMetadata.stage3Commit);
    const scoring = scoreStage3Run({
      goldChangedFiles: benchmarkCase.goldChangedFiles,
      oraclePaths: benchmarkCase.oraclePaths,
      changedFiles: workspace.changedFiles,
      reachedApproval,
      workflowTestsPassed: evidence.testsPassed === true,
      reviewPassed: evidence.reviewPassed === true,
      oraclePassed: oracle.passed,
      traceCorrelated: trace.correlated,
      remoteUnchanged: remote.unchanged,
    });
    return {
      variant,
      repetition: repetition + 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...identity,
      a2aState: projected.state,
      workflow: {
        currentStage: evidence.currentStage ?? null,
        testsPassed: evidence.testsPassed === true,
        reviewPassed: evidence.reviewPassed === true,
        retryCount: Number(evidence.retryCount ?? 0),
        planPresent: typeof evidence.plan === 'string' && evidence.plan.trim().length > 0,
        reviewPresent: typeof evidence.review === 'string' && evidence.review.trim().length > 0,
        testOutput: boundedText(evidence.testOutput ?? '', 8_000),
      },
      patch: {
        sha256: workspace.patchSha256,
        bytes: Buffer.byteLength(workspace.patch, 'utf8'),
        changedFiles: workspace.changedFiles,
        numstat: workspace.numstat,
        captureError: workspace.captureError,
      },
      oracle,
      trace,
      remote,
      scoring,
    };
  } finally {
    try {
      const shouldCancel = projected === null || projected.state === 'TASK_STATE_INPUT_REQUIRED';
      if (shouldCancel) cancellation = await cancelTask(config, identity.taskId);
      const traceStatus = shouldCancel
        ? 'cancelled'
        : projected?.state === 'TASK_STATE_COMPLETED'
          ? 'completed'
          : 'failed';
      await issuer.finalizeRootTrace(identity.rootTraceId, traceStatus, {
        evaluation: 'code-intelligence-stage3',
        variant,
        stoppedAt: projected?.evidence?.currentStage ?? 'runner_cleanup',
      });
    } catch (error) {
      process.stderr.write(`[stage3] warning: task cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    void cancellation;
  }
}

function required(name, fallback = '') {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required for Stage 3`);
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseStage3Options(argv);
  const { manifest, benchmarkCase } = await loadManifest(options.caseId);
  if (argv.includes('--rescore-report')) {
    const caseRoot = path.join(RESULT_ROOT, benchmarkCase.id);
    const reportPath = path.join(caseRoot, stage3ReportFilename(options.reportTag));
    const existing = JSON.parse(await readFile(reportPath, 'utf8'));
    if (!Array.isArray(existing.runs) || existing.benchmark?.caseId !== benchmarkCase.id) {
      throw new Error('existing Stage-3 report does not match the selected benchmark case');
    }
    if (existing.schema === 'argus.code-intelligence-stage3-evaluation.v1') {
      await writeFile(
        path.join(caseRoot, options.reportTag
          ? `evaluation-report-${options.reportTag}.raw-v1.json`
          : 'evaluation-report.raw-v1.json'),
        `${JSON.stringify(existing, null, 2)}\n`,
        'utf8',
      );
    }
    const rescored = rescoreStage3Report(existing, benchmarkCase);
    await writeFile(reportPath, `${JSON.stringify(rescored, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
      schema: rescored.schema,
      report: path.relative(process.cwd(), reportPath).replaceAll('\\', '/'),
      summary: rescored.summary,
    }, null, 2)}\n`);
    return;
  }
  const prepared = await prepareSeed(manifest, benchmarkCase);
  const reportPath = path.join(prepared.caseRoot, stage3ReportFilename(options.reportTag));
  const partialPath = path.join(prepared.caseRoot, stage3PartialFilename(options.reportTag));
  const resumePath = existsSync(partialPath) ? partialPath : reportPath;
  const resume = options.resumeReport
    ? stage3ResumeState(JSON.parse(await readFile(resumePath, 'utf8')), options, benchmarkCase.id)
    : { runs: [], completedRepetitions: 0 };
  const config = {
    databaseUrl: required('POSTGRES_CONNECTION_URL'),
    signingSecret: required('ARGUS_EXECUTION_GRANT_SECRET', process.env.WORKSPACE_SECRET?.trim()),
    workspaceSecret: required('WORKSPACE_SECRET'),
    workspaceUrl: (process.env.ARGUS_STAGE3_WORKSPACE_URL?.trim() || 'http://127.0.0.1:3001').replace(/\/$/u, ''),
    langgraphUrl: (process.env.ARGUS_STAGE3_LANGGRAPH_URL?.trim() || 'http://127.0.0.1:2025').replace(/\/$/u, ''),
    giteaToken: required('GITEA_TOKEN'),
    giteaOwner: process.env.GITEA_OWNER?.trim() || 'argus',
    giteaHostUrl: hostGiteaUrl(process.env.GITEA_BASE_URL?.trim()),
    giteaRepo: `argus-stage3-${benchmarkCase.id}`.slice(0, 100),
    bundleName: `argus-dev-stage3-${benchmarkCase.id}`.slice(0, 128),
    backendName: `gitea_stage3_${sha256(benchmarkCase.id).slice(0, 12)}`,
    timeoutMinutes: options.timeoutMinutes,
  };
  if (Buffer.byteLength(config.signingSecret, 'utf8') < 32) {
    throw new Error('Stage-3 execution-grant signing secret must contain at least 32 bytes');
  }

  const upstream = path.resolve('test-results/benchmarks/pino-upstream');
  if (!existsSync(path.join(upstream, '.git'))) throw new Error('Pino upstream benchmark clone is missing');
  const oracleFiles = await oracleContents(upstream, benchmarkCase);
  const remote = await ensureRemoteRepository(
    config,
    prepared.seed,
    prepared.metadata.stage3Commit,
    benchmarkCase.id,
  );
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const issuer = new ExecutionGrantIssuer(pool, config.signingSecret);
  const runs = resume.runs;
  try {
    const bundleId = await ensureStage3Bundle(pool, config);
    const bundleIds = await resolveGrantBundles(pool, bundleId);
    for (let repetition = resume.completedRepetitions; repetition < options.repetitions; repetition += 1) {
      for (const variant of stage3VariantOrder(repetition, options.variants)) {
        if (runs.some(run => run.repetition === repetition + 1 && run.variant === variant)) {
          process.stderr.write(`[stage3] repetition=${repetition + 1} variant=${variant} already captured; skipping\n`);
          continue;
        }
        const result = await executeRun(
          pool,
          issuer,
          config,
          benchmarkCase,
          prepared.metadata,
          bundleIds,
          variant,
          repetition,
          oracleFiles,
        );
        runs.push(result);
        await writeFile(partialPath, `${JSON.stringify({
          schema: 'argus.code-intelligence-stage3-evaluation.v2',
          partial: true,
          benchmark: { caseId: benchmarkCase.id },
          controls: { variants: options.variants, repetitions: options.repetitions },
          runs,
        }, null, 2)}\n`, 'utf8');
      }
    }
    const report = {
      schema: 'argus.code-intelligence-stage3-evaluation.v2',
      generatedAt: new Date().toISOString(),
      benchmark: {
        id: manifest.id,
        caseId: benchmarkCase.id,
        cohort: benchmarkCase.cohort,
        category: benchmarkCase.category,
        repository: manifest.repository.key,
        sourceUrl: benchmarkCase.sourceUrl,
        pullRequestUrl: benchmarkCase.pullRequestUrl,
        seed: prepared.metadata,
        hiddenOraclePaths: benchmarkCase.oraclePaths,
        goldChangedFiles: benchmarkCase.goldChangedFiles,
      },
      controls: {
        variants: options.variants,
        repetitions: options.repetitions,
        order: 'alternating-paired',
        runtime: 'configured Argus Core agent runtime profiles',
        historyMinimized: true,
        remoteMainImmutable: true,
        stoppedBeforePush: true,
        oracleWithheldUntilApproval: true,
        modelVisibleVariantLabel: false,
        externalNetworkForAgent: false,
        scoringModel: 'stage3-v2-scope-aware',
        reportTag: options.reportTag,
        resumedFromRepetitions: resume.completedRepetitions,
      },
      environment: {
        giteaRepository: `${config.giteaOwner}/${config.giteaRepo}`,
        giteaRemoteCreated: remote.created,
        bundleName: config.bundleName,
      },
      summary: summarizeStage3Runs(runs, options.repetitions),
      runs,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
      schema: report.schema,
      report: path.relative(process.cwd(), reportPath).replaceAll('\\', '/'),
      summary: report.summary,
      runs: runs.map(run => ({
        variant: run.variant,
        score: run.scoring.score,
        approval: run.scoring.checks.approval_gate_reached,
        hiddenOracle: run.scoring.checks.hidden_oracle_passed,
        rootTraceId: run.rootTraceId,
        taskId: run.taskId,
      })),
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`[stage3] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
