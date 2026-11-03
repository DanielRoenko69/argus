import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  canonicalAuditDigest,
  redactCanonicalAuditPayload,
  stableAuditJson,
  CANONICAL_AUDIT_REDACTION_PROFILE,
  type AuditJsonValue,
} from './canonicalAuditRedaction.js';
import type {
  CanonicalAuditEventInput,
  CanonicalAuditEventSummary,
  CanonicalAuditMutationResult,
  CanonicalAuditOutboxDelivery,
  CanonicalAuditProducer,
  CanonicalAuditScope,
} from './canonicalAuditTypes.js';

const DEFAULT_WORKSPACE_KEY = 'default';
const DEFAULT_TENANT_KEY = 'default';
const DEFAULT_RETENTION_CLASS = 'business-audit-standard';
const DEFAULT_OUTBOX_TOPIC = 'audit.canonical.v1';
const DEFAULT_MAX_PENDING_OUTBOX = 100_000;
const MAX_PAYLOAD_SUMMARY_BYTES = 32 * 1024;
const MAX_EFFECTIVE_ROLES = 64;
const MAX_OUTBOX_ERROR_LENGTH = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CanonicalAuditEventRow = {
  event_id: string;
  schema_version: number | string;
  sequence: number | string;
  occurred_at: string | Date;
  received_at: string | Date;
  environment: string;
  workspace_key: string;
  tenant_key: string;
  solution: string | null;
  producer_name: string;
  producer_event_id: string;
  actor_type: 'human' | 'service' | 'system';
  actor_id: string;
  actor_sso_subject: string | null;
  actor_auth_method: string;
  actor_roles: string[];
  action: string;
  outcome: 'success' | 'failure' | 'denied' | 'cancelled';
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  resource_type: string;
  resource_id: string;
  resource_revision: string | null;
  policy_id: string | null;
  policy_version: string | null;
  policy_decision: string | null;
  approval_id: string | null;
  root_run_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  request_id: string | null;
  payload_summary: Record<string, unknown> | string;
  payload_digest: string;
  before_digest: string | null;
  after_digest: string | null;
  redaction_profile: string;
  retention_class: string;
  retention_until: string | Date | null;
  legal_hold: boolean;
  previous_hash: string;
  event_hash: string;
  signing_key_id: string | null;
};

type NormalizedCanonicalAuditEvent = {
  eventId: string;
  occurredAt: string;
  receivedAt: string;
  environment: string;
  workspaceKey: string;
  tenantKey: string;
  solution: string | null;
  producerName: string;
  producerEventId: string;
  actorType: 'human' | 'service' | 'system';
  actorId: string;
  actorSsoSubject: string | null;
  actorAuthMethod: string;
  actorRoles: string[];
  action: string;
  outcome: 'success' | 'failure' | 'denied' | 'cancelled';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  resourceType: string;
  resourceId: string;
  resourceRevision: string | null;
  policyId: string | null;
  policyVersion: string | null;
  policyDecision: string | null;
  approvalId: string | null;
  rootRunId: string | null;
  traceId: string | null;
  spanId: string | null;
  requestId: string | null;
  payloadSummary: Record<string, AuditJsonValue>;
  payloadDigest: string;
  beforeDigest: string | null;
  afterDigest: string | null;
  retentionClass: string;
  retentionUntil: string | null;
  legalHold: boolean;
  signingKeyId: string | null;
};

export interface CanonicalAuditWriteOptions {
  eventId?: () => string;
  now?: () => Date;
  outboxTopic?: string;
  maxPendingOutbox?: number;
}

export interface CanonicalAuditClaimOptions {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
}

export class CanonicalAuditValidationError extends Error {}
export class CanonicalAuditBackpressureError extends Error {}

function requiredString(value: unknown, label: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new CanonicalAuditValidationError(`${label} is required`);
  if (normalized.length > max) throw new CanonicalAuditValidationError(`${label} exceeds ${max} characters`);
  return normalized;
}

function optionalString(value: unknown, label: string, max: number): string | null {
  if (value == null || value === '') return null;
  return requiredString(value, label, max);
}

