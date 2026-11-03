#!/usr/bin/env node
/**
 * Behavioral certification for canonical business-audit events and outbox.
 *
 * This command never falls back to the developer database. Point
 * CANONICAL_AUDIT_CERTIFICATION_DATABASE_URL at an explicitly disposable,
 * fully migrated PostgreSQL database.
 */

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  claimCanonicalAuditOutboxBatch,
  executeCanonicalAuditedMutation,
  markCanonicalAuditDelivered,
  releaseCanonicalAuditDelivery,
} from '../dist/audit/canonicalAuditStore.js';
import { loadAuditEvidencePage } from '../dist/audit/evidenceStore.js';
import {
  createAuditCheckpointSigner,
  createCanonicalAuditCheckpoint,
  loadLatestCanonicalAuditCheckpoint,
  verifyCanonicalAuditCheckpoint,
} from '../dist/audit/checkpoints.js';
import {
  createAuditEvidencePack,
  recordAuditEvidencePackExport,
  verifyAuditEvidencePack,
} from '../dist/audit/evidencePack.js';
import {
  createAuditRetentionPolicy,
  placeAuditLegalHold,
  releaseAuditLegalHold,
} from '../dist/audit/retention.js';
import { runCanonicalAuditIntegrityCycle } from '../dist/audit/integrityMonitor.js';
import {
  changeManagedUserPasswordAudited,
  createFirstUserAudited,
  createManagedUserAudited,
  deleteManagedUserAudited,
  updateManagedUserAudited,
} from '../dist/auth/userLifecycle.js';
import {
  createManagedApiKeyAudited,
  deleteManagedApiKeyAudited,
  rotateManagedApiKeyAudited,
  updateManagedApiKeyAudited,
} from '../dist/auth/apiKeyLifecycle.js';
import { syncSsoIdentityAudited } from '../dist/auth/ssoIdentityLifecycle.js';
import { decideRuntimeApprovalAudited } from '../dist/approvals/runtimeApprovalStore.js';
import { transitionWorkflowApprovalAudited } from '../dist/workflows/workflowApprovalLifecycle.js';
import {
  createToolFilterAudited,
  deleteToolFilterAudited,
  updateToolFilterAudited,
} from '../dist/filters/toolFilters.js';
import {
  addGroupToolRuleAudited,
  addUserToolRuleAudited,
  deleteGroupToolRuleAudited,
  deleteUserToolRuleAudited,
  setGroupAgentAllowAudited,
  setGroupCompositesAudited,
  setUserAgentAllowAudited,
  setUserCompositesAudited,
} from '../dist/auth/userPolicyStore.js';
import { createWorkspaceTagAudited } from '../dist/tags/store.js';

const { Pool } = pg;
const databaseUrl = (process.env.CANONICAL_AUDIT_CERTIFICATION_DATABASE_URL || '').trim();
const required = process.env.CANONICAL_AUDIT_CERTIFICATION_REQUIRED === '1';
const reportPath = process.env.CANONICAL_AUDIT_CERTIFICATION_REPORT
  || 'test-results/canonical-audit-certification.json';
const evidencePackPath = process.env.CANONICAL_AUDIT_EVIDENCE_PACK_REPORT
  || 'test-results/canonical-audit-evidence-pack.json';

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|passphrase|secret|token|authorization|bearer|cookie|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500) || 'unknown error';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function auditInput(suffix, resourceId, action) {
  return {
    environment: 'certification',
    workspaceKey: `workspace-${suffix}`,
    tenantKey: `tenant-${suffix}`,
    solution: 'argus.core',
    actor: {
      type: 'service', id: 'canonical-audit-certifier', authMethod: 'local-certification',
      effectiveRoles: ['certifier'],
    },
    action,
    outcome: 'success',
    risk: 'high',
    resource: { type: 'certification_record', id: resourceId, revision: '1' },
    correlation: { requestId: `request-${resourceId}`, traceId: `trace-${resourceId}` },
    payload: {
      after: { id: resourceId, label: 'certified', apiKey: 'must-never-be-persisted' },
      context: { purpose: 'disposable audit certification' },
    },
  };
}

