-- Extend role model from 3 (admin/editor/viewer) to 5 roles.
-- Hierarchy: platform_admin > gateway_admin > developer > agent_operator > viewer
--
-- Backwards-compat migration: admin -> platform_admin, editor -> developer

-- Step 1: Drop existing CHECK constraint
ALTER TABLE mcp_users DROP CONSTRAINT IF EXISTS mcp_users_role_check;

-- Step 2: Migrate existing role values
UPDATE mcp_users SET role = 'platform_admin' WHERE role = 'admin';
UPDATE mcp_users SET role = 'developer'      WHERE role = 'editor';
-- 'viewer' stays 'viewer'

-- Step 3: Add new constraint with all 5 roles
ALTER TABLE mcp_users
  ADD CONSTRAINT mcp_users_role_check
  CHECK (role IN ('platform_admin','gateway_admin','developer','agent_operator','viewer'));

COMMENT ON COLUMN mcp_users.role IS
  'Argus RBAC role. Hierarchy: platform_admin > gateway_admin > developer > agent_operator > viewer';