function isoDate(value: string | Date | undefined, label: string, fallback?: Date): string {
  const date = value == null ? fallback : new Date(value);
  if (!date || !Number.isFinite(date.getTime())) throw new CanonicalAuditValidationError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function normalizedRoles(values: string[]): string[] {
  if (!Array.isArray(values)) throw new CanonicalAuditValidationError('actor.effectiveRoles must be an array');
  const roles = [...new Set(values.map(value => requiredString(value, 'actor role', 128)))].sort();
  if (roles.length > MAX_EFFECTIVE_ROLES) {
    throw new CanonicalAuditValidationError(`actor.effectiveRoles exceeds ${MAX_EFFECTIVE_ROLES} roles`);
  }
  return roles;
}

function boundedPayloadSummary(payload: CanonicalAuditEventInput['payload']): {
  summary: Record<string, AuditJsonValue>;
  digest: string;
  beforeDigest: string | null;
  afterDigest: string | null;
} {
  const before = payload?.before === undefined ? undefined : redactCanonicalAuditPayload(payload.before);
  const after = payload?.after === undefined ? undefined : redactCanonicalAuditPayload(payload.after);
  const context = payload?.context === undefined ? undefined : redactCanonicalAuditPayload(payload.context);
  const full: Record<string, AuditJsonValue> = {};
  if (before !== undefined) full.before = before;
  if (after !== undefined) full.after = after;
  if (context !== undefined) full.context = context;
  const digest = canonicalAuditDigest(full);
  const encodedBytes = Buffer.byteLength(stableAuditJson(full), 'utf8');
  return {
    summary: encodedBytes <= MAX_PAYLOAD_SUMMARY_BYTES
      ? full
      : { digestOnly: true, truncated: true, originalRedactedBytes: encodedBytes },
    digest,
    beforeDigest: before === undefined ? null : canonicalAuditDigest(before),
    afterDigest: after === undefined ? null : canonicalAuditDigest(after),
  };
}

function normalizeInput(
  input: CanonicalAuditEventInput,
  options: CanonicalAuditWriteOptions,
): NormalizedCanonicalAuditEvent {
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new CanonicalAuditValidationError('now() returned an invalid timestamp');
  const action = requiredString(input.action, 'action', 128);
  if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(action)) {
    throw new CanonicalAuditValidationError('action must use a stable lowercase dotted identifier');
  }
  const payload = boundedPayloadSummary(input.payload);
  const eventId = requiredString((options.eventId ?? randomUUID)(), 'eventId', 64);
  if (!UUID.test(eventId)) throw new CanonicalAuditValidationError('eventId must be a UUID');
  if (!['human', 'service', 'system'].includes(input.actor.type)) {
    throw new CanonicalAuditValidationError('actor.type is invalid');
  }
  if (!['success', 'failure', 'denied', 'cancelled'].includes(input.outcome)) {
    throw new CanonicalAuditValidationError('outcome is invalid');
  }
  if (!['low', 'medium', 'high', 'critical'].includes(input.risk)) {
    throw new CanonicalAuditValidationError('risk is invalid');
  }
  return {
    eventId,
    occurredAt: isoDate(input.occurredAt, 'occurredAt', now),
    receivedAt: now.toISOString(),
    environment: requiredString(input.environment, 'environment', 64),
    workspaceKey: requiredString(input.workspaceKey ?? DEFAULT_WORKSPACE_KEY, 'workspaceKey', 128),
    tenantKey: requiredString(input.tenantKey ?? DEFAULT_TENANT_KEY, 'tenantKey', 128),
    solution: optionalString(input.solution, 'solution', 128),
    producerName: requiredString(input.producer.name, 'producer.name', 128),
    producerEventId: requiredString(input.producer.eventId, 'producer.eventId', 256),
    actorType: input.actor.type,
    actorId: requiredString(input.actor.id, 'actor.id', 256),
    actorSsoSubject: optionalString(input.actor.ssoSubject, 'actor.ssoSubject', 512),
    actorAuthMethod: requiredString(input.actor.authMethod, 'actor.authMethod', 64),
    actorRoles: normalizedRoles(input.actor.effectiveRoles),
    action,
    outcome: input.outcome,
    riskLevel: input.risk,
    resourceType: requiredString(input.resource.type, 'resource.type', 64),
    resourceId: requiredString(input.resource.id, 'resource.id', 256),
    resourceRevision: optionalString(input.resource.revision, 'resource.revision', 256),
    policyId: optionalString(input.policy?.id, 'policy.id', 256),
    policyVersion: optionalString(input.policy?.version, 'policy.version', 128),
    policyDecision: optionalString(input.policy?.decision, 'policy.decision', 64),
    approvalId: optionalString(input.approvalId, 'approvalId', 256),
    rootRunId: optionalString(input.correlation?.rootRunId, 'correlation.rootRunId', 256),
    traceId: optionalString(input.correlation?.traceId, 'correlation.traceId', 256),
    spanId: optionalString(input.correlation?.spanId, 'correlation.spanId', 256),
    requestId: optionalString(input.correlation?.requestId, 'correlation.requestId', 256),
    payloadSummary: payload.summary,
    payloadDigest: payload.digest,
    beforeDigest: payload.beforeDigest,
    afterDigest: payload.afterDigest,
    retentionClass: requiredString(input.retentionClass ?? DEFAULT_RETENTION_CLASS, 'retentionClass', 64),
    retentionUntil: input.retentionUntil == null ? null : isoDate(input.retentionUntil, 'retentionUntil'),
    legalHold: input.legalHold ?? false,
    signingKeyId: optionalString(input.signingKeyId, 'signingKeyId', 256),
  };
}

