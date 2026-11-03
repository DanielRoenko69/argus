import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { stableAuditJson, type AuditJsonValue } from './canonicalAuditRedaction.js';
import {
  loadLatestCanonicalAuditCheckpointEnvelope,
  verifyAuditCheckpointSignature,
  type CanonicalAuditCheckpoint,
} from './checkpoints.js';
import { mapCanonicalAuditEventRow, verifyCanonicalAuditEventHash } from './canonicalAuditStore.js';
import { appendCanonicalAuditEvent } from './canonicalAuditStore.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary } from './canonicalAuditTypes.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@|/-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EXPORT_EVENTS = 10_000;
const MAX_CHAIN_EVENTS = 50_000;

export interface AuditEvidencePackInput {
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  from?: string | null;
  to?: string | null;
  actorId?: string | null;
  action?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  generatedBy: { actorId: string; authMethod: string };
  now?: () => Date;
  packId?: () => string;
}

export interface AuditEvidencePackV1 {
  schemaVersion: 1;
  kind: 'argus.audit.evidence-pack';
  manifest: {
    packId: string;
    generatedAt: string;
    generatedBy: { actorId: string; authMethod: string };
    scope: { workspaceKey: string; tenantKey: string; environment: string };
    selection: {
      from: string | null;
      to: string | null;
      actorId: string | null;
      action: string | null;
      resourceType: string | null;
      resourceId: string | null;
      throughCheckpointSequence: number;
    };
    eventCount: number;
    chainEntryCount: number;
    formats: ['json', 'jsonl', 'csv'];
    controlMapping: Array<{ framework: string; control: string; evidence: string }>;
    declaredGaps: Array<{ code: string; description: string }>;
  };
  checkpoint: CanonicalAuditCheckpoint;
  verificationKey: {
    keyId: string;
    algorithm: 'Ed25519';
    publicKeyFingerprint: string;
    publicKeyPem: string;
  };
  chain: Array<{ sequence: number; eventId: string; previousHash: string; eventHash: string }>;
  chainEvents: CanonicalAuditEventSummary[];
  events: CanonicalAuditEventSummary[];
  schemaDictionary: Record<string, string>;
  artifacts: { eventsJsonl: string; eventsCsv: string };
  packDigest: string;
}

export interface AuditEvidencePackVerification {
  state: 'valid' | 'invalid';
  packId: string | null;
  verifiedEvents: number;
  verifiedChainEntries: number;
  reasons: string[];
}

