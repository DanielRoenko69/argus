import test from 'node:test';
import assert from 'node:assert/strict';
import { codegenHash, type CodegenFailure } from './codeGenerationContract.js';
import { mayRepairCodegen, reserveCodegenRepair, assertCodegenRepairSource, parseCodegenRepair, codegenRecipeHash,
  CODEGEN_REPAIR_INSTRUCTION, type CodegenRepairState } from './codeGenerationRepair.js';
import { WorkflowCancellation, withWorkflowCancellation } from './workflowCancellation.js';
import { qaEvidence } from './qaAcceptance.js';
const plan = { version: 1 as const, summary: 'Existing repository generator', setup: 'install', start: '', generate: 'generate', outputPaths: ['client.ts'] };
const source = 'a'.repeat(64), basis = 'b'.repeat(64);
const failure: CodegenFailure = { phase: 'generate', status: 'failed', exitCode: 1, stdout: '', stderr: 'invalid example email', durationMs: 1, outputSha256: codegenHash(['', 'invalid example email']) };
const state: CodegenRepairState = { code_generation_policy_version: 1, qa_environment_policy_version: 2,
  code_generation_repair_policy_version: 1, code_generation_repair_count: 0, code_generation_needs_repair: true,
  code_generation_decision: { version: 1, status: 'ready', plan }, code_generation_failed_recipes: [codegenRecipeHash(plan)],
  code_generation_failure: { sourceSha256: source, basisSha256: basis, planSha256: codegenHash(plan), failure } };
