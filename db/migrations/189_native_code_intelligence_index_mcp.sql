-- Indexing is compute-heavy and writes derived repository data. Keep it on a
-- distinct backend/Bundle so the read Bundle can never grant refresh rights.

INSERT INTO mcp_service_bundles (name, label, description)
VALUES (
  'argus-code-intelligence-index',
  'Argus Code Intelligence · Index',
  'Request commit-bound native code indexing for the exact signed Dev workspace. Must be combined with a repository Bundle.'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled,
  backend_type, builtin_key, config
)
VALUES (
  'argus-code-indexer',
  'Core-owned Graphify indexing for an execution-grant-bound workspace. No caller-controlled filesystem root.',
  'argus://code-indexer',
  'none', NULL, NULL, '{}'::jsonb, 330000, false, true,
  'builtin', 'code-indexer', '{"read_only":false,"destructive":false,"workspace_bound":true,"bundle_scoped":true}'::jsonb
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name='argus-code-intelligence-index'
 WHERE backend.name='argus-code-indexer'
ON CONFLICT (backend_id, bundle_id) DO NOTHING;

INSERT INTO mcp_tools (
  name, description, backend, query_template, parameters,
  enabled, category, tool_type
)
VALUES (
  'argus_code_request_reindex',
  'Build or reuse a native code index for the exact signed workspace Git commit.',
  'argus-code-indexer', NULL, '[]'::jsonb,
  true, 'Code Intelligence Index', 'builtin'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
SELECT tool.id, bundle.id
  FROM mcp_tools tool
  JOIN mcp_service_bundles bundle ON bundle.name='argus-code-intelligence-index'
 WHERE tool.name='argus_code_request_reindex'
ON CONFLICT (tool_id, bundle_id) DO NOTHING;

