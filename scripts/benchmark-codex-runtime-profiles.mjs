import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const PACK_ID = 'argus.dev';
const PACK_AGENT_ID = 'coding-orchestrator';
const WORKFLOW_ID = 'ticket-to-pull-request';
const TARGET_AGENTS = ['planner', 'knowledge', 'coder', 'reviewer'];
const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);
const BENCHMARK_LOCK_ID = 2_175_305_323;
const RESULT_ROOT = path.resolve('test-results/benchmarks/codex-runtime-profiles');

export const DEFAULT_PROFILES = [
  { key: 'spark', name: 'codex-subscription-local' },
  { key: 'deep', name: 'codex-subscription-deep' },
];

export const DEFAULT_TASKS = [
  {
    id: 'docs-only',
    level: 'easy',
    expectedFiles: ['docs/runtime-profile-benchmark.md'],
    description: [
      'Create docs/runtime-profile-benchmark.md.',
      "Its first line must be '# Runtime Profile Benchmark' and it must contain the exact sentence 'This file is used by the local Argus runtime-profile benchmark.'.",
      'Do not modify any other file or dependency.',
    ].join(' '),
  },
  {
    id: 'readiness-endpoint',
    level: 'normal',
    expectedFiles: ['src/app.js', 'test/app.test.js'],
    description: [
      "Add a Kubernetes-style GET /ready endpoint that returns HTTP 200 and exactly { status: 'ready', service: 'argus-dev-sample' } as JSON.",
      'Add focused automated coverage in test/app.test.js while preserving every existing endpoint contract.',
      'Do not add dependencies or modify unrelated files.',
    ].join(' '),
  },
  {
    id: 'default-tier-cross-file',
    level: 'complex',
    expectedFiles: ['README.md', 'src/app.js', 'src/server.js', 'test/app.test.js'],
    description: [
      'Add optional DEFAULT_SERVICE_TIER configuration across the service.',
      'createApp must accept an optional defaultTier option; GET /api/services uses an explicit tier query parameter first, otherwise the configured default, and still returns all services when neither exists.',
      "Unknown non-empty tiers must return HTTP 400 with exactly { error: 'invalid_tier', tier: '<value>' }.",
      'src/server.js must pass DEFAULT_SERVICE_TIER into createApp, tests must cover the default, explicit override, invalid tier, and existing behavior, and README.md must document the variable.',
      'Do not add dependencies or modify unrelated files.',
    ].join(' '),
  },
];