function identifier(value: unknown, name: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max || !IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function optionalIdentifier(value: unknown, name: string, max: number): string | null {
  if (value == null || value === '') return null;
  return identifier(value, name, max);
}

function timestamp(value: string | null | undefined, name: string): string | null {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return date.toISOString();
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function eventsCsv(events: CanonicalAuditEventSummary[]): string {
  const columns = ['sequence', 'event_id', 'occurred_at', 'actor_type', 'actor_id', 'action', 'outcome', 'risk', 'resource_type', 'resource_id', 'event_hash'];
  const rows = events.map(event => [
    event.sequence, event.eventId, event.occurredAt, event.actor.type, event.actor.id,
    event.action, event.outcome, event.risk, event.resource.type, event.resource.id, event.eventHash,
  ].map(csvCell).join(','));
  return [columns.join(','), ...rows].join('\n');
}

function withoutPackDigest(pack: AuditEvidencePackV1): Omit<AuditEvidencePackV1, 'packDigest'> {
  const { packDigest: _digest, ...unsigned } = pack;
  return unsigned;
}

export function computeAuditEvidencePackDigest(pack: Omit<AuditEvidencePackV1, 'packDigest'>): string {
  return createHash('sha256').update(stableAuditJson(pack as unknown as AuditJsonValue)).digest('hex');
}

export async function createAuditEvidencePack(
  pool: pg.Pool,
  input: AuditEvidencePackInput,
): Promise<AuditEvidencePackV1> {
  const scope = {
    workspaceKey: identifier(input.workspaceKey, 'workspaceKey', 128),
    tenantKey: identifier(input.tenantKey, 'tenantKey', 128),
    environment: identifier(input.environment, 'environment', 64),
  };
  const from = timestamp(input.from, 'from');
  const to = timestamp(input.to, 'to');
  if (from && to && from > to) throw new Error('from must not be after to');
  const actorId = optionalIdentifier(input.actorId, 'actorId', 256);
  const action = optionalIdentifier(input.action, 'action', 128);
  const resourceType = optionalIdentifier(input.resourceType, 'resourceType', 64);
  const resourceId = optionalIdentifier(input.resourceId, 'resourceId', 256);
  const generatedBy = {
    actorId: identifier(input.generatedBy.actorId, 'generatedBy.actorId', 256),
    authMethod: identifier(input.generatedBy.authMethod, 'generatedBy.authMethod', 64),
  };
  const generatedAt = (input.now ?? (() => new Date()))().toISOString();
  const packId = (input.packId ?? randomUUID)();
  if (!UUID.test(packId)) throw new Error('packId must be a UUID');
  const envelope = await loadLatestCanonicalAuditCheckpointEnvelope(pool, scope);
  if (!envelope || !verifyAuditCheckpointSignature(envelope.checkpoint, envelope.publicKeyPem)) {
    throw new Error('a valid signed audit checkpoint is required before evidence export');
  }

  const headResult = await pool.query<{ last_sequence: number | string }>(
    `SELECT last_sequence FROM mcp_canonical_audit_chain_heads
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3`,
    [scope.workspaceKey, scope.tenantKey, scope.environment],
  );
  const currentHeadSequence = Number(headResult.rows[0]?.last_sequence ?? envelope.checkpoint.lastSequence);

  const chainResult = await pool.query(
    `SELECT *
       FROM mcp_canonical_audit_events
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND sequence<=$4
      ORDER BY sequence ASC
      LIMIT $5`,
    [scope.workspaceKey, scope.tenantKey, scope.environment, String(envelope.checkpoint.lastSequence), MAX_CHAIN_EVENTS + 1],
  );
  if (chainResult.rows.length > MAX_CHAIN_EVENTS) {
    throw new Error(`evidence chain exceeds ${MAX_CHAIN_EVENTS} events; use a segmented archival export`);
  }
  const params: unknown[] = [scope.workspaceKey, scope.tenantKey, scope.environment, String(envelope.checkpoint.lastSequence)];
  const where = [
    'workspace_key=$1', 'tenant_key=$2', 'environment=$3', 'sequence<=$4',
  ];
  const add = (expression: string, value: unknown) => {
    if (value == null) return;
    params.push(value);
    where.push(expression.replace('?', `$${params.length}`));
  };
  add('occurred_at>=?::timestamptz', from);
  add('occurred_at<=?::timestamptz', to);
  add('actor_id=?', actorId);
  add('action=?', action);
  add('resource_type=?', resourceType);
  add('resource_id=?', resourceId);
  params.push(MAX_EXPORT_EVENTS + 1);
  const selectedResult = await pool.query(
    `SELECT * FROM mcp_canonical_audit_events
      WHERE ${where.join(' AND ')}
      ORDER BY sequence ASC
      LIMIT $${params.length}`,
    params,
  );
  if (selectedResult.rows.length > MAX_EXPORT_EVENTS) {
    throw new Error(`evidence export exceeds ${MAX_EXPORT_EVENTS} selected events; narrow the filters`);
  }
  const chainEvents = chainResult.rows.map(row => mapCanonicalAuditEventRow(row, false));
  const chain = chainEvents.map(event => ({
    sequence: event.sequence, eventId: event.eventId,
    previousHash: event.previousHash, eventHash: event.eventHash,
  }));
  const events = selectedResult.rows.map(row => mapCanonicalAuditEventRow(row, false));
  let previousHash = '';
  for (let index = 0; index < chainEvents.length; index += 1) {
    const event = chainEvents[index]!;
    if (event.sequence !== index + 1 || event.previousHash !== previousHash || !verifyCanonicalAuditEventHash(event)) {
      throw new Error('evidence export stopped because the canonical event chain is invalid');
    }
    previousHash = event.eventHash;
  }
  const eventsJsonl = events.map(event => stableAuditJson(event as unknown as AuditJsonValue)).join('\n');
  const unsigned: Omit<AuditEvidencePackV1, 'packDigest'> = {
    schemaVersion: 1,
    kind: 'argus.audit.evidence-pack',
    manifest: {
      packId,
      generatedAt,
      generatedBy,
      scope,
      selection: {
        from, to, actorId, action, resourceType, resourceId,
        throughCheckpointSequence: envelope.checkpoint.lastSequence,
      },
      eventCount: events.length,
      chainEntryCount: chain.length,
      formats: ['json', 'jsonl', 'csv'],
      controlMapping: [
        { framework: 'ISO/IEC 27001:2022', control: 'A.8.15', evidence: 'tamper-evident activity logging' },
        { framework: 'SOC 2', control: 'CC7.2', evidence: 'monitored system activity and security events' },
        { framework: 'DORA', control: 'Article 12', evidence: 'ICT logging, integrity and retention support' },
      ],
      declaredGaps: [
        {
          code: 'legacy_sources_not_canonical',
          description: 'The pack contains canonical producer families only; explicitly legacy sources are outside its completeness claim.',
        },
        ...(currentHeadSequence > envelope.checkpoint.lastSequence ? [{
          code: 'events_after_checkpoint_not_included',
          description: `${currentHeadSequence - envelope.checkpoint.lastSequence} canonical event(s) after the signed checkpoint are outside this pack.`,
        }] : []),
      ],
    },
    checkpoint: envelope.checkpoint,
    verificationKey: {
      keyId: envelope.checkpoint.keyId,
      algorithm: 'Ed25519',
      publicKeyFingerprint: envelope.checkpoint.publicKeyFingerprint,
      publicKeyPem: envelope.publicKeyPem,
    },
    chain,
    chainEvents,
    events,
    schemaDictionary: {
      'manifest.scope': 'Server-authorized workspace, tenant and environment boundary.',
      'manifest.selection': 'Event filters applied within the signed checkpoint boundary.',
      checkpoint: 'Ed25519-signed append-only chain head.',
      verificationKey: 'Historical public key; private signing material is never exported.',
      chain: 'Minimal sequence and hash-link proof from genesis through the checkpoint.',
      chainEvents: 'Canonical redacted event preimages required to recompute every hash link through the signed checkpoint.',
      events: 'Selected canonical events with already-redacted payload summaries and digests.',
      'artifacts.eventsJsonl': 'Canonical JSON Lines representation of selected events.',
      'artifacts.eventsCsv': 'Human-readable index; JSON remains authoritative.',
      packDigest: 'SHA-256 over every pack field except packDigest.',
    },
    artifacts: { eventsJsonl, eventsCsv: eventsCsv(events) },
  };
  return { ...unsigned, packDigest: computeAuditEvidencePackDigest(unsigned) };
}

export async function recordAuditEvidencePackExport(
  pool: pg.Pool,
  pack: AuditEvidencePackV1,
  actor: CanonicalAuditActor,
  producerEventId: string,
): Promise<{ replayed: boolean; eventId: string }> {
  const normalizedProducerEventId = identifier(producerEventId, 'producerEventId', 256);
  const selectionDigest = createHash('sha256')
    .update(stableAuditJson(pack.manifest.selection as unknown as AuditJsonValue))
    .digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await appendCanonicalAuditEvent(client, {
      producer: { name: 'audit.evidence_pack.export', eventId: normalizedProducerEventId },
      occurredAt: pack.manifest.generatedAt,
      environment: pack.manifest.scope.environment,
      workspaceKey: pack.manifest.scope.workspaceKey,
      tenantKey: pack.manifest.scope.tenantKey,
      solution: 'argus.core',
      actor,
      action: 'audit.evidence_pack.exported',
      outcome: 'success',
      risk: 'critical',
      resource: { type: 'audit_evidence_pack', id: pack.manifest.packId, revision: pack.packDigest },
      policy: { id: 'argus.audit.evidence-export', version: '1', decision: 'allow' },
      payload: { after: {
        packDigest: pack.packDigest,
        checkpointId: pack.checkpoint.checkpointId,
        eventCount: pack.manifest.eventCount,
        chainEntryCount: pack.manifest.chainEntryCount,
        selectionDigest,
      } },
      retentionClass: 'business-audit-governance',
    });
    await client.query('COMMIT');
    return { replayed: event.replayed, eventId: event.eventId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function verifyAuditEvidencePack(pack: AuditEvidencePackV1): AuditEvidencePackVerification {
  const reasons: string[] = [];
  const packId = typeof pack?.manifest?.packId === 'string' ? pack.manifest.packId : null;
  try {
    if (pack.schemaVersion !== 1 || pack.kind !== 'argus.audit.evidence-pack') reasons.push('unsupported_pack_schema');
    if (computeAuditEvidencePackDigest(withoutPackDigest(pack)) !== pack.packDigest) reasons.push('pack_digest_invalid');
    if (pack.verificationKey.keyId !== pack.checkpoint.keyId
      || pack.verificationKey.publicKeyFingerprint !== pack.checkpoint.publicKeyFingerprint
      || !verifyAuditCheckpointSignature(pack.checkpoint, pack.verificationKey.publicKeyPem)) {
      reasons.push('checkpoint_signature_invalid');
    }
    const scope = pack.manifest.scope;
    const selection = pack.manifest.selection;
    if (scope.workspaceKey !== pack.checkpoint.workspaceKey
      || scope.tenantKey !== pack.checkpoint.tenantKey
      || scope.environment !== pack.checkpoint.environment
      || selection.throughCheckpointSequence !== pack.checkpoint.lastSequence) {
      reasons.push('manifest_scope_invalid');
    }
    let previousHash = '';
    for (let index = 0; index < pack.chain.length; index += 1) {
      const entry = pack.chain[index]!;
      const chainEvent = pack.chainEvents[index];
      if (entry.sequence !== index + 1 || entry.previousHash !== previousHash
        || !chainEvent || chainEvent.sequence !== entry.sequence || chainEvent.eventId !== entry.eventId
        || chainEvent.previousHash !== entry.previousHash || chainEvent.eventHash !== entry.eventHash
        || !verifyCanonicalAuditEventHash(chainEvent)) {
        reasons.push('chain_continuity_invalid');
        break;
      }
      previousHash = entry.eventHash;
    }
    const last = pack.chain.at(-1);
    if (pack.chain.length !== pack.checkpoint.lastSequence
      || pack.chainEvents.length !== pack.chain.length
      || last?.eventId !== pack.checkpoint.lastEventId
      || last?.eventHash !== pack.checkpoint.lastEventHash) {
      reasons.push('chain_head_mismatch');
    }
    const chainBySequence = new Map(pack.chain.map(entry => [entry.sequence, entry]));
    for (const event of pack.events) {
      const entry = chainBySequence.get(event.sequence);
      if (!entry || entry.eventId !== event.eventId || entry.eventHash !== event.eventHash
        || !verifyCanonicalAuditEventHash(event)) {
        reasons.push('selected_event_invalid');
        break;
      }
      const outsideSelection = event.workspaceKey !== scope.workspaceKey
        || event.tenantKey !== scope.tenantKey
        || event.environment !== scope.environment
        || (selection.from != null && event.occurredAt < selection.from)
        || (selection.to != null && event.occurredAt > selection.to)
        || (selection.actorId != null && event.actor.id !== selection.actorId)
        || (selection.action != null && event.action !== selection.action)
        || (selection.resourceType != null && event.resource.type !== selection.resourceType)
        || (selection.resourceId != null && event.resource.id !== selection.resourceId);
      if (outsideSelection) {
        reasons.push('selected_event_outside_manifest');
        break;
      }
    }
    const expectedJsonl = pack.events.map(event => stableAuditJson(event as unknown as AuditJsonValue)).join('\n');
    if (expectedJsonl !== pack.artifacts.eventsJsonl || eventsCsv(pack.events) !== pack.artifacts.eventsCsv) {
      reasons.push('derived_artifact_invalid');
    }
    if (pack.manifest.eventCount !== pack.events.length || pack.manifest.chainEntryCount !== pack.chain.length) {
      reasons.push('manifest_count_invalid');
    }
  } catch {
    reasons.push('malformed_pack');
  }
  return {
    state: reasons.length === 0 ? 'valid' : 'invalid',
    packId,
    verifiedEvents: reasons.includes('selected_event_invalid') ? 0 : pack.events?.length ?? 0,
    verifiedChainEntries: reasons.includes('chain_continuity_invalid') ? 0 : pack.chain?.length ?? 0,
    reasons: [...new Set(reasons)],
  };
}
