import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/qdrant-provider-certification.mjs'], {
      cwd: root, env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function fixtureServer() {
  return createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/readyz') { response.writeHead(200); response.end('true'); return; }
    if (request.method === 'DELETE') { response.writeHead(200); response.end('{"result":true}'); return; }
    if (request.method === 'PUT' && /\/collections\/[^/]+$/.test(path)) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"result":true}'); return; }
    if (request.method === 'PUT' && path.includes('/points')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"ok"}'); return; }
    if (request.method === 'POST' && path.includes('/points/search')) {
      const payload = await body(request);
      assert.deepEqual(payload.vector, [1, 0, 0]);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"result":[{"id":1,"score":1,"payload":{"content":"ARGUS_QDRANT_CERTIFIED","source":"runbook.md"}}]}');
      return;
    }
    if (request.method === 'POST' && path.includes('/points/scroll')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"result":{"points":[{"id":1,"payload":{}},{"id":2,"payload":{}}]}}');
      return;
    }
    response.writeHead(404); response.end();
  });
}

async function listen(server) {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  return `http://127.0.0.1:${address.port}`;
}

test('reports not_run without explicit Qdrant certification configuration', async () => {
  const reportPath = 'test-results/qdrant-certification-not-run.json';
  const result = await run({ ARGUS_QDRANT_CERTIFICATION_BASE_URL: '', ARGUS_QDRANT_CERTIFICATION_REQUIRED: '', ARGUS_QDRANT_CERTIFICATION_REPORT: reportPath });
  assert.equal(result.code, 0);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.overall, 'not_run');
  await rm(resolve(root, reportPath), { force: true });
});

test('certifies collection, deterministic upsert, vector search and payload scroll', async () => {
  const server = fixtureServer();
  const baseUrl = await listen(server);
  const reportPath = 'test-results/qdrant-certification-passed.json';
  const result = await run({
    ARGUS_QDRANT_CERTIFICATION_BASE_URL: baseUrl,
    ARGUS_QDRANT_CERTIFICATION_REQUIRED: '1',
    ARGUS_QDRANT_CERTIFICATION_REPORT: reportPath,
  });
  await new Promise(resolveClose => server.close(resolveClose));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.overall, 'passed');
  assert.equal(report.checks.length, 5);
  assert.ok(report.checks.every(check => !('body' in check) && !('payload' in check) && !('error' in check)));
  await rm(resolve(root, reportPath), { force: true });
});
