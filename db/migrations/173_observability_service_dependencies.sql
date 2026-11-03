-- Bounded service dependency evidence extracted from provider-owned traces.
-- Raw spans and arbitrary tags remain in the tracing backend. Each row is one
-- deduplicated, semantically explicit runtime relation.

CREATE TABLE IF NOT EXISTS mcp_observability_service_dependency_evidence (
  id                BIGSERIAL PRIMARY KEY,
  identity_key      VARCHAR(64) NOT NULL UNIQUE,
  environment       VARCHAR(120) NOT NULL,
  source_service    VARCHAR(160) NOT NULL,
  target_kind       VARCHAR(24) NOT NULL
                    CHECK (target_kind IN ('service', 'database', 'messaging', 'external')),
  target_name       VARCHAR(160) NOT NULL,
  relation          VARCHAR(24) NOT NULL
                    CHECK (relation IN ('calls', 'queries', 'publishes')),
  bundle_id         INTEGER REFERENCES mcp_service_bundles(id) ON DELETE SET NULL,
  source_ref        VARCHAR(200) NOT NULL,
  duration_ms       BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  failed            BOOLEAN NOT NULL DEFAULT false,
  observed_at       TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_observability_service_dependency_distinct_check
    CHECK (lower(source_service) <> lower(target_name)),
  CONSTRAINT mcp_observability_service_dependency_expiry_check
    CHECK (expires_at > observed_at)
);

CREATE INDEX IF NOT EXISTS idx_observability_service_dependency_source
  ON mcp_observability_service_dependency_evidence
  (environment, source_service, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_observability_service_dependency_target
  ON mcp_observability_service_dependency_evidence
  (environment, target_kind, target_name, observed_at DESC);

COMMENT ON TABLE mcp_observability_service_dependency_evidence IS
  'Deduplicated runtime dependency edges extracted from explicit trace semantics; excludes raw spans, payloads and arbitrary tags.';

