-- The log sink belongs to the Argus platform, not to the retired LLM gateway.
DO $$
BEGIN
  IF to_regclass('public.gateway_logs') IS NOT NULL
     AND to_regclass('public.argus_logs') IS NULL THEN
    ALTER TABLE gateway_logs RENAME TO argus_logs;
  END IF;
END $$;

ALTER INDEX IF EXISTS idx_gateway_logs_ts RENAME TO idx_argus_logs_ts;
ALTER INDEX IF EXISTS idx_gateway_logs_level RENAME TO idx_argus_logs_level;
ALTER INDEX IF EXISTS idx_gateway_logs_tool RENAME TO idx_argus_logs_tool;

COMMENT ON TABLE argus_logs IS 'Structured operational logs emitted by Argus.';
