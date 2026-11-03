ALTER TABLE argus_execution_grants
  ADD COLUMN IF NOT EXISTS resource_scope JSONB;

COMMENT ON COLUMN argus_execution_grants.resource_scope IS
  'Optional immutable runtime target selected in Core and bound into the signed Solution Pack execution grant.';
