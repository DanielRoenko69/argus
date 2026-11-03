-- Durable, privacy-minimized evidence for governed Kubernetes connector targets.
-- Raw Kubernetes snapshots, credentials and contract bodies are deliberately excluded.

CREATE TABLE IF NOT EXISTS mcp_kubernetes_connector_certifications (
  id                BIGSERIAL PRIMARY KEY,
  backend_id        INTEGER NOT NULL REFERENCES mcp_backends(id) ON DELETE CASCADE,
  target_id         VARCHAR(128) NOT NULL,
  platform          VARCHAR(16) NOT NULL
                    CHECK (platform IN ('kubernetes', 'aks', 'eks', 'gke', 'openshift')),
  profile           VARCHAR(32) NOT NULL
                    CHECK (profile IN ('in-cluster-read-only', 'production')),
  status            VARCHAR(16) NOT NULL
                    CHECK (status IN ('passed', 'failed')),
  contract_sha256   CHAR(64) NOT NULL CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
  report_sha256     CHAR(64) NOT NULL CHECK (report_sha256 ~ '^[a-f0-9]{64}$'),
  checks            JSONB NOT NULL DEFAULT '[]'::jsonb,
  check_count       INTEGER NOT NULL CHECK (check_count > 0 AND check_count <= 256),
  passed_count      INTEGER NOT NULL CHECK (passed_count >= 0),
  failed_count      INTEGER NOT NULL CHECK (failed_count >= 0),
  generated_at      TIMESTAMPTZ NOT NULL,
  imported_by       VARCHAR(160),
  imported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_kubernetes_connector_certifications_counts_check
    CHECK (passed_count + failed_count = check_count),
  CONSTRAINT mcp_kubernetes_connector_certifications_report_unique
    UNIQUE (backend_id, target_id, report_sha256)
);

CREATE INDEX IF NOT EXISTS idx_kubernetes_connector_certifications_latest
  ON mcp_kubernetes_connector_certifications (backend_id, target_id, generated_at DESC, id DESC);

COMMENT ON TABLE mcp_kubernetes_connector_certifications IS
  'Persistent connector certification summaries bound to governed MCP Fabric targets; excludes raw cluster snapshots and credentials.';