function eventPayloadForHash(event: NormalizedCanonicalAuditEvent, sequence: string, previousHash: string): AuditJsonValue {
  return {
    schemaVersion: 1,
    sequence,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    environment: event.environment,
    workspaceKey: event.workspaceKey,
    tenantKey: event.tenantKey,
    solution: event.solution,
    producer: { name: event.producerName, eventId: event.producerEventId },
    actor: {
      type: event.actorType,
      id: event.actorId,
      ssoSubject: event.actorSsoSubject,
      authMethod: event.actorAuthMethod,
      effectiveRoles: event.actorRoles,
    },
    action: event.action,
    outcome: event.outcome,
    risk: event.riskLevel,
    resource: { type: event.resourceType, id: event.resourceId, revision: event.resourceRevision },
    policy: { id: event.policyId, version: event.policyVersion, decision: event.policyDecision },
    approvalId: event.approvalId,
    correlation: {
      rootRunId: event.rootRunId,
      traceId: event.traceId,
      spanId: event.spanId,
      requestId: event.requestId,
    },
    payloadSummary: event.payloadSummary,
    payloadDigest: event.payloadDigest,
    beforeDigest: event.beforeDigest,
    afterDigest: event.afterDigest,
    redactionProfile: CANONICAL_AUDIT_REDACTION_PROFILE,
    retentionClass: event.retentionClass,
    retentionUntil: event.retentionUntil,
    legalHold: event.legalHold,
    previousHash,
    signingKeyId: event.signingKeyId,
  };
}

export function computeCanonicalAuditEventHash(
  event: NormalizedCanonicalAuditEvent,
  sequence: string,
  previousHash: string,
): string {
  return createHash('sha256')
    .update(stableAuditJson(eventPayloadForHash(event, sequence, previousHash)))
    .digest('hex');
}

/** Recompute the v1 event digest without trusting the persisted hash value. */
export function verifyCanonicalAuditEventHash(event: CanonicalAuditEventSummary): boolean {
  if (event.schemaVersion !== 1 || event.redactionProfile !== CANONICAL_AUDIT_REDACTION_PROFILE) return false;
  const normalized: NormalizedCanonicalAuditEvent = {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    environment: event.environment,
    workspaceKey: event.workspaceKey,
    tenantKey: event.tenantKey,
    solution: event.solution,
    producerName: event.producer.name,
    producerEventId: event.producer.eventId,
    actorType: event.actor.type,
    actorId: event.actor.id,
    actorSsoSubject: event.actor.ssoSubject ?? null,
    actorAuthMethod: event.actor.authMethod,
    actorRoles: [...event.actor.effectiveRoles],
    action: event.action,
    outcome: event.outcome,
    riskLevel: event.risk,
    resourceType: event.resource.type,
    resourceId: event.resource.id,
    resourceRevision: event.resource.revision ?? null,
    policyId: event.policy.id ?? null,
    policyVersion: event.policy.version ?? null,
    policyDecision: event.policy.decision ?? null,
    approvalId: event.approvalId,
    rootRunId: event.correlation.rootRunId,
    traceId: event.correlation.traceId,
    spanId: event.correlation.spanId,
    requestId: event.correlation.requestId,
    payloadSummary: event.payloadSummary as Record<string, AuditJsonValue>,
    payloadDigest: event.payloadDigest,
    beforeDigest: event.beforeDigest,
    afterDigest: event.afterDigest,
    retentionClass: event.retentionClass,
    retentionUntil: event.retentionUntil,
    legalHold: event.legalHold,
    signingKeyId: event.signingKeyId,
  };
  return computeCanonicalAuditEventHash(normalized, String(event.sequence), event.previousHash) === event.eventHash;
}

