export type WorkflowFieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'select';
export type WorkflowStageKind = 'workspace' | 'plan' | 'knowledge' | 'code' | 'test' | 'review' | 'approval' | 'delivery';
export const BACKLOG_REVIEW_MAX_ATTEMPTS = 2;
const configuredCodingRetries = Number(process.env['MAX_REVIEW_RETRIES'] ?? '4');
export const CODING_MAX_REVISIONS = Number.isInteger(configuredCodingRetries) && configuredCodingRetries >= 0 ? configuredCodingRetries : 4;

export interface WorkflowInputOption {
  value: string;
  label: string;
}

export interface WorkflowInputField {
  name: string;
  label: string;
  type: WorkflowFieldType;
  required: boolean;
  placeholder?: string;
  description?: string;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  options?: WorkflowInputOption[];
}

export interface WorkflowStageDefinition {
  id: string;
  label: string;
  hint: string;
  kind: WorkflowStageKind;
}

export interface WorkflowCatalogEntry {
  id: string;
  graphId: string;
  label: string;
  description: string;
  tags: string[];
  inputSchema: WorkflowInputField[];
  stages: WorkflowStageDefinition[];
  approvalGates: string[];
  requiredAgents: string[];
  titleField: string;
  titlePrefix?: string;
  descriptionField?: string;
  /** Hard MCP Fabric categories required before this workflow can start. */
  requiredBundleCategories: string[];
  /** Helpful integrations shown in the launch preflight but not hard-gated. */
  recommendedBundleCategories?: string[];
  /** Informational current policy; never an authorization or human approval. */
  reviewPolicy?: { maxAttempts: number };
  revisionPolicy?: { maxRevisions: number };
  completionCriteria: {
    trueFields: string[];
    nonEmptyFields: string[];
  };
  origin?: 'builtin' | 'visual-builder';
  revision?: number;
}

