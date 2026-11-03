CREATE TABLE IF NOT EXISTS mcp_prompt_versions (
  id          SERIAL PRIMARY KEY,
  prompt_id   INTEGER NOT NULL REFERENCES mcp_prompts(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  template    JSONB NOT NULL,
  variables   TEXT[] DEFAULT '{}',
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_unique
  ON mcp_prompt_versions(prompt_id, version);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_prompt
  ON mcp_prompt_versions(prompt_id);