function parsePayloadSummary(value: CanonicalAuditEventRow['payload_summary']): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  }
  return value ?? {};
}

export function mapCanonicalAuditEventRow(row: CanonicalAuditEventRow, replayed: boolean): CanonicalAuditEventSummary {
  const sequence = Number(row.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('canonical audit sequence is outside the safe integer range');
  return {
    eventId: row.event_id,
    schemaVersion: 1,
    sequence,
    occurredAt: new Date(row.occurred_at).toISOString(),
    receivedAt: new Date(row.received_at).toISOString(),
    environment: row.environment,
    workspaceKey: row.workspace_key,
    tenantKey: row.tenant_key,
    solution: row.solution,
    producer: { name: row.producer_name, eventId: row.producer_event_id },
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      ssoSubject: row.actor_sso_subject,
      authMethod: row.actor_auth_method,
      effectiveRoles: row.actor_roles ?? [],
    },
    action: row.action,
    outcome: row.outcome,
    risk: row.risk_level,
    resource: { type: row.resource_type, id: row.resource_id, revision: row.resource_revision },
    policy: { id: row.policy_id, version: row.policy_version, decision: row.policy_decision },
    approvalId: row.approval_id,
    correlation: {
      rootRunId: row.root_run_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      requestId: row.request_id,
    },
    payloadSummary: parsePayloadSummary(row.payload_summary),
    payloadDigest: row.payload_digest,
    beforeDigest: row.before_digest,
    afterDigest: row.after_digest,
    redactionProfile: row.redaction_profile,
    retentionClass: row.retention_class,
    retentionUntil: row.retention_until == null ? null : new Date(row.retention_until).toISOString(),
    legalHold: row.legal_hold,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    signingKeyId: row.signing_key_id,
    replayed,
  };
}

type NormalizedCanonicalAuditScope = {
  environment: string;
  workspaceKey: string;
  tenantKey: string;
};

function normalizeScope(scope: CanonicalAuditScope): NormalizedCanonicalAuditScope {
  return {
    environment: requiredString(scope.environment, 'environment', 64),
    workspaceKey: requiredString(scope.workspaceKey ?? DEFAULT_WORKSPACE_KEY, 'workspaceKey', 128),
    tenantKey: requiredString(scope.tenantKey ?? DEFAULT_TENANT_KEY, 'tenantKey', 128),
  };
}

async function lockScopedProducer(
  client: pg.PoolClient,
  producer: CanonicalAuditProducer,
  scope: CanonicalAuditScope,
): Promise<void> {
  const name = requiredString(producer.name, 'producer.name', 128);
  const eventId = requiredString(producer.eventId, 'producer.eventId', 256);
  const normalized = normalizeScope(scope);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `argus-canonical-audit:${normalized.workspaceKey}:${normalized.tenantKey}:${normalized.environment}:${name}:${eventId}`,
  ]);
}

async function findExistingEvent(
  client: pg.PoolClient,
  producer: CanonicalAuditProducer,
  scope: CanonicalAuditScope,
): Promise<CanonicalAuditEventSummary | null> {
  const normalized = normalizeScope(scope);
  const result = await client.query<CanonicalAuditEventRow>(
    `SELECT * FROM mcp_canonical_audit_events
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3
        AND producer_name=$4 AND producer_event_id=$5`,
    [
      normalized.workspaceKey, normalized.tenantKey, normalized.environment,
      producer.name.trim(), producer.eventId.trim(),
    ],
  );
  return result.rows[0] ? mapCanonicalAuditEventRow(result.rows[0], true) : null;
}

async function assertOutboxCapacity(
  client: pg.PoolClient,
  maximum: number,
): Promise<void> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new CanonicalAuditValidationError('maxPendingOutbox must be a positive safe integer');
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtext('argus-canonical-audit-outbox-capacity'))");
  const result = await client.query<{ pending: string | number }>(
    'SELECT count(*)::text AS pending FROM mcp_canonical_audit_outbox WHERE delivered_at IS NULL',
  );
  if (Number(result.rows[0]?.pending ?? 0) >= maximum) {
    throw new CanonicalAuditBackpressureError(`canonical audit outbox capacity of ${maximum} reached`);
  }
}

