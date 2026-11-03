-- Governed memory bridge for Managed Hermes.
--
-- Hermes can propose bounded facts but never writes active memory directly.
-- Only accepted rows are retrieved, and the exact Core-signed workspace path
-- is part of every lookup. Project-wide promotion remains a separate review
-- step so one checkout cannot poison or leak into another project.

CREATE TABLE IF NOT EXISTS mcp_runtime_memory_proposals (
  id                    BIGSERIAL PRIMARY KEY,
  agent_id              INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  runtime_profile_id    INTEGER NOT NULL REFERENCES mcp_agent_runtime_profiles(id) ON DELETE CASCADE,
  scope_type            VARCHAR(24) NOT NULL DEFAULT 'workspace'
                          CHECK (scope_type IN ('workspace', 'project')),
  scope_key             VARCHAR(2048) NOT NULL,
  scope_key_hash        CHAR(64) NOT NULL,
  memory_type           VARCHAR(24) NOT NULL
                          CHECK (memory_type IN ('working', 'episodic', 'semantic', 'procedural')),
  content               TEXT NOT NULL CHECK (char_length(content) BETWEEN 8 AND 1200),
  content_hash          CHAR(64) NOT NULL,
  importance            REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  valid_days            INTEGER NOT NULL CHECK (valid_days BETWEEN 1 AND 365),
  valid_until           TIMESTAMPTZ,
  source_trace_id       UUID NOT NULL,
  source_runtime_run_id VARCHAR(160) NOT NULL,
  source_session_id     VARCHAR(128) NOT NULL,
  principal_kind        VARCHAR(24) NOT NULL CHECK (principal_kind IN ('user', 'api_key', 'service')),
  principal_id          VARCHAR(256) NOT NULL,
  status                VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'accepted', 'rejected')),
  proposal_count        INTEGER NOT NULL DEFAULT 1,
  last_proposed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at           TIMESTAMPTZ,
  reviewed_by_kind      VARCHAR(24) CHECK (reviewed_by_kind IN ('user', 'service')),
  reviewed_by_id        VARCHAR(256),
  accepted_at           TIMESTAMPTZ,
  access_count          INTEGER NOT NULL DEFAULT 0,
  last_accessed_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, runtime_profile_id, scope_type, scope_key_hash, content_hash)
);

CREATE INDEX IF NOT EXISTS ix_runtime_memory_workspace_lookup
  ON mcp_runtime_memory_proposals
    (agent_id, scope_type, scope_key_hash, status, importance DESC, accepted_at DESC);

CREATE INDEX IF NOT EXISTS ix_runtime_memory_pending_review
  ON mcp_runtime_memory_proposals (status, created_at DESC)
  WHERE status = 'pending';

COMMENT ON TABLE mcp_runtime_memory_proposals IS
  'Argus-owned, provenance-bound runtime memory proposals. Runtime output cannot activate memory without an Argus decision.';

-- Existing installations already applied migration 215 with memory_policy=none.
-- Switch only the dedicated Managed Dev profile; attached Hermes remains none.
UPDATE mcp_runtime_adapter_profiles binding
   SET memory_policy = 'propose_write',
       updated_at = now()
  FROM mcp_agent_runtime_profiles profile
 WHERE binding.runtime_profile_id = profile.id
   AND profile.name = 'hermes-managed-dev'
   AND binding.execution_strategy = 'managed';
