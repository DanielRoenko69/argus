-- Retire the legacy Bitbucket placeholder introduced by migration 097.
--
-- Migration 097 remains immutable so existing migration histories and checksums
-- stay valid. Fresh installations execute this migration after 097 and therefore
-- no longer expose an unusable bitbucket.example.com backend. Existing operators
-- that configured the seeded backend retain it: deletion is deliberately limited
-- to the exact, untouched placeholder state.

DO $$
DECLARE
  legacy_backend_id INTEGER;
BEGIN
  SELECT b.id
    INTO legacy_backend_id
    FROM mcp_backends b
   WHERE b.name = 'bitbucket-default'
     AND b.base_url = 'https://bitbucket.example.com'
     AND b.auth_type = 'bearer'
     AND b.auth_value IS NULL
     AND b.health_path = '/'
     AND b.default_headers = '{}'::jsonb
     AND b.timeout_ms = 30000
     AND b.tls_skip_verify = false
     AND b.enabled = true
     AND b.backend_type = 'http'
     AND b.config = jsonb_build_object(
       'kind', 'bitbucket',
       'project_key', '',
       'user_slug', '',
       'repo_slug', '',
       'default_target_branch', 'master'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM mcp_observability_incident_remediation_change_plans p
        WHERE p.write_backend_id = b.id
     )
   LIMIT 1;

  IF legacy_backend_id IS NOT NULL THEN
    DELETE FROM mcp_backend_bundles
     WHERE backend_id = legacy_backend_id;

    DELETE FROM mcp_backends
     WHERE id = legacy_backend_id;
  END IF;
END
$$;

