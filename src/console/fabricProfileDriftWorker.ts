import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { appendCanonicalAuditEvent } from '../audit/canonicalAuditStore.js';
import { logger } from '../lib/logger.js';
import {
  detectFabricProfileDrift,
  listFabricProfiles,
  persistFabricProfileDriftSnapshot,
  type FabricProfileDrift,
  type FabricProfileDriftPersistenceResult,
  type FabricProfileRecord,
} from './fabricProfiles.js';
import {
  observeFabricProfileOperation,
  recordFabricProfileDriftFindings,
  recordFabricProfileDriftNotification,
  recordFabricProfileDriftTransition,
  type FabricProfileTelemetryContext,
} from './fabricProfileTelemetry.js';

const WORKER_LOCK = 'argus-mcp-fabric-profile-drift';
const FAILURE_NOTIFICATION_THRESHOLD = 3;
type DriftNotifier = (title: string, message: string, severity: 'info' | 'warning' | 'critical') => Promise<void>;

export interface FabricProfileDriftCycleResult {
  checkedAt: string;
  considered: number;
  checked: number;
  drifted: number;
  transitions: number;
  notifications: number;
  failures: number;
  skipped: boolean;
}

export interface FabricProfileDriftWorkerOptions {
  intervalSec: number;
  environment?: string;
  maxProfiles?: number;
}

export interface FabricProfileDriftCycleDependencies {
  listProfiles?: (pool: pg.Pool) => Promise<FabricProfileRecord[]>;
  detect?: (pool: pg.Pool, profile: FabricProfileRecord) => Promise<FabricProfileDrift>;
  persistTransition?: (
    pool: pg.Pool,
    profile: FabricProfileRecord,
    drift: FabricProfileDrift,
    environment: string,
    requestId: string,
    telemetry: FabricProfileTelemetryContext,
  ) => Promise<FabricProfileDriftPersistenceResult>;
  notify?: DriftNotifier;
  now?: () => Date;
}

function transitionAction(
  drift: FabricProfileDrift,
  persistence: FabricProfileDriftPersistenceResult,
): string {
  if (drift.status === 'drifted') {
    return persistence.previousStatus === 'drifted'
      ? 'mcp.fabric_profile.drift_changed'
      : 'mcp.fabric_profile.drift_detected';
  }
  if (persistence.previousStatus === 'drifted') return 'mcp.fabric_profile.drift_resolved';
  return 'mcp.fabric_profile.drift_baseline_observed';
}

function shouldNotifyTransition(
  drift: FabricProfileDrift,
  persistence: FabricProfileDriftPersistenceResult,
): boolean {
  return persistence.transitioned
    && (drift.status === 'drifted' || persistence.previousStatus === 'drifted');
}

function transitionNotification(
  profile: FabricProfileRecord,
  drift: FabricProfileDrift,
  persistence: FabricProfileDriftPersistenceResult,
): { title: string; message: string; severity: 'info' | 'warning' | 'critical' } {
  if (drift.status !== 'drifted') {
    return {
      title: `Bundle Set recovered: ${profile.label}`,
      message: `The applied MCP Fabric baseline is back in sync. Profile ${profile.name}, revision ${drift.profileRevision}.`,
      severity: 'info',
    };
  }
  const codes = [...new Set(drift.findings.map(finding => finding.code))].slice(0, 8);
  return {
    title: `${persistence.previousStatus === 'drifted' ? 'Bundle Set drift changed' : 'Bundle Set drift detected'}: ${profile.label}`,
    message: `${drift.counts.total} finding${drift.counts.total === 1 ? '' : 's'} (${drift.counts.critical} critical, ${drift.counts.warning} warning). ${codes.join(', ')}. Review the Bundle Set in MCP Fabric before reconciling.`,
    severity: drift.counts.critical > 0 ? 'critical' : 'warning',
  };
}

