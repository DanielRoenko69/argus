import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stackHash, stackRequestSchema, validateStackResult, type StackResult } from './stackEnvironment.js';
import { usesGeneralStack, usesWorkspaceSession, stackRequest, STACK_PLAN_INSTRUCTION, STACK_REPAIR_INSTRUCTION, STACK_QA_INSTRUCTION } from './stackClient.js';
import { workspaceSessionInstruction } from './workspaceSession.js';
import { parseQaArtifact, qaBasis, qaFiles, validateQaReceipt, type QaState } from './qaAcceptance.js';
import { CODEGEN_PLAN_INSTRUCTION, generateCode, assertCodegenCurrent } from './codeGeneration.js';
import { codegenHash } from './codeGenerationContract.js';
import { CODEGEN_REPAIR_INSTRUCTION } from './codeGenerationRepair.js';

test('all workspace recipe planners distinguish Agent checkout from worker project files', () => {
  for (const prompt of [STACK_PLAN_INSTRUCTION, STACK_REPAIR_INSTRUCTION, CODEGEN_PLAN_INSTRUCTION, CODEGEN_REPAIR_INSTRUCTION]) {
    const instruction=workspaceSessionInstruction({qa_environment_policy_version:3},prompt);
    assert.ok(instruction.includes('only project root is /repo'));
    assert.ok(instruction.includes('Do not discover /workspace'));
    assert.ok(instruction.includes('non-ignored hidden project files'));
    assert.ok(instruction.includes('not permission to edit protected source/config/CI'));
    assert.equal(workspaceSessionInstruction({qa_environment_policy_version:2},prompt),prompt);
  }
});

const mode = 'workspace-session-v1' as const;
const thread = randomUUID(), base = 'a'.repeat(40), source = 'b'.repeat(64), projectKey = 'c'.repeat(64);
const plan = { version: 1 as const, summary: 'fixture', setup: 'idempotent-install', start: 'reset-local-test-data', test: 'real-tests', python: '/usr/bin/python3' };
const state: QaState = { qa_acceptance_policy_version: 1, qa_environment_policy_version: 3, workspace_dir: '/workspace/FIXTURE',
  base_commit_sha: base, stack_plan: plan, qa_test_plan: JSON.stringify({ testCases: [{ id: 'one' }] }), argus_execution_grant: 'fixture' };
