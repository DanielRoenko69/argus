-- 009: Add allowed_bundles to mcp_users for User Bundle RBAC
-- NULL = unrestricted (sees everything), array = restricted to those bundles
-- Mirrors the existing allowed_bundles pattern on mcp_api_keys.

ALTER TABLE mcp_users ADD COLUMN IF NOT EXISTS allowed_bundles INTEGER[] DEFAULT NULL;

COMMENT ON COLUMN mcp_users.allowed_bundles IS 'Service-Bundle IDs this user can access (NULL = all bundles allowed).';