async function appendLockedCanonicalAuditEvent(
  client: pg.PoolClient,
  input: CanonicalAuditEventInput,
  options: CanonicalAuditWriteOptions,
  producerAlreadyLocked: boolean,
): Promise<CanonicalAuditEventSummary> {
  const scope = {
    environment: input.environment,
    workspaceKey: input.workspaceKey,
    tenantKey: input.tenantKey,
  };
  if (!producerAlreadyLocked) await lockScopedProducer(client, input.producer, scope);
  const existing = await findExistingEvent(client, input.producer, scope);
  if (existing) return existing;

  const event = normalizeInput(input, options);
  await assertOutboxCapacity(client, options.maxPendingOutbox ?? DEFAULT_MAX_PENDING_OUTBOX);
  await client.query(
    `INSERT INTO mcp_canonical_audit_chain_heads
       (workspace_key, tenant_key, environment)
     VALUES ($1,$2,$3)
     ON CONFLICT (workspace_key, tenant_key, environment) DO NOTHING`,
    [event.workspaceKey, event.tenantKey, event.environment],
  );
  const headResult = await client.query<{ last_sequence: string | number; last_event_hash: string }>(
    `SELECT last_sequence, last_event_hash
       FROM mcp_canonical_audit_chain_heads
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3
      FOR UPDATE`,
    [event.workspaceKey, event.tenantKey, event.environment],
  );
  const head = headResult.rows[0];
  if (!head) throw new Error('canonical audit chain head could not be locked');
  const sequence = (BigInt(head.last_sequence) + 1n).toString();
  const previousHash = head.last_event_hash ?? '';
  const eventHash = computeCanonicalAuditEventHash(event, sequence, previousHash);
  const values: unknown[] = [
    event.eventId, sequence, event.occurredAt, event.receivedAt, event.environment,
    event.workspaceKey, event.tenantKey, event.solution, event.producerName, event.producerEventId,
    event.actorType, event.actorId, event.actorSsoSubject, event.actorAuthMethod, event.actorRoles,
    event.action, event.outcome, event.riskLevel, event.resourceType, event.resourceId,
    event.resourceRevision, event.policyId, event.policyVersion, event.policyDecision, event.approvalId,
    event.rootRunId, event.traceId, event.spanId, event.requestId, JSON.stringify(event.payloadSummary),
    event.payloadDigest, event.beforeDigest, event.afterDigest, CANONICAL_AUDIT_REDACTION_PROFILE,
    event.retentionClass, event.retentionUntil, event.legalHold, previousHash, eventHash, event.signingKeyId,
  ];
  const inserted = await client.query<CanonicalAuditEventRow>(
    `INSERT INTO mcp_canonical_audit_events
       (event_id, sequence, occurred_at, received_at, environment,
        workspace_key, tenant_key, solution, producer_name, producer_event_id,
        actor_type, actor_id, actor_sso_subject, actor_auth_method, actor_roles,
        action, outcome, risk_level, resource_type, resource_id,
        resource_revision, policy_id, policy_version, policy_decision, approval_id,
        root_run_id, trace_id, span_id, request_id, payload_summary,
        payload_digest, before_digest, after_digest, redaction_profile,
        retention_class, retention_until, legal_hold, previous_hash, event_hash, signing_key_id)
     VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})
     RETURNING *`,
    values,
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('canonical audit event insert returned no row');
  const topic = requiredString(options.outboxTopic ?? DEFAULT_OUTBOX_TOPIC, 'outboxTopic', 128);
  await client.query(
    `INSERT INTO mcp_canonical_audit_outbox (event_id, topic)
     VALUES ($1,$2)`,
    [event.eventId, topic],
  );
  await client.query(
    `UPDATE mcp_canonical_audit_chain_heads
        SET last_sequence=$4, last_event_hash=$5, updated_at=now()
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3`,
    [event.workspaceKey, event.tenantKey, event.environment, sequence, eventHash],
  );
  return mapCanonicalAuditEventRow(row, false);
}

/** Append inside a caller-owned transaction. This function never commits. */
export async function appendCanonicalAuditEvent(
  client: pg.PoolClient,
  input: CanonicalAuditEventInput,
  options: CanonicalAuditWriteOptions = {},
): Promise<CanonicalAuditEventSummary> {
  return appendLockedCanonicalAuditEvent(client, input, options, false);
}

/**
 * Execute a privileged mutation with fail-closed canonical audit evidence.
 * A replay returns the committed event and `result: null`; callers can re-read
 * the protected resource instead of applying the mutation twice.
 */
export async function executeCanonicalAuditedMutation<T>(
  pool: pg.Pool,
  producer: CanonicalAuditProducer,
  scope: CanonicalAuditScope,
  mutate: (client: pg.PoolClient) => Promise<T>,
  eventFor: (result: T) => Omit<CanonicalAuditEventInput, 'producer'>,
  options: CanonicalAuditWriteOptions = {},
): Promise<CanonicalAuditMutationResult<T>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const normalizedScope = normalizeScope(scope);
    await lockScopedProducer(client, producer, normalizedScope);
    const existing = await findExistingEvent(client, producer, normalizedScope);
    if (existing) {
      await client.query('COMMIT');
      return { event: existing, replayed: true, result: null };
    }
    const result = await mutate(client);
    const eventInput = { ...eventFor(result), producer };
    const eventScope = normalizeScope(eventInput);
    if (eventScope.environment !== normalizedScope.environment
      || eventScope.workspaceKey !== normalizedScope.workspaceKey
      || eventScope.tenantKey !== normalizedScope.tenantKey) {
      throw new CanonicalAuditValidationError('event scope does not match idempotency scope');
    }
    const event = await appendLockedCanonicalAuditEvent(
      client,
      eventInput,
      options,
      true,
    );
    await client.query('COMMIT');
    return { event, replayed: false, result };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function safeOutboxError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(?:password|passphrase|secret|token|authorization|bearer|cookie|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_OUTBOX_ERROR_LENGTH) || 'delivery failed';
}