const catalog: WorkflowCatalogEntry[] = [
  {
    id: 'ticket-to-pull-request',
    graphId: 'coding_workflow',
    label: 'Ticket to pull request',
    description: 'Turn a scoped ticket into tested, reviewed and human-approved delivery evidence.',
    revisionPolicy: { maxRevisions: CODING_MAX_REVISIONS },
    tags: ['ticket', 'implementation', 'testing', 'pull-request'],
    inputSchema: [
      { name: 'ticket_id', label: 'Ticket ID', type: 'text', required: true, placeholder: 'ARGUS-123' },
      { name: 'issue_reference', label: 'Gitea issue URL or number', type: 'text', required: false, description: 'Select the repository Bundle, paste its issue URL or number, then Load issue. New runs/retries verify the reviewed version; old runs keep their snapshot.' },
      { name: 'issue_sha256', label: 'Reviewed issue fingerprint', type: 'text', required: false, description: 'Filled by Load issue. An issue is reference data, never authorization.' },
      { name: 'description', label: 'Implementation brief', type: 'textarea', required: true, placeholder: 'Describe the intended behavior, constraints and acceptance criteria.' },
      { name: 'planning_thread_id', label: 'Approved planning run ID', type: 'text', required: false, description: 'Optional Backlog Planning thread UUID. Argus verifies ownership, repository and human approval, then imports the handoff.' },
      { name: 'allowed_files', label: 'Allowed change paths', type: 'textarea', required: false, description: 'Leave empty for repository-scoped implementation and tests. Optionally narrow to exact file paths (one per line). Credentials, CI, dependency/build configuration and agent-policy files remain protected; use a separately reviewed workflow for those changes.' },
      { name: 'ci_job', label: 'Jenkins job', type: 'text', required: false, description: 'Exact configured job name. Required when this repository has more than one Jenkins pipeline. Does not grant access to other jobs.' },
      {
        name: 'ci_provider',
        label: 'CI provider',
        type: 'select',
        required: true,
        defaultValue: 'gitea',
        options: [
          { value: 'gitea', label: 'Gitea Actions' },
          { value: 'github', label: 'GitHub Actions' },
          { value: 'gitlab', label: 'GitLab CI' },
          { value: 'jenkins', label: 'Jenkins' },
        ],
      },
    ],
    stages: [
      { id: 'setup_workspace', label: 'Workspace', hint: 'Clone & reset', kind: 'workspace' },
      { id: 'planner', label: 'Plan', hint: 'Planner agent', kind: 'plan' },
      { id: 'knowledge', label: 'Knowledge', hint: 'RAG & patterns', kind: 'knowledge' },
      { id: 'test_design', label: 'QA design', hint: 'Independent test cases', kind: 'test' },
      { id: 'design_refinement', label: 'Design clarification', hint: 'Up to 2 internal rounds', kind: 'plan' },
      { id: 'technical_resolution', label: 'Technical investigation budget', hint: 'Reserve one investigation', kind: 'plan' },
      { id: 'technical_investigation', label: 'Technical investigation', hint: 'Read-only evidence, then independent QA', kind: 'plan' },
      { id: 'generation_plan', label: 'Generator plan', hint: 'Reviewer · repository evidence', kind: 'plan' },
      { id: 'coder', label: 'Implement', hint: 'Coder agent', kind: 'code' },
      { id: 'code_generation', label: 'Generate', hint: 'Isolated repository generator · opt-in', kind: 'code' },
      { id: 'stack_environment', label: 'Test environment', hint: 'Automatic isolated stack · opt-in', kind: 'test' },
      { id: 'tests', label: 'Tests', hint: 'Fixture & suite', kind: 'test' },
      { id: 'qa_author', label: 'QA tests', hint: 'Independent test authoring · opt-in', kind: 'test' },
      { id: 'qa_execute', label: 'QA acceptance', hint: 'Isolated pytest evidence · opt-in', kind: 'test' },
      { id: 'reviewer', label: 'Review', hint: 'Reviewer agent', kind: 'review' },
      { id: 'human_approval', label: 'Approval', hint: 'Code gate', kind: 'approval' },
      { id: 'finalize_build', label: 'CI/CD handoff', hint: 'Branch & push', kind: 'delivery' },
      { id: 'external_ci', label: 'CI/CD', hint: 'Provider validation', kind: 'delivery' },
      { id: 'human_approval_pr', label: 'Approval', hint: 'Functional gate', kind: 'approval' },
      { id: 'finalize_pr', label: 'Pull request', hint: 'Final artifact', kind: 'delivery' },
      { id: 'requirements_input', label: 'Requirements', hint: 'Resolve blockers', kind: 'plan' },
    ],
    approvalGates: ['code_approval', 'functional_approval'],
    requiredAgents: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'],
    titleField: 'ticket_id',
    descriptionField: 'description',
    requiredBundleCategories: ['repository', 'repository-checkout', 'ci'],
    recommendedBundleCategories: ['rag'],
    completionCriteria: {
      trueFields: ['tests_passed', 'review_passed', 'human_approved', 'branch_pushed', 'pr_approved'],
      nonEmptyFields: ['pr_url'],
    },
  },
  {
    id: 'ticket-to-image-pull-request',
    graphId: 'coding_image_workflow',
    label: 'Ticket to image & pull request',
    description: 'Implement an issue, inspect the diff without running automated tests, build a local Docker image in Jenkins, then request both human approvals and create a PR.',
    revisionPolicy: { maxRevisions: CODING_MAX_REVISIONS },
    tags: ['ticket', 'implementation', 'review-only', 'jenkins', 'docker-image', 'pull-request'],
    inputSchema: [
      { name: 'ticket_id', label: 'Ticket ID', type: 'text', required: true, placeholder: 'ARGUS-123' },
      { name: 'issue_reference', label: 'Gitea issue URL or number', type: 'text', required: true, description: 'Load and review the exact issue snapshot before launch.' },
      { name: 'issue_sha256', label: 'Reviewed issue fingerprint', type: 'text', required: false, description: 'Filled by Load issue.' },
      { name: 'description', label: 'Implementation brief', type: 'textarea', required: true, placeholder: 'Describe the behavior and acceptance criteria.' },
      { name: 'planning_thread_id', label: 'Approved planning run ID', type: 'text', required: false },
      { name: 'allowed_files', label: 'Allowed change paths', type: 'textarea', required: false, description: 'CI files, Dockerfiles and dependency manifests remain protected.' },
      { name: 'ci_provider', label: 'CI provider', type: 'select', required: true, defaultValue: 'jenkins', options: [{ value: 'jenkins', label: 'Jenkins' }] },
      { name: 'ci_job', label: 'Trusted Jenkins image job', type: 'text', required: true, description: 'An operator-configured Pipeline from a protected Jenkinsfile. The workflow cannot create or edit this job.' },
    ],
    stages: [
      { id: 'setup_workspace', label: 'Workspace', hint: 'Pinned checkout', kind: 'workspace' },
      { id: 'planner', label: 'Plan', hint: 'Planner agent', kind: 'plan' },
      { id: 'knowledge', label: 'Knowledge', hint: 'Repository context', kind: 'knowledge' },
      { id: 'coder', label: 'Implement', hint: 'Coder agent', kind: 'code' },
      { id: 'reviewer', label: 'Review', hint: 'Diff and requirements; tests not run', kind: 'review' },
      { id: 'human_approval', label: 'Code approval', hint: 'Approve commit and push', kind: 'approval' },
      { id: 'finalize_build', label: 'Branch', hint: 'Commit and push', kind: 'delivery' },
      { id: 'external_ci', label: 'Jenkins image', hint: 'Build-only CI receipt', kind: 'delivery' },
      { id: 'human_approval_pr', label: 'Image approval', hint: 'Inspect build evidence', kind: 'approval' },
      { id: 'finalize_pr', label: 'Pull request', hint: 'Final artifact', kind: 'delivery' },
    ],
    approvalGates: ['code_approval', 'functional_approval'],
    requiredAgents: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'],
    titleField: 'ticket_id',
    descriptionField: 'description',
    requiredBundleCategories: ['repository', 'repository-checkout', 'ci'],
    recommendedBundleCategories: ['rag'],
    completionCriteria: {
      trueFields: ['review_passed', 'human_approved', 'branch_pushed', 'pr_approved'],
      nonEmptyFields: ['pr_url'],
    },
  },
  {
    id: 'ticket-follow-up-image-pull-request',
    graphId: 'coding_follow_up_image_workflow',
    label: 'Follow-up ticket on existing pull request',
    description: 'Continue a completed Jenkins image delivery from its pinned commit, implement a new issue and update the same open Gitea PR after fresh review and approvals.',
    revisionPolicy: { maxRevisions: CODING_MAX_REVISIONS },
    tags: ['ticket', 'follow-up', 'checkpoint', 'gitea', 'jenkins', 'pull-request'],
    inputSchema: [
      { name: 'source_thread_id', label: 'Completed Dev run ID', type: 'text', required: true, description: 'Use the workflow thread UUID of the completed image-and-PR run. The prior run remains immutable.' },
      { name: 'ticket_id', label: 'Follow-up ticket ID', type: 'text', required: true, placeholder: 'ARGUS-124' },
      { name: 'issue_reference', label: 'New Gitea issue URL or number', type: 'text', required: true, description: 'Load and review this issue before launch; it must belong to the same repository.' },
      { name: 'issue_sha256', label: 'Reviewed issue fingerprint', type: 'text', required: false, description: 'Filled by Load issue.' },
      { name: 'description', label: 'Follow-up implementation brief', type: 'textarea', required: true, placeholder: 'What must change in the existing PR?' },
      { name: 'allowed_files', label: 'Allowed change paths', type: 'textarea', required: false, description: 'Optional exact paths, one per line. CI, Docker and dependency files remain protected.' },
      { name: 'ci_provider', label: 'CI provider', type: 'select', required: true, defaultValue: 'jenkins', options: [{ value: 'jenkins', label: 'Jenkins' }] },
    ],
    stages: [
      { id: 'setup_workspace', label: 'Pinned continuation', hint: 'Verify source run, open PR and exact commit', kind: 'workspace' },
      { id: 'planner', label: 'Plan', hint: 'Plan the new ticket against existing code', kind: 'plan' },
      { id: 'knowledge', label: 'Knowledge', hint: 'Repository context', kind: 'knowledge' },
      { id: 'coder', label: 'Implement', hint: 'New commit on the same branch', kind: 'code' },
      { id: 'reviewer', label: 'Review', hint: 'Diff and requirements; tests not run', kind: 'review' },
      { id: 'human_approval', label: 'Code approval', hint: 'Approve new commit and guarded push', kind: 'approval' },
      { id: 'finalize_build', label: 'Update branch', hint: 'Fast-forward with expected head', kind: 'delivery' },
      { id: 'external_ci', label: 'Jenkins image', hint: 'Rebuild on the same job', kind: 'delivery' },
      { id: 'human_approval_pr', label: 'Image approval', hint: 'Inspect new build evidence', kind: 'approval' },
      { id: 'finalize_pr', label: 'Existing PR', hint: 'Verify updated PR; do not create another', kind: 'delivery' },
    ],
    approvalGates: ['code_approval', 'functional_approval'],
    requiredAgents: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'],
    titleField: 'ticket_id',
    descriptionField: 'description',
    requiredBundleCategories: ['repository', 'repository-checkout', 'ci'],
    recommendedBundleCategories: ['rag'],
    completionCriteria: {
      trueFields: ['review_passed', 'human_approved', 'branch_pushed', 'pr_approved'],
      nonEmptyFields: ['pr_url'],
    },
  },
  {
    id: 'pull-request-review',
    graphId: 'pull_request_review',
    label: 'Pull request review',
    description: 'Start from an existing pull request, inspect its changes, run scoped tests and create an approved release handoff.',
    tags: ['pull-request', 'review', 'testing', 'release'],
    inputSchema: [
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository', description: 'Provider-neutral repository slug or project/repository identifier.' },
      { name: 'pull_request_number', label: 'Pull request number', type: 'number', required: true, placeholder: '42', min: 1 },
      { name: 'review_goal', label: 'Review goal', type: 'textarea', required: true, placeholder: 'Describe the checks, risks and acceptance criteria for this PR.' },
      {
        name: 'next_action',
        label: 'Approved continuation',
        type: 'select',
        required: true,
        defaultValue: 'release_handoff',
        options: [
          { value: 'release_handoff', label: 'Create release handoff' },
          { value: 'approval_evidence', label: 'Record approval evidence only' },
        ],
      },
    ],
    stages: [
      { id: 'inspect_pull_request', label: 'Inspect PR', hint: 'Diff & metadata', kind: 'workspace' },
      { id: 'run_tests', label: 'Tests', hint: 'Scoped validation', kind: 'test' },
      { id: 'review_pull_request', label: 'Review', hint: 'Risk & quality', kind: 'review' },
      { id: 'human_approval', label: 'Approval', hint: 'Continuation gate', kind: 'approval' },
      { id: 'fix_pull_request', label: 'Fix', hint: 'Apply feedback', kind: 'code' },
      { id: 'release_handoff', label: 'Handoff', hint: 'Release evidence', kind: 'delivery' },
    ],
    approvalGates: ['pr_review_approval'],
    requiredAgents: ['researcher', 'coder', 'reviewer'],
    titleField: 'pull_request_number',
    titlePrefix: 'PR #',
    descriptionField: 'review_goal',
    requiredBundleCategories: ['repository', 'repository-checkout'],
    completionCriteria: {
      trueFields: ['tests_passed', 'review_passed', 'human_approved', 'pr_approved'],
      nonEmptyFields: ['delivery_summary'],
    },
  },
  {
    id: 'ci-failure-recovery',
    graphId: 'ci_failure_recovery',
    label: 'CI failure recovery',
    description: 'Diagnose a failed provider run, prepare a focused fix, rerun tests and wait for governed CI evidence.',
    tags: ['ci', 'failure', 'diagnosis', 'remediation', 'testing'],
    inputSchema: [
      { name: 'ticket_id', label: 'Recovery ID', type: 'text', required: true, placeholder: 'ARGUS-CI-123' },
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'branch_name', label: 'Failed branch', type: 'text', required: true, placeholder: 'feature/ARGUS-123' },
      { name: 'commit_sha', label: 'Failed commit', type: 'text', required: true, placeholder: 'abcdef123456' },
      {
        name: 'ci_provider',
        label: 'CI provider',
        type: 'select',
        required: true,
        defaultValue: 'gitea',
        options: [
          { value: 'gitea', label: 'Gitea Actions' },
          { value: 'github', label: 'GitHub Actions' },
          { value: 'gitlab', label: 'GitLab CI' },
          { value: 'jenkins', label: 'Jenkins' },
          { value: 'unknown', label: 'Other provider' },
        ],
      },
      { name: 'ci_workflow', label: 'CI workflow', type: 'text', required: true, defaultValue: 'default', placeholder: 'CI / test' },
      { name: 'ci_run_url', label: 'Failed CI run URL', type: 'text', required: false, placeholder: 'https://…/actions/runs/123' },
      { name: 'ci_failure_context', label: 'Failure evidence', type: 'textarea', required: true, placeholder: 'Paste the failing job, error output and acceptance criteria.' },
    ],
    stages: [
      { id: 'seed_ci_failure', label: 'CI failure', hint: 'Load provider evidence', kind: 'workspace' },
      { id: 'setup_workspace', label: 'Workspace', hint: 'Checkout failed branch', kind: 'workspace' },
      { id: 'inspect_ci_failure', label: 'Diagnose', hint: 'Root cause analysis', kind: 'knowledge' },
      { id: 'fix_ci_failure', label: 'Fix', hint: 'Coder remediation', kind: 'code' },
      { id: 'ci_recovery_tests', label: 'Tests', hint: 'Local verification', kind: 'test' },
      { id: 'ci_recovery_approval', label: 'Approval', hint: 'Push retry gate', kind: 'approval' },
      { id: 'finalize_build', label: 'Push retry', hint: 'Branch handoff', kind: 'delivery' },
      { id: 'external_ci_retry', label: 'CI/CD', hint: 'Provider rerun', kind: 'delivery' },
      { id: 'ci_recovery_complete', label: 'Complete', hint: 'Recovery evidence', kind: 'delivery' },
    ],
    approvalGates: ['ci_recovery_approval'],
    requiredAgents: ['researcher', 'coder'],
    titleField: 'ticket_id',
    descriptionField: 'ci_failure_context',
    requiredBundleCategories: ['repository', 'repository-checkout', 'ci'],
    completionCriteria: {
      trueFields: ['tests_passed', 'fix_applied', 'human_approved', 'branch_pushed', 'ci_recovery_completed'],
      nonEmptyFields: ['delivery_summary'],
    },
  },
  {
    id: 'security-remediation',
    graphId: 'security_remediation',
    label: 'Security remediation',
    description: 'Triage a security or dependency finding, prepare a minimal fix, verify it and create a governed remediation PR.',
    tags: ['security', 'dependencies', 'vulnerability', 'remediation', 'pull-request'],
    inputSchema: [
      { name: 'ticket_id', label: 'Remediation ID', type: 'text', required: true, placeholder: 'ARGUS-SEC-123' },
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'source_branch', label: 'Base branch', type: 'text', required: true, placeholder: 'main' },
      { name: 'security_finding_id', label: 'Finding ID', type: 'text', required: true, placeholder: 'CVE-2026-12345' },
      { name: 'security_tool', label: 'Scanner', type: 'text', required: true, placeholder: 'OSV / Dependabot / Trivy' },
      {
        name: 'security_severity',
        label: 'Severity',
        type: 'select',
        required: true,
        defaultValue: 'high',
        options: [
          { value: 'critical', label: 'Critical' },
          { value: 'high', label: 'High' },
          { value: 'medium', label: 'Medium' },
          { value: 'low', label: 'Low' },
          { value: 'unknown', label: 'Unknown' },
        ],
      },
      { name: 'security_package', label: 'Affected package', type: 'text', required: true, placeholder: 'package-name' },
      { name: 'security_current_version', label: 'Current version', type: 'text', required: true, placeholder: '1.2.3' },
      { name: 'security_fixed_version', label: 'Fixed version', type: 'text', required: false, placeholder: '1.2.4' },
      { name: 'security_finding_context', label: 'Finding evidence', type: 'textarea', required: true, placeholder: 'CVE details, affected path, scanner output and acceptance criteria.' },
    ],
    stages: [
      { id: 'seed_security_finding', label: 'Finding', hint: 'Load scanner evidence', kind: 'knowledge' },
      { id: 'setup_workspace', label: 'Workspace', hint: 'Checkout base branch', kind: 'workspace' },
      { id: 'security_triage', label: 'Triage', hint: 'Risk assessment', kind: 'knowledge' },
      { id: 'security_fix', label: 'Remediate', hint: 'Minimal code/dependency fix', kind: 'code' },
      { id: 'security_verification', label: 'Verify', hint: 'Tests & security scan', kind: 'test' },
      { id: 'security_fix_approval', label: 'Approval', hint: 'Push remediation', kind: 'approval' },
      { id: 'finalize_build', label: 'Push branch', hint: 'Create provider run', kind: 'delivery' },
      { id: 'external_ci', label: 'CI/CD', hint: 'Provider validation', kind: 'delivery' },
      { id: 'security_pr_approval', label: 'Approval', hint: 'Remediation PR gate', kind: 'approval' },
      { id: 'finalize_pr', label: 'Pull request', hint: 'Final remediation artifact', kind: 'delivery' },
    ],
    approvalGates: ['security_fix_approval', 'security_pr_approval'],
    requiredAgents: ['researcher', 'coder'],
    titleField: 'ticket_id',
    descriptionField: 'security_finding_context',
    requiredBundleCategories: ['repository', 'repository-checkout', 'security'],
    completionCriteria: {
      trueFields: ['tests_passed', 'security_passed', 'human_approved', 'branch_pushed', 'pr_approved'],
      nonEmptyFields: ['pr_url'],
    },
  },
  {
    id: 'release-notes',
    graphId: 'release_notes',
    label: 'Release notes',
    description: 'Analyze a bounded release scope, draft changelog notes, review them and create an approval-backed handoff.',
    tags: ['release', 'changelog', 'documentation', 'review'],
    inputSchema: [
      { name: 'release_id', label: 'Release ID', type: 'text', required: true, placeholder: 'ARGUS-REL-123' },
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'source_branch', label: 'Source branch', type: 'text', required: true, placeholder: 'main' },
      { name: 'release_version', label: 'Release version', type: 'text', required: true, placeholder: 'v1.4.0' },
      { name: 'release_scope', label: 'Release scope', type: 'textarea', required: true, placeholder: 'Merged PRs, commit range, ticket IDs or release window to include.' },
      { name: 'release_goal', label: 'Release goal', type: 'textarea', required: true, placeholder: 'Audience, risk focus and acceptance criteria for these notes.' },
    ],
    stages: [
      { id: 'seed_release', label: 'Release', hint: 'Load scope', kind: 'knowledge' },
      { id: 'inspect_release_scope', label: 'Inspect', hint: 'PRs & commits', kind: 'workspace' },
      { id: 'generate_release_notes', label: 'Draft', hint: 'Changelog writer', kind: 'code' },
      { id: 'review_release_notes', label: 'Review', hint: 'Factual quality', kind: 'review' },
      { id: 'release_approval', label: 'Approval', hint: 'Release gate', kind: 'approval' },
      { id: 'release_handoff', label: 'Handoff', hint: 'Publish-ready evidence', kind: 'delivery' },
    ],
    approvalGates: ['release_approval'],
    requiredAgents: ['researcher', 'reviewer'],
    titleField: 'release_id',
    descriptionField: 'release_goal',
    requiredBundleCategories: ['repository', 'repository-checkout'],
    recommendedBundleCategories: ['rag'],
    completionCriteria: {
      trueFields: ['review_passed', 'human_approved', 'release_completed'],
      nonEmptyFields: ['release_notes', 'delivery_summary'],
    },
  },
  {
    id: 'backlog-grooming',
    reviewPolicy: { maxAttempts: BACKLOG_REVIEW_MAX_ATTEMPTS },
    graphId: 'backlog_grooming',
    label: 'Backlog Planning',
    description: 'Turn a broad issue or epic into reviewed, independently actionable implementation tasks.',
    tags: ['backlog', 'issue', 'planning', 'decomposition', 'acceptance-criteria'],
    inputSchema: [
      { name: 'backlog_id', label: 'Backlog ID', type: 'text', required: true, placeholder: 'ARGUS-EPIC-123' },
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'source_branch', label: 'Source branch', type: 'text', required: true, placeholder: 'main' },
      { name: 'issue_title', label: 'Issue title', type: 'text', required: true, placeholder: 'Introduce tenant-aware audit retention' },
      { name: 'issue_body', label: 'Issue description', type: 'textarea', required: true, placeholder: 'Paste the epic/issue description, goals and acceptance context.' },
      { name: 'backlog_constraints', label: 'Constraints', type: 'textarea', required: false, placeholder: 'Deadlines, compatibility, compliance or operational constraints.' },
      { name: 'backlog_audience', label: 'Audience', type: 'text', required: false, defaultValue: 'Engineering team', placeholder: 'Engineering team' },
    ],
    stages: [
      { id: 'seed_backlog', label: 'Issue', hint: 'Load scope', kind: 'knowledge' },
      { id: 'setup_workspace', label: 'Workspace', hint: 'Inspect repository', kind: 'workspace' },
      { id: 'research_backlog', label: 'Research', hint: 'Patterns & risks', kind: 'knowledge' },
      { id: 'decompose_backlog', label: 'Decompose', hint: 'Vertical slices', kind: 'plan' },
      { id: 'review_backlog', label: 'Review', hint: 'Quality gate', kind: 'review' },
      { id: 'backlog_approval', label: 'Approval', hint: 'Handoff gate', kind: 'approval' },
      { id: 'backlog_handoff', label: 'Handoff', hint: 'Implementation-ready plan', kind: 'delivery' },
    ],
    approvalGates: ['backlog_approval'],
    requiredAgents: ['researcher', 'planner', 'reviewer'],
    titleField: 'backlog_id',
    descriptionField: 'issue_body',
    requiredBundleCategories: ['repository', 'repository-checkout'],
    recommendedBundleCategories: ['rag'],
    completionCriteria: {
      trueFields: ['review_passed', 'human_approved', 'backlog_completed'],
      nonEmptyFields: ['backlog_tasks', 'delivery_summary'],
    },
  },
];

