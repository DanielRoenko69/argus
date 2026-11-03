-- ============================================================
-- 006: User Authentication & Session Management
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(256) NOT NULL,
  display_name  VARCHAR(128) NOT NULL DEFAULT '',
  role          VARCHAR(16) NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'editor', 'viewer')),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mcp_sessions (
  id            VARCHAR(64) PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES mcp_users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  ip_address    VARCHAR(45),
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user ON mcp_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires ON mcp_sessions (expires_at);
