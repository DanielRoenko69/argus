-- 052: document legacy IT-Ops demo tables
--
-- Background: 9 tables (services, incidents, incident_events, deployments,
-- alert_rules, slos, cost_records, ai_agents, agent_tasks) exist in the
-- live DB without any migration source in this repo. Schema-dump suggests
-- they originated from an early SRE-dashboard prototype or seed-data
-- script that pre-dates the current MCP-server domain model.
--
-- They are NOT used by any TypeScript code in this codebase (verified via
-- ripgrep over src/), so they are effectively cold storage. We keep them
-- for two reasons:
--   1. Existing demo/dev data should not be silently dropped.
--   2. Fresh deployments (e.g., AKS) will recreate the same surface area
--      so behaviour stays consistent across environments.
--
-- All CREATE TABLE statements use IF NOT EXISTS — safe to re-run on the
-- live DB where these tables already exist.
--
-- If you decide these tables are dead weight: drop them in a follow-up
-- migration with explicit DROP TABLE ... CASCADE statements.

CREATE TABLE IF NOT EXISTS services (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  description         TEXT,
  team_id             INTEGER,
  status              VARCHAR(20) DEFAULT 'healthy',
  version             VARCHAR(20),
  replicas            INTEGER DEFAULT 1,
  cpu_usage           NUMERIC(5,2),
  memory_mb           INTEGER,
  uptime_percent      NUMERIC(5,2),
  last_deployed_at    TIMESTAMP,
  repository          VARCHAR(200)
);

CREATE TABLE IF NOT EXISTS incidents (
  id                  SERIAL PRIMARY KEY,
  title               VARCHAR(300) NOT NULL,
  severity            VARCHAR(20),
  status              VARCHAR(20),
  affected_service_id INTEGER,
  started_at          TIMESTAMP,
  resolved_at         TIMESTAMP,
  root_cause          TEXT,
  assigned_team_id    INTEGER,
  postmortem_url      VARCHAR(300)
);

CREATE TABLE IF NOT EXISTS incident_events (
  id                  SERIAL PRIMARY KEY,
  incident_id         INTEGER,
  event_type          VARCHAR(50),
  description         TEXT,
  created_by          VARCHAR(100),
  created_at          TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id                  SERIAL PRIMARY KEY,
  service_id          INTEGER,
  version             VARCHAR(20),
  environment         VARCHAR(20),
  status              VARCHAR(20),
  deployed_by         VARCHAR(100),
  started_at          TIMESTAMP,
  completed_at        TIMESTAMP,
  commit_sha          VARCHAR(40),
  rollback_of         INTEGER
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(200) NOT NULL,
  condition           TEXT,
  severity            VARCHAR(20),
  enabled             BOOLEAN DEFAULT true,
  target_service_id   INTEGER,
  notify_channel      VARCHAR(100),
  last_triggered_at   TIMESTAMP,
  silenced_until      TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slos (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(200) NOT NULL,
  service_id          INTEGER,
  metric              VARCHAR(100),
  target              NUMERIC(6,3),
  current_value       NUMERIC(6,3),
  window_days         INTEGER DEFAULT 30,
  status              VARCHAR(20),
  burn_rate           NUMERIC(5,2)
);

CREATE TABLE IF NOT EXISTS cost_records (
  id                  SERIAL PRIMARY KEY,
  service_id          INTEGER,
  period_start        DATE,
  period_end          DATE,
  compute_cost        NUMERIC(10,2),
  storage_cost        NUMERIC(10,2),
  network_cost        NUMERIC(10,2),
  total_cost          NUMERIC(10,2),
  currency            VARCHAR(3) DEFAULT 'EUR'
);

CREATE TABLE IF NOT EXISTS ai_agents (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  agent_type          VARCHAR(50),
  status              VARCHAR(20) DEFAULT 'idle',
  model               VARCHAR(50),
  description         TEXT,
  task_count          INTEGER DEFAULT 0,
  success_rate        NUMERIC(5,2),
  last_active_at      TIMESTAMP,
  created_at          TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id                  SERIAL PRIMARY KEY,
  agent_id            INTEGER,
  task_type           VARCHAR(50),
  input_summary       TEXT,
  output_summary      TEXT,
  tools_used          TEXT[],
  status              VARCHAR(20),
  started_at          TIMESTAMP,
  completed_at        TIMESTAMP,
  tokens_used         INTEGER
);
