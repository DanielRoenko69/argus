import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('certifies all compiled external Knowledge adapter journeys without cloud credentials', async () => {
  const reportPath = 'test-results/external-rag-provider-certification-test.json';
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/external-rag-provider-certification.mjs'], {
      cwd: root,
      env: { ...process.env, ARGUS_EXTERNAL_RAG_REPORT: reportPath },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.overall, 'passed');
  assert.deepEqual(report.providers.map(provider => provider.name), [
    'azure_ai_search', 'opensearch', 'elasticsearch', 'weaviate', 'pinecone', 'milvus', 'qdrant',
  ]);
  assert.ok(report.providers.every(provider => provider.status === 'passed' && !('body' in provider) && !('error' in provider)));
  await rm(resolve(root, reportPath), { force: true });
});
