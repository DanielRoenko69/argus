/** Real LangGraph + disposable PostgreSQL, synthetic Core/workspace/model responses.
 * No live run, repository, model provider, Jenkins or human decision is touched.
 * The separate workspace certificate executes real pytest in the real sandbox.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import pg from 'pg';
import { Command } from '@langchain/langgraph';
const name = `argus-qa-graph-cert-${randomUUID().slice(0, 8)}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baseSha = 'a'.repeat(40), source = 'b'.repeat(64), repaired = 'c'.repeat(64);
const workspaceSessions = process.argv.includes('--workspace-sessions');
let executedCases = 0;
let fixture, pool, saver, created = false;
const unexpected = [];
const rejectedRepairs = {
  'stack-repair-test-rejected': 'stack_repair_test_forbidden',
  'stack-repair-invalid': 'stack_plan_invalid_schema',
  'stack-repair-unchanged': 'stack_repair_unchanged',
  'stack-repair-runtime-failed': 'stack_plan_operation_failed',
};
function environmentPlan(requirements = []) {
  const blocked = fixture.mode === 'environment-blocked';
  const p = { version: 1, status: blocked ? 'blocked' : 'ready', languages: ['python'], manifestSha256: '1'.repeat(64),
    profileId: blocked ? null : fixture.mode.startsWith('environment-repair') ? 'python-public-wheels-v1' : 'fixture', profileSha256: blocked ? null : hash(requirements), runtime: 'cpython-3.12.14-linux-aarch64',
    reasons: blocked ? ['environment_profile_required'] : [] };
  return { ...p, planSha256: hash([p.version, p.status, p.languages, p.manifestSha256, p.profileId, p.profileSha256, p.runtime, p.reasons]) };
}
const mock = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    const reply = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url.startsWith('/api/internal/telemetry/')) return reply({ ok: true });
    if (req.url === '/api/internal/agent-runtimes') return reply({ fixture: { agentId: 2, runtimeType: 'argus', profileId: null } });
    if (req.url === '/test-fixture') return reply({ passed: true, output: 'Synthetic repository suite passed' });
    if (req.url === '/exec') {
      fixture.commands.push(body.cmd);
      assert.match(body.cmd, /^git (status|diff|ls-files|rev-parse)\b/, 'no shell writes/commit/push/CI allowed');
      return reply({ stdout: body.cmd.includes('status') ? ' M motor.py\n' : body.cmd.includes('rev-parse') ? baseSha : '', stderr: '', exit_code: 0 });
    }
    if (req.url === '/api/agents/2/stack-tests') {
      assert.equal(req.headers.authorization, 'Bearer ' + fixture.grant);
      if (workspaceSessions) assert.equal(body.executionMode, 'workspace-session-v1');
      if (body.action === 'inspect') return reply({ sourceSha256: fixture.source, files: 1, excludedFiles: 0, python: false });
      const project = body.action === 'project';
      if (project) fixture.stackProjects++; else { fixture.executions++; fixture.testHashes.push(hash(body.files)); }
      const newPolicyFailure = fixture.mode.startsWith('stack-v1-') && (fixture.mode === 'stack-v1-exhausted'
        || ['stack-v1-cycle', 'stack-v1-setup-regression'].includes(fixture.mode) && fixture.stackProjects <= 2
        || fixture.mode === 'stack-v1-fourth-pass' && fixture.stackProjects <= 4
        || ['stack-v1-checkpoint', 'stack-v1-expired', 'stack-v1-preinstall-expired', 'stack-v1-preinstall-stale'].includes(fixture.mode) && fixture.stackProjects === 1);
      const setupFailure = project && (newPolicyFailure || fixture.mode === 'stack-output-stop' || fixture.mode === 'stack-exhausted' || (fixture.mode === 'stack-repair-setup' || fixture.mode in rejectedRepairs) && fixture.stackProjects === 1);
      assert.equal(body.stackPlan.test, 'frozen-repository-tests', 'server-owned test commands stay identical');
      const missing = !project && fixture.mode === 'stack-repair-qa' && fixture.executions === 1;
      const assertion = !project && fixture.mode === 'stack-product-repair' && fixture.executions === 1;
      const startupFailure = project && (fixture.mode === 'stack-startup-timeout' || fixture.mode === 'stack-startup-exhausted'
        || fixture.mode === 'stack-repair-startup' && fixture.stackProjects === 1)
        || !project && fixture.mode === 'stack-qa-startup-timeout';
      const failed = setupFailure || startupFailure || missing || assertion;
      const stdout = setupFailure && fixture.mode.startsWith('stack-v1-')
        ? fixture.stackProjects === 1 ? 'FIRST_FAILURE: release asset HTTP 404' : 'LATER_FAILURE: browser installer terminated'
        : setupFailure || missing ? 'ModuleNotFoundError: fixture_dependency' : 'Synthetic stack test evidence';
      const image = 'sha256:' + hash([fixture.source, body.stackPlan]);
      const preparedSession = hash([fixture.root, fixture.source, body.stackPlan]);
      if (workspaceSessions && !project) assert.equal(body.preparedSession, preparedSession);
      return reply({ version: 1, threadId: fixture.root, basisSha256: body.basisSha256, sourceSha256: body.sourceSha256,
        testSha256: hash(project ? body.stackPlan.test : body.files), requestSha256: 'd'.repeat(64), profile: workspaceSessions ? 'workspace-session-v1' : 'stack-container-v1',
        status: setupFailure || startupFailure ? 'preparation_failed' : failed ? 'failed' : 'completed', exitCode: failed ? 1 : 0,
        stdout, stderr: '', durationMs: 1, passed: !failed, assertionFailed: assertion, collected: project || missing || startupFailure ? 0 : 1,
        nodes: project || missing || startupFailure ? [] : ['test_seed.py::test_seed'], missingModules: missing ? ['fixture_dependency'] : [], executionStarted: !setupFailure && !startupFailure,
        outputSha256: hash([stdout, '']), finishedAt: new Date().toISOString(),
        stackEnvironment: { version: 1, phase: setupFailure ? 'setup' : project ? 'project' : 'qa',
          planSha256: hash(body.stackPlan), baseImage: 'sha256:' + 'e'.repeat(64), preparedImage: setupFailure || workspaceSessions ? null : image,
          brokerRequestSha256: workspaceSessions && project ? preparedSession : 'f'.repeat(64),
          ...(workspaceSessions ? { executionMode: 'workspace-session-v1', sessionId: hash(fixture.root), preparedSession: setupFailure ? null : preparedSession } : {}),
          ...(startupFailure ? { testStarted: false, executionStatus: fixture.mode.endsWith('timeout') ? 'timeout' : 'failed' } : {}),
          ...(fixture.mode === 'stack-output-stop' ? { executionStatus: 'output_limit' } : {}),
          ...(fixture.mode === 'stack-verbose-pass' ? { executionStatus: failed ? 'failed' : 'completed',
            outputCapture: { version: 1, stdoutBytes: project ? 4000000 : 64, stderrBytes: 0, stdoutTruncated: project, stderrTruncated: false } } : {}) } });
    }
    if (req.url === '/api/agents/2/code-generation') {
      fixture.generations++;
      if (workspaceSessions) assert.equal(body.executionMode, 'workspace-session-v1');
      assert.equal(req.headers.authorization, 'Bearer ' + fixture.grant);
      if (fixture.mode === 'codegen-failed') return reply({ code: 'codegen_generation_failed_no_import' }, 409);
      assert.equal(body.sourceSha256, fixture.source);
      assert.deepEqual(body.plan.outputPaths, ['client.ts']);
      if (fixture.mode === 'codegen-unknown') return reply({ code: 'codegen_evidence_unavailable_no_replay' }, 503);
      if (fixture.mode === 'codegen-legacy-failed' || fixture.mode === 'codegen-timeout'
        || fixture.mode.startsWith('codegen-repair-') && (fixture.generations === 1 || ['codegen-repair-exhausted', 'codegen-repair-cycle'].includes(fixture.mode))) {
        const failure = { phase: fixture.mode === 'codegen-repair-setup' ? 'setup' : 'generate',
          status: fixture.mode === 'codegen-timeout' ? 'timeout' : 'failed', exitCode: fixture.mode === 'codegen-timeout' ? null : 1,
          stdout: '', stderr: 'FIRST_SUPERUSER: reserved email domain rejected by fixture validator', durationMs: 1 };
        return reply({ code: 'codegen_generation_failed_no_import', failure: { ...failure, outputSha256: hash([failure.stdout, failure.stderr]) } }, 409);
      }
      fixture.source = '9'.repeat(64);
      return reply({ version: 1, threadId: fixture.root, requestSha256: hash({ ...body, threadId: fixture.root, workspaceRoot: '/workspace/QA-FIXTURE', allowedPaths: [] }),
        basisSha256: body.basisSha256, sourceSha256: body.sourceSha256, resultSourceSha256: fixture.source, planSha256: hash(body.plan),
        brokerRequestSha256: '8'.repeat(64), baseImage: 'sha256:' + '7'.repeat(64), applied: true,
        outputs: [{ path: 'client.ts', beforeSha256: null, sha256: '6'.repeat(64) }], finishedAt: new Date().toISOString(),
        ...(workspaceSessions ? { executionMode: 'workspace-session-v1' } : {}) });
    }
    if (req.url === '/api/agents/2/qa-tests') {
      assert.equal(req.headers.authorization, 'Bearer fixture-grant');
      if (body.action === 'inspect') return reply({ sourceSha256: fixture.source, files: 1, excludedFiles: 0, python: true,
        ...(body.environmentPolicyVersion === 1 ? { environment: environmentPlan(body.environmentRequirements) } : {}) });
      fixture.executions++;
      fixture.testHashes.push(hash(body.files));
      if (fixture.mode === 'unavailable') return reply({ error: 'unknown execution result' }, 503);
      const fail = fixture.mode === 'exhausted' || (fixture.mode === 'repair' && fixture.executions === 1);
      const empty = fixture.mode === 'empty';
      const preparationFailed = fixture.mode === 'environment-preparation-failed';
      const missing = fixture.mode.startsWith('environment-repair') && (fixture.executions === 1 || fixture.mode === 'environment-repair-exhausted');
      const stdout = 'Synthetic pytest receipt', stderr = '';
      return reply({ version: 1, threadId: fixture.root, basisSha256: body.basisSha256, sourceSha256: body.sourceSha256,
        testSha256: hash(body.files), requestSha256: 'd'.repeat(64), profile: 'python-bwrap-v1',
        status: preparationFailed ? 'preparation_failed' : fail || missing ? 'failed' : 'completed', exitCode: preparationFailed ? null : fail || missing ? 1 : 0, stdout, stderr, durationMs: 1,
        ...(missing ? { missingModules: ['hypothesis'] } : {}),
        passed: !fail && !empty && !preparationFailed && !missing, assertionFailed: fail, collected: empty || preparationFailed ? 0 : 1,
        nodes: empty || preparationFailed ? [] : ['test_seed.py::test_seed'], outputSha256: hash([stdout, stderr]), finishedAt: new Date().toISOString(),
        ...(body.environmentPolicyVersion === 1 ? { executionStarted: !preparationFailed, environment: { version: 1,
          status: preparationFailed ? 'blocked' : 'ready', reason: preparationFailed ? 'environment_install_failed' : null, plan: environmentPlan(body.environmentRequirements),
          packages: preparationFailed ? [] : [{ name: 'packaging', version: '25.0', sha256: '3'.repeat(64) }],
          installationOutputSha256: '4'.repeat(64), preflightOutputSha256: preparationFailed ? null : '5'.repeat(64) } } : {}) });
    }
    if (/^\/api\/agents\/[23]\/chat$/.test(req.url)) {
      const prompt = body.message;
      let response;
      if (body.worker_task_type === 'implement_ticket') {
        fixture.coder++;
        if (!fixture.mode.startsWith('codegen-')) assert.match(prompt, /Independent QA tests failed/);
        else if (fixture.mode !== 'codegen-noop') assert.match(prompt, /Do not run the generator or install/);
        fixture.source = repaired;
        response = { version: 2, status: 'ready', summary: 'Synthetic product correction', blockers: [] };
      } else {
        if (fixture.mode !== 'legacy') assert.deepEqual(body.execution_tool_allow_patterns, ['workspace_ls', 'workspace_read', 'argus_code_search']);
        else assert.equal(body.execution_tool_allow_patterns, undefined, 'legacy review policy remains unchanged');
        if (prompt.startsWith('Inspect whether the requested implementation requires repository-owned code generation')) {
          fixture.generationPlans++;
          response = fixture.mode === 'codegen-noop' ? { version: 1, status: 'not_needed', summary: 'No generator needed' }
            : { version: 1, status: 'ready', plan: { version: 1, summary: 'Fixture generator', setup: 'install', start: '', generate: 'generate', outputPaths: [fixture.mode === 'codegen-scope' ? '.env' : 'client.ts'] } };
        } else if (prompt.startsWith('Repair the failed isolated repository generator recipe.')) {
          fixture.generationRepairs++;
          assert.match(prompt, /NO output import/); assert.match(prompt, /Do NOT submit outputPaths/);
          assert.match(prompt, /FIRST_SUPERUSER: reserved email domain rejected/);
          assert.match(prompt, /Frozen QA plan/);
          response = { version: 1, status: 'ready', summary: 'Validator-backed disposable config', setup: 'install',
            start: `export FIXTURE_CORRECTION=${fixture.generationRepairs}`, generate: 'generate' };
          if (fixture.mode === 'codegen-repair-unchanged' || fixture.mode === 'codegen-repair-cycle' && fixture.generationRepairs === 2) response.start = '';
          if (fixture.mode === 'codegen-repair-scope') response.outputPaths = ['client.ts'];
          if (fixture.mode === 'codegen-repair-blocked') response = { version: 1, status: 'blocked', summary: 'Product change required; no recipe workaround' };
          if (fixture.mode === 'codegen-repair-stale') fixture.source = '4'.repeat(64);
          if (fixture.mode === 'codegen-repair-agent-failed') return reply({ error: 'fixture private runtime detail' }, 503);
        } else if (prompt.startsWith('You are the independent QA acceptance test author.')) {
          fixture.authors++;
          assert.match(prompt, /original requirements/); assert.match(prompt, /EVERY current technical decision/);
          response = { version: 1, status: fixture.mode === 'blocked' ? 'blocked' : 'ready', summary: 'Independent seed case',
            blockers: fixture.mode === 'blocked' ? ['Contract requires 13 states, implementation reports 14.'] : [],
            files: [{ id: 'seed', content: 'def test_seed(): assert True\n', qaCaseIds: ['seed'], expected: 'Integer seed accepted', oracle: 'Original fixture brief' }] };
          if (fixture.mode === 'invalid') response.files[0].id = '../motor';
          if (fixture.mode === 'author-stale') fixture.source = repaired;
        } else if (/^(Prepare|Repair) a (disposable Linux test environment|run-private reusable Linux workspace)\./.test(prompt)) {
          fixture.stackPlans++;
          const isRepair = prompt.startsWith('Repair');
          assert.equal(isRepair, fixture.stackPlans > 1);
          assert.match(prompt, /Do not install anything in the workspace/);
          if (isRepair) assert.match(prompt, /Do NOT return a test field/);
          if (fixture.mode === 'stack-stale') fixture.source = repaired;
          response = { version: 1, summary: 'Synthetic polyglot setup', setup: `install-runtime-${fixture.stackPlans}`,
            start: 'start-local-services', ...(!isRepair ? { test: 'frozen-repository-tests' } : {}), python: '/opt/test/bin/python' };
          if (isRepair && fixture.mode === 'stack-repair-test-rejected') response.test = 'frozen-repository-tests';
          if (isRepair && fixture.mode === 'stack-repair-invalid') response.image = 'untrusted';
          if (isRepair && fixture.mode === 'stack-repair-unchanged') response.setup = 'install-runtime-1';
          if (isRepair && fixture.mode === 'stack-repair-runtime-failed') return reply({ error: 'fixture private failure' }, 503);
          if (isRepair && fixture.mode.startsWith('stack-v1-')) {
            assert.match(prompt, /Retained environment attempt history/);
            assert.match(prompt, /FIRST_FAILURE: release asset HTTP 404/);
            assert.match(prompt, /Environment repair \d\/4/);
            if (fixture.stackPlans > 2) assert.match(prompt, /LATER_FAILURE: browser installer terminated/);
            if (fixture.stackPlans === 3 && ['stack-v1-cycle', 'stack-v1-setup-regression'].includes(fixture.mode)) {
              response.setup = 'install-runtime-1'; response.summary = 'Different explanation of the old failure';
              if (fixture.mode === 'stack-v1-setup-regression') response.start = 'different-start-only';
            }
          }
        } else if (prompt.startsWith('You are diagnosing a missing Python dependency')) {
          fixture.environmentRepairs++;
          assert.match(prompt, /FROZEN/);
          response = { status: 'ready', reason: 'Independent test imports hypothesis',
            requirements: [{ requirement: 'hypothesis>=6', reason: 'test_seed.py missing import receipt' }] };
          if (fixture.mode === 'environment-repair-stale') fixture.source = repaired;
        } else {
          fixture.reviews++;
          assert.match(prompt, /You are a code review agent/);
          response = { verdict: 'APPROVE', summary: 'Synthetic review', findings: [], required_changes: [] };
        }
      }
      fixture.lastTrace = randomUUID();
      return reply({ response: JSON.stringify(response), trace_id: fixture.lastTrace, session_id: randomUUID(), iterations: 1, tool_calls: [], agent: { id: 2, name: 'fixture', model: 'synthetic' } });
    }
    throw new Error(`Unexpected mock request: ${req.url}`);
  } catch (e) { unexpected.push(String(e)); res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
});
try {
  execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=qa_cert', 'postgres:16-alpine'], { stdio: 'pipe' });
  created = true;
  const port = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  const db = `postgresql://postgres@127.0.0.1:${port}/qa_cert`;
  pool = new pg.Pool({ connectionString: db });
  const deadline = Date.now() + 20000;
  while (!(await pool.query('SELECT 1').then(() => true).catch(() => false))) {
    if (Date.now() > deadline) throw new Error('Disposable DB unavailable');
    await new Promise(r => setTimeout(r, 100));
  }
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const url = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, { POSTGRES_CONNECTION_URL: db, ARGUS_URL: url, AGENT_WORKSPACE_URL: url,
    WORKSPACE_SECRET: 'fixture-only', PLANNER_AGENT_ID: '1', REVIEWER_AGENT_ID: '2', CODER_AGENT_ID: '3',
    TEST_WEBHOOK_URL: url + '/test-fixture' });
  const { codingWorkflow: graph, codingCheckpointer } = await import('../dist/workflows/coding.js'); saver = codingCheckpointer;
  const { CODING_MAX_REVISIONS } = await import('../dist/workflowCatalog.js');
  for (const mode of ['pass', 'repair', 'exhausted', 'blocked', 'invalid', 'unavailable', 'empty', 'author-stale', 'legacy',
    'environment-pass', 'environment-blocked', 'environment-preparation-failed', 'environment-before-planning',
    'environment-repair', 'environment-repair-exhausted', 'environment-repair-stale',
    'stack-pass', 'stack-verbose-pass', 'stack-output-stop', 'stack-repair-setup', 'stack-repair-qa', 'stack-exhausted', 'stack-stale', 'stack-product-repair', 'stack-repair-startup', 'stack-startup-timeout', 'stack-startup-exhausted', 'stack-qa-startup-timeout', ...Object.keys(rejectedRepairs),
    'stack-v1-exhausted', 'stack-v1-cycle', 'stack-v1-setup-regression', 'stack-v1-fourth-pass', 'stack-v1-checkpoint', 'stack-v1-expired',
    'stack-v1-preinstall-expired', 'stack-v1-preinstall-stale',
    'codegen-pass', 'codegen-failed', 'codegen-noop', 'codegen-scope', 'codegen-unknown', 'codegen-timeout', 'codegen-legacy-failed',
    'codegen-repair-pass', 'codegen-repair-setup', 'codegen-repair-exhausted', 'codegen-repair-unchanged', 'codegen-repair-scope',
    'codegen-repair-blocked', 'codegen-repair-stale', 'codegen-repair-agent-failed', 'codegen-repair-cycle', 'codegen-repair-checkpoint'].filter(mode => !workspaceSessions || [
      'stack-pass', 'stack-product-repair', 'stack-repair-setup', 'stack-repair-qa', 'stack-exhausted', 'stack-startup-timeout',
      'codegen-pass', 'codegen-repair-pass', 'codegen-unknown', 'codegen-scope'].includes(mode))) {
    fixture = { mode, root: randomUUID(), source, authors: 0, executions: 0, coder: 0, reviews: 0, environmentRepairs: 0, stackPlans: 0, stackProjects: 0, commands: [], testHashes: [] };
    fixture.generations = 0; fixture.generationPlans = 0; fixture.generationRepairs = 0;
    fixture.grant = mode.startsWith('codegen-') ? 'eg_v1.' + Buffer.from(JSON.stringify({ rootTraceId: fixture.root, workspaceRoot: '/workspace/QA-FIXTURE', codeGeneration: { version: 1, allowedPaths: [] } })).toString('base64url') + '.fixture' : 'fixture-grant';
    const cfg = { configurable: { thread_id: fixture.root }, recursionLimit: 100 };
    // Seed this disposable checkpoint at the existing Coder boundary only.
    // The new nodes, routing, retries, review and real human interrupt execute unchanged.
    await graph.updateState(cfg, { ticket_id: 'QA-FIXTURE', description: 'Support integer reset seeds',
      development_contract_version: 2, qa_acceptance_policy_version: mode === 'legacy' ? 0 : 1,
      qa_environment_policy_version: mode.startsWith('stack-') || mode.startsWith('codegen-') ? workspaceSessions ? 3 : 2 : mode.startsWith('environment-') ? 1 : 0,
      ...(mode.startsWith('stack-v1-') ? { stack_repair_policy_version: 1 } : {}),
      code_generation_policy_version: mode.startsWith('codegen-') ? 1 : 0,
      ...(mode === 'codegen-legacy-failed' ? {} : { code_generation_repair_policy_version: mode.startsWith('codegen-') ? 1 : 0 }),
      ...(mode === 'environment-before-planning' ? { workflow_blockers: ['Project environment profile required'],
        development_findings: [{ kind: 'environment', source: 'system', summary: 'Project environment profile required', evidence: [] }] } : {}),
      technical_design_policy_version: 1, technical_decisions: [{ id: 'seed', revision: 1, status: 'qa_checked',
        topic: 'Reset', specification: 'Integer seed accepted', requirementRefs: ['Original fixture brief'], evidence: ['motor.py:1'] }],
      qa_test_plan: JSON.stringify({ testCases: [{ id: 'seed' }] }), workspace_dir: '/workspace/QA-FIXTURE',
      base_commit_sha: baseSha, argus_execution_grant: fixture.grant, code: 'Synthetic initial implementation',
      plan: 'Seeded reset', retry_count: 0, ci_provider: 'jenkins' }, mode === 'environment-before-planning' ? 'setup_workspace' : mode.startsWith('codegen-') ? 'test_design' : 'coder');
    if (['stack-v1-checkpoint', 'stack-v1-expired', 'stack-v1-preinstall-expired', 'stack-v1-preinstall-stale'].includes(mode)) {
      await graph.invoke(null, { ...cfg, interruptAfter: ['stack_environment_reserve'] });
      const retained = await graph.getState(cfg);
      assert.deepEqual(retained.next, ['stack_environment']);
      assert.equal(retained.values.stack_repair_count, 1);
      assert.equal(retained.values.stack_repair_pending, true);
      assert.ok(retained.values.stack_repair_started_at > 0);
      assert.equal(fixture.stackPlans, 1, 'reservation precedes repair inference');
      if (mode === 'stack-v1-expired') await graph.updateState(cfg,
        { stack_repair_started_at: Date.now() - 45 * 60000 - 1 }, 'stack_environment_reserve');
      if (mode.startsWith('stack-v1-preinstall-')) {
        await graph.invoke(null, { ...cfg, interruptAfter: ['stack_environment'] });
        assert.deepEqual((await graph.getState(cfg)).next, ['tests']);
        assert.equal(fixture.stackPlans, 2); assert.equal(fixture.stackProjects, 1);
        if (mode.endsWith('expired')) await graph.updateState(cfg,
          { stack_repair_started_at: Date.now() - 45 * 60000 - 1 }, 'stack_environment');
        else fixture.source = repaired;
      }
    }
    if (mode === 'codegen-repair-checkpoint') {
      await graph.invoke(null, { ...cfg, interruptBefore: ['code_generation_repair'] });
      const retained = await graph.getState(cfg);
      assert.deepEqual(retained.next, ['code_generation_repair']);
      assert.equal(retained.values.code_generation_repair_count, 1);
      assert.equal(fixture.generationRepairs, 0, 'budget is persisted before inference');
      assert.equal(retained.values.code_generation_failure.sourceSha256, repaired);
      assert.equal(fixture.coder, 1);
      // Explicit continuation of this disposable fixture only; no live run replay.
    }
    await graph.invoke(null, cfg);
    const state = await graph.getState(cfg), v = state.values;
    assert.equal(v.human_approved, false); assert.equal(v.pr_approved, false); assert.equal(v.branch_pushed, false);
    assert.equal(v.qa_acceptance_policy_version, mode === 'legacy' ? 0 : 1);
    if (mode.startsWith('codegen-')) {
      assert.equal(fixture.generationPlans, 1);
      const repairedPass = ['codegen-repair-pass', 'codegen-repair-setup', 'codegen-repair-checkpoint'].includes(mode);
      const repairCalls = mode === 'codegen-repair-exhausted' || mode === 'codegen-repair-cycle' ? 2 : mode.startsWith('codegen-repair-') ? 1 : 0;
      assert.equal(fixture.generations, ['codegen-noop', 'codegen-scope'].includes(mode) ? 0
        : mode === 'codegen-repair-exhausted' ? 3 : repairedPass || mode === 'codegen-repair-cycle' ? 2 : 1);
      assert.equal(fixture.generationRepairs, repairCalls);
      assert.equal(v.code_generation_repair_count, repairCalls);
      assert.equal(v.code_generation_needs_repair, false);
      assert.equal(v.code_generation_repair_pending, false);
      if (mode === 'codegen-legacy-failed') assert.equal(v.code_generation_repair_policy_version, 0);
      assert.equal(fixture.coder, mode === 'codegen-scope' ? 0 : 1);
      const passed = ['codegen-pass', 'codegen-noop'].includes(mode) || repairedPass;
      assert.deepEqual(state.next, [passed ? 'human_approval' : 'requirements_input']);
      assert.equal(fixture.stackProjects, passed ? 1 : 0);
      assert.equal(fixture.authors, passed ? 1 : 0); assert.equal(fixture.reviews, passed ? 1 : 0);
      assert.equal(v.tests_passed, passed); assert.equal(v.qa_receipt?.passed ?? false, passed);
      assert.equal(v.retry_count, 0);
      if (mode === 'codegen-pass' || repairedPass) assert.equal(v.qa_receipt.sourceSha256, v.code_generation_receipt.resultSourceSha256);
      assert.equal(v.plan, 'Seeded reset', 'generator repair must not rerun Planner');
      assert.equal(v.qa_test_plan, JSON.stringify({ testCases: [{ id: 'seed' }] }));
      assert.equal(v.code_generation_decision?.status === 'ready' ? v.code_generation_decision.plan.outputPaths.join(',') : '', mode === 'codegen-scope' || mode === 'codegen-noop' ? '' : 'client.ts');
      if (['codegen-repair-scope', 'codegen-repair-stale', 'codegen-repair-unchanged', 'codegen-repair-agent-failed'].includes(mode))
        assert.equal(v.code_generation_decision.plan.start, '', 'rejected correction preserves prior recipe');
      assert.doesNotMatch(v.workflow_blockers.join('\n'), /fixture private runtime detail/);
    } else if (mode.startsWith('stack-v1-')) {
      assert.equal(fixture.coder, 0); assert.equal(v.plan, 'Seeded reset');
      assert.equal(v.stack_plan.test, 'frozen-repository-tests');
      assert.equal(v.stack_repair_pending, false);
      if (['stack-v1-fourth-pass', 'stack-v1-checkpoint'].includes(mode)) {
        assert.deepEqual(state.next, ['human_approval']);
        assert.equal(v.stack_repair_count, mode === 'stack-v1-fourth-pass' ? 4 : 1);
        assert.equal(fixture.stackProjects, mode === 'stack-v1-fourth-pass' ? 5 : 2);
        assert.equal(v.qa_receipt.passed, true); assert.equal(fixture.authors, 1);
      } else {
        assert.deepEqual(state.next, ['requirements_input']);
        assert.equal(fixture.authors, 0); assert.equal(fixture.reviews, 0);
        const expected = mode === 'stack-v1-exhausted' ? [5, 5, 4, 'stack_repair_limit']
          : mode === 'stack-v1-expired' ? [1, 1, 1, 'stack_repair_window_elapsed']
          : mode.startsWith('stack-v1-preinstall-') ? [1, 2, 1, mode.endsWith('expired') ? 'stack_repair_window_elapsed' : 'stack_repair_source_changed']
          : [2, 3, 2, mode === 'stack-v1-cycle' ? 'stack_repair_repeated_recipe' : 'stack_repair_repeated_setup'];
        assert.equal(fixture.stackProjects, expected[0]); assert.equal(fixture.stackPlans, expected[1]);
        assert.equal(v.stack_repair_count, expected[2]); assert.match(v.workflow_blockers.join('\n'), new RegExp(expected[3]));
        if (mode.includes('cycle') || mode.includes('regression')) assert.equal(v.stack_plan.setup, 'install-runtime-2', 'rejected recipe is never applied');
      }
    } else if (mode.startsWith('stack-')) {
      if (mode === 'stack-qa-startup-timeout') {
        assert.deepEqual(state.next, ['requirements_input']);
        assert.equal(fixture.coder, 0); assert.equal(fixture.reviews, 0);
        assert.equal(fixture.authors, 1); assert.equal(fixture.executions, 1);
        assert.equal(v.stack_repair_count, 0); assert.equal(v.qa_receipt.executionStarted, false);
        assert.match(v.workflow_blockers.join('\n'), /service startup stopped before tests/);
      } else if (mode === 'stack-output-stop' || mode === 'stack-startup-timeout') {
        assert.deepEqual(state.next, ['requirements_input']);
        assert.equal(fixture.stackPlans, 1); assert.equal(fixture.stackProjects, 1);
        assert.equal(v.stack_repair_count, 0); assert.equal(fixture.coder, 0); assert.equal(fixture.authors, 0);
        assert.match(v.workflow_blockers.join('\n'), mode === 'stack-output-stop' ? /execution=output_limit/ : /tests not started/);
      } else if (mode in rejectedRepairs) {
        assert.deepEqual(state.next, ['requirements_input']);
        assert.equal(fixture.reviews, 0); assert.equal(fixture.coder, 0);
        assert.equal(fixture.stackProjects, 1); assert.equal(fixture.stackPlans, 2);
        assert.equal(v.stack_repair_count, 1); assert.equal(v.stack_needs_repair, false);
        assert.equal(v.stack_plan.setup, 'install-runtime-1', 'rejected repair does not replace the saved plan');
        assert.equal(v.stack_plan.test, 'frozen-repository-tests');
        const failure = v.qa_history.findLast(h => h.phase === 'stack_plan_rejected');
        assert.equal(failure.code, rejectedRepairs[mode]);
        if (mode !== 'stack-repair-runtime-failed') assert.equal(failure.traceId, fixture.lastTrace);
        assert.match(v.workflow_blockers.join('\n'), new RegExp(rejectedRepairs[mode]));
        assert.doesNotMatch(v.workflow_blockers.join('\n'), /fixture private failure/);
      } else if (['stack-exhausted', 'stack-stale', 'stack-startup-exhausted'].includes(mode)) {
        assert.deepEqual(state.next, ['requirements_input']);
        assert.equal(fixture.reviews, 0); assert.equal(fixture.coder, 0);
        assert.equal(fixture.stackProjects, mode === 'stack-stale' ? 0 : 3);
        assert.equal(v.stack_repair_count, mode === 'stack-stale' ? 0 : 2);
        if (mode === 'stack-stale') assert.match(v.workflow_blockers.join('\n'), /stack_plan_source_changed/);
      } else {
        assert.deepEqual(state.next, ['human_approval']);
        assert.equal(fixture.authors, 1); assert.equal(fixture.reviews, 1);
        assert.equal(v.qa_receipt.passed, true);
        assert.equal(v.stack_result.passed, true);
        assert.equal(v.qa_receipt.stackEnvironment.preparedImage, v.stack_result.stackEnvironment.preparedImage);
        if (workspaceSessions) {
          assert.equal(v.qa_receipt.stackEnvironment.preparedImage, null);
          assert.equal(v.qa_receipt.stackEnvironment.preparedSession, v.stack_result.stackEnvironment.preparedSession);
          assert.equal(v.qa_receipt.profile, 'workspace-session-v1');
        }
        assert.equal(new Set(fixture.testHashes).size, 1, 'general stack never re-authors frozen QA');
        assert.equal(fixture.coder, mode === 'stack-product-repair' ? 1 : 0);
        assert.equal(v.stack_repair_count, mode.includes('repair') && mode !== 'stack-product-repair' ? 1 : 0);
        assert.equal(fixture.stackPlans, ['stack-repair-setup', 'stack-repair-qa', 'stack-repair-startup'].includes(mode) ? 2 : 1);
      }
    } else if (['pass', 'repair', 'legacy', 'environment-pass', 'environment-repair'].includes(mode)) {
      assert.deepEqual(state.next, ['human_approval']);
      assert.equal(fixture.reviews, 1);
      assert.equal(fixture.authors, mode === 'legacy' ? 0 : 1);
      assert.equal(fixture.coder, mode === 'repair' ? 1 : 0);
      if (mode !== 'legacy') assert.equal(v.qa_receipt.passed, true);
      if (mode === 'repair') {
        assert.equal(fixture.executions, 2); assert.equal(v.retry_count, 1);
        assert.equal(new Set(fixture.testHashes).size, 1, 'QA sources remain frozen across product correction');
        assert.equal(v.revision_history.at(-1).trigger, 'qa');
      }
      if (mode === 'environment-repair') {
        assert.equal(fixture.environmentRepairs, 1); assert.equal(v.qa_environment_repair_count, 1);
        assert.equal(fixture.executions, 2); assert.equal(v.retry_count, 0); assert.equal(fixture.coder, 0);
        assert.equal(new Set(fixture.testHashes).size, 1, 'dependency repair cannot re-author or weaken tests');
        assert.equal(v.qa_environment_requirements[0].requirement, 'hypothesis>=6');
      }
      if (mode === 'pass') {
        fixture.source = repaired;
        // Synthetic approval only: stale binding must throw BEFORE any delivery.
        await assert.rejects(graph.invoke(new Command({ resume: { approved: true } }), cfg), /workspace changed/);
        assert.equal((await graph.getState(cfg)).values.human_approved, false);
      }
    } else if (mode === 'exhausted') {
      assert.deepEqual(state.next, []); assert.equal(v.retry_count, CODING_MAX_REVISIONS);
      assert.equal(fixture.authors, 1); assert.equal(fixture.coder, CODING_MAX_REVISIONS);
      assert.equal(fixture.executions, CODING_MAX_REVISIONS + 1); assert.equal(fixture.reviews, 0);
    } else {
      assert.deepEqual(state.next, ['requirements_input']);
      assert.equal(fixture.coder, 0); assert.equal(fixture.reviews, 0); assert.equal(v.qa_receipt?.passed ?? false, false);
      assert.equal(fixture.executions, mode === 'environment-repair-exhausted' ? 2 : ['unavailable', 'empty', 'environment-preparation-failed', 'environment-repair-stale'].includes(mode) ? 1 : 0);
      if (mode.startsWith('environment-repair')) assert.equal(fixture.environmentRepairs, 1);
      if (['environment-before-planning', 'environment-blocked'].includes(mode)) assert.equal(fixture.authors, 0, 'no model work on missing environment');
    }
    assert.deepEqual(unexpected, []);
    executedCases++;
  }
  console.log(JSON.stringify({ passed: true, cases: executedCases, providerCalls: 0, environmentMode: workspaceSessions ? 'workspace-session-v1' : 'legacy/all',
    checks: workspaceSessions ? ['workspace-mode request and receipt binding', 'human approval retained', 'bounded Coder correction', 'frozen QA sources',
      'setup and QA dependency repair', 'exhausted environment budget', 'startup timeout stop', 'generator ordering and repair', 'unknown generator no replay', 'protected generator scope']
    : ['verbose logs still reach independent QA and human gate', 'actual output limit never retries as a dependency repair', 'human approval retained', 'bounded Coder feedback', 'frozen QA sources', 'exhausted budget',
      'contradictory contract', 'invalid artifact', 'unknown receipt no replay', 'empty tests', 'stale source before approval', 'legacy unchanged',
      'managed environment binding', 'profile block without QA inference', 'preparation failure without Coder retry', 'profile gate before planning',
      'one dependency repair without Coder retry', 'dependency-repair budget exhausted', 'source drift during dependency repair',
      'polyglot stack planning', 'setup repair without product edit', 'QA repair retains frozen tests', 'two repairs exhausted',
      'source drift during stack planning', 'QA assertion correction prepares fresh source with same plan',
      'repair cannot submit tests', 'repair rejects authority injection', 'unchanged repair rejected', 'repair runtime failure sanitized without replay',
      'four repairs for new policy; legacy two unchanged', 'fourth correction can reach human gate', 'A-B-A recipe and setup regression rejected before execution',
      'complete bounded failure history in repair prompt', 'repair budget checkpoint before inference', 'expired saved window prevents repair inference',
      'source drift and expired window prevent repaired installer dispatch',
      'generator plan before Coder', 'isolated generation before tests/QA/review', 'legacy/unknown generator failure no automatic retry', 'no-op generator skipped', 'generator scope rejection before Coder',
      'two bounded generator recipe corrections', 'setup/generation correction preserves Coder and QA', 'recipe budget checkpoint before inference',
      'generator scope, source drift, repeated recipe and agent failure stop without replay', 'generator timeout never repairs'] }));
} finally {
  await saver?.end(); await pool?.end();
  await new Promise(r => mock.close(r));
  if (created) execFileSync('docker', ['stop', name], { stdio: 'pipe' });
}
