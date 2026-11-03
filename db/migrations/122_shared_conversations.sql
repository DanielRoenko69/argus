-- Migration 122: read-only, expiring, PII-redacted shared conversation snapshots.
CREATE TABLE IF NOT EXISTS mcp_shared_conversations (
  id                BIGSERIAL PRIMARY KEY,
  token_hash        TEXT NOT NULL UNIQUE,
  agent_id          INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  source_session_id VARCHAR(64) REFERENCES mcp_agent_sessions(id) ON DELETE SET NULL,
  title             TEXT NOT NULL DEFAULT '',
  redacted_messages JSONB NOT NULL,
  password_hash     TEXT,
  created_by        INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shared_conv_creator ON mcp_shared_conversations(created_by);
CREATE INDEX IF NOT EXISTS idx_shared_conv_expires ON mcp_shared_conversations(expires_at);
