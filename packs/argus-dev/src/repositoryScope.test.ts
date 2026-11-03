import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryScopeViolations } from './repositoryScope.js';
test('repository mode accepts chosen source and test files, exact list narrows it', () => {
  const status = ' M src/solver.py\n?? tests/test_new.py\n M docs/solver.md\n';
  assert.deepEqual(repositoryScopeViolations(status, ''), []);
  assert.deepEqual(repositoryScopeViolations(status, 'src/solver.py\ntests/test_new.py'), ['docs/solver.md']);
});
test('configuration, secrets, ambiguous paths and both sides of renames stay protected', () => {
  for (const path of ['.env', '.github/workflows/ci.yml', 'setup.py', 'tests/conftest.py', 'nested/package.json', 'AGENTS.md', 'Dockerfile', 'secret.pem', 'poetry.lock', '../outside', 'src/../../outside', '"src/encoded\\name"']) {
    assert.ok(repositoryScopeViolations(` M ${path}`, '').length, path);
    assert.ok(repositoryScopeViolations(`R  ${path} -> src/safe.py`, '').length, path);
  }
  assert.deepEqual(repositoryScopeViolations(' D tests/test_existing.py', ''), ['tests/test_existing.py']);
  assert.deepEqual(repositoryScopeViolations('R  tests/test_existing.py -> docs/deleted_test.py', ''), ['tests/test_existing.py']);
});
