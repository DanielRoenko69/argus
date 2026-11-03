-- Migration 246: durable drift observations for applied MCP Fabric profiles.
-- The table stores bounded, secret-free finding summaries. It never stores
-- connector credentials, endpoint configuration or authorization material.

CREATE TABLE IF NOT EXISTS mcp_fabric_profile_drift_state (
  profile_id            BIGINT PRIMARY KEY REFERENCES mcp_fabric_profiles(id) ON DELETE CASCADE,
  profile_revision      INTEGER NOT NULL CHECK (profile_revision > 0),
  manifest_digest       CHAR(64) NOT NULL,
  status                VARCHAR(24) NOT NULL CHECK (status IN ('in_sync', 'drifted', 'not_applied')),
  finding_count         INTEGER NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
  critical_count        INTEGER NOT NULL DEFAULT 0 CHECK (critical_count >= 0),
  warning_count         INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  findings              JSONB NOT NULL DEFAULT '[]'::jsonb,
  finding_digest        CHAR(64) NOT NULL,
  check_source          VARCHAR(24) NOT NULL CHECK (check_source IN ('manual', 'scheduled')),
  transition_sequence   BIGINT NOT NULL DEFAULT 1 CHECK (transition_sequence > 0),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error_code       VARCHAR(64),
  last_error_at         TIMESTAMPTZ,
  last_error_notified_at TIMESTAMPTZ,
  checked_at            TIMESTAMPTZ NOT NULL,
  changed_at            TIMESTAMPTZ NOT NULL,
  notified_at           TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_fabric_profile_drift_findings_array CHECK (jsonb_typeof(findings) = 'array'),
  CONSTRAINT mcp_fabric_profile_drift_count_consistent CHECK (finding_count = critical_count + warning_count)
);

CREATE INDEX IF NOT EXISTS idx_mcp_fabric_profile_drift_attention
  ON mcp_fabric_profile_drift_state (status, changed_at DESC)
  WHERE status = 'drifted';

CREATE INDEX IF NOT EXISTS idx_mcp_fabric_profile_drift_checked
  ON mcp_fabric_profile_drift_state (checked_at DESC);

COMMENT ON TABLE mcp_fabric_profile_drift_state IS
  'Latest bounded drift observation for an applied secret-free MCP Fabric profile.';
