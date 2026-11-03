-- Extend the bounded service catalog with provider-owned log presence.
-- Core stores only the service/environment identity and provenance. Raw log
-- lines remain in the configured logging backend.

ALTER TABLE mcp_observability_service_catalog_evidence
  DROP CONSTRAINT IF EXISTS mcp_observability_service_catalog_evidence_source_check;

ALTER TABLE mcp_observability_service_catalog_evidence
  ADD CONSTRAINT mcp_observability_service_catalog_evidence_source_check
  CHECK (source IN ('kubernetes', 'opentelemetry', 'logs'));

