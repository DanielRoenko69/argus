/** Real Argus.Dev HTTP + PostgreSQL + LangGraph; fake Core/workspace/runtime only. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import pg from 'pg';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, label) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}

const containerName = `argus-dev-codegen-recovery-${randomUUID().slice(0, 8)}`;
const secret = `disposable-${randomUUID()}`;
const threadId = randomUUID(), oldRunId = randomUUID(), root = '/workspace/CODEGEN-RECOVERY-CERT';
const baseCommitSha = 'a'.repeat(40), sourceSha256 = 'b'.repeat(64), brokerRequestSha256 = 'c'.repeat(64);
const outputPath = 'frontend/src/client/types.gen.ts';
const changedPaths = ['backend/app/api/routes/items.py', 'backend/tests/api/routes/test_items.py',
  'frontend/src/components/Common/DataTable.tsx', 'frontend/src/routes/_layout/items.tsx',
  'frontend/tests/admin.spec.ts', 'frontend/tests/items.spec.ts', 'frontend/tests/utils/privateApi.ts'];
const allowedPaths = [...changedPaths, outputPath];
const plan = { version: 1, summary: 'Regenerate the client', setup: 'true', start: '', generate: 'generate-client', outputPaths: [outputPath] };
const decision = { version: 1, status: 'ready', plan };
const summary = '[codegen_source_changed] recorded import stop';
const token = (jti, messageId, now = Math.floor(Date.now() / 1000)) => 'eg_v1.' + Buffer.from(JSON.stringify({
  v: 1, iss: 'argus.core', aud: 'argus.dev', agent: 'coding-orchestrator', jti,
  principalKind: 'user', principalId: '3', bundleIds: [47], coreAgentIds: [2], coreAgents: [{ id: 2, name: 'reviewer' }],
  messageId, rootTraceId: threadId, workspaceRoot: root, testEnvironmentPolicy: 'workspace-session-v1',
  codeGeneration: { version: 1, allowedPaths: [outputPath] }, iat: now, exp: now + 3600,
})).toString('base64url') + '.fixture-only';
const oldGrantId = randomUUID(), oldGrant = token(oldGrantId, randomUUID(), Math.floor(Date.now() / 1000) - 7200);
let recoveryPreviewCalls = 0, recoveryCalls = 0, runtimeCalls = 0, lastRecoveryRequest;
let pendingRuntime = [], serverLog = '';
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  const reply = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url?.startsWith('/api/internal/telemetry/')) return reply({ ok: true });
  if (req.url === '/api/internal/dev-git/47/reference' || req.url?.includes('/bundle-creds/')) return reply({
    kind: 'gitea', base_url: 'http://fixture.invalid', token: req.url.includes('/bundle-creds/') ? 'fresh-fixture-token' : null,
    project_key: 'fixture', user_slug: '', repo_slug: 'repo', target_branch: 'main',
    reference: { version: 1, bundleId: 47, backendId: 1, binding: 'd'.repeat(64) },
    config: { owner: 'fixture', repo: 'repo', target_branch: 'main' },
  });
  if (req.url === '/api/internal/agent-runtimes') return reply({ coder: { agentId: 2, runtimeType: 'codex', profileId: 1,
    profileEnabled: true, model: 'fixture', codeContextMode: 'metadata_only' } });
  if (req.url?.endsWith('/code-index')) return reply({ error: 'not configured in fixture' }, 404);
  if (req.url === '/claude/status') return reply({ runs: [] });
  if (req.url === '/codex/status') return reply({ enabled: true, authenticated: true, authMethod: 'fixture', runs: [] });
  if (req.url === '/exec') {
    let stdout = '';
    if (body.cmd === 'git rev-parse HEAD') stdout = baseCommitSha;
    else if (body.cmd === 'git remote get-url origin') stdout = 'http://fixture.invalid/fixture/repo.git';
    else if (body.cmd.startsWith('git status')) stdout = changedPaths.map(path => ` M ${path}`).join('\n') + '\n';
    else if (body.cmd.includes('git hash-object')) stdout = 'e'.repeat(40);
    else return reply({ error: `Unexpected command: ${body.cmd}` }, 400);
    return reply({ stdout, stderr: '', exit_code: 0 });
  }
  if ((req.url === '/stack-tests' || req.url === '/api/agents/2/stack-tests') && body.action === 'inspect')
    return reply({ sourceSha256, files: 8, excludedFiles: 0, python: true });
  if (req.url === '/code-generation/recovery-preview') {
    recoveryPreviewCalls += 1; lastRecoveryRequest = body;
    return reply({ version: 1, recoveryDigest: 'f'.repeat(64), requestSha256: hash(body), sourceSha256,
      planSha256: hash(body.plan), brokerRequestSha256 });
  }
  if (req.url === '/api/agents/2/code-generation/recover') {
    recoveryCalls += 1;
    const { recoveryDigest: _, ...input } = body;
    assert.equal(req.headers.authorization?.startsWith('Bearer eg_v1.'), true);
    assert.equal(input.executionMode, 'workspace-session-v1');
    assert.ok(lastRecoveryRequest);
    return reply({ version: 1, threadId, requestSha256: hash(lastRecoveryRequest), basisSha256: input.basisSha256,
      sourceSha256: input.sourceSha256, resultSourceSha256: '1'.repeat(64), planSha256: hash(input.plan),
      brokerRequestSha256, baseImage: 'sha256:' + '2'.repeat(64), applied: true, executionMode: 'workspace-session-v1',
      outputs: [{ path: outputPath, beforeSha256: '3'.repeat(64), sha256: '4'.repeat(64) }], finishedAt: new Date().toISOString() });
  }
  if (req.url === '/codex/run') { runtimeCalls += 1; pendingRuntime.push({ res, body }); return; }
  return reply({ error: 'Unexpected fixture request', path: req.url }, 404);
});

let child, pool, saver, created = false;
try {
  execFileSync('docker', ['run', '--rm', '-d', '--name', containerName, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=codegen_recovery_cert', 'postgres:16-alpine'], { stdio: 'pipe' });
  created = true;
  const databasePort = execFileSync('docker', ['port', containerName, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  const databaseUrl = `postgresql://postgres@127.0.0.1:${databasePort}/codegen_recovery_cert`;
  pool = new pg.Pool({ connectionString: databaseUrl });
  await until(() => pool.query('SELECT 1').then(() => true).catch(() => false), 'disposable database');
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const launch = () => {
    const process = spawn('node', ['dist/server.js'], { env: { ...globalThis.process.env, NODE_ENV: 'test', PORT: String(port),
      POSTGRES_CONNECTION_URL: databaseUrl, ARGUS_URL: mockUrl, AGENT_WORKSPACE_URL: mockUrl, WORKSPACE_SECRET: secret,
      CODER_AGENT_ID: '2', REVIEWER_AGENT_ID: '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.on('data', data => { serverLog = (serverLog + data).slice(-12_000); });
    process.stderr.on('data', data => { serverLog = (serverLog + data).slice(-12_000); });
    return process;
  };
  child = launch(); await until(() => fetch(base + '/healthz').then(response => response.ok).catch(() => false), 'Argus.Dev startup');
  process.env.POSTGRES_CONNECTION_URL = databaseUrl;
  const { codingWorkflow, codingCheckpointer } = await import('../dist/workflows/coding.js'); saver = codingCheckpointer;
  await pool.query(`INSERT INTO argus_langgraph_threads(thread_id,graph_id,status,error,metadata) VALUES ($1,'coding_workflow','interrupted',NULL,$2)`,
    [threadId, { source: 'a2a', execution_principal: 'user:3', execution_grant_id: oldGrantId, execution_bundle_ids: [47] }]);
  await pool.query(`INSERT INTO argus_langgraph_runs(run_id,thread_id,kind,payload,status,error) VALUES ($1,$2,'input','{}','failed','original import stop')`, [oldRunId, threadId]);
  const log = ['setup_workspace', 'planner', 'knowledge', 'test_design', 'generation_plan', 'coder', 'code_generation']
    .map(step => ({ step, traceId: randomUUID(), ...(step === 'code_generation' ? { summary } : {}) }));
  const config = { configurable: { thread_id: threadId } };
  await codingWorkflow.updateState(config, {
    ticket_id: 'CODEGEN-RECOVERY-CERT', description: 'Retain completed work', plan: 'SAVED PLAN', context: 'SAVED KNOWLEDGE',
    qa_test_plan: 'SAVED QA', code: 'SAVED CODER RESULT', workspace_dir: root, argus_workspace_root: root,
    argus_execution_grant: oldGrant, argus_bundle_id: 47, argus_bundle_ids: [47], base_commit_sha: baseCommitSha,
    repository_scope_policy: 'development-v1', repository: 'fixture/repo', allowed_files: allowedPaths.join('\n'),
    bitbucket_creds: { kind: 'gitea', base_url: 'http://fixture.invalid', project_key: 'fixture', user_slug: '', repo_slug: 'repo',
      target_branch: 'main', token: null, reference: { version: 1, bundleId: 47, backendId: 1, binding: 'd'.repeat(64) } },
    qa_acceptance_policy_version: 1, qa_environment_policy_version: 3, code_generation_policy_version: 1,
    code_generation_decision: decision, code_generation_receipt: null, code_generation_failure: null,
    qa_artifact: null, qa_receipt: null, stack_plan: null, stack_result: null, workflow_blockers: [summary],
    qa_history: [{ phase: 'generation_plan' }, { phase: 'code_generation_rejected', code: 'codegen_source_changed' }], log,
    tests_passed: false, review_passed: false, retry_count: 0, fix_applied: false, human_approved: false, pr_approved: false,
    branch_pushed: false, pr_url: '', test_output: '', review: '', fix_output: '',
  }, 'code_generation');
  const request = async (path, body) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-secret': secret },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const path = `/threads/${threadId}/checkpoint-retry`;
  const preview = (await request(path)).body;
  assert.equal(preview.available, true, preview.reason); assert.equal(preview.node, 'code_generation');
  assert.equal(recoveryCalls, 0); assert.equal(runtimeCalls, 0, 'preview cannot dispatch recovery or runtime');
  const messageId = randomUUID(), freshGrant = token(randomUUID(), messageId);
  const submit = { checkpointId: preview.checkpointId, workspaceDigest: preview.workspaceDigest, grant: freshGrant, messageId };
  assert.equal((await request(path, { ...submit, workspaceDigest: '0'.repeat(64) })).status, 409);
  assert.equal(recoveryCalls, 0, 'stale preview cannot consume saved output');
  const responses = await Promise.all([request(path, submit), request(path, submit)]);
  assert.deepEqual(responses.map(result => result.status).sort(), [202, 409]);
  try {
    await until(() => recoveryCalls === 1 && runtimeCalls === 1, 'recovery and next workflow phase');
  } catch (error) {
    const graphState = await codingWorkflow.getState(config);
    console.error(JSON.stringify({ recoveryPreviewCalls, recoveryCalls, runtimeCalls,
      graph: { next: graphState.next, blockers: graphState.values.workflow_blockers,
        recoveryCount: graphState.values.code_generation_recovery_count, receipt: graphState.values.code_generation_receipt,
        log: graphState.values.log?.slice(-3) },
      thread: (await pool.query('SELECT status,error,metadata FROM argus_langgraph_threads WHERE thread_id=$1', [threadId])).rows[0],
      runs: (await pool.query('SELECT kind,status,error FROM argus_langgraph_runs WHERE thread_id=$1 ORDER BY created_at', [threadId])).rows }));
    throw error;
  }
  assert.ok(recoveryPreviewCalls >= 3); assert.equal(recoveryCalls, 1);
  assert.equal(pendingRuntime[0].body.taskType, 'review');
  assert.equal(pendingRuntime.some(call => ['plan', 'implement_ticket'].includes(call.body.taskType)), false);
  const saved = await codingWorkflow.getState(config);
  assert.equal(saved.values.plan, 'SAVED PLAN'); assert.equal(saved.values.context, 'SAVED KNOWLEDGE');
  assert.equal(saved.values.qa_test_plan, 'SAVED QA'); assert.equal(saved.values.code, 'SAVED CODER RESULT');
  assert.equal(saved.values.code_generation_recovery_count, 1); assert.equal(saved.values.code_generation_receipt.applied, true);
  assert.equal(saved.values.workflow_blockers.length, 0); assert.equal(saved.values.human_approved, false); assert.equal(saved.values.pr_approved, false);
  assert.equal((await pool.query('SELECT error FROM argus_langgraph_runs WHERE run_id=$1', [oldRunId])).rows[0].error, 'original import stop');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  for (const pending of pendingRuntime) pending.res.destroy(); pendingRuntime = [];
  child = launch(); await until(() => fetch(base + '/healthz').then(response => response.ok).catch(() => false), 'Argus.Dev restart');
  await sleep(300);
  assert.equal(recoveryCalls, 1, 'restart never repeats the consumed import');
  assert.equal(runtimeCalls, 1, 'restart never repeats an uncertain next Agent call');
  console.log('PASS: real HTTP/Postgres/LangGraph code-generation import recovery; preview is read-only, stale and duplicate submissions fail closed, saved Plan/Knowledge/QA/Coder are retained, one verified import advances to environment tests, approvals stay false, and restart never replays import or Agent calls.');
} catch (error) { console.error(serverLog); throw error; }
finally {
  for (const pending of pendingRuntime) pending.res.destroy();
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  if (saver) await saver.end(); if (pool) await pool.end();
  if (created) execFileSync('docker', ['stop', containerName], { stdio: 'pipe' });
}
