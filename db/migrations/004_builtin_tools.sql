-- ============================================================
-- Migration 004: Builtin Tools in DB
-- ============================================================
-- Adds tool_type column to distinguish builtin from dynamic tools.
-- Makes query_template nullable (builtin tools don't need templates).
-- Seeds all 26 builtin tool definitions.
-- Safe to re-run (uses IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- ============================================================

-- 1. Add tool_type column
ALTER TABLE mcp_tools ADD COLUMN IF NOT EXISTS tool_type VARCHAR(16) NOT NULL DEFAULT 'dynamic';
DO $$ BEGIN
  ALTER TABLE mcp_tools ADD CONSTRAINT mcp_tools_tool_type_check CHECK (tool_type IN ('builtin', 'dynamic'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Make query_template nullable (builtin tools have no template)
ALTER TABLE mcp_tools ALTER COLUMN query_template DROP NOT NULL;

-- 3. Extend backend CHECK to allow 'builtin:*' prefixes
ALTER TABLE mcp_tools DROP CONSTRAINT IF EXISTS mcp_tools_backend_check;
ALTER TABLE mcp_tools ADD CONSTRAINT mcp_tools_backend_check
  CHECK (backend IN ('postgresql', 'opensearch', 'http')
    OR backend LIKE 'custom:%'
    OR backend LIKE 'builtin:%');

-- 4. Seed builtin tool definitions (ON CONFLICT DO NOTHING = idempotent)
INSERT INTO mcp_tools (name, description, backend, query_template, parameters, enabled, category, tool_type) VALUES
-- Kubernetes (8)
('k8s_list_namespaces', 'List all namespaces in the cluster', 'builtin:kubernetes', NULL, '[]', true, 'Kubernetes', 'builtin'),
('k8s_list_pods', 'List pods in a namespace or across all namespaces', 'builtin:kubernetes', NULL,
  '[{"name":"namespace","type":"string","description":"Namespace (omit for all namespaces)","required":false},{"name":"labelSelector","type":"string","description":"Label selector (e.g. app=nginx)","required":false}]',
  true, 'Kubernetes', 'builtin'),
('k8s_list_deployments', 'List deployments in a namespace or across all namespaces', 'builtin:kubernetes', NULL,
  '[{"name":"namespace","type":"string","description":"Namespace (omit for all namespaces)","required":false},{"name":"labelSelector","type":"string","description":"Label selector (e.g. app=nginx)","required":false}]',
  true, 'Kubernetes', 'builtin'),
('k8s_list_services', 'List services in a namespace or across all namespaces', 'builtin:kubernetes', NULL,
  '[{"name":"namespace","type":"string","description":"Namespace (omit for all namespaces)","required":false}]',
  true, 'Kubernetes', 'builtin'),
('k8s_get_pod_logs', 'Get logs from a specific pod', 'builtin:kubernetes', NULL,
  '[{"name":"name","type":"string","description":"Pod name","required":true},{"name":"namespace","type":"string","description":"Namespace","required":true},{"name":"container","type":"string","description":"Container name (required for multi-container pods)","required":false},{"name":"tailLines","type":"number","description":"Number of lines from the end (default: 100)","required":false}]',
  true, 'Kubernetes', 'builtin'),
('k8s_get_events', 'Get events in a namespace or across all namespaces', 'builtin:kubernetes', NULL,
  '[{"name":"namespace","type":"string","description":"Namespace (omit for all namespaces)","required":false}]',
  true, 'Kubernetes', 'builtin'),
('k8s_get_nodes', 'Get node status and capacity information', 'builtin:kubernetes', NULL, '[]', true, 'Kubernetes', 'builtin'),
('k8s_get_resource', 'Get detailed information about a specific Kubernetes resource', 'builtin:kubernetes', NULL,
  '[{"name":"resourceType","type":"string","description":"Type of resource (pod, deployment, service, statefulset, daemonset, configmap, ingress)","required":true},{"name":"name","type":"string","description":"Resource name","required":true},{"name":"namespace","type":"string","description":"Namespace","required":true}]',
  true, 'Kubernetes', 'builtin'),
-- Grafana (6)
('grafana_search_dashboards', 'Search for Grafana dashboards by query or tag', 'builtin:grafana', NULL,
  '[{"name":"query","type":"string","description":"Search query string","required":false},{"name":"tag","type":"string","description":"Filter by tag","required":false}]',
  true, 'Grafana', 'builtin'),
('grafana_get_dashboard', 'Get full dashboard details including panels by UID', 'builtin:grafana', NULL,
  '[{"name":"uid","type":"string","description":"Dashboard UID","required":true}]',
  true, 'Grafana', 'builtin'),
('grafana_query_prometheus', 'Execute a PromQL query via Grafana datasource proxy', 'builtin:grafana', NULL,
  '[{"name":"query","type":"string","description":"PromQL query expression","required":true},{"name":"start","type":"string","description":"Start time (ISO 8601 or relative like now-1h)","required":false},{"name":"end","type":"string","description":"End time (ISO 8601 or now)","required":false},{"name":"step","type":"string","description":"Step duration (e.g. 15s, 1m)","required":false},{"name":"datasourceUid","type":"string","description":"Datasource UID (uses default Prometheus if omitted)","required":false}]',
  true, 'Grafana', 'builtin'),
('grafana_query_loki', 'Execute a LogQL query via Grafana datasource proxy', 'builtin:grafana', NULL,
  '[{"name":"query","type":"string","description":"LogQL query expression","required":true},{"name":"start","type":"string","description":"Start time (ISO 8601 or relative)","required":false},{"name":"end","type":"string","description":"End time (ISO 8601 or now)","required":false},{"name":"limit","type":"number","description":"Maximum number of log lines to return (default: 100)","required":false},{"name":"datasourceUid","type":"string","description":"Datasource UID (uses default Loki if omitted)","required":false}]',
  true, 'Grafana', 'builtin'),
('grafana_get_alerts', 'Get alert rules and their current state', 'builtin:grafana', NULL,
  '[{"name":"state","type":"string","description":"Filter by alert state (alerting, pending, inactive, nodata, error)","required":false}]',
  true, 'Grafana', 'builtin'),
('grafana_list_datasources', 'List all configured datasources in Grafana', 'builtin:grafana', NULL, '[]', true, 'Grafana', 'builtin'),
-- OpenSearch (5)
('opensearch_list_indices', 'List indices with basic metrics (docs count, size)', 'builtin:opensearch', NULL,
  '[{"name":"pattern","type":"string","description":"Index name pattern with wildcards (e.g. logs-*)","required":false}]',
  true, 'OpenSearch', 'builtin'),
('opensearch_search', 'Execute an OpenSearch Query DSL search', 'builtin:opensearch', NULL,
  '[{"name":"index","type":"string","description":"Index name or pattern","required":true},{"name":"query","type":"string","description":"Query DSL as JSON string","required":true},{"name":"size","type":"number","description":"Number of results to return (default: 10)","required":false}]',
  true, 'OpenSearch', 'builtin'),
('opensearch_get_mapping', 'Get field mappings for an index', 'builtin:opensearch', NULL,
  '[{"name":"index","type":"string","description":"Index name","required":true}]',
  true, 'OpenSearch', 'builtin'),
('opensearch_cluster_health', 'Get cluster health status', 'builtin:opensearch', NULL, '[]', true, 'OpenSearch', 'builtin'),
('opensearch_count', 'Count documents in an index, optionally filtered by a query', 'builtin:opensearch', NULL,
  '[{"name":"index","type":"string","description":"Index name or pattern","required":true},{"name":"query","type":"string","description":"Query DSL as JSON string (omit for total count)","required":false}]',
  true, 'OpenSearch', 'builtin'),
-- PostgreSQL (3)
('pg_list_tables', 'List all tables and views in the PostgreSQL database', 'builtin:postgresql', NULL,
  '[{"name":"schema","type":"string","description":"Schema name (default: public)","required":false}]',
  true, 'PostgreSQL', 'builtin'),
('pg_describe_table', 'Describe columns, types, and constraints of a table', 'builtin:postgresql', NULL,
  '[{"name":"table","type":"string","description":"Table name","required":true},{"name":"schema","type":"string","description":"Schema name (default: public)","required":false}]',
  true, 'PostgreSQL', 'builtin'),
('pg_execute_query', 'Execute a read-only SQL query against the PostgreSQL database', 'builtin:postgresql', NULL,
  '[{"name":"query","type":"string","description":"SQL query to execute (must be read-only)","required":true}]',
  true, 'PostgreSQL', 'builtin'),
-- Meta / Operations (3)
('ops_correlate_alerts', 'Correlate current alerts with Kubernetes events and recent logs to identify root causes', 'builtin:meta', NULL,
  '[{"name":"lookbackMinutes","type":"number","description":"How many minutes to look back (default: 30)","required":false}]',
  true, 'Operations', 'builtin'),
('ops_incident_context', 'Automatically gather all relevant context for an incident: affected pods, recent logs, and recent deployments', 'builtin:meta', NULL,
  '[{"name":"namespace","type":"string","description":"Namespace of the affected service","required":true},{"name":"service","type":"string","description":"Service name (optional)","required":false},{"name":"lookbackMinutes","type":"number","description":"How many minutes to look back (default: 30)","required":false}]',
  true, 'Operations', 'builtin'),
('ops_usage_summary', 'Get token usage estimates and tool call statistics for cost tracking', 'builtin:meta', NULL,
  '[{"name":"hours","type":"number","description":"Look back N hours (default: 24)","required":false}]',
  true, 'Operations', 'builtin'),
-- Service Bundles Discovery (1)
('list_service_bundles', 'Alle konfigurierten Service-Bundles auflisten mit deren zugeordneten Tools', 'builtin:meta', NULL, '[]', true, 'Operations', 'builtin')
ON CONFLICT (name) DO NOTHING;
