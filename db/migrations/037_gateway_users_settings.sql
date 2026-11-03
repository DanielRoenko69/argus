-- Migration 037: Gateway Internal Users & Key Ownership
-- Adds user_id to mcp_api_keys and gateway-specific columns to mcp_users

-- ============================================================
-- 1. Key Ownership
-- ============================================================

ALTER TABLE mcp_api_keys
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_user_id ON mcp_api_keys(user_id);

-- ============================================================
-- 2. Gateway User Settings (reuse mcp_users table)
-- ============================================================

ALTER TABLE mcp_users
  ADD COLUMN IF NOT EXISTS gateway_role VARCHAR(16) DEFAULT 'user' CHECK (gateway_role IN ('user', 'admin', 'viewer')),
  ADD COLUMN IF NOT EXISTS gateway_max_budget NUMERIC(16,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gateway_current_spend NUMERIC(16,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gateway_allowed_models TEXT[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gateway_denied_models TEXT[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gateway_rpm_limit INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gateway_tpm_limit INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gateway_spend_reset_at TIMESTAMPTZ DEFAULT now();

-- ============================================================
-- 3. Gateway Settings Table
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_gateway_settings (
  id              SERIAL PRIMARY KEY,
  category        VARCHAR(32) NOT NULL,  -- logging | alerting | security | router | theme
  key             VARCHAR(64) NOT NULL,
  value           JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ DEFAULT now(),
  updated_by      INTEGER REFERENCES mcp_users(id),
  UNIQUE(category, key)
);

-- ============================================================
-- 4. Allowed IPs Table (Security)
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_allowed_ips (
  id              SERIAL PRIMARY KEY,
  ip_address      VARCHAR(45) NOT NULL,
  cidr            VARCHAR(64),
  description     TEXT,
  enabled         BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE mcp_gateway_settings IS 'Gateway-wide configuration (logging callbacks, alerting, security)';
COMMENT ON TABLE mcp_allowed_ips IS 'IP allowlist for gateway access control';
