import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { stableAuditJson, type AuditJsonValue } from './canonicalAuditRedaction.js';
import { mapCanonicalAuditEventRow, verifyCanonicalAuditEventHash } from './canonicalAuditStore.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_KEY_FILE_BYTES = 16 * 1024;

export interface AuditCheckpointScope {
  workspaceKey: string;
  tenantKey: string;
  environment: string;
}

export interface AuditCheckpointSigner {
  keyId: string;
  algorithm: 'Ed25519';
  privateKey: KeyObject;
  publicKeyPem: string;
  publicKeyFingerprint: string;
  source: 'external-secret' | 'kms' | 'hsm';
}

export interface CanonicalAuditCheckpoint {
  checkpointId: string;
  schemaVersion: 1;
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  lastSequence: number;
  lastEventId: string;
  lastEventHash: string;
  previousCheckpointId: string | null;
  previousCheckpointDigest: string;
  createdAt: string;
  algorithm: 'Ed25519';
  keyId: string;
  publicKeyFingerprint: string;
  checkpointDigest: string;
  signature: string;
  replayed: boolean;
}

export interface AuditCheckpointVerification {
  state: 'valid' | 'invalid' | 'not_found';
  checkpointId: string | null;
  checkedAt: string;
  verifiedEvents: number;
  reason: string | null;
}

export interface AuditCheckpointEnvelope {
  checkpoint: CanonicalAuditCheckpoint;
  publicKeyPem: string;
}

type CheckpointRow = {
  checkpoint_id: string;
  schema_version: number | string;
  workspace_key: string;
  tenant_key: string;
  environment: string;
  last_sequence: number | string;
  last_event_id: string;
  last_event_hash: string;
  previous_checkpoint_id: string | null;
  previous_checkpoint_digest: string;
  created_at: string | Date;
  algorithm: string;
  key_id: string;
  public_key_fingerprint: string;
  checkpoint_digest: string;
  signature: string;
};

