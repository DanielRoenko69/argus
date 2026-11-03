import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ENVIRONMENT_PREFLIGHT_GUIDANCE, ENVIRONMENT_PREFLIGHT_SHELL } from './environmentPreflight.js';
import { STACK_PLAN_INSTRUCTION, STACK_REPAIR_INSTRUCTION } from './stackClient.js';
import { CODEGEN_PLAN_INSTRUCTION } from './codeGeneration.js';
import { CODEGEN_REPAIR_INSTRUCTION } from './codeGenerationRepair.js';
import { workspaceSessionInstruction } from './workspaceSession.js';

test('initial and repair recipes, including reusable workspace policy, receive the complete preflight guidance', () => {
  for (const prompt of [STACK_PLAN_INSTRUCTION, STACK_REPAIR_INSTRUCTION, CODEGEN_PLAN_INSTRUCTION, CODEGEN_REPAIR_INSTRUCTION]) {
    assert.ok(prompt.includes(ENVIRONMENT_PREFLIGHT_GUIDANCE));
    const workspace = workspaceSessionInstruction({ qa_environment_policy_version: 3 }, prompt);
    assert.ok(workspace.includes(ENVIRONMENT_PREFLIGHT_GUIDANCE));
    assert.ok(workspace.includes('Do not silently substitute the supplied PostgreSQL major'));
  }
});

// macOS has no GNU timeout by default. The offline Linux certificate exercises
// the real timeout binary and installed controller; here only its CLI is stubbed.
const timeoutStub = `timeout() { test "$1" = --kill-after=2s; test "$2" = 20s; shift 2; "$@"; }`;
function shell(start: string) {
  const r = spawnSync('bash', ['-euo', 'pipefail', '-c', timeoutStub + '\n' + ENVIRONMENT_PREFLIGHT_SHELL + '\n' + start
    + '\nprintf "TESTS_STARTED\\n"'], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, LC_ALL: 'C' } });
  assert.equal(r.error, undefined);
  return r;
}

test('successful probes retain parent exports and keep diagnostics out of QA stdout', () => {
  const r = shell(`export FIXTURE_VALUE=ready
argus_preflight configuration bash -c 'test "$FIXTURE_VALUE" = ready'
test "$FIXTURE_VALUE" = ready`);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'TESTS_STARTED\n');
  assert.match(r.stderr, /configuration: ready/);
});

for (const [category, command, code] of [
  ['toolchain', 'argus_definitely_missing_bunx_fixture', 127],
  ['configuration', "bash -c 'printf secret-settings; printf secret-error >&2; exit 7'", 7],
  ['database', "bash -c 'test 16 = 18'", 1],
  ['service', "bash -c 'exit 22'", 22],
] as const) {
  test(`${category} failure stops before migrations/tests and does not expose probe output`, () => {
    const r = shell(`argus_preflight ${category} ${command}\nprintf 'MIGRATIONS_STARTED\\n'`);
    assert.equal(r.status, code);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `[environment preflight] ${category}: failed (exit ${code}); tests/generation not started\n`);
  });
}

test('failure cannot be swallowed by the caller putting the helper in a conditional', () => {
  const r = shell('if argus_preflight configuration false; then :; fi');
  assert.equal(r.status, 1); assert.equal(r.stdout, '');
});

test('arbitrary category text is rejected without leaking it', () => {
  const r = shell('argus_preflight secret-settings true');
  assert.equal(r.status, 2); assert.equal(r.stdout + r.stderr, '');
});

test('guidance preserves source/test boundaries, validates email config and separates actual server from client version', () => {
  for (const s of ['.test, .invalid and .localhost', 'admin@example.com', 'bunx', 'actual PostgreSQL server major',
    'BEFORE migrations', 'Never change validators', 'Do not change frozen test commands', 'bounded readiness waits']) {
    assert.ok(ENVIRONMENT_PREFLIGHT_GUIDANCE.includes(s));
  }
});
