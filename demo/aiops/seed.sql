\set ON_ERROR_STOP on

BEGIN;

-- This is intentionally a demo seed, not a product migration. Production
-- operators install their own provider connections through MCP Fabric.
INSERT INTO mcp_service_bundles (name, label, description, icon)
VALUES (
  'argus-aiops-observe',
  'Argus.AIOps Observe',
  'Read-only metrics, logs, traces and Kubernetes runtime evidence for governed AIOps investigations.',
  'activity'
)
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  updated_at = now();

-- The human-operated remediation path is deliberately isolated from the
-- read-only Agent bundle. Investigation Agents never receive this bundle.
INSERT INTO mcp_service_bundles (name, label, description, icon)
VALUES (
  'argus-aiops-remediate',
  'Argus.AIOps Remediate',
  'Human-approved, target-scoped provider actions for governed AIOps remediation.',
  'shield-check'
)
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  updated_at = now();

INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, config
)
VALUES (
  'aiops-prometheus',
  'Read-only Prometheus metrics for the local Argus Core container runtime.',
  'http://prometheus:9090',
  'none', NULL, '/api/v1/status/buildinfo', '{}'::jsonb,
  10000, false, true, 'http',
  '{"read_only":true,"provider":"prometheus","environment":"local-demo"}'::jsonb
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  base_url = EXCLUDED.base_url,
  auth_type = EXCLUDED.auth_type,
  auth_value = EXCLUDED.auth_value,
  health_path = EXCLUDED.health_path,
  default_headers = EXCLUDED.default_headers,
  timeout_ms = EXCLUDED.timeout_ms,
  tls_skip_verify = EXCLUDED.tls_skip_verify,
  enabled = true,
  backend_type = EXCLUDED.backend_type,
  config = EXCLUDED.config,
  updated_at = now();

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE backend.name = 'aiops-prometheus'
ON CONFLICT (backend_id, bundle_id) DO NOTHING;

INSERT INTO mcp_tools (
  name, description, backend, query_template, parameters,
  enabled, category, tool_type, is_write, risk_level
)
VALUES
  (
    'aiops_prometheus_query',
    'Run a read-only instant PromQL metrics query.',
    'custom:aiops-prometheus',
    'GET /api/v1/query?query={{query}}&time={{time}}',
    '[{"name":"query","type":"string","description":"PromQL expression","required":true},{"name":"time","type":"string","description":"Optional RFC3339 or Unix timestamp","required":false}]'::jsonb,
    true, 'AIOps Metrics', 'dynamic', false, 'low'
  ),
  (
    'aiops_prometheus_query_range',
    'Run a read-only PromQL metrics query over a bounded time range.',
    'custom:aiops-prometheus',
    'GET /api/v1/query_range?query={{query}}&start={{start}}&end={{end}}&step={{step}}',
    '[{"name":"query","type":"string","description":"PromQL expression","required":true},{"name":"start","type":"string","description":"RFC3339 or Unix start timestamp","required":true},{"name":"end","type":"string","description":"RFC3339 or Unix end timestamp","required":true},{"name":"step","type":"string","description":"Query resolution such as 15s or 1m","required":true}]'::jsonb,
    true, 'AIOps Metrics', 'dynamic', false, 'low'
  ),
  (
    'aiops_prometheus_alerts',
    'List current Prometheus alerts without changing alert state.',
    'custom:aiops-prometheus',
    'GET /api/v1/alerts',
    '[]'::jsonb,
    true, 'AIOps Incident', 'dynamic', false, 'low'
  ),
  (
    'aiops_prometheus_targets',
    'Inspect active Prometheus scrape targets and runtime health.',
    'custom:aiops-prometheus',
    'GET /api/v1/targets?state={{state}}',
    '[{"name":"state","type":"string","description":"Target state: active, dropped or any","required":false,"default":"active"}]'::jsonb,
    true, 'AIOps Runtime', 'dynamic', false, 'low'
  ),
  (
    'aiops_prometheus_label_values',
    'List values for one Prometheus label.',
    'custom:aiops-prometheus',
    'GET /api/v1/label/{{label_name}}/values',
    '[{"name":"label_name","type":"string","description":"Prometheus label name","required":true}]'::jsonb,
    true, 'AIOps Metrics', 'dynamic', false, 'low'
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  backend = EXCLUDED.backend,
  query_template = EXCLUDED.query_template,
  parameters = EXCLUDED.parameters,
  enabled = true,
  category = EXCLUDED.category,
  tool_type = EXCLUDED.tool_type,
  is_write = false,
  risk_level = 'low',
  updated_at = now();

INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
SELECT tool.id, bundle.id
  FROM mcp_tools tool
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE tool.name = ANY(ARRAY[
   'aiops_prometheus_query',
   'aiops_prometheus_query_range',
   'aiops_prometheus_alerts',
   'aiops_prometheus_targets',
   'aiops_prometheus_label_values'
 ])
ON CONFLICT (tool_id, bundle_id) DO NOTHING;

-- Use a selected policy so later tools added to the connection do not become
-- available to diagnostic Agents without an explicit review.
INSERT INTO mcp_bundle_backend_tool_policies (
  backend_id, bundle_id, mode, allowed_tool_names
)
SELECT backend.id, bundle.id, 'selected', ARRAY[
         'aiops_prometheus_query',
         'aiops_prometheus_query_range',
         'aiops_prometheus_alerts',
         'aiops_prometheus_targets',
         'aiops_prometheus_label_values'
       ]::text[]
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE backend.name = 'aiops-prometheus'
ON CONFLICT (backend_id, bundle_id) DO UPDATE SET
  mode = EXCLUDED.mode,
  allowed_tool_names = EXCLUDED.allowed_tool_names,
  updated_at = now();

-- A physically separate, workload-allowlisted MCP process owns the mutation
-- identity. Core exposes only bounded scale and Deployment revision-restore
-- contracts through a bundle that no Agent owns.
INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled, backend_type,
  mcp_endpoint, config
)
VALUES (
  'aiops-kubernetes-remediation',
  'Workload-scoped Kubernetes remediation connector for the local Argus.AIOps target.',
  'http://argus-aiops-control-plane:30085',
  'none', NULL, NULL, '{}'::jsonb,
  10000, false, true, 'mcp', '/mcp',
  '{"governed_write":true,"provider":"argus-aiops-remediation-connector","provider_version":"1.0.0","remediation_target_id":"argus-aiops-kind","remediation_source_bundles":["argus-aiops-observe"],"cluster":"argus-aiops","environment":"local-demo","execution_namespaces":["argus-demo"],"execution_workloads":["checkout-api"],"allowed_actions":["scale","deployment_revision_rollback"],"allow_secrets":false}'::jsonb
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  base_url = EXCLUDED.base_url,
  auth_type = EXCLUDED.auth_type,
  auth_value = EXCLUDED.auth_value,
  health_path = EXCLUDED.health_path,
  default_headers = EXCLUDED.default_headers,
  timeout_ms = EXCLUDED.timeout_ms,
  tls_skip_verify = EXCLUDED.tls_skip_verify,
  enabled = true,
  backend_type = EXCLUDED.backend_type,
  mcp_endpoint = EXCLUDED.mcp_endpoint,
  config = EXCLUDED.config,
  updated_at = now();

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-remediate'
 WHERE backend.name = 'aiops-kubernetes-remediation'
ON CONFLICT (backend_id, bundle_id) DO NOTHING;

INSERT INTO mcp_bundle_backend_tool_policies (
  backend_id, bundle_id, mode, allowed_tool_names
)
SELECT backend.id, bundle.id, 'selected', ARRAY[
         'aiops_kubernetes_remediation_resources_scale',
         'aiops_kubernetes_remediation_deployment_revision_rollback'
       ]::text[]
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-remediate'
 WHERE backend.name = 'aiops-kubernetes-remediation'
ON CONFLICT (backend_id, bundle_id) DO UPDATE SET
  mode = EXCLUDED.mode,
  allowed_tool_names = EXCLUDED.allowed_tool_names,
  updated_at = now();

-- External logs and traces stay provider-owned. Argus stores only the bounded
-- query metadata and the Agent's reviewed summary, never the raw corpus.
INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, config
)
VALUES
  (
    'aiops-loki',
    'Read-only Loki LogQL queries for the local multi-signal AIOps lab.',
    'http://loki:3100',
    'none', NULL, '/ready', '{}'::jsonb,
    10000, false, true, 'http',
    '{"read_only":true,"provider":"loki","environment":"local-demo","raw_telemetry_persisted":false}'::jsonb
  ),
  (
    'aiops-jaeger',
    'Read-only Jaeger trace search for the local multi-signal AIOps lab.',
    'http://jaeger:16686',
    'none', NULL, '/api/services', '{}'::jsonb,
    10000, false, true, 'http',
    '{"read_only":true,"provider":"jaeger","environment":"local-demo","raw_telemetry_persisted":false}'::jsonb
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  base_url = EXCLUDED.base_url,
  auth_type = EXCLUDED.auth_type,
  auth_value = EXCLUDED.auth_value,
  health_path = EXCLUDED.health_path,
  default_headers = EXCLUDED.default_headers,
  timeout_ms = EXCLUDED.timeout_ms,
  tls_skip_verify = EXCLUDED.tls_skip_verify,
  enabled = true,
  backend_type = EXCLUDED.backend_type,
  config = EXCLUDED.config,
  updated_at = now();

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE backend.name = ANY(ARRAY['aiops-loki', 'aiops-jaeger'])
ON CONFLICT (backend_id, bundle_id) DO NOTHING;

INSERT INTO mcp_tools (
  name, description, backend, query_template, parameters,
  enabled, category, tool_type, is_write, risk_level
)
VALUES
  (
    'aiops_loki_query_range',
    'Query bounded Loki log streams with read-only LogQL.',
    'custom:aiops-loki',
    'GET /loki/api/v1/query_range?query={{query}}&start={{start}}&end={{end}}&limit={{limit}}&direction={{direction}}',
    '[{"name":"query","type":"string","description":"LogQL selector or aggregation","required":true},{"name":"start","type":"string","description":"RFC3339 or nanosecond start timestamp","required":true},{"name":"end","type":"string","description":"RFC3339 or nanosecond end timestamp","required":true},{"name":"limit","type":"number","description":"Maximum log lines, 1 to 100","required":false,"default":50},{"name":"direction","type":"string","description":"forward or backward","required":false,"default":"backward"}]'::jsonb,
    true, 'AIOps Logs', 'dynamic', false, 'low'
  ),
  (
    'aiops_loki_label_values',
    'List Loki label values in a bounded incident window.',
    'custom:aiops-loki',
    'GET /loki/api/v1/label/{{label_name}}/values?start={{start}}&end={{end}}',
    '[{"name":"label_name","type":"string","description":"Loki label name","required":true},{"name":"start","type":"string","description":"RFC3339 or nanosecond start timestamp","required":true},{"name":"end","type":"string","description":"RFC3339 or nanosecond end timestamp","required":true}]'::jsonb,
    true, 'AIOps Logs', 'dynamic', false, 'low'
  ),
  (
    'aiops_jaeger_services',
    'List services currently indexed by the read-only Jaeger query API.',
    'custom:aiops-jaeger',
    'GET /api/services',
    '[]'::jsonb,
    true, 'AIOps Traces', 'dynamic', false, 'low'
  ),
  (
    'aiops_jaeger_find_traces',
    'Find bounded traces for a service and incident window.',
    'custom:aiops-jaeger',
    'GET /api/traces?service={{service}}&start={{start_micros}}&end={{end_micros}}&limit={{limit}}',
    '[{"name":"service","type":"string","description":"Exact Jaeger service name","required":true},{"name":"start_micros","type":"string","description":"Incident window start in Unix microseconds","required":true},{"name":"end_micros","type":"string","description":"Incident window end in Unix microseconds","required":true},{"name":"limit","type":"number","description":"Maximum traces, 1 to 100","required":false,"default":20}]'::jsonb,
    true, 'AIOps Traces', 'dynamic', false, 'low'
  ),
  (
    'aiops_jaeger_get_trace',
    'Get one trace by hexadecimal trace ID for critical-path inspection.',
    'custom:aiops-jaeger',
    'GET /api/traces/{{trace_id}}',
    '[{"name":"trace_id","type":"string","description":"Hexadecimal trace ID returned by Jaeger search","required":true}]'::jsonb,
    true, 'AIOps Traces', 'dynamic', false, 'low'
  )
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  backend = EXCLUDED.backend,
  query_template = EXCLUDED.query_template,
  parameters = EXCLUDED.parameters,
  enabled = true,
  category = EXCLUDED.category,
  tool_type = EXCLUDED.tool_type,
  is_write = false,
  risk_level = 'low',
  updated_at = now();

INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
SELECT tool.id, bundle.id
  FROM mcp_tools tool
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE tool.name = ANY(ARRAY[
   'aiops_loki_query_range',
   'aiops_loki_label_values',
   'aiops_jaeger_services',
   'aiops_jaeger_find_traces',
   'aiops_jaeger_get_trace'
 ])
ON CONFLICT (tool_id, bundle_id) DO NOTHING;

INSERT INTO mcp_bundle_backend_tool_policies (
  backend_id, bundle_id, mode, allowed_tool_names
)
SELECT backend.id, bundle.id, 'selected',
       CASE backend.name
         WHEN 'aiops-loki' THEN ARRAY['aiops_loki_query_range', 'aiops_loki_label_values']::text[]
         ELSE ARRAY['aiops_jaeger_services', 'aiops_jaeger_find_traces', 'aiops_jaeger_get_trace']::text[]
       END
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE backend.name = ANY(ARRAY['aiops-loki', 'aiops-jaeger'])
ON CONFLICT (backend_id, bundle_id) DO UPDATE SET
  mode = EXCLUDED.mode,
  allowed_tool_names = EXCLUDED.allowed_tool_names,
  updated_at = now();

-- Reuse Core's native, redacted observability provider in the same bundle.
-- This is an explicit Bundle assignment, not global Agent access.
INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE backend.name = 'argus-observability'
ON CONFLICT (backend_id, bundle_id) DO NOTHING;

INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
SELECT tool.id, bundle.id
  FROM mcp_tools tool
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE tool.name = ANY(ARRAY[
   'argus_observe_search_traces',
   'argus_observe_get_trace',
   'argus_observe_search_logs',
   'argus_observe_compare_traces'
 ])
ON CONFLICT (tool_id, bundle_id) DO NOTHING;

INSERT INTO mcp_bundle_backend_tool_policies (
  backend_id, bundle_id, mode, allowed_tool_names
)
SELECT backend.id, bundle.id, 'selected', ARRAY[
         'argus_observe_search_traces',
         'argus_observe_get_trace',
         'argus_observe_search_logs',
         'argus_observe_compare_traces'
       ]::text[]
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE backend.name = 'argus-observability'
ON CONFLICT (backend_id, bundle_id) DO UPDATE SET
  mode = EXCLUDED.mode,
  allowed_tool_names = EXCLUDED.allowed_tool_names,
  updated_at = now();

-- The standalone kagent-tools server is only a Kubernetes MCP provider. Argus
-- remains the control plane, owns Agent/model policy and exposes a deliberately
-- selected read-only subset through this Bundle. The Kind host port is bound to
-- loopback; Docker Desktop publishes it to Core as host.docker.internal.
INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled, backend_type,
  mcp_endpoint, config
)
VALUES (
  'aiops-kubernetes',
  'Read-only Kubernetes topology, event and pod-log evidence from the local Argus.AIOps cluster.',
  'http://host.docker.internal:18084',
  'none', NULL, NULL, '{}'::jsonb,
  10000, false, true, 'mcp', '/mcp',
  '{"read_only":true,"provider":"kagent-tools","scope_kind":"kubernetes","target_id":"argus-aiops-kind","target_label":"Local Kind cluster","cluster":"argus-aiops","environment":"local-demo","namespaces":["argus-aiops-system","argus-demo"],"execution_namespaces":["argus-demo"],"allow_secrets":false}'::jsonb
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  base_url = EXCLUDED.base_url,
  auth_type = EXCLUDED.auth_type,
  auth_value = EXCLUDED.auth_value,
  health_path = EXCLUDED.health_path,
  default_headers = EXCLUDED.default_headers,
  timeout_ms = EXCLUDED.timeout_ms,
  tls_skip_verify = EXCLUDED.tls_skip_verify,
  enabled = true,
  backend_type = EXCLUDED.backend_type,
  mcp_endpoint = EXCLUDED.mcp_endpoint,
  config = EXCLUDED.config,
  updated_at = now();

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE backend.name = 'aiops-kubernetes'
ON CONFLICT (backend_id, bundle_id) DO NOTHING;

-- Fail closed: expose only compact, incident-relevant read paths. Full YAML,
-- API discovery, cluster configuration and resource generation stay outside
-- the Agent bundle because their payloads are either too broad or unnecessary.
INSERT INTO mcp_bundle_backend_tool_policies (
  backend_id, bundle_id, mode, allowed_tool_names
)
SELECT backend.id, bundle.id, 'selected', ARRAY[
         'aiops_kubernetes_k8s_get_events',
         'aiops_kubernetes_k8s_get_pod_logs',
         'aiops_kubernetes_k8s_get_resources'
       ]::text[]
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name = 'argus-aiops-observe'
 WHERE backend.name = 'aiops-kubernetes'
ON CONFLICT (backend_id, bundle_id) DO UPDATE SET
  mode = EXCLUDED.mode,
  allowed_tool_names = EXCLUDED.allowed_tool_names,
  updated_at = now();

-- Pack-owned Core Agent declarations. They intentionally do not reuse the
-- generic Argus.Dev researcher/knowledge/reviewer names: those Agents carry
-- repository and pull-request prompts. Model, credential and subscription
-- runtime remain Core-owned and are inherited only for the initial local seed.
INSERT INTO mcp_agents (
  name, label, description, model, temperature, max_tokens, system_prompt,
  agent_role, enabled, max_iterations, agent_mode, bundle_ids,
  runtime_profile_id, llm_credential_profile_id, risk_level,
  human_oversight_required, untrusted_tool_output_enforcement
)
VALUES
  (
    'aiops-researcher', 'AIOps Researcher',
    'Read-only operations researcher that collects bounded provider evidence for Argus.AIOps.',
    COALESCE((SELECT model FROM mcp_agents WHERE name='researcher'), 'claude-opus-4-6'),
    0.10, 8192,
    E'You are the read-only operations researcher for Argus.AIOps. Use only the exact tools advertised for the current signed Solution Pack turn. You MUST execute provider tools before drawing a conclusion. When available, inspect target health, bounded metrics, bounded logs and bounded traces for the same service and incident window. If the incident contract explicitly names a Kubernetes namespace and Kubernetes tools are advertised, inspect Services, Deployments, Pods and recent Events in that namespace. Prefer compact resource-list, event and pod-log queries; use full resource YAML only when a compact query cannot answer a specific evidence gap, and do not retry a missing resource under another kind without list evidence. Keep the investigation to at most ten provider tool calls, then publish a concise terminal response. Never set all_namespaces=true and never enumerate an unrelated namespace. Never use workspace, coding, deployment or mutation tools. Never invent a tool result or numeric value. Separate observations, inferences and evidence gaps.',
    'aiops-researcher', true, 12, 'worker',
    ARRAY[(SELECT id FROM mcp_service_bundles WHERE name='argus-aiops-observe')]::integer[],
    (SELECT runtime_profile_id FROM mcp_agents WHERE name='researcher'),
    (SELECT llm_credential_profile_id FROM mcp_agents WHERE name='researcher'),
    'low', false, true
  ),
  (
    'aiops-knowledge', 'AIOps Knowledge',
    'Read-only runbook and incident-history specialist for Argus.AIOps.',
    COALESCE((SELECT model FROM mcp_agents WHERE name='knowledge'), 'claude-opus-4-6'),
    0.10, 6144,
    E'You are the read-only knowledge specialist for Argus.AIOps. You MUST call an advertised rag_, knowledge, runbook or incident-history tool before answering. Search for this service, symptoms and investigation window. If no tool is advertised or no result is returned, state that no grounded knowledge evidence is available. Never reuse repository context from another service and never invent a source.',
    'aiops-knowledge', true, 5, 'chat',
    ARRAY[(SELECT id FROM mcp_service_bundles WHERE name='argus-aiops-observe')]::integer[],
    (SELECT runtime_profile_id FROM mcp_agents WHERE name='knowledge'),
    (SELECT llm_credential_profile_id FROM mcp_agents WHERE name='knowledge'),
    'low', false, true
  ),
  (
    'aiops-reviewer', 'AIOps Evidence Reviewer',
    'Read-only reviewer that validates operational claims against collected AIOps evidence.',
    COALESCE((SELECT model FROM mcp_agents WHERE name='reviewer'), 'claude-opus-4-6'),
    0.10, 8192,
    E'You are the read-only evidence reviewer for Argus.AIOps. Validate every claim against the supplied collector evidence. Distinguish correlation from causation and explicitly identify missing signals. Do not claim that an unavailable provider was queried. Never perform or recommend an action as if it already happened.',
    'aiops-reviewer', true, 4, 'reviewer',
    ARRAY[(SELECT id FROM mcp_service_bundles WHERE name='argus-aiops-observe')]::integer[],
    (SELECT runtime_profile_id FROM mcp_agents WHERE name='reviewer'),
    (SELECT llm_credential_profile_id FROM mcp_agents WHERE name='reviewer'),
    'low', false, true
  )
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  agent_role = EXCLUDED.agent_role,
  enabled = true,
  max_iterations = EXCLUDED.max_iterations,
  agent_mode = EXCLUDED.agent_mode,
  bundle_ids = EXCLUDED.bundle_ids,
  runtime_profile_id = COALESCE(mcp_agents.runtime_profile_id, EXCLUDED.runtime_profile_id),
  llm_credential_profile_id = COALESCE(mcp_agents.llm_credential_profile_id, EXCLUDED.llm_credential_profile_id),
  risk_level = 'low',
  human_oversight_required = false,
  untrusted_tool_output_enforcement = true,
  updated_at = now();

COMMIT;