function boundedIdentifier(value: unknown, name: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max || !IDENTIFIER.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function normalizeScope(scope: AuditCheckpointScope): AuditCheckpointScope {
  return {
    workspaceKey: boundedIdentifier(scope.workspaceKey, 'workspaceKey', 128),
    tenantKey: boundedIdentifier(scope.tenantKey, 'tenantKey', 128),
    environment: boundedIdentifier(scope.environment, 'environment', 64),
  };
}

function publicKeyFingerprint(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

export function createAuditCheckpointSigner(
  keyId: string,
  privateKeyPem: string | Buffer,
  source: AuditCheckpointSigner['source'] = 'external-secret',
): AuditCheckpointSigner {
  const normalizedKeyId = boundedIdentifier(keyId, 'keyId', 256);
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('audit checkpoint key must be Ed25519');
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    keyId: normalizedKeyId,
    algorithm: 'Ed25519',
    privateKey,
    publicKeyPem,
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
    source,
  };
}

export function loadAuditCheckpointSignerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuditCheckpointSigner | null {
  const keyId = env['ARGUS_AUDIT_SIGNING_KEY_ID']?.trim() ?? '';
  const filename = env['ARGUS_AUDIT_SIGNING_PRIVATE_KEY_FILE']?.trim() ?? '';
  const inline = env['ARGUS_AUDIT_SIGNING_PRIVATE_KEY'] ?? '';
  if (!keyId && !filename && !inline) return null;
  if (!keyId) throw new Error('ARGUS_AUDIT_SIGNING_KEY_ID is required when audit checkpoint signing is configured');
  if (filename && inline) {
    throw new Error('Configure ARGUS_AUDIT_SIGNING_PRIVATE_KEY_FILE or ARGUS_AUDIT_SIGNING_PRIVATE_KEY, not both');
  }
  if (!filename && !inline) throw new Error('Audit checkpoint signing private key is missing');
  const material = filename ? readFileSync(filename) : Buffer.from(inline, 'utf8');
  if (material.byteLength > MAX_KEY_FILE_BYTES) throw new Error('audit checkpoint signing key exceeds 16 KiB');
  return createAuditCheckpointSigner(keyId, material);
}

type UnsignedCheckpoint = Omit<CanonicalAuditCheckpoint, 'checkpointDigest' | 'signature' | 'replayed'>;

function checkpointPayload(checkpoint: UnsignedCheckpoint): AuditJsonValue {
  return {
    schemaVersion: 1,
    checkpointId: checkpoint.checkpointId,
    workspaceKey: checkpoint.workspaceKey,
    tenantKey: checkpoint.tenantKey,
    environment: checkpoint.environment,
    lastSequence: String(checkpoint.lastSequence),
    lastEventId: checkpoint.lastEventId,
    lastEventHash: checkpoint.lastEventHash,
    previousCheckpointId: checkpoint.previousCheckpointId,
    previousCheckpointDigest: checkpoint.previousCheckpointDigest,
    createdAt: checkpoint.createdAt,
    algorithm: checkpoint.algorithm,
    keyId: checkpoint.keyId,
    publicKeyFingerprint: checkpoint.publicKeyFingerprint,
  };
}

export function computeAuditCheckpointDigest(checkpoint: UnsignedCheckpoint): string {
  return createHash('sha256').update(stableAuditJson(checkpointPayload(checkpoint))).digest('hex');
}

export function mapCanonicalAuditCheckpoint(row: CheckpointRow, replayed = false): CanonicalAuditCheckpoint {
  const sequence = Number(row.last_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('audit checkpoint sequence is invalid');
  if (Number(row.schema_version) !== 1 || row.algorithm !== 'Ed25519') {
    throw new Error('audit checkpoint schema or algorithm is unsupported');
  }
  return {
    checkpointId: row.checkpoint_id,
    schemaVersion: 1,
    workspaceKey: row.workspace_key,
    tenantKey: row.tenant_key,
    environment: row.environment,
    lastSequence: sequence,
    lastEventId: row.last_event_id,
    lastEventHash: row.last_event_hash,
    previousCheckpointId: row.previous_checkpoint_id,
    previousCheckpointDigest: row.previous_checkpoint_digest,
    createdAt: new Date(row.created_at).toISOString(),
    algorithm: 'Ed25519',
    keyId: row.key_id,
    publicKeyFingerprint: row.public_key_fingerprint,
    checkpointDigest: row.checkpoint_digest,
    signature: row.signature,
    replayed,
  };
}

export function verifyAuditCheckpointSignature(
  checkpoint: CanonicalAuditCheckpoint,
  publicKeyPem: string,
): boolean {
  try {
    if (!UUID.test(checkpoint.checkpointId) || !SHA256.test(checkpoint.checkpointDigest)) return false;
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    if (publicKeyFingerprint(publicKey) !== checkpoint.publicKeyFingerprint) return false;
    const { checkpointDigest: _digest, signature: _signature, replayed: _replayed, ...unsigned } = checkpoint;
    const digest = computeAuditCheckpointDigest(unsigned);
    return digest === checkpoint.checkpointDigest
      && verify(null, Buffer.from(digest, 'hex'), publicKey, Buffer.from(checkpoint.signature, 'base64url'));
  } catch {
    return false;
  }
}

export interface CreateAuditCheckpointOptions {
  now?: () => Date;
  checkpointId?: () => string;
}

export async function createCanonicalAuditCheckpoint(
  pool: pg.Pool,
  scopeInput: AuditCheckpointScope,
  signer: AuditCheckpointSigner,
  options: CreateAuditCheckpointOptions = {},
): Promise<CanonicalAuditCheckpoint> {
  const scope = normalizeScope(scopeInput);
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('checkpoint time is invalid');
  const checkpointId = (options.checkpointId ?? randomUUID)();
  if (!UUID.test(checkpointId)) throw new Error('checkpointId must be a UUID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [stableAuditJson(['audit-checkpoint', scope.workspaceKey, scope.tenantKey, scope.environment])],
    );
    const headResult = await client.query<{ last_sequence: string | number; last_event_hash: string }>(
      `SELECT last_sequence, last_event_hash
         FROM mcp_canonical_audit_chain_heads
        WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3
        FOR SHARE`,
      [scope.workspaceKey, scope.tenantKey, scope.environment],
    );
    const head = headResult.rows[0];
    const lastSequence = Number(head?.last_sequence ?? 0);
    if (!head || !Number.isSafeInteger(lastSequence) || lastSequence < 1 || !SHA256.test(head.last_event_hash)) {
      throw new Error('canonical audit chain has no signable head');
    }
    const existingResult = await client.query<CheckpointRow>(
      `SELECT * FROM mcp_canonical_audit_checkpoints
        WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND last_sequence=$4`,
      [scope.workspaceKey, scope.tenantKey, scope.environment, String(lastSequence)],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      await client.query('COMMIT');
      return mapCanonicalAuditCheckpoint(existing, true);
    }
    const eventResult = await client.query<{ event_id: string; event_hash: string }>(
      `SELECT event_id, event_hash FROM mcp_canonical_audit_events
        WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND sequence=$4`,
      [scope.workspaceKey, scope.tenantKey, scope.environment, String(lastSequence)],
    );
    const event = eventResult.rows[0];
    if (!event || event.event_hash !== head.last_event_hash) {
      throw new Error('canonical audit chain head does not match its terminal event');
    }
    const previousResult = await client.query<CheckpointRow>(
      `SELECT * FROM mcp_canonical_audit_checkpoints
        WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3
        ORDER BY last_sequence DESC LIMIT 1 FOR UPDATE`,
      [scope.workspaceKey, scope.tenantKey, scope.environment],
    );
    const previous = previousResult.rows[0] ? mapCanonicalAuditCheckpoint(previousResult.rows[0]) : null;
    if (previous && previous.lastSequence >= lastSequence) {
      throw new Error('audit checkpoint sequence did not advance');
    }
    await client.query(
      `INSERT INTO mcp_canonical_audit_signing_keys
         (key_id, algorithm, public_key_pem, public_key_fingerprint, registered_at, source)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key_id) DO NOTHING`,
      [signer.keyId, signer.algorithm, signer.publicKeyPem, signer.publicKeyFingerprint, now.toISOString(), signer.source],
    );
    const registered = await client.query<{
      algorithm: string; public_key_pem: string; public_key_fingerprint: string;
    }>(
      `SELECT algorithm, public_key_pem, public_key_fingerprint
         FROM mcp_canonical_audit_signing_keys WHERE key_id=$1`,
      [signer.keyId],
    );
    const key = registered.rows[0];
    if (!key || key.algorithm !== signer.algorithm
      || key.public_key_pem !== signer.publicKeyPem
      || key.public_key_fingerprint !== signer.publicKeyFingerprint) {
      throw new Error('audit signing key ID is already bound to different public key material');
    }
    const unsigned: UnsignedCheckpoint = {
      checkpointId,
      schemaVersion: 1,
      ...scope,
      lastSequence,
      lastEventId: event.event_id,
      lastEventHash: event.event_hash,
      previousCheckpointId: previous?.checkpointId ?? null,
      previousCheckpointDigest: previous?.checkpointDigest ?? '',
      createdAt: now.toISOString(),
      algorithm: 'Ed25519',
      keyId: signer.keyId,
      publicKeyFingerprint: signer.publicKeyFingerprint,
    };
    const checkpointDigest = computeAuditCheckpointDigest(unsigned);
    const signature = sign(null, Buffer.from(checkpointDigest, 'hex'), signer.privateKey).toString('base64url');
    const inserted = await client.query<CheckpointRow>(
      `INSERT INTO mcp_canonical_audit_checkpoints
         (checkpoint_id, workspace_key, tenant_key, environment, last_sequence,
          last_event_id, last_event_hash, previous_checkpoint_id, previous_checkpoint_digest,
          created_at, algorithm, key_id, public_key_fingerprint, checkpoint_digest, signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        checkpointId, scope.workspaceKey, scope.tenantKey, scope.environment, String(lastSequence),
        event.event_id, event.event_hash, unsigned.previousCheckpointId, unsigned.previousCheckpointDigest,
        unsigned.createdAt, unsigned.algorithm, unsigned.keyId, unsigned.publicKeyFingerprint,
        checkpointDigest, signature,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('audit checkpoint insert returned no row');
    await client.query('COMMIT');
    return mapCanonicalAuditCheckpoint(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadLatestCanonicalAuditCheckpoint(
  pool: pg.Pool,
  scopeInput: AuditCheckpointScope,
): Promise<CanonicalAuditCheckpoint | null> {
  const scope = normalizeScope(scopeInput);
  const result = await pool.query<CheckpointRow>(
    `SELECT * FROM mcp_canonical_audit_checkpoints
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3
      ORDER BY last_sequence DESC LIMIT 1`,
    [scope.workspaceKey, scope.tenantKey, scope.environment],
  );
  return result.rows[0] ? mapCanonicalAuditCheckpoint(result.rows[0]) : null;
}

export async function loadLatestCanonicalAuditCheckpointEnvelope(
  pool: pg.Pool,
  scopeInput: AuditCheckpointScope,
): Promise<AuditCheckpointEnvelope | null> {
  const scope = normalizeScope(scopeInput);
  const result = await pool.query<CheckpointRow & { public_key_pem: string }>(
    `SELECT checkpoint.*, signing_key.public_key_pem
       FROM mcp_canonical_audit_checkpoints checkpoint
       JOIN mcp_canonical_audit_signing_keys signing_key ON signing_key.key_id=checkpoint.key_id
      WHERE checkpoint.workspace_key=$1 AND checkpoint.tenant_key=$2 AND checkpoint.environment=$3
      ORDER BY checkpoint.last_sequence DESC LIMIT 1`,
    [scope.workspaceKey, scope.tenantKey, scope.environment],
  );
  const row = result.rows[0];
  return row ? { checkpoint: mapCanonicalAuditCheckpoint(row), publicKeyPem: row.public_key_pem } : null;
}

/**
 * Full verification intentionally walks from sequence 1 to the signed head.
 * This is suited to scheduled certification/evidence export, not a hot request
 * path for an unbounded enterprise ledger.
 */
export async function verifyCanonicalAuditCheckpoint(
  pool: pg.Pool,
  checkpointId: string,
  checkedAt = new Date(),
): Promise<AuditCheckpointVerification> {
  if (!UUID.test(checkpointId)) throw new Error('checkpointId must be a UUID');
  const checkpointResult = await pool.query<CheckpointRow & { public_key_pem: string }>(
    `SELECT checkpoint.*, signing_key.public_key_pem
       FROM mcp_canonical_audit_checkpoints checkpoint
       JOIN mcp_canonical_audit_signing_keys signing_key ON signing_key.key_id=checkpoint.key_id
      WHERE checkpoint.checkpoint_id=$1`,
    [checkpointId],
  );
  const row = checkpointResult.rows[0];
  if (!row) {
    return { state: 'not_found', checkpointId: null, checkedAt: checkedAt.toISOString(), verifiedEvents: 0, reason: null };
  }
  const checkpoint = mapCanonicalAuditCheckpoint(row);
  if (!verifyAuditCheckpointSignature(checkpoint, row.public_key_pem)) {
    return { state: 'invalid', checkpointId, checkedAt: checkedAt.toISOString(), verifiedEvents: 0, reason: 'checkpoint_signature_invalid' };
  }
  const events = await pool.query(
    `SELECT * FROM mcp_canonical_audit_events
      WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND sequence<=$4
      ORDER BY sequence ASC`,
    [checkpoint.workspaceKey, checkpoint.tenantKey, checkpoint.environment, String(checkpoint.lastSequence)],
  );
  let previousHash = '';
  let expectedSequence = 1;
  for (const eventRow of events.rows) {
    const event = mapCanonicalAuditEventRow(eventRow, false);
    if (event.sequence !== expectedSequence || event.previousHash !== previousHash || !verifyCanonicalAuditEventHash(event)) {
      return {
        state: 'invalid', checkpointId, checkedAt: checkedAt.toISOString(),
        verifiedEvents: expectedSequence - 1, reason: 'event_chain_invalid',
      };
    }
    previousHash = event.eventHash;
    expectedSequence += 1;
  }
  if (events.rows.length !== checkpoint.lastSequence
    || previousHash !== checkpoint.lastEventHash
    || events.rows.at(-1)?.event_id !== checkpoint.lastEventId) {
    return {
      state: 'invalid', checkpointId, checkedAt: checkedAt.toISOString(),
      verifiedEvents: events.rows.length, reason: 'checkpoint_head_mismatch',
    };
  }
  if (checkpoint.previousCheckpointId) {
    const previous = await pool.query<CheckpointRow>(
      `SELECT * FROM mcp_canonical_audit_checkpoints WHERE checkpoint_id=$1`,
      [checkpoint.previousCheckpointId],
    );
    if (!previous.rows[0]
      || previous.rows[0].checkpoint_digest !== checkpoint.previousCheckpointDigest
      || Number(previous.rows[0].last_sequence) >= checkpoint.lastSequence) {
      return {
        state: 'invalid', checkpointId, checkedAt: checkedAt.toISOString(),
        verifiedEvents: events.rows.length, reason: 'checkpoint_chain_invalid',
      };
    }
  } else if (checkpoint.previousCheckpointDigest !== '') {
    return {
      state: 'invalid', checkpointId, checkedAt: checkedAt.toISOString(),
      verifiedEvents: events.rows.length, reason: 'checkpoint_chain_invalid',
    };
  }
  return {
    state: 'valid', checkpointId, checkedAt: checkedAt.toISOString(),
    verifiedEvents: events.rows.length, reason: null,
  };
}
