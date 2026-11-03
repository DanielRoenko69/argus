-- Distinguish a delayed regression rollback from the immediate rollback that
-- can follow a failed provider mutation or first verification attempt.

ALTER TABLE mcp_observability_incident_remediation_events
  DROP CONSTRAINT IF EXISTS mcp_observability_incident_remediation_events_event_type_check;

ALTER TABLE mcp_observability_incident_remediation_events
  ADD CONSTRAINT mcp_observability_incident_remediation_events_event_type_check
  CHECK (event_type IN (
    'proposed','approved','rejected','executed','failed','verified',
    'dry_run_started','dry_run_passed','dry_run_failed',
    'change_plan_created','change_plan_approved','change_plan_rejected',
    'execution_started','execution_succeeded','execution_failed',
    'verification_passed','verification_failed',
    'rollback_succeeded','rollback_failed',
    'post_change_monitor_scheduled','post_change_monitor_started',
    'post_change_healthy','post_change_regressed','post_change_check_failed',
    'post_change_rollback_approved','post_change_rollback_rejected',
    'post_change_rollback_started','post_change_rollback_succeeded',
    'post_change_rollback_failed'
  ));