const dynamicCatalog = new Map<string, WorkflowCatalogEntry>();

export const DEFAULT_WORKFLOW_ID = 'ticket-to-pull-request';
export const DEFAULT_GRAPH_ID = 'coding_workflow';

export function workflowCatalog(): WorkflowCatalogEntry[] {
  return [...catalog, ...dynamicCatalog.values()].map(workflow => ({
    ...workflow,
    tags: [...workflow.tags],
    inputSchema: workflow.inputSchema.map(field => ({
      ...field,
      options: field.options?.map(option => ({ ...option })),
    })),
    stages: workflow.stages.map(stage => ({ ...stage })),
    approvalGates: [...workflow.approvalGates],
    requiredAgents: [...workflow.requiredAgents],
    requiredBundleCategories: [...workflow.requiredBundleCategories],
    ...(workflow.recommendedBundleCategories
      ? { recommendedBundleCategories: [...workflow.recommendedBundleCategories] }
      : {}),
    completionCriteria: {
      trueFields: [...workflow.completionCriteria.trueFields],
      nonEmptyFields: [...workflow.completionCriteria.nonEmptyFields],
    },
  }));
}

export interface WorkflowCompletionResult {
  successful: boolean;
  missing: string[];
}

export function evaluateWorkflowCompletion(
  workflow: WorkflowCatalogEntry,
  values: Record<string, unknown>,
): WorkflowCompletionResult {
  const missing = [
    ...workflow.completionCriteria.trueFields.filter(field => values[field] !== true),
    ...workflow.completionCriteria.nonEmptyFields.filter(field => (
      typeof values[field] !== 'string' || String(values[field]).trim().length === 0
    )),
  ];
  if (workflow.id === 'ticket-to-pull-request' && values['qa_acceptance_policy_version'] === 1) {
    const qa = values['qa_receipt'] as { passed?: boolean; status?: string; exitCode?: number; collected?: number } | null;
    if (!qa || qa.passed !== true || qa.status !== 'completed' || qa.exitCode !== 0 || !(Number(qa.collected) > 0)) missing.push('qa_acceptance_passed');
  }
  return { successful: missing.length === 0, missing };
}