const pending = () => ({ ...state, ...reserveCodegenRepair(state) });
const proposal = { version: 1, status: 'ready', summary: 'Disposable config validator correction', setup: 'install', start: 'export VALID_FIXTURE=yes', generate: 'generate' };
test('fresh policy, terminal no-import evidence and two reserved attempts required', () => {
  assert.equal(mayRepairCodegen(state), true);
  assert.equal(mayRepairCodegen({ ...state, code_generation_repair_count: 1 }), true);
  for (const count of [-1, 2, 3, 0.5, NaN]) assert.equal(mayRepairCodegen({ ...state, code_generation_repair_count: count }), false);
  for (const version of [undefined, 0, 2]) assert.equal(mayRepairCodegen({ ...state, code_generation_repair_policy_version: version }), false);
  for (const phase of ['setup', 'generate'] as const) assert.equal(mayRepairCodegen({ ...state, code_generation_failure: { ...state.code_generation_failure!, failure: { ...failure, phase } } }), true);
  for (const status of ['timeout', 'canceled', 'interrupted', 'disk_limit', 'output_limit', 'completed'])
    assert.equal(mayRepairCodegen({ ...state, code_generation_failure: { ...state.code_generation_failure!, failure: { ...failure, status } } }), false);
  for (const exitCode of [null, 0, -1, 128, 137]) assert.equal(mayRepairCodegen({ ...state, code_generation_failure: { ...state.code_generation_failure!, failure: { ...failure, exitCode } } }), false);
});
test('no repair from missing, tampered, stale or successful evidence', () => {
  assert.equal(mayRepairCodegen({ ...state, code_generation_failure: null }), false);
  assert.equal(mayRepairCodegen({ ...state, code_generation_receipt: {} as never }), false);
  for (const delta of [{ sourceSha256: '' }, { planSha256: basis }, { failure: { ...failure, outputSha256: source } }])
    assert.equal(mayRepairCodegen({ ...state, code_generation_failure: { ...state.code_generation_failure!, ...delta } }), false);
});
test('reserve before inference, no budget reset or double reservation', () => {
  const s = pending();
  assert.equal(s.code_generation_repair_count, 1);
  assert.equal(s.qa_history[0].phase, 'code_generation_repair_reserved');
  assert.equal(s.code_generation_needs_repair, false);
  assert.throws(() => reserveCodegenRepair(s), /not_eligible/);
  assert.throws(() => reserveCodegenRepair({ ...state, code_generation_repair_count: 2 }), /not_eligible/);
});
test('source and frozen QA/requirement basis are rechecked around repair and execution', () => {
  assert.doesNotThrow(() => assertCodegenRepairSource(pending(), basis, source));
  for (const [b, s] of [[source, source], [basis, basis]]) assert.throws(() => assertCodegenRepairSource(pending(), b!, s!), /basis_changed/);
  assert.throws(() => assertCodegenRepairSource(state, basis, source), /basis_changed/);
});
test('repair owns scripts only; server retains original output paths exactly', () => {
  const before = JSON.stringify(state), result = parseCodegenRepair(pending(), JSON.stringify(proposal));
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.deepEqual(result.plan.outputPaths, plan.outputPaths);
  assert.equal(JSON.stringify(state), before);
  for (const delta of [{ outputPaths: ['extra.ts'] }, { outputPaths: ['client.ts'] }, { tests: 'true' }, { mounts: ['/'] }, { grant: 'x' }, { policy: 2 }, { generate: '' }])
    assert.throws(() => parseCodegenRepair(pending(), JSON.stringify({ ...proposal, ...delta })));
  assert.throws(() => parseCodegenRepair(pending(), JSON.stringify({ version: 1, status: 'not_needed', summary: 'skip' })));
});
test('cosmetic-only, repeated recipes and invalid output never spend another execution', () => {
  assert.throws(() => parseCodegenRepair(pending(), JSON.stringify({ ...proposal, start: '' })), /unchanged/);
  const prior = { ...plan, start: proposal.start };
  assert.throws(() => parseCodegenRepair({ ...pending(), code_generation_failed_recipes: [codegenRecipeHash(prior)] }, JSON.stringify(proposal)), /unchanged/);
  for (const output of ['null', '[]', 'not json', 'x'.repeat(85001)]) assert.throws(() => parseCodegenRepair(pending(), output));
  const blocked = parseCodegenRepair(pending(), JSON.stringify({ version: 1, status: 'blocked', summary: 'Generator requires a product change' }));
  assert.equal(blocked.status, 'blocked');
});
test('prompt has the repair schema only, and explicit generator/QA/isolation boundaries', () => {
  const example = JSON.parse(CODEGEN_REPAIR_INSTRUCTION.match(/Return ONLY (\{[^\n]+?\}), or/)![1]!);
  assert.equal(parseCodegenRepair(pending(), JSON.stringify(example)).status, 'ready');
  assert.doesNotMatch(CODEGEN_REPAIR_INSTRUCTION, /"status":"not_needed"/);
  for (const rule of [/UNTRUSTED/, /SAME repository generator/, /Never hand-author/, /Do NOT submit outputPaths/, /Do not install anything in the workspace/, /EmailStr/]) assert.match(CODEGEN_REPAIR_INSTRUCTION, rule);
});
test('cancellation prevents both reservation and recipe/source recheck', async () => {
  const control = new WorkflowCancellation(); control.request();
  await withWorkflowCancellation(control, async () => {
    assert.throws(() => reserveCodegenRepair(state), /canceled/);
    assert.throws(() => assertCodegenRepairSource(pending(), basis, source), /canceled/);
  });
});
test('public evidence separates recipe budget from implementation retries and does not upgrade old runs', () => {
  const old = qaEvidence({ ...state, qa_acceptance_policy_version: 1, code_generation_repair_policy_version: undefined });
  assert.equal(old?.codeGeneration?.repairPolicyVersion, 0);
  const fresh = qaEvidence({ ...pending(), qa_acceptance_policy_version: 1 });
  assert.equal(fresh?.codeGeneration?.repairs, 1);
  assert.equal(fresh?.codeGeneration?.repairPending, true);
  assert.equal(fresh?.codeGeneration?.receipt, undefined);
});
