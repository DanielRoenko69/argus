/** Real Pack HTTP + PostgreSQL + LangGraph, fake Core/workspace/workers only.
 * Never uses the live Argus database, repositories, credentials or model APIs. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import pg from 'pg';

const name = `argus-dev-checkpoint-cert-${randomUUID().slice(0, 8)}`;
const secret = `disposable-${randomUUID()}`;
const preQa = process.argv.includes('--pre-qa-expiry');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, label) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
const workerId = randomUUID(), threadId = randomUUID(), oldRunId = randomUUID();
const root = '/workspace/CHECKPOINT-CERT';
let activeWorker = false, workspaceHash = 'a'.repeat(40), missingWorkspace = false, dirtyWorkspace = false;
const plannerTrace = randomUUID(), knowledgeTrace = randomUUID();
const calls = [], commands = [], credentialGrants = [], pending = [];
let receipts = [{ id: workerId, cwd: root, finishedAt: new Date().toISOString() }];
const token = (jti, messageId, now = Math.floor(Date.now() / 1000)) => 'eg_v1.' + Buffer.from(JSON.stringify({
  v: 1, iss: 'argus.core', aud: 'argus.dev', agent: 'coding-orchestrator', jti, principalKind: 'user', principalId: '3',
  bundleIds: [47], coreAgentIds: [2], messageId, rootTraceId: threadId, workspaceRoot: root, iat: now, exp: now + 3600,
})).toString('base64url') + '.fixture-only';
const oldGrantId = randomUUID(); const oldGrant = token(oldGrantId, randomUUID(), Math.floor(Date.now() / 1000) - 7200);
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  const reply = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url.startsWith('/api/internal/telemetry/')) return reply({ ok: true });
  if (req.url === '/api/internal/dev-git/47/reference') {
    credentialGrants.push(req.headers.authorization);
    return reply({ kind: 'gitea', base_url: 'http://fixture.invalid', token: null, project_key: 'fixture', user_slug: '',
      repo_slug: 'repo', target_branch: 'main', reference: { version: 1, bundleId: 47, backendId: 1, binding: 'b'.repeat(64) } });
  }
  if (req.url.includes('/bundle-creds/')) {
    credentialGrants.push(req.headers.authorization);
    return reply({ kind: 'gitea', base_url: 'http://fixture.invalid', token: 'fresh-fixture-credential', config: { owner: 'fixture', repo: 'repo', target_branch: 'main' } });
  }
  if (req.url === '/api/internal/agent-runtimes') return reply({ coder: { agentId: 2, runtimeType: 'codex', profileId: 1, profileEnabled: true, model: 'fixture', codeContextMode: 'metadata_only' } });
  if (req.url.endsWith('/code-index')) return reply({ error: 'Fixture has no index' }, 404);
  if (req.url === '/claude/status') return reply({ runs: [] });
  if (req.url === '/codex/status') return reply({ enabled: true, authenticated: true, authMethod: 'fixture', runs: [
    ...receipts, ...(activeWorker ? [{ id: randomUUID(), cwd: root }] : []),
  ] });
  if (req.url === '/exec') {
    commands.push(body.cmd);
    if (missingWorkspace) return reply({ stdout: '', stderr: 'missing', exit_code: 1 });
    let stdout = '';
    if (body.cmd === 'git rev-parse HEAD') stdout = 'a'.repeat(40);
    else if (body.cmd === 'git remote get-url origin') stdout = 'http://fixture.invalid/fixture/repo.git';
    else if (body.cmd.startsWith('git status')) stdout = preQa && !dirtyWorkspace ? '' : ' M src/model.py\n?? tests/test_model.py\n';
    else if (body.cmd.includes('git hash-object')) stdout = workspaceHash;
    else return reply({ error: `Unexpected command: ${body.cmd}` }, 400);
    return reply({ stdout, stderr: '', exit_code: 0 });
  }
  if (req.url === '/codex/run') { calls.push(body); pending.push(res); return; }
  return reply({ error: 'Unexpected fixture request', path: req.url }, 404);
});
let child, pool, created = false, saver;
let serverLog = '';
try {
  execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=checkpoint_cert', 'postgres:16-alpine'], { stdio: 'pipe' });
  created = true;
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  const dbUrl = `postgresql://postgres@127.0.0.1:${dbPort}/checkpoint_cert`;
  pool = new pg.Pool({ connectionString: dbUrl });
  await until(() => pool.query('SELECT 1').then(() => true).catch(() => false), 'disposable DB');
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const launch = () => {
    const proc = spawn('node', ['dist/server.js'], { env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port),
      POSTGRES_CONNECTION_URL: dbUrl, ARGUS_URL: mockUrl, AGENT_WORKSPACE_URL: mockUrl, WORKSPACE_SECRET: secret, CODER_AGENT_ID: '2', REVIEWER_AGENT_ID: '2' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', data => { serverLog = (serverLog + data).slice(-12_000); });
    proc.stderr.on('data', data => { serverLog = (serverLog + data).slice(-12_000); }); return proc;
  };
  child = launch(); await until(() => fetch(base + '/healthz').then(r => r.ok).catch(() => false), 'Pack startup');
  // Seed a real saved QA-design checkpoint, not mocked graph state.
  process.env.POSTGRES_CONNECTION_URL = dbUrl;
  const { codingWorkflow, codingCheckpointer } = await import('../dist/workflows/coding.js'); saver = codingCheckpointer;
  await pool.query(`INSERT INTO argus_langgraph_threads(thread_id,graph_id,status,error,metadata) VALUES ($1,'coding_workflow','failed',$2,$3)`,
    [threadId, preQa ? 'Argus code index authorization failed (401): {"error":"execution grant is expired or has an invalid lifetime","code":"execution_grant_expired"}'
      : `Codex runtime request failed (run ${workerId}, implement_ticket): fetch failed`, {
      source: 'a2a', execution_principal: 'user:3', execution_grant_id: oldGrantId, execution_bundle_ids: [47],
    }]);
  await pool.query(`INSERT INTO argus_langgraph_runs(run_id,thread_id,kind,payload,status,error) VALUES ($1,$2,'input','{}','failed','original timeout')`, [oldRunId, threadId]);
  if (preQa) {
    await pool.query(`CREATE TABLE mcp_observability_traces (id uuid PRIMARY KEY, root_trace_id uuid, kind text, status text)`);
    await pool.query(`INSERT INTO mcp_observability_traces VALUES ($1,$3,'agent','completed'),($2,$3,'agent','completed')`, [plannerTrace, knowledgeTrace, threadId]);
  }
  const cfg = { configurable: { thread_id: threadId } };
  await codingWorkflow.updateState(cfg, { ticket_id: 'CHECKPOINT-CERT', description: 'Retain prior work', plan: 'SAVED PLAN', context: 'SAVED KNOWLEDGE', qa_test_plan: 'SAVED QA',
    workspace_dir: root, argus_workspace_root: root, argus_execution_grant: oldGrant, argus_bundle_id: 47, argus_bundle_ids: [47],
    base_commit_sha: 'a'.repeat(40), repository_scope_policy: 'development-v1', repository: 'fixture/repo',
    bitbucket_creds: { kind: 'gitea', base_url: 'http://fixture.invalid', project_key: 'fixture', user_slug: '', repo_slug: 'repo', target_branch: 'main', token: null,
      reference: { version: 1, bundleId: 47, backendId: 1, binding: 'b'.repeat(64) } },
    ...(preQa ? { qa_acceptance_policy_version: 1, qa_test_plan: '',
      log: [{ step: 'setup_workspace' }, { step: 'planner', traceId: plannerTrace }, { step: 'knowledge', traceId: knowledgeTrace }] } : {}),
  }, preQa ? 'knowledge' : 'test_design');
  const request = async (path, body) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-workspace-secret': secret },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const path = `/threads/${threadId}/checkpoint-retry`;
  const preview = (await request(path)).body; assert.equal(preview.available, true, preview.reason); assert.equal(preview.node, preQa ? 'test_design' : 'coder');
  assert.equal(calls.length, 0, 'preview cannot invoke models');
  activeWorker = true; assert.equal((await request(path)).body.available, false); activeWorker = false;
  missingWorkspace = true; assert.equal((await request(path)).body.available, false); missingWorkspace = false;
  const messageId = randomUUID(), fresh = token(randomUUID(), messageId);
  const body = { checkpointId: preview.checkpointId, workspaceDigest: preview.workspaceDigest, grant: fresh, messageId };
  assert.equal((await request(path, { ...body, checkpointId: randomUUID() })).status, 409);
  if (preQa) {
    dirtyWorkspace = true; assert.equal((await request(path, body)).status, 409); dirtyWorkspace = false;
    const unexpected = randomUUID(); await pool.query(`INSERT INTO mcp_observability_traces VALUES ($1,$2,'agent','failed')`, [unexpected, threadId]);
    assert.equal((await request(path)).body.available, false);
    await pool.query('DELETE FROM mcp_observability_traces WHERE id=$1', [unexpected]);
  } else { workspaceHash = 'b'.repeat(40); assert.equal((await request(path, body)).status, 409); workspaceHash = 'a'.repeat(40); }
  assert.equal((await request(`/threads/${threadId}/runs`, { retry_failed: true })).status, 409, 'raw bypass is closed');
  const responses = await Promise.all([request(path, body), request(path, body)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [202, 409], 'double submit queues exactly once');
  await until(() => calls.length > 0, 'resumed Coder');
  assert.equal(calls.length, 1); assert.equal(calls[0].taskType, preQa ? 'review' : 'implement_ticket');
  assert.match(calls[0].prompt, /SAVED PLAN/);
  if (!preQa) { assert.match(calls[0].prompt, /SAVED KNOWLEDGE/); assert.match(calls[0].prompt, /SAVED QA/); }
  assert.ok(commands.every(command => !/clone|reset|checkout|commit|push|clean/.test(command)), 'no destructive workspace or external delivery commands');
  assert.ok(credentialGrants.length >= 2 && credentialGrants.every(value => value === `Bearer ${fresh}`), 'all credential refreshes use fresh authority');
  const saved = await codingWorkflow.getState(cfg);
  assert.equal(saved.values.plan, 'SAVED PLAN'); assert.equal(saved.values.context, 'SAVED KNOWLEDGE'); assert.equal(saved.values.qa_test_plan, preQa ? '' : 'SAVED QA');
  assert.equal(saved.values.argus_execution_grant, fresh); assert.equal(saved.values.bitbucket_creds.token, null);
  assert.equal(saved.values.bitbucket_creds.reference.binding, 'b'.repeat(64));
  assert.equal(saved.values.human_approved, false); assert.equal(saved.values.branch_pushed, false);
  assert.equal((await pool.query('SELECT status,error FROM argus_langgraph_runs WHERE run_id=$1', [oldRunId])).rows[0].error, 'original timeout');
  if (preQa) {
    assert.equal(saved.values.qa_acceptance_policy_version, 1);
    assert.equal(saved.values.retry_count, 0); assert.equal(saved.values.code, '');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    for (const response of pending) response.destroy();
    child = launch(); await until(() => fetch(base + '/healthz').then(r => r.ok).catch(() => false), 'Pack restart');
    assert.equal((await request(path)).body.available, false, 'a now-uncertain QA invocation cannot use pre-dispatch recovery');
    assert.equal(calls.length, 1, 'no model replay after crash');
    console.log('PASS: pre-QA grant expiry recovery through real HTTP/Postgres/LangGraph; exact QA entry, saved plan/knowledge/policy/budgets, clean checkout and only two completed traces required, duplicate submit serialized, original failure retained, uncertain QA crash never replayed. Fake provider, no real model calls.');
  } else {
  // Capture a trusted terminal receipt at failure, then expire the worker's
  // recent-run cache. A future operator must still be able to resume safely.
  receipts = [{ id: calls[0].runId, cwd: root, finishedAt: new Date().toISOString() }];
  pending[0].destroy();
  await until(async () => {
    const row = (await pool.query('SELECT status,metadata FROM argus_langgraph_threads WHERE thread_id=$1', [threadId])).rows[0];
    return row.status === 'failed' && row.metadata.checkpoint_worker_receipt?.id === calls[0].runId;
  }, 'persisted terminal receipt');
  receipts = [];
  const retainedPreview = (await request(path)).body;
  assert.equal(retainedPreview.available, true, 'persisted receipt survives runtime history expiration');
  assert.equal(retainedPreview.node, 'coder');
  activeWorker = true; assert.equal((await request(path)).body.available, false, 'saved proof never overrides an active worker'); activeWorker = false;
  const secondMessage = randomUUID(), secondGrant = token(randomUUID(), secondMessage);
  const second = await request(path, { checkpointId: retainedPreview.checkpointId, workspaceDigest: retainedPreview.workspaceDigest, grant: secondGrant, messageId: secondMessage });
  assert.equal(second.status, 202);
  await until(() => calls.length === 2, 'second resumed Coder');
  assert.equal(calls[1].taskType, 'implement_ticket');
  assert.match(calls[1].prompt, /SAVED PLAN/); assert.match(calls[1].prompt, /SAVED KNOWLEDGE/); assert.match(calls[1].prompt, /SAVED QA/);
  assert.ok(credentialGrants.every(value => [`Bearer ${fresh}`, `Bearer ${secondGrant}`].includes(value)));
  const run = second.body;
  // Abrupt restart after dispatch cannot replay a possibly live worker.
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  for (const response of pending) response.destroy();
  child = launch(); await until(() => fetch(base + '/healthz').then(r => r.ok).catch(() => false), 'Pack restart');
  assert.equal((await request(`/threads/${threadId}/state`)).body.status, 'failed');
  assert.equal(calls.length, 2, 'restart does not replay Coder');
  assert.equal((await pool.query('SELECT status FROM argus_langgraph_runs WHERE run_id=$1', [run.run_id])).rows[0].status, 'failed');
  console.log('PASS: real HTTP/Postgres/LangGraph checkpoint resume at Coder; retained plan/knowledge/QA, partial-workspace hashes, fresh grants/credentials, exact worker stop, persisted terminal proof survives worker retention, live worker overrides saved proof, drift/missing-workspace refusal, double-submit serialization, raw retry bypass closed, original failure retained, restart has no automatic replay. Fake workers/workspace; no model, Git provider or Jenkins calls.');
  }
} catch (error) { console.error(serverLog); throw error; }
finally {
  for (const response of pending) response.destroy();
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  if (saver) await saver.end(); if (pool) await pool.end();
  if (created) execFileSync('docker', ['stop', name], { stdio: 'pipe' });
}
