import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Code2,
  Database,
  FileCode2,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Network,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  TestTube2,
  Workflow,
  X,
} from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  cancelCodexRuntimeRun,
  cancelClaudeRuntimeRun,
  cancelSolutionPackTask,
  getArgusDevRuns,
  getCodingThread,
  getCodingApprovalRecovery,
  getCodingCheckpoints,
  getCodexRuntimeStatus,
  getClaudeRuntimeStatus,
  getFabricManagement,
  getHermesManagedRuntime,
  getOverview,
  getRunDetail,
  getSolutionPackAgentCard,
  getSolutionPackDiff,
  getSolutionPackRollbackRequests,
  getSolutionPacks,
  requestSolutionPackRollback,
  getSolutionPackTask,
  refreshSolutionPacks,
  resumeCodingWorkflow,
  recoverCodingApproval,
  submitCodingRequirements,
  loadCodingIssue,
  runSolutionPackPreflight,
  startSolutionPackWorkflow,
} from '../api';
import { isPlatformAdminRole } from '../access';
import { TechnicalExperimentEvidence } from './TechnicalExperimentEvidence';
import { QaAcceptanceEvidence } from './QaAcceptanceEvidence';
import type {
  CodingThreadSummary,
  CodexRuntimeRun,
  CodexRuntimeStatus,
  DistributedTraceRun,
  DistributedTraceSpan,
  HealthState,
  SolutionPackCodingEvidence,
  SolutionPackCiRun,
  SolutionPackManifest,
  SolutionPackRevisionEvidence,
  SolutionPackDiffResponse,
  SolutionPackTask,
  SolutionPackWorkflowDefinition,
  SolutionPackWorkflowStage,
} from '../types';
import { EmptyState, ErrorState, HealthBadge, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { AiOpsSolutionPackPage } from './AiOpsSolutionPackPage';
import { HermesSolutionPackPage } from './HermesSolutionPackPage';
import { HermesRuntimePanel } from '../components/HermesRuntimePanel';
import { backlogReviewPresentation, reviewOutcome } from './backlogReviewPresentation';
import { bindCodingActivity, codingProgressPresentation, type ReviewVerdict, type WorkflowActivityLog } from './codingActivityPresentation';
import { activityRole, logActivityRole, ACTIVITY_LABELS, type ActivityRole } from './codingActivityRoles';
import { DevelopmentDecisionCard, developmentInputLabel, isTechnicalWorkBlocked, readDevelopmentDecision, type DecisionReply } from './DevelopmentDecisionCard';
import { CheckpointRetryActions } from './CheckpointRetryActions';
import { QaResponseRecovery } from './QaResponseRecovery';
import { DevWorkflowProgress } from './DevWorkflowProgress';

const STAGE_ICONS = {
  workspace: GitBranch,
  plan: Workflow,
  knowledge: Database,
  code: Code2,
  test: TestTube2,
  review: GitPullRequest,
  approval: ShieldCheck,
  delivery: Boxes,
} satisfies Record<SolutionPackWorkflowStage['kind'], typeof Workflow>;

const TERMINAL_TASK_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);
const RUN_PAGE_SIZE = 6;
const RUN_PAGE_LINK_COUNT = 10;
const RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Keep immutable provider evidence intact while opening local demo links on
 * the same loopback hostname as the Argus browser session. Browsers scope SSO
 * cookies to a hostname, so localhost and 127.0.0.1 are not interchangeable.
 */
export function browserFacingProviderUrl(
  value: string,
  currentHostname = typeof window === 'undefined' ? '' : window.location.hostname,
): string {
  if (!value || !LOOPBACK_HOSTS.has(currentHostname)) return value;
  try {
    const target = new URL(value);
    if (!LOOPBACK_HOSTS.has(target.hostname) || target.hostname === currentHostname) return value;
    target.hostname = currentHostname;
    return target.toString();
  } catch {
    return value;
  }
}

const BUNDLE_CAPABILITY_LABELS: Record<string, string> = {
  repository: 'Repository / SCM',
  'repository-checkout': 'Repository checkout',
  ci: 'CI / CD provider',
  rag: 'RAG / Knowledge',
  security: 'Security scanner',
  workspace: 'Workspace tools',
};

type DevelopmentRunCard =
  | { kind: 'workflow'; thread: CodingThreadSummary }
  | { kind: 'runtime'; run: CodexRuntimeRun };

interface WorkflowBundleCandidate {
  id: number;
  name: string;
  capabilityCategories?: string[];
}

export function initialWorkflowBundleIds(
  manifestBundleNames: string[],
  bundles: WorkflowBundleCandidate[],
  requiredCategories: string[],
  recommendedCategories: string[],
): number[] {
  const declared = new Set(manifestBundleNames);
  const declaredMatches = bundles.filter(bundle => declared.has(bundle.name));
  if (declaredMatches.length > 0) return declaredMatches.map(bundle => bundle.id);

  const eligible = bundles
    .filter(bundle => requiredCategories.every(category => bundle.capabilityCategories?.includes(category)))
    .sort((left, right) => {
      const score = (bundle: WorkflowBundleCandidate) => recommendedCategories
        .filter(category => bundle.capabilityCategories?.includes(category)).length;
      return score(right) - score(left) || left.id - right.id;
    });
  return eligible[0] ? [eligible[0].id] : [];
}

function packHealth(state: string): HealthState {
  if (state === 'ready') return 'healthy';
  if (state === 'not_checked') return 'not_configured';
  if (state === 'unreachable') return 'offline';
  return 'degraded';
}

function componentCount(manifest: SolutionPackManifest | undefined): number {
  if (!manifest) return 0;
  const components = manifest.spec.components;
  return components.agents.length + (components.runtimeAdapters?.length ?? 0) + components.skills.length + components.bundles.length
    + components.workflows.length + components.knowledgeSources.length + components.dashboards.length
    + components.policies.length;
}

function taskEvidence(task: SolutionPackTask | undefined): Partial<SolutionPackCodingEvidence> {
  return (task?.artifacts?.[0]?.parts?.[0]?.data ?? {}) as Partial<SolutionPackCodingEvidence>;
}

function taskLabel(state: string): string {
  return state.replace('TASK_STATE_', '').toLowerCase().replaceAll('_', ' ');
}

function evidenceList(items: unknown[] | undefined): string[] {
  return (items ?? []).map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const value = item as Record<string, unknown>;
      return String(value['path'] ?? value['file'] ?? value['message'] ?? JSON.stringify(item));
    }
    return String(item);
  });
}

function initialWorkflowInput(workflow: SolutionPackWorkflowDefinition): Record<string, string | number | boolean> {
  return Object.fromEntries(workflow.inputSchema
    .filter(field => field.defaultValue !== undefined)
    .map(field => [field.name, field.defaultValue!])) as Record<string, string | number | boolean>;
}

const RETRY_CONTEXT_FIELD: Record<string, string> = {
  'ticket-to-pull-request': 'description',
  'pull-request-review': 'review_goal',
  'ci-failure-recovery': 'ci_failure_context',
  'security-remediation': 'security_finding_context',
  'release-notes': 'release_goal',
  'backlog-grooming': 'issue_body',
};

type RuntimeSelectionReason =
  | 'explicit_default'
  | 'explicit_managed_hermes'
  | 'workflow_requires_coder_workspace_write'
  | 'workflow_uses_agent_default'
  | 'managed_hermes_unavailable_use_agent_default';

interface RuntimeSelectionEvidence {
  source: 'argus.core';
  kind: 'runtime-selection';
  requestedMode: 'auto' | 'default' | 'managed-hermes';
  effectiveMode: 'default' | 'managed-hermes';
  reason: RuntimeSelectionReason;
  workflowId: string;
}

const RUNTIME_SELECTION_REASONS: Record<RuntimeSelectionReason, string> = {
  explicit_default: 'The Agent default was selected explicitly for this run.',
  explicit_managed_hermes: 'Managed Hermes was selected explicitly for this run.',
  workflow_requires_coder_workspace_write: 'Core routed the Coder workspace-write stage to Managed Hermes.',
  workflow_uses_agent_default: 'This workflow does not require a Coder workspace-write stage, so Core kept the Agent default.',
  managed_hermes_unavailable_use_agent_default: 'Managed Hermes was unavailable, so Core safely fell back to the Agent default.',
};

function runtimeModeLabel(mode: RuntimeSelectionEvidence['requestedMode'] | RuntimeSelectionEvidence['effectiveMode']): string {
  if (mode === 'auto') return 'Auto';
  if (mode === 'managed-hermes') return 'Managed Hermes';
  return 'Agent default';
}

function parseRuntimeSelection(value: unknown): RuntimeSelectionEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const requestedModes = new Set(['auto', 'default', 'managed-hermes']);
  const effectiveModes = new Set(['default', 'managed-hermes']);
  const reasons = new Set(Object.keys(RUNTIME_SELECTION_REASONS));
  if (candidate['source'] !== 'argus.core'
    || candidate['kind'] !== 'runtime-selection'
    || typeof candidate['requestedMode'] !== 'string' || !requestedModes.has(candidate['requestedMode'])
    || typeof candidate['effectiveMode'] !== 'string' || !effectiveModes.has(candidate['effectiveMode'])
    || typeof candidate['reason'] !== 'string' || !reasons.has(candidate['reason'])
    || typeof candidate['workflowId'] !== 'string' || !candidate['workflowId']) return null;
  return candidate as unknown as RuntimeSelectionEvidence;
}

function runtimeSelectionFromData(data: Record<string, unknown> | undefined): RuntimeSelectionEvidence | null {
  if (!data) return null;
  return parseRuntimeSelection(data) ?? parseRuntimeSelection(data['coreRuntimeSelection']);
}

function taskRuntimeSelection(task: SolutionPackTask | undefined): RuntimeSelectionEvidence | null {
  if (!task) return null;
  const metadataSelection = parseRuntimeSelection(task.metadata?.['coreRuntimeSelection']);
  if (metadataSelection) return metadataSelection;
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts ?? []) {
      const selection = runtimeSelectionFromData(part.data);
      if (selection) return selection;
    }
  }
  const messages = [...(task.history ?? []), ...(task.status.message ? [task.status.message] : [])].reverse();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const selection = runtimeSelectionFromData(part.data);
      if (selection) return selection;
    }
  }
  return null;
}

function taskPreflightReadiness(task: SolutionPackTask | undefined): { ready: boolean; blockers: string[] } {
  const parts = task?.artifacts
    ?.flatMap(artifact => artifact.parts ?? [])
    .map(part => part.data)
    .filter((data): data is Record<string, unknown> => Boolean(data && typeof data === 'object')) ?? [];
  const runtimeContainer = parts.find(data => data['runtimePreflight']);
  const runtime = runtimeContainer?.['runtimePreflight'] as Record<string, unknown> | undefined;
  const pack = parts.find(data => typeof data['ready'] === 'boolean');
  const source = runtime ?? pack;
  return {
    ready: task?.status.state === 'TASK_STATE_COMPLETED' && source?.['ready'] === true,
    blockers: Array.isArray(source?.['blockers']) ? source['blockers'].map(String) : [],
  };
}

interface BundleOperationalIssue {
  backendId: number | null;
  backendName: string;
  kind: string;
  recovery: string;
  message: string;
}

function bundleOperationalIssues(error: unknown): BundleOperationalIssue[] {
  if (!(error instanceof Error)) return [];
  const apiError = error as Error & { code?: unknown; details?: unknown };
  if (apiError.code !== 'bundle_connections_not_ready') return [];
  const details = apiError.details && typeof apiError.details === 'object' && !Array.isArray(apiError.details)
    ? apiError.details as Record<string, unknown>
    : null;
  const issues = details?.['operationalIssues'];
  if (!Array.isArray(issues)) return [];
  return issues.flatMap(issue => {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return [];
    const value = issue as Record<string, unknown>;
    const backendName = typeof value['backendName'] === 'string' ? value['backendName'].trim() : '';
    const message = typeof value['message'] === 'string' ? value['message'].trim() : '';
    if (!backendName || !message) return [];
    return [{
      backendId: typeof value['backendId'] === 'number' && Number.isInteger(value['backendId'])
        ? value['backendId']
        : null,
      backendName,
      kind: typeof value['kind'] === 'string' ? value['kind'] : 'unknown',
      recovery: typeof value['recovery'] === 'string' ? value['recovery'] : 'unknown',
      message,
    }];
  });
}

function withManagedHermesReadScope(
  currentBundleIds: number[],
  approvedBundleIds: number[],
  availableBundleIds: number[],
): number[] {
  if (currentBundleIds.some(id => approvedBundleIds.includes(id))) return currentBundleIds;
  const available = new Set(availableBundleIds);
  const approvedBundleId = approvedBundleIds.find(id => available.has(id));
  return approvedBundleId == null ? currentBundleIds : [...currentBundleIds, approvedBundleId];
}

function workflowAutoUsesManagedHermes(workflow: SolutionPackWorkflowDefinition | undefined): boolean {
  return Boolean(workflow
    && workflow.requiredAgents.includes('coder')
    && workflow.stages.some(stage => stage.kind === 'code'));
}

export function governedRetryInput(
  workflow: SolutionPackWorkflowDefinition,
  thread: CodingThreadSummary,
): Record<string, string | number | boolean> {
  const values = thread.values ?? {};
  const saved = thread.metadata['workflow_input'];
  const original = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
  const input = initialWorkflowInput(workflow);
  for (const field of workflow.inputSchema) {
    const value = original[field.name] ?? values[field.name] ?? thread.metadata[field.name];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      input[field.name] = value;
    }
  }
  const contextField = RETRY_CONTEXT_FIELD[workflow.id] ?? workflow.descriptionField;
  const base = String(input[contextField] ?? '').trim();
  // Remove only the exact legacy-generated trailing retry envelope. Old run evidence is untouched.
  input[contextField] = base.replace(/(?:\n\n)?---\nPrevious attempt failure:\n[\s\S]*\n\nPlease address the failure and rerun the relevant checks\.$/, '').trimEnd();
  return input;
}

function threadTaskId(thread: CodingThreadSummary): string {
  return typeof thread.metadata['a2a_task_id'] === 'string' ? thread.metadata['a2a_task_id'] : thread.thread_id;
}

function externalCiWaiting(thread: CodingThreadSummary): boolean {
  if (thread.next?.includes('external_ci')) return true;
  const interrupts = thread.interrupts ?? [];
  return interrupts.some(item => item?.value && typeof item.value === 'object' && item.value['stage'] === 'external_ci');
}

