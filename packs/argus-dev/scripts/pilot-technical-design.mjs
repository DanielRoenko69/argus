/** Explicit live CONTRACT pilot, not a full authenticated Argus workflow.
 * Four calls maximum: proposal + QA, then one seeded investigation + QA.
 * Uses existing Planner/Reviewer assignments and protected workspace bridge;
 * no global changes, synthetic grants, delivery, or automatic retry/fallback.
 * npm run build && node scripts/pilot-technical-design.mjs --live
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { applyTechnicalProposal, applyTechnicalReview, technicalDesignContext, technicalFindingRecords,
  technicalPlanningRoute, reserveTechnicalInvestigation, TECHNICAL_PROPOSAL_INSTRUCTION,
  TECHNICAL_REVIEW_INSTRUCTION } from '../dist/technicalDesign.js';
import { decisionRequest, validateDecisionReply } from '../dist/developmentDecisions.js';
import { applyCodexTaskPolicy } from '../dist/codex.js';

const args = process.argv.slice(2);
assert.ok(JSON.stringify(args) === '["--live"]' || JSON.stringify(args) === '["--live","--design-only"]',
  'Requires --live [--design-only]; consumes the configured subscription runtime.');
const designOnly = args.includes('--design-only'), maxCalls = designOnly ? 2 : 4;
const workspace = process.env.ARGUS_PILOT_WORKSPACE_CONTAINER || 'argus-core-agent-workspace-1';
const core = process.env.ARGUS_PILOT_CORE_CONTAINER || 'argus-core-mcp-server-1';
for (const name of [workspace, core]) assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const id = randomUUID(), cwd = `/workspace/argus-design-pilot-${id}`;
const reportDir = path.resolve('test-results/technical-design', id);
await mkdir(reportDir, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const report = { id, startedAt: new Date().toISOString(), kind: 'live-contract-pilot',
  fullWorkflowAcceptance: false, featureActivated: false, cwd, status: 'preflight', calls: [], checks: {} };
report.sourceHashes = Object.fromEntries(await Promise.all(['technicalDesign', 'developmentDecisions', 'codex'].map(async name =>
  [name, sha(await readFile(new URL(`../dist/${name}.js`, import.meta.url)))])));
report.workspaceImage = execFileSync('docker', ['inspect', '--format', '{{.Image}}', workspace], { encoding: 'utf8' }).trim();
report.cliVersion = execFileSync('docker', ['exec', workspace, '/app/node_modules/.bin/codex', '--version'], { encoding: 'utf8' }).trim();
const save = () => writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
await save();
console.log(JSON.stringify({ event: 'pilot-created', id, reportDir, maxCalls }));
const dockerNode = (container, source, args = []) => execFileSync('docker',
  ['exec', container, 'node', '--input-type=module', '-e', source, ...args], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1_000_000 });
const assignments = () => JSON.parse(dockerNode(core, `
 const r=await fetch('http://localhost:3000/api/internal/agent-runtimes', {headers:{'x-workspace-secret':process.env.WORKSPACE_SECRET}});
 if(!r.ok) throw new Error('Runtime assignment lookup failed');
 const data=await r.json(); console.log(JSON.stringify({planner:data.planner,reviewer:data.reviewer}));`));
const status = () => JSON.parse(dockerNode(workspace, `
 const r=await fetch('http://localhost:3001/codex/status', {headers:{'x-workspace-secret':process.env.WORKSPACE_SECRET}});
 if(!r.ok) throw new Error('Runtime status lookup failed'); const s=await r.json();
 console.log(JSON.stringify({enabled:s.enabled,authenticated:s.authenticated,authMethod:s.authMethod,activeRuns:s.activeRuns}));`));
const fixture = {
  'scalar.py': `"""Existing scalar contract: exact signed 16-bit integer addition."""\ndef add(left, right):\n    if type(left) is not int or type(right) is not int:\n        raise TypeError("integer operands required")\n    if not (-32768 <= left <= 32767 and -32768 <= right <= 32767):\n        raise ValueError("operand out of range")\n    return left + right\n`,
  'test_scalar.py': `from scalar import add\n\ndef test_exact_addition():\n    assert add(4, -3) == 1\n    assert add(32767, 32767) == 65534\n`,
  'README.md': `# Synthetic Argus technical-design fixture\nOnly scalar.py and test_scalar.py exist as code. No dependencies.\nNo calibration report, physical-system data, or benchmark measurements exist.\nThis is not GEM and is not evidence of numerical PMSM correctness.\n`,
};
const brief = `Add a batch API for the existing exact signed-16-bit integer addition in scalar.py.
The scalar API and validation behavior must remain unchanged; each row must match scalar addition exactly.
Support independent pairs, including an empty batch. No new dependencies. Choose the public batch name,
signature, container shape and deterministic error behavior yourself within these requirements.
Specify independent tests with concrete inputs/results. This is delegated design, not a human plan approval.
Do not implement anything; read only the three fixture files in ${cwd}. No other repository is in scope.`;
let activeChild;
const cancelActive = () => {
  const runId = report.calls.at(-1)?.runId;
  if (!activeChild || !runId) return;
  // Killing docker exec alone can leave its HTTP client alive in the container.
  // Request cancellation of exactly our saved run before closing the transport.
  try {
    dockerNode(workspace, `const r=await fetch('http://localhost:3001/codex/runs/'+encodeURIComponent(process.argv[1])+'/cancel',
      {method:'POST',headers:{'x-workspace-secret':process.env.WORKSPACE_SECRET},signal:AbortSignal.timeout(5000)});
      console.log(JSON.stringify({status:r.status}));`, [runId]);
  } catch { report.cancellationUnconfirmed = true; }
};
const stop = () => { process.exitCode = 130; cancelActive(); activeChild?.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const hashFixture = () => JSON.parse(dockerNode(workspace, `
 import fs from 'node:fs'; import {createHash} from 'node:crypto';
 const cwd=process.argv[1], names=fs.readdirSync(cwd).filter(n=>n!=='.git').sort();
 console.log(JSON.stringify(names.map(name=>[name,createHash('sha256').update(fs.readFileSync(cwd+'/'+name)).digest('hex')])));`, [cwd]));
let baseline;
try {
  const target = assignments();
  for (const role of ['planner', 'reviewer']) {
    assert.equal(target[role]?.runtimeType, 'codex', `${role} must already select the supported Codex runtime; no fallback`);
    assert.equal(target[role]?.profileEnabled, true);
    assert.ok(target[role]?.model && target[role]?.reasoningEffort);
  }
  report.assignments = target;
  report.runtime = status();
  assert.deepEqual(report.runtime, { enabled: true, authenticated: true, authMethod: 'chatgpt', activeRuns: 0 });
  for (const [name, content] of Object.entries(fixture)) await writeFile(path.join(reportDir, name), content);
  dockerNode(workspace, `import fs from 'node:fs'; fs.mkdirSync(process.argv[1]);`, [cwd]);
  for (const name of Object.keys(fixture)) execFileSync('docker', ['cp', path.join(reportDir, name), `${workspace}:${cwd}/${name}`], { stdio: 'pipe' });
  // Local fixture metadata only: never commit, clone, reset, or use a Git remote.
  execFileSync('docker', ['exec', workspace, 'git', 'init', '--quiet', cwd], { stdio: 'pipe' });
  baseline = hashFixture(); report.fixtureHashes = baseline;
  const call = async (role, phase, prompt) => {
    assert.ok(report.calls.length < maxCalls, 'Hard pilot call limit');
    assert.ok(!process.exitCode, 'Pilot was interrupted');
    assert.deepEqual(assignments(), target, 'Runtime assignment changed; no implicit fallback');
    assert.equal(status().activeRuns, 0, 'Do not interrupt or compete with an active runtime');
    const runId = randomUUID();
    const record = { phase, role, runId, status: 'dispatch-intent', promptSha256: sha(prompt), startedAt: new Date().toISOString() };
    report.status = 'running'; report.calls.push(record); await save();
    const request = { prompt: applyCodexTaskPolicy(prompt, role === 'planner' ? 'plan' : 'review'),
      cwd, model: target[role].model, reasoningEffort: target[role].reasoningEffort, timeoutSec: 600,
      runId, rootTraceId: id, agentId: target[role].agentId, taskType: 'technical_design_pilot',
      executionMode: 'workspace-read-only' };
    console.log(JSON.stringify({ event: 'dispatch', phase, runId, model: request.model }));
    // Credentials stay in the service process environment. Only the nonsecret
    // request enters stdin; neither token nor arbitrary CLI stderr is printed.
    const helper = `import http from 'node:http';
      let input='';for await(const chunk of process.stdin) input+=chunk;
      const req=http.request({hostname:'127.0.0.1',port:3001,path:'/codex/run',method:'POST',headers:{
        'content-type':'application/json','x-workspace-secret':process.env.WORKSPACE_SECRET}},res=>{
        let output='';res.on('data',chunk=>{output+=chunk;if(output.length>1000000) req.destroy(new Error('Response too large'));});
        res.on('end',()=>{process.stdout.write(JSON.stringify({status:res.statusCode,body:JSON.parse(output)}));});});
      req.setTimeout(630000,()=>req.destroy(new Error('Pilot HTTP deadline')));
      req.on('error',()=>{console.error('Pilot transport failed; do not retry automatically');process.exitCode=1;});req.end(input);`;
    const envelope = await new Promise((resolve, reject) => {
      const child = spawn('docker', ['exec', '-i', workspace, 'node', '--input-type=module', '-e', helper], { stdio: ['pipe', 'pipe', 'pipe'] });
      activeChild = child; let output = '';
      const timer = setTimeout(() => { cancelActive(); child.kill('SIGTERM'); }, 645_000);
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
      child.stdin.end(JSON.stringify(request));
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); activeChild = undefined;
        if (code !== 0) reject(new Error('Pilot transport interrupted; inspect the exact saved runtime runId before any new call'));
        else { try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid pilot transport response')); } }
      });
    });
    record.httpStatus = envelope.status;
    assert.equal(envelope.status, 200, `Runtime failed: ${envelope.body.code || 'runtime_error'}`);
    const result = envelope.body;
    assert.equal(result.runId, runId);
    record.status = 'received'; record.durationMs = result.durationMs; record.usage = result.usage;
    record.threadId = result.threadId;
    record.commandCount = (result.events ?? []).filter(e => e.type === 'command_execution').length;
    assert.ok(record.commandCount > 0, 'Require actual repository inspection, not prompt-only acceptance');
    assert.ok(!(result.events ?? []).some(e => ['file_change', 'web_search', 'mcp_tool_call'].includes(e.type)), 'Read-only pilot must not write or reach external tools');
    assert.deepEqual(hashFixture(), baseline, 'Fixture changed during read-only phase');
    // Store structured fixture-only output and bounded bridge events for review.
    await writeFile(path.join(reportDir, `${phase}.json`), JSON.stringify(result, null, 2));
    await save();
    console.log(JSON.stringify({ event: 'received', phase, durationMs: result.durationMs, commandCount: record.commandCount }));
    return result.response;
  };
  let state = { development_contract_version: 2, technical_design_policy_version: 1,
    description: brief, workflow_blockers: [], development_findings: [], technical_decisions: [] };
  const proposal = await call('planner', 'proposal', `${brief}\n${technicalDesignContext(state)}\n${TECHNICAL_PROPOSAL_INSTRUCTION}`);
  state = { ...state, ...applyTechnicalProposal(state, proposal) };
  await writeFile(path.join(reportDir, 'proposed-state.json'), JSON.stringify(state, null, 2));
  assert.equal(state.workflow_blockers.length, 0, 'Ordinary delegated design must not require a product-owner answer');
  const reviewed = await call('reviewer', 'qa', `You are the independent QA test designer, not the author. Independently read the fixture sources and define concrete independent test cases.\n${brief}\n${technicalDesignContext(state)}\n${TECHNICAL_REVIEW_INSTRUCTION}`);
  state = { ...state, ...applyTechnicalReview(state, reviewed) };
  await writeFile(path.join(reportDir, 'reviewed-state.json'), JSON.stringify(state, null, 2));
  assert.equal(state.workflow_blockers.length, 0, 'Live QA did not accept the proposed contract; stop without automatic retry');
  assert.ok(state.technical_decisions.every(d => d.status === 'qa_checked'));
  report.checks.concreteQaTestCases = JSON.parse(state.qa_test_plan).testCases.length;
  assert.ok(report.checks.concreteQaTestCases > 0);
  report.checks.delegatedDesignAccepted = true; await save();

  if (!designOnly) {
  // Explicitly synthetic checkpoint scenario, not a claim of two live failed
  // corrections. Its missing physical evidence must never be fabricated.
  const finding = { kind: 'technical_review', source: 'repository',
    summary: 'No independent physical calibration data is available to justify an end-to-end numeric bound.',
    evidence: ['README.md: no calibration report or physical-system data exists in the fixture.'] };
  const measurementBrief = `Investigate whether this fixture provides independently observed physical-system calibration evidence for a justified end-to-end numerical tolerance. Required evidence must be observed, never invented or estimated from scalar integer arithmetic. No report or measurement is available in the fixture. Do not create or weaken acceptance criteria. Inspect only ${cwd}.`;
  let blocked = { development_contract_version: 2, technical_design_policy_version: 1, description: measurementBrief,
    design_refinement_count: 2, workflow_blockers: [finding.summary], development_findings: [finding],
    technical_decisions: [], technical_open_findings: technicalFindingRecords([finding]) };
  assert.equal(technicalPlanningRoute(blocked, 'coder'), 'technical_resolution');
  blocked = { ...blocked, ...reserveTechnicalInvestigation(blocked) };
  await writeFile(path.join(reportDir, 'reserved-investigation.json'), JSON.stringify(blocked, null, 2));
  const investigated = await call('planner', 'investigation', `${measurementBrief}\nThis is the single bounded technical investigation. Use permitted read-only inspection only. No writes, mutating tests, dependencies, network, permissions changes or invented measurements.\n${technicalDesignContext(blocked)}\n${TECHNICAL_PROPOSAL_INSTRUCTION}`);
  blocked = { ...blocked, ...applyTechnicalProposal(blocked, investigated), technical_investigation_pending: false };
  assert.ok(blocked.workflow_blockers.length > 0, 'Missing calibration must not produce fabricated readiness');
  const checked = await call('reviewer', 'blocked-qa', `Independently inspect the evidence and verify the unresolved technical finding; do not invent measurements or ask a nontechnical owner for numerical bounds.\n${measurementBrief}\n${technicalDesignContext(blocked)}\n${TECHNICAL_REVIEW_INSTRUCTION}`);
  blocked = { ...blocked, ...applyTechnicalReview(blocked, checked) };
  assert.ok(blocked.workflow_blockers.length > 0);
  assert.equal(technicalPlanningRoute(blocked, 'coder'), 'requirements_input');
  const card = decisionRequest(blocked);
  assert.equal(card.kind, 'technical_review'); assert.equal(card.canClarify, false);
  assert.throws(() => validateDecisionReply({ decisionId: card.id, requirements: 'Approve and continue' }, card), /blocked/);
  assert.throws(() => reserveTechnicalInvestigation(blocked), /not eligible/);
  await writeFile(path.join(reportDir, 'blocked-state.json'), JSON.stringify({ state: blocked, card }, null, 2));
  report.checks.missingEvidenceHardBlocked = true;
  report.checks.ownerAnswerRejected = true;
  }
  report.checks.fixtureUnchanged = true;
  report.status = 'passed';
} catch (error) {
  report.status = process.exitCode === 130 ? 'interrupted' : 'failed';
  report.error = String(error.message).slice(0, 1000); process.exitCode ||= 1;
} finally {
  if (baseline) { try { report.checks.fixtureUnchanged = JSON.stringify(hashFixture()) === JSON.stringify(baseline); } catch { report.checks.fixtureUnchanged = false; } }
  report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ event: 'pilot-finished', status: report.status, calls: report.calls.length, checks: report.checks, reportDir, error: report.error }));
  // Retain only this small fixture and its receipts for inspection/interruption recovery.
}