export function getWorkflowDefinition(workflowId: string): WorkflowCatalogEntry | undefined {
  return dynamicCatalog.get(workflowId) ?? catalog.find(workflow => workflow.id === workflowId);
}

export function getWorkflowDefinitionByGraphId(graphId: string): WorkflowCatalogEntry | undefined {
  return [...dynamicCatalog.values()].find(workflow => workflow.graphId === graphId)
    ?? catalog.find(workflow => workflow.graphId === graphId);
}

export function registerDynamicWorkflowDefinition(workflow: WorkflowCatalogEntry): void {
  if (catalog.some(candidate => candidate.id === workflow.id || candidate.graphId === workflow.graphId)) {
    throw new Error(`visual workflow '${workflow.id}' conflicts with a built-in workflow`);
  }
  for (const [id, candidate] of dynamicCatalog) {
    if (id !== workflow.id && candidate.graphId === workflow.graphId) {
      throw new Error(`visual graph '${workflow.graphId}' is already registered`);
    }
  }
  dynamicCatalog.set(workflow.id, workflow);
}

export function workflowRunTitle(workflow: WorkflowCatalogEntry, input: Record<string, unknown>): string {
  const raw = input[workflow.titleField];
  const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'Development run';
  return `${workflow.titlePrefix ?? ''}${value}`;
}