function codingThreadTask(thread: CodingThreadSummary): SolutionPackTask {
  const values = thread.values ?? {};
  const bundleId = Number(thread.metadata['argus_bundle_id'] ?? values['argus_bundle_id'] ?? 0) || undefined;
  const executionBundleIds = Array.isArray(thread.metadata['execution_bundle_ids'])
    ? thread.metadata['execution_bundle_ids'].filter((value): value is number => Number.isInteger(value) && Number(value) > 0)
    : bundleId ? [bundleId] : [];
  const evidence: SolutionPackCodingEvidence = {
    workflowId: threadWorkflowId(thread),
    workflowLabel: typeof thread.metadata['workflow_label'] === 'string' ? thread.metadata['workflow_label'] : 'Development workflow',
    runTitle: typeof values['ticket_id'] === 'string' ? values['ticket_id'] : 'Development run',
    ticketId: typeof values['ticket_id'] === 'string' ? values['ticket_id'] : null,
    repository: typeof values['repository'] === 'string' ? values['repository'] : '',
    pullRequestNumber: Number(values['pull_request_number'] ?? 0) || null,
    currentStage: externalCiWaiting(thread)
      ? 'external_ci'
      : typeof thread.next?.[0] === 'string' ? thread.next[0] : 'starting',
    plan: typeof values['plan'] === 'string' ? values['plan'] : '',
    qaTestPlan: typeof values['qa_test_plan'] === 'string' ? values['qa_test_plan'] : '',
    qaAcceptance: values['qa_acceptance_policy_version'] === 1 ? { policyVersion: 1,
      environmentPolicyVersion: values['qa_environment_policy_version'], stackPlan: values['stack_plan'],
      codeGeneration: values['code_generation_policy_version'] === 1 ? { policyVersion: 1, decision: values['code_generation_decision'], receipt: values['code_generation_receipt'],
        repairPolicyVersion: values['code_generation_repair_policy_version'] ?? 0, repairs: values['code_generation_repair_count'] ?? 0,
        repairPending: values['code_generation_needs_repair'] === true || values['code_generation_repair_pending'] === true } : null,
      stackResult: values['stack_result'], stackRepairs: values['stack_repair_count'],
      environmentRequirements: values['qa_environment_requirements'], environmentRepairs: values['qa_environment_repair_count'],
      artifact: values['qa_artifact'], receipt: values['qa_receipt'], history: values['qa_history'] } : null,
    technicalExperiment: values['technical_experiment_count'] === 1 ? { attemptCount: 1,
      request: values['technical_experiment_request'], result: values['technical_experiment_result'] } : null,
    workflowBlockers: Array.isArray(values['workflow_blockers']) ? values['workflow_blockers'] as string[] : [],
    planningThreadId: typeof values['planning_thread_id'] === 'string' ? values['planning_thread_id'] : '',
    allowedFiles: typeof values['allowed_files'] === 'string' ? values['allowed_files'] : '',
    sourceIssue: (values['issue_snapshot'] ?? thread.metadata['source_issue'] ?? null) as SolutionPackCodingEvidence['sourceIssue'],
    testsPassed: values['tests_passed'] === true,
    verificationMode: ['ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(String(values['delivery_mode'] ?? thread.metadata['workflow_id'] ?? ''))
      ? 'review-only-image'
      : 'automated-tests',
    testOutput: typeof values['test_output'] === 'string' ? values['test_output'] : '',
    testProfiles: Array.isArray(values['test_profiles'])
      ? values['test_profiles'] as NonNullable<SolutionPackCodingEvidence['testProfiles']>
      : [],
    reviewPassed: values['review_passed'] === true,
    review: typeof values['review'] === 'string' ? values['review'] : '',
    backlogId: typeof values['backlog_id'] === 'string' ? values['backlog_id'] : '',
    issueTitle: typeof values['issue_title'] === 'string' ? values['issue_title'] : '',
    backlogTasks: typeof values['backlog_tasks'] === 'string' ? values['backlog_tasks'] : '',
    backlogCompleted: values['backlog_completed'] === true,
    fixOutput: typeof values['fix_output'] === 'string' ? values['fix_output'] : '',
    fixApplied: values['fix_applied'] === true,
    humanChangeRequest: typeof values['human_change_request'] === 'string' ? values['human_change_request'] : '',
    retryCount: Number(values['retry_count'] ?? 0) || 0,
    humanApproved: values['human_approved'] === true,
    branchPushed: values['branch_pushed'] === true,
    buildUrl: typeof values['build_url'] === 'string' ? values['build_url'] : '',
    deliveryStatus: typeof values['delivery_status'] === 'string' ? values['delivery_status'] : 'not_started',
    ciRun: values['ci_run'] && typeof values['ci_run'] === 'object' && !Array.isArray(values['ci_run'])
      ? values['ci_run'] as SolutionPackCodingEvidence['ciRun']
      : null,
    prApproved: values['pr_approved'] === true,
    prUrl: typeof values['pr_url'] === 'string' ? values['pr_url'] : '',
    deliverySummary: typeof values['delivery_summary'] === 'string' ? values['delivery_summary'] : '',
    fileDiffs: Array.isArray(values['file_diffs']) ? values['file_diffs'] as SolutionPackCodingEvidence['fileDiffs'] : [],
    reviewAnnotations: Array.isArray(values['review_annotations']) ? values['review_annotations'] as SolutionPackCodingEvidence['reviewAnnotations'] : [],
    revisionHistory: Array.isArray(values['revision_history'])
      ? values['revision_history'] as SolutionPackRevisionEvidence[]
      : [],
  };
  const state = externalCiWaiting(thread)
    ? 'TASK_STATE_WORKING'
    : thread.status === 'interrupted'
    ? 'TASK_STATE_INPUT_REQUIRED'
    : thread.status === 'completed' ? 'TASK_STATE_COMPLETED'
      : thread.status === 'failed' ? 'TASK_STATE_FAILED'
        : thread.status === 'canceled' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING';
  return {
    id: thread.thread_id,
    contextId: thread.thread_id,
    status: { state, timestamp: thread.updated_at, message: state === 'TASK_STATE_INPUT_REQUIRED'
      ? { parts: [{ text: 'Human approval is required before this Argus Dev workflow can continue.' }] }
      : externalCiWaiting(thread)
        ? { parts: [{ text: 'External CI/CD is still running; Argus will continue automatically after its signed callback.' }] }
        : undefined },
    metadata: {
      workflowThreadId: thread.thread_id,
      runtimeStatus: thread.status,
      workflowId: threadWorkflowId(thread),
      directCodingThread: true,
      ...(executionBundleIds.length ? { executionBundleIds } : {}),
      ...(Array.isArray(thread.metadata['execution_runtime_overrides'])
        ? { execution_runtime_overrides: thread.metadata['execution_runtime_overrides'] }
        : {}),
    },
    artifacts: [{ name: 'Argus Dev coding workflow evidence', parts: [{ data: evidence as unknown as Record<string, unknown> }] }],
  };
}

function threadTitle(thread: CodingThreadSummary): string {
  const value = thread.metadata['run_title'] ?? thread.values?.['ticket_id'] ?? thread.metadata['ticket_id'];
  return typeof value === 'string' && value ? value : 'Development run';
}

function threadDescription(thread: CodingThreadSummary): string {
  const value = thread.metadata['run_description'] ?? thread.values?.['description'] ?? thread.metadata['description'];
  return typeof value === 'string' ? value : '';
}

function threadWorkflowId(thread: CodingThreadSummary): string {
  const value = thread.metadata['workflow_id'];
  return typeof value === 'string' ? value : 'ticket-to-pull-request';
}

function threadState(thread: CodingThreadSummary): { label: string; className: string } {
  const clarification = developmentInputLabel(thread);
  if (clarification) return { label: clarification, className: 'waiting' };
  if (externalCiWaiting(thread)) return { label: 'CI in progress', className: 'working' };
  const deliveryStatus = typeof thread.values?.['delivery_status'] === 'string' ? thread.values['delivery_status'] : '';
  const providerStatus = thread.values?.['ci_run'] && typeof thread.values['ci_run'] === 'object' && !Array.isArray(thread.values['ci_run'])
    ? String((thread.values['ci_run'] as Record<string, unknown>)['status'] ?? '')
    : '';
  if (deliveryStatus === 'ci_failed' || deliveryStatus === 'pr_failed' || providerStatus === 'failure' || providerStatus === 'canceled') {
    return { label: 'CI/CD failed', className: 'failed' };
  }
  if (thread.status === 'interrupted') return { label: 'Approval required', className: 'input-required' };
  if (thread.status === 'waiting_external_ci') return { label: 'CI in progress', className: 'working' };
  if (thread.status === 'queued' || thread.status === 'idle' || thread.status === 'running') return { label: 'Running', className: 'working' };
  if (thread.status === 'canceled') return { label: 'Canceled', className: 'canceled' };
  return { label: thread.status, className: thread.status };
}

function humanChangeRequestState(thread: CodingThreadSummary): { label: string; className: string } {
  const values = thread.values ?? {};
  if (values['human_approved'] === true) return { label: 'Approved', className: 'success' };
  if (thread.status === 'completed') return { label: 'Completed', className: 'success' };
  if (thread.status === 'interrupted' && thread.next?.includes('human_approval')) {
    return { label: 'Awaiting approval', className: 'input-required' };
  }
  if (typeof values['review'] === 'string' && values['review'].trim()) {
    return { label: 'Reviewed', className: 'reviewed' };
  }
  return { label: 'In progress', className: 'working' };
}

function deliveryState(deliveryStatus: string | undefined, providerStatus: string | undefined): { label: string; className: string } | null {
  if (deliveryStatus === 'ci_failed' || deliveryStatus === 'pr_failed' || providerStatus === 'failure' || providerStatus === 'canceled') {
    return { label: 'CI/CD failed', className: 'failed' };
  }
  if (deliveryStatus === 'ci_passed' || providerStatus === 'success') {
    return { label: 'CI passed', className: 'success' };
  }
  if (deliveryStatus === 'ci_running' || providerStatus === 'running') {
    return { label: 'CI running', className: 'working' };
  }
  if (deliveryStatus === 'awaiting_ci' || providerStatus === 'queued') {
    return { label: 'CI queued', className: 'working' };
  }
  return null;
}

function threadDeliveryState(thread: CodingThreadSummary): { label: string; className: string } | null {
  const values = thread.values ?? {};
  const deliveryStatus = typeof values['delivery_status'] === 'string' ? values['delivery_status'] : undefined;
  const providerStatus = values['ci_run'] && typeof values['ci_run'] === 'object' && !Array.isArray(values['ci_run'])
    ? String((values['ci_run'] as Record<string, unknown>)['status'] ?? '')
    : undefined;
  return deliveryState(deliveryStatus, providerStatus);
}

function threadCiRun(thread: CodingThreadSummary): SolutionPackCiRun | null {
  const value = thread.values?.['ci_run'];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SolutionPackCiRun
    : null;
}

function ciProviderLabel(provider: string): string {
  const label = ({ gitea: 'Gitea', github: 'GitHub', gitlab: 'GitLab', jenkins: 'Jenkins', bitbucket: 'Bitbucket' } as Record<string, string>)[provider] ?? provider;
  return label || 'CI provider';
}

function threadStage(thread: CodingThreadSummary, workflow: SolutionPackWorkflowDefinition): string {
  if (thread.status === 'completed') return 'completed';
  if (thread.status === 'waiting_external_ci' || externalCiWaiting(thread)) return 'external_ci';
  if (typeof thread.next?.[0] === 'string') return thread.next[0];
  const log = thread.values?.['log'];
  if (Array.isArray(log)) {
    const last = [...log].reverse().find(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>)['step'] === 'string') as Record<string, unknown> | undefined;
    const step = typeof last?.['step'] === 'string' ? last['step'] : '';
    if (step === 'human') return thread.values?.['branch_pushed'] === true ? 'human_approval_pr' : 'human_approval';
    if (workflow.stages.some(stage => stage.id === step)) return step;
  }
  return workflow.stages[0]?.id ?? 'starting';
}

function stageIndex(stages: SolutionPackWorkflowStage[], stage: string, completed = false): number {
  if (completed || stage === 'completed') return stages.length;
  if (['code_generation_repair_reserve', 'code_generation_repair'].includes(stage)) stage = 'code_generation';
  const index = stages.findIndex(item => item.id === stage);
  return index < 0 ? 0 : index;
}

interface DiffFileRecord {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
}

interface DiffLine {
  kind: 'context' | 'addition' | 'deletion' | 'hunk' | 'meta';
  text: string;
  oldLine?: number;
  newLine?: number;
}

type ActivityExecution = DistributedTraceRun & { retainedStageEvidence?: boolean; phaseActivity?: boolean; reviewVerdict?: ReviewVerdict };

function workflowLogEntries(value: unknown): WorkflowActivityLog[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record['step'] === 'string' && typeof record['summary'] === 'string'
      ? [{ step: record['step'], summary: record['summary'], ...(typeof record['traceId'] === 'string' ? { traceId: record['traceId'] } : {}) }]
      : [];
  });
}

function retainedActivity(
  role: ActivityRole,
  id: string,
  output: string,
  status: DistributedTraceRun['status'],
  startedAt: string,
): ActivityExecution {
  return {
    id,
    kind: 'agent',
    taskType: role,
    title: ACTIVITY_LABELS[role],
    subtitle: role === 'qa-execution' ? 'Isolated supplemental QA tests' : role === 'test' ? 'Deterministic project test runner' : 'Persisted workflow stage evidence',
    status,
    startedAt,
    endedAt: startedAt,
    durationMs: null,
    parentTraceId: null,
    parentSpanId: null,
    outputPreview: output,
    retainedStageEvidence: true,
  };
}

function evidenceOutput(role: ActivityRole, evidence: Partial<SolutionPackCodingEvidence>, summary: string): string {
  if (role === 'plan') return evidence.plan || summary;
  if (role === 'qa-design') return evidence.qaTestPlan || summary;
  if (role === 'qa-execution') {
    const qa = evidence.qaAcceptance as { receipt?: unknown } | undefined;
    return qa?.receipt ? JSON.stringify(qa.receipt, null, 2) : summary;
  }
  if (role === 'test') return evidence.testOutput || summary;
  if (role === 'review') return evidence.review || summary;
  if (role === 'code') return evidence.fixOutput || summary;
  return summary;
}

const TEST_PHASE_LABELS: Record<string, string> = {
  setup: 'Dependency setup',
  test: 'Ticket-scoped tests',
  build: 'Project build',
};

function previewRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function workflowTestPhaseActivity(span: DistributedTraceSpan, workflowTraceId: string): ActivityExecution | null {
  if (span.traceId !== workflowTraceId || span.kind !== 'workflow') return null;
  const match = /^workflow\.stage\.tests\.([a-z0-9._-]+)$/i.exec(span.name);
  if (!match) return null;
  const phase = match[1]!.toLowerCase();
  const input = previewRecord(span.inputPreview);
  const label = typeof input['label'] === 'string' && input['label'].trim()
    ? input['label'].trim()
    : TEST_PHASE_LABELS[phase] ?? phase;
  const profileId = typeof input['profileId'] === 'string' ? input['profileId'] : '';
  const command = typeof input['command'] === 'string' ? input['command'] : '';
  return {
    id: `workflow-stage-${span.id}`,
    parentTraceId: workflowTraceId,
    parentSpanId: span.parentSpanId,
    kind: 'workflow',
    workflowStepId: 'tests',
    taskType: 'test-phase',
    title: TEST_PHASE_LABELS[phase] ?? label,
    subtitle: [label, profileId].filter(Boolean).join(' · ') || 'Deterministic project phase',
    status: span.status,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    durationMs: span.durationMs,
    inputPreview: command || null,
    outputPreview: span.outputPreview || (span.status === 'running'
      ? `${label} is running${command ? `\n\n${command}` : ''}`
      : null),
    error: span.error,
    phaseActivity: true,
  };
}

function mergeWorkflowActivity(
  executions: ActivityExecution[],
  logEntries: WorkflowActivityLog[],
  evidence: Partial<SolutionPackCodingEvidence>,
  evidenceTimestamp: string,
): ActivityExecution[] {
  const remaining = bindCodingActivity(executions, logEntries, evidence).sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const merged: ActivityExecution[] = [];
  const testLogIndexes = logEntries.flatMap((entry, index) => logActivityRole(entry.step) === 'test' ? [index] : []);
  const lastTestLogIndex = testLogIndexes.at(-1);

  logEntries.forEach((entry, index) => {
    const role = logActivityRole(entry.step);
    if (!role) return;
    if (role === 'test' && index === lastTestLogIndex) {
      for (let executionIndex = 0; executionIndex < remaining.length;) {
        if (remaining[executionIndex]?.phaseActivity) {
          merged.push(remaining.splice(executionIndex, 1)[0]!);
        } else {
          executionIndex += 1;
        }
      }
    } else if (role !== 'test') {
      const executionIndex = remaining.findIndex(execution => entry.traceId ? execution.id === entry.traceId : activityRole(execution) === role);
      if (executionIndex >= 0) {
        merged.push(remaining.splice(executionIndex, 1)[0]!);
        return;
      }
    }
    const isLastRoleEntry = !logEntries.slice(index + 1).some(item => logActivityRole(item.step) === role);
    // Latest persisted output belongs only to the latest invocation of a role.
    const output = !isLastRoleEntry
      ? entry.summary
      : evidenceOutput(role, evidence, entry.summary);
    const failed = /(?:^|\s)(?:✗|failed|error|rejected)(?:\s|:|$)/i.test(entry.summary)
      || (role === 'test' && index === lastTestLogIndex && Boolean(evidence.testOutput) && evidence.testsPassed !== true)
      || (role === 'review' && isLastRoleEntry && Boolean(evidence.review) && evidence.reviewPassed !== true);
    merged.push(retainedActivity(
      role,
      `retained-${entry.step}-${index}`,
      output,
      failed ? 'failed' : 'completed',
      new Date(Date.parse(evidenceTimestamp) + index).toISOString(),
    ));
  });

  merged.push(...remaining);
  // A live setup/test/build span is progress evidence, not the final retained
  // test result. Keep the persisted summary as a separate card even when the
  // LangGraph log query arrives a little later than the trace query.
  const roles = new Set(merged
    .filter(item => !item.phaseActivity)
    .map(activityRole)
    .filter((role): role is ActivityRole => role != null));
  const fallback: ActivityExecution[] = [];
  if (evidence.plan && !roles.has('plan')) fallback.push(retainedActivity('plan', 'retained-plan', evidence.plan, 'completed', evidenceTimestamp));
  if (evidence.testOutput && !roles.has('test')) fallback.push(retainedActivity('test', 'retained-tests', evidence.testOutput, evidence.testsPassed ? 'completed' : 'failed', evidenceTimestamp));
  if (evidence.review && !roles.has('review')) fallback.push(retainedActivity('review', 'retained-review', evidence.review, evidence.reviewPassed ? 'completed' : 'failed', evidenceTimestamp));

  for (const item of fallback) {
    const role = activityRole(item);
    if (role === 'plan') merged.unshift(item);
    else if (role === 'test') {
      const reviewIndex = merged.findIndex(entry => activityRole(entry) === 'review');
      merged.splice(reviewIndex < 0 ? merged.length : reviewIndex, 0, item);
    } else merged.push(item);
  }
  const knownIds = new Set([...merged, ...remaining].map(item => item.id));
  for (const output of evidence.agentOutputs ?? []) {
    if (output.traceId && knownIds.has(output.traceId)) continue;
    const id = output.traceId ?? `retained-visual-${output.stepId}-${output.attempt}`;
    if (knownIds.has(id)) continue;
    merged.push({
      id,
      agentId: output.agentId,
      agentRole: output.role,
      workflowStepId: output.stepId,
      taskType: output.role,
      parentTraceId: null,
      parentSpanId: null,
      kind: 'agent',
      title: output.label,
      subtitle: `Persisted Argus Workflow Spec evidence · attempt ${output.attempt}`,
      status: 'completed',
      startedAt: output.recordedAt,
      endedAt: output.recordedAt,
      durationMs: null,
      outputPreview: output.output,
      retainedStageEvidence: true,
    });
    knownIds.add(id);
  }
  return merged;
}

function activityDisplay(execution: ActivityExecution): { title: string; subtitle: string } {
  const role = activityRole(execution);
  if (!role || execution.retainedStageEvidence || execution.phaseActivity) return { title: execution.title, subtitle: execution.subtitle };
  const label = ACTIVITY_LABELS[role];
  return {
    title: execution.workflowStepId === 'review_backlog' ? 'Backlog review' : label,
    subtitle: ['test','qa-execution','generator'].includes(role) ? execution.subtitle
      : `Agent: ${execution.agentRole || execution.title} · ${execution.subtitle}`,
  };
}

function diffFiles(items: unknown[]): DiffFileRecord[] {
  return items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    if (typeof value['path'] !== 'string') return [];
    return [{
      path: value['path'],
      status: typeof value['status'] === 'string' ? value['status'] : undefined,
      additions: Number(value['additions'] ?? 0) || 0,
      deletions: Number(value['deletions'] ?? 0) || 0,
      diff: typeof value['diff'] === 'string' ? value['diff'] : '',
    }];
  });
}

function parseDiffLines(diff: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return diff.split('\n').filter((line, index, lines) => !(index === lines.length - 1 && line === '')).map(line => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: 'hunk', text: line };
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return { kind: 'meta', text: line };
    }
    if (line.startsWith('+')) {
      const result = { kind: 'addition' as const, text: line, newLine };
      newLine += 1;
      return result;
    }
    if (line.startsWith('-')) {
      const result = { kind: 'deletion' as const, text: line, oldLine };
      oldLine += 1;
      return result;
    }
    const result = { kind: 'context' as const, text: line, oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return result;
  });
}

