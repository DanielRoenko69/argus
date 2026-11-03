import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveBranchName, resolveDeliveryBranch } from './workflows/branchNames.js';

const first = '50fdc992-43a5-4743-9961-26c0c29afeb6';
const second = 'b69eda25-c5fe-4e88-bae3-74744924c614';

test('separate attempts for the same ticket get distinct, stable feature branches', () => {
  const branch = deriveBranchName('DEMO-FASTAPI-001', first);
  assert.equal(branch, 'feature/DEMO-FASTAPI-001-50fdc99243a54743996126c0c29afeb6');
  assert.equal(deriveBranchName('DEMO-FASTAPI-001', first), branch);
  assert.notEqual(deriveBranchName('DEMO-FASTAPI-001', second), branch);
  assert.match(branch, /^feature\/DEMO-FASTAPI-[A-Za-z0-9-]+$/);
});

test('branch names remain bounded and require a durable thread identity', () => {
  assert.ok(deriveBranchName('A'.repeat(300), first).length <= 200);
  assert.throws(() => deriveBranchName('DEMO-FASTAPI-001', ''));
});

test('Jenkins branch policy is applied to arbitrary ticket ids without weakening the target binding', () => {
  const branch = deriveBranchName('Checkpoint 1 Test', first, 'feature/DEMO-FASTAPI-');
  assert.equal(branch, 'feature/DEMO-FASTAPI-Checkpoint-1-Test-50fdc99243a54743996126c0c29afeb6');
  assert.match(branch, /^feature\/DEMO-FASTAPI-[A-Za-z0-9-]+$/);
});

test('tickets that already contain the Jenkins policy stem are not duplicated', () => {
  assert.equal(
    deriveBranchName('DEMO-FASTAPI-001', first, 'feature/DEMO-FASTAPI-'),
    'feature/DEMO-FASTAPI-001-50fdc99243a54743996126c0c29afeb6',
  );
});

test('policy-bound branches remain bounded and invalid Jenkins prefixes fail closed', () => {
  const branch = deriveBranchName('A'.repeat(300), first, 'feature/DEMO-FASTAPI-');
  assert.ok(branch.length <= 200);
  assert.ok(branch.startsWith('feature/DEMO-FASTAPI-'));
  assert.throws(() => deriveBranchName('TEST-1', first, 'feature/'));
  assert.throws(() => deriveBranchName('TEST-1', first, 'release/TEST-'));
});

test('checkpointed delivery branches are revalidated against the immutable Jenkins policy', () => {
  assert.equal(
    resolveDeliveryBranch('ignored', first, 'feature/DEMO-FASTAPI-existing', 'feature/DEMO-FASTAPI-'),
    'feature/DEMO-FASTAPI-existing',
  );
  assert.throws(
    () => resolveDeliveryBranch('ignored', first, 'feature/Checkpoint-1-Test-existing', 'feature/DEMO-FASTAPI-'),
    /authorized Jenkins branch policy/,
  );
});
