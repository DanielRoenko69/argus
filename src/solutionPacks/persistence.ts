import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  SolutionPackDiscoveryResult,
  SolutionPackDiscoveryState,
  SolutionPackRollbackRequest,
  SolutionPackRollbackRequestInput,
  SolutionPackRegistryPersistence,
} from './discovery.js';

type PersistedPackRow = {
  pack_id: string;
  endpoint: string;
  state: SolutionPackDiscoveryState;
  checked_at: Date | string | null;
  observed_version: string | null;
  observed_manifest: SolutionPackDiscoveryResult['manifest'] | null;
  health: SolutionPackDiscoveryResult['health'] | null;
  readiness: SolutionPackDiscoveryResult['readiness'] | null;
  error: string | null;
  previous_version: string | null;
  previous_manifest: SolutionPackDiscoveryResult['manifest'] | null;
  revision: number;
};

type RollbackRequestRow = {
  id: string;
  pack_id: string;
  requested_by: string;
  reason: string;
  source_revision: number;
  current_version: string | null;
  target_version: string;
  target_manifest: SolutionPackRollbackRequest['targetManifest'];
  status: SolutionPackRollbackRequest['status'];
  error: string | null;
  requested_at: Date | string;
  updated_at: Date | string;
  applied_at: Date | string | null;
  claimed_by: string | null;
  claimed_at: Date | string | null;
  claim_expires_at: Date | string | null;
};

