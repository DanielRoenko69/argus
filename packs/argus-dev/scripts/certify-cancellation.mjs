/** Provider-free integration: real Pack HTTP + disposable PostgreSQL, fake workers.
 * Never connects to the workstation's Argus database or an actual model/CI.
 * Run after npm run build: node scripts/certify-cancellation.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import pg from 'pg';

const name = `argus-dev-cancel-cert-${randomUUID().slice(0, 8)}`;
const secret = `disposable-${randomUUID()}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, label) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
const pending = new Map();
const finished = new Map();
const calls = [], stopCalls = [], telemetry = [];
let holdStops = true;
const mock = http.createServer(async (req, res) => {
  const parts = []; for await (const chunk of req) parts.push(chunk);
  const body = parts.length ? JSON.parse(Buffer.concat(parts)) : {};
  const reply = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url.startsWith('/api/internal/telemetry/')) { telemetry.push(body); return reply({ ok: true }); }
  if (req.url.includes('/bundle-creds/')) return reply({ kind: 'gitea', base_url: 'http://fixture.invalid', token: null, config: { owner: 'fixture', repo: 'repo' } });
  if (req.url === '/api/internal/agent-runtimes') return reply({ researcher: { agentId: 1, runtimeType: 'codex', profileId: 1, profileEnabled: true, model: 'fixture', codeContextMode: 'metadata_only' } });
  if (req.url.endsWith('/code-index')) return reply({ error: 'No index in this fixture' }, 404);
  if (req.url === '/codex/status') return reply({ enabled: true, authenticated: true, authMethod: 'fixture', runs: [...finished.values()] });
  if (req.url === '/exec') return reply({ stdout: body.cmd.includes('test -d') ? 'NO' : 'a'.repeat(40), stderr: '', exit_code: 0 });
  if (req.url === '/codex/run') {
    calls.push(body);
    pending.set(body.runId, { res, body });
    return;
  }
  const cancel = /^\/codex\/runs\/([^/]+)\/cancel$/.exec(req.url);
  if (cancel) {
    stopCalls.push(cancel[1]);
    assert.equal(req.headers['x-workspace-secret'], secret);
    if (holdStops) return reply({ error: 'simulated temporary failure' }, 503);
    const item = pending.get(cancel[1]);
    if (item) {
      finished.set(cancel[1], { id: cancel[1], finishedAt: new Date().toISOString() });
      item.res.writeHead(499, { 'content-type': 'application/json' });
      item.res.end(JSON.stringify({ error: 'canceled', code: 'runtime_canceled', runId: cancel[1] }));
      pending.delete(cancel[1]);
    }
    return reply({ ok: true }, 202);
  }
  return reply({ error: 'Unexpected fixture request', path: req.url }, 404);
});
let child, pool, created = false;
let serverLog = '';
try {
  execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=argus_dev_cancel_cert', 'postgres:16-alpine'], { stdio: 'pipe' });
  created = true;
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  const dbUrl = `postgresql://postgres@127.0.0.1:${dbPort}/argus_dev_cancel_cert`;
  pool = new pg.Pool({ connectionString: dbUrl });
  await until(() => pool.query('SELECT 1').then(() => true).catch(() => false), 'disposable DB');
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const portProbe = net.createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const launch = () => {
    const process = spawn('node', ['dist/server.js'], { env: {
      PATH: globalThis.process.env.PATH, NODE_ENV: 'test', PORT: String(port),
      POSTGRES_CONNECTION_URL: dbUrl, ARGUS_URL: mockUrl, AGENT_WORKSPACE_URL: mockUrl,
      WORKSPACE_SECRET: secret, RESEARCHER_AGENT_ID: '1', PLANNER_AGENT_ID: '1', REVIEWER_AGENT_ID: '1',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.on('data', chunk => { serverLog = (serverLog + chunk).slice(-12_000); });
    process.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-12_000); });
    return process;
  };
  child = launch();
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'Pack startup');
  const request = async (path, body, a2a = false) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      'x-workspace-secret': secret, 'content-type': a2a ? 'application/a2a+json' : 'application/json', 'a2a-version': '1.0',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json(); assert.ok(response.ok, JSON.stringify(json)); return json;
  };
  const start = async label => {
    const thread = await request('/threads', { graph_id: 'backlog_grooming', metadata: { fixture: label } });
    const taskId = randomUUID();
    const task = { id: taskId, contextId: randomUUID(), status: { state: 'TASK_STATE_WORKING' }, metadata: { workflowThreadId: thread.thread_id, workflowId: 'backlog-grooming', resultArtifactId: randomUUID() } };
    await pool.query(`INSERT INTO argus_a2a_tasks(task_id, context_id, message_id, operation, workflow_thread_id, state, task) VALUES ($1,$2,$5,'workflow.start',$3,'TASK_STATE_WORKING',$4)`, [taskId, task.contextId, thread.thread_id, task, taskId]);
    await request(`/threads/${thread.thread_id}/runs`, { input: { backlog_id: label, repository: 'fixture/repo', source_branch: 'main', issue_title: label, issue_body: 'Only analyze fixture', argus_bundle_ids: [1] } });
    await until(() => calls.find(call => call.rootTraceId === thread.thread_id), 'fake worker start');
    return { threadId: thread.thread_id, taskId, runId: calls.find(call => call.rootTraceId === thread.thread_id).runId };
  };
  const first = await start('CANCEL-CERT-ONE');
  const other = await start('CANCEL-CERT-TWO');
  await pool.query(`UPDATE argus_langgraph_threads SET metadata = metadata || $2::jsonb WHERE thread_id = $1`,
    [first.threadId, JSON.stringify({ execution_principal: 'user:7', a2a_task_id: first.taskId, execution_grant_id: 'old-fixture-grant' })]);
  const configuredRestart = (principalId = '7', sourceTaskId = first.taskId) => {
    const messageId = randomUUID(), rootTraceId = randomUUID(), jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const workspaceRoot = `/workspace/CANCEL-RESTART-${rootTraceId}`;
    const grant = 'eg_v1.' + Buffer.from(JSON.stringify({ v: 1, iss: 'argus.core', aud: 'argus.dev', agent: 'coding-orchestrator',
      jti, principalKind: 'user', principalId, bundleIds: [1], coreAgentIds: [1], messageId, rootTraceId, workspaceRoot, iat: now, exp: now + 3600,
    })).toString('base64url') + '.fixture-only';
    const send = async () => {
      const response = await fetch(base + '/message:send', { method: 'POST', headers: {
        'content-type': 'application/a2a+json', 'a2a-version': '1.0', 'x-argus-root-trace-id': rootTraceId, 'x-argus-execution-grant': grant,
      }, body: JSON.stringify({ message: { messageId, role: 'ROLE_USER', metadata: { argusRootTraceId: rootTraceId }, parts: [{ data: {
        operation: 'workflow.start', workflowId: 'backlog-grooming',
        input: { backlog_id: 'CANCEL-RESTART', repository: 'fixture/repo', source_branch: 'main', issue_title: 'Restart fixture', issue_body: 'Read only' },
        retry: { sourceThreadId: first.threadId, sourceTaskId, feedback: '' },
      } }] } }) });
      const json = await response.json(); assert.ok(response.ok, JSON.stringify(json)); return json.task;
    };
    return { send, rootTraceId, jti, workspaceRoot };
  };
  const cancel = await request(`/tasks/${first.taskId}:cancel`, {}, true);
  assert.equal(cancel.status.state, 'TASK_STATE_WORKING');
  assert.equal(cancel.metadata.runtimeStatus, 'canceling');
  await until(() => stopCalls.includes(first.runId), 'targeted runtime stop');
  assert.ok(!stopCalls.includes(other.runId));
  assert.equal((await request(`/tasks/${first.taskId}:cancel`, {}, true)).metadata.runtimeStatus, 'canceling');
  assert.equal((await request(`/threads/${other.threadId}/state`)).status, 'running');
  await request(`/threads/${first.threadId}/ci`, { provider: 'unknown', status: 'failure' });
  assert.equal((await request(`/threads/${first.threadId}/state`)).status, 'canceling', 'late CI cannot overwrite cancellation');
  assert.equal((await configuredRestart().send()).status.state, 'TASK_STATE_FAILED', 'cannot restart while canceling');
  holdStops = false;
  await until(async () => (await request(`/threads/${first.threadId}/state`)).status === 'canceled', 'terminal receipt');
  assert.equal((await request(`/tasks/${first.taskId}:cancel`, {}, true)).status.state, 'TASK_STATE_CANCELED');
  assert.equal(calls.filter(call => call.rootTraceId === first.threadId).length, 1, 'no planner after cancel');
  assert.ok(telemetry.some(event => event.rootTraceId === first.threadId && event.event === 'cancelled'));
  assert.ok(!stopCalls.includes(other.runId));
  const parentBefore = (await pool.query('SELECT status,metadata FROM argus_langgraph_threads WHERE thread_id=$1', [first.threadId])).rows[0];
  assert.equal((await configuredRestart('8').send()).status.state, 'TASK_STATE_FAILED', 'foreign owner cannot restart');
  assert.equal((await configuredRestart('7', randomUUID()).send()).status.state, 'TASK_STATE_FAILED', 'mismatched parent task cannot restart');
  const restart = configuredRestart();
  const [newTask, duplicateTask] = await Promise.all([restart.send(), restart.send()]);
  assert.equal(newTask.id, duplicateTask.id, 'repeated message creates only one task');
  await until(() => calls.find(call => call.rootTraceId === restart.rootTraceId), 'fresh restarted worker');
  assert.equal(calls.filter(call => call.rootTraceId === restart.rootTraceId).length, 1);
  const fresh = await request(`/threads/${restart.rootTraceId}/state`);
  assert.notEqual(restart.rootTraceId, first.threadId);
  assert.equal(fresh.metadata.retry_of, first.threadId);
  assert.equal(fresh.metadata.execution_grant_id, restart.jti);
  assert.equal(fresh.values.argus_workspace_root, restart.workspaceRoot);
  assert.equal(fresh.values.human_approved, false);
  assert.equal(fresh.values.pr_approved, false);
  assert.deepEqual((await pool.query('SELECT status,metadata FROM argus_langgraph_threads WHERE thread_id=$1', [first.threadId])).rows[0], parentBefore, 'parent stays unchanged');
  await request(`/tasks/${newTask.id}:cancel`, {}, true);
  await until(async () => (await request(`/threads/${restart.rootTraceId}/state`)).status === 'canceled', 'restart fixture cleanup');
  await request(`/tasks/${other.taskId}:cancel`, {}, true);
  await until(async () => (await request(`/threads/${other.threadId}/state`)).status === 'canceled', 'other fixture cleanup');

  // A disconnected worker request without terminal runtime evidence is not
  // a completed cancellation, even when the graph propagates the error.
  holdStops = true;
  const uncertain = await start('CANCEL-CERT-LOST-RECEIPT');
  await request(`/tasks/${uncertain.taskId}:cancel`, {}, true);
  pending.get(uncertain.runId).res.destroy();
  pending.delete(uncertain.runId);
  await until(() => serverLog.includes('runtime cancellation requires reconciliation'), 'lost receipt stays pending');
  assert.equal((await request(`/threads/${uncertain.threadId}/state`)).status, 'canceling');
  assert.ok(!telemetry.some(event => event.rootTraceId === uncertain.threadId && event.event === 'cancelled'));

  // Restart with a durable cancellation request must not replay an Agent.
  const restartFixture = randomUUID();
  await pool.query(`INSERT INTO argus_langgraph_threads(thread_id, graph_id, status) VALUES ($1,'backlog_grooming','canceling')`, [restartFixture]);
  await pool.query(`INSERT INTO argus_langgraph_runs(run_id,thread_id,kind,payload,status) VALUES ($1,$2,'input','{}','running')`, [randomUUID(), restartFixture]);
  const countBefore = calls.length;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  child = launch();
  await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'Pack restart');
  assert.equal((await request(`/threads/${restartFixture}/state`)).status, 'canceling');
  assert.equal(calls.length, countBefore, 'restart cannot replay cancellation');
  console.log('PASS: real HTTP/PostgreSQL cancellation, configured restart after cancel, fresh workspace/grant, owner and task binding, message idempotency, unchanged parent, worker isolation, lost receipt fail-closed, late CI isolation, no restart replay. No model or CI calls.');
} catch (error) {
  console.error(serverLog); throw error;
} finally {
  for (const item of pending.values()) item.res.destroy();
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  if (pool) await pool.end();
  if (created) execFileSync('docker', ['stop', name], { stdio: 'pipe' });
}
