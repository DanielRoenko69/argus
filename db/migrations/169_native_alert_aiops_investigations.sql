-- Durable correlation between Core-owned native alert incidents and externally
-- executed Argus AIOps tasks. Investigation evidence remains Pack-owned.

CREATE TABLE IF NOT EXISTS mcp_observability_incident_aiops_tasks (
  id             BIGSERIAL PRIMARY KEY,
  incident_id    BIGINT NOT NULL
                 REFERENCES mcp_observability_alert_incidents(id) ON DELETE CASCADE,
  pack_id        VARCHAR(128) NOT NULL,
  agent_id       VARCHAR(128) NOT NULL,
  task_id        VARCHAR(128) NOT NULL,
  root_trace_id  VARCHAR(128),
  state          VARCHAR(64) NOT NULL,
  quality        VARCHAR(64),
  summary        TEXT,
  created_by     INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_observability_incident_aiops_task_unique
    UNIQUE (incident_id, pack_id, task_id),
  CONSTRAINT mcp_observability_incident_aiops_summary_length
    CHECK (summary IS NULL OR length(summary) <= 2000)
);

CREATE INDEX IF NOT EXISTS idx_incident_aiops_tasks_incident
  ON mcp_observability_incident_aiops_tasks (incident_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_incident_aiops_tasks_task
  ON mcp_observability_incident_aiops_tasks (pack_id, agent_id, task_id);

COMMENT ON TABLE mcp_observability_incident_aiops_tasks IS
  'Core-owned links from native incidents to external AIOps tasks; excludes raw Pack evidence.';
