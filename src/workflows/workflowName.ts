/**
 * Workflow name validation + slugification.
 *
 * `mcp_workflows.name` carries a DB CHECK constraint (db/migrations/010_workflows.sql):
 *     CONSTRAINT wf_name_format CHECK (name ~ '^[a-z0-9_]+$')
 *
 * The create path historically passed the raw name straight to the INSERT, so a
 * human-friendly name with spaces / hyphens / uppercase (e.g. "Coding Workflow")
 * violated the constraint and surfaced as a confusing HTTP 500 (Postgres 23514)
 * instead of a clear validation error. This module is the single source of truth
 * for the rule so the route can reject early (400) and the UIs can slugify.
 */

/** The exact pattern enforced by the `wf_name_format` DB constraint. */
export const WORKFLOW_NAME_RE = /^[a-z0-9_]+$/;

/** True when `name` already satisfies the DB constraint. */
export function isValidWorkflowName(name: string): boolean {
  return WORKFLOW_NAME_RE.test(name);
}

/**
 * Best-effort conversion of a human-friendly name into a constraint-valid slug:
 * strip diacritics, lowercase, collapse every run of disallowed characters into
 * a single underscore, and trim leading/trailing underscores. Returns '' when
 * nothing usable remains (caller must reject that).
 *
 *   "Coding Workflow"      -> "coding_workflow"
 *   "K8s Pod-Restart #1"   -> "k8s_pod_restart_1"
 *   "Täglicher Report"     -> "taglicher_report"
 *   "   "                  -> ""
 */
export function slugifyWorkflowName(raw: string): string {
  return (raw ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '') // drop combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}
