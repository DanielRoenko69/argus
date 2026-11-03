import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('certifies RAG prompt-injection boundaries without retaining adversarial content', async () => {
  const reportPath = 'test-results/rag-injection-certification-test.json';
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/rag-injection-gate.mjs'], {
      cwd: root,
      env: { ...process.env, ARGUS_RAG_INJECTION_REPORT: reportPath },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.overall, 'passed');
  assert.equal(report.checks.length, 5);
  assert.ok(report.checks.every(check => !('payload' in check) && !('content' in check)));
  await rm(resolve(root, reportPath), { force: true });
});
