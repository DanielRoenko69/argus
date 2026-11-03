-- Migration 086: Per-User Upstream-Tokens + API-Key-User-Binding
--
-- Argus's Upstream-Service-Calls können jetzt im Namen des End-Users
-- ausgeführt werden statt mit Service-Account. Voraussetzung: OAuth-App
-- am Upstream registriert + User hat einmalig consented.
--
-- Plus: API-Keys können an einen mcp_users-Eintrag gebunden werden
-- (acting_as_user_id). Damit nutzen Cursor/VS Code-Calls trotzdem die
-- User-Identity ohne SSO-Session.
--
-- Encryption: access_token + refresh_token sind AES-256-GCM via SECRET_KEY
-- verschlüsselt (analog mcp_backends.auth_value Pattern).
--
-- Feature ist OFF by default — Aktivierung erst durch Platform-Config
-- Master-Switch upstream_token_exchange.enabled.

CREATE TABLE IF NOT EXISTS mcp_user_upstream_tokens (
  user_id           INTEGER NOT NULL REFERENCES mcp_users(id)    ON DELETE CASCADE,
  backend_id        INTEGER NOT NULL REFERENCES mcp_backends(id) ON DELETE CASCADE,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  scopes_granted    TEXT[] NOT NULL DEFAULT '{}',
  upstream_username TEXT,
  consent_given_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ,
  refresh_failed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, backend_id)
);

CREATE INDEX IF NOT EXISTS idx_user_upstream_tokens_user ON mcp_user_upstream_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_user_upstream_tokens_expires ON mcp_user_upstream_tokens (expires_at);

-- API-Key-User-Binding: Cursor/VS Code-Devs können einen "persönlichen"
-- Key haben der mit ihrer User-Identity verknüpft ist. Calls mit diesem
-- Key triggern user-policy-gate + Upstream-Token-Resolution genauso als
-- wäre der User per SSO eingeloggt.
ALTER TABLE mcp_api_keys
  ADD COLUMN IF NOT EXISTS acting_as_user_id INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL;

COMMENT ON COLUMN mcp_api_keys.acting_as_user_id IS
  'Wenn gesetzt: Calls mit diesem API-Key werden behandelt als kämen sie von diesem User (für User-Policies + Upstream-Token-Resolution). NULL = Service-Account-Verhalten.';

-- Per-Backend Auth-Mode (default service-account = bestehendes Verhalten)
ALTER TABLE mcp_backends
  ADD COLUMN IF NOT EXISTS auth_mode VARCHAR(16) NOT NULL DEFAULT 'service-account'
    CHECK (auth_mode IN ('service-account', 'permissive', 'strict')),
  ADD COLUMN IF NOT EXISTS oauth_authorize_url TEXT,
  ADD COLUMN IF NOT EXISTS oauth_token_url     TEXT,
  ADD COLUMN IF NOT EXISTS oauth_client_id     TEXT,
  ADD COLUMN IF NOT EXISTS oauth_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS oauth_scopes        TEXT[];

-- Per-Tool override (Phase G)
ALTER TABLE mcp_tools
  ADD COLUMN IF NOT EXISTS required_auth_mode VARCHAR(16)
    CHECK (required_auth_mode IN ('service-account','permissive','strict'));

COMMENT ON COLUMN mcp_tools.required_auth_mode IS
  'Per-Tool-Override für auth_mode. NULL = honor backend default. Setze "strict" für sensitive Tools wie delete-Verben.';

-- Audit-Events
ALTER TABLE mcp_immutable_audit_log
  DROP CONSTRAINT IF EXISTS mcp_immutable_audit_log_event_type_check;
ALTER TABLE mcp_immutable_audit_log
  ADD CONSTRAINT mcp_immutable_audit_log_event_type_check
  CHECK (event_type IN (
    'request_success', 'request_failure', 'cache_hit',
    'guardrail_block', 'budget_exceeded', 'rate_limit_exceeded',
    'tool_hook_decision',
    'entra_sp_provisioned', 'entra_sp_deleted', 'entra_sync_failed',
    'codegraph_built',
    'user_policy_block',
    'upstream_token_acquired', 'upstream_token_revoked',
    'upstream_auth_fallback', 'upstream_elicitation_required'
  ));

COMMENT ON TABLE mcp_user_upstream_tokens IS
  'OAuth-Token-Storage pro (User, Backend). Argus ruft Upstream im Namen des End-Users an statt Service-Account.';