function databaseUrl() {
  const user = process.env.POSTGRES_USER?.trim() || 'aiops';
  const password = process.env.POSTGRES_PASSWORD?.trim();
  const database = process.env.POSTGRES_DB?.trim() || 'aiops';
  const port = process.env.POSTGRES_PORT?.trim() || '5432';
  if (!password) throw new Error('POSTGRES_PASSWORD is required');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function integerOption(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function parseBenchmarkOptions(argv = []) {
  const valueAfter = flag => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const taskValue = valueAfter('--tasks');
  const profileValue = valueAfter('--profiles');
  const resumeValue = valueAfter('--resume-reports');
  const reportTag = valueAfter('--report-tag') ?? null;
  if (reportTag && !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(reportTag)) {
    throw new Error('--report-tag must contain 2-64 lowercase letters, digits, or hyphens');
  }
  const taskIds = taskValue ? taskValue.split(',').map(value => value.trim()).filter(Boolean) : DEFAULT_TASKS.map(task => task.id);
  const profiles = profileValue ? profileValue.split(',').map(value => value.trim()).filter(Boolean) : DEFAULT_PROFILES.map(profile => profile.key);
  const knownTasks = new Set(DEFAULT_TASKS.map(task => task.id));
  const knownProfiles = new Set(DEFAULT_PROFILES.map(profile => profile.key));
  const unknownTasks = taskIds.filter(id => !knownTasks.has(id));
  const unknownProfiles = profiles.filter(key => !knownProfiles.has(key));
  if (unknownTasks.length > 0) throw new Error(`Unknown benchmark tasks: ${unknownTasks.join(', ')}`);
  if (unknownProfiles.length > 0) throw new Error(`Unknown benchmark profiles: ${unknownProfiles.join(', ')}`);
  if (new Set(taskIds).size !== taskIds.length || new Set(profiles).size !== profiles.length) {
    throw new Error('Benchmark tasks and profiles must not contain duplicates');
  }
  return {
    taskIds,
    profiles,
    timeoutMinutes: integerOption(valueAfter('--timeout-minutes'), 20, 2, 30, '--timeout-minutes'),
    reportTag,
    dryRun: argv.includes('--dry-run'),
    resumeReports: resumeValue ? resumeValue.split(',').map(value => value.trim()).filter(Boolean) : [],
  };
}

export function profileOrder(taskIndex, profiles) {
  return taskIndex % 2 === 0 ? [...profiles] : [...profiles].reverse();
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function recordsWithin(value, maxRecords = 4_000) {
  const records = [];
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0 && records.length < maxRecords) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    records.push(current);
    for (const item of Object.values(current)) pending.push(item);
  }
  return records;
}

function workflowEvidenceWithin(task) {
  return recordsWithin(task).find(candidate => (
    candidate.workflowId === WORKFLOW_ID
    && typeof candidate.currentStage === 'string'
    && Array.isArray(candidate.fileDiffs)
  )) ?? null;
}

function responseDetail(body) {
  return typeof body?.code === 'string' ? body.code
    : typeof body?.error === 'string' ? body.error
      : typeof body?.message === 'string' ? body.message.slice(0, 400)
        : 'unknown';
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON status ${response.status}`);
  }
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${responseDetail(body)}`);
  return body;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function assertLoopback(url, label) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} must use a loopback host for this local benchmark`);
  }
  return parsed.toString().replace(/\/$/u, '');
}

async function resolveBundleIds(pool) {
  const names = ['argus-code-intelligence-read', 'argus-dev-demo'];
  const result = await pool.query(
    `SELECT id, name FROM mcp_service_bundles WHERE name=ANY($1::text[])`,
    [names],
  );
  const byName = new Map(result.rows.map(row => [row.name, Number(row.id)]));
  const missing = names.filter(name => !byName.has(name));
  if (missing.length > 0) throw new Error(`Required bundles are unavailable: ${missing.join(', ')}`);
  return names.map(name => byName.get(name));
}

async function resolveProfiles(pool, profileKeys) {
  const definitions = profileKeys.map(key => DEFAULT_PROFILES.find(profile => profile.key === key));
  const names = definitions.map(profile => profile.name);
  const result = await pool.query(
    `SELECT id, name, label, runtime_type, auth_mode, model, reasoning_effort, enabled
       FROM mcp_agent_runtime_profiles
      WHERE name=ANY($1::text[])`,
    [names],
  );
  const byName = new Map(result.rows.map(row => [row.name, row]));
  return definitions.map(definition => {
    const row = byName.get(definition.name);
    if (!row) throw new Error(`Runtime profile '${definition.name}' is missing`);
    if (!row.enabled || row.runtime_type !== 'codex' || row.auth_mode !== 'chatgpt' || !row.model) {
      throw new Error(`Runtime profile '${definition.name}' is not an enabled Codex ChatGPT profile with a model`);
    }
    return { ...definition, ...row, id: Number(row.id) };
  });
}

async function captureAgentAssignments(pool) {
  const result = await pool.query(
    `SELECT id, name, runtime_profile_id
       FROM mcp_agents
      WHERE name=ANY($1::text[])
      ORDER BY name`,
    [TARGET_AGENTS],
  );
  const present = new Set(result.rows.map(row => row.name));
  const missing = TARGET_AGENTS.filter(name => !present.has(name));
  if (missing.length > 0) throw new Error(`Required Core agents are missing: ${missing.join(', ')}`);
  return result.rows.map(row => ({
    id: Number(row.id),
    name: row.name,
    runtimeProfileId: row.runtime_profile_id === null ? null : Number(row.runtime_profile_id),
  }));
}

async function assignProfile(pool, profileId) {
  const result = await pool.query(
    `UPDATE mcp_agents
        SET runtime_profile_id=$1, updated_at=now()
      WHERE name=ANY($2::text[])
      RETURNING name, runtime_profile_id`,
    [profileId, TARGET_AGENTS],
  );
  if (result.rowCount !== TARGET_AGENTS.length) {
    throw new Error(`Only ${result.rowCount} of ${TARGET_AGENTS.length} benchmark agents were assigned`);
  }
}

async function verifyAssignedProfile(pool, profile) {
  const result = await pool.query(
    `SELECT a.name, a.runtime_profile_id, p.name AS profile_name, p.model
       FROM mcp_agents a
       LEFT JOIN mcp_agent_runtime_profiles p ON p.id=a.runtime_profile_id
      WHERE a.name=ANY($1::text[])
      ORDER BY a.name`,
    [TARGET_AGENTS],
  );
  const mismatches = result.rows.filter(row => (
    Number(row.runtime_profile_id) !== profile.id
    || row.profile_name !== profile.name
    || row.model !== profile.model
  ));
  if (result.rowCount !== TARGET_AGENTS.length || mismatches.length > 0) {
    throw new Error(`Database did not retain runtime profile '${profile.name}' for every benchmark agent`);
  }
  return result.rows.map(row => ({ agent: row.name, profile: row.profile_name, model: row.model }));
}

async function restoreAssignments(pool, assignments) {
  await pool.query('BEGIN');
  try {
    for (const assignment of assignments) {
      await pool.query(
        `UPDATE mcp_agents SET runtime_profile_id=$1, updated_at=now() WHERE id=$2`,
        [assignment.runtimeProfileId, assignment.id],
      );
    }
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function createAdminSession(pool) {
  const admin = await pool.query(
    `SELECT id, username FROM mcp_users
      WHERE enabled=true AND role='platform_admin'
      ORDER BY id LIMIT 1`,
  );
  if (!admin.rows[0]) throw new Error('No enabled local platform administrator exists');
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO mcp_sessions (id,user_id,expires_at,ip_address,user_agent)
     VALUES ($1,$2,now()+interval '4 hours','127.0.0.1','codex-runtime-profile-benchmark')`,
    [sessionId, admin.rows[0].id],
  );
  return { sessionId, username: admin.rows[0].username, cookie: `argus_session=${sessionId}` };
}

