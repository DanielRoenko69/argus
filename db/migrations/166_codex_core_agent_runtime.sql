-- Enable the Codex subscription profile for Core-governed Agent turns.
-- AIOps deliberately runs researcher and knowledge collection in parallel,
-- therefore the local bridge needs two bounded runtime slots.

UPDATE mcp_agent_runtime_profiles
   SET max_concurrent_runs = 2,
       allowed_task_types = ARRAY(
         SELECT DISTINCT task_type
           FROM unnest(allowed_task_types || ARRAY['agent_turn']) AS task_type
          ORDER BY task_type
       )
 WHERE name = 'codex-subscription-local';
