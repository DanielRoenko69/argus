import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDevelopmentOutcome, parseFileScope, missingHandoffPlaceholder, validateRequirementsReply, validateDevelopmentResume, testInfrastructureBlocker } from './developmentContract.js';

test('explicit missing authority is a blocker, not a code retry', () => {
  assert.equal(parseDevelopmentOutcome('{"status":"blocked","summary":"No files changed","blockers":["Provide approved scope"]}').status, 'blocked');
  for (const text of ['done', '{"status":"ready","summary":"done","blockers":["missing"]}', '{"status":"blocked","summary":"wait","blockers":[]}']) {
    assert.throws(() => parseDevelopmentOutcome(text));
  }
});
test('file scope cannot include globs, traversal, metadata or shell syntax', () => {
  assert.deepEqual(parseFileScope('src/new.py\ntests/test_new.py'), ['src/new.py', 'tests/test_new.py']);
  for (const value of ['../escape', '/etc/passwd', 'src/*', '.git/config', 'src/a.py;env']) assert.throws(() => parseFileScope(value));
});
test('missing handoff and infrastructure errors are not implementation instructions', () => {
  assert.equal(missingHandoffPlaceholder('<Hier den Link zum freigegebenen Planning-Lauf und den vollständigen Abschnitt einfügen.>'), true);
  assert.equal(missingHandoffPlaceholder('Add x < 3 validation'), false);
  assert.ok(testInfrastructureBlocker('TOOLCHAIN_UNAVAILABLE: python3'));
  assert.equal(testInfrastructureBlocker('AssertionError: expected 2'), null);
});
test('requirements checkpoint cannot be passed with an approval', () => {
  assert.throws(() => validateDevelopmentResume(true, { approved: true }));
  assert.throws(() => validateDevelopmentResume(false, { requirements: 'approve it' }));
  assert.doesNotThrow(() => validateDevelopmentResume(true, { requirements: 'Exact scope' }));
  assert.throws(() => validateRequirementsReply({ approved: true }));
  assert.throws(() => validateRequirementsReply({ requirements: 'scope', approved: true }));
  assert.equal(validateRequirementsReply({ requirements: ' Exact requirements ' }), 'Exact requirements');
});