async function certify(pool) {
  const suffix = randomBytes(6).toString('hex');
  const table = `argus_audit_cert_${suffix}`;
  const scope = {
    environment: 'certification', workspaceKey: `workspace-${suffix}`, tenantKey: `tenant-${suffix}`,
  };
  await pool.query(`CREATE TEMP TABLE ${table} (id TEXT PRIMARY KEY, label TEXT NOT NULL) ON COMMIT PRESERVE ROWS`);

  const firstProducer = { name: 'canonical-audit-certifier', eventId: `first-${suffix}` };
  const first = await executeCanonicalAuditedMutation(
    pool,
    firstProducer,
    scope,
    async client => {
      await client.query(`INSERT INTO ${table} (id,label) VALUES ($1,$2)`, ['record-1', 'first']);
      return { id: 'record-1' };
    },
    result => auditInput(suffix, result.id, 'certification.record_created'),
  );
  assert(!first.replayed && first.result?.id === 'record-1', 'first audited mutation did not commit');

  let replayMutationCalled = false;
  const replay = await executeCanonicalAuditedMutation(
    pool,
    firstProducer,
    scope,
    async () => { replayMutationCalled = true; return { id: 'duplicate' }; },
    result => auditInput(suffix, result.id, 'certification.record_created'),
  );
  assert(replay.replayed && replay.result === null && !replayMutationCalled, 'producer replay repeated the mutation');

  const otherScope = {
    environment: 'certification',
    workspaceKey: `workspace-other-${suffix}`,
    tenantKey: `tenant-other-${suffix}`,
  };
  const crossTenant = await executeCanonicalAuditedMutation(
    pool,
    firstProducer,
    otherScope,
    async client => {
      await client.query(`INSERT INTO ${table} (id,label) VALUES ($1,$2)`, ['record-other', 'other tenant']);
      return { id: 'record-other' };
    },
    result => ({
      ...auditInput(suffix, result.id, 'certification.record_created'),
      ...otherScope,
    }),
  );
  assert(!crossTenant.replayed && crossTenant.result?.id === 'record-other',
    'producer idempotency key leaked across tenant scope');
  assert(crossTenant.event.sequence === 1 && crossTenant.event.previousHash === '',
    'other tenant did not start an independent audit chain');

  const second = await executeCanonicalAuditedMutation(
    pool,
    { name: 'canonical-audit-certifier', eventId: `second-${suffix}` },
    scope,
    async client => {
      await client.query(`INSERT INTO ${table} (id,label) VALUES ($1,$2)`, ['record-2', 'second']);
      return { id: 'record-2' };
    },
    result => auditInput(suffix, result.id, 'certification.record_created'),
  );
  assert(second.event.sequence === first.event.sequence + 1, 'tenant/environment sequence did not advance');
  assert(second.event.previousHash === first.event.eventHash, 'tenant/environment hash chain did not link');

  let backpressureClosed = false;
  try {
    await executeCanonicalAuditedMutation(
      pool,
      { name: 'canonical-audit-certifier', eventId: `blocked-${suffix}` },
      scope,
      async client => {
        await client.query(`INSERT INTO ${table} (id,label) VALUES ($1,$2)`, ['must-rollback', 'blocked']);
        return { id: 'must-rollback' };
      },
      result => auditInput(suffix, result.id, 'certification.record_created'),
      { maxPendingOutbox: 1 },
    );
  } catch (error) {
    backpressureClosed = error?.name === 'Error' && String(error.message).includes('capacity');
  }
  const rolledBack = await pool.query(`SELECT id FROM ${table} WHERE id='must-rollback'`);
  assert(backpressureClosed && rolledBack.rows.length === 0, 'audit backpressure did not roll back the mutation');

  const eventCounts = await pool.query(
    `SELECT count(*)::int AS events,
            count(*) FILTER (WHERE payload_summary::text LIKE '%must-never-be-persisted%')::int AS leaked
       FROM mcp_canonical_audit_events
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment='certification'`,
    [`workspace-${suffix}`, `tenant-${suffix}`],
  );
  assert(eventCounts.rows[0]?.events === 2, 'producer idempotency did not preserve exactly two events');
  assert(eventCounts.rows[0]?.leaked === 0, 'canonical payload leaked a secret');

  let appendOnlyBlocked = false;
  try {
    await pool.query('UPDATE mcp_canonical_audit_events SET action=action WHERE event_id=$1', [first.event.eventId]);
  } catch (error) {
    appendOnlyBlocked = String(error?.message ?? error).includes('append-only');
  }
  assert(appendOnlyBlocked, 'canonical event update was not blocked');

  const bootstrapContext = candidate => ({
    producerEventId: `first-user-${candidate}-${suffix}`,
    environment: 'certification',
    actor: {
      type: 'system', id: 'argus.first-user-bootstrap',
      authMethod: 'unauthenticated-bootstrap', effectiveRoles: [],
    },
    requestId: `first-user-request-${candidate}-${suffix}`,
  });
  const bootstrapInputs = [
    {
      username: `audit-cert-a-${suffix}`,
      password: `First-User-Cert-A-${suffix}-9!`,
      displayName: 'Audit Certifier A',
    },
    {
      username: `audit-cert-b-${suffix}`,
      password: `First-User-Cert-B-${suffix}-9!`,
      displayName: 'Audit Certifier B',
    },
  ];
  const concurrentBootstrapPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000 });
  let bootstrapAttempts;
  try {
    bootstrapAttempts = await Promise.allSettled(bootstrapInputs.map((input, index) =>
      createFirstUserAudited(concurrentBootstrapPool, input, bootstrapContext(index)),
    ));
  } finally {
    await concurrentBootstrapPool.end();
  }
  const successfulBootstrapIndex = bootstrapAttempts.findIndex(result => result.status === 'fulfilled');
  const successfulBootstrap = bootstrapAttempts[successfulBootstrapIndex];
  const rejectedBootstrap = bootstrapAttempts.find(result => result.status === 'rejected');
  assert(bootstrapAttempts.filter(result => result.status === 'fulfilled').length === 1
    && successfulBootstrap?.status === 'fulfilled'
    && rejectedBootstrap?.status === 'rejected'
    && rejectedBootstrap.reason?.code === 'FIRST_USER_EXISTS',
  'concurrent first-user bootstrap did not commit exactly one platform administrator');
  const bootstrap = successfulBootstrap.value;
  const bootstrapReplay = await createFirstUserAudited(
    pool,
    bootstrapInputs[successfulBootstrapIndex],
    bootstrapContext(successfulBootstrapIndex),
  );
  assert(!bootstrap.replayed && bootstrapReplay.replayed
    && bootstrapReplay.value.id === bootstrap.value.id
    && bootstrap.value.role === 'platform_admin',
  'first-user bootstrap producer was not idempotent');
  const user = bootstrap.value;
  const ssoGroupA = `engineering-${suffix}`;
  const ssoGroupB = `operations-${suffix}`;
  const ssoIdentity = {
    username: `oidc:cert:${suffix}`,
    displayName: 'SSO Audit Target',
    groups: [ssoGroupA],
    provider: 'certification',
    mapping: {
      effectiveRole: 'developer',
      matched: [{ group: ssoGroupA, role: 'developer' }],
      usedDefault: false,
    },
  };
  const ssoContext = eventId => ({
    producerEventId: `sso-${eventId}-${suffix}`,
    environment: 'certification',
    requestId: `sso-request-${eventId}-${suffix}`,
  });
  const ssoProvisioned = await syncSsoIdentityAudited(pool, ssoIdentity, ssoContext('provision'));
  const ssoProvisionedReplay = await syncSsoIdentityAudited(pool, {
    ...ssoIdentity,
    displayName: 'Must not replace committed identity',
  }, ssoContext('provision'));
  assert(!ssoProvisioned.replayed && ssoProvisionedReplay.replayed
    && ssoProvisionedReplay.value.id === ssoProvisioned.value.id
    && ssoProvisionedReplay.value.display_name === 'SSO Audit Target',
  'SSO identity provisioning producer was not idempotent');
  const ssoSynchronized = await syncSsoIdentityAudited(pool, {
    ...ssoIdentity,
    groups: [ssoGroupB],
    mapping: {
      effectiveRole: 'operations_admin',
      matched: [{ group: ssoGroupB, role: 'operations_admin' }],
      usedDefault: false,
    },
  }, ssoContext('synchronize'));
  const ssoSynchronizedReplay = await syncSsoIdentityAudited(pool, {
    ...ssoIdentity,
    groups: [],
    mapping: { effectiveRole: 'viewer', matched: [], usedDefault: true },
  }, ssoContext('synchronize'));
  assert(!ssoSynchronized.replayed && ssoSynchronizedReplay.replayed
    && ssoSynchronizedReplay.value.role === 'operations_admin'
    && ssoSynchronizedReplay.value.entra_groups.length === 1
    && ssoSynchronizedReplay.value.entra_groups[0] === ssoGroupB,
  'SSO identity synchronization producer was not idempotent');
  const ssoEvents = [ssoProvisioned.auditEvent, ssoSynchronized.auditEvent];
  const ssoEvidence = await loadAuditEvidencePage(
    pool,
    [{ workspaceKey: 'default', tenantKey: 'default' }],
    {
      limit: 10, cursor: null, actorId: String(ssoProvisioned.value.id), actorType: 'human',
      resourceType: 'user', resourceId: String(ssoProvisioned.value.id), tagId: null,
      action: null, outcome: 'success', risk: 'critical', policyId: 'argus.access.sso-role-mapping',
      rootRunId: null, traceId: null, environment: 'certification', from: null, to: null,
    },
    { canExport: false, now: new Date('2026-09-08T00:00:00.000Z') },
  );
  assert(ssoEvidence.items.length === 2 && ssoEvidence.verification.state === 'event_hashes_valid',
    'SSO identity mapping evidence could not be queried and verified');
  const storedSsoEvidence = await pool.query(
    `SELECT payload_summary::text AS payload FROM mcp_canonical_audit_events
      WHERE event_id=ANY($1::uuid[])`,
    [ssoEvents.map(event => event.eventId)],
  );
  const serializedSsoEvidence = JSON.stringify(storedSsoEvidence.rows);
  assert(!serializedSsoEvidence.includes(ssoGroupA) && !serializedSsoEvidence.includes(ssoGroupB),
    'SSO identity evidence exposed raw group claims');

  const tagContext = {
    producerEventId: `tag-create-${suffix}`,
    environment: 'certification',
    actor: {
      type: 'human', id: String(user.id), authMethod: 'certification', effectiveRoles: ['developer'],
    },
    requestId: `tag-request-${suffix}`,
  };
  const tag = await createWorkspaceTagAudited(pool, {
    slug: `audit-cert-${suffix}`,
    label: `Audit certification ${suffix}`,
    color: '#7c3aed',
    description: 'Disposable canonical audit producer probe',
  }, Number(user.id), tagContext);
  const tagReplay = await createWorkspaceTagAudited(pool, {
    slug: `audit-cert-${suffix}`,
    label: `Audit certification ${suffix}`,
    color: '#7c3aed',
    description: 'Disposable canonical audit producer probe',
  }, Number(user.id), tagContext);
  assert(!tag.replayed && tagReplay.replayed && tagReplay.value.id === tag.value.id,
    'real tag producer was not idempotent');
  const tagEvidence = await pool.query(
    `SELECT event.action, outbox.state
       FROM mcp_canonical_audit_events event
       JOIN mcp_canonical_audit_outbox outbox ON outbox.event_id=event.event_id
      WHERE event.event_id=$1`,
    [tag.auditEvent.eventId],
  );
  assert(tagEvidence.rows[0]?.action === 'tag.created' && tagEvidence.rows[0]?.state === 'pending',
    'real tag mutation did not commit canonical event and outbox evidence');

  const evidencePage = await loadAuditEvidencePage(
    pool,
    [{ workspaceKey: 'default', tenantKey: 'default' }],
    {
      limit: 10, cursor: null, actorId: null, actorType: null,
      resourceType: 'workspace_tag', resourceId: tag.value.id, tagId: null,
      action: 'tag.created', outcome: 'success', risk: null, policyId: null,
      rootRunId: null, traceId: null, environment: 'certification', from: null, to: null,
    },
    { canExport: false, now: new Date('2026-09-08T00:00:00.000Z') },
  );
  assert(evidencePage.items.length === 1 && evidencePage.items[0]?.id === tag.auditEvent.eventId,
    'evidence query did not return the scoped canonical tag event');
  assert(evidencePage.verification.state === 'event_hashes_valid',
    'evidence query could not recompute the canonical event hash');
  const serializedEvidence = JSON.stringify(evidencePage);
  assert(!serializedEvidence.includes('must-never-be-persisted') && !serializedEvidence.includes('payloadSummary'),
    'evidence query exposed canonical payload content');

  const accessContext = eventId => ({
    producerEventId: `${eventId}-${suffix}`,
    environment: 'certification',
    actor: {
      type: 'human', id: String(user.id), authMethod: 'certification', effectiveRoles: ['platform_admin'],
    },
    requestId: `access-request-${eventId}-${suffix}`,
  });
  const accessPassword = `Certification-Only-${suffix}-9!`;
  const managed = await createManagedUserAudited(pool, {
    username: `managed-audit-${suffix}`,
    password: accessPassword,
    displayName: 'Managed Audit Target',
    role: 'viewer',
    allowedBundles: [],
    enabled: true,
  }, accessContext('create'));
  const managedReplay = await createManagedUserAudited(pool, {
    username: `managed-audit-${suffix}`,
    password: accessPassword,
    displayName: 'Managed Audit Target',
    role: 'viewer',
    allowedBundles: [],
    enabled: true,
  }, accessContext('create'));
  assert(!managed.replayed && managedReplay.replayed && managedReplay.value.id === managed.value.id,
    'managed user create producer was not idempotent');

  const updatedManaged = await updateManagedUserAudited(
    pool,
    Number(user.id),
    managed.value.id,
    { role: 'developer', allowed_bundles: [1] },
    accessContext('update'),
  );
  const updatedManagedReplay = await updateManagedUserAudited(
    pool,
    Number(user.id),
    managed.value.id,
    { role: 'developer', allowed_bundles: [1] },
    accessContext('update'),
  );
  assert(!updatedManaged.replayed && updatedManagedReplay.replayed
    && updatedManagedReplay.value.role === 'developer', 'managed user update producer was not idempotent');

  const passwordChanged = await changeManagedUserPasswordAudited(
    pool, managed.value.id, `${accessPassword}-rotated`, accessContext('password'),
  );
  const passwordReplay = await changeManagedUserPasswordAudited(
    pool, managed.value.id, `${accessPassword}-rotated`, accessContext('password'),
  );
  assert(!passwordChanged.replayed && passwordReplay.replayed,
    'managed user password producer was not idempotent');

  const deletedManaged = await deleteManagedUserAudited(
    pool, Number(user.id), managed.value.id, accessContext('delete'),
  );
  const deletedManagedReplay = await deleteManagedUserAudited(
    pool, Number(user.id), managed.value.id, accessContext('delete'),
  );
  assert(!deletedManaged.replayed && deletedManagedReplay.replayed,
    'managed user delete producer was not idempotent');
  const managedRows = await pool.query('SELECT id FROM mcp_users WHERE id=$1', [managed.value.id]);
  assert(managedRows.rows.length === 0, 'managed user delete did not commit');

  const accessEvents = [
    managed.auditEvent,
    updatedManaged.auditEvent,
    passwordChanged.auditEvent,
    deletedManaged.auditEvent,
  ];
  const accessEvidence = await loadAuditEvidencePage(
    pool,
    [{ workspaceKey: 'default', tenantKey: 'default' }],
    {
      limit: 10, cursor: null, actorId: String(user.id), actorType: 'human',
      resourceType: 'user', resourceId: String(managed.value.id), tagId: null,
      action: null, outcome: 'success', risk: null, policyId: 'argus.access.user-lifecycle',
      rootRunId: null, traceId: null, environment: 'certification', from: null, to: null,
    },
    { canExport: false, now: new Date('2026-09-08T00:00:00.000Z') },
  );
  assert(accessEvidence.items.length === 4 && accessEvidence.verification.state === 'event_hashes_valid',
    'access lifecycle evidence could not be queried and verified');
  const serializedAccessEvidence = JSON.stringify(accessEvidence);
  assert(!serializedAccessEvidence.includes(accessPassword) && !serializedAccessEvidence.includes('payloadSummary'),
    'access lifecycle evidence exposed password or canonical payload content');

  const apiKeyContext = eventId => ({
    producerEventId: `${eventId}-${suffix}`,
    environment: 'certification',
    actor: {
      type: 'human', id: String(user.id), authMethod: 'certification', effectiveRoles: ['platform_admin'],
    },
    requestId: `api-key-request-${eventId}-${suffix}`,
  });
  const createPlaintext = `ak_c${suffix}${randomBytes(24).toString('hex')}`;
  const createdApiKey = await createManagedApiKeyAudited(pool, {
    label: `Canonical API key ${suffix}`,
    allowedBundles: [],
    allowedTools: ['github_*'],
    deniedTools: ['github_delete_*'],
    maxRequestsPerMinute: 30,
    scope: 'mcp',
    enabled: true,
    actingAsUserId: Number(user.id),
  }, apiKeyContext('create'), () => createPlaintext);
  const createdApiKeyReplay = await createManagedApiKeyAudited(pool, {
    label: `Canonical API key ${suffix}`,
    scope: 'mcp',
  }, apiKeyContext('create'), () => 'must-not-be-issued');
  assert(!createdApiKey.replayed && createdApiKey.apiKey === createPlaintext && createdApiKey.value,
    'API key create did not return its one-time plaintext');
  assert(createdApiKeyReplay.replayed && createdApiKeyReplay.apiKey === null && createdApiKeyReplay.value === null,
    'API key create replay exposed or minted another plaintext');

  const apiKeyId = Number(createdApiKey.value.id);
  const updatedApiKey = await updateManagedApiKeyAudited(pool, apiKeyId, {
    label: `Canonical API key updated ${suffix}`,
    allowedBundles: [1],
    allowedTools: ['github_read_*'],
    deniedTools: ['github_write_*'],
    maxRequestsPerMinute: 15,
    scope: 'both',
    enabled: true,
    expiresAt: null,
  }, apiKeyContext('update'));
  const updatedApiKeyReplay = await updateManagedApiKeyAudited(pool, apiKeyId, {
    label: 'must not replace committed metadata', scope: 'agents', enabled: false,
  }, apiKeyContext('update'));
  assert(!updatedApiKey.replayed && updatedApiKeyReplay.replayed
    && updatedApiKeyReplay.value?.label === `Canonical API key updated ${suffix}`,
  'API key update producer was not idempotent');

  const rotatePlaintext = `ak_r${suffix}${randomBytes(24).toString('hex')}`;
  const rotatedApiKey = await rotateManagedApiKeyAudited(
    pool, apiKeyId, apiKeyContext('rotate'), () => rotatePlaintext,
  );
  const rotatedApiKeyReplay = await rotateManagedApiKeyAudited(
    pool, apiKeyId, apiKeyContext('rotate'), () => 'must-not-be-issued',
  );
  assert(!rotatedApiKey.replayed && rotatedApiKey.apiKey === rotatePlaintext,
    'API key rotation did not return its one-time plaintext');
  assert(rotatedApiKeyReplay.replayed && rotatedApiKeyReplay.apiKey === null && rotatedApiKeyReplay.value === null,
    'API key rotation replay exposed or minted another plaintext');

  const deletedApiKey = await deleteManagedApiKeyAudited(pool, apiKeyId, apiKeyContext('delete'));
  const deletedApiKeyReplay = await deleteManagedApiKeyAudited(pool, apiKeyId, apiKeyContext('delete'));
  assert(!deletedApiKey.replayed && deletedApiKeyReplay.replayed,
    'API key delete producer was not idempotent');
  const apiKeyRows = await pool.query('SELECT id FROM mcp_api_keys WHERE id=$1', [apiKeyId]);
  assert(apiKeyRows.rows.length === 0, 'API key delete did not commit');

  const apiKeyEvents = [
    createdApiKey.auditEvent,
    updatedApiKey.auditEvent,
    rotatedApiKey.auditEvent,
    deletedApiKey.auditEvent,
  ];
  const apiKeyEvidence = await loadAuditEvidencePage(
    pool,
    [{ workspaceKey: 'default', tenantKey: 'default' }],
    {
      limit: 10, cursor: null, actorId: String(user.id), actorType: 'human',
      resourceType: 'api_key', resourceId: String(apiKeyId), tagId: null,
      action: null, outcome: 'success', risk: 'critical', policyId: 'argus.access.api-key-lifecycle',
      rootRunId: null, traceId: null, environment: 'certification', from: null, to: null,
    },
    { canExport: false, now: new Date('2026-09-08T00:00:00.000Z') },
  );
  assert(apiKeyEvidence.items.length === 4 && apiKeyEvidence.verification.state === 'event_hashes_valid',
    'API key lifecycle evidence could not be queried and verified');
  const storedApiKeyEvents = await pool.query(
    `SELECT payload_summary::text AS payload FROM mcp_canonical_audit_events
      WHERE event_id=ANY($1::uuid[])`,
    [apiKeyEvents.map(event => event.eventId)],
  );
  const serializedApiKeyEvidence = JSON.stringify(storedApiKeyEvents.rows);
  assert(!serializedApiKeyEvidence.includes(createPlaintext)
    && !serializedApiKeyEvidence.includes(rotatePlaintext)
    && !serializedApiKeyEvidence.includes('must-not-be-issued'),
  'API key lifecycle evidence exposed one-time plaintext');

  const policyUser = (await pool.query(
    `INSERT INTO mcp_users (username, password_hash, display_name, role)
     VALUES ($1,'certification-not-a-login','Policy Audit Target','viewer') RETURNING id`,
    [`policy-audit-${suffix}`],
  )).rows[0];
  const composite = (await pool.query(
    `INSERT INTO mcp_composites (name, description)
     VALUES ($1,'Disposable policy certification composite') RETURNING id`,
    [`policy-cert-${suffix}`],
  )).rows[0];
  const agent = (await pool.query(
    `INSERT INTO mcp_agents (name, label, model, created_by)
     VALUES ($1,'Policy certification agent','certification-model',$2) RETURNING id`,
    [`policy-cert-${suffix}`, Number(user.id)],
  )).rows[0];
  const policyContext = eventId => ({
    producerEventId: `${eventId}-${suffix}`,
    environment: 'certification',
    actor: {
      type: 'human', id: String(user.id), authMethod: 'certification', effectiveRoles: ['platform_admin'],
    },
    requestId: `policy-request-${eventId}-${suffix}`,
  });
  const userComposites = await setUserCompositesAudited(
    pool, Number(policyUser.id), [Number(composite.id), Number(composite.id)], Number(user.id),
    policyContext('user-composites'),
  );
  const userCompositesReplay = await setUserCompositesAudited(
    pool, Number(policyUser.id), [Number(composite.id)], Number(user.id),
    policyContext('user-composites'),
  );
  assert(!userComposites.replayed && userCompositesReplay.replayed
    && userCompositesReplay.value.length === 1,
  'user composite policy replacement was not idempotent');

  const userRule = await addUserToolRuleAudited(
    pool, Number(policyUser.id), {
      tool_pattern: 'github_*', effect: 'allow', reason: 'Disposable policy certification',
    }, Number(user.id), policyContext('user-rule-create'),
  );
  const groupName = `policy-group-${suffix}`;
  const groupComposites = await setGroupCompositesAudited(
    pool, groupName, [Number(composite.id)], policyContext('group-composites'),
  );
  const groupRule = await addGroupToolRuleAudited(
    pool, groupName, {
      tool_pattern: 'slack_*', effect: 'deny', reason: 'Disposable policy certification',
    }, policyContext('group-rule-create'),
  );
  const userAgents = await setUserAgentAllowAudited(
    pool, Number(policyUser.id), [Number(agent.id)], `admin:${user.id}`, policyContext('user-agent-allow'),
  );
  const groupAgents = await setGroupAgentAllowAudited(
    pool, groupName, [Number(agent.id)], policyContext('group-agent-allow'),
  );
  const deletedUserRule = await deleteUserToolRuleAudited(
    pool, userRule.value, policyContext('user-rule-delete'),
  );
  const deletedGroupRule = await deleteGroupToolRuleAudited(
    pool, groupRule.value, policyContext('group-rule-delete'),
  );
  const deletedGroupRuleReplay = await deleteGroupToolRuleAudited(
    pool, groupRule.value, policyContext('group-rule-delete'),
  );
  assert(!deletedGroupRule.replayed && deletedGroupRuleReplay.replayed,
    'group rule delete replay repeated the mutation');
  assert(userAgents.value.length === 1 && groupAgents.value.length === 1
    && deletedUserRule.value && groupComposites.value.length === 1,
  'policy assignment mutations did not return their committed state');

  const policyEvents = [
    userComposites.auditEvent,
    userRule.auditEvent,
    groupComposites.auditEvent,
    groupRule.auditEvent,
    userAgents.auditEvent,
    groupAgents.auditEvent,
    deletedUserRule.auditEvent,
    deletedGroupRule.auditEvent,
  ];
  const policyEvidence = await loadAuditEvidencePage(
    pool,
    [{ workspaceKey: 'default', tenantKey: 'default' }],
    {
      limit: 20, cursor: null, actorId: String(user.id), actorType: 'human',
      resourceType: null, resourceId: null, tagId: null, action: null, outcome: 'success',
      risk: 'critical', policyId: 'argus.access.policy-management', rootRunId: null,
      traceId: null, environment: 'certification', from: null, to: null,
    },
    { canExport: false, now: new Date('2026-09-08T00:00:00.000Z') },
  );
  assert(policyEvidence.items.length === 8 && policyEvidence.verification.state === 'event_hashes_valid',
    'access policy management evidence could not be queried and verified');

  const approvalWorkflow = (await pool.query(
    `INSERT INTO mcp_workflows (name, description, created_by, human_oversight_required)
     VALUES ($1,'Disposable approval certification workflow',$2,true)
     RETURNING id`,
    [`approval_cert_${suffix}`, Number(user.id)],
  )).rows[0];
  await pool.query(
    `INSERT INTO mcp_workflow_versions
       (workflow_id, version, steps, saved_by)
     VALUES ($1,1,'[]'::jsonb,$2)`,
    [Number(approvalWorkflow.id), user.username],
  );
  const workflowApprovalContext = (eventId, actorUser) => ({
    producerEventId: `workflow-approval-${eventId}-${suffix}`,
    environment: 'certification',
    actor: {
      type: 'human', id: String(actorUser.id), authMethod: 'certification',
      effectiveRoles: [actorUser.role],
    },
    requestId: `workflow-approval-request-${eventId}-${suffix}`,
  });
  const workflowApprovalComment = `workflow-comment-${suffix}-must-not-be-canonical`;
  const workflowSubmitted = await transitionWorkflowApprovalAudited(
    pool, Number(approvalWorkflow.id), 'submitted',
    { username: user.username, role: user.role }, workflowApprovalComment, false,
    workflowApprovalContext('submit', user),
  );
  const workflowSubmittedReplay = await transitionWorkflowApprovalAudited(
    pool, Number(approvalWorkflow.id), 'submitted',
    { username: user.username, role: user.role }, 'must-not-replace-committed-comment', false,
    workflowApprovalContext('submit', user),
  );
  const workflowApproved = await transitionWorkflowApprovalAudited(
    pool, Number(approvalWorkflow.id), 'approved',
    { username: ssoSynchronized.value.username, role: ssoSynchronized.value.role }, null, false,
    workflowApprovalContext('approve', ssoSynchronized.value),
  );
  assert(!workflowSubmitted.replayed && workflowSubmittedReplay.replayed
    && !workflowApproved.replayed && workflowApproved.status === 'production',
  'workflow approval transitions were not atomic and idempotent');
  const workflowApprovalState = await pool.query(
    `SELECT lifecycle_status,
            (SELECT count(*)::int FROM mcp_workflow_approvals WHERE workflow_id=$1) AS approval_count
       FROM mcp_workflows WHERE id=$1`,
    [Number(approvalWorkflow.id)],
  );
  assert(workflowApprovalState.rows[0]?.lifecycle_status === 'production'
    && workflowApprovalState.rows[0]?.approval_count === 2,
  'workflow approval replay changed lifecycle or appended a duplicate legacy decision');

  const runtimeArgsSecret = `runtime-args-${suffix}-must-not-be-canonical`;
  const runtimeReasonSecret = `runtime-reason-${suffix}-must-not-be-canonical`;
  const runtimeCommentSecret = `runtime-comment-${suffix}-must-not-be-canonical`;
  const runtimeApproval = (await pool.query(
    `INSERT INTO mcp_runtime_approvals
       (request_key, grant_key, subject_type, workflow_id, session_id,
        tool_name, tool_args, tool_args_hash, risk_level, risk_score,
        risk_factors, risk_model, reason, requested_by_user_id)
     VALUES ($1,$2,'workflow',$3,$4,'github_create_issue',$5::jsonb,$6,
             'high',75,$7::jsonb,'argus-risk-v1',$8,$9)
     RETURNING id`,
    [
      `runtime-request-${suffix}`, `runtime-grant-${suffix}`, Number(approvalWorkflow.id),
      `certification-session-${suffix}`, JSON.stringify({ title: runtimeArgsSecret }),
      randomBytes(32).toString('hex'),
      JSON.stringify([{ id: 'write-action', label: 'Write action', category: 'action', weight: 15, evidence: 'write' }]),
      runtimeReasonSecret, Number(user.id),
    ],
  )).rows[0];
  const runtimeDecisionContext = {
    producerEventId: `runtime-approval-decision-${suffix}`,
    environment: 'certification',
    actor: {
      type: 'human', id: String(ssoSynchronized.value.id), authMethod: 'certification',
      effectiveRoles: [ssoSynchronized.value.role],
    },
    requestId: `runtime-approval-request-${suffix}`,
  };
  const runtimeDecision = await decideRuntimeApprovalAudited(
    pool, Number(runtimeApproval.id), 'approve',
    { id: Number(ssoSynchronized.value.id), username: ssoSynchronized.value.username },
    runtimeCommentSecret, false, runtimeDecisionContext,
  );
  const runtimeDecisionReplay = await decideRuntimeApprovalAudited(
    pool, Number(runtimeApproval.id), 'approve',
    { id: Number(ssoSynchronized.value.id), username: ssoSynchronized.value.username },
    'must-not-replace-runtime-comment', false, runtimeDecisionContext,
  );
  assert(!runtimeDecision.replayed && runtimeDecisionReplay.replayed
    && runtimeDecision.decision === 'approved' && runtimeDecisionReplay.decision === 'approved',
  'runtime approval decision producer was not idempotent');

  const filterSecret = `filter-secret-${suffix}-must-not-be-canonical`;
  const filterUrlSecret = `filter-url-${suffix}-must-not-be-canonical`;
  const riskPolicyContext = eventId => ({
    producerEventId: `runtime-policy-${eventId}-${suffix}`,
    environment: 'certification',
    actor: {
      type: 'human', id: String(user.id), authMethod: 'certification', effectiveRoles: ['platform_admin'],
    },
    requestId: `runtime-policy-request-${eventId}-${suffix}`,
  });
  const riskPolicy = await createToolFilterAudited(pool, {
    name: `audit_filter_${suffix}`,
    description: `Private runtime policy description ${suffix}`,
    webhook_url: `https://policy.example.test/decide?token=${filterUrlSecret}`,
    hmac_secret: filterSecret,
    timeout_ms: 2500,
    tool_patterns: ['github_*'],
    enabled: true,
    on_timeout: 'deny',
  }, riskPolicyContext('create'));
  const riskPolicyUpdated = await updateToolFilterAudited(
    pool, riskPolicy.value.id, { enabled: false }, riskPolicyContext('update'),
  );
  const riskPolicyUpdatedReplay = await updateToolFilterAudited(
    pool, riskPolicy.value.id, { enabled: true }, riskPolicyContext('update'),
  );
  const riskPolicyDeleted = await deleteToolFilterAudited(
    pool, riskPolicy.value.id, riskPolicyContext('delete'),
  );
  const riskPolicyDeletedReplay = await deleteToolFilterAudited(
    pool, riskPolicy.value.id, riskPolicyContext('delete'),
  );
  assert(!riskPolicy.replayed && !riskPolicyUpdated.replayed && riskPolicyUpdatedReplay.replayed
    && riskPolicyUpdatedReplay.value.enabled === false
    && !riskPolicyDeleted.replayed && riskPolicyDeletedReplay.replayed,
  'external runtime risk policy lifecycle was not idempotent');

  const approvalAndRiskEvents = [
    workflowSubmitted.auditEvent,
    workflowApproved.auditEvent,
    runtimeDecision.auditEvent,
    riskPolicy.auditEvent,
    riskPolicyUpdated.auditEvent,
    riskPolicyDeleted.auditEvent,
  ];
  const storedApprovalAndRiskEvidence = await pool.query(
    `SELECT action, payload_summary::text AS payload
       FROM mcp_canonical_audit_events
      WHERE event_id=ANY($1::uuid[])`,
    [approvalAndRiskEvents.map(event => event.eventId)],
  );
  const serializedApprovalAndRiskEvidence = JSON.stringify(storedApprovalAndRiskEvidence.rows);
  for (const excluded of [
    workflowApprovalComment, 'must-not-replace-committed-comment', runtimeArgsSecret,
    runtimeReasonSecret, runtimeCommentSecret, 'must-not-replace-runtime-comment',
    filterSecret, filterUrlSecret, `Private runtime policy description ${suffix}`,
  ]) {
    assert(!serializedApprovalAndRiskEvidence.includes(excluded),
      `approval/risk evidence exposed excluded value: ${excluded}`);
  }
  assert(storedApprovalAndRiskEvidence.rows.length === approvalAndRiskEvents.length,
    'approval/risk producer did not persist every canonical event');

  const auditGovernanceActor = {
    type: 'human', id: String(user.id), authMethod: 'certification', effectiveRoles: ['platform_admin'],
  };
  const retention = await createAuditRetentionPolicy(pool, {
    scope: { environment: 'certification', workspaceKey: 'default', tenantKey: 'default' },
    actor: auditGovernanceActor,
    producerEventId: `retention-policy-${suffix}`,
  }, {
    retentionClass: 'business-audit-standard', durationDays: 2555, region: 'eu',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  const legalJustification = `legal-case-${suffix}-must-not-be-canonical`;
  const legalHold = await placeAuditLegalHold(pool, {
    scope: { environment: 'certification', workspaceKey: 'default', tenantKey: 'default' },
    actor: auditGovernanceActor,
    producerEventId: `legal-hold-place-${suffix}`,
  }, {
    fromSequence: tag.auditEvent.sequence,
    throughSequence: tag.auditEvent.sequence,
    resourceType: 'workspace_tag',
    resourceId: tag.value.id,
    justification: legalJustification,
  });
  const heldEvidence = await loadAuditEvidencePage(
    pool,
    [{ workspaceKey: 'default', tenantKey: 'default' }],
    {
      limit: 10, cursor: null, actorId: null, actorType: null,
      resourceType: 'workspace_tag', resourceId: tag.value.id, tagId: null,
      action: 'tag.created', outcome: 'success', risk: null, policyId: null,
      rootRunId: null, traceId: null, environment: 'certification', from: null, to: null,
    },
    { canExport: true },
  );
  assert(heldEvidence.items[0]?.retention.legalHold === true
    && heldEvidence.items[0]?.retention.until != null,
  'retention policy and active legal-hold overlay were not applied to evidence');
  const legalRelease = await releaseAuditLegalHold(pool, {
    scope: { environment: 'certification', workspaceKey: 'default', tenantKey: 'default' },
    actor: auditGovernanceActor,
    producerEventId: `legal-hold-release-${suffix}`,
  }, {
    holdId: legalHold.hold.holdId,
    justification: `release-${legalJustification}`,
  });
  const releasedEvidence = await loadAuditEvidencePage(
    pool,
    [{ workspaceKey: 'default', tenantKey: 'default' }],
    {
      limit: 10, cursor: null, actorId: null, actorType: null,
      resourceType: 'workspace_tag', resourceId: tag.value.id, tagId: null,
      action: 'tag.created', outcome: 'success', risk: null, policyId: null,
      rootRunId: null, traceId: null, environment: 'certification', from: null, to: null,
    },
    { canExport: true },
  );
  assert(releasedEvidence.items[0]?.retention.legalHold === false,
    'released legal hold still changed effective evidence state');

  const { privateKey } = generateKeyPairSync('ed25519');
  const signingPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const checkpointSigner = createAuditCheckpointSigner(`certification-key-${suffix}`, signingPem);
  const checkpoint = await createCanonicalAuditCheckpoint(
    pool,
    { environment: 'certification', workspaceKey: 'default', tenantKey: 'default' },
    checkpointSigner,
  );
  const checkpointReplay = await createCanonicalAuditCheckpoint(
    pool,
    { environment: 'certification', workspaceKey: 'default', tenantKey: 'default' },
    checkpointSigner,
  );
  assert(!checkpoint.replayed && checkpointReplay.replayed
    && checkpointReplay.checkpointId === checkpoint.checkpointId,
  'signed checkpoint was not idempotent at the same chain head');
  const checkpointVerification = await verifyCanonicalAuditCheckpoint(pool, checkpoint.checkpointId);
  assert(checkpointVerification.state === 'valid', 'signed checkpoint did not verify against the full event chain');
  let checkpointUpdateBlocked = false;
  try {
    await pool.query('UPDATE mcp_canonical_audit_checkpoints SET signature=signature WHERE checkpoint_id=$1', [checkpoint.checkpointId]);
  } catch (error) {
    checkpointUpdateBlocked = String(error?.message ?? error).includes('append-only');
  }
  assert(checkpointUpdateBlocked, 'signed checkpoint update was not blocked');

  const evidencePack = await createAuditEvidencePack(pool, {
    workspaceKey: 'default', tenantKey: 'default', environment: 'certification',
    resourceType: 'workspace_tag', resourceId: tag.value.id,
    generatedBy: { actorId: String(user.id), authMethod: 'certification' },
  });
  const packVerification = verifyAuditEvidencePack(evidencePack);
  assert(packVerification.state === 'valid' && evidencePack.events.length === 1,
    'offline evidence pack did not verify or did not preserve its selected event');
  await mkdir(resolve(evidencePackPath, '..'), { recursive: true });
  await writeFile(resolve(evidencePackPath), `${JSON.stringify(evidencePack, null, 2)}\n`, 'utf8');
  const evidenceExport = await recordAuditEvidencePackExport(
    pool, evidencePack, auditGovernanceActor, `evidence-pack-export-${suffix}`,
  );
  assert(!evidenceExport.replayed, 'evidence-pack export audit event was unexpectedly replayed');
  const { privateKey: rotatedPrivateKey } = generateKeyPairSync('ed25519');
  const rotatedSigningPem = rotatedPrivateKey.export({ type: 'pkcs8', format: 'pem' });
  const rotatedCheckpointSigner = createAuditCheckpointSigner(`certification-key-rotated-${suffix}`, rotatedSigningPem);
  const integrityCycle = await runCanonicalAuditIntegrityCycle(pool, {
    signer: rotatedCheckpointSigner, outboxLagAlertSec: 86_400,
  });
  const certifiedScope = integrityCycle.scopes.find(result => result.scope.environment === 'certification'
    && result.scope.workspaceKey === 'default' && result.scope.tenantKey === 'default');
  assert(certifiedScope?.state === 'valid' && certifiedScope.checkpointSequence > checkpoint.lastSequence,
    'scheduled integrity cycle did not checkpoint and verify the advanced chain');
  const rotatedCheckpoint = await loadLatestCanonicalAuditCheckpoint(
    pool, { environment: 'certification', workspaceKey: 'default', tenantKey: 'default' },
  );
  const historicalVerification = await verifyCanonicalAuditCheckpoint(pool, checkpoint.checkpointId);
  const rotatedVerification = rotatedCheckpoint
    ? await verifyCanonicalAuditCheckpoint(pool, rotatedCheckpoint.checkpointId)
    : null;
  assert(rotatedCheckpoint?.keyId === rotatedCheckpointSigner.keyId
    && historicalVerification.state === 'valid' && rotatedVerification?.state === 'valid',
  'signing-key rotation did not preserve historical checkpoint verification');
  const storedAuditGovernance = await pool.query(
    `SELECT payload_summary::text AS payload FROM mcp_canonical_audit_events
      WHERE event_id=ANY($1::uuid[])`,
    [[retention.auditEvent.eventId, legalHold.auditEvent.eventId, legalRelease.auditEvent.eventId, evidenceExport.eventId]],
  );
  assert(!JSON.stringify(storedAuditGovernance.rows).includes(legalJustification)
    && !JSON.stringify(storedAuditGovernance.rows).includes(String(signingPem))
    && !JSON.stringify(storedAuditGovernance.rows).includes(String(rotatedSigningPem)),
  'audit governance evidence leaked legal justification or private signing key material');

  const deliveries = await claimCanonicalAuditOutboxBatch(pool, {
    workerId: `certifier-${suffix}`, limit: 100, leaseSeconds: 30,
  });
  const expectedEventIds = [
    first.event.eventId,
    second.event.eventId,
    crossTenant.event.eventId,
    tag.auditEvent.eventId,
    bootstrap.auditEvent.eventId,
    ...ssoEvents.map(event => event.eventId),
    ...accessEvents.map(event => event.eventId),
    ...apiKeyEvents.map(event => event.eventId),
    ...policyEvents.map(event => event.eventId),
    ...approvalAndRiskEvents.map(event => event.eventId),
    retention.auditEvent.eventId,
    legalHold.auditEvent.eventId,
    legalRelease.auditEvent.eventId,
    evidenceExport.eventId,
  ];
  const ours = deliveries.filter(delivery => expectedEventIds.includes(delivery.eventId));
  assert(ours.length === expectedEventIds.length, 'durable outbox did not expose all canonical events');
  await releaseCanonicalAuditDelivery(
    pool, ours[0].id, `certifier-${suffix}`, new Error('authorization=do-not-store-this'),
  );
  assert(await markCanonicalAuditDelivered(pool, ours[1].id, `certifier-${suffix}`), 'delivery acknowledgement failed');
  assert(await markCanonicalAuditDelivered(pool, ours[1].id, `certifier-${suffix}`), 'delivery acknowledgement was not idempotent');
  for (const delivery of ours.slice(2)) {
    assert(await markCanonicalAuditDelivered(pool, delivery.id, `certifier-${suffix}`),
      `delivery acknowledgement failed for ${delivery.eventId}`);
  }

  const outbox = await pool.query(
    `SELECT state, last_error FROM mcp_canonical_audit_outbox
      WHERE event_id=ANY($1::uuid[]) ORDER BY event_id`,
    [expectedEventIds],
  );
  assert(outbox.rows.some(row => row.state === 'pending'), 'failed delivery was dropped instead of queued');
  assert(outbox.rows.some(row => row.state === 'delivered'), 'successful delivery was not recorded');
  assert(outbox.rows.every(row => !String(row.last_error ?? '').includes('do-not-store-this')), 'outbox error leaked a secret');

  return {
    atomic_commit_and_rollback: true,
    producer_idempotency: true,
    tenant_scoped_idempotency: true,
    partition_sequence_and_hash_link: true,
    payload_redaction: true,
    append_only_guard: true,
    retry_without_drop: true,
    idempotent_delivery_ack: true,
    real_tag_producer: true,
    real_access_first_user_bootstrap: true,
    real_access_sso_identity_sync: true,
    real_access_user_lifecycle: true,
    real_access_api_key_lifecycle: true,
    real_access_policy_management: true,
    real_workflow_approval_lifecycle: true,
    real_runtime_approval_decision: true,
    real_external_runtime_risk_policy: true,
    signed_checkpoints_and_key_history: true,
    retention_and_legal_hold_overlay: true,
    offline_evidence_pack: true,
    scheduled_integrity_monitor: true,
    evidence_query: true,
    event_ids: [first.event.eventId, second.event.eventId],
  };
}

async function main() {
  const report = {
    generated_at: new Date().toISOString(),
    status: 'not_run',
    database: 'disposable database not configured',
  };
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
    try {
      const tableCheck = await pool.query("SELECT to_regclass('mcp_canonical_audit_events')::text AS name");
      assert(tableCheck.rows[0]?.name, 'migration 220 is not applied');
      report.database = await certify(pool);
      report.status = 'passed';
    } catch (error) {
      report.status = 'failed';
      report.database = safeError(error);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'failed' || (required && report.status !== 'passed')) process.exitCode = 2;
}

try { await main(); } catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
