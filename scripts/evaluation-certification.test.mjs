import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve('.');
const reportPath = 'test-results/evaluation-certification-test.json';

function run() {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/evaluation-certification.mjs'], {
      cwd: root,
      env: { ...process.env, ARGUS_EVALUATION_CERTIFICATION_REPORT: reportPath },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stderr }));
  });
}

test('certifies native evaluation promotion and rejection semantics', async () => {
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(resolve(reportPath), 'utf8'));
  assert.equal(report.overall, 'passed');
  assert.equal(report.provider_neutral, true);
  assert.equal(report.checks.length, 3);
  await rm(resolve(reportPath), { force: true });
});

