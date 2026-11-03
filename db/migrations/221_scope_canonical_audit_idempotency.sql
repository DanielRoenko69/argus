-- Scope producer idempotency to the same isolation boundary as the audit chain.
-- Equal client-generated keys in different workspaces, tenants or environments
-- must never return or suppress another principal's event.

ALTER TABLE mcp_canonical_audit_events
  DROP CONSTRAINT IF EXISTS mcp_canonical_audit_events_producer_name_producer_event_id_key;

ALTER TABLE mcp_canonical_audit_events
  ADD CONSTRAINT mcp_canonical_audit_events_scoped_producer_event_key
  UNIQUE (workspace_key, tenant_key, environment, producer_name, producer_event_id);