async function persistScheduledTransition(
  pool: pg.Pool,
  profile: FabricProfileRecord,
  drift: FabricProfileDrift,
  environment: string,
  requestId: string,
  telemetry: FabricProfileTelemetryContext,
): Promise<FabricProfileDriftPersistenceResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const persistence = await persistFabricProfileDriftSnapshot(client, drift, 'scheduled');
    if (persistence.transitioned) {
      await appendCanonicalAuditEvent(client, {
        producer: {
          name: 'mcp.fabric.profile.drift-worker',
          eventId: `profile:${profile.id}:transition:${persistence.snapshot.transitionSequence}`,
        },
        occurredAt: drift.checkedAt,
        environment,
        workspaceKey: 'default',
        tenantKey: 'default',
        solution: 'argus.core',
        actor: {
          type: 'system',
          id: 'mcp-fabric-profile-drift-worker',
          authMethod: 'internal',
          effectiveRoles: ['system'],
        },
        action: transitionAction(drift, persistence),
        outcome: 'success',
        risk: drift.counts.critical > 0 ? 'critical' : drift.counts.warning > 0 ? 'high' : 'low',
        resource: {
          type: 'mcp_fabric_profile',
          id: String(profile.id),
          revision: drift.manifestDigest,
        },
        policy: {
          id: 'argus.mcp-fabric.portable-profile-drift',
          version: '1',
          decision: drift.status,
        },
        correlation: {
          traceId: telemetry.traceId,
          spanId: telemetry.spanId,
          requestId,
        },
        payload: {
          before: {
            status: persistence.previousStatus,
            findingDigest: persistence.previousFindingDigest,
          },
          after: {
            status: drift.status,
            counts: drift.counts,
            findingDigest: persistence.snapshot.findingDigest,
            findingCodes: [...new Set(drift.findings.map(finding => finding.code))],
            profileRevision: drift.profileRevision,
            manifestDigest: drift.manifestDigest,
          },
          context: { checkSource: 'scheduled' },
        },
        retentionClass: 'business-audit-governance',
      });
    }
    await client.query('COMMIT');
    return persistence;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function markNotificationAttempted(
  pool: pg.Pool,
  profileId: number,
  transitionSequence: number,
): Promise<void> {
  await pool.query(
    `UPDATE mcp_fabric_profile_drift_state
        SET notified_at=now(), updated_at=now()
      WHERE profile_id=$1 AND transition_sequence=$2`,
    [profileId, transitionSequence],
  );
}

async function recordCheckFailure(
  pool: pg.Pool,
  profile: FabricProfileRecord,
): Promise<{ consecutiveFailures: number; notificationPending: boolean }> {
  const emptyFindingDigest = createHash('sha256').update('[]').digest('hex');
  const { rows } = await pool.query<{
    consecutive_failures: number | string;
    last_error_notified_at: Date | string | null;
  }>(
    `INSERT INTO mcp_fabric_profile_drift_state (
       profile_id, profile_revision, manifest_digest, status,
       finding_count, critical_count, warning_count, findings, finding_digest,
       check_source, transition_sequence, consecutive_failures,
       last_error_code, last_error_at, checked_at, changed_at, updated_at
     ) VALUES ($1,$2,$3,'not_applied',0,0,0,'[]'::jsonb,$4,'scheduled',1,1,
               'drift_check_failed',now(),now(),now(),now())
     ON CONFLICT (profile_id) DO UPDATE SET
       consecutive_failures=mcp_fabric_profile_drift_state.consecutive_failures+1,
       last_error_code='drift_check_failed', last_error_at=now(), updated_at=now()
     RETURNING consecutive_failures, last_error_notified_at`,
    [profile.id, profile.revision, profile.manifestDigest, emptyFindingDigest],
  );
  const consecutiveFailures = Number(rows[0]?.consecutive_failures ?? 0);
  return {
    consecutiveFailures,
    notificationPending: consecutiveFailures >= FAILURE_NOTIFICATION_THRESHOLD
      && rows[0]?.last_error_notified_at == null,
  };
}

async function markFailureNotificationAttempted(pool: pg.Pool, profileId: number): Promise<void> {
  await pool.query(
    `UPDATE mcp_fabric_profile_drift_state
        SET last_error_notified_at=now(), updated_at=now()
      WHERE profile_id=$1 AND consecutive_failures >= $2`,
    [profileId, FAILURE_NOTIFICATION_THRESHOLD],
  );
}

