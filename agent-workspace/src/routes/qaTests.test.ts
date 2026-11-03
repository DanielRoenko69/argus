import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseQaRequest, parseQaPytestEvidence, qaPytestProbe } from './qaTests.js';
const files = [{ id: 'reset', content: 'def test_reset():\n    assert True\n' }];
const input = () => ({ action: 'run', threadId: randomUUID(), workspaceRoot: '/workspace/fixture', baseCommitSha: 'a'.repeat(40), basisSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), files });
test('QA cannot choose shell commands, mount paths, test paths or duplicate files', () => {
  assert.equal(parseQaRequest(input()).files?.length, 1);
  for (const delta of [{ cmd: 'sh' }, { env: { KEY: 'secret' } }, { workspaceRoot: '/workspace/../escape' },
    { files: [] }, { files: [null] }, { threadId: '-'.repeat(36) }, { files: [...files, ...files] }, { files: [{ id: '../../source', content: 'x' }] },
    { files: [{ ...files[0], content: 'é'.repeat(8100) }] }, { files: [{ ...files[0], path: 'src/product.py' }] }]) {
    assert.throws(() => parseQaRequest({ ...input(), ...delta }));
  }
});
const node = 'test_reset.py::test_reset';
const report = () => ({ exitCode: 0, collectionErrors: 0, nodes: [node], reports: ['setup', 'call', 'teardown'].map(when => ({ node, when, outcome: 'passed', xfail: false })) });
const stdout = (value: unknown) => `normal output\nARGUS_QA_RESULT=${JSON.stringify(value)}\n`;
test('passing requires collected tests and setup/call/teardown evidence for every artifact', () => {
  assert.equal(parseQaPytestEvidence(stdout(report()), files).passed, true);
  for (const change of [{ nodes: [], reports: [] }, { reports: [] }, { collectionErrors: 1 }, { exitCode: 1 },
    { reports: report().reports.map(r => ({ ...r, outcome: r.when === 'call' ? 'skipped' : 'passed' })) },
    { reports: report().reports.map(r => ({ ...r, xfail: r.when === 'call' })) },
    { reports: [...report().reports, report().reports[0]] }]) {
    assert.equal(parseQaPytestEvidence(stdout({ ...report(), ...change }), files).passed, false);
  }
  assert.equal(parseQaPytestEvidence(stdout(report()), [...files, { id: 'untested', content: '' }]).passed, false);
  assert.throws(() => parseQaPytestEvidence('all tests passed', files));
  assert.throws(() => parseQaPytestEvidence(stdout(report()) + stdout(report()), files));
});
test('collection and setup errors are not automatic Coder corrections', () => {
  const failed = (when: string) => ({ ...report(), exitCode: 1, reports: report().reports.map(r => ({ ...r, outcome: r.when === when ? 'failed' : 'passed' })) });
  assert.equal(parseQaPytestEvidence(stdout(failed('call')), files).assertionFailed, true);
  assert.equal(parseQaPytestEvidence(stdout(failed('setup')), files).assertionFailed, false);
  assert.equal(parseQaPytestEvidence(stdout({ ...failed('call'), collectionErrors: 1 }), files).assertionFailed, false);
  assert.equal(parseQaPytestEvidence(stdout({ ...failed('call'), reports: failed('call').reports.map(r => ({ ...r, xfail: true })) }), files).assertionFailed, false);
});
test('pytest invocation is fixed, no project plugins/configuration or caller commands', () => {
  const probe = qaPytestProbe(files);
  assert.match(probe, /PYTEST_DISABLE_PLUGIN_AUTOLOAD/); assert.match(probe, /--noconftest/);
  assert.match(probe, /'no:cacheprovider'/); assert.match(probe, /'\/dev\/null'/);
  assert.match(probe, /ARGUS_QA_RESULT/); assert.match(probe, /pytest_runtest_logreport/);
});
test('environment opt-in is explicit and run requests bind a reviewed plan, not packages/commands', () => {
  const managed = { ...input(), environmentPolicyVersion: 1, environmentPlanSha256: 'd'.repeat(64) };
  assert.equal(parseQaRequest(managed).environmentPolicyVersion, 1);
  for (const delta of [{ environmentPolicyVersion: 0 }, { environmentPlanSha256: undefined }, { packages: ['arbitrary'] },
    { catalog: '/workspace/policy.json' }, { installer: 'pip' }, { network: true }]) {
    assert.throws(() => parseQaRequest({ ...managed, ...delta }));
  }
  assert.throws(() => parseQaRequest({ ...input(), environmentPlanSha256: 'd'.repeat(64) }));
});
