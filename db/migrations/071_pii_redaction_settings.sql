-- Migration 071: PII Redaction runtime settings
--
-- Seeds mcp_gateway_settings with the master-switch + detector list + log
-- level for the PII redaction layer (see src/lib/redaction.ts).
--
-- Runtime-toggleable from Platform Settings UI: changing a row here +
-- POST /api/admin/settings/pii-redaction invalidates the in-process cache
-- so the next trace uses the new values without restart.
--
-- Env vars PII_REDACTION_* are the fallback used until the first DB load.

INSERT INTO mcp_gateway_settings (category, key, value) VALUES
  ('pii_redaction', 'enabled',   'true'::jsonb),
  ('pii_redaction', 'detectors', '["email","phone","iban","cc","k8s_token","git_token","bearer","azure_key","aws_key","argus_key","password","empid"]'::jsonb),
  ('pii_redaction', 'log_level', '"count"'::jsonb)
ON CONFLICT (category, key) DO NOTHING;
