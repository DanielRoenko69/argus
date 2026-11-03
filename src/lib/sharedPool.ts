/**
 * sharedPool — module-level singleton for the gateway-wide pg.Pool, set once
 * at boot by index.ts. Avoids circular imports between deep tool-execution
 * code (customBackends) and index.ts.
 */

import type pg from 'pg';

let pool: pg.Pool | null = null;

export function setSharedPool(p: pg.Pool | null): void {
  pool = p;
}

export function getSharedPool(): pg.Pool | null {
  return pool;
}
