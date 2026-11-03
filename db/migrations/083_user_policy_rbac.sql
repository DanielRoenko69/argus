-- Migration 083: Per-User MCP-Tool RBAC
--
-- Adds fine-grained authorization on top of Argus SSO. Users are mapped to
-- composites (bundles of tools) plus optional explicit allow/deny rules at
-- the tool-name pattern level. Groups (from JWT 'groups' claim) get the
-- same primitives. Enforcement happens in a new tool-level hook at
-- priority 50 (before destructive-cmd-guard).

-- Cache Entra group ObjectIDs on the user row, refreshed every login.
ALTER TABLE mcp_users
  ADD COLUMN IF NOT EXISTS entra_groups TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_mcp_users_entra_groups ON mcp_users USING GIN (entra_groups);

-- User → Composite binding (grants user every tool that matches the
-- composite's tool_allow_patterns and is not in tool_deny_patterns)
CREATE TABLE IF NOT EXISTS mcp_user_composites (
  user_id      INTEGER NOT NULL REFERENCES mcp_users(id) ON DELETE CASCADE,
  composite_id INTEGER NOT NULL REFERENCES mcp_composites(id) ON DELETE CASCADE,
  granted_by   INTEGER REFERENCES mcp_users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, composite_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_user_composites_user ON mcp_user_composites (user_id);

-- User → Tool-pattern rule (glob allow/deny on top of composites)
CREATE TABLE IF NOT EXISTS mcp_user_tool_rules (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES mcp_users(id) ON DELETE CASCADE,
  tool_pattern  TEXT NOT NULL,
  effect        VARCHAR(8) NOT NULL CHECK (effect IN ('allow','deny')),
  reason        TEXT,
  expires_at    TIMESTAMPTZ,
  created_by    INTEGER REFERENCES mcp_users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_user_tool_rules_user ON mcp_user_tool_rules (user_id);

-- Group (Entra group ObjectID string) → Composite
CREATE TABLE IF NOT EXISTS mcp_group_composites (
  group_name    VARCHAR(128) NOT NULL,
  composite_id  INTEGER NOT NULL REFERENCES mcp_composites(id) ON DELETE CASCADE,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_name, composite_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_group_composites_group ON mcp_group_composites (group_name);

-- Group → Tool-pattern rule
CREATE TABLE IF NOT EXISTS mcp_group_tool_rules (
  id            SERIAL PRIMARY KEY,
  group_name    VARCHAR(128) NOT NULL,
  tool_pattern  TEXT NOT NULL,
  effect        VARCHAR(8) NOT NULL CHECK (effect IN ('allow','deny')),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_group_tool_rules_group ON mcp_group_tool_rules (group_name);

-- New audit event for blocked tool calls
ALTER TABLE mcp_immutable_audit_log
  DROP CONSTRAINT IF EXISTS mcp_immutable_audit_log_event_type_check;

ALTER TABLE mcp_immutable_audit_log
  ADD CONSTRAINT mcp_immutable_audit_log_event_type_check
  CHECK (event_type IN (
    'request_success',
    'request_failure',
    'cache_hit',
    'guardrail_block',
    'budget_exceeded',
    'rate_limit_exceeded',
    'tool_hook_decision',
    'entra_sp_provisioned',
    'entra_sp_deleted',
    'entra_sync_failed',
    'codegraph_built',
    'user_policy_block'
  ));

COMMENT ON COLUMN mcp_users.entra_groups IS
  'Snapshot of Entra group ObjectIDs from last SSO login. Used by user-policy-gate to resolve group-level rules.';
