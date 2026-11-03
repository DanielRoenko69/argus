// Two unrelated disposable projects. No model, real checkout, volume or approval.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { qaSnapshot, runQaTests } from '/app/dist/routes/qaTests.js';
assert.equal(process.env.ARGUS_DISPOSABLE_RESOLVER_CERT, 'true');
assert.equal(process.getuid(), 1000);
async function fixture(name, manifest, source) {
  const root = `/workspace/${name}`;
  await mkdir(root);
  for (const [file, text] of Object.entries(manifest)) await writeFile(`${root}/${file}`, text);
  await writeFile(`${root}/product.py`, source);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture']);
  return { action: 'inspect', threadId: randomUUID(), workspaceRoot: root, baseCommitSha: git(['rev-parse', 'HEAD']), basisSha256: 'a'.repeat(64), environmentPolicyVersion: 1 };
}
async function execute(input, files) {
  const before = await qaSnapshot(input);
  assert.equal(before.environment?.status, 'ready', JSON.stringify(before.environment));
  const request = { ...input, action: 'run', sourceSha256: before.sourceSha256, environmentPlanSha256: before.environment.planSha256, files };
  const receipt = await runQaTests(request, undefined, '/runtime/resolver-cert');
  return { before, request, receipt };
}
const first = await fixture('resolver-first', { 'requirements.txt': 'packaging==25.0\n' }, 'def answer(): return 42\n');
const files = [{ id: 'same_tests', content: `import pathlib, socket, subprocess, pytest, colorama
from product import answer
def test_original_contract():
 assert answer() == 42
 assert colorama.Fore.RED
 assert not pathlib.Path('/run/secrets/environment_resolver').exists()
 with pytest.raises(OSError): socket.socket()
 with pytest.raises(OSError): subprocess.run(['/usr/bin/true'])
 with pytest.raises(OSError): pathlib.Path('/repo/product.py').write_text('no')
 with pytest.raises(OSError): pathlib.Path('/deps/mutate.py').write_text('no')
` }];
const failed = await execute(first, files);
assert.equal(failed.receipt.environment?.status, 'ready', JSON.stringify(failed.receipt));
assert.equal(failed.receipt.passed, false);
assert.equal(failed.receipt.assertionFailed, false);
assert.deepEqual(failed.receipt.missingModules, ['colorama'], failed.receipt.stdout + failed.receipt.stderr);
const supplement = { ...first, environmentRequirements: [{ requirement: 'colorama>=0.4,<1', reason: 'Frozen test_same_tests.py imports colorama; known distribution name' }] };
const repaired = await execute(supplement, files);
assert.equal(repaired.receipt.passed, true, JSON.stringify(repaired.receipt));
assert.equal(repaired.receipt.testSha256, failed.receipt.testSha256);
assert.equal(repaired.receipt.sourceSha256, failed.receipt.sourceSha256);
for (const p of failed.receipt.environment.packages) assert.deepEqual(repaired.receipt.environment.packages.find(other => other.name === p.name), p);
assert.deepEqual(await runQaTests(repaired.request, undefined, '/runtime/resolver-cert'), repaired.receipt);
await writeFile(`${first.workspaceRoot}/product.py`, 'def answer(): return 0\n');
const red = await execute(supplement, files);
assert.equal(red.receipt.assertionFailed, true, JSON.stringify(red.receipt));
assert.equal(red.receipt.testSha256, repaired.receipt.testSha256);
assert.equal(red.receipt.environment.resolution.lockSha256, repaired.receipt.environment.resolution.lockSha256);
const second = await fixture('resolver-unrelated', { 'pyproject.toml': '[project]\nname="unrelated"\nversion="1"\ndependencies=["idna==3.10"]\n' }, 'import idna\ndef answer(): return idna.encode("example.org")\n');
const independent = await execute(second, [{ id: 'unrelated', content: 'from product import answer\ndef test_domain(): assert answer() == b"example.org"\n' }]);
assert.equal(independent.receipt.passed, true, JSON.stringify(independent.receipt));
assert.ok(independent.receipt.environment.packages.some(p => p.name === 'idna'));
assert.ok(!independent.receipt.environment.packages.some(p => p.name === 'colorama'), 'projects do not share installed supplements');
const blocked = await fixture('resolver-denied', { 'requirements.txt': 'evil @ https://example.invalid/evil.whl\n' }, '');
const denied = await qaSnapshot(blocked);
assert.equal(denied.environment.status, 'blocked');
assert.ok(denied.environment.reasons.includes('environment_source_not_allowed'));
console.log(JSON.stringify({ passed: true, providerCalls: 0, realProjectsTouched: 0,
  checks: ['real public-PyPI resolution', 'two unrelated project manifests', 'missing import receipt', 'isolated dependency supplement',
    'same frozen tests and unchanged source', 'previous versions and hashes retained', 'no test network/process/write/secret access',
    'known receipt readback without execution', 'red assertion remains red', 'unapproved dependency URL blocked'] }));
