-- ============================================================
-- Migration 002: API Key Bundle RBAC
-- ============================================================
-- Adds allowed_bundles column to mcp_api_keys for bundle-based
-- access control. NULL = all bundles allowed (backwards compatible).
-- Safe to re-run (uses IF NOT EXISTS).
-- ============================================================

ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS allowed_bundles INTEGER[] DEFAULT NULL;

COMMENT ON COLUMN mcp_api_keys.allowed_bundles IS 'Service-Bundle IDs this key can access (NULL = all bundles allowed).';

CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_prefix ON mcp_api_keys (key_prefix);