export async function claimCanonicalAuditOutboxBatch(
  pool: pg.Pool,
  options: CanonicalAuditClaimOptions,
): Promise<CanonicalAuditOutboxDelivery[]> {
  const workerId = requiredString(options.workerId, 'workerId', 256);
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 500);
  const leaseSeconds = Math.min(Math.max(Math.floor(options.leaseSeconds ?? 60), 5), 900);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query<{ id: string | number; event_id: string; topic: string; attempt_count: number | string }>(
      `WITH candidates AS (
         SELECT id FROM mcp_canonical_audit_outbox
          WHERE delivered_at IS NULL
            AND available_at <= now()
            AND (state='pending' OR (state='processing' AND leased_until < now()))
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE mcp_canonical_audit_outbox outbox
          SET state='processing', attempt_count=attempt_count+1,
              leased_by=$2, leased_until=now() + ($3::int * interval '1 second'),
              last_error=NULL
         FROM candidates
        WHERE outbox.id=candidates.id
       RETURNING outbox.id, outbox.event_id, outbox.topic, outbox.attempt_count`,
      [limit, workerId, leaseSeconds],
    );
    if (claimed.rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }
    const eventIds = claimed.rows.map(row => row.event_id);
    const events = await client.query<CanonicalAuditEventRow>(
      'SELECT * FROM mcp_canonical_audit_events WHERE event_id=ANY($1::uuid[])',
      [eventIds],
    );
    const byId = new Map(events.rows.map(row => [row.event_id, mapCanonicalAuditEventRow(row, false)]));
    const deliveries = claimed.rows.map(row => {
      const event = byId.get(row.event_id);
      if (!event) throw new Error(`canonical audit event ${row.event_id} is missing for outbox delivery`);
      return {
        id: String(row.id),
        eventId: row.event_id,
        topic: row.topic,
        attemptCount: Number(row.attempt_count),
        event,
      };
    });
    await client.query('COMMIT');
    return deliveries;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function markCanonicalAuditDelivered(
  pool: pg.Pool,
  deliveryId: string,
  workerId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE mcp_canonical_audit_outbox
        SET state='delivered', delivered_at=COALESCE(delivered_at, now()),
            leased_by=NULL, leased_until=NULL, last_error=NULL
      WHERE id=$1 AND (state='delivered' OR (state='processing' AND leased_by=$2))`,
    [requiredString(deliveryId, 'deliveryId', 64), requiredString(workerId, 'workerId', 256)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function releaseCanonicalAuditDelivery(
  pool: pg.Pool,
  deliveryId: string,
  workerId: string,
  error: unknown,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE mcp_canonical_audit_outbox
        SET state='pending', available_at=now() +
              (LEAST(3600, GREATEST(1, power(2, LEAST(attempt_count, 12)))) * interval '1 second'),
            leased_by=NULL, leased_until=NULL, last_error=$3
      WHERE id=$1 AND state='processing' AND leased_by=$2 AND delivered_at IS NULL`,
    [
      requiredString(deliveryId, 'deliveryId', 64),
      requiredString(workerId, 'workerId', 256),
      safeOutboxError(error),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