export function validateWorkflowInput(workflow: WorkflowCatalogEntry, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('workflow input must be an object');
  const source = raw as Record<string, unknown>;
  const known = new Set(workflow.inputSchema.map(field => field.name));
  const unknown = Object.keys(source).find(key => !known.has(key));
  if (unknown) throw new Error(`unsupported input field '${unknown}' for workflow '${workflow.id}'`);
  const result: Record<string, unknown> = {};
  for (const field of workflow.inputSchema) {
    const supplied = source[field.name] ?? field.defaultValue;
    if (field.required && (supplied === undefined || supplied === null || String(supplied).trim() === '')) {
      throw new Error(`workflow input '${field.name}' is required`);
    }
    if (supplied === undefined || supplied === null || supplied === '') continue;
    if (field.type === 'number') {
      const value = typeof supplied === 'number' ? supplied : Number(supplied);
      if (!Number.isInteger(value)) throw new Error(`workflow input '${field.name}' must be an integer`);
      if (field.min !== undefined && value < field.min) throw new Error(`workflow input '${field.name}' must be at least ${field.min}`);
      if (field.max !== undefined && value > field.max) throw new Error(`workflow input '${field.name}' must be at most ${field.max}`);
      result[field.name] = value;
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof supplied !== 'boolean') throw new Error(`workflow input '${field.name}' must be a boolean`);
      result[field.name] = supplied;
      continue;
    }
    if (typeof supplied !== 'string') throw new Error(`workflow input '${field.name}' must be a string`);
    const value = supplied.trim();
    if (value.length > (field.type === 'textarea' ? 20_000 : 512)) throw new Error(`workflow input '${field.name}' exceeds the allowed size`);
    if (field.type === 'select' && !field.options?.some(option => option.value === value)) {
      throw new Error(`workflow input '${field.name}' contains an unsupported option`);
    }
    result[field.name] = value;
  }
  return result;
}
