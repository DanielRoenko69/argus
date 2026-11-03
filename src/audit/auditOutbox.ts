/**
 * auditOutbox — File-backed retry-queue für Audit-Events, deren DB-INSERT
 * scheitert (transient DB-outage, connection-pool exhaustion, etc.).
 *
 * Design:
 *   - Bei `writeImmutableAudit` Failure → `enqueueFailedAudit(entry)` appended
 *     eine Zeile zu `data/audit-outbox.jsonl`
 *   - Background-Worker `setInterval(drainOutbox, 30s)` versucht jede Zeile
 *     einzeln in die DB zu schreiben
 *   - Bei Erfolg wird die Zeile entfernt; bei Failure attempts++ und Zeile bleibt
 *   - Nach 20 Attempts wird das Event verworfen (Loud-Log)
 *   - Outbox-File hat Hard-Cap von 50MB (sonst Disk-Full bei langem Outage)
 *
 * Crash-Safety: Datei survives Process-Restart. Bei Boot wird einmal sofort
 * `drainOutbox` aufgerufen.
 *
 * Multi-Pod-Note: Jeder Pod hat seine eigene Outbox-Datei (kein gemeinsames
 * Volume nötig). Vorteil: kein Lock-Contention. Nachteil: bei Pod-Death gehen
 * Events in der File verloren. Für Prod sollte das Datenverzeichnis ein PV sein.
 */

import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import type { ImmutableAuditEntry } from './immutableAudit.js';
import { insertAuditRow } from './immutableAudit.js';

const OUTBOX_PATH = process.env['AUDIT_OUTBOX_PATH']
  ?? path.join(process.cwd(), 'data', 'audit-outbox.jsonl');
const DRAIN_INTERVAL_MS = parseInt(process.env['AUDIT_OUTBOX_DRAIN_INTERVAL_MS'] ?? '30000', 10);
const MAX_OUTBOX_SIZE_BYTES = 50 * 1024 * 1024;  // 50 MB
const MAX_ATTEMPTS = 20;

let drainInProgress = false;
let workerHandle: NodeJS.Timeout | null = null;

interface OutboxRow {
  entry: ImmutableAuditEntry;
  enqueuedAt: string;  // ISO-8601, ursprünglicher Event-Zeitpunkt
  attempts: number;
}

/** Append a failed audit event to the outbox file. Never throws. */
export function enqueueFailedAudit(entry: ImmutableAuditEntry, _now: () => number = Date.now): void {
  try {
    fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });

    // Size cap — drop events when outbox grows pathologically (multi-day DB-outage).
    // Without this, disk fills up and the whole pod dies.
    try {
      const st = fs.statSync(OUTBOX_PATH);
      if (st.size >= MAX_OUTBOX_SIZE_BYTES) {
        logger.error(
          { sizeBytes: st.size, limitBytes: MAX_OUTBOX_SIZE_BYTES, eventType: entry.eventType },
          'audit outbox at size limit — dropping event (DB is likely down for extended time)',
        );
        return;
      }
    } catch { /* file doesn't exist yet, that's fine */ }

    const row: OutboxRow = {
      entry,
      enqueuedAt: new Date(_now()).toISOString(),
      attempts: 0,
    };
    fs.appendFileSync(OUTBOX_PATH, JSON.stringify(row) + '\n');
  } catch (err) {
    // Disk full / permission denied / etc. — event is unfortunately lost.
    logger.error({ err: String(err), path: OUTBOX_PATH }, 'audit outbox enqueue failed — event lost');
  }
}

/**
 * Read the outbox, attempt to insert each entry to DB, rewrite file with
 * remaining (failed-retry) entries. Returns counts for observability.
 *
 * Skipped (returns 0/0) when another drain is already in flight.
 */
export async function drainOutbox(pool: pg.Pool): Promise<{ drained: number; failed: number; dropped: number }> {
  if (drainInProgress) return { drained: 0, failed: 0, dropped: 0 };
  drainInProgress = true;
  try {
    if (!fs.existsSync(OUTBOX_PATH)) return { drained: 0, failed: 0, dropped: 0 };

    const content = fs.readFileSync(OUTBOX_PATH, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    let drained = 0, dropped = 0;
    const remaining: string[] = [];

    for (const line of lines) {
      let row: OutboxRow;
      try {
        row = JSON.parse(line) as OutboxRow;
        if (!row || !row.entry || !row.entry.eventType) throw new Error('malformed row');
      } catch {
        // Corrupt line — log and skip (don't put back, would loop forever)
        logger.warn({ line: line.slice(0, 200) }, 'audit outbox: dropping corrupt line');
        dropped++;
        continue;
      }

      try {
        const originalAt = row.enqueuedAt ? new Date(row.enqueuedAt) : undefined;
        await insertAuditRow(pool, row.entry, originalAt);
        drained++;
      } catch (err) {
        row.attempts = (row.attempts ?? 0) + 1;
        if (row.attempts < MAX_ATTEMPTS) {
          remaining.push(JSON.stringify(row));
        } else {
          logger.error(
            { entry: row.entry, attempts: row.attempts, lastErr: String(err) },
            'audit outbox entry dropped after MAX_ATTEMPTS — permanent loss',
          );
          dropped++;
        }
      }
    }

    // Rewrite outbox atomically: write to .tmp, rename. Avoids
    // half-written files if process dies mid-write.
    if (remaining.length === 0) {
      try { fs.unlinkSync(OUTBOX_PATH); } catch { /* already gone */ }
    } else {
      const tmp = OUTBOX_PATH + '.tmp';
      fs.writeFileSync(tmp, remaining.join('\n') + '\n');
      fs.renameSync(tmp, OUTBOX_PATH);
    }

    if (drained > 0 || dropped > 0) {
      logger.info({ drained, retried: remaining.length, dropped }, 'audit outbox drained');
    }
    return { drained, failed: remaining.length, dropped };
  } finally {
    drainInProgress = false;
  }
}

/** Start the periodic drain worker. Idempotent. */
export function startAuditOutboxWorker(pool: pg.Pool): void {
  if (workerHandle) return;
  // Immediate drain on startup — process previously-queued events ASAP
  drainOutbox(pool).catch(err => logger.warn({ err: String(err) }, 'audit outbox initial drain failed'));
  workerHandle = setInterval(() => {
    drainOutbox(pool).catch(err => logger.warn({ err: String(err) }, 'audit outbox drain failed'));
  }, DRAIN_INTERVAL_MS);
  workerHandle.unref();
  logger.info({ path: OUTBOX_PATH, intervalMs: DRAIN_INTERVAL_MS }, 'audit outbox worker started');
}

/** Stop the drain worker (for tests + clean shutdown). */
export function stopAuditOutboxWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
}

/** For tests. */
export function _outboxPath(): string { return OUTBOX_PATH; }
