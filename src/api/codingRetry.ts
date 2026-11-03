/**
 * Provider-neutral retry helpers for Argus Dev workflows.
 *
 * A retry is a new LangGraph thread, but it must carry the original
 * workflow input and bundle scope forward. Keeping this logic separate from
 * the HTTP route makes the contract testable without a running LangGraph
 * instance and prevents the legacy ticket/description path from becoming the
 * default for newer workflows.
 */

export type RetryRecord = Record<string, unknown>;

/** User-supplied fields for each registered Argus Dev workflow. */
export const WORKFLOW_INPUT_FIELDS: Record<string, readonly string[]> = {
  coding_workflow: ['ticket_id', 'description'],
  'ticket-to-pull-request': ['ticket_id', 'description'],
  pull_request_review: ['repository', 'pull_request_number', 'review_goal', 'next_action'],
  'pull-request-review': ['repository', 'pull_request_number', 'review_goal', 'next_action'],
  ci_failure_recovery: [
    'ticket_id', 'repository', 'branch_name', 'commit_sha', 'ci_provider', 'ci_workflow',
    'ci_run_url', 'ci_failure_context',
  ],
  'ci-failure-recovery': [
    'ticket_id', 'repository', 'branch_name', 'commit_sha', 'ci_provider', 'ci_workflow',
    'ci_run_url', 'ci_failure_context',
  ],
  security_remediation: [
    'ticket_id', 'repository', 'source_branch', 'security_finding_id', 'security_tool',
    'security_severity', 'security_package', 'security_current_version', 'security_fixed_version',
    'security_finding_context',
  ],
  'security-remediation': [
    'ticket_id', 'repository', 'source_branch', 'security_finding_id', 'security_tool',
    'security_severity', 'security_package', 'security_current_version', 'security_fixed_version',
    'security_finding_context',
  ],
  release_notes: ['release_id', 'repository', 'source_branch', 'release_version', 'release_scope', 'release_goal'],
  'release-notes': ['release_id', 'repository', 'source_branch', 'release_version', 'release_scope', 'release_goal'],
  backlog_grooming: [
    'backlog_id', 'repository', 'source_branch', 'issue_title', 'issue_body', 'backlog_constraints',
    'backlog_audience',
  ],
  'backlog-grooming': [
    'backlog_id', 'repository', 'source_branch', 'issue_title', 'issue_body', 'backlog_constraints',
    'backlog_audience',
  ],
};

const BUNDLE_FIELDS = ['argus_bundle_id', 'argus_workflow_id'] as const;

const RETRY_FEEDBACK_FIELD: Record<string, string> = {
  coding_workflow: 'description',
  'ticket-to-pull-request': 'description',
  pull_request_review: 'review_goal',
  'pull-request-review': 'review_goal',
  ci_failure_recovery: 'ci_failure_context',
  'ci-failure-recovery': 'ci_failure_context',
  security_remediation: 'security_finding_context',
  'security-remediation': 'security_finding_context',
  release_notes: 'release_goal',
  'release-notes': 'release_goal',
  backlog_grooming: 'issue_body',
  'backlog-grooming': 'issue_body',
};

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  return true;
}

function record(value: unknown): RetryRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RetryRecord
    : {};
}

/**
 * Keep only known user input fields and bundle references. This deliberately
 * drops runtime secrets such as apiToken, execution grants and provider
 * credentials before persisting retry metadata.
 */
export function sanitizeWorkflowInput(workflowType: string, input: RetryRecord): RetryRecord {
  const fields = WORKFLOW_INPUT_FIELDS[workflowType] ?? WORKFLOW_INPUT_FIELDS.coding_workflow;
  const result: RetryRecord = {};
  for (const field of [...fields, ...BUNDLE_FIELDS]) {
    const value = input[field];
    if (isPresent(value)) result[field] = value;
  }
  return result;
}

/** Reconstruct the original input for legacy threads that predate metadata. */
export function workflowInputFromState(
  workflowType: string,
  state: { metadata?: RetryRecord; values?: RetryRecord },
): RetryRecord {
  const metadata = record(state.metadata);
  const values = record(state.values);
  const persisted = record(metadata['workflow_input']);
  const fields = WORKFLOW_INPUT_FIELDS[workflowType] ?? WORKFLOW_INPUT_FIELDS.coding_workflow;
  const result: RetryRecord = {};
  for (const field of [...fields, ...BUNDLE_FIELDS]) {
    const candidate = [persisted[field], values[field], metadata[field]].find(isPresent);
    if (candidate !== undefined) result[field] = candidate;
  }
  return sanitizeWorkflowInput(workflowType, result);
}

/** Historical failures are metadata, not a new task instruction. */
export function buildRetryInput(workflowType: string, originalInput: RetryRecord, _errorContext: string): RetryRecord {
  const result = sanitizeWorkflowInput(workflowType, originalInput);
  const field = RETRY_FEEDBACK_FIELD[workflowType] ?? 'description';
  const base = typeof result[field] === 'string' ? result[field].trim() : '';
  result[field] = base.replace(/(?:\n\n)?---\nPrevious attempt failure:\n[\s\S]*\n\nPlease address the failure and rerun the relevant checks\.$/, '').trimEnd();
  return result;
}