function rollbackRequestFromRow(row: RollbackRequestRow): SolutionPackRollbackRequest {
  return {
    id: row.id,
    packId: row.pack_id,
    requestedBy: row.requested_by,
    reason: row.reason,
    sourceRevision: Number(row.source_revision),
    currentVersion: row.current_version,
    targetVersion: row.target_version,
    targetManifest: row.target_manifest,
    status: row.status,
    error: row.error,
    requestedAt: new Date(row.requested_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    claimExpiresAt: row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null,
  };
}

/**
 * Stores the last observed Pack contract without storing service credentials.
 * The environment remains authoritative for endpoint/token configuration;
 * PostgreSQL only provides durable installation and reconciliation evidence.
 */
export class SolutionPackPostgresStore implements SolutionPackRegistryPersistence {
  constructor(private readonly pool: pg.Pool) {}

  async load(packIds: string[]): Promise<SolutionPackDiscoveryResult[]> {
    if (packIds.length === 0) return [];
    const result = await this.pool.query<PersistedPackRow>(
      `SELECT pack_id, endpoint, state, checked_at, observed_version,
              observed_manifest, health, readiness, error,
              previous_version, previous_manifest, revision
         FROM argus_solution_pack_installations
        WHERE pack_id = ANY($1::text[])`,
      [packIds],
    );
    return result.rows.map(row => ({
      configuredId: row.pack_id,
      endpoint: row.endpoint,
      state: row.state,
      checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null,
      ...(row.observed_manifest ? { manifest: row.observed_manifest } : {}),
      ...(row.health ? { health: row.health } : {}),
      ...(row.readiness ? { readiness: row.readiness } : {}),
      ...(row.error ? { error: row.error } : {}),
      revision: Number(row.revision ?? 0),
      ...(row.previous_version ? { previousVersion: row.previous_version } : {}),
      ...(row.previous_manifest ? { previousManifest: row.previous_manifest } : {}),
    }));
  }

  async save(results: SolutionPackDiscoveryResult[]): Promise<void> {
    for (const result of results) {
      const version = result.manifest?.metadata.version ?? null;
      await this.pool.query(
        `INSERT INTO argus_solution_pack_installations
           (pack_id, endpoint, state, checked_at, observed_version,
            observed_manifest, health, readiness, error, revision, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, 1, NOW())
         ON CONFLICT (pack_id) DO UPDATE SET
           endpoint = EXCLUDED.endpoint,
           state = EXCLUDED.state,
           checked_at = EXCLUDED.checked_at,
           observed_version = EXCLUDED.observed_version,
           observed_manifest = EXCLUDED.observed_manifest,
           health = EXCLUDED.health,
           readiness = EXCLUDED.readiness,
           error = EXCLUDED.error,
           previous_version = CASE
             WHEN argus_solution_pack_installations.observed_version IS DISTINCT FROM EXCLUDED.observed_version
               THEN argus_solution_pack_installations.observed_version
             ELSE argus_solution_pack_installations.previous_version
           END,
           previous_manifest = CASE
             WHEN argus_solution_pack_installations.observed_version IS DISTINCT FROM EXCLUDED.observed_version
               THEN argus_solution_pack_installations.observed_manifest
             ELSE argus_solution_pack_installations.previous_manifest
           END,
           revision = argus_solution_pack_installations.revision + 1,
           updated_at = NOW()`,
        [
          result.configuredId,
          result.endpoint,
          result.state,
          result.checkedAt,
          version,
          JSON.stringify(result.manifest ?? null),
          JSON.stringify(result.health ?? null),
          JSON.stringify(result.readiness ?? null),
          result.error ?? null,
        ],
      );
    }
  }

  async createRollbackRequest(input: SolutionPackRollbackRequestInput): Promise<SolutionPackRollbackRequest> {
    const id = randomUUID();
    const result = await this.pool.query<RollbackRequestRow>(
      `INSERT INTO argus_solution_pack_rollback_requests
         (id, pack_id, requested_by, reason, source_revision, current_version,
          target_version, target_manifest, status, requested_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending', NOW(), NOW())
       RETURNING id, pack_id, requested_by, reason, source_revision, current_version,
                 target_version, target_manifest, status, error,
                 requested_at, updated_at, applied_at, claimed_by, claimed_at, claim_expires_at`,
      [
        id,
        input.packId,
        input.requestedBy,
        input.reason,
        input.sourceRevision,
        input.currentVersion,
        input.targetVersion,
        JSON.stringify(input.targetManifest),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('rollback request was not returned by PostgreSQL');
    return rollbackRequestFromRow(row);
  }

  async listRollbackRequests(
    status: SolutionPackRollbackRequest['status'] = 'pending',
    limit = 20,
  ): Promise<SolutionPackRollbackRequest[]> {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const result = await this.pool.query<RollbackRequestRow>(
      `SELECT id, pack_id, requested_by, reason, source_revision, current_version,
              target_version, target_manifest, status, error,
              requested_at, updated_at, applied_at, claimed_by, claimed_at, claim_expires_at
         FROM argus_solution_pack_rollback_requests
        WHERE status = $1
        ORDER BY requested_at ASC
        LIMIT $2`,
      [status, boundedLimit],
    );
    return result.rows.map(rollbackRequestFromRow);
  }

  async listRollbackRequestsForPack(packId: string, limit = 20): Promise<SolutionPackRollbackRequest[]> {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const result = await this.pool.query<RollbackRequestRow>(
      `SELECT id, pack_id, requested_by, reason, source_revision, current_version,
              target_version, target_manifest, status, error,
              requested_at, updated_at, applied_at, claimed_by, claimed_at, claim_expires_at
         FROM argus_solution_pack_rollback_requests
        WHERE pack_id = $1
        ORDER BY requested_at DESC
        LIMIT $2`,
      [packId, boundedLimit],
    );
    return result.rows.map(rollbackRequestFromRow);
  }

  async claimRollbackRequest(id: string, workerId: string, leaseSeconds = 300): Promise<SolutionPackRollbackRequest | null> {
    const requestedLeaseSeconds = Number.isFinite(leaseSeconds) ? Math.trunc(leaseSeconds) : 300;
    const boundedLeaseSeconds = Math.min(3600, Math.max(30, requestedLeaseSeconds));
    const result = await this.pool.query<RollbackRequestRow>(
      `UPDATE argus_solution_pack_rollback_requests
          SET status = 'accepted', claimed_by = $2, claimed_at = NOW(),
              claim_expires_at = NOW() + ($3 * INTERVAL '1 second'), updated_at = NOW()
        WHERE id = $1::uuid
          AND (status = 'pending' OR (status = 'accepted' AND (claim_expires_at IS NULL OR claim_expires_at < NOW())))
      RETURNING id, pack_id, requested_by, reason, source_revision, current_version,
                target_version, target_manifest, status, error,
                requested_at, updated_at, applied_at, claimed_by, claimed_at, claim_expires_at`,
      [id, workerId, boundedLeaseSeconds],
    );
    const row = result.rows[0];
    return row ? rollbackRequestFromRow(row) : null;
  }

  async completeRollbackRequest(
    id: string,
    workerId: string,
    status: Extract<SolutionPackRollbackRequest['status'], 'applied' | 'failed'>,
    error: string | null,
  ): Promise<SolutionPackRollbackRequest | null> {
    const result = await this.pool.query<RollbackRequestRow>(
      `UPDATE argus_solution_pack_rollback_requests
          SET status = $2, error = $3,
              applied_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE applied_at END,
              updated_at = NOW()
        WHERE id = $1::uuid AND status = 'accepted' AND claimed_by = $4
      RETURNING id, pack_id, requested_by, reason, source_revision, current_version,
                target_version, target_manifest, status, error,
                requested_at, updated_at, applied_at, claimed_by, claimed_at, claim_expires_at`,
      [id, status, error, workerId],
    );
    const row = result.rows[0];
    return row ? rollbackRequestFromRow(row) : null;
  }
}