async function remoteHeadSha() {
  const port = process.env.GITEA_PORT?.trim() || '3005';
  const owner = process.env.GITEA_OWNER?.trim() || 'argus';
  const token = process.env.GITEA_TOKEN?.trim();
  if (!token) throw new Error('GITEA_TOKEN is required to prove the benchmark remote stays immutable');
  const baseUrl = assertLoopback(`http://127.0.0.1:${port}`, 'Gitea URL');
  const response = await fetch(`${baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/argus-dev-sample/branches/main`, {
    headers: { authorization: `token ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await responseJson(response, 'Gitea main-branch lookup');
  const sha = body?.commit?.id;
  if (typeof sha !== 'string' || sha.length < 7) throw new Error('Gitea branch response did not contain a commit SHA');
  return sha;
}

async function waitForTask(baseUrl, cookie, taskId, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  const taskUrl = `${baseUrl}/api/admin/solution-packs/${PACK_ID}/agents/${PACK_AGENT_ID}/a2a/tasks/${taskId}`;
  let previousMarker = '';
  let latest = null;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Benchmark interrupted');
    const body = await responseJson(await fetch(taskUrl, { headers: { cookie }, signal }), 'benchmark task status');
    latest = body.task;
    const state = String(latest?.status?.state ?? 'unknown');
    const evidence = workflowEvidenceWithin(latest);
    const marker = `${state}:${String(evidence?.currentStage ?? 'starting')}`;
    if (marker !== previousMarker) {
      emit({ event: 'task-status', taskId, state, stage: evidence?.currentStage ?? 'starting' });
      previousMarker = marker;
    }
    if (state === 'TASK_STATE_INPUT_REQUIRED' || TERMINAL_STATES.has(state)) return latest;
    await sleep(3_000);
  }
  throw new Error(`Task ${taskId} exceeded the ${Math.round(timeoutMs / 60_000)} minute benchmark timeout`);
}

async function cancelTask(baseUrl, headers, taskId) {
  return responseJson(await fetch(
    `${baseUrl}/api/admin/solution-packs/${PACK_ID}/agents/${PACK_AGENT_ID}/a2a/tasks/${taskId}/cancel`,
    { method: 'POST', headers, body: '{}' },
  ), 'benchmark task cancellation');
}

async function traceEvidence(pool, rootTraceId) {
  const result = await pool.query(
    `SELECT trace.id, trace.provider, trace.model, trace.status, trace.duration_ms,
            trace.input_tokens, trace.output_tokens, trace.total_cost_usd, trace.metadata,
            agent.name AS agent_name
       FROM mcp_observability_traces trace
       LEFT JOIN mcp_agents agent ON agent.id=trace.agent_id
      WHERE trace.root_trace_id=$1::uuid AND trace.kind='agent'
      ORDER BY trace.started_at, trace.id`,
    [rootTraceId],
  );
  const rows = result.rows.filter(row => TARGET_AGENTS.includes(row.agent_name));
  return {
    agents: rows.map(row => ({
      traceId: row.id,
      agent: row.agent_name,
      provider: row.provider,
      model: row.model,
      status: row.status,
      durationMs: Number(row.duration_ms ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      costUsd: Number(row.total_cost_usd ?? 0),
      runtimeProfileName: row.metadata?.runtime_profile_name ?? null,
    })),
    inputTokens: rows.reduce((sum, row) => sum + Number(row.input_tokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + Number(row.output_tokens ?? 0), 0),
    agentDurationMs: rows.reduce((sum, row) => sum + Number(row.duration_ms ?? 0), 0),
    costUsd: rows.reduce((sum, row) => sum + Number(row.total_cost_usd ?? 0), 0),
  };
}

export function scoreBenchmarkRun(run) {
  const expected = new Set(run.expectedFiles ?? []);
  const actual = new Set(run.changedFiles ?? []);
  const expectedRecall = expected.size === 0 ? 1 : [...expected].filter(file => actual.has(file)).length / expected.size;
  const scopePrecision = actual.size === 0 ? 0 : [...actual].filter(file => expected.has(file)).length / actual.size;
  const modelMatch = TARGET_AGENTS.every(agent => (
    run.trace?.agents?.some(trace => trace.agent === agent && trace.model === run.expectedModel && trace.status === 'completed')
  )) && !run.trace?.agents?.some(trace => TARGET_AGENTS.includes(trace.agent) && trace.model !== run.expectedModel);
  const checks = {
    approvalGateReached: run.stage === 'human_approval' && run.taskState === 'TASK_STATE_INPUT_REQUIRED',
    testsPassed: run.testsPassed === true,
    reviewPassed: run.reviewPassed === true,
    expectedFileRecall: expectedRecall,
    scopePrecision,
    modelMatch,
    remoteUnchanged: run.remoteBefore === run.remoteAfter,
  };
  const score = (
    (checks.approvalGateReached ? 0.25 : 0)
    + (checks.testsPassed ? 0.20 : 0)
    + (checks.reviewPassed ? 0.15 : 0)
    + checks.expectedFileRecall * 0.15
    + checks.scopePrecision * 0.10
    + (checks.modelMatch ? 0.10 : 0)
    + (checks.remoteUnchanged ? 0.05 : 0)
  );
  return { score: Number(score.toFixed(4)), checks };
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

export function summarizeBenchmark(runs) {
  const byProfile = Object.fromEntries([...new Set(runs.map(run => run.profile))].map(profile => {
    const matching = runs.filter(run => run.profile === profile);
    return [profile, {
      runs: matching.length,
      successfulRuns: matching.filter(run => run.scoring?.score === 1).length,
      meanScore: mean(matching.map(run => run.scoring?.score)),
      meanWallDurationMs: mean(matching.map(run => run.wallDurationMs)),
      meanInputTokens: mean(matching.map(run => run.trace?.inputTokens)),
      meanOutputTokens: mean(matching.map(run => run.trace?.outputTokens)),
      totalRetries: matching.reduce((sum, run) => sum + Number(run.retryCount ?? 0), 0),
    }];
  }));
  const comparisons = [...new Set(runs.map(run => run.taskId))].map(taskId => {
    const pair = runs.filter(run => run.taskId === taskId);
    const ranked = [...pair].sort((left, right) => (
      (right.scoring?.score ?? 0) - (left.scoring?.score ?? 0)
      || (left.wallDurationMs ?? Number.MAX_SAFE_INTEGER) - (right.wallDurationMs ?? Number.MAX_SAFE_INTEGER)
      || (left.trace?.inputTokens ?? Number.MAX_SAFE_INTEGER) - (right.trace?.inputTokens ?? Number.MAX_SAFE_INTEGER)
    ));
    return { taskId, observedWinner: ranked[0]?.profile ?? null, profiles: Object.fromEntries(pair.map(run => [run.profile, {
      score: run.scoring?.score ?? 0,
      wallDurationMs: run.wallDurationMs ?? null,
      inputTokens: run.trace?.inputTokens ?? null,
      outputTokens: run.trace?.outputTokens ?? null,
      retryCount: run.retryCount ?? null,
    }])) };
  });
  return {
    interpretation: 'single-pair-local-pilot',
    promotionDecisionAllowed: false,
    note: 'One pair per task is directional evidence only; repeat before changing production routing policy.',
    profiles: byProfile,
    comparisons,
  };
}

async function loadResumeRuns(reportPaths, selectedTaskIds, selectedProfiles) {
  const allowedRoot = `${RESULT_ROOT.toLowerCase()}${path.sep}`;
  const imported = [];
  const sources = [];
  for (const reportPath of reportPaths) {
    const resolved = path.resolve(reportPath);
    if (!resolved.toLowerCase().startsWith(allowedRoot)) {
      throw new Error(`Resume report must be inside ${path.relative(process.cwd(), RESULT_ROOT)}`);
    }
    const report = JSON.parse(await readFile(resolved, 'utf8'));
    if (report?.schema !== 'argus.codex-runtime-profile-benchmark.v1' || !Array.isArray(report.runs)) {
      throw new Error(`Resume report '${reportPath}' is not a Codex runtime-profile benchmark v1 report`);
    }
    sources.push(path.relative(process.cwd(), resolved).replaceAll('\\', '/'));
    for (const run of report.runs) {
      if (!selectedTaskIds.includes(run?.taskId) || !selectedProfiles.includes(run?.profile)) continue;
      if (run?.scoring?.score !== 1 || run?.scoring?.checks?.modelMatch !== true
        || run?.scoring?.checks?.remoteUnchanged !== true) continue;
      const existingIndex = imported.findIndex(candidate => (
        candidate.taskId === run.taskId && candidate.profile === run.profile
      ));
      if (existingIndex >= 0) imported.splice(existingIndex, 1);
      imported.push({ ...run, importedFrom: sources.at(-1) });
    }
  }
  return { runs: imported, sources };
}

async function executeArm({ pool, baseUrl, headers, cookie, bundleIds, task, profile, timeoutMs, signal }) {
  const startedAt = new Date();
  const ticketId = `RUNTIME-BENCH-${task.id}-${profile.key}-${Date.now().toString(36)}`.toUpperCase().slice(0, 120);
  const remoteBefore = await remoteHeadSha();
  let taskId = null;
  let rootTraceId = null;
  let projectedTask = null;
  let error = null;
  let cancellationState = null;
  try {
    await assignProfile(pool, profile.id);
    const assignedProfiles = await verifyAssignedProfile(pool, profile);
    emit({ event: 'profiles-assigned', benchmarkTask: task.id, profile: profile.key, assignedProfiles });
    const messageUrl = `${baseUrl}/api/admin/solution-packs/${PACK_ID}/agents/${PACK_AGENT_ID}/a2a/message`;
    const launched = await responseJson(await fetch(messageUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: `Run the local ${task.level} runtime-profile benchmark through ${WORKFLOW_ID}.`,
        data: {
          operation: 'workflow.start',
          workflowId: WORKFLOW_ID,
          input: {
            ticket_id: ticketId,
            description: [
              task.description,
              'Run relevant repository checks and review the implementation.',
              'Stop at the first Argus human approval gate.',
              'Do not commit, push, open a pull request, merge, deploy, or change credentials.',
            ].join(' '),
          },
        },
        execution: { bundleIds, runtimeMode: 'default' },
      }),
      signal,
    }), 'runtime-profile benchmark launch');
    taskId = launched.task?.id ?? null;
    rootTraceId = launched.rootTraceId ?? null;
    if (!taskId || !rootTraceId) throw new Error('Benchmark launch returned no task or root trace ID');
    emit({
      event: 'launched', benchmarkTask: task.id, profile: profile.key, model: profile.model,
      taskId, rootTraceId, logsUrl: `${baseUrl}/observe/logs?root_trace=${rootTraceId}`,
    });
    projectedTask = await waitForTask(baseUrl, cookie, taskId, timeoutMs, signal);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (taskId && (!projectedTask || projectedTask.status?.state === 'TASK_STATE_INPUT_REQUIRED')) {
      try {
        const cancellation = await cancelTask(baseUrl, headers, taskId);
        cancellationState = cancellation.task?.status?.state ?? null;
      } catch (cause) {
        error = `${error ? `${error}; ` : ''}cleanup: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
  }
  if (rootTraceId) await sleep(750);
  const trace = rootTraceId ? await traceEvidence(pool, rootTraceId) : { agents: [], inputTokens: 0, outputTokens: 0, agentDurationMs: 0, costUsd: 0 };
  const evidence = workflowEvidenceWithin(projectedTask);
  const remoteAfter = await remoteHeadSha();
  const finishedAt = new Date();
  const run = {
    taskId: task.id,
    level: task.level,
    profile: profile.key,
    runtimeProfileName: profile.name,
    expectedModel: profile.model,
    reasoningEffort: profile.reasoning_effort,
    ticketId,
    a2aTaskId: taskId,
    rootTraceId,
    logsUrl: rootTraceId ? `${baseUrl}/observe/logs?root_trace=${rootTraceId}` : null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallDurationMs: finishedAt.getTime() - startedAt.getTime(),
    taskState: projectedTask?.status?.state ?? null,
    cancellationState,
    stage: evidence?.currentStage ?? null,
    changedFiles: Array.isArray(evidence?.fileDiffs) ? evidence.fileDiffs.map(diff => diff.path).filter(Boolean).sort() : [],
    expectedFiles: [...task.expectedFiles].sort(),
    testsPassed: evidence?.testsPassed === true,
    reviewPassed: evidence?.reviewPassed === true,
    retryCount: Number(evidence?.retryCount ?? 0),
    remoteBefore,
    remoteAfter,
    trace,
    error,
  };
  run.scoring = scoreBenchmarkRun(run);
  emit({
    event: 'arm-complete', task: task.id, profile: profile.key, score: run.scoring.score,
    durationMs: run.wallDurationMs, tokens: trace.inputTokens + trace.outputTokens,
    retries: run.retryCount, error,
  });
  return run;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseBenchmarkOptions(argv);
  const selectedTasks = options.taskIds.map(id => DEFAULT_TASKS.find(task => task.id === id));
  const selectedProfileDefs = options.profiles.map(key => DEFAULT_PROFILES.find(profile => profile.key === key));
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ options, tasks: selectedTasks, profiles: selectedProfileDefs }, null, 2)}\n`);
    return;
  }

  const baseUrl = assertLoopback(process.env.ARGUS_BASE_URL?.trim() || 'http://127.0.0.1:3000', 'ARGUS_BASE_URL');
  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let locked = false;
  let session = null;
  let assignments = null;
  let runs = [];
  let resumedFrom = [];
  try {
    const lock = await pool.query('SELECT pg_try_advisory_lock($1) AS acquired', [BENCHMARK_LOCK_ID]);
    locked = lock.rows[0]?.acquired === true;
    if (!locked) throw new Error('Another Codex runtime-profile benchmark is already running');
    assignments = await captureAgentAssignments(pool);
    const profiles = await resolveProfiles(pool, options.profiles);
    const resumed = await loadResumeRuns(options.resumeReports, options.taskIds, options.profiles);
    runs = resumed.runs;
    resumedFrom = resumed.sources;
    session = await createAdminSession(pool);
    const bundleIds = await resolveBundleIds(pool);
    emit({
      event: 'benchmark-ready', operator: session.username, tasks: options.taskIds,
      profiles: profiles.map(profile => ({ key: profile.key, name: profile.name, model: profile.model })),
      originalAssignments: assignments,
    });
    for (let taskIndex = 0; taskIndex < selectedTasks.length; taskIndex += 1) {
      const task = selectedTasks[taskIndex];
      const order = profileOrder(taskIndex, options.profiles);
      for (const profileKey of order) {
        if (runs.some(run => run.taskId === task.id && run.profile === profileKey)) {
          emit({ event: 'arm-resumed', task: task.id, profile: profileKey });
          continue;
        }
        if (abortController.signal.aborted) throw new Error('Benchmark interrupted');
        const profile = profiles.find(candidate => candidate.key === profileKey);
        try {
          const run = await executeArm({
            pool,
            baseUrl,
            headers: { cookie: session.cookie, origin: baseUrl, 'content-type': 'application/json' },
            cookie: session.cookie,
            bundleIds,
            task,
            profile,
            timeoutMs: options.timeoutMinutes * 60_000,
            signal: abortController.signal,
          });
          runs.push(run);
        } finally {
          await restoreAssignments(pool, assignments);
        }
      }
    }
    const generatedAt = new Date().toISOString();
    const report = {
      schema: 'argus.codex-runtime-profile-benchmark.v1',
      generatedAt,
      controls: {
        localOnly: true,
        pairedAlternatingOrder: true,
        repetitionsPerTaskAndProfile: 1,
        workflowId: WORKFLOW_ID,
        runtimeMode: 'default',
        stoppedBeforeApproval: true,
        remoteMainImmutable: true,
        profilesRestored: true,
        resumedFrom,
      },
      tasks: selectedTasks,
      profiles: profiles.map(profile => ({
        key: profile.key,
        name: profile.name,
        label: profile.label,
        model: profile.model,
        reasoningEffort: profile.reasoning_effort,
      })),
      summary: summarizeBenchmark(runs),
      runs,
    };
    await mkdir(RESULT_ROOT, { recursive: true });
    const timestamp = generatedAt.replace(/[:.]/gu, '-');
    const filename = `${timestamp}${options.reportTag ? `-${options.reportTag}` : ''}.json`;
    const reportPath = path.join(RESULT_ROOT, filename);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
      ok: runs.every(run => run.scoring.score === 1),
      report: path.relative(process.cwd(), reportPath).replaceAll('\\', '/'),
      summary: report.summary,
      runs: runs.map(run => ({
        task: run.taskId,
        profile: run.profile,
        score: run.scoring.score,
        durationMs: run.wallDurationMs,
        inputTokens: run.trace.inputTokens,
        outputTokens: run.trace.outputTokens,
        retries: run.retryCount,
        rootTraceId: run.rootTraceId,
        error: run.error,
      })),
    }, null, 2)}\n`);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (assignments) await restoreAssignments(pool, assignments).catch(error => {
      process.stderr.write(`[runtime-benchmark] CRITICAL: failed to restore agent profiles: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
    if (session) await pool.query('DELETE FROM mcp_sessions WHERE id=$1', [session.sessionId]).catch(() => undefined);
    if (locked) await pool.query('SELECT pg_advisory_unlock($1)', [BENCHMARK_LOCK_ID]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`[runtime-benchmark] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
