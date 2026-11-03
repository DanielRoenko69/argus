-- Explicit, immutable Graphify knowledge assignments for Agents.
--
-- RAG indexes remain document/vector sources. Repository snapshots are a
-- separate knowledge kind because they carry commit-bound files, symbols and
-- relations and must retain their original Bundle authorization boundary.

CREATE TABLE IF NOT EXISTS mcp_agent_code_index_snapshots (
  agent_id    INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  snapshot_id BIGINT NOT NULL REFERENCES mcp_code_index_snapshots(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, snapshot_id),
  UNIQUE (agent_id, priority)
);

CREATE INDEX IF NOT EXISTS idx_agent_code_index_snapshots_snapshot
  ON mcp_agent_code_index_snapshots (snapshot_id, agent_id);

COMMENT ON TABLE mcp_agent_code_index_snapshots IS
  'Immutable Graphify repository knowledge explicitly assigned to an Agent; runtime retrieval still enforces the snapshot Bundle scope.';
