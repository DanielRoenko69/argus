// Mirror of the backend src/workflows/workflowName.ts rule. Workflow names must
// satisfy the DB CHECK constraint wf_name_format (^[a-z0-9_]+$); the builder
// slugifies the user's free-text name before POST so "Coding Workflow" becomes
// "coding_workflow" instead of triggering a 500/400 from the constraint.

export const WORKFLOW_NAME_RE = /^[a-z0-9_]+$/;

export function isValidWorkflowName(name: string): boolean {
  return WORKFLOW_NAME_RE.test(name);
}

/** Lowercase, strip diacritics, collapse disallowed-char runs to '_', trim '_'.
 *  Returns '' when nothing usable remains. */
export function slugifyWorkflowName(raw: string): string {
  return (raw ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}
