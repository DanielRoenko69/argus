import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEncryptedRecoveryBundle,
  openEncryptedRecoveryBundle,
  recoverySha256,
} from './lib/pilot-recovery-bundle.mjs';

const key = 'pilot-recovery-test-key-with-at-least-32-characters';

test('round-trips an encrypted database, workspace and WORM receipt manifest', () => {
  const databaseArchive = Buffer.from('postgres-custom-archive-fixture');
  const bundle = createEncryptedRecoveryBundle({
    databaseArchive,
    gitRevision: 'abc123',
    workspaceFiles: [{ path: 'runs/run-1/receipt.json', content: Buffer.from('{"ok":true}') }],
    configuration: [{ path: 'docker-compose.yml', sha256: 'a'.repeat(64) }],
    wormReceipts: [{ objectKey: 'tenant-a/workspace-a/report-1', digest: 'b'.repeat(64) }],
  }, key, new Date('2026-09-14T12:00:00.000Z'));

  assert.equal(JSON.stringify(bundle).includes('postgres-custom-archive-fixture'), false);
  assert.equal(JSON.stringify(bundle).includes(key), false);
  const opened = openEncryptedRecoveryBundle(bundle, key);
  assert.deepEqual(opened.databaseArchive, databaseArchive);
  assert.equal(opened.manifest.workspace.fileCount, 1);
  assert.equal(opened.manifest.wormReceipts.length, 1);
  assert.equal(opened.workspaceFiles[0].sha256, recoverySha256(Buffer.from('{"ok":true}')));
});

test('fails authentication for a wrong key or modified ciphertext', () => {
  const bundle = createEncryptedRecoveryBundle({ databaseArchive: Buffer.from('db') }, key);
  assert.throws(() => openEncryptedRecoveryBundle(bundle, `${key}-wrong`));
  const tampered = { ...bundle, ciphertext: `${bundle.ciphertext.slice(0, -4)}AAAA` };
  assert.throws(() => openEncryptedRecoveryBundle(tampered, key));
});
