// Execute only in a disposable workspace container with no production mounts or credentials.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { qaSnapshot, runQaTests } from '/app/dist/routes/qaTests.js';
assert.equal(process.env.ARGUS_DISPOSABLE_QA_CERT, 'true');
const id = randomUUID(), root = `/workspace/qa-cert-${id}`, store = `/runtime/qa-cert-${id}`;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
try {
  await mkdir(root); await writeFile(`${root}/pyproject.toml`, '# synthetic python fixture\n');
  await writeFile(`${root}/motor.py`, 'def reset(seed):\n    return seed.spawn(1)\n');
  await writeFile(`${root}/banner.jpg`, Buffer.alloc(5065965, 7));
  await writeFile(`${root}/.env`, 'SYNTHETIC_SECRET=must-not-be-readable\n');
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture']);
  const baseCommitSha = git(['rev-parse', 'HEAD']);
  const base = { action: 'run', threadId: randomUUID(), workspaceRoot: root, baseCommitSha, basisSha256: 'b'.repeat(64) };
  const request = async (content, fileId = 'seeded_reset') => ({ ...base, sourceSha256: (await qaSnapshot(base)).sourceSha256, files: [{ id: fileId, content }] });
  const code = 'from motor import reset\ndef test_seeded_reset():\n    assert reset(42) == 42\n';
  const first = await request(code), red = await runQaTests(first, undefined, store);
  assert.equal(red.passed, false, red.stderr); assert.equal(red.assertionFailed, true, red.stdout + red.stderr);
  assert.equal(red.collected, 1);
  assert.deepEqual(await runQaTests(first, undefined, store), red, 'completed request is a receipt lookup, not another execution');
  await writeFile(`${root}/motor.py`, 'def reset(seed):\n    return int(seed)\n');
  await assert.rejects(runQaTests(first, undefined, store), /workspace_changed/);
  const second = await request(code), green = await runQaTests(second, undefined, store);
  assert.equal(green.passed, true, green.stdout + green.stderr);
  assert.equal(green.testSha256, red.testSha256); assert.notEqual(green.sourceSha256, red.sourceSha256);
  const probe = `import os, pathlib, socket, subprocess, pytest
def test_boundaries():
 assert 'WORKSPACE_SECRET' not in os.environ
 assert len(pathlib.Path('/repo/banner.jpg').read_bytes()) == 5065965
 for p in ['/repo/.env', '/repo/.git', '/home/node/.codex', '/proc/1/environ', ${JSON.stringify(root)}]:
  assert not pathlib.Path(p).exists()
 with pytest.raises(OSError): pathlib.Path('/repo/motor.py').write_text('tampered')
 with pytest.raises(OSError): socket.socket()
 with pytest.raises(OSError): subprocess.run(['/usr/bin/true'])
 pathlib.Path('/tmp/scratch').write_text('ok')
`;
  const isolated = await runQaTests(await request(probe, 'boundaries'), undefined, store);
  assert.equal(isolated.passed, true, isolated.stdout + isolated.stderr);
  for (const content of ['import pytest\ndef test_skip(): pytest.skip("skip")\n',
    'import pytest\n@pytest.mark.xfail(reason="known")\ndef test_xfail(): assert False\n',
    'import pytest\n@pytest.mark.xfail(reason="unexpected pass")\ndef test_xpass(): assert True\n',
    '# no tests\n', 'import missing_qa_fixture_dependency\n']) {
    const result = await runQaTests(await request(content), undefined, store);
    assert.equal(result.passed, false); assert.equal(result.assertionFailed, false);
  }
  const canceledRequest = await request('import time\ndef test_long(): time.sleep(35)\n');
  const controller = new AbortController();
  const pending = runQaTests(canceledRequest, controller.signal, store);
  setTimeout(() => controller.abort(), 500);
  assert.equal((await pending).status, 'canceled');
  const timeout = await runQaTests(await request('import time\ndef test_timeout(): time.sleep(35)\n'), undefined, store);
  assert.equal(timeout.status, 'timeout'); assert.equal(timeout.passed, false);
  const incomplete = await request('def test_unknown(): assert True\n');
  const partial = `${store}/${incomplete.threadId}/${hash(incomplete)}`;
  await mkdir(partial); await writeFile(`${partial}/intent.json`, JSON.stringify(incomplete));
  await assert.rejects(runQaTests(incomplete, undefined, store));
  assert.equal(await readFile(`${root}/motor.py`, 'utf8'), 'def reset(seed):\n    return int(seed)\n');
  await symlink('/etc/passwd', `${root}/outside`);
  await assert.rejects(qaSnapshot(base), /unsafe_source/);
  console.log(JSON.stringify({ passed: true, providerCalls: 0, checks: ['red-before/green-after same QA source', 'uncommitted source snapshot', 'receipt replay', 'stale source refusal', 'no hidden/git/credentials/host access', 'read-only repo', 'no network/processes', 'skips/xfail/empty/collection errors fail closed', 'cancel', 'timeout', 'interrupted attempt refusal', 'symlink refusal'] }));
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(store, { recursive: true, force: true });
}
