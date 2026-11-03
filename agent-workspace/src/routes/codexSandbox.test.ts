import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { CODEX_SANDBOX_HELPER_DIR, codexSandboxPath } from './codexSandbox.js';

test('Linux Codex uses its version-matched helper before system or workspace PATH entries', () => {
  assert.equal(codexSandboxPath('/workspace/bin:/usr/bin:/bin', 'linux'), `${CODEX_SANDBOX_HELPER_DIR}:/workspace/bin:/usr/bin:/bin`);
  assert.equal(codexSandboxPath('', 'linux'), `${CODEX_SANDBOX_HELPER_DIR}:/usr/local/bin:/usr/bin:/bin`);
});
test('non-Linux hosts keep their existing OS sandbox path', () => {
  assert.equal(codexSandboxPath('/usr/bin:/bin', 'darwin'), '/usr/bin:/bin');
});
test('helper selection preserves sandbox policy and the independent experiment executable', () => {
  const bridge = readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
  assert.match(bridge, /PATH: codexSandboxPath/);
  assert.match(bridge, /await assertCodexSandboxHelper\(\)/);
  assert.match(bridge, /sandboxMode: codexSandboxMode\(executionMode\)/);
  assert.match(bridge, /networkAccessEnabled: false/);
  assert.match(readFileSync(new URL('./technicalExperiment.ts', import.meta.url), 'utf8'), /spawn\('\/usr\/bin\/bwrap'/);
});
