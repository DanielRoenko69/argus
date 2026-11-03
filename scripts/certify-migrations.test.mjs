import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/certify-migrations.mjs'], { cwd: root, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

test('does not touch a developer database when no disposable URL is configured', async () => {
  const reportPath = 'test-results/migration-certification-test.json';
  const result = await run({
    MIGRATION_CERTIFICATION_DATABASE_URL: '',
    MIGRATION_CERTIFICATION_REQUIRED: '0',
    ARGUS_MIGRATION_CERTIFICATION_REPORT: reportPath,
  });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.status, 'not_run');
  assert.equal(report.naming.ordered, true);
  assert.equal(report.naming.duplicate_numbers.length, 0);
  await rm(resolve(root, reportPath), { force: true });
});

test('supports strict release mode without silently treating a missing DB as passed', async () => {
  const reportPath = 'test-results/migration-certification-test-required.json';
  const result = await run({
    MIGRATION_CERTIFICATION_DATABASE_URL: '',
    MIGRATION_CERTIFICATION_REQUIRED: '1',
    ARGUS_MIGRATION_CERTIFICATION_REPORT: reportPath,
  });
  assert.equal(result.code, 2);
  await rm(resolve(root, reportPath), { force: true });
});
