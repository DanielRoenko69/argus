-- First-class read-only native Code Intelligence MCP backend. Index refresh is
-- intentionally not part of this bundle; it will require a separate write-like
-- capability and a commit-bound workspace execution grant.

INSERT INTO mcp_service_bundles (name, label, description)
VALUES (
  'argus-code-intelligence-read',
  'Argus Code Intelligence · Read',
  'Commit-bound symbol, lexical and dependency-graph retrieval over repositories authorized by this Bundle.'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled,
  backend_type, builtin_key, config
)
VALUES (
  'argus-code-intelligence',
  'Native read-only code retrieval stored in Argus PostgreSQL; no external graph service required.',
  'argus://code-intelligence',
  'none', NULL, NULL, '{}'::jsonb, 10000, false, true,
  'builtin', 'code-intelligence', '{"read_only":true,"snapshot_scoped":true,"bundle_scoped":true}'::jsonb
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name='argus-code-intelligence-read'
 WHERE backend.name='argus-code-intelligence'
ON CONFLICT (backend_id, bundle_id) DO NOTHING;

INSERT INTO mcp_tools (
  name, description, backend, query_template, parameters,
  enabled, category, tool_type
)
VALUES
  (
    'argus_code_index_status',
    'List accessible immutable code indexes and their exact repository commit.',
    'argus-code-intelligence', NULL,
    '[{"name":"snapshot_id","type":"number","description":"Exact snapshot id","required":false},{"name":"repository_key","type":"string","description":"Exact repository key","required":false},{"name":"branch_name","type":"string","description":"Exact branch name","required":false},{"name":"limit","type":"number","description":"Maximum results","required":false}]'::jsonb,
    true, 'Code Intelligence', 'builtin'
  ),
  (
    'argus_code_search',
    'Search one accessible immutable code snapshot using symbol, full-text and bounded graph evidence.',
    'argus-code-intelligence', NULL,
    '[{"name":"snapshot_id","type":"number","description":"Exact immutable snapshot id","required":true},{"name":"query","type":"string","description":"Symbol, identifier, error text or code intent","required":true},{"name":"limit","type":"number","description":"Maximum evidence results","required":false},{"name":"include_graph","type":"boolean","description":"Expand one dependency hop","required":false}]'::jsonb,
    true, 'Code Intelligence', 'builtin'
  )
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
SELECT tool.id, bundle.id
  FROM mcp_tools tool
  JOIN mcp_service_bundles bundle ON bundle.name='argus-code-intelligence-read'
 WHERE tool.name IN ('argus_code_index_status', 'argus_code_search')
ON CONFLICT (tool_id, bundle_id) DO NOTHING;

