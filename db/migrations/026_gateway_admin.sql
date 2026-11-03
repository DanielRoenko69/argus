-- Migration 026: Gateway Admin Flag

-- Add gateway_admin flag to API keys for admin RBAC
ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS gateway_admin BOOLEAN DEFAULT false;

-- Add id to SELECT queries in gateway key cache (already exists as PK, just ensure loaded)
-- No schema change needed for id — it's already the PRIMARY KEY

-- Update existing keys: set gateway_admin = true for keys that have gateway_enabled = true
-- This is a safe default for existing installations
UPDATE mcp_api_keys SET gateway_admin = true WHERE gateway_enabled = true AND gateway_admin IS NULL;
