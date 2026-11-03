-- Public release: Argus ships without pre-built skills except the Workflow
-- Copilot skills (workflow-copilot-builder, workflow-copilot-field) that the
-- visual workflow builder depends on.
--
-- Earlier migrations still create these skills because later statements in
-- the same migrations bind them to historical agents by name. This final step
-- removes them again so a fresh installation starts with an empty skill
-- catalog. Agent/bundle bindings cascade; compliance frameworks fall back to
-- "no checklist authored yet" (skill_id ON DELETE SET NULL). Immutable skill
-- revision history rows are intentionally retained.
--
-- Numbered 9000 so it sorts after every regular migration on a fresh install.

UPDATE mcp_agent_templates
   SET skill_names = ARRAY(
         SELECT skill_name
           FROM unnest(skill_names) AS skill_name
          WHERE skill_name NOT IN (
            'eu_ai_act_checklist', 'nis2_checklist', 'iso27001_checklist', 'dora_checklist', 'soc2_checklist',
            'architecture-diagram',
            'argus-coding-standards', 'jira-workflow-protocol', 'pr-creation-protocol',
            'confluence-knowledge-protocol', 'code-review-protocol', 'guardrails-safety',
            'helmrelease-feature-template', 'feature-cleanup-protocol'
          )
       ),
       updated_at = now()
 WHERE skill_names && ARRAY[
   'eu_ai_act_checklist', 'nis2_checklist', 'iso27001_checklist', 'dora_checklist', 'soc2_checklist',
   'architecture-diagram',
   'argus-coding-standards', 'jira-workflow-protocol', 'pr-creation-protocol',
   'confluence-knowledge-protocol', 'code-review-protocol', 'guardrails-safety',
   'helmrelease-feature-template', 'feature-cleanup-protocol'
 ]::text[];

DELETE FROM mcp_skills
 WHERE name IN (
   'eu_ai_act_checklist', 'nis2_checklist', 'iso27001_checklist', 'dora_checklist', 'soc2_checklist',
   'architecture-diagram',
   'argus-coding-standards', 'jira-workflow-protocol', 'pr-creation-protocol',
   'confluence-knowledge-protocol', 'code-review-protocol', 'guardrails-safety',
   'helmrelease-feature-template', 'feature-cleanup-protocol'
 );
