export type HealthState = 'healthy' | 'degraded' | 'offline' | 'not_configured';
export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type RiskLevel = 'medium' | 'high' | 'critical';

export interface RiskFactor {
  id: string;
  label: string;
  category: 'action' | 'environment' | 'scope' | 'data' | 'execution' | 'policy';
  weight: number;
  evidence: string;
}

export interface ConsoleUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
}

export interface AttentionItem {
  id: string;
  kind: 'approval' | 'failure' | 'health';
  title: string;
  detail: string;
  href: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface RunSummary {
  id: string;
  numericId?: number;
  workflowId?: number;
  workflowHref?: string;
  kind: 'workflow' | 'agent';
  title: string;
  subtitle: string;
  status: RunStatus;
  progress?: number;
  risk: 'low' | 'medium' | 'high';
  startedAt: string;
  updatedAt: string;
  durationMs?: number | null;
  error?: string | null;
  href?: string;
}

export interface OverviewResponse {
  generatedAt: string;
  user: ConsoleUser;
  attention: AttentionItem[];
  stats: {
    activeRuns: number;
    successRate24h: number | null;
    completed24h: number;
    failed24h: number;
    workflowsInReview: number;
    connectedTools: number;
    agents: number;
  };
  health: {
    state: HealthState;
    healthy: number;
    total: number;
    degraded: number;
    issues?: Array<{
      id: string;
      name: string;
      state: 'degraded' | 'offline';
      error: string;
      href: string;
    }>;
  };
  runs: RunSummary[];
}

export interface PlatformBackendHealthResult {
  name: string;
  kind: 'mcp_backend' | 'internal';
  url: string | null;
  status: 'ok' | 'down' | 'unknown';
  http_status?: number;
  latency_ms: number;
  error?: string;
}

export interface PlatformBackendHealthResponse {
  timestamp: string;
  total: number;
  ok: number;
  down: number;
  results: PlatformBackendHealthResult[];
}

export interface PlatformExecutionCertificate {
  id: string;
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  profileId: 'pilot-demo';
  sourceSchema: 'argus.solution-showcase-golden-runs.v1';
  sourceMode: 'execute' | 'verify-only';
  generatedAt: string;
  recordedAt: string;
  recordedBy: string;
  payloadSha256: string;
  passed: true;
  devPassed: true;
  aiopsPassed: true;
  identity: { displayName: string | null; username: string | null; authMethod: string | null; mfaMethod: string | null };
  dev: {
    taskId: string; rootTraceId: string; ticketId: string | null; repository: string | null;
    workflowId: string | null; verificationMode: 'tests-and-review' | 'review-only-image'; testExecution: 'passed' | 'intentionally_skipped';
    branchName: string | null; commitSha: string | null; pullRequestUrl: string | null; changedFiles: string[];
    ci: { provider: string | null; status: string | null; runUrl: string | null; imageTag: string | null; imageId: string | null };
  };
  aiops: {
    taskId: string; rootTraceId: string; state: string | null; quality: string | null;
    profile: { displayName: string | null; service: string | null; environment: string | null; revision: number | null; sha256: string | null };
    evidenceLanes: Array<{ lane: string; status: string }>;
    providerToolNames: string[];
  };
}

export interface PlatformExecutionCertificateCatalog {
  schemaVersion: 1;
  kind: 'platform-execution-certificate-catalog';
  profile: { id: 'pilot-demo'; label: string };
  freshnessDays: number;
  certificates: PlatformExecutionCertificate[];
  limitation: string;
}

export interface SolutionPackManifest {
  apiVersion: 'argus.eu/v1alpha1';
  kind: 'SolutionPack';
  metadata: {
    id: string;
    version: string;
    displayName: string;
    description?: string;
  };
  spec: {
    delivery: {
      type: 'container';
      protocol: 'argus-pack-v1alpha1';
      healthPath: string;
      readinessPath: string;
    };
    requires: {
      core: string;
      capabilities: string[];
      credentials: Array<{ id: string; accepts: string[]; optional: boolean }>;
    };
    components: {
      agents: Array<{
        id: string;
        runtime: string;
        skills: string[];
        bundles: string[];
        credentials: string[];
        coreAgents: string[];
        a2aAgentCardPath?: string;
      }>;
      /** Optional for pre-runtime-adapter Pack records retained by older Core versions. */
      runtimeAdapters?: SolutionPackRuntimeAdapterDeclaration[];
      skills: string[];
      bundles: string[];
      workflows: string[];
      knowledgeSources: string[];
      dashboards: string[];
      policies: string[];
    };
    readiness: { smokeTests: string[] };
  };
}

/**
 * A Pack-owned execution bridge. This is intentionally not an MCP bundle:
 * bundles describe tools; runtime adapters describe where an agent loop runs.
 */
export interface SolutionPackRuntimeAdapterDeclaration {
  id: string;
  runtime: string;
  protocol: 'argus-runtime-v1alpha1';
  endpoint: string;
  modes: Array<'attached' | 'managed'>;
  capabilities: string[];
}

export type SolutionPackRuntimeAdapterConnectionState =
  | 'ready'
  | 'degraded'
  | 'unavailable';

export interface SolutionPackRuntimeAdapterCapabilitiesResponse {
  adapter: SolutionPackRuntimeAdapterDeclaration;
  capabilities: {
    adapter: Pick<SolutionPackRuntimeAdapterDeclaration, 'id' | 'runtime' | 'protocol'>;
    modes: Array<'attached' | 'managed'>;
    capabilities: string[];
  };
}

export interface SolutionPackRuntimeAdapterStatusResponse {
  adapter: SolutionPackRuntimeAdapterDeclaration;
  status: {
    adapter: Pick<SolutionPackRuntimeAdapterDeclaration, 'id' | 'runtime' | 'protocol'>;
    state: SolutionPackRuntimeAdapterConnectionState;
    checkedAt?: string;
    modes: Array<{
      mode: 'attached' | 'managed';
      state: SolutionPackRuntimeAdapterConnectionState;
      detail?: string;
    }>;
  };
}

export type AttachedHermesRunState =
  | 'queued' | 'running' | 'awaiting_approval' | 'stopping' | 'cancelled' | 'completed' | 'failed';

export interface AttachedHermesRunResponse {
  apiVersion: 'argus-runtime-v1alpha1';
  trust: 'external_attested';
  governance: {
    coreMcpLease: false;
    nativeToolsExternallyGoverned: true;
  };
  run: {
    id: string;
    mode: 'attached';
    state: AttachedHermesRunState;
    updatedAt: string;
    output?: string;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  };
}

export interface SolutionPackRecord {
  configuredId: string;
  endpoint: string;
  state: 'not_checked' | 'ready' | 'degraded' | 'unreachable' | 'invalid' | 'incompatible';
  checkedAt: string | null;
  manifest?: SolutionPackManifest;
  health?: { ok: boolean; status?: number; latencyMs: number; error?: string };
  readiness?: { ok: boolean; status?: number; latencyMs: number; error?: string };
  error?: string;
  revision?: number;
  previousVersion?: string;
  previousManifest?: SolutionPackManifest;
}

export interface SolutionPacksResponse {
  total: number;
  packs: SolutionPackRecord[];
}

export interface SolutionPackManifestDiffChange {
  path: string;
  before: unknown;
  after: unknown;
  kind: 'added' | 'removed' | 'changed';
}

export interface SolutionPackDiffResponse {
  packId: string;
  state: SolutionPackRecord['state'];
  revision: number;
  previousVersion: string | null;
  currentVersion: string | null;
  rollbackAvailable: boolean;
  changes: SolutionPackManifestDiffChange[];
}

export interface SolutionPackRollbackRequest {
  id: string;
  packId: string;
  requestedBy: string;
  reason: string;
  sourceRevision: number;
  currentVersion: string | null;
  targetVersion: string;
  targetManifest: SolutionPackManifest;
  status: 'pending' | 'accepted' | 'applied' | 'failed' | 'canceled';
  error: string | null;
  requestedAt: string;
  updatedAt: string;
  appliedAt: string | null;
  claimedBy?: string | null;
  claimedAt?: string | null;
  claimExpiresAt?: string | null;
}

export interface SolutionPackRollbackRequestsResponse {
  packId: string;
  total: number;
  requests: SolutionPackRollbackRequest[];
}

export interface RepositoryIssueSnapshot {
  version: 1; provider: 'gitea'; repository: string; gitOrigin: string; number: number;
  url: string; title: string; body: string; state: string; updatedAt: string;
  fetchedAt: string; sha256: string; toolName: string; backendId: number;
}

export interface SolutionPackCodingEvidence {
  technicalExperiment?: unknown;
  qaAcceptance?: unknown;
  sourceIssue?: RepositoryIssueSnapshot | null;
  qaTestPlan?: string;
  workflowBlockers?: string[];
  planningThreadId?: string;
  allowedFiles?: string;
  workflowId: string;
  workflowLabel: string;
  runTitle: string;
  ticketId: string | null;
  repository: string;
  pullRequestNumber: number | null;
  currentStage: string;
  plan: string;
  testsPassed: boolean;
  verificationMode?: 'review-only-image' | 'automated-tests';
  testOutput: string;
  testProfiles?: Array<{
    id: string;
    runner: 'node' | 'python' | 'go' | 'rust' | 'maven' | 'gradle' | 'dotnet' | string;
    root: string;
    passed: boolean;
  }>;
  reviewPassed: boolean;
  review: string;
  fixOutput?: string;
  fixApplied?: boolean;
  releaseId?: string;
  releaseVersion?: string;
  releaseScope?: string;
  releaseGoal?: string;
  releaseNotes?: string;
  releaseCompleted?: boolean;
  backlogId?: string;
  issueTitle?: string;
  issueBody?: string;
  backlogTasks?: string;
  backlogConstraints?: string;
  backlogCompleted?: boolean;
  humanChangeRequest: string;
  retryCount: number;
  humanApproved: boolean;
  branchPushed: boolean;
  buildUrl: string;
  deliveryStatus?: string;
  ciRun?: SolutionPackCiRun | null;
  prApproved: boolean;
  prUrl: string;
  deliverySummary: string;
  fileDiffs: unknown[];
  reviewAnnotations: unknown[];
  revisionHistory?: SolutionPackRevisionEvidence[];
  visualCompleted?: boolean;
  stepResults?: Record<string, {
    status: string;
    label: string;
    type: string;
    result: string;
    durationMs: number;
  }>;
  agentOutputs?: Array<{
    stepId: string;
    label: string;
    role: string;
    agentId: number;
    output: string;
    attempt: number;
    traceId?: string;
    sessionId?: string;
    runtimeRunId?: string;
    recordedAt: string;
  }>;
}

export interface SolutionPackRevisionAgentEvidence {
  output: string;
  traceId?: string;
  sessionId?: string;
  runtimeRunId?: string;
  recordedAt: string;
}

export interface SolutionPackRevisionEvidence {
  attempt: number;
  retryCount: number;
  trigger: 'initial' | 'tests' | 'qa' | 'reviewer' | 'human' | 'functional';
  triggerFeedback: string;
  startedAt: string;
  coder: SolutionPackRevisionAgentEvidence;
  tests?: {
    passed: boolean;
    output: string;
    profiles: NonNullable<SolutionPackCodingEvidence['testProfiles']>;
    recordedAt: string;
  };
  reviewer?: {
    verdict: 'APPROVE' | 'REQUEST_CHANGES';
    summary: string;
    findings: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
      message: string;
      file?: string;
      line?: number;
    }>;
    requiredChanges: string[];
    output: string;
    traceId?: string;
    sessionId?: string;
    runtimeRunId?: string;
    recordedAt: string;
  };
  humanDecisions: Array<{
    stage: 'code' | 'functional';
    approved: boolean;
    feedback: string;
    recordedAt: string;
  }>;
  fileDiffs: unknown[];
}

export interface SolutionPackCiRun {
  provider: 'gitea' | 'github' | 'gitlab' | 'jenkins' | 'bitbucket' | 'unknown' | string;
  external_id: string;
  workflow: string;
  status: 'queued' | 'running' | 'success' | 'failure' | 'canceled' | 'unknown' | string;
  conclusion: string;
  branch: string;
  commit_sha: string;
  run_url: string;
  updated_at: string;
}

export interface SolutionPackWorkflowInputOption {
  value: string;
  label: string;
}

export interface SolutionPackWorkflowInputField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select';
  required: boolean;
  placeholder?: string;
  description?: string;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  options?: SolutionPackWorkflowInputOption[];
}

export interface SolutionPackWorkflowStage {
  id: string;
  label: string;
  hint: string;
  kind: 'workspace' | 'plan' | 'knowledge' | 'code' | 'test' | 'review' | 'approval' | 'delivery';
}

export interface SolutionPackWorkflowDefinition {
  id: string;
  graphId: string;
  label: string;
  description: string;
  tags: string[];
  inputSchema: SolutionPackWorkflowInputField[];
  stages: SolutionPackWorkflowStage[];
  approvalGates: string[];
  requiredAgents: string[];
  titleField: string;
  titlePrefix?: string;
  descriptionField?: string;
  requiredBundleCategories?: string[];
  recommendedBundleCategories?: string[];
  reviewPolicy?: { maxAttempts: number };
  revisionPolicy?: { maxRevisions: number };
  requiredExecutionTargetKinds?: string[];
}

export interface SolutionPackAgentCardResponse {
  agentCard: {
    name: string;
    description?: string;
    version: string;
    skills: Array<{
      id: string;
      name: string;
      description?: string;
      'x-argus-workflow'?: SolutionPackWorkflowDefinition;
    }>;
  };
}

export interface SolutionPackTask {
  id: string;
  contextId?: string;
  status: {
    state: string;
    timestamp?: string;
    message?: { parts?: Array<{ text?: string; data?: Record<string, unknown> }> };
  };
  metadata?: Record<string, unknown>;
  artifacts?: Array<{
    name?: string;
    parts?: Array<{ data?: Record<string, unknown> }>;
  }>;
  history?: Array<{
    parts?: Array<{ text?: string; data?: Record<string, unknown> }>;
  }>;
}

export interface SolutionPackTaskResponse {
  task: SolutionPackTask;
}

export interface SolutionPackTaskListEntry {
  task: SolutionPackTask;
  createdAt: string;
  updatedAt: string;
}

export interface SolutionPackTaskListResponse {
  tasks: SolutionPackTaskListEntry[];
  nextCursor: string | null;
}

export interface SolutionPackMessageResponse extends SolutionPackTaskResponse {
  rootTraceId: string;
}

export type SolutionPackPreflightResponse = SolutionPackMessageResponse;

export type AiOpsEvidenceLane =
  | 'metrics'
  | 'logs'
  | 'traces'
  | 'runtime'
  | 'topology'
  | 'changes'
  | 'knowledge'
  | 'incident';

export interface AiOpsGlobalReadiness {
  schemaVersion: 1;
  kind: 'aiops-readiness';
  state: 'setup_required' | 'ready' | 'degraded' | 'blocked';
  presentation: 'connector_setup' | 'connected_summary';
  generatedAt: string;
  pack: { state: 'ready' | 'degraded' | 'offline'; version: string | null };
  eligibleBundleCount: number;
  availableLanes: AiOpsEvidenceLane[];
  primaryConnection: {
    bundleId: number;
    bundleName: string;
    lanes: AiOpsEvidenceLane[];
    certifiedTargetCount: number;
    checkedAt: string;
  } | null;
  profiles: { active: number; ready: number; degraded: number; blocked: number };
  issues: Array<{
    code: string;
    severity: 'warning' | 'blocking';
    message: string;
    lane?: AiOpsEvidenceLane;
    bundleId?: number;
    backendId?: number;
  }>;
  recoveryActions: Array<{
    id: string;
    label: string;
    kind: 'manage_connection' | 'add_environment' | 'review_catalog' | 'renew_certification' | 'edit_profile';
    href: string;
  }>;
}

export type AiOpsEvidenceRequirement = 'required' | 'optional' | 'disabled';

export interface AiOpsEvidenceQueryTemplate {
  id: string;
  toolName: string;
  description?: string;
  source?: {
    kind: 'elasticsearch' | 'opensearch' | 'loki' | 'generic';
    resource?: string;
    fields?: {
      timestamp: string;
      service: string;
      environment?: string;
      message: string;
      severity?: string;
      traceId?: string;
    };
  };
  defaults?: {
    signalKeyword?: string;
    signalFingerprint?: string;
  };
  template: string;
}

export interface AiOpsServiceProfileConfig {
  schemaVersion: 1;
  service: {
    displayName: string;
    serviceName: string;
    environment: string;
    description?: string;
  };
  ownership: {
    team?: string;
    escalationPolicyRef?: string;
    businessService?: string;
    criticality: 'low' | 'medium' | 'high' | 'critical';
  };
  evidencePolicy: {
    lanes: Array<{
      lane: AiOpsEvidenceLane;
      requirement: AiOpsEvidenceRequirement;
      bundleId: number;
      toolAllowlist?: string[];
      queryTemplates: AiOpsEvidenceQueryTemplate[];
    }>;
    minimumCollectedLanes: number;
    correlationWindowMinutes: number;
    maxProviderResultBytes: number;
  };
  selectors: {
    otelServiceNames: string[];
    metricLabels: Record<string, string>;
    logLabels: Record<string, string>;
    traceOperations: string[];
    runtime?: {
      kind: 'kubernetes';
      backendId: number;
      targetId: string;
      cluster: string;
      namespace: string;
      workloads: Array<{ kind: 'Deployment' | 'StatefulSet' | 'Job'; name: string }>;
    };
    repositories?: Array<{ provider: string; owner: string; repository: string }>;
  };
  detection: {
    nativeAlertRuleIds: number[];
    nativeSloIds: number[];
    providerMonitorRefs: string[];
    autoInvestigate: boolean;
    cooldownMinutes: number;
  };
  context: {
    knowledgeSourceIds: number[];
    runbookRefs: string[];
    dependencyOverrides: Array<{
      targetKind: 'service' | 'database' | 'messaging' | 'external';
      targetName: string;
      relation: 'calls' | 'queries' | 'publishes';
      direction: 'upstream' | 'downstream';
      reason?: string;
    }>;
  };
  remediationPolicy: {
    mode: 'diagnose-only' | 'propose' | 'governed-execute';
    allowedAdapterKeys: string[];
    maxRiskWithoutApproval: 'none' | 'low';
    requireApprovalInProduction: true;
    requireVerification: true;
    requireRollbackPlan: true;
  };
}

export interface AiOpsServiceProfile {
  schemaVersion: 1;
  kind: 'aiops-service-profile';
  id: number;
  status: 'draft' | 'active' | 'paused' | 'archived';
  activeRevision: { revision: number; sha256: string } | null;
  latestRevision: {
    revision: number;
    sha256: string;
    config: AiOpsServiceProfileConfig;
    createdAt: string;
    createdBy: { id: number; username: string };
  };
  tags: Array<{ id: string; label: string; color: string | null }>;
  allowedActions: Array<'read' | 'edit' | 'validate' | 'activate' | 'pause' | 'clone' | 'archive' | 'investigate'>;
  createdAt: string;
  updatedAt: string;
}

export interface AiOpsServiceProfileReadiness {
  schemaVersion: 1;
  kind: 'aiops-service-profile-readiness';
  profileId: number;
  revision: number;
  profileSha256: string;
  state: 'ready' | 'degraded' | 'blocked';
  generatedAt: string;
  lanes: Array<{
    lane: AiOpsEvidenceLane;
    requirement: AiOpsEvidenceRequirement;
    state: 'ready' | 'missing' | 'blocked' | 'disabled';
    bundleId: number;
    bundleName: string | null;
    providedCategories: string[];
    toolNames: string[];
    issueCodes: string[];
  }>;
  runtime: {
    required: boolean;
    state: 'not_required' | 'ready' | 'missing' | 'blocked';
    scope: AiOpsServiceProfileConfig['selectors']['runtime'] | null;
    certification: {
      status: 'passed' | 'failed';
      freshness: 'fresh' | 'expiring' | 'stale';
      generatedAt: string;
      expiresAt: string;
    } | null;
  };
  summary: {
    requiredLanes: number;
    readyRequiredLanes: number;
    optionalGaps: number;
    blockingIssues: number;
  };
  issues: AiOpsGlobalReadiness['issues'];
  recoveryActions: AiOpsGlobalReadiness['recoveryActions'];
}

export interface AiOpsServiceProfileListResponse {
  schemaVersion: 1;
  kind: 'aiops-service-profile-list';
  profiles: AiOpsServiceProfile[];
}

export interface AiOpsServiceProfileInvestigationSignal {
  title: string;
  summary: string;
  severity?: 'critical' | 'warning' | 'info';
  startedAt?: string;
  alertSource?: string;
  alertUrl?: string;
  keyword?: string;
  fingerprint?: string;
  sourceIncidentId?: number;
  labels?: Record<string, string>;
}

