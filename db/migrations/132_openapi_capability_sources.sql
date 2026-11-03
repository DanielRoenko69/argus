-- Persist safe OpenAPI source manifests for explicit drift checks.
-- Raw specifications and credentials are deliberately never stored here.

CREATE TABLE IF NOT EXISTS mcp_capability_sources (
  id                            SERIAL PRIMARY KEY,
  source_type                   VARCHAR(16) NOT NULL DEFAULT 'openapi'
                                CHECK (source_type = 'openapi'),
  backend_id                    INTEGER NOT NULL UNIQUE
                                REFERENCES mcp_backends(id) ON DELETE CASCADE,
  name_prefix                   VARCHAR(32) NOT NULL UNIQUE,
  source_kind                   VARCHAR(8) NOT NULL
                                CHECK (source_kind IN ('url', 'text')),
  source_url                    TEXT,
  title                         VARCHAR(200) NOT NULL DEFAULT '',
  openapi_version               VARCHAR(32) NOT NULL DEFAULT '',
  base_url                      TEXT NOT NULL,
  base_url_override             TEXT,
  auth_scheme                   JSONB,
  auth_signature                CHAR(64),
  manifest_version              SMALLINT NOT NULL DEFAULT 1 CHECK (manifest_version = 1),
  spec_digest                   CHAR(64),
  manifest_digest               CHAR(64),
  operation_count               INTEGER NOT NULL DEFAULT 0 CHECK (operation_count BETWEEN 0 AND 500),
  revision                      BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  lifecycle_status              VARCHAR(16) NOT NULL DEFAULT 'unchecked'
                                CHECK (lifecycle_status IN ('unchecked', 'current', 'drifted', 'error')),
  last_checked_at               TIMESTAMPTZ,
  last_observed_spec_digest     CHAR(64),
  last_observed_manifest_digest CHAR(64),
  last_check_summary            JSONB,
  last_check_error_code         VARCHAR(64),
  imported_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (source_kind = 'url' AND source_url IS NOT NULL)
    OR (source_kind = 'text' AND source_url IS NULL)
  ),
  CHECK (source_url IS NULL OR source_url ~ '^https?://' AND position('?' IN source_url) = 0 AND position('#' IN source_url) = 0),
  CHECK (auth_signature IS NULL OR auth_signature ~ '^[0-9a-f]{64}$'),
  CHECK (
    auth_scheme IS NULL OR (
      (
      jsonb_typeof(auth_scheme) = 'object'
      AND auth_scheme ?& ARRAY['type', 'headerName']
      AND (auth_scheme - ARRAY['type', 'headerName']::text[]) = '{}'::jsonb
      AND auth_scheme->>'type' IN ('none', 'bearer', 'basic', 'header')
      AND (
        (auth_scheme->>'type' = 'header' AND jsonb_typeof(auth_scheme->'headerName') = 'string'
          AND length(auth_scheme->>'headerName') BETWEEN 1 AND 128
          AND auth_scheme->>'headerName' ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]+$')
        OR (auth_scheme->>'type' <> 'header' AND auth_scheme->'headerName' = 'null'::jsonb)
      )
      ) IS TRUE
    )
  ),
  CHECK (spec_digest IS NULL OR spec_digest ~ '^[0-9a-f]{64}$'),
  CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[0-9a-f]{64}$'),
  CHECK (last_observed_spec_digest IS NULL OR last_observed_spec_digest ~ '^[0-9a-f]{64}$'),
  CHECK (last_observed_manifest_digest IS NULL OR last_observed_manifest_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS mcp_capability_source_operations (
  source_id       INTEGER NOT NULL REFERENCES mcp_capability_sources(id) ON DELETE CASCADE,
  operation_key   VARCHAR(2056) NOT NULL,
  tool_id         INTEGER REFERENCES mcp_tools(id) ON DELETE SET NULL,
  tool_name       VARCHAR(64) NOT NULL,
  method          VARCHAR(8) NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  path            TEXT NOT NULL,
  is_write        BOOLEAN NOT NULL,
  supported       BOOLEAN NOT NULL,
  signature_version SMALLINT NOT NULL DEFAULT 1 CHECK (signature_version = 1),
  signature       CHAR(64) NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (source_id, operation_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_capability_source_operations_tool
  ON mcp_capability_source_operations(tool_id)
  WHERE tool_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capability_sources_status
  ON mcp_capability_sources(lifecycle_status, updated_at DESC);

-- Existing importer-owned backends remain visible, but intentionally have no
-- invented baseline digest. One confirmed re-import establishes a trustworthy
-- canonical baseline and operation mapping.
INSERT INTO mcp_capability_sources (
  backend_id, name_prefix, source_kind, source_url, title, openapi_version,
  base_url, base_url_override, auth_scheme, auth_signature, spec_digest,
  manifest_digest, operation_count, lifecycle_status, imported_at
)
SELECT backend.id,
       backend.name,
       'text',
       NULL,
       backend.name,
       '',
       backend.base_url,
       NULL,
       NULL,
       NULL,
       NULL,
       NULL,
       0,
       'unchecked',
       COALESCE(backend.updated_at, backend.created_at, now())
  FROM mcp_backends backend
 WHERE backend.backend_type = 'http'
   AND backend.name ~ '^[a-z][a-z0-9_-]{0,31}$'
   AND (
     backend.config->>'managed_by' = 'openapi'
     OR (
       backend.description = 'Imported from OpenAPI'
       AND EXISTS (
         SELECT 1
           FROM mcp_tools tool
          WHERE tool.category = 'openapi:' || backend.name
            AND tool.backend = 'custom:' || backend.name
       )
     )
   )
ON CONFLICT (backend_id) DO NOTHING;

COMMENT ON TABLE mcp_capability_sources IS
  'Credential-free canonical baselines and lifecycle state for imported capability sources.';
COMMENT ON TABLE mcp_capability_source_operations IS
  'Complete mapped OpenAPI operation baseline; tool_id is NULL for unselected or unsupported operations.';
