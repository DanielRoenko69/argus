-- Audit #3 — cross-replica cron-tick dedup.
--
-- triggerWorker.startTriggerWorker runs a setInterval cron tick in EVERY pod.
-- The previous in-process `lastTickMinute` guard only deduped within a single
-- pod, so a scheduled workflow fired once PER REPLICA per minute. This table
-- lets exactly one pod claim each minute bucket via
--   INSERT INTO mcp_cron_ticks (tick_key) VALUES ($key)
--   ON CONFLICT (tick_key) DO NOTHING RETURNING tick_key
-- The winner gets a row back; the others conflict and skip the tick. Old rows
-- are pruned opportunistically (rows older than 1h) by runCronTick.
CREATE TABLE IF NOT EXISTS mcp_cron_ticks (
  tick_key  text PRIMARY KEY,
  fired_at  timestamptz NOT NULL DEFAULT now()
);
