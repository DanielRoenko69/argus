import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirements } from './resolver.js';
import { parseQaRequest, parseQaPytestEvidence } from '../routes/qaTests.js';
test('structured supplements describe needs, never install commands or authority', () => {
  const needs = [{ requirement: 'hypothesis>=6', reason: 'Independent property test import' }];
  assert.deepEqual(parseRequirements(needs), needs);
  for (const value of [[...needs, ...needs], [{ requirement: 'pkg @ https://evil/w.whl', reason: 'x' }],
    [{ requirement: '--index-url evil', reason: 'x' }], [{ requirement: 'pip install pkg', reason: '' }],
    [{ ...needs[0], command: 'sh' }], null]) assert.throws(() => parseRequirements(value));
  const request = { action: 'inspect', threadId: '12345678-1234-4234-8234-123456789abc', workspaceRoot: '/workspace/fixture',
    baseCommitSha: 'a'.repeat(40), basisSha256: 'b'.repeat(64), environmentRequirements: needs };
  assert.throws(() => parseQaRequest(request));
  assert.deepEqual(parseQaRequest({ ...request, environmentPolicyVersion: 1 }).environmentRequirements, needs);
});
test('a missing import is environment feedback, never an automatic product assertion failure', () => {
  const node = 'test_one.py::test_one';
  const evidence = { exitCode: 1, collectionErrors: 0, nodes: [node], missingModules: ['hypothesis'],
    reports: ['setup', 'call', 'teardown'].map(when => ({ node, when, outcome: when === 'call' ? 'failed' : 'passed', xfail: false })) };
  const parsed = parseQaPytestEvidence(`ARGUS_QA_RESULT=${JSON.stringify(evidence)}`, [{ id: 'one', content: 'x' }]);
  assert.equal(parsed.assertionFailed, false); assert.equal(parsed.passed, false); assert.deepEqual(parsed.missingModules, ['hypothesis']);
});
