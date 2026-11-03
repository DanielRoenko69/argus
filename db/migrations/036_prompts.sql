-- 036: Prompt Management
CREATE TABLE IF NOT EXISTS mcp_prompts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL UNIQUE,
  description TEXT,
  template JSONB NOT NULL DEFAULT '{"messages":[]}'::jsonb,
  variables JSONB DEFAULT '[]'::jsonb,
  version INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  tags JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_prompts_name ON mcp_prompts(name);
CREATE INDEX IF NOT EXISTS idx_mcp_prompts_active ON mcp_prompts(is_active);
