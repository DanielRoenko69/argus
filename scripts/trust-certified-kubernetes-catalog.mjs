#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const databaseUrl = process.env.POSTGRES_CONNECTION_URL ?? '';
const expectedFingerprint = (process.env.ARGUS_KUBERNETES_CATALOG_TRUST_FINGERPRINT ?? '').trim();
const actor = (process.env.ARGUS_CERTIFICATION_ACTOR ?? '').trim();
const reportPath = process.env.ARGUS_KUBERNETES_CERTIFICATION_REPORT
  ?? 'test-results/kubernetes-connector-certification.json';

if (!databaseUrl) throw new Error('POSTGRES_CONNECTION_URL is required');
if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
  throw new Error('ARGUS_KUBERNETES_CATALOG_TRUST_FINGERPRINT must contain the exact reviewed SHA-256 fingerprint');
}
if (!actor || actor.length > 255) throw new Error('ARGUS_CERTIFICATION_ACTOR is required');

const report = JSON.parse(await readFile(reportPath, 'utf8'));
if (report?.overall !== 'passed' || report?.targetId !== 'argus-aiops-kind'
  || report?.profile !== 'in-cluster-read-only') {
  throw new Error('the Kubernetes certification report is not a passing argus-aiops-kind read-only report');
}
const generatedAt = Date.parse(report.generatedAt ?? '');
if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > 30 * 60_000 || generatedAt > Date.now() + 60_000) {
  throw new Error('the Kubernetes certification report must be fresh (maximum age: 30 minutes)');
}
const requiredChecks = ['workload.read-only-tools', 'rbac.get:secrets:argus-demo', 'supply-chain.image-digest'];
for (const id of requiredChecks) {
  if (!report.checks?.some(check => check.id === id && check.status === 'passed')) {
    throw new Error(`required certification check did not pass: ${id}`);
  }
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const current = await client.query(
    `SELECT registry.*, backend.name AS backend_name
       FROM mcp_registry_entries registry
       JOIN mcp_backends backend ON backend.id=registry.backend_id
      WHERE backend.name='aiops-kubernetes' AND backend.backend_type='mcp'
      FOR UPDATE OF registry`,
  );
  const registry = current.rows[0];
  if (!registry) throw new Error('aiops-kubernetes registry entry was not found');
  if (registry.catalog_fingerprint !== expectedFingerprint) {
    throw new Error(`catalog fingerprint changed during review: ${registry.catalog_fingerprint}`);
  }
  if (registry.trust_status !== 'changed') {
    throw new Error(`catalog must be in changed state, received ${registry.trust_status}`);
  }
  const summary = registry.change_summary ?? {};
  if ((summary.added ?? []).length !== 0 || (summary.removed ?? []).length !== 0
    || JSON.stringify(summary.changed ?? []) !== JSON.stringify(['k8s_generate_resource'])) {
    throw new Error(`catalog drift exceeds the reviewed schema-only change: ${JSON.stringify(summary)}`);
  }

  const user = await client.query(
    `SELECT id, username FROM mcp_users
      WHERE username=$1 AND role='platform_admin' AND enabled=true LIMIT 1`,
    [actor],
  );
  if (!user.rows[0]) throw new Error(`enabled platform administrator '${actor}' was not found`);

  const trusted = await client.query(
    `UPDATE mcp_registry_entries
        SET trust_status='trusted', trusted_fingerprint=catalog_fingerprint,
            verified_at=now(), verified_by_user_id=$2, verification_comment=$3
      WHERE backend_id=$1
      RETURNING backend_id, trust_status, catalog_fingerprint, verified_at`,
    [registry.backend_id, user.rows[0].id,
      `Local read-only connector certification passed (${report.contractSha256}); reviewed schema drift: k8s_generate_resource`],
  );
  await client.query(
    `INSERT INTO mcp_admin_audit_log
      (action, table_name, object_id, object_label, changed_by, changed_by_api_key, before_state, after_state)
     VALUES ('trusted', 'mcp_registry_entries', $1, $2, $3, NULL, $4::jsonb, $5::jsonb)`,
    [String(registry.backend_id), registry.backend_name, user.rows[0].username,
      JSON.stringify({ trust_status: registry.trust_status, catalog_fingerprint: registry.catalog_fingerprint }),
      JSON.stringify({
        trust_status: 'trusted', catalog_fingerprint: expectedFingerprint,
        certification_report: reportPath, contract_sha256: report.contractSha256,
      })],
  );
  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({ ok: true, registry: trusted.rows[0], actor: user.rows[0].username }, null, 2)}\n`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
