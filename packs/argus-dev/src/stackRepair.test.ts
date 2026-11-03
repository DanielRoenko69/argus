import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stackHash, type StackPlan, type StackResult } from './stackEnvironment.js';
import { parseStackProposal, STACK_REPAIR_INSTRUCTION } from './stackClient.js';
import { qaEvidence } from './qaAcceptance.js';
import { STACK_MAX_REPAIRS, STACK_REPAIR_WINDOW_MS, mayRepairStack, reserveStackRepair,
  assertStackRepairWindow, assertNewStackRecipe, assertStackRepairSource, assertStackRepairExecution, stackRepairContext,
  stackRecipeHash, stackAttempts, stackRepairBudget, type StackRepairState } from './stackRepair.js';

const now = 1_800_000_000_000, source = 'a'.repeat(64), basis = 'b'.repeat(64);
const plan: StackPlan = { version: 1, summary: 'Initial recipe', setup: 'fetch-missing-checksums', start: 'start-db',
  test: 'frozen-tests\r\n', python: '/opt/python/bin/python' };
const fixed = { ...plan, summary: 'Correct release artifact; retain integrity checks', setup: 'fetch-verified-asset\ninstall-browser' };
function receipt(p = plan, extra: Partial<StackResult> = {}): StackResult {
  const r: StackResult = { version: 1, threadId: randomUUID(), basisSha256: basis, sourceSha256: source,
    testSha256: stackHash(p.test), requestSha256: 'c'.repeat(64), profile: 'stack-container-v1',
    status: 'preparation_failed', exitCode: 22, stackEnvironment: { version: 1, planSha256: stackHash(p),
      baseImage: 'sha256:' + 'd'.repeat(64), preparedImage: null, phase: 'setup', brokerRequestSha256: 'e'.repeat(64) },
    executionStarted: false, missingModules: [], stdout: '', stderr: 'curl: (22) HTTP 404', durationMs: 100,
    passed: false, assertionFailed: false, collected: 0, nodes: [], outputSha256: '', finishedAt: new Date(now).toISOString(), ...extra };
  r.outputSha256 = stackHash([r.stdout, r.stderr]);
  return r;
}
function state(): StackRepairState {
  const first = receipt(), second = receipt(fixed, { exitCode: 137, stderr: 'installer terminated', stdout: 'Mailpit installed; browser install started' });
  return { qa_environment_policy_version: 2, stack_repair_policy_version: 1, stack_repair_count: 1,
    stack_repair_started_at: now, stack_needs_repair: true, stack_plan: fixed, stack_result: second,
    qa_history: [{ phase: 'stack_plan', plan, repair: 0 }, { phase: 'stack_project', receipt: first },
      { phase: 'stack_plan', plan: fixed, repair: 1 }, { phase: 'stack_project', receipt: second }] };
}
test('four repairs for fresh policy; absent/legacy policy keeps two; assertions never gain retries', () => {
  for (const count of [0, 1, 2, 3]) assert.equal(mayRepairStack({ ...state(), stack_repair_count: count }, receipt(), now), true);
  assert.equal(mayRepairStack({ ...state(), stack_repair_count: 4 }, receipt(), now), false);
  for (const policy of [undefined, 0]) {
    assert.equal(mayRepairStack({ ...state(), stack_repair_policy_version: policy }, receipt(), now), true);
    assert.equal(mayRepairStack({ ...state(), stack_repair_policy_version: policy, stack_repair_count: 2 }, receipt(), now), false);
  }
  for (const r of [receipt(plan, { assertionFailed: true }), receipt(plan, { status: 'timeout' }),
    receipt(plan, { status: 'canceled' }), receipt(plan, { status: 'output_limit' }), receipt(plan, { passed: true })])
    assert.equal(mayRepairStack(state(), r, now), false);
});
test('invalid budgets and unsupported policy fail closed', () => {
  for (const count of [-1, NaN, 1.5, Infinity]) assert.equal(mayRepairStack({ ...state(), stack_repair_count: count }, receipt(), now), false);
  for (const started of [0, now + 1, NaN, -1])
    assert.equal(stackRepairBudget({ ...state(), stack_repair_started_at: started }, now), 'stack_repair_budget_invalid');
  assert.equal(mayRepairStack({ ...state(), stack_repair_policy_version: 7 }, receipt(), now), false);
});
test('checkpoint reservation starts the window once, consumes before inference and survives serialization', () => {
  const initial = { ...state(), stack_repair_count: 0, stack_repair_started_at: 0 };
  const reserved = reserveStackRepair(initial, now);
  assert.equal(reserved.stack_repair_count, 1); assert.equal(reserved.stack_repair_started_at, now);
  assert.equal(reserved.stack_repair_pending, true);
  assert.equal(reserved.qa_history[0]!.deadlineAt, now + STACK_REPAIR_WINDOW_MS);
  const restored = JSON.parse(JSON.stringify({ ...initial, ...reserved }));
  assert.doesNotThrow(() => assertStackRepairWindow(restored, now + 1));
  assert.throws(() => reserveStackRepair(restored, now + 1), { code: 'stack_repair_not_reserved' });
  const next = reserveStackRepair({ ...restored, stack_repair_pending: false }, now + 100);
  assert.equal(next.stack_repair_started_at, now); assert.equal(next.stack_repair_count, 2);
});
test('window is checked at reservation, model and installer admission; last reserved attempt is usable', () => {
  const pending = { ...state(), stack_repair_count: STACK_MAX_REPAIRS, stack_repair_pending: true };
  assert.doesNotThrow(() => assertStackRepairWindow(pending, now + STACK_REPAIR_WINDOW_MS - 1));
  assert.throws(() => assertStackRepairWindow(pending, now + STACK_REPAIR_WINDOW_MS), { code: 'stack_repair_window_elapsed' });
  assert.throws(() => reserveStackRepair(state(), now + STACK_REPAIR_WINDOW_MS), { code: 'stack_repair_window_elapsed' });
  assert.throws(() => assertStackRepairWindow(state(), now), { code: 'stack_repair_not_reserved' });
});
test('A -> B -> A is rejected even with a different explanation; changed setup can proceed', () => {
  const s = state();
  assert.throws(() => assertNewStackRecipe(s, { ...plan, summary: 'Fixing the browser now' }, source, basis), { code: 'stack_repair_repeated_recipe' });
  assert.throws(() => assertNewStackRecipe(s, { ...plan, start: 'different-start', python: '/bin/python3' }, source, basis), { code: 'stack_repair_repeated_setup' });
  assert.doesNotThrow(() => assertNewStackRecipe(s, { ...fixed, setup: 'fetch-verified-asset\ninstall-minimal-browser' }, source, basis));
  assert.equal(stackRecipeHash(plan), stackRecipeHash({ ...plan, summary: 'Cosmetic' }));
});
test('reserved repair rechecks source and QA basis immediately before installer dispatch', () => {
  const s = { ...state(), ...reserveStackRepair(state(), now) };
  assert.doesNotThrow(() => assertStackRepairExecution(s, source, basis, now));
  assert.throws(() => assertStackRepairExecution(s, '9'.repeat(64), basis, now), { code: 'stack_repair_source_changed' });
  assert.throws(() => assertStackRepairExecution(s, source, '9'.repeat(64), now), { code: 'stack_repair_source_changed' });
  assert.throws(() => assertStackRepairExecution(s, source, basis, now + STACK_REPAIR_WINDOW_MS), { code: 'stack_repair_window_elapsed' });
});
test('failure history includes earlier corrections and actual partial progress, not only the last error', () => {
  const context = stackRepairContext(state(), source, basis);
  assert.match(context, /UNTRUSTED/); assert.match(context, /HTTP 404/); assert.match(context, /137/);
  assert.match(context, /Mailpit installed/); assert.match(context, /fetch-missing-checksums/);
  assert.match(context, /fetch-verified-asset/); assert.match(context, /changesSincePrevious/);
  assert.equal(stackAttempts(state(), source, basis).length, 2, 'current receipt is not duplicated');
  assert.match(STACK_REPAIR_INSTRUCTION, /do not reintroduce/);
  assert.match(STACK_REPAIR_INSTRUCTION, /Exit 137 alone does not prove/);
});
test('history cannot conflate changed source, basis, unbound recipes or tampered output', () => {
  const s = state();
  assert.equal(stackAttempts(s, '9'.repeat(64), basis).length, 0);
  assert.equal(stackAttempts(s, source, '9'.repeat(64)).length, 0);
  assert.doesNotThrow(() => assertNewStackRecipe(s, plan, '9'.repeat(64), basis));
  assert.throws(() => assertStackRepairSource(s, '9'.repeat(64), basis), { code: 'stack_repair_source_changed' });
  assert.doesNotThrow(() => assertStackRepairSource(s, source, basis));
  const unbound = { ...receipt(), stderr: 'altered after validation' };
  assert.equal(stackAttempts({ ...s, stack_result: null, qa_history: [{ phase: 'stack_plan', plan }, { phase: 'stack_project', receipt: unbound }] }, source, basis).length, 0);
});
test('large recipe additions cannot evict the removed failing command from change evidence', () => {
  const manyAdditions = { ...fixed, setup: fixed.setup + '\ninstall-other-package'.repeat(500) };
  const s = { ...state(), stack_plan: manyAdditions, stack_result: receipt(manyAdditions),
    qa_history: [{ phase: 'stack_plan', plan }, { phase: 'stack_project', receipt: receipt(plan) },
      { phase: 'stack_plan', plan: manyAdditions }, { phase: 'stack_project', receipt: receipt(manyAdditions) }] };
  assert.match(stackRepairContext(s, source, basis), /- setup: fetch-missing-checksums/);
});
test('passing environment evidence does not prohibit reuse; QA missing-runtime failures do', () => {
  const passed = receipt(plan, { passed: true, status: 'completed', exitCode: 0 });
  const s = { ...state(), stack_plan: plan, stack_result: passed, qa_history: [] };
  assert.doesNotThrow(() => assertNewStackRecipe(s, plan, source, basis));
  const qa = receipt(plan, { status: 'failed', exitCode: 1, executionStarted: true, missingModules: ['missing'],
    stackEnvironment: { ...passed.stackEnvironment, phase: 'qa' } });
  assert.throws(() => assertNewStackRecipe({ ...s, qa_receipt: qa }, plan, source, basis), { code: 'stack_repair_repeated_recipe' });
});
test('repair context is bounded, redacts credentials and preserves parseable evidence', () => {
  const p = { ...plan, setup: 'TOKEN=SECRET_VALUE\nfetch-verified-asset' };
  const r = receipt(p, { stderr: 'Bearer BEARER_VALUE password="PASSWORD_VALUE" https://user:URL_VALUE@example.com/a\n' + '\\'.repeat(30000),
    stdout: 'token=SECOND_VALUE\nAuthorization: Basic BASIC_VALUE\nBearer SHORT_BEARER\npassword="SHORT_PASSWORD"\nhttps://user:SHORT_URL@example.com/a\nCookie: session=COOKIE_VALUE' });
  const s = { ...state(), stack_plan: p, stack_result: r, qa_history: [] };
  const context = stackRepairContext(s, source, basis);
  assert.ok(context.length < 24500); assert.doesNotMatch(context, /BEARER_VALUE|PASSWORD_VALUE|URL_VALUE|SECOND_VALUE|SECRET_VALUE|BASIC_VALUE|SHORT_BEARER|SHORT_PASSWORD|SHORT_URL|COOKIE_VALUE/);
  assert.ok(Array.isArray(JSON.parse(context.slice(context.indexOf('\n') + 1))));
});
test('repair never changes frozen tests, source scope, grants or old-run policy', () => {
  const { test: frozen, ...environment } = fixed;
  assert.equal(parseStackProposal(JSON.stringify({ ...environment, setup: 'verified-new-setup' }), plan).test, frozen);
  assert.throws(() => parseStackProposal(JSON.stringify({ ...environment, test: 'true' }), plan), { code: 'stack_repair_test_forbidden' });
  const evidence = qaEvidence({ ...state(), qa_receipt: null, qa_acceptance_policy_version: 1 });
  assert.equal(evidence?.stackRepairPolicy?.maxRepairs, 4);
  assert.equal(evidence?.stackRepairPolicy?.windowMinutes, 45);
  assert.equal(qaEvidence({ ...state(), qa_receipt: null, stack_repair_policy_version: 0, qa_acceptance_policy_version: 1 })?.stackRepairPolicy?.maxRepairs, 2);
});
