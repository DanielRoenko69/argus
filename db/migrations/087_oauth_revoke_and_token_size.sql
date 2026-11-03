-- Migration 087: Upstream-Token-Hardening (Security-Findings M5 + L8)
--
-- M5: oauth_revoke_url für best-effort Upstream-Revoke beim Disconnect.
--     Manche Backends (Bitbucket, Atlassian) bieten /oauth2/revoke an. Ohne diesen
--     Call lebt der Token am Upstream weiter bis zur natürlichen Expiry → DSGVO-Risiko.
--
-- L8: CHECK constraint auf Token-Größe (DB-Bloat-Schutz gegen pathologische
--     OAuth-Server / Memory-Exhaustion via dauerhaft riesige Token-Payloads).

ALTER TABLE mcp_backends
  ADD COLUMN IF NOT EXISTS oauth_revoke_url TEXT;

COMMENT ON COLUMN mcp_backends.oauth_revoke_url IS
  'Optional: OAuth Token-Revocation-Endpoint (RFC 7009). Wird bei /api/connections DELETE best-effort aufgerufen.';

-- Token-Größenlimits (10 KB pro encrypted Token reicht für jeden mir bekannten Provider).
-- IF EXISTS guard für Repeat-runs; constraint-name-Lookup damit der Re-Apply idempotent ist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_user_upstream_tokens_access_size_chk'
  ) THEN
    ALTER TABLE mcp_user_upstream_tokens
      ADD CONSTRAINT mcp_user_upstream_tokens_access_size_chk
      CHECK (length(access_token_enc) < 16384);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_user_upstream_tokens_refresh_size_chk'
  ) THEN
    ALTER TABLE mcp_user_upstream_tokens
      ADD CONSTRAINT mcp_user_upstream_tokens_refresh_size_chk
      CHECK (refresh_token_enc IS NULL OR length(refresh_token_enc) < 16384);
  END IF;
END
$$;