export interface AiOpsServiceProfileInvestigationStarted {
  schemaVersion: 1;
  kind: 'aiops-service-profile-investigation-started';
  profile: { id: number; revision: number; sha256: string };
  resolvedContextSha256: string;
  execution: {
    bundleIds: number[];
    toolNames: string[];
    resourceScope: NativeAlertAiopsResourceScope | null;
    service: string;
    environment: string;
  };
  rootTraceId: string;
  task: SolutionPackTask;
}

export interface AiOpsEvidenceQueryPreflightInput {
  bundleId: number;
  lane: AiOpsEvidenceLane;
  query: AiOpsEvidenceQueryTemplate;
  context: {
    serviceName: string;
    environment: string;
    windowStart: string;
    windowEnd: string;
    runtime?: { cluster: string; namespace: string };
    signal?: { keyword?: string; fingerprint?: string };
    traceId?: string;
  };
  execute: boolean;
}

export interface AiOpsEvidenceQueryPreflightResult {
  schemaVersion: 1;
  kind: 'aiops-evidence-query-preflight';
  lane: AiOpsEvidenceLane;
  bundleId: number;
  queryId: string;
  toolName: string;
  generatedAt: string;
  state: 'preview' | 'succeeded' | 'failed';
  executed: boolean;
  request: { arguments: Record<string, unknown> };
  response: {
    preview: string;
    matchedDocuments: number | null;
    durationMs: number;
    resultBytes: number;
    truncated: boolean;
  } | null;
}

