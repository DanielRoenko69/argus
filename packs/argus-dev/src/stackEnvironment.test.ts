import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stackHash, stackRequestSchema, validateStackResult, type StackResult } from './stackEnvironment.js';
import { parseStackProposal, stackRepairEligible, usesGeneralStack, StackPlanError, stackPlanningFailure, STACK_PLAN_INSTRUCTION, STACK_REPAIR_INSTRUCTION } from './stackClient.js';
import { parseQaArtifact, qaBasis, validateQaReceipt, type QaState } from './qaAcceptance.js';
const plan = { version: 1 as const, summary: 'Python + Bun + PostgreSQL', setup: 'install-tools', start: 'start-local-services', test: 'run-tests', python: '/repo/.venv/bin/python' };
const thread = randomUUID();
const source = 'c'.repeat(64);
const input = { action: 'project' as const, baseCommitSha: 'a'.repeat(40), basisSha256: 'b'.repeat(64), sourceSha256: source, stackPlan: plan };
function receipt(): StackResult { return { version: 1, threadId: thread, basisSha256: input.basisSha256, sourceSha256: source,
  testSha256: stackHash(plan.test), requestSha256: 'd'.repeat(64), profile: 'stack-container-v1',
  status: 'completed', exitCode: 0, stackEnvironment: { version: 1, planSha256: stackHash(plan), baseImage: 'sha256:' + 'e'.repeat(64),
    preparedImage: 'sha256:' + 'f'.repeat(64), phase: 'project', brokerRequestSha256: '1'.repeat(64) },
  executionStarted: true, missingModules: [], stdout: 'pass', stderr: '', durationMs: 1, passed: true,
  assertionFailed: false, collected: 0, nodes: [], outputSha256: stackHash(['pass', '']), finishedAt: new Date().toISOString() }; }
