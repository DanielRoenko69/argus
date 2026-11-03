import type pg from 'pg';
import { logger } from '../lib/logger.js';
import {
  canonicalAuditCheckpointSequenceGauge,
  canonicalAuditIntegrityGauge,
  canonicalAuditOutboxOldestAgeGauge,
  canonicalAuditOutboxPendingGauge,
} from '../lib/metrics.js';
import {
  createCanonicalAuditCheckpoint,
  loadLatestCanonicalAuditCheckpointEnvelope,
  verifyCanonicalAuditCheckpoint,
  type AuditCheckpointScope,
  type AuditCheckpointSigner,
} from './checkpoints.js';

export type AuditIntegrityState = 'valid' | 'unsigned' | 'signature_invalid' | 'chain_invalid' | 'checkpoint_lag';

export interface AuditIntegrityScopeResult {
  scope: AuditCheckpointScope;
  state: AuditIntegrityState;
  headSequence: number;
  checkpointSequence: number | null;
  checkpointId: string | null;
  reason: string | null;
}

export interface AuditIntegrityCycleResult {
  checkedAt: string;
  scopes: AuditIntegrityScopeResult[];
  outbox: { pending: number; oldestAgeSeconds: number; lagging: boolean };
}

export interface AuditIntegrityCycleOptions {
  signer?: AuditCheckpointSigner | null;
  now?: () => Date;
  outboxLagAlertSec?: number;
  maxScopes?: number;
}

export async function runCanonicalAuditIntegrityCycle(
  pool: pg.Pool,
  options: AuditIntegrityCycleOptions = {},
): Promise<AuditIntegrityCycleResult> {
  const now = (options.now ?? (() => new Date()))();
  const maxScopes = Math.min(Math.max(options.maxScopes ?? 1_000, 1), 10_000);
  const scopeRows = await pool.query<{
    workspace_key: string; tenant_key: string; environment: string; last_sequence: number | string;
  }>(
    `SELECT workspace_key, tenant_key, environment, last_sequence
       FROM mcp_canonical_audit_chain_heads
      WHERE last_sequence>0
      ORDER BY workspace_key, tenant_key, environment
      LIMIT $1`,
    [maxScopes],
  );
  const scopes: AuditIntegrityScopeResult[] = [];
  for (const row of scopeRows.rows) {
    const scope = { workspaceKey: row.workspace_key, tenantKey: row.tenant_key, environment: row.environment };
    const headSequence = Number(row.last_sequence);
    try {
      if (options.signer) await createCanonicalAuditCheckpoint(pool, scope, options.signer, { now: () => now });
      const envelope = await loadLatestCanonicalAuditCheckpointEnvelope(pool, scope);
      if (!envelope) {
        scopes.push({ scope, state: 'unsigned', headSequence, checkpointSequence: null, checkpointId: null, reason: 'checkpoint_missing' });
        continue;
      }
      const verification = await verifyCanonicalAuditCheckpoint(pool, envelope.checkpoint.checkpointId, now);
      const checkpointSequence = envelope.checkpoint.lastSequence;
      let state: AuditIntegrityState = 'valid';
      if (verification.state !== 'valid') {
        state = verification.reason === 'checkpoint_signature_invalid' ? 'signature_invalid' : 'chain_invalid';
      } else if (checkpointSequence < headSequence) {
        state = 'checkpoint_lag';
      }
      scopes.push({
        scope, state, headSequence, checkpointSequence,
        checkpointId: envelope.checkpoint.checkpointId, reason: verification.reason,
      });
    } catch (error) {
      scopes.push({
        scope, state: 'chain_invalid', headSequence, checkpointSequence: null, checkpointId: null,
        reason: error instanceof Error ? error.message.slice(0, 256) : 'integrity_cycle_failed',
      });
    }
  }
  const outboxResult = await pool.query<{ pending: number | string; oldest_age_seconds: number | string | null }>(
    `SELECT count(*)::text AS pending,
            COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at))), 0)::text AS oldest_age_seconds
       FROM mcp_canonical_audit_outbox
      WHERE delivered_at IS NULL`,
  );
  const pending = Number(outboxResult.rows[0]?.pending ?? 0);
  const oldestAgeSeconds = Math.max(0, Number(outboxResult.rows[0]?.oldest_age_seconds ?? 0));
  const lagging = pending > 0 && oldestAgeSeconds >= (options.outboxLagAlertSec ?? 300);

  canonicalAuditIntegrityGauge.reset();
  for (const result of scopes) {
    canonicalAuditIntegrityGauge.set({ environment: result.scope.environment, state: result.state }, 1);
    if (result.checkpointSequence != null) {
      canonicalAuditCheckpointSequenceGauge.set({ environment: result.scope.environment }, result.checkpointSequence);
    }
    if (result.state !== 'valid') {
      logger.error({
        environment: result.scope.environment,
        state: result.state,
        headSequence: result.headSequence,
        checkpointSequence: result.checkpointSequence,
        checkpointId: result.checkpointId,
        reason: result.reason,
      }, 'Canonical audit integrity alert');
    }
  }
  canonicalAuditOutboxPendingGauge.set(pending);
  canonicalAuditOutboxOldestAgeGauge.set(oldestAgeSeconds);
  if (lagging) {
    logger.error({ pending, oldestAgeSeconds }, 'Canonical audit outbox lag alert');
  }
  return { checkedAt: now.toISOString(), scopes, outbox: { pending, oldestAgeSeconds, lagging } };
}

export function startCanonicalAuditIntegrityMonitor(
  pool: pg.Pool,
  options: AuditIntegrityCycleOptions & { intervalSec: number },
): { stop(): void; runNow(): Promise<AuditIntegrityCycleResult> } {
  let active = false;
  const runNow = async () => {
    if (active) throw new Error('canonical audit integrity cycle is already running');
    active = true;
    try {
      return await runCanonicalAuditIntegrityCycle(pool, options);
    } finally {
      active = false;
    }
  };
  const timer = setInterval(() => {
    void runNow().catch(error => logger.error({ err: error }, 'Canonical audit integrity monitor failed'));
  }, Math.max(60, options.intervalSec) * 1_000);
  timer.unref();
  void runNow().catch(error => logger.error({ err: error }, 'Initial canonical audit integrity monitor failed'));
  return { stop: () => clearInterval(timer), runNow };
}