export interface CodingThreadSummary {
  thread_id: string;
  graph_id?: string;
  status: 'idle' | 'queued' | 'running' | 'interrupted' | 'waiting_external_ci' | 'completed' | 'failed' | 'canceled';
  error?: string | null;
  metadata: Record<string, unknown>;
  values?: Record<string, unknown>;
  next?: string[];
  tasks?: Array<{ id?: string; name?: string; interrupts?: Array<{ id?: string; value?: Record<string, unknown> }> }>;
  interrupts?: Array<{ id?: string; value?: Record<string, unknown> }>;
  checkpoint_id?: string;
  checkpoint_metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CodingThreadsResponse {
  threads: CodingThreadSummary[];
}

export interface CodingRetryResponse {
  thread_id: string;
  original_thread_id: string;
  status: 'started' | string;
}

export interface CodexRuntimeRun {
  id: string;
  telemetryTraceId?: string;
  telemetryRootTraceId?: string | null;
  state: 'starting' | 'running' | 'completed' | 'failed' | 'canceled';
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  timeoutSec: number;
  threadId: string | null;
  rootTraceId: string | null;
  agentId: number | null;
  taskType: string | null;
  errorCode?: string;
  error?: string;
  cancelReason?: 'operator' | 'request_disconnected' | 'timeout';
}

export interface CodexRuntimeStatus {
  enabled: boolean;
  authenticated: boolean;
  authMethod: string;
  activeRuns: number;
  recentRuns?: number;
  maxConcurrentRuns: number;
  runs: CodexRuntimeRun[];
}

export type RuntimeAuthProvider = 'codex' | 'claude-code';
export type RuntimeAuthState = 'starting' | 'waiting_for_user' | 'code_submitted' | 'completed' | 'failed' | 'canceled' | 'expired';

export interface RuntimeAuthSession {
  id: string;
  provider: RuntimeAuthProvider;
  state: RuntimeAuthState;
  verificationUri: string | null;
  userCode: string | null;
  requiresCodeSubmission: boolean;
  message: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  error?: string;
}

export type PublicWidgetRuntimeState = 'active' | 'master_disabled' | 'widget_disabled' | 'agent_unavailable' | 'origins_missing';

export interface PublicWidgetRecord {
  id: number;
  agentId: number;
  agent: null | {
    id: number;
    name: string;
    label: string;
    enabled: boolean;
    visibility: 'internal' | 'public';
  };
  slug: string;
  allowedOrigins: string[];
  enabled: boolean;
  runtimeState: PublicWidgetRuntimeState;
  greeting: string | null;
  accent: string | null;
  title: string | null;
  inputPlaceholder: string | null;
  launcherIconUrl: string | null;
  launcherIconAlt: string | null;
  launcherPosition: 'left' | 'right';
  rateLimitPerIp: number;
  dailyTokenCap: number;
  createdBy: string | null;
  createdAt: string;
  publicPath: string;
  scriptPath: string;
}

export interface PublicWidgetMutation {
  agentId?: number;
  slug?: string;
  allowedOrigins?: string[];
  enabled?: boolean;
  greeting?: string | null;
  accent?: string | null;
  title?: string | null;
  inputPlaceholder?: string | null;
  launcherIconUrl?: string | null;
  launcherIconAlt?: string | null;
  launcherPosition?: 'left' | 'right';
  rateLimitPerIp?: number;
  dailyTokenCap?: number;
}

export interface PublicWidgetDemoState {
  configured: boolean;
  reachable: boolean;
  agentId: number | null;
  agentReady: boolean;
  widgetId: number | null;
  widgetEnabled: boolean;
  origin: string | null;
  publicPath: string | null;
}

export interface PublicWidgetDemoResponse {
  demo: PublicWidgetDemoState;
  widget?: PublicWidgetRecord | null;
}

export interface PublicWidgetCatalog {
  generatedAt: string;
  masterEnabled: boolean;
  demo: PublicWidgetDemoState;
  widgets: PublicWidgetRecord[];
  agents: Array<{ id: number; name: string; label: string }>;
  limits: {
    maxOrigins: number;
    minDailyTokenCap: number;
    maxDailyTokenCap: number;
    maxRateLimitPerIp: number;
  };
}

export interface RuntimeHookRecord {
  name: string;
  priority: number;
  description: string;
  kind: 'built_in' | 'external';
}

export interface RuntimePolicyRecord {
  id: number;
  name: string;
  description: string;
  webhookUrl: string;
  timeoutMs: number;
  toolPatterns: string[];
  enabled: boolean;
  onFailure: 'allow' | 'deny';
  hasHmacSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimePolicyMutation {
  name?: string;
  description?: string;
  webhookUrl?: string;
  timeoutMs?: number;
  toolPatterns?: string[];
  enabled?: boolean;
  onFailure?: 'allow' | 'deny';
  secretAction?: 'keep' | 'replace' | 'clear';
  hmacSecret?: string;
}

export interface RuntimeControlCatalog {
  generatedAt: string;
  hooks: RuntimeHookRecord[];
  policies: RuntimePolicyRecord[];
  limits: {
    minTimeoutMs: number;
    maxTimeoutMs: number;
    maxPatterns: number;
    maxPatternLength: number;
  };
}

export interface RuntimePolicyTestResult {
  reachable: boolean;
  status: number | null;
  ok: boolean;
  decision: 'allow' | 'deny' | 'invalid' | 'unreachable';
  reason: string | null;
  latencyMs: number;
  signed: boolean;
  responsePreview: string | null;
}

export type ComplianceRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ComplianceVerdict = 'passed' | 'warning' | 'failed' | 'not_applicable';
export type ComplianceSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ComplianceFramework {
  id: number;
  slug: string;
  label: string;
  version: string;
  jurisdiction: string | null;
  description: string;
  enabled: boolean;
  checklistReady: boolean;
  knowledgeAttached: boolean;
  ready: boolean;
}

export interface ComplianceRun {
  id: number;
  frameworkId: number;
  frameworkSlug: string | null;
  frameworkLabel: string | null;
  target: string;
  agentId: number | null;
  status: ComplianceRunStatus;
  score: number | null;
  counts: { passed: number; warning: number; failed: number; notApplicable: number };
  triggeredBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface ComplianceFinding {
  id: number | null;
  article: string;
  title: string;
  verdict: ComplianceVerdict;
  severity: ComplianceSeverity;
  evidence: string | null;
  remediation: string | null;
  codePointers: Array<{ file: string; line: number | null; snippet: string | null }>;
  createdAt: string | null;
}

export interface ComplianceWorkspaceResponse {
  generatedAt: string;
  assessmentNotice: string;
  auditor: { ready: boolean; agentId: number | null };
  stats: {
    frameworks: number;
    readyFrameworks: number;
    activeRuns: number;
    completedRuns: number;
    averageScore: number | null;
    recentGaps: number;
  };
  frameworks: ComplianceFramework[];
  runs: ComplianceRun[];
}

export interface ComplianceRunDetailResponse {
  generatedAt: string;
  assessmentNotice: string;
  framework: ComplianceFramework;
  run: ComplianceRun;
  findings: ComplianceFinding[];
  exports: { pdf: string; csv: string } | null;
}

export interface AgentSummary {
  id: number;
  name: string;
  label: string;
  description: string;
  model: string;
  effective_model?: string;
  runtime_profile_id?: number | null;
  runtime_label?: string | null;
  runtime_type?: 'argus' | 'codex' | 'claude-code' | 'hermes';
  reasoning_effort?: string | null;
  supports_vision: boolean;
}

export interface AgentRagRef {
  id: number;
  name: string;
  label: string;
  priority: number;
}

export interface AgentSkillRef {
  revision_id?: number;
  current_revision_id?: number;
  id: number;
  name: string;
  label: string;
  icon: string;
  category: string | null;
  position: number;
}

export type AgentReadinessStatus = 'ready' | 'degraded' | 'blocked' | 'disabled';
export type AgentCapabilityState = 'ready' | 'warning' | 'blocked' | 'disabled';

export interface AgentCapabilityReadiness {
  agentId: number;
  agentName: string;
  status: AgentReadinessStatus;
  ready: boolean;
  checkedAt: string;
  blockers: string[];
  warnings: string[];
  runtime: {
    type: 'argus' | 'codex' | 'claude-code' | 'hermes';
    profileId: number | null;
    profileName: string | null;
    profileLabel: string | null;
    model: string;
    state: AgentCapabilityState;
    authenticated: boolean | null;
    activeRuns: number | null;
    maxConcurrentRuns: number | null;
    availableSlots: number | null;
    trust?: 'core_governed' | 'external_attested';
    detail: string;
  };
  bundles: Array<{
    id: number;
    name: string;
    label: string;
    toolNames: string[];
    state: AgentCapabilityState;
    backends: Array<{
      id: number;
      name: string;
      type: 'http' | 'mcp' | 'builtin';
      enabled: boolean;
      connected: boolean | null;
      trustStatus: 'unverified' | 'trusted' | 'changed' | 'quarantined' | null;
      toolCount: number;
      state: AgentCapabilityState;
      detail: string;
    }>;
  }>;
  tools: Array<{ name: string; source: 'bundle' | 'workspace' | 'knowledge' | 'subagent' }>;
  capabilities: {
    workspace: { available: boolean; toolCount: number };
    knowledge: { available: boolean; toolCount: number };
    subagents: { available: boolean; toolCount: number };
    codegraph: { available: boolean; toolCount: number };
  };
}

export interface ManagedAgent extends Omit<AgentSummary, 'supports_vision'> {
  supports_vision?: boolean;
  temperature: number;
  max_tokens: number;
  system_prompt: string | null;
  agent_role: string | null;
  composite_id: number | null;
  composite_name: string | null;
  gitea_project: string | null;
  enabled: boolean;
  max_iterations: number;
  created_at: string;
  updated_at: string;
  agent_mode: 'chat' | 'worker' | 'reviewer';
  task_type: string | null;
  pr_branch: string | null;
  pr_number: number | null;
  ticket_id: string | null;
  allowed_paths: string[] | null;
  bitbucket_repo: string | null;
  bundle_ids: number[] | null;
  llm_api_key: '********' | null;
  llm_credential_profile_id: number | null;
  runtime_profile_id?: number | null;
  thinking_budget: number;
  untrusted_tool_output_enforcement: boolean;
  codegraph_enabled: boolean;
  visibility: 'internal' | 'public';
  min_role: ArgusUserRole | null;
  risk_level: 'low' | 'medium' | 'high';
  human_oversight_required: boolean;
  entra_object_id: string | null;
  entra_app_id: string | null;
  entra_blueprint_id: string | null;
  entra_synced_at: string | null;
  entra_sync_error: string | null;
  rag_indexes: AgentRagRef[];
  code_indexes?: AgentCodeIndexRef[];
  skills: AgentSkillRef[];
  readiness?: AgentCapabilityReadiness;
}

export interface IdentitySecurityStatus {
  provider: {
    enabled: boolean;
    name: string;
    type: string;
    ssoOnly: boolean;
    localLoginEnabled: boolean;
    emergencyLocalAdmin: boolean;
    mfaMaxAgeSeconds: number;
    accountManagementUrl: string | null;
    adminConsoleUrl: string | null;
  };
  session: {
    authMethod: 'local' | 'oidc';
    ssoLinked: boolean;
    mfaVerifiedAt: string | null;
    mfaMethod: string | null;
    mfaFresh: boolean;
  };
  actions: {
    canLink: boolean;
    canStepUp: boolean;
    canManageMfa: boolean;
    canManageOrganizationPolicy: boolean;
  };
  complianceReports: {
    roleAuthorized: boolean;
    freshMfaRequired: true;
    ready: boolean;
  };
}

export interface AgentCodeIndexRef {
  id: number;
  repository_key: string;
  branch_name: string;
  commit_sha: string;
  provider: string;
  file_count: number;
  symbol_count: number;
  edge_count: number;
  priority: number;
}

export interface AgentModelOption {
  model_name: string;
  provider: string;
  enabled: boolean;
  supports_vision: boolean;
}

export interface AgentCompositeOption {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
}

export interface AgentBundleOption {
  id: number;
  name: string;
  label: string;
  description: string;
  icon: string;
  backend_count: number;
  tool_count: number;
}

export interface RagIndexOption {
  id: number;
  name: string;
  label: string;
  description: string;
  provider: string;
  endpoint: string;
  index_name: string;
  api_key: string | null;
  semantic_config: string | null;
  vector_field?: string | null;
  adapter_config?: KnowledgeAdapterConfig;
  top_k: number;
  enabled: boolean;
  hyde_enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

export type KnowledgeProviderId = 'pgvector' | 'qdrant' | 'azure_ai_search' | 'opensearch' | 'elasticsearch' | 'weaviate' | 'pinecone' | 'milvus';

export interface KnowledgeAdapterConfig {
  text_field?: string;
  source_field?: string;
  id_field?: string;
  namespace?: string;
  auth_mode?: 'api_key' | 'basic' | 'bearer';
}

export interface KnowledgeProviderField {
  key: 'endpoint' | 'index_name' | 'semantic_config' | 'vector_field' | `adapter_config.${string}`;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  input?: 'text' | 'url' | 'select';
  default_value?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface KnowledgeProviderDefinition {
  id: KnowledgeProviderId;
  label: string;
  description: string;
  kind: 'built_in' | 'external';
  target_label: string;
  credential: { mode: 'none' | 'optional' | 'required'; label: string; placeholder: string };
  capabilities: { ingest: boolean; evaluation: boolean };
  fields: KnowledgeProviderField[];
}

export interface KnowledgeDocument {
  id: number;
  name: string;
  chunk_count: number;
  created_at: string;
}

export interface KnowledgeSource extends RagIndexOption {
  documents: KnowledgeDocument[];
}

export interface KnowledgeCatalog {
  sources: KnowledgeSource[];
  providers: KnowledgeProviderDefinition[];
}

export interface NativeCodeIndexSnapshot {
  id: number;
  repositoryKey: string;
  branchName: string;
  commitSha: string;
  provider: string;
  sourceGraphDigest: string;
  parserVersion: string | null;
  graphSchemaVersion: string | null;
  embeddingModel: string | null;
  status: 'building' | 'ready' | 'failed' | 'superseded';
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  documentCount: number;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  finishedAt: string | null;
  bundleNames: string[];
  languages: Record<string, number>;
}

export interface KnowledgeSourceMutation {
  name?: string;
  label: string;
  description: string;
  provider: KnowledgeProviderId;
  endpoint: string;
  index_name: string;
  api_key?: string | null;
  semantic_config: string | null;
  vector_field: string | null;
  adapter_config: KnowledgeAdapterConfig;
  top_k: number;
  enabled: boolean;
}

export interface KnowledgeSearchResult {
  id: string;
  score: number;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeTestResult {
  ok: boolean;
  query: string;
  results_count: number;
  results: KnowledgeSearchResult[];
}

export interface KnowledgeEvalResult {
  index: string;
  sample_size: number;
  evaluated: number;
  hits: number;
  hit_at_5: number;
  details: Array<{ question: string; chunk_id: string; hit: boolean }>;
  langfuse_dataset?: string;
  langfuse_run?: string;
  error?: string;
}

export interface KnowledgeUploadResult {
  documents: Array<{ id: number; name: string; chunkCount: number }>;
  failed: Array<{ name: string; error: string }>;
}

export interface SkillOption {
  id: number;
  name: string;
  label: string;
  description: string;
  content: string;
  category: string | null;
  icon: string;
  source_url?: string | null;
  source_ref?: string | null;
  imported_at?: string | null;
  created_at?: string;
  updated_at?: string;
  assigned_agents?: Array<{ id: number; name: string; label: string; enabled: boolean }>;
}

export interface SkillMutation {
  name: string;
  label: string;
  description: string;
  content: string;
  category: string | null;
  icon: string;
}

export interface SkillAdoptionResponse {
  generatedAt: string;
  windowDays: number;
  kpis: {
    activeConsumers1d: number;
    activeConsumers7d: number;
    activeConsumers30d: number;
    totalSkills: number;
    activeSkills: number;
    adoptionRate: number;
    totalUses: number;
    averageUsesPerConsumer: number;
    p50Ms: number;
    p95Ms: number;
    errorCount: number;
    errorRate: number;
  };
  bySkill: Array<{
    skill: string;
    label: string;
    uses: number;
    activeConsumers: number;
    averageContextLength: number;
    p95Ms: number;
    errorCount: number;
    errorRate: number;
  }>;
  consumers: Array<{ id: string; skillFetches: number; distinctSkills: number }>;
  timeSeries: Array<{ day: string; uses: number; errors: number }>;
  stale: Array<{ id: number; name: string; label: string; icon: string; daysSinceLastUse: number | null }>;
  trending: Array<{ skill: string; label: string; recent: number; prior: number; delta: number }>;
  heatmap: Array<{ dayOfWeek: number; hour: number; uses: number }>;
}

export interface AgentHookConfig {
  agent_id: number;
  extra_destructive_patterns: string[];
  max_tool_calls: number | null;
  updated_at?: string;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

export interface AgentSessionSummary {
  id: string;
  agent_id: number;
  user_id: number | null;
  message_count: number;
  messages: AgentMessage[];
  created_at: string;
  last_active: string;
}

export interface AgentStudioCatalog {
  agents: ManagedAgent[];
  templates: AgentTemplate[];
  drafts: AgentTemplateDraft[];
  credentialProfiles: LlmCredentialProfileRecord[];
  models: AgentModelOption[];
  composites: AgentCompositeOption[];
  bundles: AgentBundleOption[];
  ragIndexes: RagIndexOption[];
  codeIndexes?: NativeCodeIndexSnapshot[];
  skills: SkillOption[];
  runtimeProfiles?: AgentRuntimeProfile[];
}

/** Execution engine assignment. This contains references only, never tokens. */
export interface AgentRuntimeProfile {
  id: number;
  name: string;
  label: string;
  description: string;
  runtime_type: 'argus' | 'codex' | 'claude-code' | 'hermes';
  auth_mode: 'none' | 'chatgpt' | 'claude_subscription' | 'api_key' | 'managed_access_token' | 'runtime_adapter';
  auth_ref: string | null;
  model: string | null;
  reasoning_effort: string | null;
  code_context_mode: 'metadata_only' | 'bounded_source';
  code_context_max_results: number;
  code_context_max_bytes: number;
  enabled: boolean;
  max_concurrent_runs: number;
  allowed_task_types: string[];
  assigned_agent_count: number;
  managed?: boolean;
  adapter_pack_id?: string | null;
  adapter_id?: string | null;
  execution_strategy?: 'attached' | 'managed' | 'auto' | null;
  adapter_credential_ref?: string | null;
  native_profile_ref?: string | null;
  workspace_policy?: 'context_only' | 'checkout' | 'isolated_worktree' | null;
  memory_policy?: 'none' | 'read_context' | 'propose_write' | null;
  native_tool_policy?: 'disabled' | 'external_attested' | 'managed_mcp_only' | null;
  session_policy?: 'clean' | 'resume_project' | 'resume_explicit' | null;
  adapter_config?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRuntimeCodeContextPolicyMutation {
  mode: 'metadata_only' | 'bounded_source';
  maxResults: number;
  maxBytes: number;
}

export interface AgentTemplate {
  id: number;
  name: string;
  label: string;
  description: string;
  category: string;
  agentMode: 'chat' | 'worker' | 'reviewer';
  config: {
    temperature?: number;
    maxTokens?: number;
    thinkingBudget?: number;
    systemPrompt?: string;
    agentRole?: string;
    giteaProject?: string;
    enabled?: boolean;
    maxIterations?: number;
    taskType?: string;
    allowedPaths?: string[];
    bitbucketRepo?: string;
    untrustedToolOutputEnforcement?: boolean;
    codegraphEnabled?: boolean;
    visibility?: 'internal' | 'public';
    minRole?: string;
    riskLevel?: 'low' | 'medium' | 'high';
    humanOversightRequired?: boolean;
  };
  compositeName: string | null;
  skillNames: string[];
  recommendedCapabilities: string[];
  requiredBy: string[];
  requiredToolPatterns: string[];
  minimumBundleCount: number;
  compatibleBundleIds: number[];
  version: number;
  installed: boolean;
  installedAgentId: number | null;
  installedVersion: number | null;
  installedAgents?: Array<{
    id: number;
    name: string;
    label: string;
    model: string;
    installedVersion: number;
  }>;
  upgradeAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMutation {
  name?: string;
  label: string;
  description: string;
  model: string;
  temperature: number;
  max_tokens: number;
  system_prompt: string | null;
  agent_role: string | null;
  composite_id: number | null;
  gitea_project: string | null;
  enabled: boolean;
  max_iterations: number;
  agent_mode: 'chat' | 'worker' | 'reviewer';
  task_type: string | null;
  pr_branch: string | null;
  pr_number: number | null;
  ticket_id: string | null;
  allowed_paths: string[] | null;
  bitbucket_repo: string | null;
  bundle_ids: number[] | null;
  llm_api_key?: string | null;
  llm_credential_profile_id: number | null;
  runtime_profile_id: number | null;
  thinking_budget: number;
  untrusted_tool_output_enforcement: boolean;
  codegraph_enabled: boolean;
  visibility: 'internal' | 'public';
  min_role: ArgusUserRole | null;
  risk_level: 'low' | 'medium' | 'high';
  human_oversight_required: boolean;
}

export interface AgentStudioSaveInput {
  agent: AgentMutation;
  ragIndexIds: number[];
  codeIndexIds: number[];
  skillIds: number[];
  hookConfig: Omit<AgentHookConfig, 'agent_id' | 'updated_at'>;
}

export interface WorkflowSummary {
  id: number;
  name: string;
  description: string;
  steps: Array<{ id: string; label: string; type?: string; tool?: string; agent_id?: number; agent_role?: string }>;
  input_params: Array<{ name: string; type: string; required: boolean }>;
  enabled: boolean;
  bundle_ids: number[];
  created_at: string;
  updated_at: string;
  human_oversight_required?: boolean;
  source?: 'manual' | 'visual' | 'template' | string;
  lifecycle_status?: string;
  tags?: string[];
  agent_requirements?: WorkflowAgentRequirement[];
}

export interface WorkflowAgentRequirement {
  role: string;
  label?: string;
  stepIds: string[];
  agentName?: string;
  agentId?: number;
  presetName?: string;
  minimumPresetVersion?: number;
  allowedModes: Array<'chat' | 'worker' | 'reviewer'>;
  requiredSkillNames: string[];
  requiredToolPatterns: string[];
  minimumBundleCount: number;
}

export interface WorkflowAgentAssignment {
  role: string;
  label: string;
  stepIds: string[];
  status: 'ready' | 'degraded' | 'blocked';
  agentId: number | null;
  agentName: string | null;
  agentLabel: string | null;
  agentMode: 'chat' | 'worker' | 'reviewer' | null;
  model: string | null;
  presetName: string | null;
  installedPresetVersion: number | null;
  requiredPresetVersion: number | null;
  skillNames: string[];
  bundleIds: number[];
  toolNames: string[];
  runtime: AgentCapabilityReadiness['runtime'] | null;
  catalogFingerprint: string | null;
  blockers: string[];
  warnings: string[];
}

export interface WorkflowAgentPreflight {
  workflowId: number;
  workflowName: string;
  checkedAt: string;
  ready: boolean;
  inferredLegacyContract: boolean;
  contractFingerprint: string;
  blockers: string[];
  warnings: string[];
  assignments: WorkflowAgentAssignment[];
}

export interface UserConnection {
  backend_id: number;
  name: string;
  auth_mode: 'permissive' | 'strict';
  oauth_scopes: string[] | null;
  connected: boolean;
  expires_at: string | null;
  scopes_granted: string[] | null;
  upstream_username: string | null;
  last_used_at: string | null;
  refresh_failed_at: string | null;
  readiness?: 'disabled' | 'not_connected' | 'reconnect_required' | 'refresh_required' | 'ready';
  has_refresh_token?: boolean;
}

export interface UserConnectionsResponse {
  connections: UserConnection[];
  delegationEnabled?: boolean;
}

export interface WorkforceSsoPortal {
  backendId: number;
  backendName: string;
  backendIds: number[];
  backendNames: string[];
  connectionCount: number;
  bundleIds: number[];
  mode: 'shared_oidc' | 'external_org_sso';
  application: string;
  label: string;
  providerName: string;
  presentationRole: string;
  state: 'ready' | 'sso_required' | 'premium_required';
  premium: true;
  launchPath: string | null;
  lastLaunch: {
    auditId: number;
    launchedAt: string;
  } | null;
}

export interface WorkforceIdentityAccessResponse {
  provider: {
    enabled: boolean;
    name: string;
  };
  session: {
    authMethod: 'local' | 'oidc';
    mfaFresh: boolean;
    mfaVerifiedAt: string | null;
    mfaMethod: string | null;
  };
  entitlement: {
    enabled: boolean;
    name: string;
  };
  stats: {
    available: number;
    ready: number;
    launched: number;
    configuredBackends: number;
  };
  portals: WorkforceSsoPortal[];
}

export interface AdminApiKey {
  id: number;
  key_prefix: string;
  key_suffix: string | null;
  label: string;
  allowed_bundles: number[] | null;
  allowed_tools: string[] | null;
  denied_tools: string[] | null;
  max_requests_per_minute: number | null;
  scope: 'mcp' | 'agents' | 'both';
  enabled: boolean;
  acting_as_user_id: number | null;
  composite_id: number | null;
  expires_at: string | null;
  last_used_at: string | null;
  rotation_schedule: string | null;
  next_rotation_at: string | null;
  created_at: string;
}

export interface AdminApiKeyMutation {
  label: string;
  allowed_bundles: number[] | null;
  allowed_tools: string[] | null;
  denied_tools: string[] | null;
  max_requests_per_minute: number | null;
  scope: 'mcp' | 'agents' | 'both';
  enabled: boolean;
  acting_as_user_id?: number | null;
  expires_at: string | null;
}

export interface ApiKeyBindingTarget {
  id: number;
  username: string;
  display_name: string;
  role: string;
  is_self: boolean;
}

export interface AdminApiKeySecret {
  id: number;
  label: string;
  key_prefix: string;
  key_suffix: string | null;
  api_key: string;
}

export interface HermesDevConnection {
  id: number;
  label: string;
  userId: number;
  username: string;
  displayName: string;
  apiKeyId: number;
  keyPrefix: string;
  keySuffix: string | null;
  bundleIds: number[];
  enabled: boolean;
  clientSeen: boolean;
  lastUsedAt: string | null;
  lastTestedAt: string | null;
  lastTestState: 'ready' | 'blocked' | 'failed' | null;
  lastTestDetail: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HermesDevConnectionSecret {
  connection: HermesDevConnection;
  apiKey: string;
  endpointPath: '/mcp/hermes-dev';
  environment: {
    ARGUS_HERMES_DEV_MCP_URL: string;
    ARGUS_HERMES_DEV_MCP_KEY: string;
  };
  configYaml: string;
}

export interface HermesDevConnectionCatalog {
  identity: {
    id: number;
    username: string;
    displayName: string;
    role: string;
    authentication: 'sso' | 'argus-session';
  };
  connections: HermesDevConnection[];
  bundles: Array<{
    id: number;
    name: string;
    label: string;
    toolCount: number;
  }>;
}

export interface HermesDevConnectionTest {
  connection: HermesDevConnection;
  coreReady: boolean;
  clientSeen: boolean;
  detail: string;
}

export type HermesManagedRunState =
  | 'queued' | 'provisioning' | 'running' | 'awaiting_approval'
  | 'cancelling' | 'cancelled' | 'completed' | 'failed';

export interface HermesManagedRunResponse {
  run: {
    id: string;
    mode: 'managed';
    rootTraceId: string;
    state: HermesManagedRunState;
    acceptedAt: string;
    updatedAt: string;
    eventCursor?: string;
  };
  lease: {
    leaseId: string;
    packId: string;
    adapterId: string;
    coreAgentId: number;
    runId: string;
    requestId: string;
    rootTraceId: string;
    mode: 'managed';
    status: 'pending' | 'active' | 'revoking' | 'revoked' | 'expired' | 'failed' | 'completed';
    issuedAt: string;
    activatedAt: string | null;
    expiresAt: string;
    revokedAt: string | null;
    terminalAt: string | null;
  };
}

export interface HermesManagedRuntimeCatalog {
  identity: {
    id: number;
    displayName: string;
    role: string;
    authentication: 'sso' | 'argus-session';
  };
  pack: { connected: boolean; version: string | null };
  adapter: {
    id: string;
    state: SolutionPackRuntimeAdapterConnectionState;
    modes: Array<{ mode: 'attached' | 'managed'; state: SolutionPackRuntimeAdapterConnectionState; detail?: string }>;
    capabilities?: string[];
  };
  managed: {
    ready: boolean;
    detail: string;
    approvedBundleIds: number[];
    agents: Array<{ id: number; name: string; label: string }>;
  };
  limits: {
    deadlineSeconds: { default: number; min: number; max: number };
    maxToolCalls: { default: number; min: number; max: number };
  };
}

export interface HermesManagedRuntimePreflight {
  ready: boolean;
  errors: string[];
  snapshot: HermesManagedRuntimeCatalog;
}

export interface HermesManagedRunEvents {
  run: HermesManagedRunResponse['run'];
  events: Array<{
    apiVersion: 'argus-runtime-v1alpha1';
    eventId: string;
    sequence: number;
    occurredAt: string;
    run: { id: string; rootTraceId: string; state: HermesManagedRunState };
    type: string;
    evidence?: Record<string, string | number | boolean | null>;
  }>;
  lastEventId?: string;
}

export interface HermesManagedMemoryProposal {
  id: string;
  kind: 'working' | 'episodic' | 'semantic' | 'procedural';
  content: string;
  importance: number;
  validDays: number;
  status: 'pending' | 'accepted' | 'rejected';
  workspaceLabel: string;
  sourceTraceId: string;
  sourceRuntimeRunId: string;
  proposalCount: number;
  createdAt: string;
  reviewedAt: string | null;
}

export type ArgusUserRole =
  | 'platform_admin'
  | 'operations_admin'
  | 'developer'
  | 'agent_operator'
  | 'viewer'
  | 'chat_user';

export interface AdminWorkspaceScope {
  tenant_key: string;
  workspace_key: string;
  is_default: boolean;
}

export interface AdminUser {
  id: number;
  username: string;
  display_name: string;
  role: ArgusUserRole | 'admin' | 'editor';
  allowed_bundles: number[] | null;
  enabled: boolean;
  created_at: string;
  last_login: string | null;
  workspace_scopes?: AdminWorkspaceScope[];
  last_auth_method?: 'local' | 'oidc' | null;
  last_mfa_verified_at?: string | null;
  last_mfa_method?: string | null;
}

export interface AdminUserCreateMutation {
  username: string;
  password: string;
  display_name: string;
  role: ArgusUserRole;
  allowed_bundles: number[] | null;
  enabled: boolean;
  workspace_scopes: AdminWorkspaceScope[];
}

export interface AdminUserUpdateMutation {
  display_name: string;
  role: ArgusUserRole;
  allowed_bundles: number[] | null;
  enabled: boolean;
  workspace_scopes: AdminWorkspaceScope[];
}

export type VaultProvider = 'none' | 'azure-kv' | 'hashicorp';

export interface SafeVaultConfig {
  type: VaultProvider;
  azureKvUri?: string;
  azureAuth?: 'workload-identity' | 'client-secret';
  azureClientId?: string;
  azureTenantId?: string;
  hashicorpUrl?: string;
  hashicorpMount?: string;
  hashicorpNamespace?: string;
  mappings?: Record<string, string>;
  azureClientSecretConfigured: boolean;
  hashicorpTokenConfigured: boolean;
}

export interface VaultConfigMutation extends Omit<SafeVaultConfig, 'azureClientSecretConfigured' | 'hashicorpTokenConfigured'> {
  azureClientSecret?: string;
  hashicorpToken?: string;
  clearAzureClientSecret?: boolean;
  clearHashicorpToken?: boolean;
}

export interface OtelConfig {
  endpoint: string;
  sampling: number;
  serviceName: string;
  headers: Record<string, string>;
}

export interface HydeConfig {
  model: string;
  maxTokens: number;
  prompt: string;
}

export interface K8sImpersonationConfig {
  enabled: boolean;
  userSource: 'username' | 'email' | 'custom';
  userHeader?: string;
  defaultGroup?: string;
  groupMap?: Record<string, string>;
}

export interface UpstreamTokenExchangeConfig {
  enabled: boolean;
}

export interface PlatformConfigResponse {
  vault: SafeVaultConfig;
  otel: OtelConfig;
  hyde: HydeConfig;
  k8s_impersonation: K8sImpersonationConfig;
  upstream_token_exchange: UpstreamTokenExchangeConfig;
}

export interface VaultConnectionTest {
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

export interface RunsResponse {
  generatedAt: string;
  runs: RunSummary[];
}

export interface DashboardMetricsResponse {
  totalToolCalls: number;
  toolCallsToday: number;
  toolCallsThisWeek: number;
  errorRate24h: number;
  avgDuration24h: number;
  activeApiKeys24h: number;
  toolCallsTimeline: Array<{ hour: string; count: number; errors: number }>;
  topTools: Array<{ tool: string; count: number; avg_duration: number }>;
  topApiKeys: Array<{ api_key_prefix: string; count: number }>;
}

export interface ObservabilityAnalyticsResponse {
  generatedAt: string;
  hours: number;
  summary: {
    totalTraces: number;
    completedTraces: number;
    failedTraces: number;
    activeTraces: number;
    waitingTraces: number;
    successRate: number;
    errorRate: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    llmCalls: number;
    toolCalls: number;
  };
  timeline: Array<{ bucket: string; count: number; completed: number; failed: number; costUsd: number; avgDurationMs: number }>;
  models: Array<{ provider: string; model: string; calls: number; failures: number; inputTokens: number; outputTokens: number; costUsd: number; avgDurationMs: number; p95DurationMs: number }>;
  tools: Array<{ tool: string; calls: number; failures: number; avgDurationMs: number; p95DurationMs: number }>;
  agents: Array<{ id: number | null; name: string; executions: number; failures: number; successRate: number; tokens: number; costUsd: number; p95DurationMs: number }>;
  workflows: Array<{ id: number | null; name: string; executions: number; failures: number; successRate: number; p95DurationMs: number }>;
}

export type NativeAlertMetric = 'error_rate' | 'success_rate' | 'p95_latency_ms' | 'total_cost_usd' | 'failure_count' | 'latency_regression_percent' | 'cost_regression_percent';
export type NativeAlertOperator = 'gt' | 'gte' | 'lt' | 'lte';
export type NativeAlertSeverity = 'info' | 'warning' | 'critical';
export type NativeAlertScopeKind = 'all' | 'agent' | 'workflow' | 'model' | 'tool';

export interface NativeAlertAiopsResourceScope {
  kind: 'kubernetes';
  backendId: number;
  targetId: string;
  namespace: string;
}

export interface AgentTemplateDraftInput {
  name: string;
  label: string;
  description: string;
  category: string;
  agentMode: 'chat' | 'worker' | 'reviewer';
  config: AgentTemplate['config'];
  compositeName: string | null;
  skillNames: string[];
  recommendedCapabilities: string[];
  requiredBy: string[];
  requiredToolPatterns: string[];
  minimumBundleCount: number;
}

export interface AgentTemplateDraft {
  name: string;
  definition: AgentTemplateDraftInput;
  baseVersion: number;
  targetVersion: number;
  existingTemplate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplatePreflight {
  templateName: string;
  selectionValid: boolean;
  errors: string[];
  readiness: AgentCapabilityReadiness | null;
}

export interface AgentTemplateFieldDiff {
  field: string;
  baseline: unknown;
  current: unknown;
  target: unknown;
  templateChanged: boolean;
  locallyChanged: boolean;
  conflict: boolean;
}

export interface AgentTemplateUpgradePreview {
  templateName: string;
  templateLabel: string;
  agentId: number;
  installedVersion: number;
  targetVersion: number;
  upgradeAvailable: boolean;
  safeToApply: boolean;
  proposedChanges: AgentTemplateFieldDiff[];
  localChanges: AgentTemplateFieldDiff[];
  conflicts: AgentTemplateFieldDiff[];
}

export interface NativeAlertRuleMutation {
  name: string;
  description: string;
  metric: NativeAlertMetric;
  operator: NativeAlertOperator;
  threshold: number;
  windowMinutes: number;
  minSamples: number;
  severity: NativeAlertSeverity;
  scopeKind: NativeAlertScopeKind;
  scopeValue: string | null;
  cooldownMinutes: number;
  notify: boolean;
  enabled: boolean;
  aiopsAutoInvestigate: boolean;
  aiopsBundleIds: number[];
  aiopsResourceScope: NativeAlertAiopsResourceScope | null;
  aiopsService: string | null;
  aiopsEnvironment: string | null;
}

export interface NativeAlertRule extends NativeAlertRuleMutation {
  id: number;
  lastState: 'ok' | 'firing' | 'no_data';
  lastValue: number | null;
  lastSampleCount: number;
  lastEvaluatedAt: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  openIncidentId: number | null;
}

export interface NativeAlertTemplate {
  id: string;
  name: string;
  description: string;
  category: 'reliability' | 'latency' | 'cost' | 'operations';
  rules: NativeAlertRuleMutation[];
  installedRules: number;
  installed: boolean;
}

export interface NativeAlertIncident {
  id: number;
  ruleId: number;
  ruleName: string;
  state: 'firing' | 'recovered';
  severity: NativeAlertSeverity;
  metricValue: number;
  threshold: number;
  sampleCount: number;
  message: string;
  context: Record<string, unknown> & {
    metric?: NativeAlertMetric;
    operator?: NativeAlertOperator;
    windowMinutes?: number;
    scopeKind?: NativeAlertScopeKind;
    scopeValue?: string | null;
    baseline?: { value: number; currentValue: number; sampleCount: number; windowDays: 7 | 30 } | null;
    exemplars?: NativeAlertExemplar[];
  };
  triggeredAt: string;
  recoveredAt: string | null;
  notifiedAt: string | null;
  correlation: {
    groupId: number;
    correlationKey: string;
    role: 'primary' | 'member';
    groupingReasons: Array<{
      code: 'primary_signal' | 'same_service' | 'same_environment' | 'within_correlation_window';
      summary: string;
      evidence: Record<string, string | number>;
    }>;
    service: string;
    environment: string;
    state: 'firing' | 'recovered';
    severity: NativeAlertSeverity;
    correlationWindowMinutes: number;
    primaryIncidentId: number;
    signalCount: number;
    firstTriggeredAt: string;
    lastSignalAt: string;
    recoveredAt: string | null;
    groupedAt: string;
  } | null;
}

export interface IncidentAiopsInvestigation {
  id: number;
  incidentId: number;
  packId: string;
  agentId: string;
  taskId: string;
  rootTraceId: string | null;
  state: string;
  quality: string | null;
  summary: string | null;
  result: IncidentAiopsResult | null;
  executionContext: {
    bundleIds: number[];
    resourceScope: NativeAlertAiopsResourceScope | null;
    service: string | null;
    environment: string | null;
    serviceProfile: { id: number; revision: number; sha256: string } | null;
    capturedAt: string;
  };
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  statusAvailable: boolean;
}

export type IncidentRemediationExecutionIntent = {
  adapterKey: 'kubernetes.scale.v1';
  workloadKind: 'Deployment' | 'StatefulSet';
  workloadName: string;
  desiredReplicas: number;
} | {
  adapterKey: 'kubernetes.deployment-revision-rollback.v1';
  workloadKind: 'Deployment';
  workloadName: string;
  targetRevision: number;
};

export interface IncidentAiopsResult {
  schemaVersion: 1;
  sourceSchemaVersion: number;
  generatedAt: string | null;
  quality: 'reviewed' | 'partial' | 'failed';
  conclusion: 'confirmed' | 'suspected' | 'inconclusive' | 'refuted';
  executiveAssessment: string;
  rootCause: {
    candidateRef: string | null;
    targetKind: string | null;
    targetName: string | null;
    statement: string;
    confidence: number;
    rationale: string;
  } | null;
  hypotheses: Array<{
    id: string;
    statement: string;
    verdict: 'supported' | 'weakened' | 'unresolved' | 'refuted';
    confidence: number;
    evidenceFor: string[];
    evidenceAgainst: string[];
  }>;
  evidence: Array<{
    lane: 'metrics' | 'logs' | 'traces' | 'runtime' | 'topology' | 'changes' | 'knowledge';
    claim: string;
    sourceRefs: string[];
  }>;
  recommendedActions: Array<{
    priority: 'now' | 'next' | 'later';
    action: string;
    rationale: string;
    requiresApproval: boolean;
    executionIntent?: IncidentRemediationExecutionIntent | null;
  }>;
}

export interface IncidentAiopsInvestigationsResponse {
  incidentId: number;
  total: number;
  investigations: IncidentAiopsInvestigation[];
  automation: NativeAlertAiopsDispatch | null;
  remediations: IncidentRemediation[];
}

export interface IncidentRemediationEvent {
  id: number;
  type: 'proposed' | 'approved' | 'rejected' | 'executed' | 'failed' | 'verified'
      | 'dry_run_started' | 'dry_run_passed' | 'dry_run_failed'
      | 'change_plan_created' | 'change_plan_approved' | 'change_plan_rejected'
      | 'execution_started' | 'execution_succeeded' | 'execution_failed'
      | 'verification_passed' | 'verification_failed'
      | 'rollback_succeeded' | 'rollback_failed'
      | 'post_change_monitor_scheduled' | 'post_change_monitor_started'
      | 'post_change_healthy' | 'post_change_regressed' | 'post_change_check_failed'
      | 'post_change_rollback_approved' | 'post_change_rollback_rejected'
      | 'post_change_rollback_started' | 'post_change_rollback_succeeded'
      | 'post_change_rollback_failed';
  actorUserId: number | null;
  actorUsername: string | null;
  comment: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface IncidentRemediationDryRun {
  id: number;
  remediationId: number;
  bundleId: number;
  toolName: string;
  arguments: Record<string, string | number | boolean>;
  status: 'running' | 'passed' | 'failed';
  executionTraceId: string;
  resultPreview: string | null;
  errorMessage: string | null;
  redactionSummary: Record<string, number>;
  startedBy: number | null;
  startedByUsername: string;
  startedAt: string;
  completedAt: string | null;
}

export interface IncidentRemediationExecutorParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string;
  suggestedValue?: string | number | boolean;
  valueSource: 'incident' | 'default' | null;
  locked: boolean;
}

export interface IncidentRemediationExecutorCandidate {
  bundleId: number;
  bundleName: string;
  bundleLabel: string;
  toolName: string;
  description: string;
  backend: string;
  category: string | null;
  executorKind: 'native_read' | 'dynamic_get';
  parameters: IncidentRemediationExecutorParameter[];
  suggestedArguments: Record<string, string | number | boolean>;
  missingRequiredArguments: string[];
}

export interface IncidentRemediationExecutorCandidatesResponse {
  incidentId: number;
  remediationId: number;
  total: number;
  candidates: IncidentRemediationExecutorCandidate[];
}

export interface IncidentRemediationWriteAdapterCandidate {
  adapterKey: IncidentRemediationExecutionIntent['adapterKey'];
  label: string;
  description: string;
  controls: {
    riskLevel: 'high';
    planApproval: 'hash_bound';
    verification: 'read_after_write';
    rollback: 'verified_restore';
    postChangeMonitoring: true;
    productionSeparationOfDuties: true;
  };
  status: 'ready' | 'unavailable';
  reason: string | null;
  bundleId: number | null;
  bundleLabel: string | null;
  writeBackendId: number | null;
  writeBackendName: string | null;
  writeToolName: string | null;
  target: {
    backendId: number;
    targetId: string;
    cluster: string;
    namespace: string;
    environment: string;
  } | null;
  workloadKinds: Array<'Deployment' | 'StatefulSet'>;
  replicas: { minimum: 1; maximum: 50 } | null;
  intent: IncidentRemediationExecutionIntent | null;
}

export interface IncidentRemediationWriteAdaptersResponse {
  incidentId: number;
  remediationId: number;
  total: number;
  adapters: IncidentRemediationWriteAdapterCandidate[];
}

export interface IncidentRemediationChangePlan {
  id: number;
  remediationId: number;
  adapterKey: string;
  bundleId: number;
  writeBackendId: number;
  writeToolName: string;
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'executing' | 'verified' | 'failed' | 'rolled_back' | 'rollback_failed';
  version: number;
  planHash: string;
  targetScope: Record<string, unknown>;
  preview: { format: string; summary: string; lines: string[]; rollbackSummary: string };
  writeArguments: Record<string, unknown>;
  verifyArguments: Record<string, unknown>;
  rollbackArguments: Record<string, unknown>;
  adapterState: Record<string, unknown>;
  previousReplicas: number | null;
  desiredReplicas: number | null;
  createdBy: number | null;
  createdByUsername: string;
  approvedBy: number | null;
  approvedByUsername: string | null;
  approvalComment: string | null;
  approvedAt: string | null;
  executionTraceId: string | null;
  executionResult: string | null;
  executionError: string | null;
  executedAt: string | null;
  verificationTraceId: string | null;
  verificationResult: string | null;
  verificationError: string | null;
  verifiedAt: string | null;
  rollbackTraceId: string | null;
  rollbackResult: string | null;
  rollbackError: string | null;
  rolledBackAt: string | null;
  createdAt: string;
  updatedAt: string;
  postChangeMonitor: IncidentRemediationPostChangeMonitor | null;
}

export interface IncidentRemediationPostChangeMonitor {
  id: number;
  remediationId: number;
  planId: number;
  status: 'scheduled' | 'checking' | 'healthy' | 'regression_detected' | 'check_failed'
    | 'rollback_approved' | 'rollback_rejected' | 'rolling_back' | 'rolled_back' | 'rollback_failed';
  version: number;
  rollbackHash: string;
  scheduledFor: string;
  observationTraceId: string | null;
  observedReplicas: number | null;
  observedState: Record<string, unknown> | null;
  observationResult: string | null;
  observationError: string | null;
  observedAt: string | null;
  decidedBy: number | null;
  decidedByUsername: string | null;
  decisionComment: string | null;
  decidedAt: string | null;
  rollbackTraceId: string | null;
  rollbackResult: string | null;
  rollbackError: string | null;
  rolledBackAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentRemediation {
  id: number;
  incidentId: number;
  taskLinkId: number;
  taskId: string;
  rootTraceId: string | null;
  sourceActionIndex: number;
  priority: 'now' | 'next' | 'later';
  action: string;
  rationale: string;
  requiresApproval: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  executionMode: 'proposal_only' | 'dry_run' | 'governed_write';
  executorBundleId: number | null;
  executorToolName: string | null;
  targetScope: Record<string, unknown> | null;
  executionIntent: IncidentRemediationExecutionIntent | null;
  status: 'proposed' | 'approved' | 'rejected' | 'executed' | 'failed' | 'verified';
  version: number;
  createdBy: number | null;
  decidedBy: number | null;
  decidedByUsername: string | null;
  decisionComment: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: IncidentRemediationEvent[];
  dryRuns: IncidentRemediationDryRun[];
  changePlans: IncidentRemediationChangePlan[];
}

export interface NativeAlertAiopsDispatch {
  id: number;
  incidentId: number;
  ruleId: number;
  status: 'pending' | 'dispatching' | 'started' | 'blocked' | 'failed' | 'skipped';
  bundleIds: number[];
  resourceScope: NativeAlertAiopsResourceScope | null;
  service: string;
  environment: string;
  serviceProfile: { id: number; revision: number; sha256: string } | null;
  attemptCount: number;
  availableAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
  taskLinkId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeAlertExemplar {
  rootTraceId: string;
  traceId: string;
  spanId: string | null;
  runKind: 'agent' | 'workflow';
  title: string;
  startedAt: string;
  durationMs: number;
  costUsd: number;
  dominantSpanLabel: string | null;
  href: string;
}

export type IncidentChangeKind = 'agent' | 'workflow' | 'model' | 'capability' | 'connection' | 'access' | 'configuration';
export type IncidentChangeRelevance = 'direct' | 'contextual' | 'temporal';

export interface IncidentChangeCorrelation {
  id: number;
  kind: IncidentChangeKind;
  relevance: IncidentChangeRelevance;
  action: string;
  objectType: string;
  objectId: string;
  objectLabel: string;
  actor: string;
  occurredAt: string;
  minutesFromTrigger: number;
  phase: 'before' | 'during' | 'after';
  changedFields: string[];
  reason: string;
}

export interface IncidentChangeCorrelationResponse {
  incidentId: number;
  generatedAt: string;
  window: { hoursBefore: number; minutesAfter: number };
  changes: IncidentChangeCorrelation[];
  summary: { total: number; direct: number; contextual: number; temporal: number };
}

export interface NativeAlertsResponse {
  generatedAt: string;
  rules: NativeAlertRule[];
  incidents: NativeAlertIncident[];
  templates: NativeAlertTemplate[];
  summary: { enabledRules: number; firingRules: number; incidents24h: number; recovered24h: number };
}

export type IncidentAiopsFeedbackVerdict = 'helpful' | 'partial' | 'incorrect';
export type IncidentAiopsFeedbackReason = 'accurate_root_cause' | 'useful_evidence' | 'incomplete_evidence'
  | 'missing_context' | 'incorrect_root_cause' | 'stale_evidence' | 'unsafe_recommendation' | 'other';

export interface IncidentAiopsFeedbackReview {
  id: number;
  incidentId: number;
  taskLinkId: number;
  taskId: string;
  rootTraceId: string;
  verdict: IncidentAiopsFeedbackVerdict;
  reason: IncidentAiopsFeedbackReason;
  comment: string | null;
  reviewer: { id: number | null; name: string | null };
  serviceProfile: { id: number; revision: number; sha256: string } | null;
  supersedesId: number | null;
  createdAt: string;
}

export interface IncidentAiopsFeedbackResponse {
  generatedAt: string;
  incidentId: number;
  taskLinkId: number;
  taskId: string;
  rootTraceId: string;
  serviceProfile: { id: number; revision: number; sha256: string } | null;
  currentUserFeedback: IncidentAiopsFeedbackReview | null;
  feedback: IncidentAiopsFeedbackReview[];
  summary: {
    reviews: number;
    helpful: number;
    partial: number;
    incorrect: number;
    helpfulPercent: number | null;
    reviewedAt: string | null;
  };
}

export interface IncidentAiopsFeedbackMutation {
  verdict: IncidentAiopsFeedbackVerdict;
  reason: IncidentAiopsFeedbackReason;
  comment?: string | null;
}

export interface IncidentAiopsFeedbackMutationResponse extends IncidentAiopsFeedbackResponse {
  submitted: IncidentAiopsFeedbackReview;
  auditEvent: { eventId: string; sequence: number };
  replayed: boolean;
}

export interface AiopsOutcomeResponse {
  schemaVersion: 1;
  generatedAt: string;
  window: { days: number; from: string; to: string };
  signals: { total: number; native: number; provider: number; providerDeliveries: number };
  incidents: {
    actionable: number;
    firing: number;
    recovered: number;
    correlated: number;
    standalone: number;
    suppressedSignals: number;
    compressionRatio: number;
    medianRecoveryMs: number | null;
    p95RecoveryMs: number | null;
  };
  investigations: {
    started: number;
    completed: number;
    partial: number;
    failed: number;
    blocked: number;
    active: number;
    coveragePercent: number;
    completionRatePercent: number;
    medianTimeToStartMs: number | null;
    medianTimeToCompleteMs: number | null;
  };
  rootCause: { confirmed: number; suspected: number; refuted: number; inconclusive: number };
  remediations: {
    proposed: number;
    approved: number;
    awaitingApproval: number;
    executed: number;
    verified: number;
    failed: number;
    rolledBack: number;
    successRatePercent: number;
    postChangeHealthy: number;
    postChangeRegressed: number;
  };
  recurrence: { servicesWithRepeatIncidents: number; repeatIncidents: number };
  topServices: Array<{
    service: string;
    environment: string;
    incidents: number;
    signals: number;
    firing: number;
    recovered: number;
    medianRecoveryMs: number | null;
  }>;
  profileAttribution: {
    profileBoundInvestigations: number;
    telemetryLinkedInvestigations: number;
    totalTokens: number;
    recordedCostUsd: number;
    reviewedInvestigations: number;
    reviews: number;
    helpful: number;
    partial: number;
    incorrect: number;
    helpfulPercent: number;
    truncated: boolean;
    profiles: Array<{
      profile: {
        id: number;
        revision: number;
        sha256: string;
        displayName: string;
        service: string;
        environment: string;
      };
      investigations: number;
      completedInvestigations: number;
      evidence: {
        assessedInvestigations: number;
        investigationsMeetingPolicy: number;
        policyCoveragePercent: number;
        minimumCollectedLanes: number;
        configuredLanes: number;
        requiredLanes: number;
        optionalLanes: number;
        lanes: Array<{
          lane: 'metrics' | 'logs' | 'traces' | 'runtime' | 'topology' | 'changes' | 'knowledge' | 'incident';
          requirement: 'required' | 'optional';
          investigationsWithEvidence: number;
          coveragePercent: number;
          claims: number;
        }>;
      };
      usage: {
        telemetryLinkedInvestigations: number;
        tokenAttributedInvestigations: number;
        costAttributedInvestigations: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        recordedCostUsd: number;
        averageTokensPerInvestigation: number;
        averageRecordedCostUsdPerInvestigation: number;
      };
      feedback: {
        reviewedInvestigations: number;
        reviews: number;
        helpful: number;
        partial: number;
        incorrect: number;
        helpfulPercent: number;
      };
    }>;
  };
  graph: {
    nodes: Array<{
      id: string;
      kind: 'service' | 'database' | 'messaging' | 'external';
      label: string;
      environment: string;
      incidents: number;
      signals: number;
      firing: number;
      incidentIds: number[];
      providerLinks: Array<{
        provider: string;
        monitorRef: string;
        incidentId: number;
        observedAt: string;
        incidentHref: string;
        externalHref: string | null;
      }>;
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      relation: 'calls' | 'queries' | 'publishes';
      calls: number;
      failures: number;
      failureRate: number;
      p95DurationMs: number | null;
      lastSeenAt: string;
      evidence: 'observed' | 'causal_candidate';
      confidence: 'high' | 'medium' | 'low' | null;
    }>;
    truncated: { nodes: boolean; edges: boolean };
  };
}

export type IncidentImpactDirection = 'upstream' | 'downstream';

export interface IncidentImpactDependency {
  sourceService: string;
  targetKind: 'service' | 'database' | 'messaging' | 'external';
  targetName: string;
  relation: 'calls' | 'queries' | 'publishes';
  direction: IncidentImpactDirection;
  depth: number;
  path: string[];
  calls: number;
  failures: number;
  failureRate: number;
  p95DurationMs: number | null;
  lastSeenAt: string;
}

export interface IncidentImpactResponse {
  incidentId: number;
  generatedAt: string;
  available: boolean;
  reason: string | null;
  service: string | null;
  environment: string | null;
  window: { minutesBefore: number; minutesAfter: number };
  summary: {
    upstreamServices: number;
    downstreamServices: number;
    externalDependencies: number;
    failingDependencies: number;
    observedCalls: number;
    observedFailures: number;
  };
  impactedServices: Array<{
    service: string;
    direction: IncidentImpactDirection;
    depth: number;
    path: string[];
  }>;
  dependencies: IncidentImpactDependency[];
  rootCauseCandidates: Array<IncidentImpactDependency & {
    confidence: 'high' | 'medium' | 'low';
    reason: string;
  }>;
}

export type NativeServiceCatalogSource = 'kubernetes' | 'opentelemetry' | 'logs' | 'alert_rule';

export interface NativeServiceCatalogTarget {
  backendId: number;
  targetId: string;
  cluster: string;
  namespace: string;
  workloads: Array<{ kind: string; name: string }>;
  lastSeenAt: string;
  current: boolean;
}

export interface NativeServiceCatalogEntry {
  id: string;
  serviceName: string;
  environment: string;
  sources: NativeServiceCatalogSource[];
  targets: NativeServiceCatalogTarget[];
  lastSeenAt: string;
  current: boolean;
  evidenceCount: number;
}

export interface NativeServiceCatalogResponse {
  generatedAt: string;
  entries: NativeServiceCatalogEntry[];
  summary: { services: number; current: number; kubernetes: number; opentelemetry: number; logs: number; configured: number };
}

export interface NativeServiceCatalogRefreshInput {
  bundleId: number;
  resourceScope: NativeAlertAiopsResourceScope;
}

export interface NativeServiceCatalogRefreshResponse extends NativeServiceCatalogResponse {
  refresh: { discovered: number; dependencies: number; sources: string[]; warnings: string[] };
}

export type NativeServiceHealthState = 'healthy' | 'degraded' | 'critical' | 'no_data';
export type NativeSloState = 'met' | 'breached' | 'no_data';
export type NativeConfiguredSloState = NativeSloState | 'disabled';
export type NativeSloMetric = 'success_rate' | 'p95_latency_ms';

export interface NativeSloMutation {
  name: string;
  description: string;
  metric: NativeSloMetric;
  target: number;
  windowMinutes: number;
  minSamples: number;
  scopeKind: NativeAlertScopeKind;
  scopeValue: string | null;
  enabled: boolean;
}

export interface NativeSlo extends NativeSloMutation {
  id: number;
  createdAt: string;
  updatedAt: string;
  evaluation: {
    state: NativeConfiguredSloState;
    actual: number | null;
    sampleCount: number;
    errorBudgetRemainingPercent: number | null;
    burnRate: number | null;
    evaluatedAt: string;
  };
}

export interface NativeSlosResponse {
  generatedAt: string;
  slos: NativeSlo[];
  summary: { enabled: number; met: number; breached: number; noData: number };
}

export interface NativeServiceHealthResponse {
  generatedAt: string;
  hours: number;
  state: NativeServiceHealthState;
  score: number | null;
  summary: {
    totalExecutions: number;
    successRate: number;
    p95DurationMs: number;
    totalCostUsd: number;
    firingIncidents: number;
    criticalIncidents: number;
  };
  errorBudget: {
    objective: number;
    terminalExecutions: number;
    allowedFailures: number;
    actualFailures: number;
    remainingPercent: number;
    state: NativeSloState;
  };
  slos: Array<{
    id: 'reliability' | 'latency' | 'incidents';
    name: string;
    state: NativeSloState;
    target: string;
    actual: string;
    description: string;
  }>;
  components: Array<{
    id: string;
    kind: 'agent' | 'workflow' | 'model' | 'tool';
    name: string;
    detail: string;
    state: NativeServiceHealthState;
    executions: number;
    failures: number;
    successRate: number;
    p95DurationMs: number;
    costUsd: number;
  }>;
  openIncidents: NativeAlertIncident[];
  customSlos: NativeSlo[];
  recommendations: Array<{
    severity: 'info' | 'warning' | 'critical';
    title: string;
    description: string;
    href: string;
  }>;
}

export type SyntheticCanaryStatus = 'ok' | 'failed' | 'timeout' | 'error';
export type SyntheticCanaryOperationsState = 'disabled' | 'not_configured' | 'no_data' | 'healthy' | 'degraded' | 'running';

export interface SyntheticCanaryConfig {
  enabled: boolean;
  intervalMinutes: number;
  timeoutSeconds: number;
  retentionDays: number;
  agentIds: number[];
  source: 'database' | 'environment';
  updatedAt: string | null;
  credentialConfigured: boolean;
  targetMode: 'automatic' | 'selected';
}

export interface SyntheticCanaryOperationsResponse {
  generatedAt: string;
  config: SyntheticCanaryConfig;
  state: {
    status: SyntheticCanaryOperationsState;
    totalTargets: number;
    passingTargets: number;
    failingTargets: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
    running: boolean;
  };
  availableAgents: Array<{ id: number; name: string; label: string }>;
  canaries: Array<{
    agentId: number;
    agentName: string;
    total: number;
    okCount: number;
    failCount: number;
    successRate: number;
    p95LatencyMs: number;
    lastStatus: SyntheticCanaryStatus | null;
    lastAt: string | null;
  }>;
  history: Array<{
    id: number;
    agentId: number;
    agentName: string;
    timestamp: string;
    completedAt: string;
    status: SyntheticCanaryStatus;
    latencyMs: number;
    errorMessage?: string;
    source: 'scheduled' | 'manual';
    triggeredBy: string | null;
  }>;
}

export interface SyntheticCanaryConfigMutation {
  enabled: boolean;
  intervalMinutes: number;
  timeoutSeconds: number;
  retentionDays: number;
  agentIds: number[];
}

export interface SyntheticCanaryRunResponse {
  results: Array<{
    agentId: number;
    agentName: string;
    timestamp: string;
    status: SyntheticCanaryStatus;
    latencyMs: number;
    errorMessage?: string;
  }>;
  operations: SyntheticCanaryOperationsResponse;
}

export type CiProviderCanaryStatus = 'ok' | 'failed' | 'timeout' | 'error';
export type CiProviderCanaryOperationsState = 'no_data' | 'healthy' | 'degraded';

export interface CiProviderCanaryRunRecord {
  id: number;
  provider: 'gitea' | 'github' | 'gitlab' | 'jenkins';
  externalId: string;
  status: CiProviderCanaryStatus;
  httpStatus: number | null;
  latencyMs: number;
  providerStatus: string | null;
  errorMessage: string | null;
  source: 'manual' | 'scheduled' | 'internal';
  triggeredBy: string | null;
  startedAt: string;
  completedAt: string;
}

export interface CiProviderCanaryOperationsResponse {
  generatedAt: string;
  state: {
    status: CiProviderCanaryOperationsState;
    totalRuns: number;
    passingRuns: number;
    failingRuns: number;
    lastRunAt: string | null;
  };
  history: CiProviderCanaryRunRecord[];
}

export interface CiProviderCanaryRunResponse {
  results: CiProviderCanaryRunRecord[];
  operations: CiProviderCanaryOperationsResponse;
}

export type NativeDependencyNodeKind = 'workflow' | 'agent' | 'model' | 'tool' | 'knowledge';

export interface NativeDependencyMapResponse {
  generatedAt: string;
  hours: number;
  nodes: Array<{
    id: string;
    kind: NativeDependencyNodeKind;
    name: string;
    detail: string;
    state: NativeServiceHealthState;
    calls: number;
    failures: number;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    relation: 'invokes' | 'calls' | 'uses' | 'queries';
    evidence: 'configured' | 'observed' | 'both';
    calls: number;
    failures: number;
  }>;
  summary: { nodes: number; edges: number; configuredEdges: number; observedEdges: number; unhealthyNodes: number };
}

export interface ActiveToolCall {
  id: string;
  name: string;
  args: unknown;
  startedAt: number;
  finishedAt?: number;
  isError?: boolean;
  previewTrunc?: string;
}

export interface ActiveSession {
  sessionId: string;
  agentId: number;
  agentName: string;
  agentMode: 'chat' | 'worker' | 'reviewer' | string;
  callingUserId?: number;
  startedAt: number;
  lastActivityAt: number;
  iteration: number;
  status: 'thinking' | 'tool-call' | 'streaming' | 'done' | 'error';
  toolCalls: ActiveToolCall[];
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  lastMessage?: string;
  errorMessage?: string;
}

export interface LiveActivityResponse {
  sessions: ActiveSession[];
  counts: { total: number; thinking: number; tool: number; streaming: number; done: number; error: number };
  ts: number;
}

export interface AuditLogEntry {
  id: number;
  timestamp: string;
  api_key_prefix: string | null;
  tool: string;
  param_summary: string | null;
  duration_ms: number;
  result_size: number;
  is_error: boolean;
  error_message: string | null;
}

export interface AuditEntriesResponse {
  entries: AuditLogEntry[];
  total: number;
}

export interface AuditStatsResponse {
  totalCalls: number;
  errorCount: number;
  errorRate: number;
  avgDuration: number;
  topTools: Array<{ tool: string; count: number; avg_duration: number }>;
  topApiKeys: Array<{ api_key_prefix: string; count: number }>;
  callsPerHour: Array<{ hour: string; count: number; errors: number }>;
}

export interface AgentRuntimeProfileMutation {
  name: string;
  label: string;
  description: string;
  runtimeType: 'argus' | 'codex' | 'claude-code';
  model: string | null;
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  enabled: boolean;
  maxConcurrentRuns: number;
  allowedTaskTypes: string[];
  codeContextMode: 'metadata_only' | 'bounded_source';
  codeContextMaxResults: number;
  codeContextMaxBytes: number;
}

export type CanonicalAuditOutcome = 'success' | 'failure' | 'denied' | 'cancelled';
export type CanonicalAuditRisk = 'low' | 'medium' | 'high' | 'critical';

export interface CanonicalAuditEvidenceItem {
  id: string;
  occurredAt: string;
  receivedAt: string;
  environment: string;
  solution: string | null;
  actor: { type: 'human' | 'service' | 'system'; id: string; ssoSubject: string | null; authMethod: string; effectiveRoles: string[] };
  action: string;
  outcome: CanonicalAuditOutcome;
  risk: CanonicalAuditRisk;
  policy: { id: string | null; version: string | null; decision: string | null };
  approval: { id: string | null; href: string | null };
  resource: { type: string; id: string; label: string; href: string | null; version: string | null; tags: Array<{ id: string; name: string; color: string }> };
  correlation: { rootRunId: string | null; traceId: string | null; spanId: string | null; requestId: string | null; rootRunHref: string | null; logsHref: string | null };
  digests: { payload: string; before: string | null; after: string | null; redactionProfile: string };
  integrity: { sequence: number; previousHash: string; hash: string; hashState: 'event_hash_valid' | 'event_hash_invalid'; signingKeyId: string | null; checkpointId: string | null };
  retention: { class: string; until: string | null; legalHold: boolean };
  summary: string;
}

export interface CanonicalAuditEvidencePage {
  schemaVersion: 1;
  generatedAt: string;
  verification: { state: 'event_hashes_valid' | 'event_hashes_and_checkpoint_valid' | 'integrity_failure' | 'not_applicable'; checkpointId: string | null; checkedAt: string };
  coverage: { canonicalProducerFamilies: string[]; legacyGaps: Array<{ code: string; description: string }> };
  items: CanonicalAuditEvidenceItem[];
  nextCursor: string | null;
  export: { allowed: boolean; state: 'available' | 'not_authorized'; formats: Array<'json' | 'jsonl' | 'csv'>; requiresStepUp: boolean };
}

export type AuditReportType = 'governance' | 'compliance' | 'run_evidence' | 'incident';
export type AuditReportCadence = 'manual' | 'daily' | 'weekly' | 'monthly';
export type ExternalEvidenceAnchorKind = 'worm_object' | 'qualified_timestamp' | 'transparency_log';
export interface ExternalEvidenceAnchor {
  schemaVersion: 1; kind: 'argus.external-evidence-anchor'; anchorId: string; reportRunId: string;
  scope: { workspaceKey: string; tenantKey: string; environment: string };
  packId: string; packSha256: string; anchorKind: ExternalEvidenceAnchorKind; provider: string; reference: string;
  anchoredAt: string; retentionUntil: string | null; statementSha256: string; receiptSha256: string;
  verificationKeyId: string; verificationKeyFingerprint: string; verification: 'verified'; createdAt: string;
}
export interface AuditReportDefinition {
  id: string; environment: string; name: string; reportType: AuditReportType; cadence: AuditReportCadence; timezone: string;
  scheduleHour: number; scheduleWeekday: number | null; scheduleMonthday: number | null; windowDays: number;
  filters: Record<string, string | null>; formats: Array<'pdf' | 'json' | 'jsonl' | 'csv'>; enabled: boolean;
  createdBy: string; createdAt: string; updatedAt: string; nextRunAt: string | null; lastRunAt: string | null; disabledAt: string | null;
}
export interface AuditReportRun {
  id: string; definitionId: string | null; environment: string; reportType: AuditReportType; name: string;
  triggerType: 'manual' | 'scheduled' | 'event'; requestedBy: string; status: 'queued' | 'running' | 'completed' | 'failed';
  periodFrom: string; periodTo: string; filters: Record<string, string | null>; checkpointId: string | null; packId: string | null;
  packDigest: string | null; verificationState: 'valid' | 'invalid' | null; eventCount: number; chainEntryCount: number; gapCodes: string[];
  summary: { title: string; eventCount: number; actorCount: number; successCount: number; deniedCount: number; failureCount: number; criticalRiskCount: number; topActions: Array<{ action: string; count: number }> } | null;
  errorCode: string | null; errorMessage: string | null; startedAt: string | null; completedAt: string | null; createdAt: string;
  reviews: Array<{ id: string; decision: 'approved' | 'rejected' | 'superseded'; actorId: string; actorAuthMethod: string; occurredAt: string; auditEventId: string }>;
  externalAnchors: ExternalEvidenceAnchor[];
}
export interface AuditReportCatalog {
  readiness: { enabled: boolean; signingConfigured: boolean; canonicalEventCount: number; checkpointCount: number; environments: string[]; ready: boolean };
  exportSecurity: { requiresFreshMfa: boolean; satisfied: boolean; maxAgeSeconds: number; stepUpUrl: string };
  externalAnchoring: { enabled: boolean; provider: string | null; supportedKinds: ExternalEvidenceAnchorKind[]; requiresFreshMfa: boolean };
  definitions: AuditReportDefinition[];
  runs: AuditReportRun[];
}

export type AuditRetentionBlockerCode = 'empty' | 'legal_hold' | 'not_due' | 'indefinite' | 'batch_limit' | 'checkpoint_boundary';
export type AuditRetentionPlanStatus = 'planned' | 'approved' | 'rejected' | 'archive_verified' | 'purge_executed' | 'failed';
export interface AuditRetentionArchive {
  archiveId: string; planId: string; checkpointId: string; checkpointDigest: string; manifestSha256: string;
  packageSha256: string; packageBytes: number; eventCount: number; firstSequence: number; lastSequence: number;
  lastEventHash: string; provider: string; reference: string; archivedAt: string; retentionUntil: string;
  statementSha256: string; receiptSha256: string; verificationKeyId: string; verificationKeyFingerprint: string;
  verification: 'verified'; requestedById: string; createdAt: string;
  restoreDrills: AuditRetentionRestoreDrill[];
  segment: AuditRetentionChainSegment | null;
}
export interface AuditRetentionRestoreDrill {
  drillId: string; archiveId: string; provider: string; reference: string;
  packageSha256: string; receiptSha256: string; checkpointDigest: string;
  eventCount: number; firstSequence: number; lastSequence: number; lastEventHash: string;
  retrievedBytes: number; retrievedAt: string; verifiedAt: string; durationMs: number;
  verificationStatus: 'verified'; requestedById: string; createdAt: string;
  verification: {
    receipt: 'signature_valid'; package: 'sha256_valid'; checkpoint: 'signature_valid';
    eventChain: 'complete_and_valid'; wormRetention: 'active'; purgeAuthorized: false;
  };
}
export interface AuditRetentionChainSegment {
  segmentId: string; segmentOrdinal: number; previousSegmentId: string | null; previousSegmentDigest: string;
  archiveId: string; restoreDrillId: string; firstSequence: number; lastSequence: number; eventCount: number;
  firstPreviousHash: string; lastEventHash: string; continuationSequence: number; continuationPreviousHash: string;
  checkpointId: string; checkpointDigest: string; archivePackageSha256: string; archiveReceiptSha256: string;
  segmentDigest: string; sealedAt: string; requestedById: string; createdAt: string;
  verification: {
    archive: 'worm_receipt_verified'; restoreDrill: 'full_download_verified'; sourceBoundary: 'canonical_chain_verified';
    continuation: 'hash_anchored'; purgeAuthorized: false;
  };
}
export interface AuditRetentionPlan {
  planId: string; environment: string; retentionClass: 'all-classes'; checkpointId: string; checkpointDigest: string;
  throughSequence: number; evaluatedAt: string; eligiblePrefixCount: number; firstSequence: number | null; lastSequence: number | null;
  blocker: { code: AuditRetentionBlockerCode; sequence: number | null }; manifestSha256: string;
  manifest: {
    schemaVersion: 1; mode: 'dry_run'; evaluatedAt: string; purgeAllowed: false;
    eligibleEvents: Array<{ eventId: string; sequence: number; retentionClass: string; retentionUntil: string; region: string | null }>;
    nextRequiredAction: 'none' | 'independent_approval_then_archive';
  };
  manifestEventsIncluded?: boolean;
  requestedById: string; requesterSsoSubject: string; mfaVerifiedAt: string; mfaMethod: string;
  producerEventId: string; createdAt: string; status: AuditRetentionPlanStatus;
  archive?: AuditRetentionArchive | null;
}
export interface AuditRetentionPlanCatalog {
  schemaVersion: 1;
  readiness: {
    mode: 'archive_first'; purgeEnabled: false; signerConfigured: boolean;
    requiresFreshMfa: true; requiresIndependentApproval: true; requiresExternalArchiveAnchor: true;
    externalArchiveConfigured: boolean; externalArchiveProvider: string | null; restoreDrillConfigured: boolean;
    offlineVerifierAvailable: boolean; segmentSealingEnabled: boolean;
  };
  operationSecurity: { requiresFreshMfa: true; satisfied: boolean; maxAgeSeconds: number; stepUpUrl: string };
  plans: AuditRetentionPlan[];
}

export type AiSystemLifecycleState = 'not_assessed' | 'assessment_in_progress' | 'blocked' | 'controls_incomplete' | 'ready_for_independent_review' | 'externally_assessed' | 'released' | 'suspended' | 'retired';
export type AiSystemClassification = 'assessment_required' | 'prohibited' | 'high_risk' | 'limited_transparency' | 'minimal_or_no_risk' | 'out_of_scope';
export interface AiSystemRegistryItem {
  aiSystemId: string; revisionId: string; revision: number; revisionSha256: string; displayName: string;
  lifecycleState: AiSystemLifecycleState; classification: AiSystemClassification;
  owner: { actorType: 'user' | 'service' | 'system' | 'external_reviewer'; actorId: string; displayName?: string };
  marketRoles: string[]; componentCount: number; createdAt: string; releasedAt: string | null;
  tags: Array<{ id: string | number; name: string; color: string }>;
  allowedActions: string[];
}
export interface AiSystemRegistryCatalog {
  schemaVersion: 1;
  kind: 'ai-system-registry-list';
  aiSystems: AiSystemRegistryItem[];
  claimBoundary: string;
}

export type AiSystemMarketRole = 'provider' | 'deployer' | 'importer' | 'distributor' | 'authorised_representative' | 'product_manufacturer' | 'data_controller' | 'data_processor';
export type AiSystemComponentType = 'agent' | 'workflow' | 'model' | 'runtime_profile' | 'mcp_bundle' | 'skill' | 'knowledge_source' | 'dataset';
export interface AiSystemActorRef {
  actorType: 'user' | 'service' | 'system' | 'external_reviewer';
  actorId: string;
  displayName?: string;
}
export interface AiSystemComponentBinding {
  resourceType: AiSystemComponentType;
  resourceId: string;
  revision: string;
  sha256: string;
}
export interface AiSystemMarketRoleAssignment {
  role: AiSystemMarketRole;
  organisationId: string;
  organisationName: string;
  rationale: string;
  confirmedBy?: AiSystemActorRef;
  confirmedAt?: string;
}
export interface AiSystemClassificationRecord {
  assessmentId?: string;
  classification: AiSystemClassification;
  articleRefs: string[];
  annexRefs: string[];
  highRiskBasis?: string;
  rationale: string;
  legalReviewRequired: boolean;
  assessedBy?: AiSystemActorRef;
  assessedAt?: string;
  nextReviewAt: string;
}
export interface AiSystemRevision {
  schemaVersion: 1;
  kind: 'ai-system-revision';
  aiSystemId: string;
  revisionId: string;
  revision: number;
  revisionSha256: string;
  displayName: string;
  lifecycleState: AiSystemLifecycleState;
  owner: AiSystemActorRef;
  intendedPurpose: string;
  prohibitedUses: string[];
  targetUsers: string[];
  affectedGroups: string[];
  regions: string[];
  marketRoles: AiSystemMarketRoleAssignment[];
  prohibitedPracticeCheck: { decision: 'clear' | 'blocked' | 'external_review_required'; articleRefs: string[]; rationale: string; decidedBy?: AiSystemActorRef; decidedAt?: string };
  classification: AiSystemClassificationRecord;
  componentBindings: AiSystemComponentBinding[];
  dataCategories: string[];
  controlCatalog: { catalogId: string; catalogVersion: number; catalogSha256: string };
  createdAt: string;
  releasedAt: string | null;
}
export interface AiSystemReadinessStep {
  stepId: string;
  title: string;
  status: 'not_started' | 'in_progress' | 'complete' | 'blocked' | 'external_review_required';
  blocking: boolean;
  issues: string[];
  action: { label: string; href: string } | null;
}
export interface AiSystemRegistrationReadiness {
  schemaVersion: 1;
  kind: 'ai-system-registration-readiness';
  aiSystemId: string;
  revisionId: string;
  state: AiSystemLifecycleState;
  generatedAt: string;
  evidenceCoverage: { applicable: number; satisfied: number; blocked: number; notAssessed: number; expiring: number };
  steps: AiSystemReadinessStep[];
  customerResponsibilities: Array<{ responsibilityId: string; title: string; ownerRole: 'provider' | 'deployer' | 'external_assessor'; status: 'open' | 'provided' | 'verified'; dueAt: string | null }>;
  allowedActions: string[];
  claimBoundary: string;
}
export interface AiSystemRegistryDetail {
  schemaVersion: 1;
  kind: 'ai-system-registry-detail';
  aiSystem: { revision: AiSystemRevision; tags: AiSystemRegistryItem['tags']; allowedActions: string[]; readiness: AiSystemRegistrationReadiness };
  auditEventId?: string;
  decisionId?: string;
  replayed?: boolean;
}
export interface AiSystemCreateInput {
  displayName: string;
  intendedPurpose: string;
  prohibitedUses: string[];
  targetUsers: string[];
  affectedGroups: string[];
  regions: string[];
  marketRoles: Array<Omit<AiSystemMarketRoleAssignment, 'confirmedBy' | 'confirmedAt'>>;
  prohibitedPracticeCheck: { decision: 'clear' | 'blocked' | 'external_review_required'; articleRefs: string[]; rationale: string };
  classification: AiSystemClassificationRecord;
  componentBindings: AiSystemComponentBinding[];
  dataCategories: string[];
  controlCatalog: AiSystemRevision['controlCatalog'];
}
export interface AiSystemClassificationInput {
  expectedRevision: number;
  expectedRevisionSha256: string;
  prohibitedPracticeCheck: AiSystemCreateInput['prohibitedPracticeCheck'];
  classification: AiSystemClassificationRecord;
}
export interface AiSystemReleaseInput {
  expectedRevision: number;
  expectedRevisionSha256: string;
  decisionRationale: string;
  evidence: Array<{ evidenceType: 'canonical_event' | 'report' | 'evidence_pack'; evidenceId: string; sha256: string; href?: string }>;
}

export type AiSystemControlStatus = 'not_assessed' | 'in_progress' | 'satisfied' | 'exception' | 'not_applicable';
export interface AiActControlDefinition {
  controlId: string;
  articleRefs: string[];
  title: string;
  description: string;
  applicability: 'always' | 'high_risk' | 'conditional';
  enforcement: 'technical' | 'organisational' | 'hybrid';
  blocksProduction: boolean;
  evidenceKinds: string[];
  responsibilities: Array<{ party: 'argus_platform' | 'provider' | 'deployer' | 'external_assessor'; responsibility: string; required: boolean }>;
  customerInputs: string[];
}
export interface AiActControlCatalog {
  schemaVersion: 1;
  kind: 'ai-act-control-catalog';
  catalogId: string;
  catalogVersion: number;
  catalogSha256: string;
  effectiveFrom: string;
  legalSource: { regulation: string; title: string; url: string };
  claimBoundary: string;
  controls: AiActControlDefinition[];
}
export interface AiSystemControlEvidence {
  evidenceType: 'canonical_event' | 'report' | 'evidence_pack';
  evidenceId: string;
  sha256: string;
  href?: string;
}

export type RunStatusV2 =
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_external'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'cancelled'
  | 'stale'
  | 'unknown';

export type RunDisplayStatus = 'active' | 'waiting' | 'action_required' | 'succeeded' | 'failed' | 'cancelled' | 'stale';
export type RunAllowedAction = 'open' | 'cancel' | 'review_approval';
export type RunEvidenceCompleteness = 'frozen' | 'legacy_live_fallback' | 'missing';

export interface RunResourceRef {
  type: string;
  id: string;
  label: string;
  href: string | null;
  version: string | null;
  tags: Array<{ id: string; label: string; color: string | null }>;
  capturedAt: string;
}

export interface RunSummaryV2 {
  id: string;
  kind: 'workflow' | 'agent';
  title: string;
  status: RunStatusV2;
  displayStatus: RunDisplayStatus;
  attentionReason: string | null;
  currentPhase: string | null;
  startedAt: string;
  updatedAt: string;
  durationMs: number | null;
  rootTraceId: string | null;
  parentRunId: string | null;
  childCounts: { running: number; waiting: number; completed: number; failed: number; cancelled: number };
  resourceRefs: RunResourceRef[];
  evidenceCompleteness: RunEvidenceCompleteness;
  allowedActions: RunAllowedAction[];
  href: string;
  orphaned: boolean;
  children?: RunSummaryV2[];
}

export interface RunPageV2 {
  schemaVersion: 2;
  generatedAt: string;
  view: 'root' | 'all';
  includeChildren: 'none' | 'summary' | 'full';
  items: RunSummaryV2[];
  nextCursor: string | null;
  orphanCount: number;
}
export interface AiSystemControlAssessment {
  schemaVersion: 1;
  kind: 'ai-system-control-assessment';
  assessmentId: string;
  aiSystemId: string;
  revisionId: string;
  revision: number;
  revisionSha256: string;
  catalogId: string;
  catalogVersion: number;
  catalogSha256: string;
  controlId: string;
  sequence: number;
  status: AiSystemControlStatus;
  ownerParty: 'argus_platform' | 'provider' | 'deployer' | 'external_assessor';
  ownerId: string;
  dueAt: string | null;
  reassessmentAt: string | null;
  rationale: string;
  evidence: AiSystemControlEvidence[];
  exception: { rationale: string; compensatingControls: string[]; expiresAt: string; approvedBy: AiSystemActorRef; approvedAt: string } | null;
  assessedBy: AiSystemActorRef;
  assessedAt: string;
  assessmentSha256: string;
}
export interface AiSystemControlProjection {
  definition: AiActControlDefinition;
  applicable: boolean;
  assessment: AiSystemControlAssessment | null;
  effectiveStatus: AiSystemControlStatus;
  expired: boolean;
  releaseBlocking: boolean;
  issues: string[];
}
export interface AiSystemControlLedger {
  schemaVersion: 1;
  kind: 'ai-system-control-ledger';
  aiSystemId: string;
  revisionId: string;
  revision: number;
  revisionSha256: string;
  assessmentSourceRevision: { revisionId: string; revision: number; revisionSha256: string; relation: 'current_revision' | 'release_source' };
  generatedAt: string;
  catalog: AiActControlCatalog;
  coverage: { applicable: number; satisfied: number; open: number; exceptions: number; expired: number };
  releaseReady: boolean;
  blockingReasons: string[];
  controls: AiSystemControlProjection[];
  claimBoundary: string;
}
export interface AiSystemControlAssessmentInput {
  expectedRevision: number;
  expectedRevisionSha256: string;
  status: AiSystemControlStatus;
  ownerParty: AiSystemControlAssessment['ownerParty'];
  ownerId: string;
  dueAt: string | null;
  reassessmentAt: string | null;
  rationale: string;
  evidence: AiSystemControlEvidence[];
  exception: { rationale: string; compensatingControls: string[]; expiresAt: string } | null;
}

export type AiComplianceDossierArtifactFormat = 'manifest' | 'json' | 'pdf' | 'signature';
export type AiComplianceRequirementState = 'satisfied' | 'partial' | 'missing' | 'not_applicable' | 'expired';
export interface AiComplianceRequirementCoverage {
  applicable: number; satisfied: number; partial: number; missing: number; expired: number; notApplicable: number;
}
export interface AiComplianceRequirement {
  requirementId: string;
  legalRefs: string[];
  title: string;
  description: string;
  applicability: 'always' | 'conditional' | 'high_risk';
  state: AiComplianceRequirementState;
  ownerRole: 'argus_platform' | 'provider' | 'deployer' | 'external_assessor';
  expectedEvidence: string[];
  controlIds: string[];
  evidence: Array<{ evidenceType: string; evidenceId: string; sha256: string; href?: string }>;
  findings: string[];
  assessedAt: string;
  nextReviewAt: string | null;
}
export interface AiComplianceMatrix {
  schemaVersion: 2;
  kind: 'argus.ai-compliance-obligation-matrix';
  matrixSha256: string;
  legalBaseline: {
    regulation: 'Regulation (EU) 2024/1689'; officialJournalUrl: string; annexIvUrl: string; qualityManagementUrl: string;
    assessedAt: string; legalReviewRequired: true; applicabilityRationale: string;
  };
  coverage: AiComplianceRequirementCoverage;
  groups: Array<{
    groupId: 'annex_iv' | 'quality_management' | 'lifecycle' | 'conformity_assessment';
    title: string; legalRefs: string[]; coverage: AiComplianceRequirementCoverage; requirements: AiComplianceRequirement[];
  }>;
}
export interface AiComplianceDossierManifest {
  schemaVersion: 1 | 2; kind: 'ai-compliance-dossier-manifest'; dossierId: string; dossierSha256: string; generatedAt: string;
  generatedBy: { actorType: 'user' | 'service' | 'system' | 'external_reviewer'; actorId: string; displayName?: string };
  assessmentStatus: 'controls_incomplete' | 'ready_for_independent_review' | 'externally_assessed' | 'suspended';
  aiSystem: { aiSystemId: string; revisionId: string; revision: number; revisionSha256: string; displayName: string; classification: AiSystemClassification };
  scope: { workspaceId: string; tenantId: string; environments: string[]; from: string; to: string };
  sourceEvidencePack: { evidencePackId: string; sha256: string; checkpointId: string; verification: 'verified' | 'verified_with_declared_gaps' | 'failed' };
  controlCoverage: { applicable: number; satisfied: number; open: number; exceptions: number; expired: number };
  sections: Array<{ sectionId: string; title: string; state: 'complete' | 'complete_with_gaps' | 'missing' | 'not_applicable'; evidenceCount: number; gapCount: number; evidence: Array<{ evidenceType: string; evidenceId: string; sha256: string }> }>;
  artifacts: Array<{ format: 'pdfa' | 'pdf' | 'json' | 'jsonl' | 'csv' | 'signature'; filename: string; mediaType: string; bytes: number; sha256: string }>;
  externalAnchors: Array<{ kind: 'worm_object' | 'qualified_timestamp' | 'transparency_log'; provider: string; reference: string; anchoredAt: string; verification: 'verified' | 'failed' | 'unverified' }>;
  complianceMatrix?: AiComplianceMatrix;
  declaredGaps: Array<{ gapId: string; severity: 'low' | 'medium' | 'high' | 'critical'; description: string; ownerRole: 'argus_platform' | 'provider' | 'deployer' | 'external_assessor'; dueAt: string | null }>;
  claimBoundary: string;
}
export interface AiComplianceDossier {
  manifest: AiComplianceDossierManifest;
  sourceReportRunId: string;
  verification: { state: 'valid' | 'invalid'; reasons: string[]; sourceEvidencePackState: 'valid' | 'invalid' };
}
export interface AiComplianceDossierCatalog {
  schemaVersion: 1;
  kind: 'ai-compliance-dossier-list';
  dossiers: AiComplianceDossier[];
}

export interface LogIndex {
  name: string;
  doc_count: number;
}

export interface LogHit {
  id: number | string;
  '@timestamp': string;
  level: string;
  message: string;
  tool: string | null;
  backend: string | null;
  req_id: string | null;
  root_trace_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  agent_id: number | null;
  workflow_execution_id: number | null;
  data: unknown;
}

export interface LogSearchResponse {
  hits: LogHit[];
  total: string;
}

export type RunTimelineEventKind =
  | 'run_started'
  | 'step_completed'
  | 'step_failed'
  | 'step_skipped'
  | 'step_waiting'
  | 'approval_requested'
  | 'approval_approved'
  | 'approval_rejected'
  | 'run_resumed'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'llm_started'
  | 'llm_completed'
  | 'llm_failed'
  | 'rag_started'
  | 'rag_completed'
  | 'rag_failed';

export interface RunTimelineEvent {
  id: string;
  kind: RunTimelineEventKind;
  title: string;
  detail: string;
  timestamp: string;
  durationMs?: number | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  spanKind?: string | null;
  stepId?: string | null;
  approvalId?: number;
  toolName?: string | null;
  actor?: string | null;
  comment?: string | null;
  inputPreview?: string | null;
  resultPreview?: string | null;
  riskLevel?: RiskLevel;
  riskScore?: number;
  riskFactors?: RiskFactor[];
}

export interface RunDetailStep {
  id: string;
  label: string;
  type: string;
  toolName: string | null;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';
  durationMs: number | null;
  resultPreview: string | null;
}

export interface DistributedTraceRun {
  id: string;
  agentId?: number | null;
  agentRole?: string | null;
  workflowStepId?: string | null;
  taskType?: string | null;
  parentTraceId: string | null;
  parentSpanId: string | null;
  kind: 'workflow' | 'agent';
  title: string;
  subtitle: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputPreview?: string | null;
  outputPreview?: string | null;
  error?: string | null;
  href?: string;
}

export type NativeServiceTopologyNodeKind = 'cluster' | 'namespace' | 'workload' | 'service' | 'dependency' | 'alert';
export type NativeServiceTopologySignal = 'kubernetes' | 'traces' | 'logs' | 'alerts';

export interface NativeServiceTopologyResponse {
  generatedAt: string;
  nodes: Array<{
    id: string;
    kind: NativeServiceTopologyNodeKind;
    name: string;
    detail: string;
    environment: string | null;
    state: NativeServiceHealthState;
    current: boolean;
    signals: NativeServiceTopologySignal[];
    evidenceCount: number;
    events: number;
    calls: number;
    failures: number;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    relation: 'contains' | 'runs' | 'backs' | 'exposes' | 'monitored_by' | 'calls' | 'queries' | 'publishes';
    evidence: 'configured' | 'observed' | 'both';
    current: boolean;
    calls: number;
    failures: number;
    p95DurationMs: number | null;
    lastSeenAt: string | null;
  }>;
  summary: {
    clusters: number;
    namespaces: number;
    workloads: number;
    services: number;
    alerts: number;
    firingAlerts: number;
    traceServices: number;
    logServices: number;
    runtimeDependencies: number;
    calls: number;
    failures: number;
  };
}

export interface DistributedTraceSpan {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  kind: 'llm' | 'tool' | 'rag' | 'workflow' | 'approval' | 'memory' | 'event' | 'unknown';
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  toolName: string | null;
  model: string | null;
  provider: string | null;
  inputPreview?: string | null;
  outputPreview?: string | null;
  metadataPreview?: string | null;
  error: string | null;
}

export interface TraceEvidenceResponse {
  generatedAt: string;
  family?: DistributedTraceFamily | null;
}

export interface DistributedTraceAnalysis {
  criticalPath: string[];
  bottleneck: null | {
    key: string;
    id: string;
    nodeType: 'run' | 'span';
    kind: string;
    label: string;
    durationMs: number;
    selfTimeMs: number;
    sharePercent: number;
  };
  totalDurationMs: number;
  maxConcurrency: number;
  failedNodes: number;
}

export interface RunCodeEvidenceCitation {
  filePath: string;
  symbolName: string | null;
  startLine: number | null;
  endLine: number | null;
  chunkKind: string | null;
  channels: Array<'exact' | 'lexical' | 'vector' | 'graph'>;
  fusedScore: number | null;
}

export interface RunCodeIntelligenceEvidence {
  mode: 'metadata_only' | 'local_retrieval';
  snapshots: Array<{
    snapshotId: number;
    repositoryKey: string;
    branchName: string;
    commitSha: string;
    provider: string;
    fileCount: number | null;
    symbolCount: number | null;
    edgeCount: number | null;
    documentCount: number | null;
    traceId: string;
    spanId: string;
    status: RunStatus;
    observedAt: string;
  }>;
  retrievals: Array<{
    traceId: string;
    spanId: string;
    agentId: number | null;
    agentName: string | null;
    runtimeTraceId: string | null;
    taskType: string | null;
    snapshotId: number | null;
    status: RunStatus;
    durationMs: number | null;
    evidenceCount: number;
    channels: Array<'exact' | 'lexical' | 'vector' | 'graph'>;
    citations: RunCodeEvidenceCitation[];
    observedAt: string;
    error: string | null;
  }>;
}

export interface DistributedTraceComparison {
  baseline: {
    rootTraceId: string;
    startedAt: string;
    status: RunStatus;
    durationMs: number;
    costUsd: number;
    failedNodes: number;
    href?: string;
  };
  current: {
    rootTraceId: string;
    durationMs: number;
    costUsd: number;
    failedNodes: number;
  };
  summary: {
    durationDeltaMs: number;
    durationDeltaPercent: number | null;
    costDeltaUsd: number;
    costDeltaPercent: number | null;
    failedNodeDelta: number;
    regressionCount: number;
    improvementCount: number;
  };
  changes: Array<{
    signature: string;
    label: string;
    kind: string;
    nodeType: 'run' | 'span';
    change: 'regression' | 'improvement' | 'new' | 'removed' | 'status_regression';
    currentStatus: RunStatus | null;
    baselineStatus: RunStatus | null;
    currentDurationMs: number | null;
    baselineDurationMs: number | null;
    durationDeltaMs: number | null;
    durationDeltaPercent: number | null;
    currentCostUsd: number | null;
    baselineCostUsd: number | null;
    costDeltaUsd: number | null;
  }>;
}

export interface HistoricalTraceWindow {
  days: 7 | 30;
  sampleCount: number;
  terminalCount: number;
  medianDurationMs: number;
  p95DurationMs: number;
  medianCostUsd: number;
  p95CostUsd: number;
  successRate: number;
}

export interface HistoricalTraceBaseline {
  selectedWindowDays: 7 | 30 | null;
  confidence: 'none' | 'low' | 'medium' | 'high';
  sampleCount: number;
  currentDurationMs: number;
  currentCostUsd: number;
  durationDeltaPercent: number | null;
  costDeltaPercent: number | null;
  durationState: 'no_data' | 'normal' | 'warning' | 'critical';
  costState: 'no_data' | 'normal' | 'warning' | 'critical';
  selected: HistoricalTraceWindow | null;
  windows: HistoricalTraceWindow[];
}

export interface DistributedTraceFamily {
  rootTraceId: string;
  currentTraceId: string;
  truncated: boolean;
  spansTruncated: boolean;
  runs: DistributedTraceRun[];
  spans: DistributedTraceSpan[];
  codeIntelligence?: RunCodeIntelligenceEvidence | null;
  analysis: DistributedTraceAnalysis;
  historicalBaseline: HistoricalTraceBaseline;
  comparison: DistributedTraceComparison | null;
}

export interface SpanEvidenceResponse {
  generatedAt: string;
  trace: {
    id: string;
    rootTraceId: string;
    parentTraceId: string | null;
    name: string;
    kind: string;
  };
  span: {
    id: string;
    parentSpanId: string | null;
    name: string;
    kind: DistributedTraceSpan['kind'];
    status: RunStatus;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    model: string | null;
    provider: string | null;
    toolName: string | null;
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
    inputPreview: string | null;
    outputPreview: string | null;
    metadataPreview: string | null;
    error: string | null;
  };
}

export type TraceFeedbackSource = 'human' | 'model' | 'policy' | 'import';
export type TraceFeedbackSentiment = 'positive' | 'neutral' | 'negative' | 'mixed';

export interface TraceFeedback {
  id: number;
  traceId: string;
  spanId: string | null;
  source: TraceFeedbackSource;
  label: string;
  score: number | null;
  sentiment: TraceFeedbackSentiment | null;
  comment: string | null;
  tags: string[];
  metadata: unknown;
  createdByUserId: number | null;
  createdByName: string | null;
  supersedesId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TraceFeedbackSummary {
  activeCount: number;
  humanCount: number;
  modelCount: number;
  averageScore: number | null;
  sentiments: Record<TraceFeedbackSentiment, number>;
  labels: Array<{
    label: string;
    count: number;
    humanCount: number;
    modelCount: number;
    averageScore: number | null;
  }>;
}

export interface TraceFeedbackResponse {
  generatedAt: string;
  traceId: string;
  submitted?: TraceFeedback;
  feedback: TraceFeedback[];
  summary: TraceFeedbackSummary;
}

export interface TraceFeedbackMutation {
  label?: string;
  spanId?: string | null;
  score?: number | null;
  sentiment?: TraceFeedbackSentiment | null;
  comment?: string | null;
  tags?: string[];
}

export interface WorkflowAgentContractAssignmentEvidence {
  role: string;
  label: string;
  stepIds: string[];
  status: 'ready' | 'degraded' | 'blocked';
  agentId: number | null;
  agentName: string | null;
  agentLabel: string | null;
  agentMode: 'chat' | 'worker' | 'reviewer' | null;
  model: string | null;
  presetName: string | null;
  installedPresetVersion: number | null;
  skillNames: string[];
  bundleIds: number[];
  toolNames: string[];
  runtime: {
    type: 'argus' | 'codex' | 'claude-code' | 'hermes';
    profileId: number | null;
    profileName: string | null;
    profileLabel: string | null;
    model: string;
    state: 'ready' | 'warning' | 'blocked' | 'disabled';
    detail: string;
  } | null;
  catalogFingerprint: string | null;
  blockers: string[];
  warnings: string[];
  runs?: Array<{
    traceId: string;
    title: string;
    taskType: string | null;
    status: RunStatus;
    startedAt: string;
    durationMs: number | null;
    runHref: string;
    traceHref: string;
  }>;
}

export interface WorkflowAgentContractEvidence {
  schemaVersion: 1;
  capturedAt: string | null;
  contractFingerprint: string | null;
  inferredLegacyContract: boolean;
  assignments: WorkflowAgentContractAssignmentEvidence[];
}

export interface RunDetailResponse {
  generatedAt: string;
  run: RunSummary & {
    workflowId?: number;
    workflowHref?: string;
    trigger?: string | null;
    resumeCount?: number;
    waitingApprovalId?: number | null;
    waitingStepId?: string | null;
    lifecycleStatus?: string;
    humanOversightRequired?: boolean;
    tags?: string[];
    inputKeys?: string[];
    totalSteps: number;
    completedSteps: number;
    agentId?: number;
    agentMode?: string;
    iteration?: number;
    termination?: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    traceId?: string;
    rootTraceId?: string;
    parentTraceId?: string | null;
    parentSpanId?: string | null;
  };
  currentApproval: {
    id: number;
    status: 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
    toolName: string;
    stepId: string | null;
    requestedAt: string;
    reviewer: string | null;
    comment: string | null;
    riskLevel: RiskLevel;
    riskScore: number;
    riskFactors: RiskFactor[];
    riskModel: string;
  } | null;
  metrics: Record<string, number>;
  agentContract?: WorkflowAgentContractEvidence | null;
  steps: RunDetailStep[];
  timeline: RunTimelineEvent[];
  traceFamily?: DistributedTraceFamily | null;
}

export interface FabricServer {
  id: string;
  name: string;
  type: 'mcp' | 'http' | 'database';
  state: HealthState;
  latencyMs: number | null;
  toolCount: number;
  authType: string;
  endpoint: string;
  bundleCount: number;
  bundleNames: string[];
  error?: string | null;
  trustStatus: 'unverified' | 'trusted' | 'changed' | 'quarantined' | 'not_applicable';
  catalogFingerprint: string | null;
  trustedFingerprint: string | null;
  registryToolCount: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  changedAt: string | null;
  verifiedAt: string | null;
  verificationComment: string | null;
  changeSummary: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  ssoPortal?: FabricBackendSsoPortal | null;
}

export interface FabricBackendSsoPortal {
  mode: 'shared_oidc' | 'external_org_sso';
  application: string;
  label: string;
  providerName: string;
  presentationRole: string;
  state: 'ready' | 'sso_required' | 'premium_required';
  premium: true;
  launchPath: string | null;
}

export interface FabricTool {
  id: string;
  name: string;
  server: string;
  description: string;
  bundleCount: number;
  bundleNames: string[];
}

export interface FabricBundle {
  id: number;
  label: string;
  icon: string;
  serverCount: number;
  toolCount: number;
  access: 'unrestricted' | 'granted';
}

export interface FabricResponse {
  generatedAt: string;
  permissions: {
    canManage: boolean;
  };
  stats: {
    servers: number;
    healthy: number;
    tools: number;
    bundles: number;
    trusted: number;
    trustAttention: number;
    mcpServers: number;
    ssoPortals?: number;
    readySsoPortals?: number;
  };
  servers: FabricServer[];
  bundles: FabricBundle[];
  tools: FabricTool[];
}

export interface FabricManagementBundle {
  id: number;
  name: string;
  label: string;
  description: string;
  icon: string;
  agentRole: string | null;
  systemPrompt: string | null;
  backendIds: number[];
  skillIds: number[];
  workflowIds: number[];
  workflowCount: number;
  toolPolicies: FabricBundleToolPolicy[];
  backendCount: number;
  toolCount: number;
  compositeCount: number;
  capabilityCategories?: string[];
  capabilitySignals?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FabricBundleToolPolicy {
  backendId: number;
  bundleId?: number;
  mode: 'all' | 'selected';
  allowedToolNames: string[];
}

export interface FabricManagementTool {
  backendId: number | null;
  name: string;
  description: string;
  source: 'dynamic' | 'remote';
  enabled: boolean;
  isWrite: boolean;
  bundleIds: number[];
}

export interface FabricManagementBackend {
  id: number;
  name: string;
  description: string;
  type: 'mcp' | 'http' | 'builtin';
  managed: boolean;
  managedBy: 'openapi' | null;
  sourceId: number | null;
  enabled: boolean;
  state: HealthState;
  endpoint: string;
  baseUrl: string;
  mcpEndpoint: string | null;
  authType: 'none' | 'bearer' | 'basic' | 'header';
  hasAuthValue: boolean;
  healthPath: string | null;
  defaultHeaders: Record<string, string>;
  timeoutMs: number;
  tlsSkipVerify: boolean;
  authMode: 'service-account' | 'permissive' | 'strict';
  oauthAuthorizeUrl: string | null;
  oauthTokenUrl: string | null;
  oauthClientId: string | null;
  hasOauthClientSecret: boolean;
  oauthScopes: string[];
  oauthRevokeUrl: string | null;
  toolCount: number;
  bundleIds: number[];
  executionTargets?: FabricExecutionTarget[];
  workflowCount: number;
  ssoPortal?: FabricBackendSsoPortal | null;
  createdAt: string;
  updatedAt: string;
}

export interface FabricManagementSkill {
  id: number;
  name: string;
  label: string;
  description: string;
  category: string | null;
  icon: string;
}

export interface FabricManagementResponse {
  generatedAt: string;
  bundles: FabricManagementBundle[];
  backends: FabricManagementBackend[];
  skills: FabricManagementSkill[];
  tools: FabricManagementTool[];
  kubernetesCertifications?: FabricKubernetesCertification[];
  kubernetesCertificationPolicy?: FabricKubernetesCertificationPolicy;
}

export interface FabricProfileConnector {
  slot: string;
  backendName: string;
  backendType: 'mcp' | 'http' | 'builtin';
}

export interface FabricProfileManifest {
  apiVersion: 'fabric.argus.dev/v1alpha1';
  kind: 'FabricProfile';
  metadata: {
    name: string;
    label: string;
    description: string;
    version: string;
  };
  spec: {
    connectors: FabricProfileConnector[];
    bundles: Array<{
      name: string;
      label: string;
      description: string;
      icon: string;
      systemPrompt: string | null;
      agentRole: string | null;
      connectors: Array<{
        slot: string;
        toolPolicy: {
          mode: 'all' | 'selected';
          allowedToolNames: string[];
        };
      }>;
      skills: string[];
      directTools: string[];
    }>;
    access: null | {
      compositeName: string;
      description: string;
      toolAllowPatterns: string[];
      toolDenyPatterns: string[];
      groupBindings: Array<{
        logicalName: string;
        required: boolean;
      }>;
    };
  };
}

export interface FabricProfileSsoGroup {
  name: string;
  memberCount: number;
}

export interface FabricProfileMappings {
  backends?: Record<string, string>;
  skills?: Record<string, string>;
  groups?: Record<string, string>;
}

export interface FabricProfileRecord {
  id: number;
  name: string;
  label: string;
  description: string;
  manifestVersion: string;
  revision: number;
  manifest: FabricProfileManifest;
  manifestDigest: string;
  source: 'local' | 'imported';
  installedBundleIds: number[];
  appliedMappings: FabricProfileMappings;
  createdBy: string | null;
  updatedBy: string | null;
  lastAppliedAt: string | null;
  drift?: FabricProfileDriftSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

export interface FabricProfileVersionRecord {
  id: number;
  profileId: number;
  revision: number;
  manifestVersion: string;
  manifest: FabricProfileManifest;
  manifestDigest: string;
  source: 'local' | 'imported';
  installedBundleIds: number[];
  appliedMappings: FabricProfileMappings;
  changeKind: 'created' | 'exported' | 'applied';
  applied: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface FabricProfileVersionDiff {
  profileId: number;
  from: Pick<FabricProfileVersionRecord, 'revision' | 'manifestVersion' | 'manifestDigest' | 'createdAt'>;
  to: Pick<FabricProfileVersionRecord, 'revision' | 'manifestVersion' | 'manifestDigest' | 'createdAt'>;
  counts: { total: number; added: number; removed: number; changed: number };
  changes: Array<{
    kind: 'added' | 'removed' | 'changed';
    scope: 'metadata' | 'connector' | 'bundle' | 'access';
    resource: string;
    field: string;
    before: unknown;
    after: unknown;
  }>;
  truncated: boolean;
}

export interface FabricProfileRestoreRequest {
  id: string;
  profileId: number;
  profileLabel: string;
  targetRevision: number;
  targetManifestDigest: string;
  requestedFromRevision: number;
  requestedFromManifestDigest: string;
  mappings: FabricProfileMappings;
  planToken: string;
  planSnapshot: Pick<FabricProfilePlan, 'actions' | 'blockers'>;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'stale';
  requestedBy: number | null;
  requestedByUsername: string;
  requestComment: string;
  decidedBy: number | null;
  decidedByUsername: string | null;
  decisionComment: string | null;
  requestedAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

export interface FabricProfileDriftFinding {
  code:
    | 'bundle_missing'
    | 'bundle_metadata_changed'
    | 'backend_assignment_changed'
    | 'tool_policy_changed'
    | 'skill_assignment_changed'
    | 'direct_tool_assignment_changed'
    | 'composite_missing'
    | 'composite_changed'
    | 'group_binding_missing'
    | 'group_binding_changed';
  severity: 'warning' | 'critical';
  resourceType: 'bundle' | 'connector' | 'skill' | 'tool' | 'composite' | 'sso_group';
  resource: string;
  message: string;
  expected: unknown;
  actual: unknown;
}

export interface FabricProfileDrift {
  status: 'in_sync' | 'drifted' | 'not_applied';
  checkedAt: string;
  profileId: number;
  profileRevision: number;
  manifestDigest: string;
  counts: { total: number; critical: number; warning: number };
  findings: FabricProfileDriftFinding[];
}

export interface FabricProfileDriftSnapshot extends Omit<FabricProfileDrift, 'findings'> {
  findings: Array<Pick<FabricProfileDriftFinding, 'code' | 'severity' | 'resourceType' | 'resource' | 'message'>>;
  findingDigest: string;
  source: 'manual' | 'scheduled';
  transitionSequence: number;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  changedAt: string;
  notifiedAt: string | null;
}

export interface FabricProfilePlan {
  manifest: FabricProfileManifest;
  manifestDigest: string;
  planToken: string;
  actions: Array<{
    kind: 'bundle' | 'composite' | 'group';
    target: string;
    operation: 'create' | 'update' | 'bind';
    detail: string;
  }>;
  blockers: Array<{
    code: 'missing_backend' | 'missing_skill' | 'missing_tool' | 'missing_group';
    resource: string;
    message: string;
  }>;
  resolved: {
    backends: Record<string, { id: number; name: string }>;
    skills: Record<string, { id: number; name: string }>;
    directTools: Record<string, { id: number; name: string }>;
    groups: Record<string, FabricProfileSsoGroup>;
  };
}

export interface FabricKubernetesCertificationPolicy {
  warningAgeHours: number;
  maxAgeHours: number;
  enforceAIOps: boolean;
}

export interface FabricKubernetesCertificationCheck {
  id: string;
  status: 'failed';
  detail: string;
}

export interface FabricKubernetesCertification {
  id: number;
  backendId: number;
  targetId: string;
  platform: 'kubernetes' | 'aks' | 'eks' | 'gke' | 'openshift';
  profile: 'in-cluster-read-only' | 'production';
  status: 'passed' | 'failed';
  contractSha256: string;
  reportSha256: string;
  checkCount: number;
  passedCount: number;
  failedCount: number;
  failedChecks: FabricKubernetesCertificationCheck[];
  generatedAt: string;
  importedAt: string;
  importedBy: string | null;
  freshness: 'fresh' | 'expiring' | 'stale';
  ageHours: number;
  expiresAt: string;
}

export interface FabricKubernetesCertificationHistoryResponse {
  history: FabricKubernetesCertification[];
  policy: FabricKubernetesCertificationPolicy;
}

export interface ServiceTemplateField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'password' | 'select';
  required: boolean;
  default?: string;
  placeholder: string | null;
  options: string[];
}

export interface ServiceTemplateSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  subcategory: string | null;
  tags: string[];
  backendType: 'http' | 'mcp';
  docsUrl: string | null;
  installable: boolean;
  unavailableReason: string | null;
  certification: {
    level: 'contract';
    status: 'certified' | 'failed';
    certifiedCount: number;
    totalCount: number;
  };
  fields: ServiceTemplateField[];
  tools: Array<{ nameSuffix: string; description: string; method: string | null }>;
}

export interface ServiceTemplateCatalogResponse {
  generatedAt: string;
  categories: Array<{ id: string; label: string; icon: string; templateCount: number }>;
  templates: ServiceTemplateSummary[];
}

export interface ServiceTemplateInstallInput {
  prefix: string;
  fields: Record<string, string>;
  bundleId: number;
}

export interface ServiceTemplateInstallResult {
  templateId: string;
  connection: { id: number; name: string };
  capabilities: Array<{ id: number; name: string }>;
  warnings: string[];
}

export interface CapabilityParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string;
}

export interface CapabilityStudioItem {
  id: string;
  managedId: number | null;
  managedBy: 'openapi' | null;
  name: string;
  description: string;
  source: 'managed' | 'builtin' | 'remote';
  backend: string;
  backendId: number | null;
  backendLabel: string;
  queryTemplate: string | null;
  parameters: CapabilityParameter[];
  inputSchema: Record<string, unknown> | null;
  category: string | null;
  enabled: boolean;
  isWrite: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  requiredAuthMode: 'service-account' | 'permissive' | 'strict' | null;
  bundleIds: number[];
  workflowCount: number;
  editable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityStudioResponse {
  generatedAt: string;
  stats: {
    total: number;
    active: number;
    managed: number;
    remote: number;
    writeFlagged: number;
    unscoped: number;
    disabled: number;
  };
  bundles: Array<{ id: number; name: string; label: string; icon: string }>;
  backends: Array<{
    id: number;
    name: string;
    description: string;
    type: 'http' | 'mcp' | 'builtin';
    enabled: boolean;
  }>;
  capabilities: CapabilityStudioItem[];
}

export interface CapabilityMutation {
  name: string;
  description: string;
  backend: string;
  queryTemplate: string;
  parameters: CapabilityParameter[];
  category: string;
  enabled: boolean;
  bundleIds: number[];
  allowUnscoped: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  requiredAuthMode: 'service-account' | 'permissive' | 'strict' | null;
}

export type CapabilityPlaygroundParameters = Record<string, string | number | boolean>;

export interface CapabilityPlaygroundRequestPreview {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface CapabilityPlaygroundResponse {
  status: number;
  statusText: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
  durationMs: number;
}

export interface CapabilityPlaygroundResult {
  capability: {
    id: string;
    name: string;
    enabled: boolean;
    isWrite: boolean;
    riskLevel: 'low' | 'medium' | 'high';
  };
  request: CapabilityPlaygroundRequestPreview;
  executed: boolean;
  response?: CapabilityPlaygroundResponse;
}

export interface CapabilityPlaygroundMutation {
  parameters: CapabilityPlaygroundParameters;
  execute: boolean;
  confirmWrite: boolean;
}

export interface OpenApiImportSource {
  specText?: string;
  specUrl?: string;
  namePrefix?: string;
  baseUrl?: string;
}

export interface OpenApiPreviewOperation {
  key: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  parameterCount: number;
  parameters: CapabilityParameter[];
  tags: string[];
  isWrite: boolean;
  riskLevel: 'low' | 'high';
  supported: boolean;
  warnings: string[];
  change: 'create' | 'update' | 'collision' | 'unsupported';
  collisionReason: string | null;
}

export interface OpenApiPreview {
  previewDigest: string;
  specDigest: string;
  title: string;
  openapiVersion: string;
  sourceKind: 'text' | 'url';
  prefix: string;
  baseUrl: string;
  security: {
    auth_type: 'none' | 'bearer' | 'basic' | 'header';
    headerName?: string;
    note?: string;
  };
  existing: {
    backendId: number | null;
    backendOwned: boolean;
    authType: string | null;
    hasCredential: boolean;
    credentialReusable: boolean;
    importedToolCount: number;
    assignedBundleIds: number[];
    sourceRevision: string | null;
    sourceManifestDigest: string | null;
    defaultBundleId: number | null;
    defaultBundleOwned: boolean;
  };
  operations: OpenApiPreviewOperation[];
  removals: Array<{ name: string; workflowCount: number }>;
  counts: {
    total: number;
    supported: number;
    read: number;
    write: number;
    create: number;
    update: number;
    collisions: number;
    unsupported: number;
    removals: number;
  };
  warnings: string[];
}

export interface OpenApiImportMutation extends OpenApiImportSource {
  previewDigest: string;
  selectedOperationKeys: string[];
  bundleIds: number[];
  createDefaultBundle: boolean;
  enabled: boolean;
  confirmWrites: boolean;
  confirmReimport: boolean;
  confirmRemovals: boolean;
  acknowledgeUnsupportedAuth: boolean;
  credential?: string;
  basicUser?: string;
  basicPassword?: string;
}

export interface OpenApiImportResult {
  backendId: number;
  bundleId: number;
  bundleIds: number[];
  created: { read: number; write: number };
  inserted: { read: number; write: number };
  updated: { read: number; write: number };
  removed: string[];
  skipped: string[];
  warnings: string[];
}

export type OpenApiCapabilitySourceStatus = 'unchecked' | 'current' | 'drifted' | 'error';

export interface OpenApiSourceDriftSummary {
  added: number;
  changed: number;
  removed: number;
  authChanged: boolean;
  baseUrlChanged: boolean;
}

export interface OpenApiCapabilitySource {
  id: number;
  name: string;
  prefix: string;
  backendId: number;
  backendEnabled: boolean;
  source: {
    kind: 'url' | 'text';
    url: string | null;
    canCheck: boolean;
    baseUrlOverride: string | null;
  };
  status: OpenApiCapabilitySourceStatus;
  importedAt: string;
  checkedAt: string | null;
  baseline: {
    specDigest: string | null;
    manifestDigest: string | null;
    operationCount: number;
  };
  lastCheck: {
    status: OpenApiCapabilitySourceStatus;
    checkedAt: string;
    observedSpecDigest: string | null;
    observedManifestDigest: string | null;
    summary: OpenApiSourceDriftSummary | null;
    errorCode: string | null;
  } | null;
}

export interface OpenApiCapabilitySourcesResponse {
  generatedAt: string;
  sources: OpenApiCapabilitySource[];
}

export interface OpenApiSourceOperationRef {
  key: string;
  name: string;
  method: string;
  path: string;
  isWrite: boolean;
  supported: boolean;
  signature: string;
  workflowCount: number;
}

export type OpenApiSourceAuthSnapshot = {
  type: 'none' | 'bearer' | 'basic' | 'header';
  headerName: string | null;
} | null;

export interface OpenApiSourceCheckResult {
  source: {
    id: number;
    name: string;
    prefix: string;
    sourceKind: 'url' | 'text';
  };
  checkedAt: string;
  status: 'current' | 'drifted';
  baseline: {
    specDigest: string;
    manifestDigest: string;
  };
  observed: {
    specDigest: string;
    manifestDigest: string;
    title: string;
    openapiVersion: string;
    baseUrl: string;
    auth: Exclude<OpenApiSourceAuthSnapshot, null>;
  };
  diff: {
    added: OpenApiSourceOperationRef[];
    changed: Array<{
      before: OpenApiSourceOperationRef;
      after: OpenApiSourceOperationRef;
      changes: string[];
    }>;
    removed: OpenApiSourceOperationRef[];
    baseUrl: {
      changed: boolean;
      before: string;
      after: string;
    };
    auth: {
      changed: boolean;
      before: OpenApiSourceAuthSnapshot;
      after: OpenApiSourceAuthSnapshot;
    };
    summary: OpenApiSourceDriftSummary;
  };
}

export interface OpenApiSourceRetirementCapabilityImpact {
  id: number;
  name: string;
  isWrite: boolean;
  enabled: boolean;
  bundleIds: number[];
  workflowCount: number;
}

export interface OpenApiSourceRetirementBundleImpact {
  id: number;
  name: string;
  label: string;
  connectionAssigned: boolean;
  capabilityIds: number[];
  capabilityNames: string[];
}

export interface OpenApiSourceRetirementWorkflowImpact {
  id: number;
  name: string;
  capabilityNames: string[];
}

export interface OpenApiSourceRetirementConfirmation {
  expectedPrefix: string;
  expectedRevision: string;
  expectedManifestDigest: string | null;
  expectedImpactDigest: string;
}

export interface OpenApiSourceRetirementPreview {
  source: {
    id: number;
    name: string;
    prefix: string;
    revision: string;
    manifestDigest: string | null;
    operationCount: number;
  };
  backend: {
    id: number;
    name: string;
    enabled: boolean;
  };
  impact: {
    capabilities: OpenApiSourceRetirementCapabilityImpact[];
    bundles: OpenApiSourceRetirementBundleImpact[];
    workflows: OpenApiSourceRetirementWorkflowImpact[];
  };
  confirmation: OpenApiSourceRetirementConfirmation;
}

export interface OpenApiSourceRetirementResult {
  sourceId: number;
  backendId: number;
  prefix: string;
  deletedCapabilities: Array<{ id: number; name: string }>;
  deletedCapabilityCount: number;
  preservedBundleIds: number[];
  preservedWorkflowIds: number[];
  retiredAt: string;
  warnings: string[];
}

export interface FabricBundleMutation {
  name?: string;
  label: string;
  description: string;
  icon: string;
  agentRole: string | null;
  systemPrompt: string | null;
  backendIds: number[];
  skillIds: number[];
  toolPolicies: FabricBundleToolPolicy[];
}

export interface FabricToolAssignmentInput {
  bundleId: number;
  tools: Array<{
    backendId: number | null;
    name: string;
  }>;
}

export interface FabricBundleToolChangeInput {
  action: 'remove' | 'move';
  targetBundleId?: number;
  tools: Array<{
    backendId: number | null;
    name: string;
  }>;
}

export interface AccessPolicyComposite {
  id: number;
  name: string;
  description: string;
  bundleMode: 'all' | 'selected';
  includedBundleIds: number[];
  toolAllowPatterns: string[];
  toolDenyPatterns: string[];
  systemPrompt: string | null;
  agentRole: string | null;
  enabled: boolean;
  userCount: number;
  groupCount: number;
  agentCount: number;
  apiKeyCount: number;
  groupNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AccessPolicyGroupRule {
  id?: number;
  toolPattern: string;
  effect: 'allow' | 'deny';
  reason: string | null;
}

export interface AccessPolicyGroup {
  name: string;
  memberCount: number;
  compositeIds: number[];
  agentIds: number[];
  deniedAgentIds: number[];
  rules: AccessPolicyGroupRule[];
}

export interface AccessPolicyUserRule extends AccessPolicyGroupRule {
  expiresAt: string | null;
}

export interface AccessPolicyUser {
  id: number;
  label: string;
  username: string;
  role: string;
  enabled: boolean;
  allowedBundleIds: number[] | null;
  entraGroups: string[];
  compositeIds: number[];
  agentIds: number[];
  deniedAgentIds: number[];
  rules: AccessPolicyUserRule[];
}

export interface AccessPolicyTechnicalIdentity {
  id: number;
  kind: 'agent' | 'api_key';
  label: string;
  secondary: string;
  enabled: boolean;
  compositeId: number | null;
  scope: 'mcp' | 'agents' | 'both' | null;
  allowedBundleIds: number[] | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
}

export type AccessPolicyPostureSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AccessPolicyPostureTarget {
  tab: 'composites' | 'groups' | 'users' | 'technical';
  id: string;
}

export interface AccessPolicyPostureFinding {
  id: string;
  severity: AccessPolicyPostureSeverity;
  category: 'exposure' | 'coverage' | 'hygiene';
  title: string;
  description: string;
  recommendation: string;
  entityLabel: string;
  target: AccessPolicyPostureTarget | null;
}

export interface AccessPolicyPosture {
  score: number;
  status: 'strong' | 'watch' | 'at_risk' | 'critical';
  coveragePercent: number;
  coveredPrincipals: number;
  totalPrincipals: number;
  unrestrictedPrincipals: number;
  summary: Record<AccessPolicyPostureSeverity, number> & { total: number };
  findings: AccessPolicyPostureFinding[];
}

export interface AccessPolicyResponse {
  generatedAt: string;
  permissions: { canManage: boolean };
  stats: {
    composites: number;
    enabled: number;
    groups: number;
    rules: number;
  };
  bundles: Array<{
    id: number;
    name: string;
    label: string;
    icon: string;
    toolCount: number;
    toolNames: string[];
  }>;
  tools: string[];
  technicalIdentities: AccessPolicyTechnicalIdentity[];
  users: AccessPolicyUser[];
  simulatorPrincipals: AccessPolicySimulatorPrincipal[];
  composites: AccessPolicyComposite[];
  groups: AccessPolicyGroup[];
  posture: AccessPolicyPosture;
}

export type AccessPolicySimulatorPrincipalKind = 'user' | 'agent' | 'api_key' | 'group' | 'composite';

export interface AccessPolicySimulatorPrincipal {
  id: string;
  kind: AccessPolicySimulatorPrincipalKind;
  label: string;
  secondary: string;
  enabled: boolean;
}

export interface AccessPolicySimulation {
  generatedAt: string;
  principal: AccessPolicySimulatorPrincipal;
  toolName: string;
  decision: 'allow' | 'deny';
  rawDecision: 'allow' | 'deny' | 'no_rule';
  reason: string;
  policyMode: boolean;
  sources: string[];
  steps: Array<{
    key: string;
    label: string;
    outcome: 'matched' | 'passed';
    detail: string;
    evidence: string[];
    source?: string;
  }>;
}

export interface AccessPolicySimulationInput {
  principalKind: AccessPolicySimulatorPrincipalKind;
  principalId: string;
  toolName: string;
}

export interface AccessPolicyCompositeMutation {
  name: string;
  description: string;
  bundleMode: 'all' | 'selected';
  includedBundleIds: number[];
  toolAllowPatterns: string[];
  toolDenyPatterns: string[];
  systemPrompt: string | null;
  agentRole: string | null;
  enabled: boolean;
}

export interface AccessPolicyGroupMutation {
  groupName: string;
  compositeIds: number[];
  agentIds: number[];
  rules: Array<{
    toolPattern: string;
    effect: 'allow' | 'deny';
    reason: string | null;
  }>;
}

export interface AccessPolicyUserMutation {
  userId: number;
  compositeIds: number[];
  agentIds: number[];
  rules: Array<{
    toolPattern: string;
    effect: 'allow' | 'deny';
    reason: string | null;
    expiresAt: string | null;
  }>;
}

export interface AccessPolicyTechnicalIdentityMutation {
  kind: 'agent' | 'api_key';
  id: number;
  compositeId: number | null;
  bundleMode: 'all' | 'selected';
  allowedBundleIds: number[];
  toolMode: 'all' | 'selected';
  allowedTools: string[];
  deniedTools: string[];
}

export interface FabricConnectionMutation {
  name?: string;
  type: 'mcp' | 'http';
  description: string;
  baseUrl: string;
  mcpEndpoint: string | null;
  authType: 'none' | 'bearer' | 'basic' | 'header';
  authValue?: string | null;
  healthPath: string | null;
  defaultHeaders: Record<string, string>;
  timeoutMs: number;
  tlsSkipVerify: boolean;
  enabled: boolean;
  authMode: 'service-account' | 'permissive' | 'strict';
  oauthAuthorizeUrl: string | null;
  oauthTokenUrl: string | null;
  oauthClientId: string | null;
  oauthClientSecret?: string | null;
  oauthScopes: string[];
  oauthRevokeUrl: string | null;
  bundleIds: number[];
  executionTarget?: {
    kind: 'kubernetes';
    platform: 'kubernetes' | 'aks' | 'eks' | 'gke' | 'openshift';
    targetId: string;
    label: string;
    cluster: string;
    environment: string;
    namespaces: string[];
  } | null;
}

export interface FabricConnectionTestResult {
  type: 'mcp' | 'http';
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  toolCount?: number;
}

export interface FabricConnectionSaveResult {
  connection: {
    id: number;
    name: string;
    type: 'mcp' | 'http';
    enabled: boolean;
  };
  warning: string | null;
}

export interface FabricConnectionDiscoveryResult {
  connected: boolean;
  toolCount: number;
  trustStatus: string;
  changeSummary: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  tools: Array<{
    name: string;
    description: string;
  }>;
}

export type AccessPrincipalKind = 'user' | 'api_key' | 'agent' | 'workflow' | 'group' | 'policy';
export type AccessSource = 'direct' | 'unrestricted' | 'composite' | 'group';

export interface BundleAccessPrincipal {
  id: string;
  label: string;
  secondary: string;
  kind: AccessPrincipalKind;
  source: AccessSource;
  enabled: boolean;
}

export interface BundleAccessCandidate {
  id: string;
  label: string;
  secondary: string;
  kind: AccessPrincipalKind;
  access: 'none' | 'direct' | 'unrestricted' | 'inherited';
  enabled: boolean;
  editable: boolean;
  reason: string;
}

export interface BundleConnection {
  id: string;
  name: string;
  description: string;
  type: 'mcp' | 'http';
  state: HealthState;
  endpoint: string;
  enabled: boolean;
  toolCount: number;
  toolAccessMode: 'all' | 'selected';
  allowedToolCount: number;
}

export interface BundleCapability {
  id: string;
  backendId: number | null;
  name: string;
  server: string;
  description: string;
  enabled: boolean;
  membership: 'direct' | 'connection' | 'direct_and_connection';
}

export interface FabricBundleDetailResponse {
  generatedAt: string;
  permissions: {
    canManage: boolean;
    canInspectAccess: boolean;
  };
  bundle: {
    id: number;
    name: string;
    label: string;
    description: string;
    icon: string;
    agentRole: string | null;
    endpoint: string;
  };
  stats: {
    connections: number;
    tools: number;
    identities: number;
    workflows: number;
  };
  access: {
    redacted: boolean;
    principals: BundleAccessPrincipal[];
    candidates: BundleAccessCandidate[];
    note: string;
  };
  connections: BundleConnection[];
  tools: BundleCapability[];
}

export interface ApprovalHistoryItem {
  id: string;
  action: 'submitted' | 'approved' | 'rejected' | 'withdrawn';
  actor: string;
  role: string | null;
  comment: string | null;
  createdAt: string;
}

export interface ApprovalInboxItem {
  id: string;
  kind: 'workflow_review' | 'runtime_tool' | 'coding_workflow';
  workflowId: number | null;
  codingThreadId?: string;
  runtimeApprovalId?: number;
  agentId?: number | null;
  title: string;
  description: string;
  subjectLabel?: string;
  sessionId?: string;
  workflowExecutionId?: number | null;
  workflowStepId?: string | null;
  autoResume?: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  status: 'pending';
  risk: RiskLevel;
  riskScore?: number;
  riskFactors?: RiskFactor[];
  riskModel?: string;
  submittedBy: string;
  submittedAt: string;
  comment: string | null;
  version: number | null;
  bundles: string[];
  tags: string[];
  humanOversightRequired: boolean;
  occurrenceCount?: number;
  history: ApprovalHistoryItem[];
  href: string;
  actions: {
    canApprove: boolean;
    canReject: boolean;
    blockedReason: string | null;
  };
}

export interface GovernanceResponse {
  generatedAt: string;
  user: {
    username: string;
  };
  permissions: {
    canReview: boolean;
    canOverrideFourEyes: boolean;
    canManagePlatform: boolean;
  };
  stats: {
    pending: number;
    submittedByMe: number;
    highRisk: number;
    oldestSubmittedAt: string | null;
  };
  approvals: ApprovalInboxItem[];
  recentDecisions: Array<{
    id: string;
    title: string;
    action: 'approved' | 'rejected' | 'withdrawn' | 'consumed';
    actor: string;
    actorRole: string | null;
    comment: string | null;
    createdAt: string;
    href: string;
    kind: 'workflow_review' | 'runtime_tool';
  }>;
}

export type LlmProviderType = 'openai' | 'anthropic' | 'openai-compatible';
export type LlmProviderAuthType = 'bearer' | 'api-key' | 'none';
export type LlmCredentialBudgetMode = 'observe' | 'alert' | 'block';

export interface LlmCredentialProfileMutation {
  name: string;
  label: string;
  description: string;
  providerType: LlmProviderType;
  secretName: string | null;
  apiKey?: string | null;
  department: string | null;
  costCenter: string | null;
  monthlyBudgetUsd: number | null;
  budgetMode: LlmCredentialBudgetMode;
  enabled: boolean;
  expiresAt: string | null;
}

export interface LlmCredentialProfileRecord extends Omit<LlmCredentialProfileMutation, 'apiKey'> {
  id: number;
  credentialConfigured: boolean;
  inlineCredentialConfigured: boolean;
  assignedAgents: number;
  assignedProviders: number;
  currentMonthSpendUsd: number;
  budgetUsedPercent: number | null;
  expired: boolean;
  lastRotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProviderMutation {
  name: string;
  label: string;
  providerType: LlmProviderType;
  baseUrl: string;
  authType: LlmProviderAuthType;
  secretName: string | null;
  apiKey?: string | null;
  credentialProfileId: number | null;
  enabled: boolean;
}

export interface LlmProviderRecord extends Omit<LlmProviderMutation, 'apiKey'> {
  id: number;
  credentialConfigured: boolean;
  inlineCredentialConfigured: boolean;
  credentialProfileLabel: string | null;
  lastTestStatus: 'healthy' | 'failed' | null;
  lastTestedAt: string | null;
  lastTestError: string | null;
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LlmModelMutation {
  modelName: string;
  displayName: string;
  providerId: number;
  upstreamModelName: string;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  inputCostPer1k: number | null;
  outputCostPer1k: number | null;
}

export interface LlmModelRecord extends LlmModelMutation {
  id: number;
  providerLabel: string;
  providerType: LlmProviderType;
  providerEnabled: boolean;
  assignedAgents: number;
  createdAt: string;
  updatedAt: string;
}

export interface LlmCatalog {
  providers: LlmProviderRecord[];
  models: LlmModelRecord[];
  credentialProfiles: LlmCredentialProfileRecord[];
  summary: {
    enabledProviders: number;
    enabledModels: number;
    healthyProviders: number;
    configuredCredentials: number;
  };
}

export interface LlmProviderTestResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  error?: string;
}

export interface OnboardingProvider {
  id: number;
  name: string;
  label: string;
  providerType: LlmProviderType;
  baseUrl: string;
  authType: LlmProviderAuthType;
  enabled: boolean;
  credentialConfigured: boolean;
  lastTestStatus: 'healthy' | 'failed' | null;
  modelCount: number;
  canTest: boolean;
}

export interface OnboardingModel {
  id: number;
  modelName: string;
  displayName: string;
  providerId: number;
  providerLabel: string;
  providerType: LlmProviderType;
  enabled: boolean;
  providerEnabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
}

export interface OnboardingAgent {
  id: number;
  name: string;
  label: string;
  description: string;
  model: string;
}

export interface OnboardingStarterAgent {
  id: number;
  name: string;
  label: string;
  description: string;
  category: string;
  agentMode: 'chat' | 'worker' | 'reviewer';
  recommendedCapabilities: string[];
  requiredToolPatterns: string[];
  minimumBundleCount: number;
  compatibleBundleIds: number[];
  installed: boolean;
  installedAgentId: number | null;
  installedAgents: OnboardingAgent[];
  version: number;
}

export interface OnboardingBundle {
  id: number;
  name: string;
  label: string;
  description: string;
}

export interface OnboardingCatalog {
  generatedAt: string;
  providers: OnboardingProvider[];
  models: OnboardingModel[];
  agents: OnboardingAgent[];
  starterAgents: OnboardingStarterAgent[];
  bundles: OnboardingBundle[];
}

export interface FabricExecutionTarget {
  kind: 'kubernetes';
  platform: 'kubernetes' | 'aks' | 'eks' | 'gke' | 'openshift';
  backendId: number;
  backendName: string;
  targetId: string;
  label: string;
  targetLabel: string;
  cluster: string;
  namespace: string;
  environment: string;
  bundleIds: number[];
}

export type EvaluationDatasetStatus = 'draft' | 'active' | 'archived';
export type EvaluationExperimentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface QualityReview {
  id:number; trace_id:string; source_sha256:string; status:'open'|'reviewed'|'resolved';
  verdict:'needs_review'|'confirmed_issue'|'acceptable'; note:string; reviewer_user_id:number;
  previous_review_id:number|null; created_at:string;
}
export interface QualityItem {
  trace_id:string; name:string; agent:string|null; model:string|null; started_at:string;
  run_status:string; source_sha256:string; status:QualityReview['status']; review_stale:boolean;
  signals:{ failed_run:boolean; human_feedback:number; evaluation_failures:number; evaluation_errors:number };
  review:QualityReview|null;
  evaluation_experiment_id:number|null;
}
export interface QualityQueue { items:QualityItem[]; window_days:number; candidate_limit:number; possibly_truncated:boolean }
export interface EvaluationStarterSet {
  key:string; version:number; name:string; description:string; evidence_kind:'synthetic'; content_sha256:string;
  cases:Array<{ caseKey:string; input:unknown; context:unknown; expectedOutput:unknown; rules:EvaluationRules; metadata:Record<string,unknown> }>;
}
export interface EvaluationTracePreview {
  source:{ trace_id:string; span_id:string|null }; name:unknown; status:string;
  input:unknown; observed_output:unknown; preview_sha256:string; warning:string;
}
export interface EvaluationDataset {
  contract_version?: number;
  id: number;
  dataset_key: string;
  version: number;
  name: string;
  description: string;
  bundle_ids: number[];
  agent_id: number | null;
  status: EvaluationDatasetStatus;
  case_count: number;
  content_sha256: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvaluationCase {
  source_trace_id?:string|null;
  source_span_id?:string|null;
  metadata?:Record<string,unknown>;
  rules?: EvaluationRules | null;
  id: number;
  dataset_id: number;
  case_key: string;
  input_redacted: unknown;
  expected_output: unknown;
  context_redacted: unknown;
  input_sha256: string;
  created_at: string;
}

export interface EvaluationDatasetDetail {
  dataset: EvaluationDataset;
  cases: EvaluationCase[];
}

export interface EvaluationExperiment {
  configuration_snapshot?: Record<string, unknown> | null;
  comparison_id?:number|null;
  comparison_status?:EvaluationExperimentStatus|null;
  evidence_kind?: 'legacy_smoke' | 'frozen_v1';
  readiness?: { startable: boolean; code: string; reason: string };
  dataset_sha256?: string | null;
  configuration_sha256?: string | null;
  expected_cases?: Array<{ id: number; case_key: string; sha256: string }> | null;
  id: number;
  dataset_id: number;
  dataset_key?: string;
  dataset_version?: number;
  dataset_agent_id?: number | null;
  agent_id: number | null;
  model_ref: string;
  credential_ref: string | null;
  evaluator_config: Record<string, unknown>;
  baseline_experiment_id: number | null;
  status: EvaluationExperimentStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface EvaluationResult {
  trace_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  evidence?: { judgement?: unknown; measurements?: Record<string,unknown> } | null;
  id: number;
  experiment_id: number;
  case_id: number;
  attempt: number;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  output_redacted: unknown;
  latency_ms: number | null;
  scores: Record<string, number>;
  evaluator_version: string | null;
  error_message: string | null;
}

export interface EvaluationRegressionResponse {
  comparison_state?: 'passed' | 'failed' | 'inconclusive' | 'not_comparable';
  candidate: { experimentId: number; status: string; overall: number; cases: number; errors?: number; latencyMs?: number; costUsd?: number };
  baseline: { experimentId: number; status: string; overall: number; cases: number; errors?: number; latencyMs?: number; costUsd?: number } | null;
  result: { status: 'passed' | 'failed'; scoreDelta: number; checks: Array<{ name: string; status: 'passed' | 'failed'; observed: number; threshold: number; detail?: string }> } | null;
  reason?: string;
}

export interface EvaluationExperimentDetail {
  experiment: EvaluationExperiment;
  results: EvaluationResult[];
  cancellation_requested?: boolean;
  attempts?: Array<{ case_id:number; attempt:number; trace_id:string|null; started_at:string }>;
  progress?: { total_cases:number; completed_cases:number; recorded_attempts:number; pending_attempts:number; retryable_case_ids:number[] };
}

export interface EvaluationComparison {
  stop_reason?:string|null;
  id:number; name:string; dataset_id:number; repetitions:number; order_mode:'alternating'|'baseline_first';
  status:EvaluationExperimentStatus; cancel_requested:boolean; created_at:string; started_at:string|null;
  plan:Array<{ position:number; round:number; variant:'baseline'|'candidate'; experiment_id:number; configuration_sha256:string }>;
}
export interface EvaluationComparisonDetail {
  comparison:EvaluationComparison;
  records:Array<EvaluationExperimentDetail & EvaluationComparison['plan'][number]>;
  summary:{ comparison_state:string; completed_steps:number; total_steps:number; planned_requests:number; remaining_requests:number;
    cost_coverage:{ measured:number; total:number; known_subtotal_usd:number }; note:string;
    rounds:Array<{ round:number; baseline_experiment_id:number|null; candidate_experiment_id:number|null; evidence:EvaluationRegressionResponse|null }> };
}

export type EvaluationAssertion =
  | { type:'text_equals'|'text_includes'|'text_excludes'; value:string }
  | { type:'json_object'; required:string[] }
  | { type:'json_field_equals'; path:string[]; value:string|number|boolean|null };
export interface EvaluationRules { version:'argus.deterministic.v1'; assertions:EvaluationAssertion[] }
export interface EvaluationTargets {
  agent:{ id:number; label:string; runtime_type:string; runtime_label:string; default_model:string|null; reasoning_effort?:string|null };
  blocker:string|null;
  targets:Array<{ id:number; kind?:'api_model'|'runtime_profile'; model_ref:string; label:string; effective_model:string; provider_label:string; selectable:boolean; reason:string|null }>;
  note:string;
}
export interface EvaluationComparisonInput {
  name:string; dataset_id:number; baseline:{ agent_id:number; model_ref:string }; candidate:{ agent_id:number; model_ref:string;prompt_revision_id?:number;skill_revision_id?:number };
  repetitions:number; order_mode:'alternating'|'baseline_first'; reviewed_preflight_sha256?:string;
}
export interface EvaluationPreflight {
  ready:boolean; preflight_sha256:string; comparison_kind:string; planned_requests:number; repetitions:number; order_mode:string;
  dataset:{ id:number; name:string; version:number; case_count:number; sha256:string };
  baseline:{ agent_id:number; agent_name:string; model_ref:string; effective_model:string; runtime_label:string; skill_count:number; temperature:unknown; max_tokens:unknown; thinking_budget:unknown; reasoning_effort:unknown; prompt_sha256:string; skills_sha256:string; configuration_sha256:string };
  candidate:EvaluationPreflight['baseline']; differences:string[]; warnings:string[];
}

export type ConsoleModuleId =
  | 'argus.core'
  | 'argus.dev'
  | 'argus.aiops'
  | 'argus.hermes'
  | 'public-channels'
  | 'compliance';

export interface ConsoleModuleCapability {
  id: ConsoleModuleId;
  installed: boolean;
  entitled: boolean;
  available: boolean;
  reason: 'available' | 'not_installed' | 'not_entitled';
}

export interface ConsoleNavigationCapabilityResponse {
  schemaVersion: 1;
  generatedAt: string;
  actor: { id: number; role: string };
  permissions: string[];
  modules: ConsoleModuleCapability[];
  navigation: {
    canUseArgusDev: boolean;
    canBuildWorkflows: boolean;
    canManageAgents: boolean;
    canManageIntegrations: boolean;
    canManageKnowledge: boolean;
    canRunEvaluations: boolean;
    canReviewApprovals: boolean;
    canObservePlatform: boolean;
    canReadAuditEvidence: boolean;
    canManageRuntimePolicy: boolean;
    canUseCompliance: boolean;
    canManagePublicChannels: boolean;
    canSearchWorkspaceResources: boolean;
    canAdminPlatform: boolean;
  };
}

export type GlobalSearchResourceType = 'agent' | 'workflow' | 'skill' | 'knowledge' | 'bundle';

export interface GlobalSearchResult {
  type: GlobalSearchResourceType;
  id: string;
  title: string;
  subtitle: string;
  description: string;
  href: string;
  status: string | null;
  score: number;
}

export interface GlobalSearchResponse {
  schemaVersion: 1;
  generatedAt: string;
  query: string;
  results: GlobalSearchResult[];
  counts: Partial<Record<GlobalSearchResourceType, number>>;
  truncated: boolean;
  durationMs: number;
}