function DiffViewer({ items }: { items: unknown[] }) {
  const files = diffFiles(items);
  if (files.length === 0) return null;
  return (
    <section className="solution-diff-panel" aria-label="Code changes">
      <header>
        <div><span className="eyebrow">CODE REVIEW · DIFF</span><h3>Changed files</h3></div>
        <b>{files.length} file{files.length === 1 ? '' : 's'}</b>
      </header>
      <div className="solution-diff-files">
        {files.map(file => (
          <article className="solution-diff-file" key={file.path}>
            <header><span><FileCode2 size={14} />{file.path}</span><em><i>+{file.additions ?? 0}</i><i>−{file.deletions ?? 0}</i></em></header>
            <div className="solution-diff-code">
              {parseDiffLines(file.diff ?? '').map((line, index) => (
                <div className={`solution-diff-line diff-${line.kind}`} key={`${file.path}-${index}`}>
                  <span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span><code>{line.text || ' '}</code>
                </div>
              ))}
              {!file.diff && <div className="solution-diff-empty">No unified patch was retained for this file.</div>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

const REVISION_TRIGGER_LABELS: Record<SolutionPackRevisionEvidence['trigger'], string> = {
  initial: 'Initial implementation',
  tests: 'Test feedback',
  qa: 'Independent QA feedback',
  reviewer: 'Reviewer feedback',
  human: 'Human change request',
  functional: 'Functional feedback',
};

function RevisionHistory({ revisions, runActive }: { revisions: SolutionPackRevisionEvidence[]; runActive: boolean }) {
  if (revisions.length === 0) return null;
  return (
    <section className="solution-revision-history" aria-label="Revision history">
      <header>
        <div><span className="eyebrow">GOVERNED FEEDBACK LOOP</span><h3>Revision history</h3><p>Immutable evidence for every implementation, test, review and human decision.</p></div>
        <b>{revisions.length} attempt{revisions.length === 1 ? '' : 's'}</b>
      </header>
      <div className="solution-revision-list">
        {revisions.map((revision, index) => {
          const verdict = revision.reviewer?.verdict;
          const state = verdict === 'APPROVE'
            ? { label: 'Review passed', className: 'approved' }
            : verdict === 'REQUEST_CHANGES'
              ? { label: 'Changes requested', className: 'changes' }
              : revision.tests?.passed === false
                ? { label: 'Tests failed', className: 'failed' }
                : { label: runActive ? 'Checks pending' : 'Checks not completed', className: runActive ? 'running' : 'changes' };
          const changedFiles = diffFiles(Array.isArray(revision.fileDiffs) ? revision.fileDiffs : []);
          return (
            <details className="solution-revision" open={index === revisions.length - 1} key={`${revision.attempt}-${revision.startedAt}`}>
              <summary>
                <span className="solution-revision-number">{revision.attempt}</span>
                <div><b>Attempt {revision.attempt}</b><small>{REVISION_TRIGGER_LABELS[revision.trigger] ?? revision.trigger}</small></div>
                <em className={`state-${state.className}`}>{state.label}</em>
                <small>{changedFiles.length} file{changedFiles.length === 1 ? '' : 's'}</small>
              </summary>
              <div className="solution-revision-body">
                {revision.triggerFeedback && <blockquote><small>INPUT FOR THIS ATTEMPT</small>{revision.triggerFeedback}</blockquote>}
                <div className="solution-revision-phases">
                  <article>
                    <header><span><Bot size={14} />Coder</span>{revision.coder.traceId && <a href={`/runs/agent/${encodeURIComponent(revision.coder.traceId)}`}><Network size={12} />Run</a>}</header>
                    <pre>{revision.coder.output || 'No coder output was retained.'}</pre>
                  </article>
                  {revision.tests && (
                    <article>
                      <header><span><TestTube2 size={14} />Tests</span><em className={revision.tests.passed ? 'state-approved' : 'state-failed'}>{revision.tests.passed ? 'Passed' : 'Failed'}</em></header>
                      {(revision.tests.profiles ?? []).length > 0 && <div className="solution-revision-profiles">{revision.tests.profiles.map(profile => <code className={profile.passed ? 'state-approved' : 'state-failed'} key={`${profile.id}-${profile.root}`}>{profile.runner} · {profile.root}</code>)}</div>}
                      <pre>{revision.tests.output || 'No test output was retained.'}</pre>
                    </article>
                  )}
                  {revision.reviewer && (
                    <article>
                      <header><span><ShieldCheck size={14} />Reviewer</span>{revision.reviewer.traceId && <a href={`/runs/agent/${encodeURIComponent(revision.reviewer.traceId)}`}><Network size={12} />Run</a>}</header>
                      {revision.reviewer.summary && <p>{revision.reviewer.summary}</p>}
                      {(revision.reviewer.findings ?? []).length > 0 && <ul className="solution-revision-findings">{revision.reviewer.findings.map((finding, findingIndex) => <li key={`${finding.severity}-${findingIndex}`}><em className={`severity-${finding.severity}`}>{finding.severity}</em><span>{finding.message}{finding.file && <code>{finding.file}{finding.line ? `:${finding.line}` : ''}</code>}</span></li>)}</ul>}
                      {(revision.reviewer.requiredChanges ?? []).length > 0 && <section className="solution-revision-requirements"><small>REQUIRED CHANGES</small><ol>{revision.reviewer.requiredChanges.map((change, changeIndex) => <li key={`${changeIndex}-${change}`}>{change}</li>)}</ol></section>}
                      {!revision.reviewer.summary && revision.reviewer.output && <pre>{revision.reviewer.output}</pre>}
                    </article>
                  )}
                </div>
                {(revision.humanDecisions ?? []).length > 0 && <div className="solution-revision-decisions">{revision.humanDecisions.map((decision, decisionIndex) => <article key={`${decision.stage}-${decision.recordedAt}-${decisionIndex}`}><span>{decision.approved ? <Check size={13} /> : <X size={13} />}</span><div><b>{decision.stage === 'functional' ? 'Functional decision' : 'Code decision'}</b><p>{decision.feedback || (decision.approved ? 'Approved' : 'Changes requested')}</p></div><em className={decision.approved ? 'state-approved' : 'state-changes'}>{decision.approved ? 'approved' : 'changes requested'}</em></article>)}</div>}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function WorkflowFlow({ task, workflow }: { task?: SolutionPackTask; workflow: SolutionPackWorkflowDefinition }) {
  const evidence = taskEvidence(task);
  if (['ticket-to-pull-request', 'ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(workflow.id) && task) {
    return <DevWorkflowProgress key={task.id} workflow={workflow} evidence={evidence} state={task.status.state}
      canceling={task.metadata?.['runtimeStatus'] === 'canceling'} />;
  }
  const stages = workflow.stages.filter(stage => (!['qa_author', 'qa_execute'].includes(stage.id) || !task || Boolean(evidence.qaAcceptance))
    && (stage.id !== 'stack_environment' || !task || (evidence.qaAcceptance as { environmentPolicyVersion?: number } | undefined)?.environmentPolicyVersion === 2)
    && (!['generation_plan', 'code_generation'].includes(stage.id) || !task || Boolean((evidence.qaAcceptance as { codeGeneration?: unknown } | undefined)?.codeGeneration)));
  const current = stageIndex(stages, String(evidence.currentStage ?? ''), task?.status.state === 'TASK_STATE_COMPLETED');
  const active = task && !TERMINAL_TASK_STATES.has(task.status.state) && task.metadata?.['runtimeStatus'] !== 'canceling';
  return (
    <div className="solution-flow" aria-label={`${workflow.label} workflow`}>
      {stages.map((stage, index) => {
        const Icon = STAGE_ICONS[stage.kind];
        const stateClass = task && index < current ? ' is-complete' : active && index === current ? ' is-active' : '';
        return <div className={`solution-flow-step${stateClass}`} key={stage.id}><span>{task && index < current ? <Check size={17} /> : <Icon size={17} />}</span><b>{stage.label}</b><small>{stage.hint}</small>{index < stages.length - 1 && <ArrowRight size={14} />}</div>;
      })}
    </div>
  );
}

function ArgusDevSolutionPackPage() {
  const { packId = 'argus.dev' } = useParams<{ packId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview, staleTime: 15_000 });
  const platformAdmin = isPlatformAdminRole(overview.data?.user.role);
  const query = useQuery({ queryKey: ['solution-packs'], queryFn: getSolutionPacks, staleTime: 15_000 });
  const pack = query.data?.packs.find(item => item.configuredId === packId);
  const hermesPackConfigured = query.data?.packs.some(item => item.configuredId === 'argus.hermes') ?? false;
  const hermesPackConnected = query.data?.packs.some(item =>
    item.configuredId === 'argus.hermes'
    && item.state === 'ready'
    && item.manifest?.metadata.id === 'argus.hermes'
    && item.manifest.spec.components.runtimeAdapters?.some(adapter => adapter.runtime === 'hermes'),
  ) ?? false;
  const packReady = pack?.state === 'ready';
  const runs = useQuery({
    queryKey: ['argus-dev-runs'],
    queryFn: getArgusDevRuns,
    enabled: packReady,
    retry: false,
    refetchInterval: queryState => packReady && !queryState.state.error ? 5_000 : false,
  });
  const codexRuntime = useQuery<CodexRuntimeStatus>({
    queryKey: ['argus-dev-codex-runtime'],
    queryFn: getCodexRuntimeStatus,
    refetchInterval: queryState => queryState.state.data?.activeRuns ? 3_000 : 15_000,
  });
  const claudeRuntime = useQuery<CodexRuntimeStatus>({
    queryKey: ['argus-dev-claude-runtime'],
    queryFn: getClaudeRuntimeStatus,
    refetchInterval: queryState => queryState.state.data?.activeRuns ? 3_000 : 15_000,
  });
  const activeRuntimeRuns = useMemo(
    () => (codexRuntime.data?.runs ?? []).filter(run => run.state === 'starting' || run.state === 'running'),
    [codexRuntime.data?.runs],
  );
  const activeClaudeRuns = useMemo(
    () => (claudeRuntime.data?.runs ?? []).filter(run => run.state === 'starting' || run.state === 'running'),
    [claudeRuntime.data?.runs],
  );
  // Presentation only: retain planning sessions in runtime data and counts.
  // Hiding a row must never cancel its worker or alter the workflow's plan step.
  const visibleRuntimeRuns = activeRuntimeRuns.filter(run => run.taskType !== 'plan');
  const visibleClaudeRuns = activeClaudeRuns.filter(run => run.taskType !== 'plan');
  const cancelRuntime = useMutation({
    mutationFn: cancelCodexRuntimeRun,
    onSuccess: () => { void codexRuntime.refetch(); },
  });
  const cancelClaude = useMutation({
    mutationFn: cancelClaudeRuntimeRun,
    onSuccess: () => { void claudeRuntime.refetch(); },
  });
  const refresh = useMutation({
    mutationFn: refreshSolutionPacks,
    onSuccess: data => queryClient.setQueryData(['solution-packs'], data),
  });
  const packDiff = useQuery<SolutionPackDiffResponse>({
    queryKey: ['solution-pack-diff', packId, pack?.revision],
    queryFn: () => getSolutionPackDiff(packId),
    enabled: platformAdmin && Boolean(pack && pack.state !== 'not_checked'),
    staleTime: 15_000,
  });
  const rollbackRequests = useQuery({
    queryKey: ['solution-pack-rollback-requests', packId],
    queryFn: () => getSolutionPackRollbackRequests(packId, 20),
    enabled: platformAdmin && Boolean(pack),
    staleTime: 5_000,
    refetchInterval: queryState => queryState.state.error ? false : 10_000,
    retry: false,
  });
  const [rollbackReason, setRollbackReason] = useState('');
  const rollback = useMutation({
    mutationFn: () => requestSolutionPackRollback(packId, rollbackReason.trim()),
    onSuccess: async () => {
      setRollbackReason('');
      await queryClient.invalidateQueries({ queryKey: ['solution-pack-diff', packId] });
      await queryClient.invalidateQueries({ queryKey: ['solution-packs'] });
    },
  });
  const manifest = pack?.manifest;
  const orchestrator = manifest?.spec.components.agents[0];
  const catalog = useQuery({
    queryKey: ['solution-pack-agent-card', packId, orchestrator?.id],
    queryFn: () => getSolutionPackAgentCard(packId, orchestrator!.id),
    enabled: Boolean(orchestrator && pack?.state === 'ready'),
    staleTime: 30_000,
  });
  const workflows = useMemo(
    () => (catalog.data?.agentCard.skills ?? [])
      .map(skill => skill['x-argus-workflow'])
      .filter((workflow): workflow is SolutionPackWorkflowDefinition => Boolean(workflow)),
    [catalog.data],
  );
  const [launchOpen, setLaunchOpen] = useState(false);
  const [workflowId, setWorkflowId] = useState('');
  const [workflowInput, setWorkflowInput] = useState<Record<string, string | number | boolean>>({});
  const [preflightRepository, setPreflightRepository] = useState('');
  const repositoryInput = String(workflowInput['repository'] ?? '').trim();
  useEffect(() => {
    const timer = setTimeout(() => setPreflightRepository(repositoryInput), 400);
    return () => clearTimeout(timer);
  }, [repositoryInput]);
  const [bundleIds, setBundleIds] = useState<number[]>([]);
  const issuePreviewSection = useRef<HTMLElement>(null);
  const issueReference = String(workflowInput['issue_reference'] ?? '').trim();
  const issueSelectionKey = JSON.stringify([launchOpen, workflowId, issueReference, [...bundleIds].sort((a, b) => a - b)]);
  const issueGeneration = useRef(0);
  const [reviewedIssue, setReviewedIssue] = useState<{ key: string; snapshot: import('../types').RepositoryIssueSnapshot } | null>(null);
  const issuePreview = useMutation({
    mutationFn: async (input: { key: string; generation: number; reference: string; bundleIds: number[] }) => ({
      key: input.key, generation: input.generation, ...(await loadCodingIssue(input.reference, input.bundleIds)),
    }),
    onSuccess: result => {
      if (result.generation === issueGeneration.current) setReviewedIssue(result);
    },
  });
  const resetIssuePreview = issuePreview.reset;
  useEffect(() => {
    // A -> B -> A is still a new selection. Never restore an old response or error.
    issueGeneration.current += 1;
    setReviewedIssue(null);
    resetIssuePreview();
  }, [issueSelectionKey, resetIssuePreview]);
  const currentIssueRequest = issuePreview.variables?.key === issueSelectionKey
    && issuePreview.variables.generation === issueGeneration.current;
  const issueLoading = currentIssueRequest && issuePreview.isPending;
  const issueError = currentIssueRequest ? issuePreview.error : null;
  const currentIssue = reviewedIssue?.key === issueSelectionKey ? reviewedIssue.snapshot : null;
  const issueReady = !issueReference || Boolean(currentIssue);
  const loadIssuePreview = (reveal = false) => {
    if (!issueReference || issueLoading || bundleIds.length === 0) return;
    setReviewedIssue(null);
    issuePreview.mutate({ key: issueSelectionKey, generation: issueGeneration.current, reference: issueReference, bundleIds: [...bundleIds] });
    if (reveal) {
      issuePreviewSection.current?.scrollIntoView?.({ block: 'start' });
      issuePreviewSection.current?.focus({ preventScroll: true });
    }
  };
  const [runtimeMode, setRuntimeMode] = useState<'auto' | 'default' | 'managed-hermes'>('auto');
  const [initializedBundles, setInitializedBundles] = useState(false);
  const [seedTask, setSeedTask] = useState<SolutionPackTask | null>(null);
  const [activeTaskId, setActiveTaskId] = useState('');
  const [rationale, setRationale] = useState('');
  const [retryFeedback, setRetryFeedback] = useState('');
  const [retrySource, setRetrySource] = useState<{ sourceThreadId: string; sourceTaskId?: string } | null>(null);
  const [runPage, setRunPage] = useState(1);
  const [showCheckpointHistory, setShowCheckpointHistory] = useState(false);
  const selectedThreadParam = searchParams.get('thread') ?? '';
  // Keep a just-started task selected immediately. Search-param navigation is
  // asynchronous, so relying on it alone lets a still-visible old thread win
  // the first render after an A2A start response.
  const selectedTaskId = activeTaskId || searchParams.get('task') || selectedThreadParam;

  useEffect(() => {
    if (workflows.length === 0 || workflows.some(workflow => workflow.id === workflowId)) return;
    setWorkflowId(workflows[0]!.id);
    setWorkflowInput(initialWorkflowInput(workflows[0]!));
  }, [workflowId, workflows]);

  const selectedWorkflow = workflows.find(workflow => workflow.id === workflowId) ?? workflows[0];
  const issueField = ['ticket-to-pull-request', 'ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(selectedWorkflow?.id ?? '')
    ? selectedWorkflow.inputSchema.find(field => field.name === 'issue_reference') : undefined;
  const ciProviderField = selectedWorkflow?.inputSchema.find(field => field.name === 'ci_provider');
  const ciProvider = workflowInput['ci_provider'] ?? ciProviderField?.defaultValue;
  const ciJobField = selectedWorkflow?.inputSchema.find(field => field.name === 'ci_job');
  // Older Pack catalogs put the Jenkins-specific field before the provider.
  // Keep the runtime contract, but show the dependent control beside its choice.
  const workflowFields = (selectedWorkflow?.inputSchema ?? []).flatMap(field => {
    if (ciProviderField && field.name === 'ci_job') return [];
    if (field.name === 'ci_provider' && ciJobField && ciProvider === 'jenkins') return [field, ciJobField];
    return [field];
  });
  const chooseWorkflow = (nextWorkflow: SolutionPackWorkflowDefinition) => {
    setWorkflowId(nextWorkflow.id);
    setWorkflowInput(initialWorkflowInput(nextWorkflow));
  };
  const openLaunch = () => {
    setReviewedIssue(null);
    issuePreview.reset();
    if (retrySource && selectedWorkflow) setWorkflowInput(initialWorkflowInput(selectedWorkflow));
    setRetrySource(null);
    setRetryFeedback('');
    start.reset();
    if (selectedWorkflow && workflowId !== selectedWorkflow.id) chooseWorkflow(selectedWorkflow);
    setLaunchOpen(true);
  };
  const missingRequiredFields = workflowFields.filter(field => {
    if (!field.required) return false;
    const value = workflowInput[field.name] ?? field.defaultValue;
    return value === undefined || value === null || String(value).trim() === '';
  });

  const selectedRunSummary = runs.data?.threads.find(thread => selectedThreadParam
    ? thread.thread_id === selectedThreadParam
    : threadTaskId(thread) === selectedTaskId || thread.thread_id === selectedTaskId);
  const directCodingRunSelected = Boolean(selectedRunSummary && (Boolean(selectedThreadParam) || typeof selectedRunSummary.metadata['a2a_task_id'] !== 'string'));
  const selectedCodingThreadId = selectedRunSummary?.thread_id ?? selectedThreadParam;

  const fabric = useQuery({
    queryKey: ['fabric-management'],
    queryFn: getFabricManagement,
    staleTime: 30_000,
    enabled: launchOpen || Boolean(selectedTaskId) || Boolean(orchestrator && pack?.state === 'ready'),
  });
  const launchHermesRuntime = useQuery({
    queryKey: ['hermes-managed-runtime'],
    queryFn: getHermesManagedRuntime,
    enabled: hermesPackConfigured && (launchOpen || Boolean(selectedTaskId) || hermesPackConnected),
    staleTime: 10_000,
    refetchInterval: launchOpen ? 5_000 : false,
  });
  const availableBundleIds = (fabric.data?.bundles ?? []).map(bundle => bundle.id);
  const approvedHermesBundleIds = launchHermesRuntime.data?.managed.approvedBundleIds ?? [];
  const autoWorkflowNeedsCoder = workflowAutoUsesManagedHermes(selectedWorkflow);
  const autoUsesManagedHermes = autoWorkflowNeedsCoder && launchHermesRuntime.data?.managed.ready === true;
  const predictedUsesManagedHermes = runtimeMode === 'managed-hermes' || (runtimeMode === 'auto' && autoUsesManagedHermes);
  const selectAutoRuntime = () => {
    setRuntimeMode('auto');
    if (autoWorkflowNeedsCoder && hermesPackConfigured) {
      setBundleIds(current => withManagedHermesReadScope(current, approvedHermesBundleIds, availableBundleIds));
    }
  };
  const selectManagedHermes = () => {
    setRuntimeMode('managed-hermes');
    setBundleIds(current => withManagedHermesReadScope(current, approvedHermesBundleIds, availableBundleIds));
  };
  const predictedManagedHermesBundleReady = !predictedUsesManagedHermes
    || approvedHermesBundleIds.some(id => bundleIds.includes(id));
  const selectedHermesBundleLabels = (fabric.data?.bundles ?? [])
    .filter(bundle => bundleIds.includes(bundle.id) && approvedHermesBundleIds.includes(bundle.id))
    .map(bundle => bundle.label);

  useEffect(() => {
    if (!initializedBundles || runtimeMode !== 'auto' || !autoWorkflowNeedsCoder || !hermesPackConfigured) return;
    setBundleIds(current => withManagedHermesReadScope(current, approvedHermesBundleIds, availableBundleIds));
  }, [initializedBundles, runtimeMode, autoWorkflowNeedsCoder, hermesPackConfigured, approvedHermesBundleIds.join(','), availableBundleIds.join(',')]);

  const requiredBundleCategories = selectedWorkflow?.requiredBundleCategories ?? [];
  const recommendedBundleCategories = selectedWorkflow?.recommendedBundleCategories ?? [];
  const selectedBundleRecords = (fabric.data?.bundles ?? []).filter(bundle => bundleIds.includes(bundle.id));
  const repositoryBundleLabels = selectedBundleRecords
    .filter(bundle => bundle.capabilityCategories?.includes('repository-checkout'))
    .map(bundle => bundle.label);
  const providedBundleCategories = new Set(
    selectedBundleRecords.flatMap(bundle => bundle.capabilityCategories ?? []),
  );
  const missingBundleCategories = requiredBundleCategories.filter(category => !providedBundleCategories.has(category));
  const missingRecommendedCategories = recommendedBundleCategories.filter(category => !providedBundleCategories.has(category));
  const preflightBundleIds = bundleIds.length > 0
    ? bundleIds
    : (fabric.data?.bundles ?? [])
      .filter(bundle => manifest?.spec.components.bundles.includes(bundle.name))
      .map(bundle => bundle.id);
  const launchRoutingPreflight = useQuery({
    queryKey: [
      'solution-pack-launch-routing-preflight',
      packId,
      orchestrator?.id,
      selectedWorkflow?.id,
      runtimeMode,
      launchHermesRuntime.data?.managed.ready ?? null,
      preflightRepository,
      [...bundleIds].sort((left, right) => left - right),
    ],
    queryFn: () => runSolutionPackPreflight(packId, orchestrator!.id, {
      workflowId: selectedWorkflow!.id,
      bundleIds,
      runtimeMode,
      ...(preflightRepository ? { repository: preflightRepository } : {}),
    }),
    enabled: launchOpen
      && preflightRepository === repositoryInput
      && initializedBundles
      && Boolean(orchestrator && selectedWorkflow)
      && pack?.state === 'ready'
      && bundleIds.length > 0
      && missingBundleCategories.length === 0
      && (!autoWorkflowNeedsCoder || !hermesPackConfigured || launchHermesRuntime.isFetched)
      && predictedManagedHermesBundleReady,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const launchRoutingSelection = taskRuntimeSelection(launchRoutingPreflight.data?.task);
  const launchRoutingReadiness = taskPreflightReadiness(launchRoutingPreflight.data?.task);
  const launchOperationalIssues = bundleOperationalIssues(launchRoutingPreflight.error);
  const launchCatalogIssues = launchOperationalIssues.filter(issue => issue.recovery === 'review_catalog');
  const missingSelectedBundles = bundleIds.filter(id => !availableBundleIds.includes(id));
  const usesManagedHermes = runtimeMode === 'managed-hermes'
    || (runtimeMode === 'auto'
      && (launchRoutingSelection ? launchRoutingSelection.effectiveMode === 'managed-hermes' : autoUsesManagedHermes));
  const managedHermesBundleReady = !usesManagedHermes
    || approvedHermesBundleIds.some(id => bundleIds.includes(id));
  const preflight = useMutation({ mutationFn: async () => {
    const [catalogResult, fabricResult] = await Promise.all([catalog.refetch(), fabric.refetch()]);
    const refreshedWorkflows = (catalogResult.data?.agentCard.skills ?? [])
      .map(skill => skill['x-argus-workflow'])
      .filter((workflow): workflow is SolutionPackWorkflowDefinition => Boolean(workflow));
    const selectedWorkflowId = selectedWorkflow?.id
      ?? workflows[0]?.id
      ?? refreshedWorkflows[0]?.id
      ?? manifest?.spec.components.workflows?.[0];
    const refreshedBundleIds = fabricResult.data?.bundles
      .filter(bundle => manifest?.spec.components.bundles.includes(bundle.name))
      .map(bundle => bundle.id) ?? [];
    return runSolutionPackPreflight(packId, orchestrator!.id, {
      workflowId: selectedWorkflowId,
      bundleIds: preflightBundleIds.length > 0 ? preflightBundleIds : refreshedBundleIds,
    });
  } });
  const preflightEvidence = preflight.data?.task.artifacts?.[0]?.parts?.[0]?.data;
  const capabilityEvidence = preflight.data?.task.artifacts
    ?.flatMap(artifact => artifact.parts ?? [])
    .map(part => part.data)
    .map(data => data?.['kind'] === 'bundle-capability-preflight'
      ? data
      : data?.['coreBundleCapabilityPreflight'] && typeof data['coreBundleCapabilityPreflight'] === 'object'
        ? data['coreBundleCapabilityPreflight'] as Record<string, unknown>
        : undefined)
    .find(data => data?.['kind'] === 'bundle-capability-preflight');

  useEffect(() => {
    if (initializedBundles || !fabric.data || !manifest) return;
    setBundleIds(initialWorkflowBundleIds(
      manifest.spec.components.bundles,
      fabric.data.bundles,
      requiredBundleCategories,
      recommendedBundleCategories,
    ));
    setInitializedBundles(true);
  }, [fabric.data, initializedBundles, manifest, requiredBundleCategories.join(','), recommendedBundleCategories.join(',')]);

  const selectTask = (taskId: string) => {
    setRationale('');
    setActiveTaskId(taskId);
    setSearchParams(taskId ? { task: taskId } : {}, { replace: true });
  };

  const start = useMutation({
    mutationFn: async () => {
      if (!issueReady) throw new Error('Load and review the issue for the selected repository Bundle before starting.');
      const readiness = await runSolutionPackPreflight(packId, orchestrator!.id, {
        workflowId: selectedWorkflow!.id,
        bundleIds,
        runtimeMode,
        ...(workflowInput['repository'] ? { repository: String(workflowInput['repository']).trim() } : {}),
      });
      const readinessParts = readiness.task.artifacts
        ?.flatMap(artifact => artifact.parts ?? [])
        .map(part => part.data)
        .filter((data): data is Record<string, unknown> => Boolean(data && typeof data === 'object')) ?? [];
      const runtimePreflightContainer = readinessParts.find(data => data['runtimePreflight']);
      const runtimePreflight = runtimePreflightContainer?.['runtimePreflight'] as Record<string, unknown> | undefined;
      const packReadiness = readinessParts.find(data => typeof data['ready'] === 'boolean');
      // Older Core responses nested agent-workspace readiness below
      // `runtimePreflight`; the real Argus Dev A2A preflight publishes its
      // readiness directly on the artifact. Prefer the more specific runtime
      // verdict when present, while accepting the provider-neutral Pack
      // contract used by current runtimes.
      const ready = runtimePreflight
        ? runtimePreflight['ready'] === true
        : packReadiness?.['ready'] === true;
      const blockerSource = runtimePreflight ?? packReadiness;
      const blockers = Array.isArray(blockerSource?.['blockers'])
        ? blockerSource['blockers'].map(String)
        : [];
      const failureReason = typeof readiness.task.metadata?.['failureReason'] === 'string'
        ? readiness.task.metadata['failureReason']
        : '';
      if (readiness.task.status.state !== 'TASK_STATE_COMPLETED' || !ready) {
        throw new Error(failureReason || blockers.join('; ') || 'Runtime, Agent or MCP bundle readiness check failed.');
      }
      if (runtimeMode === 'managed-hermes'
        && (!hermesPackConnected || !launchHermesRuntime.data?.managed.ready || !managedHermesBundleReady)) {
        throw new Error(launchHermesRuntime.data?.managed.detail || 'Managed Hermes is not ready for the selected execution bundles.');
      }
      const launchInput: Record<string, string | number | boolean> = { ...workflowInput, ...(selectedWorkflow!.inputSchema.some(field => field.name === 'issue_sha256')
        ? { issue_sha256: issueReference ? currentIssue!.sha256 : '' } : {}) };
      // A hidden Jenkins job must not leak into another provider, including retries.
      if (ciProviderField && ciProvider !== 'jenkins') delete launchInput['ci_job'];
      return startSolutionPackWorkflow(packId, orchestrator!.id, {
        workflowId: selectedWorkflow!.id,
        input: launchInput,
        bundleIds,
        runtimeMode,
        ...(retrySource ? { retry: { ...retrySource, feedback: retryFeedback.trim() } } : {}),
      });
    },
    onSuccess: async data => {
      setSeedTask(data.task);
      setRunPage(1);
      queryClient.setQueryData(['solution-pack-task', packId, orchestrator?.id, data.task.id], { task: data.task });
      setLaunchOpen(false);
      setReviewedIssue(null);
      setRetrySource(null);
      setRetryFeedback('');
      setRuntimeMode('auto');
      if (selectedWorkflow) setWorkflowInput(initialWorkflowInput(selectedWorkflow));
      selectTask(data.task.id);
      await queryClient.invalidateQueries({ queryKey: ['argus-dev-runs'] });
    },
  });

  // One source for both the disabled button and its visible explanation.
  const launchBlockers: string[] = [];
  if (!orchestrator) launchBlockers.push('The workflow orchestrator is unavailable.');
  if (!selectedWorkflow) launchBlockers.push('Select a development workflow.');
  if (pack?.state !== 'ready') launchBlockers.push('The Argus Dev Solution Pack is not ready.');
  if (missingRequiredFields.length > 0) launchBlockers.push(`Complete required fields: ${missingRequiredFields.map(field => field.label).join(', ')}.`);
  if (!issueReady) launchBlockers.push(issueLoading
    ? 'Wait for the issue preview to finish loading.'
    : 'Load and review the issue again for the currently selected Bundles.');
  if (bundleIds.length === 0) launchBlockers.push('Select execution Bundles.');
  if (missingBundleCategories.length > 0) launchBlockers.push(`Missing Bundle capabilities: ${missingBundleCategories.map(category => BUNDLE_CAPABILITY_LABELS[category] ?? category).join(', ')}.`);
  if (missingSelectedBundles.length > 0) launchBlockers.push('Remove unavailable Bundles from the selection above.');
  if (!managedHermesBundleReady) launchBlockers.push('Select an operator-approved read-only Bundle for Managed Hermes.');
  // The repository reaches the preflight after a short debounce; until then the
  // visible route preview belongs to the previous value and must not unlock Start.
  if (launchRoutingPreflight.isFetching || preflightRepository !== repositoryInput) launchBlockers.push('Wait for the live runtime and execution-scope check.');
  if ((launchRoutingPreflight.error as Error & { code?: string } | null)?.code === 'repository_checkout_conflict') launchBlockers.push('Select exactly one repository checkout Bundle.');
  if (launchOperationalIssues.length > 0) launchBlockers.push('Resolve the execution-scope connection issues shown above.');
  if (launchRoutingPreflight.data && !launchRoutingReadiness.ready) launchBlockers.push('Resolve the runtime readiness error shown above.');
  if (start.isPending) launchBlockers.push('The governed task is being started.');

  const taskQuery = useQuery({
    queryKey: ['solution-pack-task', packId, orchestrator?.id, selectedTaskId],
    queryFn: () => getSolutionPackTask(packId, orchestrator!.id, selectedTaskId),
    // Wait for the thread index before deciding whether this UUID is an A2A
    // task id or a direct LangGraph thread id. Otherwise a direct run briefly
    // hits the Pack A2A endpoint and leaves a misleading "task not found"
    // error in the dialog.
    enabled: Boolean(orchestrator && selectedTaskId && !runs.isLoading && !directCodingRunSelected),
    refetchInterval: queryState => {
      const state = queryState.state.data?.task.status.state
        ?? (seedTask?.id === selectedTaskId ? seedTask.status.state : '');
      return TERMINAL_TASK_STATES.has(state) ? false : 2_000;
    },
  });
  const codingThreadQuery = useQuery({
    queryKey: ['coding-thread', selectedCodingThreadId],
    queryFn: () => getCodingThread(selectedCodingThreadId),
    // A2A task retention is intentionally shorter than LangGraph checkpoint
    // retention. Keep the persisted workflow thread warm as a fallback so a
    // historical run remains inspectable and approvable after its Pack task
    // has expired.
    enabled: Boolean(selectedCodingThreadId && (directCodingRunSelected || selectedRunSummary)),
    refetchInterval: queryState => {
      const status = queryState.state.data?.status;
      return status === 'completed' || status === 'failed' || status === 'canceled' ? false : 2_000;
    },
  });
  const directTask = codingThreadQuery.data ? codingThreadTask(codingThreadQuery.data) : undefined;
  // A task query can briefly finish with data belonging to the previous
  // selection while the URL and the new query key are settling. Never show
  // that data in the detail dialog: it makes a newly started run look like a
  // different task and can also expose the wrong approval controls.
  const selectedA2aTask = taskQuery.data?.task?.id === selectedTaskId ? taskQuery.data.task : undefined;
  const selectedCodingTask = directTask && (
    directTask.id === selectedTaskId
    || (taskQuery.isError && selectedCodingThreadId === directTask.id)
  )
    ? directTask
    : undefined;
  const selectedSeedTask = seedTask?.id === selectedTaskId ? seedTask : undefined;
  // The start response is authoritative while the newly created A2A task is
  // still propagating to the task endpoint. Only use the persisted LangGraph
  // projection after that seed task is no longer available.
  const task = selectedA2aTask ?? selectedSeedTask ?? selectedCodingTask;
  const usingCodingThreadEvidence = Boolean(selectedCodingTask && !selectedA2aTask && !selectedSeedTask);
  const taskError = task
    ? null
    : directCodingRunSelected
      ? codingThreadQuery.error
      : taskQuery.error ?? codingThreadQuery.error;
  const codingEvidence = taskEvidence(task);
  const executionRuntimeOverrides = Array.isArray(task?.metadata?.['executionRuntimeOverrides'])
    ? task.metadata['executionRuntimeOverrides']
    : Array.isArray(task?.metadata?.['execution_runtime_overrides'])
      ? task.metadata['execution_runtime_overrides']
      : [];
  const executionRuntimeLabel = executionRuntimeOverrides
    .map(value => value && typeof value === 'object' && !Array.isArray(value)
      ? String((value as Record<string, unknown>)['runtimeProfileName'] ?? '')
      : '')
    .filter(Boolean)
    .join(', ');
  const runtimeSelection = taskRuntimeSelection(task);
  const effectiveExecutionRuntimeLabel = executionRuntimeLabel
    || (runtimeSelection?.effectiveMode === 'managed-hermes' ? 'hermes-managed-dev' : 'Agent default');
  const workflowThreadId = typeof task?.metadata?.['workflowThreadId'] === 'string'
    ? task.metadata['workflowThreadId']
    : '';
  const checkpointThreadId = workflowThreadId || selectedCodingThreadId;
  const checkpointHistory = useQuery({
    queryKey: ['coding-checkpoints', checkpointThreadId],
    queryFn: () => getCodingCheckpoints(checkpointThreadId),
    enabled: showCheckpointHistory && Boolean(checkpointThreadId),
    staleTime: 5_000,
  });
  const taskState = task?.status.state ?? '';
  const inputRequired = taskState === 'TASK_STATE_INPUT_REQUIRED';
  const terminal = TERMINAL_TASK_STATES.has(taskState);
  const canceling = !terminal && task?.metadata?.['runtimeStatus'] === 'canceling';

  const argusDevRuns = useMemo(
    () => {
      const cutoff = Date.now() - RUN_WINDOW_MS;
      return (runs.data?.threads ?? [])
        .filter(thread => threadTaskId(thread) && Date.parse(thread.updated_at) >= cutoff)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    },
    [runs.data],
  );
  const persistedRuntimeRuns = useMemo(
    () => {
      const cutoff = Date.now() - RUN_WINDOW_MS;
      return (codexRuntime.data?.runs ?? [])
        .filter(run => Boolean(run.telemetryTraceId)
          && ['completed', 'failed', 'canceled'].includes(run.state)
          && Date.parse(run.updatedAt) >= cutoff)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    },
    [codexRuntime.data?.runs],
  );
  const developmentRuns = useMemo<DevelopmentRunCard[]>(
    () => [
      ...argusDevRuns.map(thread => ({ kind: 'workflow' as const, thread })),
      ...persistedRuntimeRuns.map(run => ({ kind: 'runtime' as const, run })),
    ].sort((left, right) => {
      const leftUpdated = left.kind === 'workflow' ? left.thread.updated_at : left.run.updatedAt;
      const rightUpdated = right.kind === 'workflow' ? right.thread.updated_at : right.run.updatedAt;
      return Date.parse(rightUpdated) - Date.parse(leftUpdated);
    }),
    [argusDevRuns, persistedRuntimeRuns],
  );
  const runPageCount = Math.max(1, Math.ceil(developmentRuns.length / RUN_PAGE_SIZE));
  const runPageWindowStart = Math.floor((Math.min(runPage, runPageCount) - 1) / RUN_PAGE_LINK_COUNT) * RUN_PAGE_LINK_COUNT + 1;
  const visibleRunPages = Array.from(
    { length: Math.min(RUN_PAGE_LINK_COUNT, runPageCount - runPageWindowStart + 1) },
    (_, index) => runPageWindowStart + index,
  );
  const pagedDevelopmentRuns = useMemo(
    () => developmentRuns.slice((runPage - 1) * RUN_PAGE_SIZE, runPage * RUN_PAGE_SIZE),
    [developmentRuns, runPage],
  );
  useEffect(() => {
    setRunPage(current => Math.min(current, runPageCount));
  }, [runPageCount]);
  const selectedThread = argusDevRuns.find(thread => threadTaskId(thread) === selectedTaskId);
  const taskWorkflowId = typeof task?.metadata?.['workflowId'] === 'string'
    ? task.metadata['workflowId']
    : selectedThread ? threadWorkflowId(selectedThread) : '';
  const detailWorkflow = workflows.find(workflow => workflow.id === taskWorkflowId) ?? selectedWorkflow;
  const approvalRecovery = useQuery({
    queryKey: ['git-approval-recovery', checkpointThreadId, codingThreadQuery.data?.checkpoint_id,
      codingThreadQuery.data?.status ?? selectedThread?.status],
    queryFn: () => getCodingApprovalRecovery(checkpointThreadId),
    enabled: Boolean(checkpointThreadId && ['input_required', 'interrupted', 'failed'].includes(codingThreadQuery.data?.status ?? selectedThread?.status ?? '')
      && ['ticket-to-pull-request', 'ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(taskWorkflowId)),
    retry: false,
  });
  const traceId = workflowThreadId || selectedThread?.thread_id || '';
  const hasTraceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(traceId);
  const runDetail = useQuery({
    queryKey: ['solution-pack-run-agents', traceId],
    queryFn: () => getRunDetail('workflow', traceId),
    enabled: Boolean(selectedTaskId && hasTraceId),
    refetchInterval: terminal ? false : 3_000,
  });
  const agentExecutions = useMemo(() => (
    runDetail.data?.traceFamily?.runs
      .filter(run => run.kind === 'agent')
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)) ?? []
  ), [runDetail.data]);
  const testPhaseExecutions = useMemo(() => (
    runDetail.data?.traceFamily?.spans
      .map(span => workflowTestPhaseActivity(span, traceId))
      .filter((activity): activity is ActivityExecution => activity != null)
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)) ?? []
  ), [runDetail.data, traceId]);
  const activitySourceThread = codingThreadQuery.data ?? selectedThread;
  const activityLog = useMemo(
    () => workflowLogEntries(activitySourceThread?.values?.['log']),
    [activitySourceThread?.values],
  );
  const activityEvidenceTimestamp = activitySourceThread?.updated_at
    ?? task?.status.timestamp
    ?? '1970-01-01T00:00:00.000Z';
  const activityExecutions = useMemo(
    () => mergeWorkflowActivity([...agentExecutions, ...testPhaseExecutions], activityLog, codingEvidence, activityEvidenceTimestamp),
    [activityEvidenceTimestamp, activityLog, agentExecutions, codingEvidence, testPhaseExecutions],
  );
  const backlogReview = detailWorkflow?.id === 'backlog-grooming' ? backlogReviewPresentation({
    state: taskState,
    canceling,
    stage: codingEvidence.currentStage,
    review: codingEvidence.review,
    passed: codingEvidence.reviewPassed,
    humanApproved: codingEvidence.humanApproved,
    humanChangeRequest: codingEvidence.humanChangeRequest,
    retries: codingEvidence.retryCount,
    completedReviews: activityLog.filter(entry => entry.step === 'review_backlog').length,
    maxAttempts: detailWorkflow.reviewPolicy?.maxAttempts,
  }) : null;
  const codingProgress = ['ticket-to-pull-request', 'ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(detailWorkflow?.id ?? '')
    ? codingProgressPresentation({ state: taskState, canceling, evidence: codingEvidence, maxRevisions: detailWorkflow.revisionPolicy?.maxRevisions,
      technicalBlocked: (codingThreadQuery.data?.interrupts ?? selectedThread?.interrupts ?? []).some(item => {
        const decision = readDevelopmentDecision(item.value?.['decision']);
        return decision?.kind === 'technical_review' && !decision.canClarify;
      }), responseFailure: (codingThreadQuery.data?.interrupts ?? selectedThread?.interrupts ?? []).some(item =>
        Boolean(readDevelopmentDecision(item.value?.['decision'])?.responseFailure)) }) : null;
  const selectedBundleIds = Array.isArray(task?.metadata?.['executionBundleIds'])
    ? task.metadata['executionBundleIds'].filter((value): value is number => typeof value === 'number')
    : Array.isArray(selectedThread?.metadata['execution_bundle_ids'])
      ? selectedThread.metadata['execution_bundle_ids'].filter((value): value is number => typeof value === 'number')
      : Number(selectedThread?.metadata['argus_bundle_id'] ?? 0) > 0
        ? [Number(selectedThread?.metadata['argus_bundle_id'])]
      : [];
  const selectedBundleLabels = selectedBundleIds.map(id => fabric.data?.bundles.find(bundle => bundle.id === id)?.label ?? `Bundle #${id}`);
  const managedHermesRetry = executionRuntimeOverrides.some(value => (
    value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>)['runtimeType'] === 'hermes'
  ));
  const activeApprovalDefinition = detailWorkflow?.stages.find(stage => (
    stage.kind === 'approval' && stage.id === codingEvidence.currentStage
  ));
  const approvalStage = ['ticket-to-pull-request', 'ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(detailWorkflow?.id ?? '') && codingEvidence.currentStage === 'human_approval_pr'
    ? 'Functional approval'
    : activeApprovalDefinition
      ? activeApprovalDefinition.label
      : detailWorkflow?.id === 'pull-request-review'
        ? 'PR continuation approval'
        : codingEvidence.humanApproved ? 'Functional approval' : 'Code approval';
  // `taskEvidence` intentionally returns a partial object while a run is
  // still being assembled. Normalize optional diff evidence once so the
  // detail view remains render-safe for older/in-flight runs.
  const diffItems = Array.isArray(codingEvidence.fileDiffs) ? codingEvidence.fileDiffs : [];
  const changedFiles = evidenceList(diffItems);
  const revisionHistory = Array.isArray(codingEvidence.revisionHistory) ? codingEvidence.revisionHistory : [];
  const approvalInterrupt = (codingThreadQuery.data?.interrupts ?? selectedThread?.interrupts ?? [])
    .find(item => item?.value && typeof item.value === 'object')?.value;
  const approvalMessage = approvalInterrupt && typeof approvalInterrupt['message'] === 'string' ? approvalInterrupt['message'] : '';
  const requirementsNeeded = codingEvidence.currentStage === 'requirements_input' || approvalInterrupt?.['stage'] === 'requirements_input';
  const developmentDecision = readDevelopmentDecision(approvalInterrupt?.['decision']);
  const versionedDecision = approvalInterrupt?.['decision'] !== undefined || codingThreadQuery.data?.values?.['development_contract_version'] === 2;
  const [requirementsText, setRequirementsText] = useState('');
  const approvalPlan = approvalInterrupt && typeof approvalInterrupt['plan_summary'] === 'string' ? approvalInterrupt['plan_summary'] : '';
  const approvalEvidence = approvalInterrupt?.['evidence'] && typeof approvalInterrupt['evidence'] === 'object'
    && !Array.isArray(approvalInterrupt['evidence'])
    ? JSON.stringify(approvalInterrupt['evidence'], null, 2)
    : '';
  const approvalReview = approvalInterrupt && typeof approvalInterrupt['review_summary'] === 'string'
    ? approvalInterrupt['review_summary']
    : approvalEvidence;
  const humanChangeThread = codingThreadQuery.data ?? selectedThread;
  const humanChangeRequest = typeof codingEvidence.humanChangeRequest === 'string' && codingEvidence.humanChangeRequest.trim()
    ? codingEvidence.humanChangeRequest.trim()
    : typeof humanChangeThread?.values?.['human_change_request'] === 'string'
      ? humanChangeThread.values['human_change_request'].trim()
      : '';
  const releaseNotes = typeof codingEvidence.releaseNotes === 'string' ? codingEvidence.releaseNotes.trim() : '';
  const backlogTasks = typeof codingEvidence.backlogTasks === 'string' ? codingEvidence.backlogTasks.trim() : '';
  const humanChangeState = humanChangeRequest && humanChangeThread
    ? humanChangeRequestState(humanChangeThread)
    : null;
  const changeRequestCoder = agentExecutions.find(execution => /coder/i.test(`${execution.title} ${execution.subtitle}`));
  const changeRequestReviewer = agentExecutions.find(execution => /review/i.test(`${execution.title} ${execution.subtitle}`));
  const changeRequestCoderHref = changeRequestCoder ? changeRequestCoder.href ?? `/runs/agent/${encodeURIComponent(changeRequestCoder.id)}` : null;
  const changeRequestReviewerHref = changeRequestReviewer ? changeRequestReviewer.href ?? `/runs/agent/${encodeURIComponent(changeRequestReviewer.id)}` : null;
  const retryThreadId = workflowThreadId || selectedThread?.thread_id || selectedCodingThreadId;
  const detailCiState = deliveryState(codingEvidence.deliveryStatus, codingEvidence.ciRun?.status);

  const decision = useMutation({
    mutationFn: (approved: boolean) => resumeCodingWorkflow(workflowThreadId, {
      approved,
      feedback: rationale.trim(),
      rationale: rationale.trim(),
    }),
    onSuccess: async () => {
      setRationale('');
      await Promise.all([taskQuery.refetch(), codingThreadQuery.refetch(), queryClient.invalidateQueries({ queryKey: ['argus-dev-runs'] })]);
    },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: ['git-approval-recovery', checkpointThreadId] }); },
  });
  const recoverApproval = useMutation({
    mutationFn: (checkpointId: string) => recoverCodingApproval(checkpointThreadId, checkpointId),
    onSuccess: async () => {
      await Promise.all([taskQuery.refetch(), codingThreadQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ['git-approval-recovery', checkpointThreadId] }),
        queryClient.invalidateQueries({ queryKey: ['argus-dev-runs'] })]);
    },
  });
  const clarify = useMutation({
    mutationFn: (reply?: DecisionReply) => reply
      ? submitCodingRequirements(workflowThreadId, reply.requirements, { decisionId: reply.decisionId, answers: reply.answers })
      : submitCodingRequirements(workflowThreadId, requirementsText.trim()),
    onSuccess: async () => {
      setRequirementsText('');
      await Promise.all([taskQuery.refetch(), codingThreadQuery.refetch(), queryClient.invalidateQueries({ queryKey: ['argus-dev-runs'] })]);
    },
  });
  const configureRetry = () => {
    const source = codingThreadQuery.data ?? selectedThread;
    if (!source || !detailWorkflow) return;
    setWorkflowId(detailWorkflow.id);
    setWorkflowInput(governedRetryInput(detailWorkflow, source));
    setRetryFeedback('');
    setBundleIds([...selectedBundleIds]);
    setInitializedBundles(true);
    setRuntimeMode(runtimeSelection?.requestedMode ?? (managedHermesRetry ? 'managed-hermes' : 'default'));
    setReviewedIssue(null);
    issuePreview.reset();
    setRetrySource({ sourceThreadId: source.thread_id,
      ...(typeof source.metadata['a2a_task_id'] === 'string' ? { sourceTaskId: source.metadata['a2a_task_id'] } : {}) });
    start.reset();
    setLaunchOpen(true);
  };
  const cancel = useMutation({
    mutationFn: () => cancelSolutionPackTask(packId, orchestrator!.id, task!.id),
    onSuccess: async data => {
      setSeedTask(data.task);
      queryClient.setQueryData(['solution-pack-task', packId, orchestrator?.id, data.task.id], data);
      await queryClient.invalidateQueries({ queryKey: ['argus-dev-runs'] });
    },
  });

  if (query.isLoading) return <LoadingState label="Discovering solution packs…" />;
  if (query.error) return <ErrorState error={query.error} />;

  if (!pack) {
    return (
      <>
        <PageHeader eyebrow="SOLUTIONS" title="Argus Dev" description="Governed software-development workflows delivered as an external Argus solution pack." />
        <section className="panel solution-empty">
          <EmptyState title="Argus Dev is not connected" description="Configure argus.dev through ARGUS_SOLUTION_PACK_ENDPOINTS, then refresh discovery." />
          <button className="button button-primary" type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw size={15} />Refresh packs</button>
        </section>
      </>
    );
  }

  const title = manifest?.metadata.displayName ?? pack.configuredId;
  const selectedTicket = codingEvidence.runTitle || codingEvidence.ticketId
    || (selectedThread ? threadTitle(selectedThread) : 'Development run');
  const runningCount = activeRuntimeRuns.length + activeClaudeRuns.length + argusDevRuns.filter(thread => ['idle', 'queued', 'running', 'waiting_external_ci'].includes(thread.status)).length;
  const waitingCount = argusDevRuns.filter(thread => thread.status === 'interrupted' && !externalCiWaiting(thread)
    && !developmentInputLabel(thread)).length;
  const technicalBlockedCount = argusDevRuns.filter(isTechnicalWorkBlocked).length;
  const clarificationCount = argusDevRuns.filter(thread => developmentInputLabel(thread) && !isTechnicalWorkBlocked(thread)).length;
  const ciWaitingCount = argusDevRuns.filter(thread => externalCiWaiting(thread)).length;
  const completedCount = persistedRuntimeRuns.filter(run => run.state === 'completed').length
    + argusDevRuns.filter(thread => thread.status === 'completed').length;
  const developmentRunCount = developmentRuns.length;

  return (
    <>
      <PageHeader
        eyebrow="SOLUTIONS · ARGUS CORE"
        title={title}
        description={manifest?.metadata.description ?? 'External solution pack connected to the governed Argus Core runtime.'}
        actions={(
          <>
            {platformAdmin && <button className="button button-secondary" type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw className={refresh.isPending ? 'spin' : ''} size={15} />Refresh</button>}
            <a className="button button-secondary" href="/build/workflows"><Workflow size={15} />Workflow catalog</a>
            <button className="button button-primary" type="button" onClick={openLaunch}><Plus size={15} />New development run</button>
          </>
        )}
      />

      <section className="solution-hero">
        <div className="solution-identity">
          <span className="solution-mark"><Code2 size={26} /></span>
          <div><small>CONTAINERIZED SOLUTION PACK</small><h2>{title}</h2><p>{pack.endpoint}</p></div>
          <HealthBadge state={packHealth(pack.state)} />
        </div>
        <div className="solution-facts">
          <span><b>{manifest?.metadata.version ?? '—'}</b><small>pack version</small></span>
          <span><b>{manifest?.spec.components.workflows.length ?? 0}</b><small>workflows</small></span>
          <span><b>{manifest?.spec.components.agents.length ?? 0}</b><small>orchestrators</small></span>
          <span><b>{componentCount(manifest)}</b><small>declared components</small></span>
          <span><b>{pack.readiness?.latencyMs ?? '—'}{pack.readiness ? ' ms' : ''}</b><small>readiness</small></span>
        </div>
      </section>

      {pack.error && <div className="editor-error" role="alert">{pack.error}</div>}

      {hermesPackConnected && <HermesRuntimePanel />}

      <section className="panel solution-runs-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">DEVELOPMENT CONTROL PLANE</span><h2>Development runs</h2><p>Live and persisted executions from the last 7 days.</p></div>
          <button className="button button-primary" type="button" onClick={openLaunch}><Plus size={14} />New run</button>
        </div>
        <div className="solution-run-summary" aria-label="Argus Dev run summary">
          <span><LoaderCircle size={14} /><b>{runningCount}</b><small>running</small></span>
          <span><ShieldCheck size={14} /><b>{waitingCount}</b><small>awaiting approval</small></span>
          {clarificationCount > 0 && <span><CircleDot size={14} /><b>{clarificationCount}</b><small>awaiting clarification</small></span>}
          {technicalBlockedCount > 0 && <span><CircleDot size={14} /><b>{technicalBlockedCount}</b><small>technically blocked</small></span>}
          <span className="solution-summary-ci"><Network size={14} /><b>{ciWaitingCount}</b><small>CI/CD waiting</small></span>
          <span><CheckCircle2 size={14} /><b>{completedCount}</b><small>completed</small></span>
          <span><Clock3 size={14} /><b>{developmentRunCount}</b><small>last 7 days</small></span>
        </div>
        {visibleRuntimeRuns.length ? (
          <section className="solution-runtime-sessions" aria-label="Codex runtime sessions">
            <header>
              <div><span className="eyebrow">EXECUTION RUNTIME</span><h3>Active Codex runtime sessions</h3><p>Live sessions can be stopped here. Completed runs and their evidence remain available in the normal Runs and Logs views.{visibleRuntimeRuns.length < activeRuntimeRuns.length && ' Plan sessions are hidden here; their execution is unchanged.'}</p></div>
              <b>{codexRuntime.data?.activeRuns ?? 0}/{codexRuntime.data?.maxConcurrentRuns ?? 0} active</b>
            </header>
            <div className="solution-runtime-session-list">
              {visibleRuntimeRuns.map(runtimeRun => (
                <article className={`solution-runtime-session state-${runtimeRun.state}`} key={runtimeRun.id}>
                  <span className="solution-runtime-session-icon"><Code2 size={14} /></span>
                  <div><b>{runtimeRun.taskType || 'Codex runtime'}</b><small>{runtimeRun.state} · {runtimeRun.model || 'codex-default'} · {runtimeRun.reasoningEffort || 'default'}</small></div>
                  <code title={runtimeRun.id}>{runtimeRun.id.slice(0, 12)}…</code>
                  {['starting', 'running'].includes(runtimeRun.state) && <button type="button" disabled={cancelRuntime.isPending} onClick={() => cancelRuntime.mutate(runtimeRun.id)}>{cancelRuntime.isPending ? 'Stopping…' : 'Stop'}</button>}
                  {runtimeRun.telemetryTraceId && <a href={`/runs/agent/${encodeURIComponent(runtimeRun.telemetryTraceId)}`}>Run</a>}
                  {runtimeRun.telemetryTraceId && <a href={`/observe/logs?trace=${encodeURIComponent(runtimeRun.telemetryTraceId)}`}>Logs</a>}
                  {runtimeRun.error && <p>{runtimeRun.error}</p>}
                </article>
              ))}
            </div>
          </section>
        ) : codexRuntime.error ? (
          <p className="solution-runtime-session-error">Runtime status unavailable: {codexRuntime.error instanceof Error ? codexRuntime.error.message : 'unknown error'}</p>
        ) : null}
        {visibleClaudeRuns.length ? (
          <section className="solution-runtime-sessions solution-runtime-sessions-claude" aria-label="Claude Code runtime sessions">
            <header>
              <div><span className="eyebrow">EXECUTION RUNTIME</span><h3>Active Claude Code subscription sessions</h3><p>Authenticated through the local Claude.ai Pro/Max session in the protected claude-auth volume.{visibleClaudeRuns.length < activeClaudeRuns.length && ' Plan sessions are hidden here; their execution is unchanged.'}</p></div>
              <b>{claudeRuntime.data?.activeRuns ?? 0}/{claudeRuntime.data?.maxConcurrentRuns ?? 0} active</b>
            </header>
            <div className="solution-runtime-session-list">
              {visibleClaudeRuns.map(runtimeRun => (
                <article className={`solution-runtime-session state-${runtimeRun.state}`} key={runtimeRun.id}>
                  <span className="solution-runtime-session-icon"><Bot size={14} /></span>
                  <div><b>{runtimeRun.taskType || 'Claude Code runtime'}</b><small>{runtimeRun.state} · {runtimeRun.model || 'claude-subscription'}</small></div>
                  <code title={runtimeRun.id}>{runtimeRun.id.slice(0, 12)}…</code>
                  {['starting', 'running'].includes(runtimeRun.state) && <button type="button" disabled={cancelClaude.isPending} onClick={() => cancelClaude.mutate(runtimeRun.id)}>{cancelClaude.isPending ? 'Stopping…' : 'Stop'}</button>}
                  {runtimeRun.telemetryTraceId && <a href={`/runs/agent/${encodeURIComponent(runtimeRun.telemetryTraceId)}`}>Run</a>}
                  {runtimeRun.telemetryTraceId && <a href={`/observe/logs?trace=${encodeURIComponent(runtimeRun.telemetryTraceId)}`}>Logs</a>}
                  {runtimeRun.error && <p>{runtimeRun.error}</p>}
                </article>
              ))}
            </div>
          </section>
        ) : claudeRuntime.error ? (
          <p className="solution-runtime-session-error">Claude Code runtime unavailable: {claudeRuntime.error instanceof Error ? claudeRuntime.error.message : 'unknown error'}</p>
        ) : null}
        {query.isLoading ? <LoadingState label="Checking Argus Dev runtime…" /> : !packReady ? (
          <div className="solution-runs-empty">
            <EmptyState
              title="Argus Dev runtime is offline"
              description={pack?.error || 'Start or reconnect the argus.dev Solution Pack before loading development runs.'}
            />
          </div>
        ) : runs.isLoading ? <LoadingState label="Loading development runs…" /> : runs.error ? <ErrorState error={runs.error} /> : developmentRuns.length > 0 ? (
          <>
          <div className="solution-run-cards">
            {pagedDevelopmentRuns.map(card => {
              if (card.kind === 'runtime') {
                const runtimeRun = card.run;
                const stateLabel = runtimeRun.state === 'completed' ? 'Completed' : runtimeRun.state === 'failed' ? 'Failed' : 'Canceled';
                return (
                  <a className="solution-run-card solution-runtime-run-card" href={`/runs/agent/${encodeURIComponent(runtimeRun.telemetryTraceId!)}`} key={`runtime:${runtimeRun.id}`}>
                    <header><span><Code2 size={15} /></span><div><small>API EXECUTION</small><h3>{runtimeRun.taskType || 'Codex runtime'}</h3></div><em className={`solution-task-state state-${runtimeRun.state}`}>{stateLabel}</em></header>
                    <p>{runtimeRun.error || `Workspace ${runtimeRun.cwd || 'runtime workspace'}`}</p>
                    <footer><span>{runtimeRun.model || 'codex-default'}</span><span>Run + Logs</span><time>{timeAgo(runtimeRun.updatedAt)}</time><ArrowRight size={13} /></footer>
                  </a>
                );
              }
              const thread = card.thread;
              const status = threadState(thread);
              const workflow = workflows.find(item => item.id === threadWorkflowId(thread));
              const stages = (workflow?.stages ?? []).filter(stage => !['qa_author', 'qa_execute'].includes(stage.id)
                || thread.values?.['qa_acceptance_policy_version'] === 1).filter(stage => stage.id !== 'stack_environment'
                || [2, 3].includes(Number(thread.values?.['qa_environment_policy_version']))).filter(stage => !['generation_plan', 'code_generation'].includes(stage.id)
                || thread.values?.['code_generation_policy_version'] === 1);
              const current = workflow ? stageIndex(stages, threadStage(thread, workflow), thread.status === 'completed') : 0;
              const progress = stages.length > 0 ? Math.max(4, Math.round((current / stages.length) * 100)) : 4;
              const testsPassed = thread.values?.['tests_passed'] === true;
              const reviewPassed = thread.values?.['review_passed'] === true;
              const ciState = threadDeliveryState(thread);
              const ciRun = threadCiRun(thread);
              const bundleCount = Array.isArray(thread.metadata['execution_bundle_ids']) ? thread.metadata['execution_bundle_ids'].length : 0;
              return (
                <div className="solution-run-card-shell" key={thread.thread_id}>
                  <button className="solution-run-card" type="button" onClick={() => selectTask(threadTaskId(thread))}>
                    <header><span><GitBranch size={15} /></span><div><small>{workflow?.label ?? 'DEVELOPMENT WORKFLOW'}</small><h3>{threadTitle(thread)}</h3></div><em className={`solution-task-state state-${status.className}`}>{status.label}</em></header>
                    <p>{threadDescription(thread) || 'No implementation brief was retained for this run.'}</p>
                    <div className="solution-run-progress"><i style={{ width: `${progress}%` }} /></div>
                    <footer><span>{current >= stages.length ? 'Completed' : stages[current]?.label ?? 'Starting'}</span><span className={testsPassed ? 'is-ok' : ''}><TestTube2 size={12} />{['ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(workflow?.id ?? '') ? 'Tests skipped' : 'Tests'}</span><span className={reviewPassed ? 'is-ok' : ''}><ShieldCheck size={12} />Review</span>{ciState && <span className={`solution-run-ci-state state-${ciState.className}`}>{ciState.label}</span>}<span>{bundleCount} bundle{bundleCount === 1 ? '' : 's'}</span><time>{timeAgo(thread.updated_at)}</time><ArrowRight size={13} /></footer>
                  </button>
                  {ciRun?.run_url && <a className="solution-run-ci-link" href={browserFacingProviderUrl(ciRun.run_url)} target="_blank" rel="noreferrer"><Network size={12} />Open {ciProviderLabel(ciRun.provider)} CI<ArrowRight size={11} /></a>}
                </div>
              );
            })}
          </div>
          <footer className="solution-run-pagination">
            <span>Showing {(runPage - 1) * RUN_PAGE_SIZE + 1}–{Math.min(runPage * RUN_PAGE_SIZE, developmentRuns.length)} of {developmentRuns.length} runs · last 7 days</span>
            {runPageCount > 1 && <nav aria-label="Development run pages">
              <button type="button" disabled={runPage === 1} onClick={() => setRunPage(page => Math.max(1, page - 1))}>Previous</button>
              {visibleRunPages.map(page => <button type="button" aria-current={page === runPage ? 'page' : undefined} className={page === runPage ? 'is-active' : ''} aria-label={`Page ${page}`} onClick={() => setRunPage(page)} key={page}>{page}</button>)}
              <button type="button" disabled={runPage === runPageCount} onClick={() => setRunPage(page => Math.min(runPageCount, page + 1))}>Next</button>
            </nav>}
          </footer>
          </>
        ) : (
          <div className="solution-runs-empty"><EmptyState title="No Argus Dev runs in the last 7 days" description="Start a governed development workflow. Older runs remain available in the global Runs area." /><button className="button button-primary" type="button" onClick={openLaunch}><Plus size={14} />Start first run</button></div>
        )}
      </section>

      <section className="panel solution-flow-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">ARGUS DEV · WORKFLOW CATALOG</span><h2>{selectedWorkflow?.label ?? 'Discovering workflows…'}</h2><p>{selectedWorkflow?.description ?? 'Loading the runtime-published workflow contract.'}</p></div>
          <span className="solution-protocol"><Network size={13} />A2A + MCP</span>
        </div>
        {catalog.isLoading ? <LoadingState label="Loading workflow catalog…" /> : catalog.error ? <ErrorState error={catalog.error} /> : (
          <>
            <div className="solution-workflow-tabs">
              {workflows.map(workflow => <button type="button" className={workflow.id === selectedWorkflow?.id ? 'is-active' : ''} onClick={() => chooseWorkflow(workflow)} key={workflow.id}><Workflow size={15} /><span><b>{workflow.label}</b><small>{workflow.stages.length} stages · {workflow.approvalGates.length} approval gate{workflow.approvalGates.length === 1 ? '' : 's'}</small></span></button>)}
            </div>
            {selectedWorkflow && <WorkflowFlow workflow={selectedWorkflow} />}
          </>
        )}
        <div className="solution-flow-note"><ShieldCheck size={14} /><span>Inputs, stages and approval gates come from the signed Pack catalog. Tool access remains constrained by Core execution bundles.</span></div>
      </section>

      <div className="solution-grid">
        <section className="panel solution-components">
          <div className="panel-heading"><div><span className="eyebrow">PACK MANIFEST</span><h2>Installed building blocks</h2></div><span>Checked {pack.checkedAt ? timeAgo(pack.checkedAt) : 'never'}</span></div>
          <div className="solution-component-grid">
            <article><Bot size={17} /><span><small>ORCHESTRATOR</small><b>{orchestrator?.id ?? 'Not declared'}</b><em>{orchestrator?.runtime ?? '—'} runtime</em></span></article>
            <article><Workflow size={17} /><span><small>WORKFLOWS</small><b>{manifest?.spec.components.workflows.length ?? 0} registered</b><em>LangGraph checkpointed</em></span></article>
            <article><Database size={17} /><span><small>KNOWLEDGE</small><b>{manifest?.spec.components.knowledgeSources[0] ?? 'Not declared'}</b><em>Core-governed RAG</em></span></article>
            <article><ShieldCheck size={17} /><span><small>POLICY</small><b>{manifest?.spec.components.policies[0] ?? 'Not declared'}</b><em>Repository writes</em></span></article>
          </div>
          <div className="solution-agent-line"><span>Core agents</span><div>{orchestrator?.coreAgents.map(agent => <code key={agent}>{agent}</code>)}</div></div>
          <div className="solution-agent-line"><span>Skills</span><div>{manifest?.spec.components.skills.map(skill => <code key={skill}>{skill}</code>)}</div></div>
        </section>

        <aside className="panel solution-runtime">
          <div className="panel-heading"><div><span className="eyebrow">RUNTIME CHECK</span><h2>Core ↔ pack boundary</h2></div></div>
          <div className="solution-checks">
            <span className={pack.health?.ok ? 'is-ok' : ''}><CircleDot size={13} /><b>Container health</b><small>{pack.health?.ok ? `${pack.health.latencyMs} ms` : 'Unavailable'}</small></span>
            <span className={pack.readiness?.ok ? 'is-ok' : ''}><CircleDot size={13} /><b>Pack readiness</b><small>{pack.readiness?.ok ? `${pack.readiness.latencyMs} ms` : 'Unavailable'}</small></span>
            <span className={manifest ? 'is-ok' : ''}><CircleDot size={13} /><b>Manifest contract</b><small>{manifest?.apiVersion ?? 'Missing'}</small></span>
          </div>
          {packDiff.data && (
            <section className="solution-reconciliation" aria-label="Solution Pack reconciliation">
              <header><div><span className="eyebrow">RECONCILIATION</span><h3>Installed contract</h3></div><code>r{packDiff.data.revision}</code></header>
              <p><span>{packDiff.data.previousVersion ?? 'first install'}</span><ArrowRight size={12} /><strong>{packDiff.data.currentVersion ?? 'unknown'}</strong></p>
              <small>{packDiff.data.changes.length === 0 ? 'No manifest changes recorded.' : `${packDiff.data.changes.length} manifest change${packDiff.data.changes.length === 1 ? '' : 's'} since the previous version.`}</small>
              {packDiff.data.rollbackAvailable && (
                <>
                  <label className="solution-reconciliation-reason"><span>Rollback reason</span><input value={rollbackReason} onChange={event => setRollbackReason(event.target.value)} minLength={8} maxLength={2000} placeholder="Why should the previous contract be restored?" /></label>
                  <button className="button button-secondary" type="button" disabled={rollback.isPending || rollbackReason.trim().length < 8} onClick={() => rollback.mutate()}><RefreshCw size={14} />{rollback.isPending ? 'Requesting rollback…' : `Request rollback to ${packDiff.data.previousVersion}`}</button>
                </>
              )}
              {rollback.error && <div className="editor-error" role="alert">{rollback.error.message}</div>}
              {rollbackRequests.data?.requests.length ? (
                <div className="solution-rollback-history" aria-label="Rollback request history">
                  <div className="solution-rollback-history-heading"><span>Recent rollback requests</span><small>{rollbackRequests.data.total}</small></div>
                  {rollbackRequests.data.requests.map(request => (
                    <article key={request.id}>
                      <header><strong className={`solution-rollback-status status-${request.status}`}>{request.status}</strong><time>{timeAgo(request.updatedAt)}</time></header>
                      <p><span>to {request.targetVersion}</span><span>by {request.requestedBy}</span></p>
                      {request.claimedBy && <small>Worker {request.claimedBy}{request.claimExpiresAt ? ` lease until ${new Date(request.claimExpiresAt).toLocaleTimeString()}` : ''}</small>}
                      {request.error && <small className="solution-rollback-error">{request.error}</small>}
                    </article>
                  ))}
                </div>
              ) : rollbackRequests.error ? <small className="solution-rollback-history-muted">Rollback history is unavailable until persistence is configured.</small> : null}
              {rollback.data && <small className="solution-reconciliation-success">Rollback request {rollback.data.rollback.status} · target {rollback.data.rollback.targetVersion}</small>}
            </section>
          )}
          <button className="button button-primary" type="button" disabled={!orchestrator || preflight.isPending || pack.state !== 'ready'} onClick={() => preflight.mutate()}><Play size={14} />{preflight.isPending ? 'Running preflight…' : 'Run A2A preflight'}</button>
          {preflight.error && <div className="editor-error" role="alert">{preflight.error.message}</div>}
          {preflight.data && <div className="solution-preflight"><CheckCircle2 size={16} /><span><b>{taskLabel(preflight.data.task.status.state)}</b><small>{String(preflightEvidence?.['engine'] ?? 'LangGraph')} · {String(preflightEvidence?.['toolTransport'] ?? 'MCP')} · trace {preflight.data.rootTraceId.slice(0, 8)}</small>{capabilityEvidence && <small className={capabilityEvidence['ok'] === true ? 'is-ok' : 'is-missing'}>Bundles: {capabilityEvidence['ok'] === true ? 'capabilities ready' : `missing ${Array.isArray(capabilityEvidence['missing']) ? capabilityEvidence['missing'].join(', ') : 'required capability'}`}</small>}</span></div>}
          <div className="solution-runtime-links"><a href="/build/agents/manage"><Bot size={13} />Configure Core agents</a><a href="/runs"><Play size={13} />Inspect executions</a></div>
        </aside>
      </div>

      {launchOpen && (
        <div className="solution-dialog-layer" role="presentation" onMouseDown={() => setLaunchOpen(false)}>
          <section className="solution-start-dialog" role="dialog" aria-modal="true" aria-label="Start Argus Dev run" onMouseDown={event => event.stopPropagation()}>
            <header><div><span className="eyebrow">DEVELOPMENT CONTROL PLANE</span><h2>{retrySource ? 'Configure retry' : 'Run Argus Dev'}</h2><p>{retrySource ? 'Review inputs, runtime and bundles before starting a new attempt. Previous approvals are not reused.' : 'Select a governed workflow and provide its runtime-published inputs.'}</p></div><button type="button" aria-label="Close development run dialog" disabled={start.isPending} onClick={() => setLaunchOpen(false)}><X size={17} /></button></header>
            <form className="solution-run-form" onSubmit={event => { event.preventDefault(); start.mutate(); }}>
              {retrySource && <section aria-label="Retry context"><p>Original run: <Link to={`/runs/workflow/${encodeURIComponent(retrySource.sourceThreadId)}`}>{retrySource.sourceThreadId}</Link>. Historical errors remain on that run, not in the task description.</p><label className="editor-field"><span>Additional feedback <em>optional</em></span><textarea rows={3} maxLength={12_000} value={retryFeedback} onChange={event => setRetryFeedback(event.target.value)} placeholder="New instructions for this attempt; do not paste credentials." /></label></section>}
              <fieldset className="solution-workflow-picker">
                <legend>Development workflow <em>required</em></legend>
                <div>{workflows.map(workflow => <label className={workflow.id === selectedWorkflow?.id ? 'is-selected' : ''} key={workflow.id}><input type="radio" name="argus-dev-workflow" checked={workflow.id === selectedWorkflow?.id} onChange={() => chooseWorkflow(workflow)} /><span><b>{workflow.label}</b><small>{workflow.description}</small><em>{workflow.stages.length} stages · {workflow.requiredAgents.length} agents</em></span></label>)}</div>
              </fieldset>
              {['ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(selectedWorkflow?.id ?? '') && <div className="solution-bundle-preflight" role="note"><strong>{selectedWorkflow?.id === 'ticket-follow-up-image-pull-request' ? 'Pinned PR follow-up' : 'Review-only image path'}</strong><p>{selectedWorkflow?.id === 'ticket-follow-up-image-pull-request' ? 'Use a completed Dev run ID and a newly reviewed ticket. Argus verifies the original PR, continues its exact commit in a fresh workspace, rebuilds through the same Jenkins job and updates the existing PR. No automated tests run; both approvals are required again.' : 'No automated tests are authored or run. The Reviewer inspects the implementation diff, a human approves the code, Jenkins builds an image from the exact pushed commit, and a second human decision gates the PR. The image is not deployed or pushed to a registry.'}</p></div>}
              <fieldset className="solution-bundle-picker">
                <legend>Execution bundles <em>required</em></legend>
                <p>Choose the repository Bundle first, then add any Code Intelligence or other required Bundles. Only tools in this selection are available to the run.</p>
                {missingSelectedBundles.length > 0 && <div className="editor-error" role="alert">Some previous bundles are no longer available: {missingSelectedBundles.map(id => <button type="button" className="button button-secondary" key={id} onClick={() => setBundleIds(ids => ids.filter(value => value !== id))}>Remove unavailable Bundle #{id}</button>)}</div>}
                {fabric.isLoading && <small>Loading backend bundles…</small>}
                {fabric.error && <div className="editor-error" role="alert">{fabric.error.message}</div>}
                <div className="solution-bundle-options">
                  {fabric.data?.bundles.map(bundle => {
                    const selected = bundleIds.includes(bundle.id);
                    const approvedForHermes = approvedHermesBundleIds.includes(bundle.id);
                    return <label className={selected ? 'is-selected' : ''} key={bundle.id}><input type="checkbox" checked={selected} onChange={() => setBundleIds(ids => selected ? ids.filter(id => id !== bundle.id) : [...ids, bundle.id])} /><span className="connection-check">{selected && <Check size={12} />}</span><span><b>{bundle.label}{approvedForHermes && <em>HERMES READ-ONLY</em>}</b><small>{bundle.toolCount} tools · {bundle.backendCount} backends</small></span></label>;
                  })}
                </div>
                {!fabric.isLoading && fabric.data?.bundles.length === 0 && <small>No bundles are available. Create a backend bundle in MCP Fabric first.</small>}
                {selectedWorkflow && requiredBundleCategories.length > 0 && (
                  <div className={`solution-bundle-preflight ${missingBundleCategories.length === 0 ? 'is-ready' : 'is-blocked'}`} role="status">
                    <header><ShieldCheck size={14} /><b>Workflow capability preflight</b><em>{missingBundleCategories.length === 0 ? 'Required capabilities present' : 'Missing required capability'}</em></header>
                    <div>{requiredBundleCategories.map(category => <span className={providedBundleCategories.has(category) ? 'is-ok' : 'is-missing'} key={category}><i>{providedBundleCategories.has(category) ? '✓' : '!'}</i>{BUNDLE_CAPABILITY_LABELS[category] ?? category}</span>)}</div>
                    {missingBundleCategories.length > 0 && <small>Select a bundle containing: {missingBundleCategories.map(category => BUNDLE_CAPABILITY_LABELS[category] ?? category).join(', ')}. The server will enforce this check too.</small>}
                    {missingBundleCategories.length === 0 && missingRecommendedCategories.length > 0 && <small>Optional for this workflow: {missingRecommendedCategories.map(category => BUNDLE_CAPABILITY_LABELS[category] ?? category).join(', ')}.</small>}
                  </div>
                )}
              </fieldset>
              {issueField && <section className="solution-issue-input" aria-label="Source issue preview" ref={issuePreviewSection} tabIndex={-1}>
                <div className="solution-issue-scope" aria-live="polite">
                  <span>Repository Bundle</span>
                  <strong>{repositoryBundleLabels.join(' · ') || 'Select a repository Bundle above'}</strong>
                  <small>{currentIssue ? `Verified repository: ${currentIssue.repository}` : 'The repository and issue-read permission are verified when you load the issue.'}</small>
                </div>
                <div className="solution-issue-controls">
                  <label className="editor-field" htmlFor="argus-dev-issue-reference"><span>{issueField.label} {issueField.required ? <em>required</em> : <em>optional</em>}</span>
                    <input id="argus-dev-issue-reference" aria-describedby="argus-dev-issue-help" required={issueField.required} maxLength={512} value={String(workflowInput['issue_reference'] ?? '')} onChange={event => setWorkflowInput(input => ({ ...input, issue_reference: event.target.value }))} placeholder="Paste the selected repository's Gitea issue URL or number" />
                  </label>
                  <button className="button button-secondary" type="button" disabled={!issueReference || issueLoading || bundleIds.length === 0 || start.isPending} onClick={() => loadIssuePreview()}>{issueLoading ? 'Loading issue…' : 'Load issue'}</button>
                </div>
                {retrySource && issueReference && !currentIssue && <p><strong>Retry: Bundles and inputs are already selected.</strong> Reload and review the source issue for this new attempt; the previous preview is historical evidence.</p>}
                <p id="argus-dev-issue-help">Read-only preview. Review the issue before starting. Changing its URL or the selected Bundles requires a new preview; this does not grant approval.</p>
                {issueError && <div className="editor-error" role="alert"><strong>Issue could not be loaded</strong><p>{issueError.message}</p><small>Check the repository Bundle above, then load again. The Bundle and your user policy must allow its read-only Gitea issue tool.</small></div>}
                {currentIssue ? <div className="solution-issue-result" aria-live="polite"><h3>#{currentIssue.number} · {currentIssue.title}</h3><p>{currentIssue.repository} · {currentIssue.state} · updated {currentIssue.updatedAt}</p><pre>{currentIssue.body}</pre><small>Snapshot SHA-256: {currentIssue.sha256} · Tool: {currentIssue.toolName}</small></div>
                  : !issueError && <p role="status">{issueLoading ? 'Reading the issue through MCP…' : issueReference ? 'Load and review this issue to enable Start.' : issueField.required ? 'Enter and load a Gitea issue before starting this workflow.' : 'Optional: load a Gitea issue, or continue with an implementation brief only.'}</p>}
              </section>}
              {workflowFields.filter(field => field.name !== 'issue_sha256' && (!issueField || field.name !== 'issue_reference')).map(field => (
                <label className="editor-field" key={field.name}>
                  <span>{field.label} {field.required && <em>required</em>}</span>
                  {field.type === 'textarea' ? <textarea required={field.required} maxLength={20_000} rows={5} value={String(workflowInput[field.name] ?? '')} onChange={event => setWorkflowInput(input => ({ ...input, [field.name]: event.target.value }))} placeholder={field.placeholder} />
                    : field.type === 'select' ? <select required={field.required} value={String(workflowInput[field.name] ?? field.defaultValue ?? '')} onChange={event => setWorkflowInput(input => ({ ...input, [field.name]: event.target.value }))}>{!field.required && <option value="">Select…</option>}{field.options?.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
                      : field.type === 'boolean' ? <input type="checkbox" checked={Boolean(workflowInput[field.name] ?? field.defaultValue ?? false)} onChange={event => setWorkflowInput(input => ({ ...input, [field.name]: event.target.checked }))} />
                        : <input required={field.required} type={field.type === 'number' ? 'number' : 'text'} min={field.min} max={field.max} maxLength={field.type === 'text' ? 512 : undefined} value={String(workflowInput[field.name] ?? '')} onChange={event => setWorkflowInput(input => ({ ...input, [field.name]: event.target.value }))} placeholder={field.placeholder} />}
                  {field.description && <small>{field.description}</small>}
                </label>
              ))}
              <fieldset className="solution-runtime-picker">
                <legend>Coder runtime <em>task-specific</em></legend>
                <p>The workflow and workspace remain owned by Argus Dev. This choice changes only the Coder runtime for this run.</p>
                <div>
                  <label className={runtimeMode === 'auto' ? 'is-selected' : ''}>
                    <input type="radio" name="argus-dev-runtime" checked={runtimeMode === 'auto'} onChange={selectAutoRuntime} />
                    <span><b>Auto <em>recommended</em></b><small>{launchRoutingPreflight.isFetching ? 'Core is checking the live runtime route…' : launchRoutingSelection ? `${runtimeModeLabel(launchRoutingSelection.effectiveMode)}: ${RUNTIME_SELECTION_REASONS[launchRoutingSelection.reason]}` : autoUsesManagedHermes ? 'Managed Hermes: this workflow declares a Coder workspace-write stage.' : autoWorkflowNeedsCoder ? 'Agent default: Managed Hermes is not ready.' : 'Agent default: this workflow has no managed Coder stage.'}</small></span>
                  </label>
                  <label className={runtimeMode === 'default' ? 'is-selected' : ''}>
                    <input type="radio" name="argus-dev-runtime" checked={runtimeMode === 'default'} onChange={() => setRuntimeMode('default')} />
                    <span><b>Agent default</b><small>Use the Coder's configured runtime and preserve the normal Argus Dev path.</small></span>
                  </label>
                  {hermesPackConnected && (
                    <label className={runtimeMode === 'managed-hermes' ? 'is-selected' : ''}>
                      <input type="radio" name="argus-dev-runtime" checked={runtimeMode === 'managed-hermes'} disabled={!launchHermesRuntime.data?.managed.ready} onChange={selectManagedHermes} />
                      <span><b>Managed Hermes</b><small>{launchHermesRuntime.isLoading ? 'Checking isolated runtime readinessâ€¦' : launchHermesRuntime.data?.managed.detail ?? 'Managed Hermes readiness is unavailable.'}</small></span>
                    </label>
                  )}
                </div>
                {usesManagedHermes && hermesPackConnected && !managedHermesBundleReady && <small className="is-missing">Select at least one operator-approved read-only Bundle for the Hermes worker.</small>}
                {usesManagedHermes && selectedHermesBundleLabels.length > 0 && <small className="is-ok">Hermes read-only scope added automatically: {selectedHermesBundleLabels.join(', ')}.</small>}
              </fieldset>
              <section className={`solution-launch-routing ${launchRoutingSelection ? `is-${launchRoutingSelection.effectiveMode}` : ''}`} aria-label="Core launch runtime routing" role="status">
                {launchRoutingPreflight.isFetching ? <><LoaderCircle className="spin" size={15} /><span><b>Checking live Core route</b><small>Verifying runtime health and the selected execution scope.</small></span></> : launchRoutingPreflight.error ? <><CircleDot size={15} /><span><b>{launchOperationalIssues.length > 0 ? 'Execution scope needs attention' : 'Routing preview unavailable'}</b><small>{launchRoutingPreflight.error.message}{launchOperationalIssues.length === 0 ? ' Start will retry the governed preflight.' : ''}</small>{launchCatalogIssues.length > 0 && <span className="solution-launch-routing-actions">{launchCatalogIssues.map(issue => <Link key={`${issue.backendId ?? 'backend'}-${issue.backendName}`} to={`/mcp-fabric?server=${encodeURIComponent(issue.backendName)}&returnTo=${encodeURIComponent(`/solutions/${packId}`)}#connections`}>Review {issue.backendName} catalog <ArrowRight size={11} /></Link>)}</span>}</span></> : launchRoutingSelection ? <><ShieldCheck size={15} /><span><b>{runtimeModeLabel(launchRoutingSelection.requestedMode)} <ArrowRight size={11} /> {runtimeModeLabel(launchRoutingSelection.effectiveMode)}</b><small>{RUNTIME_SELECTION_REASONS[launchRoutingSelection.reason]} · trace {launchRoutingPreflight.data!.rootTraceId.slice(0, 8)}</small></span></> : <><CircleDot size={15} /><span><b>Waiting for runtime selection</b><small>Choose the workflow, runtime and required Bundles.</small></span></>}
              </section>
              {launchRoutingPreflight.data && !launchRoutingReadiness.ready && !start.error && <div className="editor-error" role="alert">{launchRoutingReadiness.blockers.join('; ') || 'The governed runtime preflight is not ready.'}</div>}
              {start.error && <div className="editor-error" role="alert">{start.error.message}</div>}
              {launchBlockers.length > 0 && <section className="solution-start-requirements" id="argus-dev-start-requirements" role="status" aria-label="Start requirements"><strong>Before you can start</strong><ul>{launchBlockers.map(reason => <li key={reason}>{reason}</li>)}</ul>
                {issueField && !issueReady && <button type="button" className="button button-secondary" disabled={issueLoading || bundleIds.length === 0 || start.isPending} onClick={() => loadIssuePreview(true)}>{issueLoading ? 'Loading source issue…' : 'Load issue preview'}<ArrowRight size={14} /></button>}
              </section>}
              <footer><button className="button button-secondary" type="button" onClick={() => setLaunchOpen(false)}>Cancel</button><button className="button button-primary" type="submit" aria-describedby={launchBlockers.length > 0 ? 'argus-dev-start-requirements' : undefined} disabled={launchBlockers.length > 0}><Play size={15} />{start.isPending ? 'Starting governed task…' : retrySource ? 'Start new attempt' : `Start ${selectedWorkflow?.label ?? 'workflow'}`}</button></footer>
            </form>
          </section>
        </div>
      )}

      {selectedTaskId && !launchOpen && (
        <div className="solution-dialog-layer" role="presentation" onMouseDown={() => selectTask('')}>
          <section className="solution-run-detail-dialog" role="dialog" aria-modal="true" aria-label={`Argus Dev run ${selectedTicket}`} onMouseDown={event => event.stopPropagation()}>
            <header><div><span className="eyebrow">ARGUS DEV · RUN EVIDENCE</span><h2>{selectedTicket}</h2>
              {selectedThread ? threadDescription(selectedThread) && <details className="solution-run-instructions" key={selectedTaskId}>
                <summary>Run instructions</summary>
                <div className="solution-run-instructions-body" tabIndex={0} aria-label="Full run instructions">{threadDescription(selectedThread).split(/(\r?\n[ \t]*\r?\n)/).map((part, index) => index % 2 === 0 ? <p key={index}>{part}</p> : part)}</div>
              </details> : <p>Loading persisted A2A task evidence…</p>}
            </div>{task && <em className={`solution-task-state state-${taskLabel(taskState).replaceAll(' ', '-')}`}>{taskState === 'TASK_STATE_WORKING' && <LoaderCircle className="spin" size={13} />}{canceling ? 'Canceling' : inputRequired && developmentDecision?.responseFailure ? 'Agent response error' : taskLabel(taskState)}</em>}<button type="button" aria-label="Close run details" onClick={() => selectTask('')}><X size={17} /></button></header>
            <div className="solution-run-detail-body">
              {(taskQuery.isLoading || codingThreadQuery.isLoading) && !task ? <LoadingState label="Loading run evidence…" /> : taskError ? <ErrorState error={taskError} /> : task ? (
                <>
                  <div className="solution-task-meta">
                    <span><small>{usingCodingThreadEvidence ? 'LANGGRAPH THREAD' : 'A2A TASK'}</small><code>{task.id}</code></span>
                    <span><small>WORKFLOW THREAD</small><code>{workflowThreadId || 'starting…'}</code></span>
                    <span><small>{detailWorkflow?.id === 'backlog-grooming' ? 'REVISION COUNTER' : 'RETRIES'}</small><code>{codingEvidence.retryCount ?? 0}</code></span>
                    <span><small>CODER RUNTIME</small><code>{effectiveExecutionRuntimeLabel}</code></span>
                    {traceId && <a href={`/runs/workflow/${encodeURIComponent(traceId)}`}><Network size={13} />Open trace</a>}
                  </div>
                  {taskState === 'TASK_STATE_COMPLETED' && codingEvidence.prUrl && codingEvidence.ciRun?.status === 'success' && (
                    <section className="solution-golden-path-complete" aria-label="Golden path completion evidence">
                      <header><CheckCircle2 size={22} /><div><span className="eyebrow">GOLDEN PATH COMPLETE</span><h3>Review-ready delivery assembled</h3><p>Ticket, governed implementation, human gates, provider build and pull request are bound to one run.</p></div><em>complete</em></header>
                      <div className="solution-golden-path-facts">
                        {codingEvidence.sourceIssue?.url && <a href={browserFacingProviderUrl(codingEvidence.sourceIssue.url)} target="_blank" rel="noreferrer"><small>SOURCE ISSUE</small><b>#{codingEvidence.sourceIssue.number}</b><span>{codingEvidence.sourceIssue.title}</span></a>}
                        <span><small>DELIVERED COMMIT</small><code title={codingEvidence.ciRun.commit_sha}>{codingEvidence.ciRun.commit_sha?.slice(0, 12) || 'not recorded'}</code><span>{codingEvidence.ciRun.branch || 'branch not recorded'}</span></span>
                        {codingEvidence.ciRun.run_url && <a href={browserFacingProviderUrl(codingEvidence.ciRun.run_url)} target="_blank" rel="noreferrer" aria-label="Open completed CI build"><small>PROVIDER BUILD</small><b>{ciProviderLabel(codingEvidence.ciRun.provider)}{codingEvidence.ciRun.external_id ? ` #${codingEvidence.ciRun.external_id}` : ''}</b><span>passed</span></a>}
                        <a href={browserFacingProviderUrl(codingEvidence.prUrl)} target="_blank" rel="noreferrer" aria-label="Open completed pull request"><small>PULL REQUEST</small><b>Open delivery</b><span>ready for review</span></a>
                      </div>
                      <footer><span><ShieldCheck size={13} />{Number(codingEvidence.humanApproved) + Number(codingEvidence.prApproved)}/2 human approvals recorded</span><span><TestTube2 size={13} />{codingEvidence.verificationMode === 'review-only-image' ? 'Image build only · automated tests intentionally skipped' : codingEvidence.testsPassed ? 'Automated tests passed' : 'Test result not recorded'}</span></footer>
                    </section>
                  )}
                  {runtimeSelection && (
                    <section className={`solution-runtime-decision is-${runtimeSelection.effectiveMode}`} aria-label="Core runtime routing decision">
                      <div><span className="eyebrow">CORE RUNTIME ROUTING</span><strong>{runtimeModeLabel(runtimeSelection.requestedMode)} <ArrowRight size={12} /> {runtimeModeLabel(runtimeSelection.effectiveMode)}</strong></div>
                      <p>{RUNTIME_SELECTION_REASONS[runtimeSelection.reason]}</p>
                      <code>{runtimeSelection.workflowId}</code>
                    </section>
                  )}
                  {selectedBundleLabels.length > 0 && <div className="solution-detail-bundles"><span>Execution scope</span>{selectedBundleLabels.map(label => <code key={label}>{label}</code>)}</div>}
                  {(() => {
                    const checkpoint = (codingThreadQuery.data ?? selectedThread)?.metadata?.['follow_up_checkpoint'];
                    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return null;
                    const source = checkpoint as Record<string, unknown>;
                    return <div className="solution-detail-bundles"><span>Continues checkpoint</span><Link to={`/runs/workflow/${encodeURIComponent(String(source['sourceThreadId'] ?? ''))}`}>Source run</Link><code>{String(source['commitSha'] ?? '').slice(0, 12)}</code></div>;
                  })()}
                  {(codingThreadQuery.data ?? selectedThread)?.status === 'completed' && workflowThreadId
                    && ['ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(detailWorkflow?.id ?? '')
                    && Boolean((codingThreadQuery.data ?? selectedThread)?.values?.['pr_url']) && <button className="button button-primary" type="button" onClick={() => {
                      const followUp = workflows.find(workflow => workflow.id === 'ticket-follow-up-image-pull-request');
                      if (!followUp) return;
                      setWorkflowId(followUp.id);
                      setWorkflowInput({ ...initialWorkflowInput(followUp), source_thread_id: workflowThreadId, ci_provider: 'jenkins' });
                      setBundleIds([...selectedBundleIds]); setInitializedBundles(true); setRetrySource(null); setRetryFeedback('');
                      start.reset(); setLaunchOpen(true);
                    }}>Create follow-up ticket on this PR</button>}
                  {checkpointThreadId && <section className="solution-run-instructions" aria-label="Checkpoint history">
                    <button className="button button-secondary" type="button" onClick={() => setShowCheckpointHistory(value => !value)}>
                      {showCheckpointHistory ? 'Hide checkpoints' : 'Show checkpoints'}
                    </button>
                    {showCheckpointHistory && (checkpointHistory.isLoading ? <p>Loading persisted checkpoints…</p>
                      : checkpointHistory.error ? <p role="alert">Checkpoint history is unavailable: {checkpointHistory.error.message}</p>
                        : <><p>{checkpointHistory.data?.checkpoints.length ?? 0} recent checkpoints. Prior steps are retained; a follow-up starts a new run.</p>
                          <ol>{checkpointHistory.data?.checkpoints.map((checkpoint, index) => <li key={checkpoint.checkpointId ?? index}>
                            <code title={checkpoint.checkpointId ?? undefined}>{checkpoint.checkpointId?.slice(0, 12) ?? 'pending'}</code>
                            {checkpoint.parentCheckpointId && <> · parent <code title={checkpoint.parentCheckpointId}>{checkpoint.parentCheckpointId.slice(0, 12)}</code></>}
                            {' · '}{checkpoint.nodes.join(', ') || checkpoint.next.join(', ') || 'input'}
                            {checkpoint.interrupted ? ' · waiting for input' : ''}
                            {checkpoint.createdAt ? ` · ${new Date(checkpoint.createdAt).toLocaleString()}` : ''}
                          </li>)}</ol></>)}
                  </section>}
                  {detailWorkflow && <div className="solution-detail-flow"><WorkflowFlow task={task} workflow={detailWorkflow} /></div>}
                  {codingProgress && (
                    <section className={`solution-review-decision tone-${codingProgress.tone}`} aria-label="Development progress">
                      <header><div><span className="eyebrow">TESTS & CODE REVIEW</span><h3>{codingProgress.title}</h3></div><span>{codingProgress.count}</span></header>
                      <p role="status">{codingProgress.detail}</p>
                      <p>{codingProgress.checks}</p><small>{codingProgress.policy}</small>
                      {codingProgress.latest?.reviewer && <details open={codingProgress.latest.reviewer.verdict === 'REQUEST_CHANGES'}><summary>Latest reviewer findings</summary><p>{codingProgress.latest.reviewer.summary}</p><ul>{codingProgress.latest.reviewer.requiredChanges.map((change, index) => <li key={index}>{change}</li>)}</ul></details>}
                    </section>
                  )}
                  {backlogReview && (
                    <section className={`solution-review-decision tone-${backlogReview.tone}`} aria-label="Backlog review decision">
                      <header><div><span className="eyebrow">PLAN QUALITY REVIEW</span><h3>{backlogReview.title}</h3></div><span>{backlogReview.roundLabel}</span></header>
                      <p role="status">{backlogReview.detail}</p>
                      <small>Last review: {backlogReview.decision}. {backlogReview.policy}</small>
                      <details open={codingEvidence.reviewPassed !== true}><summary>Reviewer findings</summary><pre>{codingEvidence.review}</pre></details>
                    </section>
                  )}
                  {humanChangeRequest && humanChangeState && (
                    <section className="solution-human-change-request" aria-label="Human change request">
                      <header>
                        <div><span className="eyebrow">HUMAN INPUT</span><h3>Change request</h3></div>
                        <em className={`state-${humanChangeState.className}`}>{humanChangeState.label}</em>
                      </header>
                      <blockquote>{humanChangeRequest}</blockquote>
                      {humanChangeThread?.updated_at && <small>Last updated {new Date(humanChangeThread.updated_at).toLocaleString()}</small>}
                      <div>
                        {changeRequestCoderHref && <a href={changeRequestCoderHref}><Bot size={12} />Coder activity<ArrowRight size={11} /></a>}
                        {changeRequestReviewerHref && <a href={changeRequestReviewerHref}><ShieldCheck size={12} />Reviewer activity<ArrowRight size={11} /></a>}
                        {!changeRequestCoderHref && !changeRequestReviewerHref && <span>Persisted in workflow trace</span>}
                      </div>
                    </section>
                  )}
                  {detailWorkflow?.id === 'release-notes' && releaseNotes && (
                    <section className="solution-human-change-request" aria-label="Release notes evidence">
                      <header>
                        <div><span className="eyebrow">RELEASE EVIDENCE</span><h3>{codingEvidence.releaseVersion || 'Release notes'}</h3></div>
                        <em className={codingEvidence.releaseCompleted ? 'state-success' : 'state-warning'}>{codingEvidence.releaseCompleted ? 'handoff ready' : 'draft'}</em>
                      </header>
                      <pre>{releaseNotes}</pre>
                    </section>
                  )}
                  {detailWorkflow?.id === 'backlog-grooming' && backlogTasks && (
                    <section className="solution-human-change-request" aria-label="Backlog Planning evidence">
                      <header>
                        <div><span className="eyebrow">IMPLEMENTATION HANDOFF</span><h3>{codingEvidence.issueTitle || codingEvidence.backlogId || 'Backlog plan'}</h3></div>
                        <em className={codingEvidence.backlogCompleted ? 'state-success' : 'state-warning'}>{codingEvidence.backlogCompleted ? 'handoff ready' : 'draft'}</em>
                      </header>
                      <pre>{backlogTasks}</pre>
                      {codingEvidence.backlogCompleted && codingEvidence.humanApproved && workflowThreadId && <button className="button button-primary" type="button" onClick={() => {
                        const dev = workflows.find(workflow => workflow.id === 'ticket-to-pull-request');
                        if (!dev) return;
                        setWorkflowId(dev.id);
                        setWorkflowInput({ ...initialWorkflowInput(dev), planning_thread_id: workflowThreadId,
                          description: 'Implement only the first independently testable slice from the verified planning handoff. Develop matching automated tests; preserve all out-of-scope code and tests.' });
                        setBundleIds([...selectedBundleIds]); setInitializedBundles(true); setRetrySource(null); setRetryFeedback(''); start.reset(); setLaunchOpen(true);
                      }}>Configure Dev run from this plan</button>}
                    </section>
                  )}
                  {selectedThread?.error && (
                    <div className="solution-run-error" role="alert">
                      <span><strong>Workflow stopped:</strong> {selectedThread.error}</span>
                      <div>
                        {traceId && <a href={`/runs/workflow/${encodeURIComponent(traceId)}`}><Network size={12} />Trace details</a>}
                        {traceId && <a href={`/observe/logs?root_trace=${encodeURIComponent(traceId)}`}><Database size={12} />Correlated logs</a>}
                      </div>
                    </div>
                  )}
                  {taskState === 'TASK_STATE_FAILED' && !canceling && (codingThreadQuery.data ?? selectedThread)?.status === 'failed' && retryThreadId && (
                    <section className="solution-retry-panel" aria-label="Retry workflow with feedback">
                      <div><RefreshCw size={17} /><span><small>RETRY OPTIONS</small><b>Retry this workflow</b><p>Continue a verified failed checkpoint, or configure a new attempt from the beginning. Previous attempt and Agent results remain in the run history.</p></span></div>
                      <CheckpointRetryActions key={retryThreadId} threadId={retryThreadId} canConfigure={Boolean(detailWorkflow && (codingThreadQuery.data ?? selectedThread))} configure={configureRetry}
                        onContinued={async () => { await Promise.all([taskQuery.refetch(), codingThreadQuery.refetch(), queryClient.invalidateQueries({ queryKey: ['argus-dev-runs'] })]); }} />
                    </section>
                  )}
                  {taskState === 'TASK_STATE_CANCELED' && (codingThreadQuery.data ?? selectedThread)?.status === 'canceled' && retryThreadId && (
                    <section className="solution-retry-panel" aria-label="Restart canceled workflow">
                      <div><RefreshCw size={17} /><span><small>NEW RUN</small><b>Restart after cancellation</b><p>Reuse inputs and Bundles in a new configurable run from the beginning. Fresh permissions and approvals are required; the canceled run stays unchanged.</p></span></div>
                      <button className="button button-primary" type="button" disabled={!detailWorkflow} onClick={configureRetry}>Configure new run</button>
                    </section>
                  )}
                  {inputRequired && !canceling && retryThreadId && (codingThreadQuery.data ?? selectedThread)?.status === 'interrupted'
                    && (codingEvidence.workflowBlockers ?? []).some(item => typeof item === 'string' && item.startsWith('[codegen_source_changed] ')) && (
                    <section className="solution-retry-panel" aria-label="Recover generated-file import">
                      <div><RefreshCw size={17} /><span><small>IMPORT RECOVERY</small><b>Keep completed work</b><p>Check whether the completed generator output can be safely imported. Preview does not start a workflow or grant approval.</p></span></div>
                      <CheckpointRetryActions key={`import-${retryThreadId}`} threadId={retryThreadId} recoveryOnly canConfigure={false} configure={() => {}}
                        onContinued={async () => { await Promise.all([taskQuery.refetch(), codingThreadQuery.refetch(), queryClient.invalidateQueries({ queryKey: ['argus-dev-runs'] })]); }} />
                    </section>
                  )}
                  <RevisionHistory revisions={revisionHistory} runActive={!terminal && !canceling} />
                  {typeof selectedThread?.metadata['retry_of'] === 'string' && <p>New attempt of <Link to={`/runs/workflow/${encodeURIComponent(selectedThread.metadata['retry_of'])}`}>the original run</Link>. Approvals belong to this attempt only.</p>}
                  <section className="solution-agent-results">
                    <header>
                      <div><span className="eyebrow">WORKFLOW ACTIVITY</span><h3>Agents, tests & approvals</h3><p>Cards name the workflow task; the agent and runtime appear below. Attempts count per task, not per agent. Completed planning is not a passed test or code-review approval.</p></div>
                      <b>{activityExecutions.length + (inputRequired ? 1 : 0) + (codingEvidence.humanApproved ? 1 : 0) + (codingEvidence.prApproved ? 1 : 0)}</b>
                    </header>
                    {runDetail.error && <div className="editor-error" role="alert">Live trace results could not be loaded: {runDetail.error.message}. Persisted workflow evidence remains available below.</div>}
                    {runDetail.isLoading && activityExecutions.length === 0 ? <LoadingState label="Loading workflow activity…" /> : activityExecutions.length > 0 ? (
                      <div className="solution-agent-result-list">
                        {activityExecutions.map((execution, index) => {
                          const tools = runDetail.data?.traceFamily?.spans.filter(span => span.traceId === execution.id && span.kind === 'tool') ?? [];
                          const display = activityDisplay(execution);
                          const sameAgentAttempt = activityExecutions.slice(0, index + 1).filter(item => activityDisplay(item).title === display.title).length;
                          const sameAgentTotal = activityExecutions.filter(item => activityDisplay(item).title === display.title).length;
                          const ActivityIcon = ['test','qa-execution','generator'].includes(activityRole(execution) ?? '') ? TestTube2 : Bot;
                          const reviewVerdict = activityRole(execution) === 'review'
                            && (execution.status === 'completed' || execution.retainedStageEvidence)
                            ? execution.reviewVerdict ?? reviewOutcome(execution.outputPreview) : null;
                          const statusLabel = reviewVerdict === 'changes-requested' ? 'Changes requested'
                            : reviewVerdict === 'approved' ? 'Review passed'
                              : activityRole(execution) === 'review' && execution.status === 'completed' ? 'Execution completed · verdict unavailable'
                                : activityRole(execution) === 'qa-design' && execution.status === 'completed' ? 'QA design completed'
                                  : activityRole(execution) === 'code' && execution.status === 'completed' ? 'Implementation completed' : execution.status;
                          return (
                            <details className={`solution-agent-result state-${execution.status}${reviewVerdict ? ` review-${reviewVerdict}` : ''}`} open={execution.status === 'running'} key={execution.id}>
                              <summary>
                                <span><ActivityIcon size={15} /></span>
                                <div><b>{display.title}{sameAgentTotal > 1 ? ` · attempt ${sameAgentAttempt}` : ''}</b><small>{display.subtitle}</small></div>
                                <em>{statusLabel}</em>
                                <time>{execution.retainedStageEvidence ? 'retained' : execution.durationMs == null ? execution.status === 'running' ? 'running' : '—' : `${(execution.durationMs / 1000).toFixed(1)} s`}</time>
                                {execution.href && <a className="solution-agent-run-link" href={execution.href} onClick={event => event.stopPropagation()}><Network size={12} />Run</a>}
                              </summary>
                              <div>
                                {activityRole(execution) === 'qa-design' && <p className="solution-review-execution-note">Independent test design by the Reviewer agent before implementation. This is not a code-review verdict.</p>}
                                {['qa-tests','qa-execution','environment','environment-repair','generator-plan','generator-repair','generator'].includes(activityRole(execution) ?? '') && <p className="solution-review-execution-note">{display.title}. This is a separate workflow task, not a code-review attempt or human approval.</p>}
                                {activityRole(execution) === 'agent-task' && <p className="solution-review-execution-note">The exact workflow task could not be bound to this trace. The agent name alone does not prove a code review or QA result.</p>}
                                {activityRole(execution) === 'code' && <p className="solution-review-execution-note">Implementation execution only. Test results, code-review verdict and human approvals are recorded separately.</p>}
                                {activityRole(execution) === 'review' && <p className="solution-review-execution-note">{execution.retainedStageEvidence ? 'Retained review evidence.' : `Agent execution: ${execution.status}.`} Review outcome and human approval are separate.</p>}
                                {tools.length > 0 && <section><small>TOOLS</small><p>{tools.map(tool => <code className={`state-${tool.status}`} key={tool.id}>{tool.toolName ?? tool.name}</code>)}</p></section>}
                                {activityRole(execution) === 'test' && !execution.phaseActivity && (codingEvidence.testProfiles?.length ?? 0) > 0 && <section><small>PROJECT PROFILES</small><p>{codingEvidence.testProfiles!.map(profile => <code className={profile.passed ? 'state-completed' : 'state-failed'} key={profile.id}>{profile.runner} · {profile.root}</code>)}</p></section>}
                                <section><small>OUTPUT</small><pre>{execution.error || execution.outputPreview || (execution.status === 'running' ? 'Agent is still working…' : 'No result preview was retained.')}</pre></section>
                                {execution.href && <a href={execution.href}>Open full agent trace <ArrowRight size={12} /></a>}
                              </div>
                            </details>
                          );
                        })}
                      </div>
                    ) : <p className="solution-agent-results-empty">Workflow activity will appear here as soon as an agent or test stage starts.</p>}
                    {(codingEvidence.humanApproved || codingEvidence.prApproved) && (
                      <div className="solution-approval-history" aria-label="Completed human approvals">
                        {codingEvidence.humanApproved && <article><span><Check size={14} /></span><div><b>{detailWorkflow?.id === 'backlog-grooming' ? 'Plan handoff approval' : 'Code approval'}</b><small>Approved by a human reviewer</small></div><em>approved</em></article>}
                        {codingEvidence.prApproved && <article><span><Check size={14} /></span><div><b>Functional approval</b><small>Approved by a human reviewer</small></div><em>approved</em></article>}
                      </div>
                    )}
                    {codingEvidence.sourceIssue && <details className="solution-approval-context"><summary>Source issue #{codingEvidence.sourceIssue.number}: {codingEvidence.sourceIssue.title}</summary><p>{codingEvidence.sourceIssue.repository} · frozen at {codingEvidence.sourceIssue.fetchedAt}</p><pre>{codingEvidence.sourceIssue.body}</pre><small>SHA-256: {codingEvidence.sourceIssue.sha256} · MCP tool: {codingEvidence.sourceIssue.toolName}</small></details>}
                    {codingEvidence.qaTestPlan && <details className="solution-approval-context"><summary>Independent QA test design</summary><pre>{codingEvidence.qaTestPlan}</pre></details>}
                    <TechnicalExperimentEvidence evidence={codingEvidence.technicalExperiment} />
                    <QaAcceptanceEvidence evidence={codingEvidence.qaAcceptance} />
                    {approvalRecovery.data?.available && approvalRecovery.data.checkpointId && (
                      <section className="solution-approval-gate solution-agent-approval" aria-label="Recorded approval recovery">
                        <div><ShieldCheck size={18} /><span><small>RECORDED DECISION · DISPATCH RECOVERY</small>
                          <b>{approvalRecovery.data.approved ? 'Approval recorded; continuation pending' : 'Change request recorded; continuation pending'}</b>
                          <p>The original human decision is already in the audit trail. Resume only this unchanged checkpoint without repeating earlier Agent work or voting again. A recorded change request may start its requested revision. If the checkpoint or permission changed, Argus stops.</p>
                        </span></div>
                        <footer><button className="button button-primary" type="button" disabled={recoverApproval.isPending}
                          onClick={() => recoverApproval.mutate(approvalRecovery.data!.checkpointId!)}>
                          <RefreshCw size={14} /> Resume recorded decision</button></footer>
                        {recoverApproval.error && <div className="editor-error" role="alert">{recoverApproval.error.message}</div>}
                      </section>
                    )}
                    {inputRequired && requirementsNeeded && versionedDecision && (developmentDecision
                      ? <DevelopmentDecisionCard key={developmentDecision.id} decision={developmentDecision}
                          pending={clarify.isPending || !workflowThreadId} error={clarify.error?.message} onSubmit={reply => clarify.mutate(reply)} />
                      : <p role="alert">The current decision is unavailable. Reload before answering; no approval can resolve this stop.</p>)}
                    {inputRequired && requirementsNeeded && workflowThreadId && developmentDecision?.responseFailure?.phase === 'qa' && !developmentDecision.canClarify && (
                      <QaResponseRecovery key={`${workflowThreadId}:${developmentDecision.id}`} threadId={workflowThreadId} allowFreshRetry={!codingEvidence.qaAcceptance} failureCategory={developmentDecision.responseFailure.category}
                        onContinued={async () => { await Promise.all([taskQuery.refetch(), codingThreadQuery.refetch(), queryClient.invalidateQueries({ queryKey: ['argus-dev-runs'] })]); }} />
                    )}
                    {inputRequired && requirementsNeeded && !versionedDecision && (
                      <section className="solution-approval-gate solution-agent-approval" aria-label="Requirements clarification">
                        <div><span><small>INPUT REQUIRED — NOT AN APPROVAL</small><b>Resolve prerequisites</b><p>Clarify missing requirements or explain an environment repair. Bundles, file scope and approval gates remain unchanged. For a scope change, cancel and configure a new run.</p></span></div>
                        <ul>{(codingEvidence.workflowBlockers ?? []).map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>
                        <label className="editor-field"><span>Clarification</span><textarea required rows={5} maxLength={12000} value={requirementsText} onChange={event => setRequirementsText(event.target.value)} /></label>
                        <footer><button className="button button-primary" type="button" disabled={clarify.isPending || !requirementsText.trim() || !workflowThreadId} onClick={() => clarify.mutate(undefined)}>Submit clarification & re-plan</button></footer>
                        {clarify.error && <div className="editor-error" role="alert">{clarify.error.message}</div>}
                      </section>
                    )}
                    {inputRequired && !requirementsNeeded && !approvalRecovery.data?.available && (
                      <section className="solution-approval-gate solution-agent-approval">
                        {versionedDecision && ['ticket-to-pull-request', 'ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(detailWorkflow?.id ?? '') && <div className="solution-approval-context" aria-label="Decision evidence summary"><span>
                          <b>{codingEvidence.humanApproved ? 'This decision allows pull-request creation only.' : codingEvidence.verificationMode === 'review-only-image' ? 'This decision allows commit/push and the Jenkins image build only.' : 'This decision allows commit/push and the configured CI checks.'}</b>
                          <p>No merge, deployment or additional permissions are approved here.</p>
                          <p>Tests: {codingEvidence.verificationMode === 'review-only-image' ? 'intentionally skipped' : codingEvidence.testsPassed === true ? 'passed' : 'not verified as passed'} · Code review: {codingEvidence.reviewPassed === true ? 'passed' : 'not verified as passed'} · Changed files: {diffItems.length}.</p>
                          {codingEvidence.humanApproved && <p>CI: {codingEvidence.ciRun?.status ?? 'no provider result recorded'} · Commit: {codingEvidence.ciRun?.commit_sha || 'not recorded'}.</p>}
                        </span></div>}
                        <div><ShieldCheck size={18} /><span><small>HUMAN-IN-THE-LOOP</small><b>{approvalStage} required</b><p>{detailWorkflow?.id === 'backlog-grooming' ? 'Approve this reviewed plan for handoff only. Implementation, CI and pull-request actions require their own workflow and approvals.' : detailWorkflow?.id === 'pull-request-review' ? 'Review the PR inspection, scoped test result and reviewer recommendation before creating a release handoff.' : codingEvidence.verificationMode === 'review-only-image' ? codingEvidence.humanApproved ? 'Inspect the Jenkins image receipt for this exact commit before allowing pull-request creation. Automated tests were skipped.' : 'Review the changed code against the ticket. Automated tests were skipped; approval permits commit and push only.' : codingEvidence.humanApproved ? 'Validate the built branch in its target environment before allowing pull-request creation.' : 'Review the agent results, code changes and test evidence before continuing.'}</p></span></div>
                        {(approvalMessage || approvalPlan || approvalReview) && <div className="solution-approval-context"><span><b>{approvalMessage || 'Human approval is required before this workflow can continue.'}</b></span>{approvalPlan && <details><summary>Planner evidence</summary><pre>{approvalPlan}</pre></details>}{approvalReview && <details open><summary>Reviewer evidence</summary><pre>{approvalReview}</pre></details>}</div>}
                        <label className="editor-field"><span>Decision rationale / requested changes <em>required</em></span><textarea required rows={3} value={rationale} onChange={event => setRationale(event.target.value)} placeholder="Explain the approval or list the implementation changes the agents must make." /></label>
                        <footer><button className="button button-danger" type="button" disabled={decision.isPending || !rationale.trim()} onClick={() => decision.mutate(false)}><X size={14} />Request changes</button><button className="button button-primary" type="button" disabled={decision.isPending || !rationale.trim() || !workflowThreadId} onClick={() => decision.mutate(true)}><Check size={14} />Approve & continue</button></footer>
                        {decision.error && <div className="editor-error" role="alert">{decision.error.message}</div>}
                      </section>
                    )}
                  </section>
                  {codingEvidence.ciRun && (
                    <section className="solution-ci-evidence" aria-label="External CI/CD evidence">
                      <div><span className="eyebrow">EXTERNAL CI/CD</span><h3>Pipeline handoff</h3><p>{detailCiState?.className === 'failed' ? 'The provider reported a failed run. Review the external evidence and retry with feedback when ready.' : detailCiState?.className === 'success' ? 'The provider passed the branch checks. The workflow is ready for its next approval gate.' : 'Argus pushed the branch; the configured provider owns build, test and deployment execution.'}</p></div>
                      <div className="solution-ci-facts">
                        <span><small>PROVIDER</small><b>{codingEvidence.ciRun.provider}</b></span>
                        <span><small>ARGUS LIFECYCLE</small><b className={`state-${detailCiState?.className ?? 'working'}`}>{detailCiState?.label ?? codingEvidence.deliveryStatus ?? codingEvidence.ciRun.status}</b></span>
                        <span><small>PROVIDER STATUS</small><b className={`state-${codingEvidence.ciRun.status}`}>{codingEvidence.ciRun.status}</b></span>
                        <span><small>BRANCH</small><code>{codingEvidence.ciRun.branch || '—'}</code></span>
                        {codingEvidence.ciRun.run_url && <a href={browserFacingProviderUrl(codingEvidence.ciRun.run_url)} target="_blank" rel="noreferrer">Open CI/CD run <ArrowRight size={12} /></a>}
                        {codingEvidence.prUrl && <a href={browserFacingProviderUrl(codingEvidence.prUrl)} target="_blank" rel="noreferrer">Open pull request <ArrowRight size={12} /></a>}
                      </div>
                    </section>
                  )}
                  {diffItems.length > 0 && <DiffViewer items={diffItems} />}
                  {changedFiles.length > 0 && <div className="solution-changed-files"><span><FileCode2 size={14} />Changed files</span><div>{changedFiles.map(file => <code key={file}>{file}</code>)}</div></div>}
                  {!terminal && !inputRequired && <div className="solution-live-note" role="status"><LoaderCircle className="spin" size={14} /><span>{canceling ? 'Cancellation requested. Stopping the active runtime; waiting for any non-interruptible operation to finish. No further workflow steps will start.' : 'Polling signed A2A task evidence every two seconds.'}</span></div>}
                  {!terminal && <button className="button button-secondary solution-cancel-task" type="button" disabled={cancel.isPending || canceling} onClick={() => cancel.mutate()}><Square size={13} />{cancel.isPending || canceling ? 'Canceling…' : 'Cancel task'}</button>}
                  {cancel.error && <div className="editor-error" role="alert">{cancel.error.message}</div>}
                </>
              ) : <EmptyState title="Run evidence is unavailable" description="The persisted A2A task could not be resolved from this solution pack." />}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function SolutionPackPage() {
  const { packId = 'argus.dev' } = useParams<{ packId?: string }>();
  if (packId === 'argus.dev') return <ArgusDevSolutionPackPage />;
  if (packId === 'argus.aiops') return <AiOpsSolutionPackPage packId={packId} />;
  if (packId === 'argus.hermes') return <HermesSolutionPackPage packId={packId} />;
  return (
    <EmptyState
      title="Unknown Solution Pack"
      description={`No Argus module is registered for '${packId}'. Check the Solution Pack endpoint configuration or return to Home.`}
    />
  );
}