export async function runFabricProfileDriftCycle(
  pool: pg.Pool,
  options: Pick<FabricProfileDriftWorkerOptions, 'environment' | 'maxProfiles'> = {},
  dependencies: FabricProfileDriftCycleDependencies = {},
): Promise<FabricProfileDriftCycleResult> {
  const lockClient = await pool.connect();
  const now = dependencies.now?.() ?? new Date();
  const result: FabricProfileDriftCycleResult = {
    checkedAt: now.toISOString(), considered: 0, checked: 0, drifted: 0,
    transitions: 0, notifications: 0, failures: 0, skipped: false,
  };
  try {
    const lock = await lockClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      [WORKER_LOCK],
    );
    if (!lock.rows[0]?.acquired) return { ...result, skipped: true };
    return await observeFabricProfileOperation('drift_sweep', async telemetry => {
      const listProfiles = dependencies.listProfiles ?? (candidatePool => listFabricProfiles(candidatePool));
      const detect = dependencies.detect ?? ((candidatePool, profile) => detectFabricProfileDrift(candidatePool, profile));
      const persistTransition = dependencies.persistTransition ?? persistScheduledTransition;
      const notify: DriftNotifier = dependencies.notify ?? (async (title, message, severity) => {
        const notifications = await import('../lib/notifications.js');
        await notifications.sendNotification(title, message, severity);
      });
      const environment = options.environment ?? process.env['NODE_ENV'] ?? 'development';
      const maxProfiles = Math.min(Math.max(options.maxProfiles ?? 200, 1), 1_000);
      const profiles = (await listProfiles(pool))
        .filter(profile => profile.source === 'imported' && profile.lastAppliedAt != null)
        .slice(0, maxProfiles);
      result.considered = profiles.length;
      const requestId = `fabric-profile-drift:${randomUUID()}`;
      for (const profile of profiles) {
        try {
          const drift = await detect(pool, profile);
          const persistence = await persistTransition(pool, profile, drift, environment, requestId, telemetry);
          result.checked++;
          if (drift.status === 'drifted') result.drifted++;
          if (persistence.transitioned) {
            result.transitions++;
            recordFabricProfileDriftTransition(drift.status);
          }
          recordFabricProfileDriftFindings(drift.status, drift.counts.total);
          if (shouldNotifyTransition(drift, persistence)) {
            const notification = transitionNotification(profile, drift, persistence);
            const notificationKind = drift.status === 'drifted' ? 'drift' : 'recovery';
            try {
              await notify(notification.title, notification.message, notification.severity);
              await markNotificationAttempted(pool, profile.id, persistence.snapshot.transitionSequence);
              recordFabricProfileDriftNotification(notificationKind, 'success');
              result.notifications++;
            } catch (error) {
              recordFabricProfileDriftNotification(notificationKind, 'failure');
              logger.warn({ err: error, fabricProfileId: profile.id }, 'MCP Fabric profile drift notification failed');
            }
          }
        } catch (error) {
          result.failures++;
          const failureState = await recordCheckFailure(pool, profile).catch(() => ({
            consecutiveFailures: 0,
            notificationPending: false,
          }));
          if (failureState.notificationPending) {
            try {
              await notify(
                `Bundle Set drift monitoring delayed: ${profile.label}`,
                `Argus could not verify profile ${profile.name} for ${failureState.consecutiveFailures} consecutive checks. The last verified state remains visible; inspect Core logs before reconciling.`,
                'warning',
              );
              await markFailureNotificationAttempted(pool, profile.id).catch(() => undefined);
              recordFabricProfileDriftNotification('check_failure', 'success');
              result.notifications++;
            } catch (notificationError) {
              recordFabricProfileDriftNotification('check_failure', 'failure');
              logger.warn({ err: notificationError, fabricProfileId: profile.id }, 'MCP Fabric profile drift failure notification failed');
            }
          }
          logger.warn({ err: error, fabricProfileId: profile.id }, 'MCP Fabric profile drift check failed');
        }
      }
      telemetry.setAttributes({
        'argus.fabric_profile.drift.considered': result.considered,
        'argus.fabric_profile.drift.checked': result.checked,
        'argus.fabric_profile.drift.drifted': result.drifted,
        'argus.fabric_profile.drift.transitions': result.transitions,
        'argus.fabric_profile.drift.failures': result.failures,
      });
      return result;
    });
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [WORKER_LOCK]).catch(() => undefined);
    lockClient.release();
  }
}

export function startFabricProfileDriftWorker(
  pool: pg.Pool,
  options: FabricProfileDriftWorkerOptions,
): { stop(): void; runNow(): Promise<FabricProfileDriftCycleResult> } {
  let active = false;
  const runNow = async () => {
    if (active) throw new Error('MCP Fabric profile drift cycle is already running');
    active = true;
    try {
      return await runFabricProfileDriftCycle(pool, options);
    } finally {
      active = false;
    }
  };
  const intervalSec = Math.min(Math.max(Math.floor(options.intervalSec), 30), 86_400);
  const timer = setInterval(() => {
    void runNow()
      .then(cycle => {
        if (cycle.transitions || cycle.failures) logger.info(cycle, 'MCP Fabric profile drift cycle completed');
      })
      .catch(error => logger.error({ err: error }, 'MCP Fabric profile drift worker failed'));
  }, intervalSec * 1_000);
  timer.unref();
  setTimeout(() => void runNow().catch(error => logger.error({ err: error }, 'Initial MCP Fabric profile drift cycle failed')), 5_000).unref();
  logger.info({ intervalSec }, 'MCP Fabric profile drift worker started');
  return { stop: () => clearInterval(timer), runNow };
}