function receipt(): StackResult {
  return { version: 1, threadId: thread, basisSha256: qaBasis(state), sourceSha256: source, testSha256: stackHash(plan.test),
    requestSha256: 'd'.repeat(64), profile: mode, status: 'completed', exitCode: 0, passed: true, assertionFailed: false,
    executionStarted: true, missingModules: [], collected: 0, nodes: [], stdout: '', stderr: '', outputSha256: stackHash(['', '']), durationMs: 1,
    finishedAt: new Date().toISOString(), stackEnvironment: { version: 1, executionMode: mode, sessionId: 'e'.repeat(64), preparedSession: projectKey,
      preparedImage: null, baseImage: 'sha256:' + 'f'.repeat(64), planSha256: stackHash(plan), brokerRequestSha256: projectKey,
      phase: 'project', executionStatus: 'completed', testStarted: true } };
}
test('policy 3 is explicit and old bases are not reused', () => {
  // Cross-repository wire equality is enforced by npm run test:contracts.
  assert.ok(usesGeneralStack(state)); assert.ok(usesWorkspaceSession(state));
  assert.notEqual(qaBasis(state), qaBasis({ ...state, qa_environment_policy_version: 2 }));
  assert.equal(usesWorkspaceSession({ qa_environment_policy_version: 2 }), false);
});
test('workspace receipt cannot accept a snapshot image, another source or mixed mode', () => {
  const input = { action: 'project' as const, executionMode: mode, baseCommitSha: base, basisSha256: qaBasis(state), sourceSha256: source, stackPlan: plan };
  assert.ok(validateStackResult(input, thread, receipt()).passed);
  for (const delta of [{ preparedImage: 'sha256:' + 'f'.repeat(64) }, { preparedSession: null }, { sessionId: undefined },
    { executionMode: undefined }, { preparedSession: '9'.repeat(64) }])
    assert.throws(() => validateStackResult(input, thread, { ...receipt(), stackEnvironment: { ...receipt().stackEnvironment, ...delta } }));
  assert.throws(() => validateStackResult({ ...input, executionMode: undefined }, thread, receipt()));
  assert.throws(() => validateStackResult({ ...input, sourceSha256: '9'.repeat(64) }, thread, receipt()));
  const qa = { ...input, action: 'run', files: [{ id: 'one', content: 'assert True' }] };
  assert.ok(stackRequestSchema.safeParse({ ...qa, preparedSession: projectKey }).success);
  for (const fields of [{}, { preparedImage: 'sha256:' + 'f'.repeat(64) }, { preparedImage: 'sha256:' + 'f'.repeat(64), preparedSession: projectKey }])
    assert.equal(stackRequestSchema.safeParse({ ...qa, ...fields }).success, false);
});
test('independent QA binds the exact passing project session and original frozen artifacts', () => {
  const s = { ...state, stack_result: receipt() };
  s.qa_artifact = parseQaArtifact(s, JSON.stringify({ version: 1, status: 'ready', summary: 'independent', blockers: [], files: [
    { id: 'one', content: 'def test_one(): assert 2 + 2 == 4', qaCaseIds: ['one'], expected: '4', oracle: 'contract' }] }), source, randomUUID(), stackHash(plan));
  const qa = { ...receipt(), testSha256: stackHash(qaFiles(s.qa_artifact)), collected: 1, nodes: ['one'],
    stackEnvironment: { ...receipt().stackEnvironment, phase: 'qa', brokerRequestSha256: '8'.repeat(64) } };
  assert.ok(validateQaReceipt(s, thread, source, qa).passed);
  assert.throws(() => validateQaReceipt({ ...s, stack_result: { ...s.stack_result, passed: false } }, thread, source, qa));
  assert.throws(() => validateQaReceipt(s, thread, source, { ...qa, stackEnvironment: { ...qa.stackEnvironment, preparedSession: '9'.repeat(64) } }));
  assert.throws(() => validateQaReceipt(s, thread, source, { ...qa, testSha256: '9'.repeat(64) }));
  const db = { version: 1 as const, engine: 'postgresql' as const, serverMajor: 16, scopeSha256: '7'.repeat(64), reset: 'before-phase' as const };
  const withDb = { ...s, stack_result: { ...s.stack_result, stackEnvironment: { ...s.stack_result.stackEnvironment, workspaceDatabase: db } } };
  assert.throws(() => validateQaReceipt(withDb, thread, source, qa));
  const dbQa = { ...qa, stackEnvironment: { ...qa.stackEnvironment, workspaceDatabase: db } };
  assert.ok(validateQaReceipt(withDb, thread, source, dbQa).passed);
  assert.throws(() => validateQaReceipt(withDb, thread, source, { ...dbQa, stackEnvironment: { ...dbQa.stackEnvironment, workspaceDatabase: { ...db, scopeSha256: '8'.repeat(64) } } }));
});
test('client explicitly sends workspace mode without image fallback', async () => {
  let body: any;
  await stackRequest(state, thread, 2, qaBasis(state), 'project', source, undefined, (async (_url, options) => {
    body = JSON.parse(String(options?.body)); return Response.json(receipt());
  }) as typeof fetch);
  assert.equal(body.executionMode, mode); assert.equal(body.preparedImage, undefined);
});
test('generator uses the same mode and cannot reuse a legacy receipt', async () => {
  const generation = { version: 1 as const, summary: 'fixture', setup: 'install', start: '', generate: 'repo-generator', outputPaths: ['client.ts'] };
  const claims = { rootTraceId: thread, workspaceRoot: state.workspace_dir, codeGeneration: { version: 1, allowedPaths: [] } };
  const s = { ...state, code_generation_policy_version: 1, code_generation_decision: { version: 1 as const, status: 'ready' as const, plan: generation },
    argus_execution_grant: 'eg_v1.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture' };
  const r = await generateCode(s, thread, 2, qaBasis(s), source, (async (_url, options) => {
    const input = JSON.parse(String(options?.body)); assert.equal(input.executionMode, mode);
    return Response.json({ version: 1, executionMode: mode, threadId: thread, basisSha256: input.basisSha256, sourceSha256: source,
      requestSha256: codegenHash({ ...input, threadId: thread, workspaceRoot: s.workspace_dir, allowedPaths: [] }),
      resultSourceSha256: '4'.repeat(64), planSha256: codegenHash(generation), brokerRequestSha256: '5'.repeat(64), baseImage: 'sha256:' + 'f'.repeat(64),
      applied: true, outputs: [{ path: 'client.ts', beforeSha256: null, sha256: '6'.repeat(64) }], finishedAt: new Date().toISOString() });
  }) as typeof fetch);
  assertCodegenCurrent({ ...s, code_generation_receipt: r }, qaBasis(s), r.resultSourceSha256);
  assert.throws(() => assertCodegenCurrent({ ...s, code_generation_receipt: { ...r, executionMode: undefined } }, qaBasis(s), r.resultSourceSha256));
});
test('only new-mode prompts describe reuse, reset responsibilities and no image construction', () => {
  for (const instruction of [STACK_PLAN_INSTRUCTION, STACK_QA_INSTRUCTION, CODEGEN_PLAN_INSTRUCTION]) {
    assert.equal(workspaceSessionInstruction({ qa_environment_policy_version: 2 }, instruction), instruction);
    const actual = workspaceSessionInstruction(state, instruction);
    assert.match(actual, /no Docker build, commit or prepared image/);
    assert.match(actual, /Every start must reset/);
    assert.match(actual, /Code and PR approvals and Jenkins remain separate/);
    assert.match(actual, /TEST_POSTGRES_PASSWORD/);
    assert.match(actual, /fresh empty database for EACH/);
    assert.match(actual, /Do not silently substitute/);
    assert.doesNotMatch(actual, /fresh isolated container built|fresh offline test container from the prepared image/);
  }
});
