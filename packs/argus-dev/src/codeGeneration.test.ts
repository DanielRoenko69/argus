import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { usesCodeGeneration, codegenCoderContext, assertCodegenCurrent, generateCode, codegenFailureMessage, type CodegenState } from './codeGeneration.js';
import { codegenHash, parseCodegenDecision, CODEGEN_PROTECTED_PATH } from './codeGenerationContract.js';
import { PROTECTED_DEVELOPMENT_PATH } from './repositoryScope.js';
const plan = { version: 1 as const, summary: 'Repository generator', setup: 'install', start: '', generate: 'generator', outputPaths: ['client.ts'] };
const root = randomUUID(), basis = 'b'.repeat(64), source = 'c'.repeat(64), workspace = '/workspace/FIXTURE';
const claim = { workspaceRoot: workspace, rootTraceId: root, codeGeneration: { version: 1, allowedPaths: [] } };
const grant = 'eg_v1.' + Buffer.from(JSON.stringify(claim)).toString('base64url') + '.fixture';
const state: CodegenState = { code_generation_policy_version: 1, qa_environment_policy_version: 2,
  code_generation_decision: { version: 1, status: 'ready', plan }, argus_execution_grant: grant, workspace_dir: workspace, base_commit_sha: 'a'.repeat(40) };
test('old runs are never upgraded and missing runtime is not Coder permission to install', () => {
  assert.equal(usesCodeGeneration({}), false);
  assert.equal(usesCodeGeneration({ qa_environment_policy_version: 2 }), false);
  assert.equal(usesCodeGeneration(state), true);
  assert.match(codegenCoderContext(state), /Do not run the generator or install/);
  assert.match(codegenCoderContext(state), /not by itself a blocker/);
  assert.match(codegenCoderContext(state), /Do not claim successful/);
  assert.equal(codegenCoderContext({ ...state, code_generation_policy_version: 0 }), '');
});
test('existing protected path policy stays identical', () => {
  // Cross-repository wire equality is enforced by npm run test:contracts.
  assert.equal(CODEGEN_PROTECTED_PATH, PROTECTED_DEVELOPMENT_PATH);
});
test('no-op and blocked proposals are explicit; authority fields and invented output scope fail', () => {
  for (const status of ['not_needed', 'blocked']) assert.equal(parseCodegenDecision(JSON.stringify({ version: 1, status, summary: 'evidence' }), []).status, status);
  for (const delta of [{ outputPaths: ['.env'] }, { outputPaths: ['client/*'] }, { mounts: ['/'] }, { generate: '' }, { outputPaths: [] }])
    assert.throws(() => parseCodegenDecision(JSON.stringify({ version: 1, status: 'ready', plan: { ...plan, ...delta } }), []));
  assert.throws(() => parseCodegenDecision(JSON.stringify({ version: 1, status: 'ready', plan }), ['other.ts']));
});
test('generated source requires a current receipt; successful generation is not a test approval', async () => {
  const input = { action: 'generate', baseCommitSha: state.base_commit_sha, basisSha256: basis, sourceSha256: source, plan };
  const value = { version: 1, threadId: root, requestSha256: codegenHash({ ...input, threadId: root, workspaceRoot: workspace, allowedPaths: [] }),
    basisSha256: basis, sourceSha256: source, resultSourceSha256: 'd'.repeat(64), planSha256: codegenHash(plan),
    brokerRequestSha256: 'e'.repeat(64), baseImage: 'sha256:' + 'f'.repeat(64), applied: true,
    outputs: [{ path: 'client.ts', beforeSha256: null, sha256: '1'.repeat(64) }], finishedAt: new Date().toISOString() };
  const receipt = await generateCode(state, root, 2, basis, source, (async () => Response.json(value)) as typeof fetch);
  assertCodegenCurrent({ ...state, code_generation_receipt: receipt }, basis, value.resultSourceSha256);
  assert.throws(() => assertCodegenCurrent({ ...state, code_generation_receipt: receipt }, basis, source), /stale/);
  assert.throws(() => assertCodegenCurrent(state, basis, source), /stale/);
  assert.equal(Object.hasOwn(receipt, 'tests_passed'), false);
  await assert.rejects(generateCode({ ...state, allowed_files: 'other.ts' }, root, 2, basis, source, (() => { throw Error('must not dispatch'); }) as typeof fetch), /plan_invalid/);
  let calls = 0;
  await assert.rejects(generateCode(state, root, 2, basis, source, (async () => { calls++; return Response.json({ code: 'codegen_generation_failed_no_import' }, { status: 409 }); }) as typeof fetch), /generation_failed/);
  assert.equal(calls, 1);
});
test('workspace capacity explains the operator repair without granting replay or approval', () => {
  const message = codegenFailureMessage('codegen_stack_session_capacity');
  assert.match(message, /before starting a generator/);
  assert.match(message, /ARGUS_WORKSPACE_MAX_SESSIONS/);
  assert.match(message, /No automatic retry/);
  assert.match(codegenFailureMessage('codegen_stack_session_capacity_config_invalid'), /1 to 32/);
  assert.match(codegenFailureMessage('codegen_unavailable_no_replay'), /could not be completed and verified/);
});
