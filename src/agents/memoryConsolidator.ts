/**
 * memoryConsolidator — background pruning of near-duplicate agent memories.
 *
 * Argus's storeMemory already has Mem0-style contradiction handling
 * (threshold 0.88) per-write. But over time:
 *  - Same fact stored with slightly different wording → falls below 0.88
 *  - Concurrent writes race past the dedup check
 *  - Episodic memories accumulate that should've been pruned
 *
 * This job runs periodically and removes near-duplicate pairs at a HIGHER
 * threshold (0.94 default) — keeping the newer entry, deleting the older.
 *
 * v1 = exact-duplicate-prune (no LLM). v2 could add cluster-then-summarize
 * for true consolidation of semantically-related-but-not-identical facts.
 *
 * Run via setInterval in src/index.ts (default: every 24h). Manual trigger
 * via POST /api/admin/memory/consolidate.
 */

import type pg from 'pg';
import { logger } from '../lib/logger.js';

export interface ConsolidationResult {
  agentsScanned: number;
  pairsFound: number;
  duplicatesRemoved: number;
  durationMs: number;
}

/**
 * Run one consolidation pass across all agents.
 *
 * Threshold guidance:
 *  - 0.94: very conservative — only obvious dupes (recommended default)
 *  - 0.92: medium — catches paraphrases
 *  - 0.88: aggressive (matches storeMemory contradiction threshold)
 *
 * Excludes 'working' memories — those are session-scoped and pruned on
 * session-end. Only 'semantic' and 'procedural' are long-lived enough
 * to benefit from consolidation. 'episodic' is also included since old
 * episodic memories with valid_until set are auto-pruned separately.
 */
export async function consolidateMemoriesOnce(
  pool: pg.Pool,
  opts: { threshold?: number; dryRun?: boolean } = {},
): Promise<ConsolidationResult> {
  const threshold = opts.threshold ?? 0.94;
  const start = Date.now();

  // Pairwise SQL: for each pair (a, b) with a.id > b.id (avoid 2x work),
  // same agent + same kind, similarity > threshold.
  // Uses halfvec HNSW from Mig 084 for performance.
  const { rows: pairs } = await pool.query<{
    keep_id: number;
    drop_id: number;
    sim: number;
    agent_id: number;
  }>(
    `SELECT
       CASE WHEN a.created_at >= b.created_at THEN a.id ELSE b.id END AS keep_id,
       CASE WHEN a.created_at >= b.created_at THEN b.id ELSE a.id END AS drop_id,
       (1 - (a.embedding <=> b.embedding))::float AS sim,
       a.agent_id
     FROM mcp_agent_memory a
     JOIN mcp_agent_memory b
       ON b.id < a.id
      AND b.agent_id     = a.agent_id
      AND b.memory_type  = a.memory_type
      AND b.memory_type IN ('semantic', 'procedural', 'episodic')
     WHERE (1 - (a.embedding <=> b.embedding)) > $1
     ORDER BY sim DESC`,
    [threshold],
  );

  if (pairs.length === 0) {
    return {
      agentsScanned: 0,
      pairsFound: 0,
      duplicatesRemoved: 0,
      durationMs: Date.now() - start,
    };
  }

  // Multi-pair handling: if memory M is paired with N AND with O, we'd
  // delete M twice. Build a set of drop-ids, but skip drops that are
  // already in the keep-set of an earlier pair.
  const toDelete = new Set<number>();
  const survivors = new Set<number>();

  for (const p of pairs) {
    // If drop already survivor from earlier pair, skip — chains converge
    if (survivors.has(p.drop_id)) continue;
    if (toDelete.has(p.keep_id)) continue;   // keep would be deleted by earlier pair
    toDelete.add(p.drop_id);
    survivors.add(p.keep_id);
  }

  const agentIds = new Set(pairs.map(p => p.agent_id));

  if (opts.dryRun) {
    logger.info({
      agentsScanned: agentIds.size,
      pairsFound: pairs.length,
      wouldRemove: toDelete.size,
      threshold,
    }, 'memoryConsolidator: dry-run');
    return {
      agentsScanned: agentIds.size,
      pairsFound: pairs.length,
      duplicatesRemoved: 0,
      durationMs: Date.now() - start,
    };
  }

  if (toDelete.size > 0) {
    await pool.query('DELETE FROM mcp_agent_memory WHERE id = ANY($1)', [Array.from(toDelete)]);
  }

  const durationMs = Date.now() - start;
  logger.info({
    agentsScanned: agentIds.size,
    pairsFound: pairs.length,
    duplicatesRemoved: toDelete.size,
    threshold,
    durationMs,
  }, 'memoryConsolidator: pass complete');

  return {
    agentsScanned: agentIds.size,
    pairsFound: pairs.length,
    duplicatesRemoved: toDelete.size,
    durationMs,
  };
}

/**
 * Start periodic consolidation in the background.
 * Returns the timer handle so a caller can clearInterval on shutdown.
 */
export function startMemoryConsolidator(pool: pg.Pool, intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  // Run once 10 minutes after start (gives Argus time to settle),
  // then on the configured interval.
  const initial = setTimeout(() => {
    consolidateMemoriesOnce(pool).catch(err => {
      logger.warn({ err: String(err) }, 'memoryConsolidator initial run failed');
    });
  }, 10 * 60 * 1000);
  initial.unref();

  const timer = setInterval(() => {
    consolidateMemoriesOnce(pool).catch(err => {
      logger.warn({ err: String(err) }, 'memoryConsolidator scheduled run failed');
    });
  }, intervalMs);
  timer.unref();

  logger.info({ intervalHours: intervalMs / 3_600_000 }, 'memoryConsolidator scheduled');
  return timer;
}
