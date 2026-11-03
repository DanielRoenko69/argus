import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { usesQaAcceptance, parseQaArtifact, qaBasis, qaHash, qaFiles, validateQaReceipt, assertQaCurrent, qaRequest, mayRepairQaEnvironment, parseEnvironmentRepair, type QaState } from './qaAcceptance.js';
const source = 'b'.repeat(64), thread = randomUUID();
const state = (): QaState => ({ qa_acceptance_policy_version: 1, workspace_dir: '/workspace/fixture', base_commit_sha: 'a'.repeat(40),
  description: 'Support a seeded reset', qa_test_plan: JSON.stringify({ testCases: [{ id: 'reset' }] }), argus_execution_grant: 'fixture-grant' });
const proposal = () => ({ version: 1, status: 'ready', summary: 'Seeded partial reset', blockers: [], files: [{ id: 'seeded_reset',
  content: 'def test_reset():\n    assert True\n', qaCaseIds: ['reset'], expected: 'Reset accepts integers', oracle: 'Requirement 1' }] });
function fixture() {
  const s = state(); s.qa_artifact = parseQaArtifact(s, JSON.stringify(proposal()), source, randomUUID());
  const receipt = { version: 1, threadId: thread, basisSha256: qaBasis(s), sourceSha256: source,
    testSha256: qaHash(qaFiles(s.qa_artifact)), requestSha256: 'c'.repeat(64), profile: 'python-bwrap-v1',
    status: 'completed', exitCode: 0, stdout: 'fixture', stderr: '', durationMs: 1, passed: true, assertionFailed: false,
    collected: 1, nodes: ['test_seeded_reset.py::test_reset'], outputSha256: qaHash(['fixture', '']), finishedAt: new Date().toISOString() };
  return { s, receipt };
}
test('only explicit new-run policy enables independent QA; legacy state stays disabled', async () => {
  assert.equal(usesQaAcceptance({}), false); assert.equal(usesQaAcceptance(state()), true);
  await assertQaCurrent({}, '', 4); // no grant, model call or sandbox for legacy
});
test('strict artifacts cannot choose paths/commands, reference invented cases or hide blockers', () => {
  const p = proposal(); assert.equal(parseQaArtifact(state(), JSON.stringify(p), source, randomUUID()).files.length, 1);
  for (const invalid of [ { ...p, cmd: 'shell' }, { ...p, files: [] }, { ...p, blockers: ['shape drift'] },
    { ...p, files: [{ ...p.files[0], id: '../product' }] }, { ...p, files: [{ ...p.files[0], qaCaseIds: ['invented'] }] },
    { ...p, files: [p.files[0], p.files[0]] }, { ...p, files: [{ ...p.files[0], content: '\0' }] },
    { ...p, files: [{ ...p.files[0], content: 'é'.repeat(8100) }] } ]) {
    assert.throws(() => parseQaArtifact(state(), JSON.stringify(invalid), source, randomUUID()));
  }
  assert.throws(() => parseQaArtifact(state(), JSON.stringify(p), source, 'missing-trace'));
});
test('actual receipts bind exact tests, original requirements, source, thread and output', () => {
  const { s, receipt } = fixture(); assert.equal(validateQaReceipt(s, thread, source, receipt).passed, true);
  for (const delta of [{ threadId: randomUUID() }, { sourceSha256: 'd'.repeat(64) }, { testSha256: 'e'.repeat(64) },
    { stdout: 'invented' }, { collected: 0 }, { nodes: [] }, { exitCode: 1 }, { assertionFailed: true }]) {
    assert.throws(() => validateQaReceipt(s, thread, source, { ...receipt, ...delta }));
  }
  for (const delta of [{ description: 'different' }, { qa_test_plan: '{}' }, { technical_decisions: [{ revision: 2 }] }, { allowed_files: 'src/only.py' }]) {
    assert.throws(() => validateQaReceipt({ ...s, ...delta }, thread, source, receipt));
  }
  s.qa_artifact!.files[0]!.content += '# changed';
  assert.throws(() => validateQaReceipt(s, thread, source, receipt));
});
test('incomplete, missing or failed QA cannot authorize delivery', async () => {
  const { s, receipt } = fixture(); await assert.rejects(assertQaCurrent(s, thread, 4), /not passed/);
  s.qa_receipt = { ...receipt, passed: false } as never; await assert.rejects(assertQaCurrent(s, thread, 4), /not passed/);
});
test('transport loss is not retried and contains no raw provider response', async () => {
  const { s } = fixture(); let calls = 0;
  const fake = (async () => { calls++; return new Response('sensitive failure', { status: 503 }); }) as typeof fetch;
  await assert.rejects(qaRequest(s, thread, 4, 'run', source, fake), /no automatic replay/);
  assert.equal(calls, 1);
});
function environment() {
  const plan = { version: 1, status: 'ready', languages: ['python'], manifestSha256: '1'.repeat(64), profileId: 'fixture',
    profileSha256: '2'.repeat(64), runtime: 'cpython-3.12.13-linux-aarch64', reasons: [] };
  return { version: 1, status: 'ready', reason: null, plan: { ...plan, planSha256: qaHash([plan.version, plan.status, plan.languages,
    plan.manifestSha256, plan.profileId, plan.profileSha256, plan.runtime, plan.reasons]) },
    packages: [{ name: 'packaging', version: '26.0', sha256: '3'.repeat(64) }],
    installationOutputSha256: '4'.repeat(64), preflightOutputSha256: '5'.repeat(64) };
}
test('environment is frozen in the server-authored artifact and cannot be silently enabled for legacy runs', () => {
  const { s, receipt } = fixture(), e = environment();
  assert.equal(qaBasis({ ...s, qa_environment_policy_version: 0 }), qaBasis(s));
  assert.throws(() => validateQaReceipt(s, thread, source, { ...receipt, environment: e, executionStarted: true }));
  s.qa_environment_policy_version = 1;
  assert.throws(() => parseQaArtifact(s, JSON.stringify(proposal()), source, randomUUID()));
  s.qa_artifact = parseQaArtifact(s, JSON.stringify(proposal()), source, randomUUID(), e.plan.planSha256);
  const managed = { ...receipt, basisSha256: qaBasis(s), environment: e, executionStarted: true };
  assert.equal(validateQaReceipt(s, thread, source, managed).passed, true);
  for (const delta of [{ environment: undefined }, { executionStarted: false },
    { environment: { ...e, plan: { ...e.plan, runtime: 'changed' } } },
    { environment: { ...e, packages: [] } }]) assert.throws(() => validateQaReceipt(s, thread, source, { ...managed, ...delta }));
  const blocked = { ...managed, environment: { ...e, status: 'blocked', reason: 'environment_install_failed', packages: [], preflightOutputSha256: null },
    executionStarted: false, status: 'preparation_failed', passed: false, collected: 0, nodes: [], exitCode: null };
  assert.equal(validateQaReceipt(s, thread, source, blocked).assertionFailed, false);
  assert.throws(() => validateQaReceipt(s, thread, source, { ...blocked, passed: true }));
});
test('inspection requires a plan for opt-in runs and rejects profile overrides before dispatch', async () => {
  const s = { ...state(), qa_environment_policy_version: 1 };
  const e = environment(); let sent: any;
  const fake = (async (_url, options) => { sent = JSON.parse(options!.body as string); return Response.json({ sourceSha256: source,
    files: 1, excludedFiles: 0, python: true, environment: e.plan }); }) as typeof fetch;
  const result = await qaRequest(s, thread, 4, 'inspect', undefined, fake);
  assert.equal(sent.environmentPolicyVersion, 1); assert.equal(Object.hasOwn(sent, 'packages'), false);
  assert.ok('python' in result && result.environment?.planSha256 === e.plan.planSha256);
  const missing = (async () => Response.json({ sourceSha256: source, files: 1, excludedFiles: 0, python: true })) as typeof fetch;
  await assert.rejects(qaRequest(s, thread, 4, 'inspect', undefined, missing), /policy mismatch/i);
});
test('dependency repair needs a completed missing-import failure and has a separate one-attempt budget', () => {
  const { s, receipt } = fixture(), e = environment();
  const repairable = { ...s, qa_environment_policy_version: 1, qa_receipt: { ...receipt, status: 'failed', exitCode: 1,
    passed: false, assertionFailed: false, missingModules: ['hypothesis'], environment: { ...e, plan: { ...e.plan, profileId: 'python-public-wheels-v1' } } } } as QaState;
  assert.equal(mayRepairQaEnvironment(repairable), true);
  for (const delta of [{ qa_environment_repair_count: 1 }, { qa_environment_policy_version: 0 },
    { qa_receipt: { ...repairable.qa_receipt, status: 'timeout' } },
    { qa_receipt: { ...repairable.qa_receipt, status: 'canceled' } },
    { qa_receipt: { ...repairable.qa_receipt, assertionFailed: true } },
    { qa_receipt: { ...repairable.qa_receipt, missingModules: [] } },
    { qa_receipt: { ...repairable.qa_receipt, environment: { ...e, status: 'blocked' } } }]) {
    assert.equal(mayRepairQaEnvironment({ ...repairable, ...delta } as QaState), false);
  }
});
test('repair can only append dependencies, never replace tests, versions or prior requirements', () => {
  const s = { ...state(), qa_environment_policy_version: 1,
    qa_environment_requirements: [{ requirement: 'packaging==25.0', reason: 'source import' }] };
  const p = { status: 'ready', reason: 'property tests import hypothesis', requirements: [...s.qa_environment_requirements,
    { requirement: 'hypothesis>=6', reason: 'test_seeded_reset.py import' }] };
  assert.equal(parseEnvironmentRepair(s, JSON.stringify(p)).requirements.length, 2);
  for (const delta of [{ requirements: p.requirements.slice(1) }, { files: [] }, { command: 'pip install hypothesis' },
    { requirements: [...s.qa_environment_requirements] },
    { requirements: [...s.qa_environment_requirements, { requirement: 'x @ https://evil', reason: 'untrusted' }] }]) {
    assert.throws(() => parseEnvironmentRepair(s, JSON.stringify({ ...p, ...delta })));
  }
  assert.throws(() => parseQaArtifact(state(), JSON.stringify({ ...proposal(), environmentRequirements: p.requirements }), source, randomUUID()), /Unexpected environment/);
});
