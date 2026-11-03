-- Per-run, opaque access leases for a managed external runtime's MCP connection.
--
-- The signed execution grant remains the credential.  This table intentionally
-- stores only its JTI and binding metadata, never the bearer token itself.
-- A managed runner must present both values on /mcp/runtime/:leaseId.

CREATE TABLE IF NOT EXISTS argus_runtime_mcp_leases (
  lease_id             UUID PRIMARY KEY,
  execution_grant_id   UUID NOT NULL REFERENCES argus_execution_grants(grant_id) ON DELETE RESTRICT,
  pack_id              VARCHAR(128) NOT NULL,
  adapter_id           VARCHAR(128) NOT NULL,
  core_agent_id        INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE RESTRICT,
  run_id               UUID NOT NULL UNIQUE,
  request_id           UUID NOT NULL,
  root_trace_id        UUID NOT NULL,
  mode                 VARCHAR(16) NOT NULL CHECK (mode IN ('managed')),
  status               VARCHAR(16) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'revoking', 'revoked', 'expired', 'failed', 'completed')),
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at         TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ,
  terminal_at          TIMESTAMPTZ,
  CHECK (expires_at > issued_at),
  UNIQUE (pack_id, adapter_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_argus_runtime_mcp_leases_active
  ON argus_runtime_mcp_leases (lease_id, expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_argus_runtime_mcp_leases_trace
  ON argus_runtime_mcp_leases (root_trace_id, issued_at DESC);

COMMENT ON TABLE argus_runtime_mcp_leases IS
  'Opaque per-run bindings between a managed external runtime and a signed Argus execution grant. Bearer grants are never persisted here.';
