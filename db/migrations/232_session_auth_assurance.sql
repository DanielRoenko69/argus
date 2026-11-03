-- Provider-verified authentication assurance for browser sessions.
-- Existing and local-password sessions remain deliberately non-MFA. Sensitive
-- operations can require a recent OIDC assertion without trusting request
-- headers or mutable client-side state.

ALTER TABLE mcp_sessions
  ADD COLUMN IF NOT EXISTS auth_method VARCHAR(32) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS mfa_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_method VARCHAR(160);

ALTER TABLE mcp_sessions
  DROP CONSTRAINT IF EXISTS mcp_sessions_auth_method_valid,
  ADD CONSTRAINT mcp_sessions_auth_method_valid
    CHECK (auth_method IN ('local', 'oidc')),
  DROP CONSTRAINT IF EXISTS mcp_sessions_mfa_assurance_coherent,
  ADD CONSTRAINT mcp_sessions_mfa_assurance_coherent CHECK (
    (mfa_verified_at IS NULL AND mfa_method IS NULL)
    OR
    (
      auth_method = 'oidc'
      AND mfa_verified_at IS NOT NULL
      AND mfa_method IS NOT NULL
      AND length(btrim(mfa_method)) > 0
    )
  );

CREATE INDEX IF NOT EXISTS idx_mcp_sessions_mfa_verified
  ON mcp_sessions (user_id, mfa_verified_at DESC)
  WHERE auth_method = 'oidc' AND mfa_verified_at IS NOT NULL;

COMMENT ON COLUMN mcp_sessions.auth_method IS
  'Server-established browser authentication method; never sourced from a request header.';
COMMENT ON COLUMN mcp_sessions.mfa_verified_at IS
  'OIDC auth_time accepted only with configured signed amr/acr MFA evidence.';
COMMENT ON COLUMN mcp_sessions.mfa_method IS
  'Accepted signed ID-token assurance marker, for example amr:mfa or acr:urn:example:mfa.';
