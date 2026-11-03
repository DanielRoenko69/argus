import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  createAuditCheckpointSigner,
  createCanonicalAuditCheckpoint,
  loadAuditCheckpointSignerFromEnv,
  verifyAuditCheckpointSignature,
  verifyCanonicalAuditCheckpoint,
} from '../checkpoints.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const CHECKPOINT_ID = '7ac4433f-258a-4e6a-bab3-44ed061b94b4';
const EVENT_ID = '72afcd23-2f61-4f25-b96d-2381c08040c4';
const EVENT_HASH = 'a'.repeat(64);
const SCOPE = { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' };

function signer(id = 'audit-key-2026-09') {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createAuditCheckpointSigner(
    id,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
}

function transactionalPool(handler: (sql: string, params: unknown[]) => Promise<unknown>) {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => handler(sql, params));
  const release = jest.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  return { pool: { connect: jest.fn(async () => client), query } as unknown as pg.Pool, query, release };
}

describe('canonical audit checkpoints', () => {
  it('signs an immutable scoped chain head without persisting private key material', async () => {
    const activeSigner = signer();
    const db = transactionalPool(async (sql, params) => {
      if (sql.includes('FROM mcp_canonical_audit_chain_heads')) {
        return { rows: [{ last_sequence: '1', last_event_hash: EVENT_HASH }] };
      }
      if (sql.includes('AND last_sequence=$4')) return { rows: [] };
      if (sql.includes('SELECT event_id, event_hash')) {
        return { rows: [{ event_id: EVENT_ID, event_hash: EVENT_HASH }] };
      }
      if (sql.includes('ORDER BY last_sequence DESC LIMIT 1 FOR UPDATE')) return { rows: [] };
      if (sql.includes('FROM mcp_canonical_audit_signing_keys WHERE')) {
        return { rows: [{
          algorithm: activeSigner.algorithm,
          public_key_pem: activeSigner.publicKeyPem,
          public_key_fingerprint: activeSigner.publicKeyFingerprint,
        }] };
      }
      if (sql.includes('INSERT INTO mcp_canonical_audit_checkpoints')) {
        return { rows: [{
          checkpoint_id: params[0], schema_version: 1,
          workspace_key: params[1], tenant_key: params[2], environment: params[3],
          last_sequence: params[4], last_event_id: params[5], last_event_hash: params[6],
          previous_checkpoint_id: params[7], previous_checkpoint_digest: params[8],
          created_at: params[9], algorithm: params[10], key_id: params[11],
          public_key_fingerprint: params[12], checkpoint_digest: params[13], signature: params[14],
        }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const checkpoint = await createCanonicalAuditCheckpoint(db.pool, SCOPE, activeSigner, {
      now: () => NOW,
      checkpointId: () => CHECKPOINT_ID,
    });

    expect(checkpoint).toMatchObject({
      checkpointId: CHECKPOINT_ID,
      lastSequence: 1,
      lastEventHash: EVENT_HASH,
      keyId: activeSigner.keyId,
      replayed: false,
    });
    expect(verifyAuditCheckpointSignature(checkpoint, activeSigner.publicKeyPem)).toBe(true);
    const calls = db.query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls.some(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(calls.some(([sql]) => sql.includes('FOR SHARE'))).toBe(true);
    expect(calls.at(-1)?.[0]).toBe('COMMIT');
    expect(JSON.stringify(calls)).not.toContain('PRIVATE KEY');
    expect(db.release).toHaveBeenCalled();
  });

  it('returns an existing checkpoint when the same chain head is certified twice', async () => {
    const activeSigner = signer();
    const existing = {
      checkpoint_id: CHECKPOINT_ID, schema_version: 1,
      workspace_key: SCOPE.workspaceKey, tenant_key: SCOPE.tenantKey, environment: SCOPE.environment,
      last_sequence: '1', last_event_id: EVENT_ID, last_event_hash: EVENT_HASH,
      previous_checkpoint_id: null, previous_checkpoint_digest: '', created_at: NOW,
      algorithm: 'Ed25519', key_id: activeSigner.keyId,
      public_key_fingerprint: activeSigner.publicKeyFingerprint,
      checkpoint_digest: 'b'.repeat(64), signature: 'signed-once',
    };
    const db = transactionalPool(async sql => {
      if (sql.includes('FROM mcp_canonical_audit_chain_heads')) {
        return { rows: [{ last_sequence: '1', last_event_hash: EVENT_HASH }] };
      }
      if (sql.includes('AND last_sequence=$4')) return { rows: [existing] };
      return { rows: [], rowCount: 1 };
    });

    await expect(createCanonicalAuditCheckpoint(db.pool, SCOPE, activeSigner))
      .resolves.toMatchObject({ checkpointId: CHECKPOINT_ID, replayed: true });
    expect(db.query.mock.calls.some(call => String(call[0]).includes('INSERT INTO mcp_canonical_audit_checkpoints'))).toBe(false);
    expect(db.query.mock.calls.map(call => call[0]).at(-1)).toBe('COMMIT');
  });

  it('supports key rotation and rejects a signature under the wrong historical key', async () => {
    const first = signer('audit-key-1');
    const second = signer('audit-key-2');
    const db = transactionalPool(async (sql, params) => {
      if (sql.includes('FROM mcp_canonical_audit_chain_heads')) {
        return { rows: [{ last_sequence: '1', last_event_hash: EVENT_HASH }] };
      }
      if (sql.includes('AND last_sequence=$4')) return { rows: [] };
      if (sql.includes('SELECT event_id, event_hash')) return { rows: [{ event_id: EVENT_ID, event_hash: EVENT_HASH }] };
      if (sql.includes('ORDER BY last_sequence DESC LIMIT 1 FOR UPDATE')) return { rows: [] };
      if (sql.includes('FROM mcp_canonical_audit_signing_keys WHERE')) {
        return { rows: [{ algorithm: second.algorithm, public_key_pem: second.publicKeyPem, public_key_fingerprint: second.publicKeyFingerprint }] };
      }
      if (sql.includes('INSERT INTO mcp_canonical_audit_checkpoints')) {
        return { rows: [{
          checkpoint_id: params[0], schema_version: 1, workspace_key: params[1], tenant_key: params[2],
          environment: params[3], last_sequence: params[4], last_event_id: params[5], last_event_hash: params[6],
          previous_checkpoint_id: params[7], previous_checkpoint_digest: params[8], created_at: params[9],
          algorithm: params[10], key_id: params[11], public_key_fingerprint: params[12],
          checkpoint_digest: params[13], signature: params[14],
        }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const checkpoint = await createCanonicalAuditCheckpoint(db.pool, SCOPE, second, {
      now: () => NOW, checkpointId: () => CHECKPOINT_ID,
    });
    expect(verifyAuditCheckpointSignature(checkpoint, second.publicKeyPem)).toBe(true);
    expect(verifyAuditCheckpointSignature(checkpoint, first.publicKeyPem)).toBe(false);
  });

  it('fails closed for ambiguous secret configuration and non-Ed25519 keys', () => {
    expect(() => loadAuditCheckpointSignerFromEnv({
      ARGUS_AUDIT_SIGNING_KEY_ID: 'key-1',
      ARGUS_AUDIT_SIGNING_PRIVATE_KEY_FILE: 'key.pem',
      ARGUS_AUDIT_SIGNING_PRIVATE_KEY: 'inline',
    })).toThrow('not both');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => createAuditCheckpointSigner(
      'rsa-key', privateKey.export({ type: 'pkcs8', format: 'pem' }),
    )).toThrow('must be Ed25519');
  });

  it('reports a missing checkpoint without attempting event verification', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const result = await verifyCanonicalAuditCheckpoint(
      { query } as unknown as pg.Pool,
      CHECKPOINT_ID,
      NOW,
    );
    expect(result).toEqual({
      state: 'not_found', checkpointId: null, checkedAt: NOW.toISOString(), verifiedEvents: 0, reason: null,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
