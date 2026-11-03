// Synthetic offline certification only; never mount a real workspace, credentials or runtime volume.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { qaSnapshot, runQaTests } from '/app/dist/routes/qaTests.js';
import { projectIdentity } from '/app/dist/environments/catalog.js';
const root = '/workspace/environment-cert-fixture';
const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const requirements = 'packaging==25.0\n';
assert.equal(process.env.ARGUS_DISPOSABLE_ENVIRONMENT_CERT, 'true');
if (process.argv.includes('--seed')) {
  assert.equal(process.getuid(), 0);
  const names = (await readdir('/opt/argus-environments/wheels')).filter(n => n.endsWith('.whl'));
  const wheels = await Promise.all(names.sort().map(async file => {
    const [name, version] = file.split('-');
    return { file, name: name.replaceAll('_', '-').toLowerCase(), version,
      sha256: hash(await readFile(`/opt/argus-environments/wheels/${file}`)) };
  }));
  const manifestSha256 = projectIdentity([['requirements.txt', hash(requirements)]]).manifestSha256;
  const pythonVersion = execFileSync('/usr/bin/python3', ['-I', '-S', '-c', 'import sys; print("%s.%s" % sys.version_info[:2])'], { encoding: 'utf8' }).trim();
  await writeFile('/opt/argus-environments/catalog.json', JSON.stringify({ version: 1, profiles: [{
    id: 'synthetic-python', adapter: 'python-wheels-v1', manifestSha256, pythonVersion, wheels, imports: ['packaging', 'pytest', 'motor'],
  }] }));
  await chmod('/opt/argus-environments/catalog.json', 0o644);
  process.exit(0);
}
assert.equal(process.getuid(), 1000);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
await mkdir(root);
await writeFile(`${root}/requirements.txt`, requirements);
await writeFile(`${root}/motor.py`, 'from packaging.version import Version\ndef answer(): return Version("1.0") < Version("2.0")\n');
await writeFile(`${root}/.env`, 'SYNTHETIC_SECRET=never-exposed\n');
git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture']);
const input = { action: 'inspect', threadId: randomUUID(), workspaceRoot: root,
  baseCommitSha: git(['rev-parse', 'HEAD']), basisSha256: 'a'.repeat(64), environmentPolicyVersion: 1 };
const before = await qaSnapshot(input);
if (process.argv.includes('--assert-untrusted')) {
  assert.equal(before.environment?.status, 'blocked');
  assert.ok(before.environment.reasons.includes('environment_catalog_unavailable'));
  console.log(JSON.stringify({ passed: true, check: 'writable operator policy mount is rejected before installation' }));
  process.exit(0);
}
assert.equal(before.environment?.status, 'ready', JSON.stringify(before.environment));
const files = [{ id: 'boundaries', content: `import pathlib, socket, subprocess, pytest
from motor import answer
def test_dependencies_and_boundaries():
 assert answer()
 assert not pathlib.Path('/repo/.env').exists()
 assert not pathlib.Path('/home/node/.codex').exists()
 with pytest.raises(OSError): pathlib.Path('/deps/unauthorized.py').write_text('no')
 with pytest.raises(OSError): pathlib.Path('/repo/motor.py').write_text('no')
 with pytest.raises(OSError): socket.socket()
 with pytest.raises(OSError): subprocess.run(['/usr/bin/true'])
` }];
const request = { ...input, action: 'run', sourceSha256: before.sourceSha256, environmentPlanSha256: before.environment.planSha256, files };
const store = '/runtime/environment-cert';
const receipt = await runQaTests(request, undefined, store);
if (receipt.environment?.status !== 'ready') {
  // Fixture-only diagnostic; production APIs project hashes, not installer output.
  for (const phase of ['installation', 'preflight']) {
    try { console.log(await readFile(`${store}/${request.threadId}/${hash(request)}/environment-${phase}.json`, 'utf8')); } catch { /* phase not reached */ }
  }
}
assert.equal(receipt.environment?.status, 'ready', JSON.stringify(receipt));
assert.equal(receipt.passed, true, receipt.stdout + receipt.stderr);
assert.equal(receipt.collected, 1);
assert.equal(receipt.environment.packages.some(p => p.name === 'packaging' && p.version === '25.0'), true);
assert.deepEqual(await runQaTests(request, undefined, store), receipt, 'receipt readback, no reinstall/replay');
assert.equal((await qaSnapshot(input)).sourceSha256, before.sourceSha256);
await writeFile(`${root}/motor.py`, 'from packaging.version import Version\ndef answer(): return False\n');
await assert.rejects(runQaTests(request, undefined, store), /workspace_changed/);
const changed = await qaSnapshot(input);
const failed = await runQaTests({ ...request, sourceSha256: changed.sourceSha256 }, undefined, store);
assert.equal(failed.assertionFailed, true, JSON.stringify(failed));
assert.equal(failed.testSha256, receipt.testSha256, 'same independent tests, no weakening');
await writeFile(`${root}/requirements.txt`, 'unapproved-package==1.0\n');
const blockedPlan = await qaSnapshot(input);
assert.equal(blockedPlan.environment.status, 'blocked');
const blocked = await runQaTests({ ...request, sourceSha256: blockedPlan.sourceSha256,
  environmentPlanSha256: blockedPlan.environment.planSha256 }, undefined, store);
assert.equal(blocked.status, 'preparation_failed'); assert.equal(blocked.executionStarted, false);
assert.equal(blocked.collected, 0); assert.equal(blocked.assertionFailed, false);
await writeFile(`${root}/requirements.txt`, requirements);
const current = await qaSnapshot(input);
const canceledRequest = { ...request, sourceSha256: current.sourceSha256, files: [{ id: 'canceled', content: 'def test_cancel(): assert True\n' }] };
const controller = new AbortController(); controller.abort();
const canceled = await runQaTests(canceledRequest, controller.signal, store);
assert.equal(canceled.environment.reason, 'environment_preparation_canceled'); assert.equal(canceled.executionStarted, false);
const incomplete = { ...canceledRequest, files: [{ id: 'unknown', content: 'def test_unknown(): assert True\n' }] };
const intent = `${store}/${incomplete.threadId}/${hash(incomplete)}`;
await mkdir(intent); await writeFile(`${intent}/intent.json`, JSON.stringify(incomplete));
await assert.rejects(runQaTests(incomplete, undefined, store), /ENOENT/, 'unknown preparation is not replayed');
console.log(JSON.stringify({ passed: true, providerCalls: 0, checks: ['actual offline pinned wheel installation', 'imports and independent pytest',
  'network/process/source/dependency isolation', 'same frozen tests after product change', 'receipt replay without execution',
  'source drift rejected', 'unapproved manifest blocked without install/test', 'canceled preparation', 'unknown intent not replayed'] }));
