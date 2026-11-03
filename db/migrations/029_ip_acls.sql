-- Migration 029: IP Address ACLs for Gateway

CREATE TABLE IF NOT EXISTS mcp_ip_acls (
  id SERIAL PRIMARY KEY,
  target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('key', 'team', 'global')),
  target_id INTEGER DEFAULT NULL,              -- FK to mcp_api_keys.id or mcp_teams.id, NULL for global
  cidr VARCHAR(64) NOT NULL,                   -- e.g. "192.168.1.0/24" or "10.0.0.5/32"
  action VARCHAR(8) NOT NULL DEFAULT 'allow' CHECK (action IN ('allow', 'deny')),
  priority INTEGER DEFAULT 0,                  -- Higher number = evaluated first (desc)
  description TEXT,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_acls_target ON mcp_ip_acls(target_type, target_id, enabled);
CREATE INDEX IF NOT EXISTS idx_ip_acls_cidr ON mcp_ip_acls(cidr);
