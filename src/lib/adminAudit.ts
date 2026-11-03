/**
 * Admin audit log helpers — shared between gateway/* and the main /api/admin/*
 * mutation routes. Writes to mcp_admin_audit_log so we have a single
 * compliance trail (NIS2/ISO27001) for every privileged action.
 *
 * Fire-and-forget: failures don't block the request, just emit a warning.
 */

import type pg from 'pg';
import type { Request } from 'express';
import { logger } from './logger.js';

export interface AdminActor {
  changedBy: string;
  changedByApiKey: string | null;
}

/** Resolve "who did this" from a session user or API key prefix on the request. */
export function getAdminActor(req: Request): AdminActor {
  const r = req as unknown as Record<string, unknown>;
  const user = r['user'] as { username?: string; display_name?: string } | undefined;
  const apiKeyPrefix = r['apiKeyPrefix'] as string | undefined;
  const changedBy = user?.username ?? user?.display_name ?? (apiKeyPrefix ? `key:${apiKeyPrefix}` : 'unknown');
  return { changedBy, changedByApiKey: apiKeyPrefix ?? null };
}

/**
 * Write an audit row for a privileged mutation. Fire-and-forget — never blocks
 * the request, never throws. Sensitive fields (password_hash, secrets) should
 * be redacted by the caller before passing to beforeState/afterState.
 */
export function writeAdminAudit(
  pool: pg.Pool,
  req: Request,
  action: string,
  tableName: string,
  objectId: string,
  objectLabel: string | null,
  beforeState?: unknown,
  afterState?: unknown,
): Promise<number | null> {
  const { changedBy, changedByApiKey } = getAdminActor(req);
  return pool.query<{ id: number | string }>(
    `INSERT INTO mcp_admin_audit_log
     (action, table_name, object_id, object_label, changed_by, changed_by_api_key, before_state, after_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      action, tableName, objectId, objectLabel ?? null,
      changedBy, changedByApiKey,
      beforeState != null ? JSON.stringify(beforeState) : null,
      afterState  != null ? JSON.stringify(afterState)  : null,
    ],
  ).then(result => {
    const id = Number(result.rows[0]?.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }).catch((err: unknown) => {
    logger.warn({ err }, 'Failed to write admin audit log');
    return null;
  });
}

/**
 * Strip sensitive keys before persisting to the audit log so we don't leak
 * password hashes / secrets / tokens into a long-lived compliance table.
 */
export function redactSensitive<T extends Record<string, unknown>>(obj: T | null | undefined): Partial<T> | null {
  if (!obj) return null;
  const SENSITIVE = new Set([
    'password', 'password_hash', 'password_confirm',
    'api_key', 'apikey', 'api_key_hash', 'key_hash', 'key',
    'secret', 'token', 'refresh_token', 'access_token',
    'client_secret',
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}