test('old runs never inherit general installation authority', () => {
  for (const policy of [undefined, 0, 1]) assert.equal(usesGeneralStack({ qa_environment_policy_version: policy }), false);
  assert.equal(usesGeneralStack({ qa_environment_policy_version: 2 }), true);
});
test('plan accepts stack scripts, not execution authority, paths or secrets', () => {
  assert.deepEqual(parseStackProposal(JSON.stringify(plan)), plan);
  for (const change of [{ image: 'arbitrary' }, { mounts: ['/'] }, { env: { TOKEN: 'secret' } }, { python: '/bin/../../bin/sh' }, { setup: 'é'.repeat(13000) }])
    assert.throws(() => parseStackProposal(JSON.stringify({ ...plan, ...change })));
  for (const change of [{ workspaceRoot: '/workspace/OTHER' }, { threadId: randomUUID() }, { preparedImage: 'sha256:' + 'f'.repeat(64) }])
    assert.equal(stackRequestSchema.safeParse({ ...input, ...change }).success, false);
});
test('repair accepts environment-only proposals and reattaches frozen test bytes', () => {
  const previous = { ...plan, test: 'set -euo pipefail\r\nprintf "Prüfung"\nrun-tests\n' };
  const { test: frozen, ...environment } = previous;
  for (const delta of [{ setup: 'install-missing-runtime' }, { start: 'start-fixed-service' }, { python: '/opt/python/bin/python' }]) {
    const repaired = parseStackProposal(JSON.stringify({ ...environment, ...delta }), previous);
    assert.deepEqual(Buffer.from(repaired.test), Buffer.from(frozen));
    assert.equal(stackHash(repaired.test), stackHash(previous.test));
    assert.notEqual(stackHash(repaired), stackHash(previous));
    assert.equal(previous.test, frozen);
  }
  assert.throws(() => parseStackProposal(JSON.stringify({ ...environment, summary: 'Cosmetic only' }), previous), { code: 'stack_repair_unchanged' });
});
test('repair rejects any test field, authority injection, invalid or oversized proposals', () => {
  const { test: _, ...environment } = plan;
  for (const testValue of ['true', plan.test, null, '']) {
    assert.throws(() => parseStackProposal(JSON.stringify({ ...environment, setup: 'repair', test: testValue }), plan), { code: 'stack_repair_test_forbidden' });
  }
  for (const delta of [{ image: 'arbitrary' }, { mounts: ['/'] }, { env: { TOKEN: 'secret' } }, { python: '/bin/../sh' }, { setup: 'é'.repeat(13000) }, { setup: '' }])
    assert.throws(() => parseStackProposal(JSON.stringify({ ...environment, setup: 'repair', ...delta }), plan), { code: 'stack_plan_invalid_schema' });
  for (const value of [null, [], 'string', 42, { setup: 'repair' }])
    assert.throws(() => parseStackProposal(JSON.stringify(value), plan), { code: 'stack_plan_invalid_schema' });
  assert.throws(() => parseStackProposal('not JSON', plan), { code: 'stack_plan_invalid_json' });
  assert.throws(() => parseStackProposal('x'.repeat(90001), plan), { code: 'stack_plan_too_large' });
  assert.throws(() => parseStackProposal(JSON.stringify(environment), { ...plan, test: '' }), { code: 'stack_repair_previous_invalid' });
});
test('initial and repair prompts agree with their distinct strict response contracts', () => {
  const initial = JSON.parse(STACK_PLAN_INSTRUCTION.match(/\{[^\n]+\}/)![0]);
  const repair = JSON.parse(STACK_REPAIR_INSTRUCTION.match(/\{[^\n]+\}/)![0]);
  assert.ok(parseStackProposal(JSON.stringify(initial)).test);
  assert.equal(Object.hasOwn(repair, 'test'), false);
  assert.equal(parseStackProposal(JSON.stringify(repair), plan).test, plan.test);
  assert.match(STACK_REPAIR_INSTRUCTION, /Do NOT return a test field/);
});
test('planning errors expose stable reasons without leaking raw provider data', () => {
  const known = stackPlanningFailure(new StackPlanError('stack_repair_test_forbidden'), 'validate');
  assert.equal(known.code, 'stack_repair_test_forbidden');
  assert.match(known.message, /was not applied/);
  for (const error of [new Error('token=SECRET'), { response: 'PRIVATE' }, null]) {
    const failure = stackPlanningFailure(error, 'agent');
    assert.equal(failure.code, 'stack_plan_operation_failed');
    assert.match(failure.message, /at agent/);
    assert.doesNotMatch(failure.message, /SECRET|PRIVATE/);
  }
});
test('passing evidence is source/plan/image/output bound', () => {
  assert.equal(validateStackResult(input, thread, receipt()).passed, true);
  for (const delta of [{ sourceSha256: '0'.repeat(64) }, { threadId: randomUUID() }, { outputSha256: '0'.repeat(64) },
    { testSha256: '0'.repeat(64) }, { exitCode: 1 }, { executionStarted: false }, { missingModules: ['missing'] }])
    assert.throws(() => validateStackResult(input, thread, { ...receipt(), ...delta }));
});
test('startup failure is preparation evidence, never assertions or a successful test', () => {
  const r = { ...receipt(), status: 'preparation_failed' as const, passed: false, exitCode: 1, executionStarted: false,
    stackEnvironment: { ...receipt().stackEnvironment, testStarted: false, executionStatus: 'failed' as const } };
  assert.equal(validateStackResult(input, thread, r).executionStarted, false);
  assert.equal(stackRepairEligible(r, 0, 4), true);
  assert.equal(stackRepairEligible(r, 4, 4), false);
  for (const delta of [{ passed: true }, { assertionFailed: true }, { collected: 1 }, { nodes: ['invented'] }, { executionStarted: true }, { status: 'failed' }])
    assert.throws(() => validateStackResult(input, thread, { ...r, ...delta }));
  const timeout = { ...r, stackEnvironment: { ...r.stackEnvironment, executionStatus: 'timeout' as const } };
  assert.equal(validateStackResult(input, thread, timeout).status, 'preparation_failed');
  assert.equal(stackRepairEligible(timeout, 0, 4), false);
});
test('diagnostic truncation is not failure but clipped QA cannot be passing evidence', () => {
  const r = receipt();
  r.stackEnvironment.executionStatus = 'completed';
  r.stackEnvironment.outputCapture = { version: 1, stdoutBytes: 4000000, stderrBytes: 0, stdoutTruncated: true, stderrTruncated: false };
  assert.equal(validateStackResult(input, thread, r).passed, true);
  assert.throws(() => validateStackResult(input, thread, { ...r, stackEnvironment: { ...r.stackEnvironment, executionStatus: 'output_limit' } }));
  const files = [{ id: 'one', content: 'test' }];
  const qa = { ...r, testSha256: stackHash(files), collected: 1, nodes: ['one'], stackEnvironment: { ...r.stackEnvironment, phase: 'qa' } };
  assert.throws(() => validateStackResult({ ...input, action: 'run', files, preparedImage: r.stackEnvironment.preparedImage! }, thread, qa));
});
test('actual setup limit/cancel/unknown causes never request dependency repair', () => {
  const r = { ...receipt(), status: 'preparation_failed' as const, passed: false, exitCode: 137, executionStarted: false,
    stackEnvironment: { ...receipt().stackEnvironment, phase: 'setup' as const, preparedImage: null } };
  for (const executionStatus of ['output_limit', 'timeout', 'canceled', 'interrupted', 'disk_limit'] as const) {
    const v = { ...r, stackEnvironment: { ...r.stackEnvironment, executionStatus } };
    assert.equal(validateStackResult(input, thread, v).stackEnvironment.executionStatus, executionStatus);
    assert.equal(stackRepairEligible(v, 0, 4), false);
  }
  assert.equal(stackRepairEligible({ ...r, stackEnvironment: { ...r.stackEnvironment, executionStatus: 'failed' } }, 0, 4), true);
  assert.throws(() => validateStackResult(input, thread, { ...r, status: 'failed', stackEnvironment: { ...r.stackEnvironment, executionStatus: 'timeout' } }));
});
test('bounded missing-environment repair never retries assertion failures', () => {
  const missing = { ...receipt(), status: 'failed' as const, passed: false, exitCode: 1, stderr: 'ModuleNotFoundError' };
  assert.equal(stackRepairEligible(missing, 0), true);
  assert.equal(stackRepairEligible(missing, 1), true);
  assert.equal(stackRepairEligible(missing, 2), false);
  assert.equal(stackRepairEligible({ ...missing, assertionFailed: true }, 0), false);
  assert.equal(stackRepairEligible({ ...missing, status: 'timeout' }, 0), false);
  assert.equal(stackRepairEligible({ ...missing, stderr: 'AssertionError: wrong result' }, 0), false);
});
test('independent QA requires passing project evidence and exactly the prepared image', () => {
  const s: QaState = { qa_acceptance_policy_version: 1, qa_environment_policy_version: 2, stack_plan: plan,
    workspace_dir: '/workspace/FIXTURE', base_commit_sha: input.baseCommitSha,
    qa_test_plan: JSON.stringify({ testCases: [{ id: 'one' }] }) };
  s.qa_artifact = parseQaArtifact(s, JSON.stringify({ version: 1, status: 'ready', summary: 'Independent assertion', blockers: [],
    files: [{ id: 'one', content: 'def test_one(): assert 2 + 2 == 4', qaCaseIds: ['one'], expected: '4', oracle: 'contract' }] }), source, randomUUID(), stackHash(plan));
  s.stack_result = { ...receipt(), basisSha256: qaBasis(s) };
  const qa = { ...receipt(), basisSha256: qaBasis(s), testSha256: stackHash(s.qa_artifact.files.map(({ id, content }) => ({ id, content }))),
    collected: 1, nodes: ['test_one.py::test_one'], stackEnvironment: { ...receipt().stackEnvironment, phase: 'qa' as const } };
  assert.equal(validateQaReceipt(s, thread, source, qa).passed, true);
  assert.throws(() => validateQaReceipt({ ...s, stack_result: { ...s.stack_result!, passed: false } }, thread, source, qa));
  assert.throws(() => validateQaReceipt(s, thread, source, { ...qa, stackEnvironment: { ...qa.stackEnvironment, preparedImage: 'sha256:' + '9'.repeat(64) } }));
  assert.throws(() => validateQaReceipt(s, thread, source, { ...qa, collected: 0, nodes: [] }));
});
