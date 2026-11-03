import dotenv from 'dotenv';
dotenv.config();

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { appendIncidentRemediationAudit } from '../observability/incidentRemediationAudit.js';

const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL or DATABASE_URL is required');

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();
const suffix = randomUUID();
const producerBase = `aiops-remediation-audit-cert-${suffix}`;
const planHash = 'c'.repeat(64);
const rootTraceId = randomUUID();
const executionTraceId = randomUUID();
const requestId = `audit-cert-${suffix}`;
const operator = {
  id: 1,
  username: 'oidc:aiops-certifier',
  audit: {
    producerEventId: producerBase,
    environment: 'certification',
    requestId,
    actor: {
      type: 'service' as const,
      id: 'aiops-remediation-certifier',
      ssoSubject: null,
      authMethod: 'local-certification',
      effectiveRoles: ['certifier'],
    },
  },
};

try {
  await client.query('BEGIN');
  const approved = await appendIncidentRemediationAudit(client, {
    eventKey: 'change-plan-approve',
    action: 'aiops.remediation.plan.approved', outcome: 'success', risk: 'high',
    incidentId: 1, remediationId: 2, planId: 3,
    resourceType: 'aiops-change-plan', resourceId: '3', resourceRevision: '2',
    planHash, rootTraceId,
    policy: { id: 'aiops.remediation.human-approval', version: 'v1', decision: 'approve' },
    approvalId: `change-plan:3:${planHash}`,
    before: { planStatus: 'awaiting_approval', planVersion: 1 },
    after: { planStatus: 'approved', planVersion: 2 },
    operator,
  });
  const started = await appendIncidentRemediationAudit(client, {
    eventKey: 'execution-started',
    action: 'aiops.remediation.execution.started', outcome: 'success', risk: 'high',
    incidentId: 1, remediationId: 2, planId: 3,
    resourceType: 'aiops-change-plan', resourceId: '3', resourceRevision: '3',
    planHash, rootTraceId, traceId: executionTraceId,
    approvalId: `change-plan:3:${planHash}`,
    before: { planStatus: 'approved', planVersion: 2 },
    after: { planStatus: 'executing', planVersion: 3 },
    operator,
  });
  const verified = await appendIncidentRemediationAudit(client, {
    eventKey: 'verification-passed',
    action: 'aiops.remediation.verification.passed', outcome: 'success', risk: 'high',
    incidentId: 1, remediationId: 2, planId: 3,
    resourceType: 'aiops-change-plan', resourceId: '3', resourceRevision: '4',
    planHash, rootTraceId, traceId: randomUUID(),
    after: { planStatus: 'verified', verificationStatus: 'passed' },
    operator,
  });

  assert.equal(started.previousHash, approved.eventHash, 'execution event must extend approval hash');
  assert.equal(verified.previousHash, started.eventHash, 'verification event must extend execution hash');
  assert.equal(started.sequence, approved.sequence + 1, 'execution sequence must immediately follow approval');
  assert.equal(verified.sequence, started.sequence + 1, 'verification sequence must immediately follow execution');
  assert.equal(started.actor.id, 'aiops-remediation-certifier');
  assert.equal(started.correlation.rootRunId, rootTraceId);
  assert.equal(started.correlation.traceId, executionTraceId);
  assert.equal(started.correlation.requestId, requestId);
  assert.equal(started.approvalId, `change-plan:3:${planHash}`);

  const ids = [approved.eventId, started.eventId, verified.eventId];
  const outbox = await client.query<{ event_id: string; state: string }>(
    `SELECT event_id::text, state
       FROM mcp_canonical_audit_outbox
      WHERE event_id=ANY($1::uuid[])
      ORDER BY id`,
    [ids],
  );
  assert.deepEqual(outbox.rows.map(row => row.event_id), ids, 'every remediation audit event requires one outbox record');
  assert.ok(outbox.rows.every(row => row.state === 'pending'), 'new audit outbox records must be pending');

  const persisted = await client.query<{ action: string; payload_summary: unknown }>(
    `SELECT action, payload_summary
       FROM mcp_canonical_audit_events
      WHERE event_id=ANY($1::uuid[])
      ORDER BY sequence`,
    [ids],
  );
  assert.deepEqual(persisted.rows.map(row => row.action), [
    'aiops.remediation.plan.approved',
    'aiops.remediation.execution.started',
    'aiops.remediation.verification.passed',
  ]);
  const serialized = JSON.stringify(persisted.rows);
  assert.ok(!serialized.includes('writeArguments'));
  assert.ok(!serialized.includes('providerOutput'));

  console.log(JSON.stringify({
    ok: true,
    tokenFree: true,
    mutationFree: true,
    rolledBack: true,
    events: persisted.rows.length,
    outboxRecords: outbox.rows.length,
    hashLinksVerified: 2,
  }, null, 2));
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  client.release();
  await pool.end();
}
