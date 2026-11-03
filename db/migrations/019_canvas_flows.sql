-- Migration 019: Visual Canvas Flows
-- Speichert ReactFlow-basierte Workflows und Agent-Builder-Flows.

CREATE TABLE IF NOT EXISTS mcp_canvas_flows (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(128) NOT NULL UNIQUE,
  label       VARCHAR(256) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  flow_type   VARCHAR(32) NOT NULL DEFAULT 'workflow', -- 'workflow' | 'agent_builder'
  flow_data   JSONB NOT NULL DEFAULT '{}',             -- ReactFlow {nodes[], edges[]}
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_by  INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT canvas_flow_name_format CHECK (name ~ '^[a-z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_canvas_flows_type ON mcp_canvas_flows (flow_type);

CREATE TABLE IF NOT EXISTS mcp_canvas_executions (
  id           SERIAL PRIMARY KEY,
  flow_id      INTEGER NOT NULL REFERENCES mcp_canvas_flows(id) ON DELETE CASCADE,
  status       VARCHAR(32) NOT NULL DEFAULT 'running', -- 'running'|'success'|'failed'
  input_args   JSONB NOT NULL DEFAULT '{}',
  node_results JSONB NOT NULL DEFAULT '{}',            -- {nodeId: {output, error, duration_ms}}
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  duration_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mcp_canvas_executions_flow ON mcp_canvas_executions (flow_id);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_mcp_canvas_flows_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_canvas_flows_updated_at ON mcp_canvas_flows;
CREATE TRIGGER trg_mcp_canvas_flows_updated_at
  BEFORE UPDATE ON mcp_canvas_flows
  FOR EACH ROW EXECUTE FUNCTION update_mcp_canvas_flows_updated_at();

COMMENT ON TABLE mcp_canvas_flows IS 'ReactFlow-basierte visuelle Workflows und Agent-Builder-Flows.';
COMMENT ON TABLE mcp_canvas_executions IS 'Ausführungshistorie für Canvas-Flows mit Node-Ergebnissen.';
