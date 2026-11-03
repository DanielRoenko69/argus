-- First-class read-only Observability MCP backend. The dedicated bundle makes
-- exposure explicit for scoped API keys and diagnostic Agents.

INSERT INTO mcp_service_bundles (name, label, description)
VALUES (
  'argus-observability',
  'Argus Observability',
  'Read-only trace, span, structured-log and run-comparison capabilities for diagnostic Agents.'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled,
  backend_type, builtin_key, config
)
VALUES (
  'argus-observability',
  'Native read-only Argus investigation tools. Data stays in the Argus PostgreSQL telemetry store.',
  'argus://observability',
  'none', NULL, NULL, '{}'::jsonb, 10000, false, true,
  'builtin', 'observability', '{"read_only":true,"redaction":"required"}'::jsonb
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  JOIN mcp_service_bundles bundle ON bundle.name='argus-observability'
 WHERE backend.name='argus-observability'
ON CONFLICT (backend_id, bundle_id) DO NOTHING;

INSERT INTO mcp_tools (
  name, description, backend, query_template, parameters,
  enabled, category, tool_type
)
VALUES
  (
    'argus_observe_search_traces', 'Search recent Argus traces by status and kind.',
    'argus-observability', NULL,
    '[{"name":"hours","type":"number","description":"Lookback hours","required":false},{"name":"limit","type":"number","description":"Maximum results","required":false},{"name":"status","type":"string","description":"Trace status","required":false},{"name":"kind","type":"string","description":"Trace kind","required":false}]'::jsonb,
    true, 'Observability', 'builtin'
  ),
  (
    'argus_observe_get_trace', 'Inspect a native Argus trace family and its spans.',
    'argus-observability', NULL,
    '[{"name":"trace_id","type":"string","description":"Native trace UUID","required":true},{"name":"include_family","type":"boolean","description":"Include correlated child runs","required":false},{"name":"include_previews","type":"boolean","description":"Include bounded redacted previews","required":false},{"name":"span_limit","type":"number","description":"Maximum spans","required":false}]'::jsonb,
    true, 'Observability', 'builtin'
  ),
  (
    'argus_observe_search_logs', 'Search redacted structured logs correlated to a trace or span.',
    'argus-observability', NULL,
    '[{"name":"trace_id","type":"string","description":"Trace UUID","required":false},{"name":"root_trace_id","type":"string","description":"Trace family UUID","required":false},{"name":"span_id","type":"string","description":"Span UUID","required":false},{"name":"level","type":"string","description":"Log level","required":false},{"name":"query","type":"string","description":"Message query","required":false},{"name":"limit","type":"number","description":"Maximum results","required":false}]'::jsonb,
    true, 'Observability', 'builtin'
  ),
  (
    'argus_observe_compare_traces', 'Compare latency, cost and failures between two native trace families.',
    'argus-observability', NULL,
    '[{"name":"current_trace_id","type":"string","description":"Current trace UUID","required":true},{"name":"baseline_trace_id","type":"string","description":"Baseline trace UUID","required":true}]'::jsonb,
    true, 'Observability', 'builtin'
  )
ON CONFLICT (name) DO NOTHING;

-- Keep legacy palette/filter paths bundle-aware too. Current policy resolution
-- inherits the backend assignment; the direct link preserves the same scope in
-- older workflow and Agent selectors.
INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
SELECT tool.id, bundle.id
  FROM mcp_tools tool
  JOIN mcp_service_bundles bundle ON bundle.name='argus-observability'
 WHERE tool.name IN (
   'argus_observe_search_traces',
   'argus_observe_get_trace',
   'argus_observe_search_logs',
   'argus_observe_compare_traces'
 )
ON CONFLICT (tool_id, bundle_id) DO NOTHING;

COMMENT ON COLUMN argus_logs.trace_id IS
  'Native trace correlation used by the Argus Observability MCP investigation tools.';
