import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = 'test-results/manifest-test-provider.json';
const manifestPath = 'test-results/manifest-test.json';
const signaturePath = `${manifestPath}.sig`;

function run(command, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/certification-manifest.mjs', command], { cwd: root, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

test('creates and verifies a signed evidence manifest without copying report contents', async () => {
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  await writeFile(resolve(root, reportPath), JSON.stringify({ overall: 'passed', secret: 'must-not-be-copied' }), 'utf8');
  const env = {
    ARGUS_PROVIDER_CERTIFICATION_REPORT: reportPath,
    // Keep the unit test independent from certification artifacts that may
    // legitimately exist in a developer checkout from earlier demo runs.
    ARGUS_MIGRATION_CERTIFICATION_REPORT: 'test-results/manifest-test-missing-migrations.json',
    RUN_RESOURCE_SNAPSHOT_CERTIFICATION_REPORT: 'test-results/manifest-test-missing-run-snapshots.json',
    REPOSITORY_GRAPH_CERTIFICATION_REPORT: 'test-results/manifest-test-missing-repository-graph.json',
    CANONICAL_AUDIT_CERTIFICATION_REPORT: 'test-results/manifest-test-missing-canonical-audit.json',
    ARGUS_CHAOS_REPORT: 'test-results/manifest-test-missing-chaos.json',
    ARGUS_HA_REPORT: 'test-results/manifest-test-missing-ha.json',
    ARGUS_LLM_FAULT_REPORT: 'test-results/manifest-test-missing-llm-faults.json',
    ARGUS_ANTHROPIC_FAULT_REPORT: 'test-results/manifest-test-missing-anthropic-faults.json',
    ARGUS_QDRANT_CERTIFICATION_REPORT: 'test-results/manifest-test-missing-qdrant.json',
    ARGUS_EXTERNAL_RAG_REPORT: 'test-results/manifest-test-missing-external-rag.json',
    ARGUS_RAG_INJECTION_REPORT: 'test-results/manifest-test-missing-rag-injection.json',
    ARGUS_EVALUATION_CERTIFICATION_REPORT: 'test-results/manifest-test-missing-evaluation.json',
    ARGUS_LOCAL_E2E_REPORT: 'test-results/manifest-test-missing-local-e2e.json',
    ARGUS_CERTIFICATION_REQUIRED_GATES: 'ci-provider',
    ARGUS_CERTIFICATION_REQUIRE_IMAGE_DIGEST: '1',
    ARGUS_IMAGE_REFERENCE: 'argus:test',
    ARGUS_IMAGE_DIGEST: 'sha256:abc123',
    ARGUS_CERTIFICATION_SIGNING_KEY: 'manifest-test-signing-key',
    ARGUS_CERTIFICATION_MANIFEST_PATH: manifestPath,
    ARGUS_CERTIFICATION_SIGNATURE_PATH: signaturePath,
  };
  const created = await run('create', env);
  assert.equal(created.code, 0, created.stderr);
  const manifestText = await readFile(resolve(root, manifestPath), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.overall, 'passed');
  assert.equal(manifest.gates[0].status, 'passed');
  assert.equal(manifestText.includes('must-not-be-copied'), false);
  const verified = await run('verify', env);
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, /"valid": true/);
  await writeFile(resolve(root, manifestPath), `${manifestText}tampered`, 'utf8');
  const tampered = await run('verify', env);
  assert.equal(tampered.code, 2);
  assert.match(tampered.stdout, /"valid": false/);
  await Promise.all([reportPath, manifestPath, signaturePath].map(path => rm(resolve(root, path), { force: true })));
});
