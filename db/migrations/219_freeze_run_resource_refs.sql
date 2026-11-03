-- Freeze primary resource and tag references at run creation time.
--
-- The database boundary covers every current workflow/Agent creation path,
-- including builder runs, schedules, webhooks, retries, sub-workflows and
-- externally reported Agent telemetry. Existing historical rows remain
-- untouched because current catalog state cannot be reconstructed honestly.

CREATE OR REPLACE FUNCTION argus_frozen_tags_for_resource(
  p_resource_type VARCHAR,
  p_resource_id TEXT
)
RETURNS JSONB AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', tag.id::text,
        'label', tag.label,
        'color', tag.color
      )
      ORDER BY lower(tag.label), tag.id
    ),
    '[]'::jsonb
  )
  FROM mcp_resource_tag_assignments assignment
  JOIN mcp_workspace_tags tag
    ON tag.workspace_key=assignment.workspace_key
   AND tag.id=assignment.tag_id
  WHERE assignment.workspace_key='default'
    AND assignment.resource_type=p_resource_type
    AND assignment.resource_id=p_resource_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION argus_freeze_workflow_execution_resource_refs()
RETURNS TRIGGER AS $$
DECLARE
  captured_at TEXT;
  workflow_ref JSONB;
  agent_refs JSONB;
  existing_refs JSONB;
BEGIN
  IF TG_OP='UPDATE' THEN
    existing_refs := OLD.execution_snapshot->'resourceRefs';
    IF existing_refs IS NOT NULL THEN
      NEW.execution_snapshot := jsonb_set(
        COALESCE(NEW.execution_snapshot, '{}'::jsonb),
        '{resourceRefs}',
        existing_refs,
        true
      );
    END IF;
    RETURN NEW;
  END IF;

  existing_refs := NEW.execution_snapshot->'resourceRefs';
  IF jsonb_typeof(existing_refs)='array' AND jsonb_array_length(existing_refs)>0 THEN
    RETURN NEW;
  END IF;

  captured_at := to_char(
    NEW.started_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  SELECT jsonb_build_object(
           'type', 'workflow',
           'id', workflow.id::text,
           'label', replace(workflow.name, '_', ' '),
           'href', '/build/workflows/studio/' || workflow.id::text,
           'version', (
             SELECT version.version::text
             FROM mcp_workflow_versions version
             WHERE version.workflow_id=workflow.id
               AND version.saved_at<=NEW.started_at
             ORDER BY version.version DESC
             LIMIT 1
           ),
           'tags', argus_frozen_tags_for_resource('workflow', workflow.id::text),
           'capturedAt', captured_at
         )
    INTO workflow_ref
    FROM mcp_workflows workflow
   WHERE workflow.id=NEW.workflow_id;

  WITH assigned_agent_ids AS (
    SELECT DISTINCT (assignment->>'agentId')::integer AS agent_id
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(NEW.execution_snapshot->'assignments')='array'
          THEN NEW.execution_snapshot->'assignments'
        ELSE '[]'::jsonb
      END
    ) assignment
    WHERE assignment->>'agentId' ~ '^[1-9][0-9]*$'
  )
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'type', 'agent',
               'id', agent.id::text,
               'label', COALESCE(NULLIF(btrim(agent.label), ''), agent.name),
               'href', '/build/agents/' || agent.id::text,
               'version', NULL,
               'tags', argus_frozen_tags_for_resource('agent', agent.id::text),
               'capturedAt', captured_at
             )
             ORDER BY agent.id
           ),
           '[]'::jsonb
         )
    INTO agent_refs
    FROM assigned_agent_ids assigned
    JOIN mcp_agents agent ON agent.id=assigned.agent_id;

  NEW.execution_snapshot := COALESCE(NEW.execution_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'resourceRefs',
      COALESCE(jsonb_build_array(workflow_ref), '[]'::jsonb)
        || COALESCE(agent_refs, '[]'::jsonb)
    );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_freeze_workflow_execution_resource_refs
  ON mcp_workflow_executions;
CREATE TRIGGER trg_freeze_workflow_execution_resource_refs
  BEFORE INSERT OR UPDATE OF execution_snapshot ON mcp_workflow_executions
  FOR EACH ROW EXECUTE FUNCTION argus_freeze_workflow_execution_resource_refs();

CREATE OR REPLACE FUNCTION argus_freeze_agent_trace_resource_refs()
RETURNS TRIGGER AS $$
DECLARE
  captured_at TEXT;
  agent_ref JSONB;
  existing_refs JSONB;
BEGIN
  IF TG_OP='UPDATE' THEN
    existing_refs := OLD.metadata->'resourceRefs';
    IF existing_refs IS NOT NULL THEN
      NEW.metadata := jsonb_set(
        COALESCE(NEW.metadata, '{}'::jsonb),
        '{resourceRefs}',
        existing_refs,
        true
      );
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind<>'agent' OR NEW.agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  existing_refs := NEW.metadata->'resourceRefs';
  IF jsonb_typeof(existing_refs)='array' AND jsonb_array_length(existing_refs)>0 THEN
    RETURN NEW;
  END IF;

  captured_at := to_char(
    NEW.started_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  SELECT jsonb_build_object(
           'type', 'agent',
           'id', agent.id::text,
           'label', COALESCE(NULLIF(btrim(agent.label), ''), agent.name),
           'href', '/build/agents/' || agent.id::text,
           'version', NULL,
           'tags', argus_frozen_tags_for_resource('agent', agent.id::text),
           'capturedAt', captured_at
         )
    INTO agent_ref
    FROM mcp_agents agent
   WHERE agent.id=NEW.agent_id;

  IF agent_ref IS NOT NULL THEN
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object('resourceRefs', jsonb_build_array(agent_ref));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_freeze_agent_trace_resource_refs
  ON mcp_observability_traces;
CREATE TRIGGER trg_freeze_agent_trace_resource_refs
  BEFORE INSERT OR UPDATE OF metadata ON mcp_observability_traces
  FOR EACH ROW EXECUTE FUNCTION argus_freeze_agent_trace_resource_refs();

COMMENT ON FUNCTION argus_frozen_tags_for_resource(VARCHAR, TEXT) IS
  'Builds the immutable TagRef array embedded into new run resource evidence.';
COMMENT ON FUNCTION argus_freeze_workflow_execution_resource_refs() IS
  'Freezes Workflow and resolved Agent ResourceRefs on insert and preserves them on later updates.';
COMMENT ON FUNCTION argus_freeze_agent_trace_resource_refs() IS
  'Freezes the primary Agent ResourceRef on telemetry insert and preserves it on later updates.';
