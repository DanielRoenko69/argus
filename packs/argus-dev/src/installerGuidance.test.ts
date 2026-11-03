import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { VERIFIED_ARCHIVE_EXAMPLE, INSTALLER_GUIDANCE } from './installerGuidance.js';
import { STACK_PLAN_INSTRUCTION, STACK_REPAIR_INSTRUCTION } from './stackClient.js';
import { CODEGEN_PLAN_INSTRUCTION } from './codeGeneration.js';
import { CODEGEN_REPAIR_INSTRUCTION } from './codeGenerationRepair.js';

test('all isolated initial and repair plans receive the same integrity guidance', () => {
  for (const prompt of [STACK_PLAN_INSTRUCTION, STACK_REPAIR_INSTRUCTION, CODEGEN_PLAN_INSTRUCTION, CODEGEN_REPAIR_INSTRUCTION])
    assert.ok(prompt.includes(INSTALLER_GUIDANCE));
});

test('real checksum verification reproduces the filename bug, accepts the corrected path and rejects corrupt bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'argus-archive-fixture-'));
  try {
    const original = 'fixture archive bytes', archive = 'uv-x86_64-unknown-linux-gnu.tar.gz';
    writeFileSync(join(dir, 'original'), original);
    writeFileSync(join(dir, 'corrupt'), original + 'tampered');
    writeFileSync(join(dir, 'manifest'), createHash('sha256').update(original).digest('hex') + '  ' + archive + '\n');
    const prefix = `set -euo pipefail
asset_url=https://example.org/releases/${archive}
checksum_url=https://example.org/releases/${archive}.sha256
${process.platform === 'darwin' ? 'sha256sum() { shasum -a 256 "$@"; }' : ''}
# Download stub only: the checksum verifier and shell example are real.
curl() {
  local url dest
  while [ "$#" -gt 0 ]; do
    case "$1" in -o) dest="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac
  done
  if [ "$url" = "$checksum_url" ]; then cp "$fixture/manifest" "$dest"; else cp "$fixture/$archive_fixture" "$dest"; fi
}
`;
    for (const [name, example, archiveFixture, success] of [
      ['original-bug', VERIFIED_ARCHIVE_EXAMPLE.replace('"$download_dir/$archive_name"', '"$download_dir/uv.tar.gz"'), 'original', false],
      ['corrected', VERIFIED_ARCHIVE_EXAMPLE, 'original', true],
      ['corrupt', VERIFIED_ARCHIVE_EXAMPLE, 'corrupt', false],
    ] as const) {
      const downloadDir = join(dir, 'download-' + name); mkdirSync(downloadDir);
      const result = spawnSync('bash', ['-c', prefix + example], { encoding: 'utf8', timeout: 5000,
        env: { ...process.env, LC_ALL: 'C', fixture: dir, download_dir: downloadDir, archive_fixture: archiveFixture } });
      assert.equal(result.error, undefined); assert.equal(result.status === 0, success, result.stderr);
      if (name === 'original-bug') assert.match(result.stderr, /No such file/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
