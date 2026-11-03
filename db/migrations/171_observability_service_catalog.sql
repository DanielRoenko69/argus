-- Cached, provider-neutral service identities discovered through governed
-- observability and Kubernetes read paths. Raw provider payloads remain at the
-- source; Core persists only bounded identity and provenance fields.

CREATE TABLE IF NOT EXISTS mcp_observability_service_catalog_evidence (
  id             BIGSERIAL PRIMARY KEY,
  identity_key   VARCHAR(64) NOT NULL UNIQUE,
  service_name   VARCHAR(160) NOT NULL,
  environment    VARCHAR(120) NOT NULL,
  source         VARCHAR(32) NOT NULL
                 CHECK (source IN ('kubernetes', 'opentelemetry')),
  source_ref     VARCHAR(200) NOT NULL,
  bundle_id      INTEGER REFERENCES mcp_service_bundles(id) ON DELETE SET NULL,
  backend_id     INTEGER REFERENCES mcp_backends(id) ON DELETE SET NULL,
  target_id      VARCHAR(128),
  cluster        VARCHAR(200),
  namespace      VARCHAR(63),
  workload_kind  VARCHAR(64),
  workload_name  VARCHAR(200),
  attributes     JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at    TIMESTAMPTZ NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_observability_service_catalog_name_check
    CHECK (length(btrim(service_name)) > 0),
  CONSTRAINT mcp_observability_service_catalog_expiry_check
    CHECK (expires_at > observed_at)
);

CREATE INDEX IF NOT EXISTS idx_observability_service_catalog_lookup
  ON mcp_observability_service_catalog_evidence
  (environment, service_name, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_observability_service_catalog_target
  ON mcp_observability_service_catalog_evidence
  (backend_id, target_id, namespace, observed_at DESC)
  WHERE backend_id IS NOT NULL;

COMMENT ON TABLE mcp_observability_service_catalog_evidence IS
  'Bounded service identity evidence discovered through certified read-only MCP and telemetry providers; excludes raw telemetry and credentials.';
