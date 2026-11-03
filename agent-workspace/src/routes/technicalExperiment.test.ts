import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseExperimentRequest, snapshotPathAllowed, sandboxArgs, snapshotLimits, planSnapshot, EXPERIMENT_LIMITS, SnapshotPreparationError } from './technicalExperiment.js';
test('experiment input is strict and cannot pick command, interpreter, mount or credentials', () => {
  const valid = { threadId: randomUUID(), workspaceRoot: '/workspace/RUN-1', baseCommitSha: 'a'.repeat(40),
    basisSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), script: 'print(42)' };
  assert.deepEqual(parseExperimentRequest(valid), valid);
  for (const change of [{ workspaceRoot: '/workspace/../home' }, { threadId: '../../outside' }, { cmd: 'sh' },
    { script: 'é'.repeat(13000) }, { script: '\0' }, { script: ' ' }, { env: { TOKEN: 'secret' } }, { mounts: [] }, { snapshotFileBytes: 33554432 }]) {
    assert.throws(() => parseExperimentRequest({ ...valid, ...change }));
  }
});
test('operator snapshot limits have bounded integer configuration and conservative invalid-config rejection', () => {
  assert.deepEqual(snapshotLimits({}), { snapshotFileBytes: 16 * 1048576, snapshotBytes: 128 * 1048576 });
  assert.deepEqual(snapshotLimits({ ARGUS_SNAPSHOT_FILE_MIB: '32', ARGUS_SNAPSHOT_TOTAL_MIB: '256' }), { snapshotFileBytes: 32 * 1048576, snapshotBytes: 256 * 1048576 });
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '33', '16mb', ' 16']) {
    assert.throws(() => snapshotLimits({ ARGUS_SNAPSHOT_FILE_MIB: value }));
  }
  assert.throws(() => snapshotLimits({ ARGUS_SNAPSHOT_TOTAL_MIB: '257' }));
  assert.throws(() => snapshotLimits({ ARGUS_SNAPSHOT_TOTAL_MIB: '8' }));
});
test('whole-tree preflight retains frontend media and rejects exact file/total/count overflows before copying', () => {
  const entry = (file: string, size: number) => `100644 blob ${'a'.repeat(40)} ${size}\t${file}`;
  const plan = planSnapshot([entry('src/app.py', 42), entry('docs/plots/project_banner.jpg', 5065965)]);
  assert.equal(plan.files.length, 2); assert.equal(plan.bytes, 5066007);
  assert.equal(planSnapshot([entry('image.bin', 16 * 1048576)]).files.length, 1);
  assert.throws(() => planSnapshot([entry('image.bin', 16 * 1048576 + 1)]), (e: unknown) => {
    assert.ok(e instanceof SnapshotPreparationError); assert.equal(e.reason, 'snapshot_file_size_limit');
    assert.equal(e.filePath, 'image.bin'); assert.equal(e.actual, 16 * 1048576 + 1); return true;
  });
  const eight = Array.from({ length: 8 }, (_, i) => entry(`img${i}.bin`, 16 * 1048576));
  assert.equal(planSnapshot(eight).bytes, 128 * 1048576);
  assert.throws(() => planSnapshot([...eight, entry('one.py', 1)]), /snapshot_total_size_limit/);
  assert.throws(() => planSnapshot(Array(3001).fill(entry('x', 0))), /snapshot_file_count_limit/);
  const smaller = { ...EXPERIMENT_LIMITS, ...snapshotLimits({ ARGUS_SNAPSHOT_FILE_MIB: '2', ARGUS_SNAPSHOT_TOTAL_MIB: '64' }) };
  assert.throws(() => planSnapshot([entry('banner.jpg', 5065965)], smaller), /snapshot_file_size_limit/);
});
test('snapshot excludes hidden content, symlinks and path traversal', () => {
  assert.ok(snapshotPathAllowed('src/motor.py', '100644'));
  for (const p of ['.env', 'src/.git/config', '../escape', '/absolute', 'a/../b', 'a//b', 'secrets/key', 'node_modules/a', 'a\\b', 'a\nb']) {
    assert.equal(snapshotPathAllowed(p, '100644'), false, p);
  }
  assert.equal(snapshotPathAllowed('linked', '120000'), false);
});
test('sandbox contains exact copied mounts, clean env, namespaces and a fixed filtered Python launcher', () => {
  const args = sandboxArgs('/runtime/technical-experiments/fixture', null), joined = args.join(' ');
  assert.ok(args.includes('--unshare-all')); assert.ok(args.includes('--unshare-user')); assert.ok(args.includes('--clearenv'));
  assert.ok(args.includes('--cap-drop')); assert.ok(args.includes('/usr/bin/python3')); assert.ok(args.includes('-I'));
  assert.match(joined, /seccomp_load/); assert.match(joined, /clone clone3 fork vfork execve execveat unshare setns/);
  assert.ok(!joined.includes('/workspace')); assert.ok(!joined.includes('.codex')); assert.ok(!args.includes('--proc'));
  assert.ok(!args.includes('--bind')); assert.ok(args.includes('--ro-bind'));
});
