import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/certify-run-resource-snapshots.mjs'], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

test('does not fall back to the developer database', async () => {
  const reportPath = 'test-results/run-resource-snapshot-certification-test.json';
  const result = await run({
    RUN_RESOURCE_SNAPSHOT_CERTIFICATION_DATABASE_URL: '',
    RUN_RESOURCE_SNAPSHOT_CERTIFICATION_REQUIRED: '0',
    RUN_RESOURCE_SNAPSHOT_CERTIFICATION_REPORT: reportPath,
  });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.status, 'not_run');
  await rm(resolve(root, reportPath), { force: true });
});

test('strict mode rejects a missing disposable database', async () => {
  const reportPath = 'test-results/run-resource-snapshot-certification-required-test.json';
  const result = await run({
    RUN_RESOURCE_SNAPSHOT_CERTIFICATION_DATABASE_URL: '',
    RUN_RESOURCE_SNAPSHOT_CERTIFICATION_REQUIRED: '1',
    RUN_RESOURCE_SNAPSHOT_CERTIFICATION_REPORT: reportPath,
  });
  assert.equal(result.code, 2, result.stderr);
  await rm(resolve(root, reportPath), { force: true });
});
