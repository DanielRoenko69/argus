-- Audit (data-integrity) — reconcile init.sql-only column into the migration set.
--
-- `mcp_agents.bundle_ids` is created by db/init.sql (the docker-entrypoint-initdb
-- seed) but by NO numbered migration. A deployment that provisions Postgres via
-- the migration runner alone (e.g. managed/AKS Postgres where init.sql is not
-- applied) ends up without the column, and agent creation + the workflow palette
-- / RBAC step-access queries then fail with "column bundle_ids does not exist".
-- Idempotent, so it is a no-op on the docker-compose/init.sql path.
ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS bundle_ids INTEGER[] DEFAULT NULL;
