-- Bind provider-write plans to an explicit, Core-normalized recommendation
-- intent. Diagnostic recommendations intentionally keep this column NULL and
-- can never be promoted into an unrelated write operation.

ALTER TABLE mcp_observability_incident_remediations
  ADD COLUMN IF NOT EXISTS execution_intent JSONB;

ALTER TABLE mcp_observability_incident_remediations
  DROP CONSTRAINT IF EXISTS mcp_incident_remediation_execution_intent_check;

ALTER TABLE mcp_observability_incident_remediations
  ADD CONSTRAINT mcp_incident_remediation_execution_intent_check CHECK (
    execution_intent IS NULL OR (
      jsonb_typeof(execution_intent) = 'object'
      AND execution_intent - ARRAY['adapterKey','workloadKind','workloadName','desiredReplicas']::text[] = '{}'::jsonb
      AND execution_intent->>'adapterKey' = 'kubernetes.scale.v1'
      AND execution_intent->>'workloadKind' IN ('Deployment','StatefulSet')
      AND execution_intent->>'workloadName' ~ '^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$'
      AND length(execution_intent->>'workloadName') BETWEEN 1 AND 253
      AND CASE
        WHEN execution_intent->>'desiredReplicas' ~ '^[1-9][0-9]*$'
          THEN (execution_intent->>'desiredReplicas')::integer BETWEEN 1 AND 50
        ELSE false
      END
      AND octet_length(execution_intent::text) <= 2048
    )
  );

COMMENT ON COLUMN mcp_observability_incident_remediations.execution_intent IS
  'Strict, human-reviewable write intent emitted with a normalized recommendation. NULL means read-only diagnosis only.';
