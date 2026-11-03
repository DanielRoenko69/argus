-- Extend the strict recommendation intent contract with the second registered
-- Core adapter. Each branch retains an exact key set; arbitrary JSON fields or
-- provider operations remain invalid at the persistence boundary.

ALTER TABLE mcp_observability_incident_remediations
  DROP CONSTRAINT IF EXISTS mcp_incident_remediation_execution_intent_check;

ALTER TABLE mcp_observability_incident_remediations
  ADD CONSTRAINT mcp_incident_remediation_execution_intent_check CHECK (
    execution_intent IS NULL OR (
      jsonb_typeof(execution_intent) = 'object'
      AND execution_intent->>'workloadName' ~ '^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$'
      AND length(execution_intent->>'workloadName') BETWEEN 1 AND 253
      AND octet_length(execution_intent::text) <= 2048
      AND (
        (
          execution_intent - ARRAY['adapterKey','workloadKind','workloadName','desiredReplicas']::text[] = '{}'::jsonb
          AND execution_intent->>'adapterKey' = 'kubernetes.scale.v1'
          AND execution_intent->>'workloadKind' IN ('Deployment','StatefulSet')
          AND CASE
            WHEN execution_intent->>'desiredReplicas' ~ '^[1-9][0-9]?$'
              THEN (execution_intent->>'desiredReplicas')::integer BETWEEN 1 AND 50
            ELSE false
          END
        ) OR (
          execution_intent - ARRAY['adapterKey','workloadKind','workloadName','targetRevision']::text[] = '{}'::jsonb
          AND execution_intent->>'adapterKey' = 'kubernetes.deployment-revision-rollback.v1'
          AND execution_intent->>'workloadKind' = 'Deployment'
          AND CASE
            WHEN execution_intent->>'targetRevision' ~ '^[1-9][0-9]{0,8}$|^1000000000$'
              THEN (execution_intent->>'targetRevision')::integer BETWEEN 1 AND 1000000000
            ELSE false
          END
        )
      )
    )
  );

COMMENT ON COLUMN mcp_observability_incident_remediations.execution_intent IS
  'Strict, versioned Core adapter intent. NULL is read-only; exact scale and retained Deployment revision contracts are allowed.';
