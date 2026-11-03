/** Real Pack HTTP/Postgres/LangGraph with synthetic Core/workspace responses.
 * No real repository, provider, model, credentials or Jenkins is contacted.
 * Run after npm run build. Only the disposable named database is removed.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import pg from 'pg';

const name = `argus-dev-design-cert-${randomUUID().slice(0, 8)}`;
const secret = `disposable-${randomUUID()}`;
const cases = new Map(), calls = [], commands = [];
let activeQaWorker = false, dirtyQaWorkspace = false;
let packBase = '';
const sha = value => createHash('sha256').update(value).digest('hex');
const sandboxEvidence = "Synthetic inspection failure: bwrap: Can't mount proc on /proc: Operation not permitted";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, label) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
const extract = (prompt, label) => JSON.parse(prompt.split(`${label}\n`)[1]?.split('\n')[0] ?? 'null');
const outcome = (blockers = []) => ({ version: 2, status: blockers.length ? 'blocked' : 'ready', summary: 'Synthetic technical plan/test evidence.', blockers });
const mock = http.createServer(async (req, res) => {
  try {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const body = parts.length ? JSON.parse(Buffer.concat(parts)) : {};
    const reply = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url.startsWith('/api/internal/telemetry/')) return reply({ ok: true });
    if (req.url === '/api/internal/dev-git/7/reference') return reply({ kind: 'gitea', base_url: 'http://fixture.invalid', token: null,
      project_key: '', user_slug: 'fixture', repo_slug: 'repo', target_branch: 'main',
      reference: { version: 1, bundleId: 7, backendId: 1, binding: 'b'.repeat(64) } });
    if (req.url === '/api/internal/dev-git/ci-authorization') {
      assert.equal(body.phase, 'prepare', 'no CI delivery is authorized by this certification');
      return reply({ ciReference: { version: 1, bundleId: 7, backendId: 2, job: 'fixture-dev', apiOrigin: 'http://ci.fixture.invalid',
        repository: 'fixture/repo', branchPrefix: 'feature/DESIGN-', authMode: 'service-account', credentialSource: 'argus-dev-dispatcher', binding: 'c'.repeat(64) } });
    }
    if (req.url === '/api/internal/dev-git/operate') {
      assert.equal(body.operation, 'clone', 'fixture forbids pushes and PR creation');
      assert.equal(body.reference.bundleId, 7); return reply({ ok: true });
    }
    if (req.url === '/api/internal/agent-runtimes') return reply(Object.fromEntries([1, 2, 3, 4].map(agentId =>
      [`fixture-${agentId}`, { agentId, runtimeType: 'argus', profileId: null }])));
    if (req.url === '/exec') {
      commands.push(body.cmd);
      if (body.cmd === 'git status --porcelain --untracked-files=all') return reply({ stdout: dirtyQaWorkspace ? ' M src/api.py\n' : '', stderr: '', exit_code: 0 });
      if (body.cmd === 'git remote get-url origin') return reply({ stdout: 'http://fixture.invalid/fixture/repo.git', stderr: '', exit_code: 0 });
      return reply({ stdout: body.cmd.includes('test -d') ? 'NO' : 'a'.repeat(40), stderr: '', exit_code: 0 });
    }
    if (req.url === '/codex/status' || req.url === '/claude/status') return reply({ runs: activeQaWorker ? [...cases.keys()].map(root => ({ cwd: `/workspace/DESIGN-CERT-${root}` })) : [] });
    if (req.url === '/api/agents/1/technical-experiment') {
      const root = req.headers['x-argus-root-trace-id'], fixture = cases.get(root);
      assert.ok(fixture?.experiment); assert.equal(req.headers.authorization, `Bearer ${fixture.grant}`);
      fixture.experiments++;
      assert.equal(fixture.experiments, 1, 'no experiment repair/replay');
      const checkpoint = await fetch(`${packBase}/threads/${root}/state`, { headers: { 'x-workspace-secret': secret } }).then(r => r.json());
      assert.equal(checkpoint.values.technical_experiment_count, 1, 'budget persisted BEFORE executing');
      assert.equal(checkpoint.values.technical_experiment_request.script, body.script);
      assert.equal(checkpoint.values.technical_experiment_result, null);
      if (fixture.experiment === 'unavailable') return reply({ error: 'uncertain' }, 503);
      if (fixture.experiment === 'preparation_limit') return reply({ version: 1, threadId: root,
        baseCommitSha: body.baseCommitSha, basisSha256: body.basisSha256, requestSha256: body.requestSha256,
        scriptSha256: sha(body.script), status: 'preparation_failed', executionStarted: false,
        reason: 'snapshot_file_size_limit', filePath: 'public/banner.jpg', actual: 16777217, limit: 16777216,
        limits: { wallMs: 30000, cpuSeconds: 20, memoryBytes: 536870912, outputBytes: 32768,
          scriptBytes: 24000, snapshotFileBytes: 16777216, snapshotBytes: 134217728, snapshotFiles: 3000 } });
      const stdout = 'reference_error=0.0001\n', stderr = '';
      return reply({ version: 1, threadId: root, baseCommitSha: body.baseCommitSha, basisSha256: body.basisSha256,
        requestSha256: body.requestSha256, scriptSha256: sha(body.script), snapshotSha256: 'f'.repeat(64),
        profile: 'python-bwrap-v1', status: 'completed', exitCode: 0, stdout, stderr, outputSha256: sha(JSON.stringify([stdout, stderr])),
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 12, files: 1, excludedFiles: 0,
        pythonVersion: '3.12.14', limits: { wallMs: 30000, cpuSeconds: 20, memoryBytes: 536870912, outputBytes: 32768,
          scriptBytes: 24000, snapshotBytes: 67108864, snapshotFiles: 3000 } });
    }
    const agent = /^\/api\/agents\/(\d+)\/chat$/.exec(req.url);
    if (agent) {
      const root = req.headers['x-argus-root-trace-id'];
      const fixture = cases.get(root); assert.ok(fixture, 'unknown fixture root');
      assert.equal(req.headers.authorization, `Bearer ${fixture.grant}`);
      const prompt = body.message, phase = body.worker_task_type;
      if (['plan', 'review', 'implement_ticket'].includes(phase)) {
        assert.match(prompt, /path-coverage witness/, 'candidate-path guidance reaches each technical role');
        assert.match(prompt, /proposed measurement is not an executed result or permission/);
      }
      if (['plan', 'review'].includes(phase)) assert.deepEqual(body.execution_tool_allow_patterns, ['workspace_ls', 'workspace_read', 'argus_code_search']);
      calls.push({ root, phase });
      let response;
      if (phase === 'knowledge') response = 'Synthetic repository evidence.';
      else if (phase === 'plan') {
        fixture.plans++;
        const investigating = prompt.includes('This is the single bounded technical investigation');
        if (investigating) fixture.investigations++;
        const open = extract(prompt, 'Open technical findings (retain exact finding IDs when resolving):');
        response = JSON.stringify({ outcome: outcome(), decisions: [{ id: 'api', topic: 'Concrete batch API',
          specification: `BatchMotor(num_envs: int), revision ${fixture.plans}`, rationale: 'Compatible scoped implementation choice.',
          requirementRefs: ['Frozen brief: batch API'], evidence: ['fixture/src/api.py:1'] }],
          resolutions: open.map(f => ({ findingId: f.id, decisionIds: ['api'], evidence: ['Targeted independent evidence candidate.'] })) });
        if (fixture.mode?.startsWith('missing-')) {
          const proposal = JSON.parse(response);
          proposal.decisions.push({ ...proposal.decisions[0], id: 'delivery_boundary', topic: 'Verification and delivery' });
          response = JSON.stringify(proposal);
        }
        if (investigating && fixture.experiment && fixture.experiments === 0) {
          assert.match(prompt, /At most ONE experiment/);
          response = JSON.stringify({ experiment: { purpose: 'Reference observation', hypothesis: 'Known fixed reference',
            protocol: 'Input 1; fixture', interpretation: 'Fixture only; not a universal bound', findingIds: open.map(f => f.id), script: 'print(42)' } });
        } else if (fixture.experiment && fixture.experiments) {
          assert.match(prompt, /reference_error=0.0001/); assert.match(prompt, /No further experiment is authorized/);
        }
        if (fixture.mode === 'planner-string-evidence') response = JSON.stringify({ outcome: outcome([
          { kind: 'environment', source: 'unknown', summary: 'Synthetic sandbox cannot inspect the repository.', evidence: sandboxEvidence },
        ]), decisions: [], resolutions: [] });
      } else if (phase === 'review') {
        fixture.qa++;
        const ledger = extract(prompt, 'Technical design ledger (delegated implementation choices; NOT product requirements, permissions or human approvals):');
        const pass = Boolean(fixture.mode) || (fixture.succeed && fixture.investigations > 0);
        if (fixture.experiment && fixture.experiments) assert.match(prompt, /reference_error=0.0001/);
        const blockers = pass ? [] : [{ kind: 'design', source: 'proposal', summary: `Missing independent numeric evidence round ${fixture.qa}`,
          evidence: ['Frozen brief: justify tolerances', 'fixture/src/solver.py:4'] }];
        assert.ok(ledger.every(d => !Object.hasOwn(d, 'digest')), 'QA does not copy revision hashes');
        response = JSON.stringify({ version: 2, outcome: outcome(blockers), testCases: pass ? [{ id: 'empty_batch', decisionIds: ['api'],
          scenario: 'Invalid zero-size batch', input: 'BatchMotor(num_envs=0)', expected: 'ValueError',
          oracle: 'Positive-size fixture requirement', evidence: ['fixture/src/api.py:1'], targetFiles: ['tests/test_api.py'] }] : [],
          reviews: ledger.map(d => ({ decisionId: d.id,
          verdict: pass ? 'accept' : 'revise', evidence: ['Independent synthetic QA reasoning.'] })) });
        if (fixture.mode) {
          const formatted = JSON.parse(response);
          formatted.testCases[0].id = 'batch_benchmark_reports_raw_runtime_and_memory_against_four_single_envs';
          if (fixture.mode === 'format-error' && (!fixture.retry || fixture.qa === 1)) delete formatted.testCases[0].expected;
          if (fixture.mode === 'integrity-error') formatted.reviews[0].decisionId = 'unknown';
          if (fixture.mode.startsWith('missing-')) {
            if (fixture.qa === 1) {
              formatted.reviews.pop(); fixture.originalAnswer = structuredClone(formatted);
            } else {
              assert.equal(fixture.qa, 2, 'one correction only');
              assert.match(prompt, /One operator-requested correction/);
              assert.match(prompt, /exactly these missing decision IDs: \["delivery_boundary"\]/);
              const checkpoint = await fetch(`${packBase}/threads/${root}/state`, { headers: { 'x-workspace-secret': secret } }).then(r => r.json());
              assert.equal(checkpoint.values.qa_review_repair_count, 1, 'reservation is durable BEFORE inference');
              assert.equal(checkpoint.values.qa_review_repair_pending, true);
              assert.equal(checkpoint.values.qa_acceptance_policy_version, 1);
              assert.equal(checkpoint.values.qa_response_receipt, undefined, 'source answer stays private');
              assert.deepEqual(formatted.testCases, fixture.originalAnswer.testCases);
              assert.deepEqual(formatted.reviews.slice(0, 1), fixture.originalAnswer.reviews);
              if (fixture.mode === 'missing-reject') {
                formatted.reviews[1].verdict = 'revise';
                formatted.outcome = outcome([{ kind: 'environment', source: 'repository', summary: 'Delivery reference unavailable', evidence: ['fixture/reference.py'] }]);
              }
              if (fixture.mode === 'missing-mutate') formatted.testCases[0].expected = 'weakened assertion';
            }
          }
          if (fixture.retry && fixture.qa > 1) {
            formatted.outcome = outcome([{ kind: 'environment', source: 'repository', summary: 'Synthetic reference unavailable', evidence: ['fixture/reference.py'] }]);
            formatted.reviews[0].verdict = 'revise'; formatted.testCases = [];
          }
          response = JSON.stringify(formatted);
        }
      } else if (phase === 'implement_ticket') {
        fixture.coder++;
        assert.match(prompt, /QA-checked technical contract/);
        assert.match(prompt, /qa_checked/);
        assert.match(prompt, /"testCases"/);
        assert.match(prompt, /"oracle"/);
        if (fixture.experiment) assert.match(prompt, /reference_error=0.0001/);
        response = JSON.stringify(outcome([{ kind: 'technical_review', source: 'repository', summary: 'Fixture stops before any code or CI writes.', evidence: ['fixture boundary'] }]));
      } else throw new Error(`Unexpected phase ${phase}`);
      return reply({ response, session_id: randomUUID(), tool_calls: [], iterations: 1, trace_id: randomUUID(),
        agent: { id: Number(agent[1]), name: 'fixture', label: 'Fixture agent', model: 'synthetic' } });
    }
    return reply({ error: 'Unexpected fixture request', path: req.url }, 404);
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});

let child, pool, saver, created = false, serverLog = '';
try {
  execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e', 'POSTGRES_DB=technical_design_cert', 'postgres:16-alpine'], { stdio: 'pipe' });
  created = true;
  const dbPort = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  const dbUrl = `postgresql://postgres@127.0.0.1:${dbPort}/technical_design_cert`;
  pool = new pg.Pool({ connectionString: dbUrl });
  await until(() => pool.query('SELECT 1').then(() => true).catch(() => false), 'disposable database');
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  packBase = base;
  const launch = enabled => {
    const proc = spawn('node', ['dist/server.js'], { env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port),
      POSTGRES_CONNECTION_URL: dbUrl, ARGUS_URL: mockUrl, AGENT_WORKSPACE_URL: mockUrl, WORKSPACE_SECRET: secret,
      PLANNER_AGENT_ID: '1', REVIEWER_AGENT_ID: '2', CODER_AGENT_ID: '3', KNOWLEDGE_AGENT_ID: '4',
      ARGUS_JENKINS_API_ORIGIN: 'http://ci.fixture.invalid', ARGUS_JENKINS_PUBLIC_ORIGIN: 'http://ci.fixture.invalid',
      ARGUS_JENKINS_DISPATCH_USER: 'fixture-only', ARGUS_JENKINS_DISPATCH_TOKEN: 'fixture-only',
      ARGUS_JENKINS_DISPATCH_TARGETS: JSON.stringify([{ repository: 'fixture/repo', gitOrigin: 'http://fixture.invalid', branchPrefix: 'feature/DESIGN-', job: 'fixture-dev' }]),
      ARGUS_DEV_TECHNICAL_DESIGN_ENABLED: enabled ? 'true' : 'false', ARGUS_TECHNICAL_EXPERIMENTS_ENABLED: enabled ? 'true' : 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', chunk => { serverLog = (serverLog + chunk).slice(-12000); });
    proc.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-12000); }); return proc;
  };
  child = launch(true); await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'Pack startup');
  const request = async (path, body) => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-workspace-secret': secret,
      'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  for (const { succeed, mode, experiment, retry } of [{ succeed: false }, { succeed: true },
    { succeed: true, experiment: 'success' }, { succeed: true, experiment: 'unavailable' },
    { succeed: true, experiment: 'preparation_limit' },
    { mode: 'long-id' }, { mode: 'format-error' }, { mode: 'format-error', retry: true }, { mode: 'integrity-error' }, { mode: 'planner-string-evidence' },
    { mode: 'missing-accept' }, { mode: 'missing-reject' }, { mode: 'missing-mutate' }]) {
    const root = randomUUID(), messageId = randomUUID(), now = Math.floor(Date.now() / 1000);
    const grant = 'eg_v1.' + Buffer.from(JSON.stringify({ v: 1, iss: 'argus.core', aud: 'argus.dev', agent: 'coding-orchestrator',
      jti: randomUUID(), principalKind: 'user', principalId: '7', bundleIds: [7], coreAgentIds: [1, 2, 3, 4], messageId,
      rootTraceId: root, workspaceRoot: `/workspace/DESIGN-CERT-${root}`, iat: now, exp: now + 3600 })).toString('base64url') + '.fixture-only';
    const fixture = { grant, succeed, mode, experiment, retry, experiments: 0, plans: 0, qa: 0, investigations: 0, coder: 0 }; cases.set(root, fixture);
    const started = await fetch(`${base}/message:send`, { method: 'POST', headers: { 'content-type': 'application/a2a+json',
      'a2a-version': '1.0', 'x-argus-root-trace-id': root, 'x-argus-execution-grant': grant }, body: JSON.stringify({ message: {
        messageId, role: 'ROLE_USER', metadata: { argusRootTraceId: root }, parts: [{ data: { operation: 'workflow.start',
          workflowId: 'ticket-to-pull-request', input: { ticket_id: 'DESIGN-CERT', description: 'Implement a documented batch API with justified tolerances.', ci_provider: 'jenkins' } } }],
      } }) });
    const startedBody = await started.json(); assert.ok(started.ok, JSON.stringify(startedBody));
    const paused = await until(async () => {
      const r = await request(`/threads/${root}/state`);
      if (r.body.status === 'failed') throw new Error(`Fixture workflow failed: ${r.body.error}`);
      return r.body.status === 'interrupted' ? r.body : null;
    }, 'technical stop');
    assert.deepEqual([fixture.plans, fixture.qa, fixture.investigations, fixture.coder],
      mode === 'planner-string-evidence' ? [1, 0, 0, 0] : mode ? [1, 1, 0, mode === 'long-id' ? 1 : 0] : experiment === 'success' ? [5, 4, 2, 1]
        : experiment ? [4, 3, 1, 0] : [4, 4, 1, succeed ? 1 : 0]);
    assert.equal(paused.values.technical_experiment_policy_version, 1);
    assert.equal(paused.values.technical_experiment_count, experiment ? 1 : 0);
    assert.equal(fixture.experiments, experiment ? 1 : 0);
    if (experiment === 'success') {
      assert.equal(paused.values.technical_experiment_result.status, 'completed');
      assert.ok(paused.values.log.some(l => l.step === 'technical_experiment_review'));
    }
    if (experiment === 'unavailable') assert.equal(paused.values.technical_experiment_result, null);
    if (experiment === 'preparation_limit') {
      assert.equal(paused.values.technical_experiment_result.status, 'preparation_failed');
      assert.equal(paused.values.technical_experiment_result.executionStarted, false);
      assert.ok(paused.values.log.some(l => /Python script did not start/.test(l.summary)));
      assert.ok(!paused.values.log.some(l => l.step === 'technical_experiment_review'));
    }
    assert.equal(paused.values.technical_design_policy_version, 1);
    assert.equal(paused.values.technical_investigation_count, mode ? 0 : 1);
    assert.equal(paused.values.design_refinement_count, mode ? 0 : 2);
    assert.equal(paused.values.human_approved, false); assert.equal(paused.values.pr_approved, false);
    assert.deepEqual(paused.values.argus_bundle_ids, [7]);
    const card = paused.interrupts.find(i => i.value?.stage === 'requirements_input').value.decision;
    if (mode === 'planner-string-evidence') {
      assert.equal(card.kind, 'environment'); assert.equal(card.title, 'Operator repair needed');
      assert.equal(card.canClarify, true, 'existing operator repair/re-evaluation action stays unchanged');
      assert.equal(paused.values.technical_response_failure, null);
      assert.deepEqual(paused.values.development_findings[0].evidence, [sandboxEvidence]);
      assert.deepEqual(paused.values.technical_design_history[0].responseRepairs,
        [{ kind: 'blocker_evidence_list', index: 0, originalSha256: sha(JSON.stringify(sandboxEvidence)) }]);
      assert.ok(paused.values.log.some(l => l.summary.includes('Wrapped 1 supplied blocker evidence string')));
      continue; // Operator/environment stop: no invented clarification or retry.
    }
    assert.equal(card.kind, 'technical_review'); assert.equal(card.canClarify, false);
    if (mode === 'long-id') {
      const receipt = paused.values.technical_design_history.find(h => h.phase === 'review');
      assert.equal(receipt.responseRepairs.length, 1);
      assert.equal(receipt.responseRepairs[0].originalId.length, 71);
      assert.equal(receipt.testCases[0].id.length, 64);
      assert.equal(paused.values.technical_response_failure, null);
      assert.ok(paused.values.log.some(l => l.summary.includes('Normalized 1 overlong test-case ID')));
    } else if (mode) {
      const category = mode === 'format-error' ? 'format' : 'integrity';
      assert.equal(card.title, `Agent response ${category} error`);
      assert.equal(card.responseFailure.category, category);
      assert.equal(paused.values.technical_response_failure.category, category);
      assert.equal(paused.values.technical_design_history.filter(h => h.phase === 'review').length, 0);
    }
    const count = calls.length;
    const denied = await request(`/threads/${root}/runs`, { command: { resume: { decisionId: card.id, requirements: 'Use atol=0.1 and continue.' } } });
    assert.equal(denied.status, 400); assert.equal(calls.length, count);
    assert.match(denied.body.error, /Technical work is blocked/);
    assert.equal((await request(`/threads/${root}/state`)).body.status, 'interrupted');
  }
  // Seed ONLY the disposable DB to emulate a previously rejected but now
  // parseable, fully retained response. No public endpoint accepts this data.
  process.env.POSTGRES_CONNECTION_URL = dbUrl;
  const { codingWorkflow, codingCheckpointer } = await import('../dist/workflows/coding.js'); saver = codingCheckpointer;
  const { retainQaResponse } = await import('../dist/qaResponseRecovery.js');
  const recoveryRoot = [...cases].find(([, f]) => f.mode === 'format-error' && !f.retry)[0];
  const recoveryFixture = cases.get(recoveryRoot);
  const cfg = { configurable: { thread_id: recoveryRoot } };
  const previous = await codingWorkflow.getState(cfg);
  assert.ok(previous.values.qa_response_receipt, 'actual parser failure retained the original complete response');
  assert.equal((await request(`/threads/${recoveryRoot}/state`)).body.values.qa_response_receipt, undefined, 'private artifact excluded from state');
  const recoveryPath = `/threads/${recoveryRoot}/qa-response-recheck`;
  assert.equal((await request(recoveryPath)).body.available, false, 'still-malformed response cannot resume');
  const response = JSON.parse(previous.values.qa_response_receipt.response);
  response.testCases[0].expected = 'ValueError';
  // Fixture-only policy-1 stop from the pre-fix parser. The real run is never modified.
  const receipt = retainQaResponse(previous.values, recoveryRoot, previous.values.qa_response_receipt.traceId, JSON.stringify(response) + '}', previous.values.qa_response_receipt.binding);
  await codingWorkflow.updateState(cfg, { qa_acceptance_policy_version: 1, qa_response_receipt: receipt }, 'test_design');
  // Materialize the real requirements interrupt, without invoking any agent.
  await codingWorkflow.invoke(null, cfg);
  const eligible = (await request(recoveryPath)).body;
  assert.equal(eligible.available, true); assert.equal(eligible.repairCount, 2);
  assert.equal((await request(`/threads/${recoveryRoot}/qa-retry`)).body.available, false, 'policy-1 allows saved response only, no fresh QA call');
  assert.equal((await request(`/threads/${recoveryRoot}/checkpoint-retry`)).body.available, false, 'generic policy-1 continuation stays closed');
  const beforeRecoveryCalls = calls.length;
  activeQaWorker = true; assert.equal((await request(recoveryPath)).body.available, false); activeQaWorker = false;
  dirtyQaWorkspace = true; assert.equal((await request(recoveryPath)).body.available, false); dirtyQaWorkspace = false;
  const messageId = randomUUID();
  const oldClaims = JSON.parse(Buffer.from(recoveryFixture.grant.split('.')[1], 'base64url'));
  recoveryFixture.grant = 'eg_v1.' + Buffer.from(JSON.stringify({ ...oldClaims, jti: randomUUID(), messageId })).toString('base64url') + '.fixture-only';
  const submission = { checkpointId: eligible.checkpointId, workspaceDigest: eligible.workspaceDigest, reviewDigest: eligible.reviewDigest, grant: recoveryFixture.grant, messageId };
  assert.equal((await request(recoveryPath, { ...submission, response: 'client cannot supply an answer' })).status, 409);
  assert.equal((await request(recoveryPath, { ...submission, reviewDigest: '0'.repeat(64) })).status, 409);
  assert.equal((await request(recoveryPath, { ...submission, workspaceDigest: '0'.repeat(64) })).status, 409);
  for (const extra of [{ principalId: '8' }, { bundleIds: [8] }, { workspaceRoot: '/workspace/OTHER' }]) {
    const wrongGrant = 'eg_v1.' + Buffer.from(JSON.stringify({ ...oldClaims, jti: randomUUID(), messageId, ...extra })).toString('base64url') + '.fixture-only';
    assert.equal((await request(recoveryPath, { ...submission, grant: wrongGrant })).status, 409);
  }
  assert.equal(calls.length, beforeRecoveryCalls, 'preview and rejected requests make no model calls');
  const attempts = await Promise.all([request(recoveryPath, submission), request(recoveryPath, submission)]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [202, 409]);
  await until(async () => {
    const r = await request(`/threads/${recoveryRoot}/state`);
    if (r.body.status === 'failed') throw new Error(r.body.error);
    return r.body.status === 'interrupted' && recoveryFixture.coder === 1;
  }, 'saved QA continuation stops at synthetic Coder boundary');
  assert.deepEqual([recoveryFixture.plans, recoveryFixture.qa, recoveryFixture.coder], [1, 1, 1]);
  const recovered = (await request(`/threads/${recoveryRoot}/state`)).body;
  assert.equal(recovered.values.plan, previous.values.plan);
  assert.equal(recovered.values.context, previous.values.context);
  assert.equal(recovered.values.technical_investigation_count, previous.values.technical_investigation_count);
  assert.equal(recovered.values.human_approved, false); assert.equal(recovered.values.pr_approved, false);
  assert.equal(recovered.values.qa_acceptance_policy_version, 1);
  assert.equal(recovered.values.qa_artifact, null); assert.equal(recovered.values.qa_receipt, null);
  assert.deepEqual(recovered.values.qa_history, []);
  assert.equal(recovered.values.technical_design_history.find(h => h.phase === 'review').responseRepairs[0].kind, 'trailing_object_closer');
  const oldPaused = await codingWorkflow.getState({ configurable: { thread_id: recoveryRoot, checkpoint_id: eligible.checkpointId } });
  assert.equal(oldPaused.values.qa_response_receipt.response, receipt.response, 'original malformed receipt retained unchanged');
  assert.ok(recovered.values.technical_design_history.some(h => h.phase === 'response_recovery' && h.responseSha256 === receipt.responseSha256));
  recoveryFixture.recovered = true;
  // Separate explicit fresh-QA path: emulate the old malformed digest protocol
  // in the disposable checkpoint, then prove it is retained, NEVER repaired.
  const retryRoot = [...cases].find(([, f]) => f.retry)[0], retryFixture = cases.get(retryRoot);
  const retryCfg = { configurable: { thread_id: retryRoot } };
  const beforeRetry = await codingWorkflow.getState(retryCfg);
  const legacy = JSON.parse(beforeRetry.values.qa_response_receipt.response);
  delete legacy.version;
  legacy.reviews[0].digest = beforeRetry.values.technical_decisions[0].digest + 'e';
  const rejected = retainQaResponse(beforeRetry.values, retryRoot, beforeRetry.values.qa_response_receipt.traceId, JSON.stringify(legacy));
  await codingWorkflow.updateState(retryCfg, { qa_response_receipt: rejected }, 'test_design');
  await codingWorkflow.invoke(null, retryCfg);
  const retryPath = `/threads/${retryRoot}/qa-retry`;
  assert.equal((await request(`/threads/${retryRoot}/qa-response-recheck`)).body.available, false);
  const retryPreview = (await request(retryPath)).body;
  assert.equal(retryPreview.available, true); assert.equal(retryPreview.node, 'test_design');
  const callsBeforeRetry = calls.length;
  activeQaWorker = true; assert.equal((await request(retryPath)).body.available, false); activeQaWorker = false;
  dirtyQaWorkspace = true; assert.equal((await request(retryPath)).body.available, false); dirtyQaWorkspace = false;
  const retryMessageId = randomUUID(), retryClaims = JSON.parse(Buffer.from(retryFixture.grant.split('.')[1], 'base64url'));
  const tokenFor = extra => 'eg_v1.' + Buffer.from(JSON.stringify({ ...retryClaims, jti: randomUUID(), messageId: retryMessageId, ...extra })).toString('base64url') + '.fixture-only';
  retryFixture.grant = tokenFor({});
  const retryBody = { checkpointId: retryPreview.checkpointId, workspaceDigest: retryPreview.workspaceDigest, reviewDigest: retryPreview.reviewDigest, grant: retryFixture.grant, messageId: retryMessageId };
  for (const bad of [{ ...retryBody, node: 'coder' }, { ...retryBody, reviewDigest: '0'.repeat(64) },
    { ...retryBody, workspaceDigest: '0'.repeat(64) }, { ...retryBody, grant: tokenFor({ principalId: '8' }) },
    { ...retryBody, grant: tokenFor({ bundleIds: [8] }) }]) assert.equal((await request(retryPath, bad)).status, 409);
  assert.equal(calls.length, callsBeforeRetry);
  const retried = await Promise.all([request(retryPath, retryBody), request(retryPath, retryBody)]);
  assert.deepEqual(retried.map(r => r.status).sort(), [202, 409]);
  await until(async () => {
    const r = await request(`/threads/${retryRoot}/state`);
    if (r.body.status === 'failed') throw new Error(r.body.error);
    return r.body.status === 'interrupted' && retryFixture.qa === 2;
  }, 'explicit QA retry stops at genuine environment finding');
  const afterRetry = (await request(`/threads/${retryRoot}/state`)).body;
  assert.deepEqual(calls.slice(callsBeforeRetry).map(c => c.phase), ['review']);
  assert.deepEqual([retryFixture.plans, retryFixture.qa, retryFixture.coder], [1, 2, 0]);
  for (const field of ['plan', 'context', 'plan_revision', 'design_refinement_count', 'technical_investigation_count', 'technical_experiment_count', 'argus_bundle_ids', 'allowed_files', 'human_approved', 'pr_approved']) {
    assert.deepEqual(afterRetry.values[field], beforeRetry.values[field], field);
  }
  assert.equal(afterRetry.values.development_findings[0].kind, 'environment');
  assert.equal(afterRetry.values.technical_response_failure, null);
  const retryHistory = afterRetry.values.technical_design_history.find(h => h.phase === 'qa_retry');
  assert.equal(retryHistory.responseSha256, rejected.responseSha256);
  assert.equal(retryHistory.previousFailure.category, 'format');
  const retainedCheckpoint = await codingWorkflow.getState({ configurable: { thread_id: retryRoot, checkpoint_id: retryPreview.checkpointId } });
  assert.equal(retainedCheckpoint.values.qa_response_receipt.response, rejected.response);
  assert.equal((await request(retryPath)).body.available, false, 'domain stop is not another format retry');
  // Only disposable fixtures: emulate a historical policy-1 omission stop.
  // The retained answer and frozen binding were produced by the actual QA node.
  for (const [root, fixture] of cases) {
    if (!fixture.mode?.startsWith('missing-')) continue;
    const config = { configurable: { thread_id: root } };
    await codingWorkflow.updateState(config, { qa_acceptance_policy_version: 1 }, 'test_design');
    await codingWorkflow.invoke(null, config);
    const source = await codingWorkflow.getState(config);
    const path = `/threads/${root}/qa-retry`, countBefore = calls.length;
    const preview = (await request(path)).body;
    assert.equal(preview.available, true, JSON.stringify(preview));
    assert.equal(preview.retryKind, 'missing_reviews'); assert.deepEqual(preview.missingDecisionIds, ['delivery_boundary']);
    assert.equal((await request(`/threads/${root}/qa-response-recheck`)).body.available, false);
    activeQaWorker = true; assert.equal((await request(path)).body.available, false); activeQaWorker = false;
    dirtyQaWorkspace = true; assert.equal((await request(path)).body.available, false); dirtyQaWorkspace = false;
    const messageId = randomUUID(), claims = JSON.parse(Buffer.from(fixture.grant.split('.')[1], 'base64url'));
    fixture.grant = 'eg_v1.' + Buffer.from(JSON.stringify({ ...claims, jti: randomUUID(), messageId })).toString('base64url') + '.fixture-only';
    const body = { checkpointId: preview.checkpointId, workspaceDigest: preview.workspaceDigest, reviewDigest: preview.reviewDigest, grant: fixture.grant, messageId };
    assert.equal((await request(path, { ...body, missingDecisionIds: ['api'] })).status, 409);
    assert.equal((await request(path, { ...body, reviewDigest: '0'.repeat(64) })).status, 409);
    assert.equal(calls.length, countBefore, 'preview and invalid submission make no model calls');
    const result = await Promise.all([request(path, body), request(path, body)]);
    assert.deepEqual(result.map(r => r.status).sort(), [202, 409]);
    const after = await until(async () => {
      const state = (await request(`/threads/${root}/state`)).body;
      if (state.status === 'failed') throw new Error(state.error);
      return state.status === 'interrupted' && fixture.qa === 2 ? state : null;
    }, `targeted ${fixture.mode} correction`);
    assert.deepEqual([fixture.plans, fixture.qa, fixture.coder], [1, 2, fixture.mode === 'missing-accept' ? 1 : 0]);
    assert.deepEqual(calls.slice(countBefore).map(c => c.phase), fixture.mode === 'missing-accept' ? ['review', 'implement_ticket'] : ['review']);
    assert.equal(after.values.qa_review_repair_count, 1); assert.equal(after.values.qa_review_repair_pending, false);
    assert.equal(after.values.qa_acceptance_policy_version, 1);
    for (const field of ['plan', 'context', 'plan_revision', 'design_refinement_count', 'technical_investigation_count', 'argus_bundle_ids', 'allowed_files', 'human_approved', 'pr_approved']) {
      assert.deepEqual(after.values[field], source.values[field], field);
    }
    const sourceAgain = await codingWorkflow.getState({ configurable: { thread_id: root, checkpoint_id: preview.checkpointId } });
    assert.equal(sourceAgain.values.qa_response_receipt.response, source.values.qa_response_receipt.response);
    assert.equal((await request(path)).body.available, false, 'no second correction');
    assert.equal((await request(path, body)).status, 409);
    if (fixture.mode === 'missing-mutate') assert.equal(after.values.technical_response_failure.category, 'integrity');
    else {
      assert.equal(after.values.technical_response_failure, null);
      assert.equal(JSON.parse(after.values.qa_test_plan).testCases.length, fixture.originalAnswer.testCases.length);
    }
    if (fixture.mode === 'missing-reject') assert.equal(after.values.development_findings[0].kind, 'environment');
    fixture.correctionBody = body; fixture.correctionCheckpoint = after.checkpoint_id;
  }
  assert.ok(commands.every(cmd => !/git.*(?:commit|push)|jenkins|docker build/.test(cmd)), 'no delivery commands');
  const count = calls.length;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  await pool.query("UPDATE argus_langgraph_threads SET status='running' WHERE thread_id=$1", [retryRoot]);
  await pool.query("INSERT INTO argus_langgraph_runs (run_id,thread_id,kind,payload,base_checkpoint_id,status) VALUES ($1,$2,'continue',$3::jsonb,$4,'running')",
    [randomUUID(), retryRoot, JSON.stringify({ qaRetry: retryBody }), afterRetry.checkpoint_id]);
  const [omissionRoot, omissionFixture] = [...cases].find(([, f]) => f.mode === 'missing-mutate');
  await pool.query("UPDATE argus_langgraph_threads SET status='running' WHERE thread_id=$1", [omissionRoot]);
  await pool.query("INSERT INTO argus_langgraph_runs (run_id,thread_id,kind,payload,base_checkpoint_id,status) VALUES ($1,$2,'continue',$3::jsonb,$4,'running')",
    [randomUUID(), omissionRoot, JSON.stringify({ qaRetry: omissionFixture.correctionBody }), omissionFixture.correctionCheckpoint]);
  child = launch(false); await until(() => fetch(`${base}/healthz`).then(r => r.ok).catch(() => false), 'Pack restart');
  for (const [root, fixture] of cases) {
    const saved = (await request(`/threads/${root}/state`)).body;
    assert.equal(saved.status, fixture.retry || root === omissionRoot ? 'failed' : 'interrupted'); assert.equal(saved.values.technical_design_policy_version, 1);
    if (fixture.retry || root === omissionRoot) assert.match(saved.error, /No automatic replay/);
    if (fixture.mode?.startsWith('missing-')) {
      assert.equal(saved.values.qa_review_repair_count, 1); assert.equal(saved.values.qa_acceptance_policy_version, 1);
      assert.equal((await request(`/threads/${root}/qa-retry`)).body.available, false);
    }
    assert.equal(saved.values.technical_investigation_count, fixture.mode ? 0 : 1);
    assert.equal(saved.values.technical_experiment_count, fixture.experiment ? 1 : 0);
    assert.equal(fixture.experiments, fixture.experiment ? 1 : 0);
    if (fixture.mode?.endsWith('-error') && !fixture.recovered && !fixture.retry) assert.equal(saved.values.technical_response_failure.category, fixture.mode.split('-')[0]);
    if (fixture.recovered) assert.ok(saved.values.technical_design_history.some(h => h.phase === 'response_recovery'));
    if (fixture.mode === 'long-id') assert.equal(saved.values.technical_design_history.find(h => h.phase === 'review').responseRepairs.length, 1);
    if (fixture.mode === 'planner-string-evidence') {
      assert.deepEqual(saved.values.development_findings[0].evidence, [sandboxEvidence]);
      assert.equal(saved.values.technical_design_history[0].responseRepairs[0].kind, 'blocker_evidence_list');
      assert.equal(saved.values.technical_response_failure, null);
    }
  }
  assert.equal(calls.length, count, 'restart cannot replay the investigation or change existing policy');
  console.log('PASS: real A2A/HTTP/Postgres/LangGraph; bounded design loop; optional same-Planner experiment; server-bound fresh QA reviews; explicit QA retry; policy-1 omission correction reserves once before inference, preserves tests/verdicts/plan/Knowledge, permits genuine rejection, rejects weakened tests; duplicate requests and restart cannot replay correction; saved QA recheck; private receipt projection; active-worker/dirty-workspace/stale-hash/owner/Bundle refusal; no delivery approvals/writes. Synthetic agents, experiment receipts and seeded historical parser/policy stops only.');
} catch (error) { console.error(serverLog); throw error; }
finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  if (pool) await pool.end();
  if (saver) await saver.end();
  if (created) execFileSync('docker', ['stop', name], { stdio: 'pipe' });
}
