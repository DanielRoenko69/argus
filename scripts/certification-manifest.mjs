#!/usr/bin/env node
/**
 * Create/verify a signed Argus release-certification manifest.
 *
 * The manifest is deliberately an evidence index, not a copy of test output:
 * only gate status, artifact hashes, image digest and revision are included.
 * HMAC signing keeps the first implementation dependency-free for CI.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const command = process.argv[2] || 'create';
const manifestPath = process.env.ARGUS_CERTIFICATION_MANIFEST_PATH || 'test-results/argus-certification-manifest.json';
const signaturePath = process.env.ARGUS_CERTIFICATION_SIGNATURE_PATH || `${manifestPath}.sig`;
const signingKey = (process.env.ARGUS_CERTIFICATION_SIGNING_KEY || '').trim();

function safeText(value, max = 300) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readRevision() {
  if (process.env.ARGUS_GIT_REVISION) return safeText(process.env.ARGUS_GIT_REVISION, 128);
  try { return safeText(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }), 128); } catch { return null; }
}

function requiredGates() {
  return [...new Set((process.env.ARGUS_CERTIFICATION_REQUIRED_GATES || '')
    .split(',').map(value => value.trim()).filter(Boolean))];
}

async function digestArtifact(path) {
  try {
    const bytes = await readFile(resolve(path));
    return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
  } catch {
    return null;
  }
}

async function loadGate(name, reportPath) {
  if (!reportPath) return { name, status: 'not_run', artifact: null, reason: 'no report configured' };
  const artifact = await digestArtifact(reportPath);
  if (!artifact) return { name, status: 'not_run', artifact: { path: reportPath }, reason: 'report not found' };
  try {
    const report = JSON.parse(await readFile(resolve(reportPath), 'utf8'));
    // Operational gates use `status`; provider/evaluation reports use `overall`.
    const reportStatus = report?.overall ?? report?.status;
    const status = reportStatus === 'passed' ? 'passed'
      : reportStatus === 'failed' ? 'failed' : 'not_run';
    return { name, status, artifact };
  } catch {
    return { name, status: 'failed', artifact, reason: 'report is not valid JSON' };
  }
}

function gateStatus(gates, required) {
  const requiredMissing = required.filter(name => gates.find(gate => gate.name === name)?.status !== 'passed');
  const failed = gates.some(gate => gate.status === 'failed');
  const passed = gates.some(gate => gate.status === 'passed');
  return {
    overall: failed || requiredMissing.length ? 'failed' : passed ? 'passed' : 'not_run',
    requiredMissing,
  };
}

function sign(payload) {
  if (!signingKey) throw new Error('ARGUS_CERTIFICATION_SIGNING_KEY is required');
  return `hmac-sha256=${createHmac('sha256', signingKey).update(payload).digest('hex')}`;
}

async function createManifest() {
  const gates = await Promise.all([
    loadGate('ci-provider', process.env.ARGUS_PROVIDER_CERTIFICATION_REPORT || 'test-results/ci-provider-certification.json'),
    loadGate('migrations', process.env.ARGUS_MIGRATION_CERTIFICATION_REPORT || 'test-results/migration-certification.json'),
    loadGate('run-resource-snapshots', process.env.RUN_RESOURCE_SNAPSHOT_CERTIFICATION_REPORT || 'test-results/run-resource-snapshot-certification.json'),
    loadGate('repository-graph', process.env.REPOSITORY_GRAPH_CERTIFICATION_REPORT || 'test-results/repository-graph-certification.json'),
    loadGate('canonical-audit', process.env.CANONICAL_AUDIT_CERTIFICATION_REPORT || 'test-results/canonical-audit-certification.json'),
    loadGate('chaos-recovery', process.env.ARGUS_CHAOS_REPORT || 'test-results/chaos-recovery.json'),
    loadGate('ha-session', process.env.ARGUS_HA_REPORT || 'test-results/ha-session-continuity.json'),
    loadGate('llm-faults', process.env.ARGUS_LLM_FAULT_REPORT || 'test-results/llm-provider-faults.json'),
    loadGate('anthropic-faults', process.env.ARGUS_ANTHROPIC_FAULT_REPORT || 'test-results/anthropic-provider-faults.json'),
    loadGate('qdrant', process.env.ARGUS_QDRANT_CERTIFICATION_REPORT || 'test-results/qdrant-provider-certification.json'),
    loadGate('external-rag', process.env.ARGUS_EXTERNAL_RAG_REPORT || 'test-results/external-rag-provider-certification.json'),
    loadGate('rag-injection', process.env.ARGUS_RAG_INJECTION_REPORT || 'test-results/rag-injection-certification.json'),
    loadGate('evaluation', process.env.ARGUS_EVALUATION_CERTIFICATION_REPORT || 'test-results/evaluation-certification.json'),
    loadGate('local-e2e', process.env.ARGUS_LOCAL_E2E_REPORT),
  ]);
  const required = requiredGates();
  const outcome = gateStatus(gates, required);
  const imageDigest = safeText(process.env.ARGUS_IMAGE_DIGEST, 200) || null;
  const requireDigest = process.env.ARGUS_CERTIFICATION_REQUIRE_IMAGE_DIGEST === '1';
  const manifest = {
    schema: 'argus.certification.v1',
    generated_at: new Date().toISOString(),
    git_revision: readRevision(),
    image: {
      reference: safeText(process.env.ARGUS_IMAGE_REFERENCE, 300) || null,
      digest: imageDigest,
    },
    required_gates: required,
    required_missing: outcome.requiredMissing,
    gates,
    overall: requireDigest && !imageDigest ? 'failed' : outcome.overall,
    ...(requireDigest && !imageDigest ? { reason: 'image digest is required' } : {}),
  };
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  const signature = sign(payload);
  await mkdir(dirname(resolve(manifestPath)), { recursive: true });
  await writeFile(resolve(manifestPath), payload, 'utf8');
  await writeFile(resolve(signaturePath), `${signature}\n`, 'utf8');
  process.stdout.write(JSON.stringify({ manifest: manifestPath, signature: signaturePath, overall: manifest.overall, signature }, null, 2) + '\n');
  if (manifest.overall === 'failed') process.exitCode = 2;
}

async function verifyManifest() {
  if (!signingKey) throw new Error('ARGUS_CERTIFICATION_SIGNING_KEY is required');
  const payload = await readFile(resolve(manifestPath), 'utf8');
  const stored = (await readFile(resolve(signaturePath), 'utf8')).trim();
  const expected = sign(payload);
  const valid = stored.length === expected.length && timingSafeEqual(Buffer.from(stored), Buffer.from(expected));
  let manifest = null;
  try { manifest = JSON.parse(payload); } catch { /* signature validity still reported */ }
  process.stdout.write(JSON.stringify({ valid, overall: manifest?.overall ?? null, manifest: manifestPath, signature: signaturePath }, null, 2) + '\n');
  if (!valid) process.exitCode = 2;
}

try {
  if (command === 'create') await createManifest();
  else if (command === 'verify') await verifyManifest();
  else throw new Error(`Unknown command '${command}'. Use create or verify.`);
} catch (error) {
  process.stderr.write(`${safeText(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 2;
}
