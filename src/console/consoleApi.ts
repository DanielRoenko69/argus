import type { Express, Request, RequestHandler, Response } from 'express';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ActiveSession } from '../agents/activeSessions.js';
import { hasFreshMfaSession, type SessionUser } from '../auth/userAuth.js';
import {
  resolveAuthorizedWorkspaceScope,
  type AuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../auth/workspaceScope.js';
import type { DynamicToolRow } from '../tools/dynamic/index.js';
import type { getStatus } from '../status/statusData.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { LANGGRAPH_URL, WORKSPACE_SECRET } from '../config/env.js';
import type { Config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { hasRole } from '../auth/roles.js';
import { deleteBundle, getBundle, getBundleBackends, getBundleTools, listBundles } from '../bundles/serviceBundles.js';
import { checkBundleCapabilities, loadBundleCapabilities } from '../solutionPacks/bundleCapabilities.js';
import {
  executionTargetsFromBackend,
  mergeExecutionTargetConfig,
  normalizeKubernetesExecutionTargetMutation,
  resolveExecutionResourceScope,
  type KubernetesExecutionTargetConfig,
} from '../solutionPacks/executionTargets.js';
import {
  importKubernetesCertification,
  KubernetesCertificationError,
  listKubernetesCertificationHistory,
  listLatestKubernetesCertifications,
  loadKubernetesCertificationPolicy,
  normalizeKubernetesCertificationReport,
  resolveKubernetesCertificationBackendId,
} from '../solutionPacks/kubernetesCertificationStore.js';
import { writeAdminAudit } from '../lib/adminAudit.js';
import {
  isOpenApiCategory,
  lockBackendOpenApiOwnership,
  OpenApiOwnershipError,
  openApiConflictBody,
} from '../lib/openApiOwnership.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { encrypt } from '../lib/encryption.js';
import { protectHeadersForStorage, redactHeaders } from '../backends/headerSecrets.js';
import {
  assertSsrfSafe,
  checkCustomBackend,
  type CustomBackendRow,
} from '../backends/customBackends.js';
import {
  checkRemoteMcp,
  connectRemoteMcp,
  disconnectRemoteMcp,
  getRemoteConnection,
  persistDiscoveredTools,
  refreshRemoteMcpTools,
} from '../backends/remoteMcpClients.js';
import {
  decideRuntimeApprovalAudited,
  getRuntimeApproval,
  RuntimeApprovalDecisionError,
  type RuntimeApprovalRecord,
} from '../approvals/runtimeApprovalStore.js';
import { buildUserLifecycleAuditContext } from '../auth/userLifecycleAuditContext.js';
import { dispatchRuntimeApprovalDecision } from '../workflows/runtimeResumeCoordinator.js';
import type { StepResult, WorkflowStep } from '../workflows/types.js';
import type { RiskFactor, RiskLevel } from '../approvals/riskEngine.js';
import type { McpCatalogChangeSummary, McpTrustStatus } from '../backends/mcpRegistry.js';
import {
  loadAllowedToolNames,
  listBundleToolPolicies,
  type BundleBackendToolPolicy,
  type BundleToolPolicyMode,
} from '../bundles/toolPolicies.js';
import { fetchUserPolicyData } from '../auth/userPolicyStore.js';
import { explainUserPolicy, type PolicyExplanationStep } from '../auth/userPolicyResolver.js';
import { isToolAllowed, isToolAllowedByPatterns, loadApiKeyRbac, type ApiKeyRbacEntry } from '../auth/apiKeyRbac.js';
import { buildPolicyPosture } from './policyPosture.js';
import {
  describeBackendSso,
  parseBackendSsoPortal,
  validatedBackendSsoLaunchUrl,
} from './backendSso.js';
import {
  buildConsoleNavigationCapabilities,
  CONSOLE_MODULE_IDS,
  type ConsoleModuleId,
} from './navigationCapabilities.js';
import {
  cleanDeletedCapabilityPolicies,
  normalizeCapabilityMutation,
  syncCapabilityBundleAssignments,
  type NormalizedCapabilityMutation,
} from './capabilityStudio.js';
import { importOpenApi } from '../actions/openapi/importOpenApi.js';
import {
  prepareOpenApiStudioPreview,
  type OpenApiStudioSourceInput,
} from '../actions/openapi/studio.js';
import { buildOpenApiCapabilityManifest } from '../actions/openapi/manifest.js';
import {
  CapabilitySourceError,
  checkCapabilitySource,
  listCapabilitySources,
} from '../actions/openapi/lifecycle.js';
import {
  OpenApiSourceRetirementError,
  previewOpenApiSourceRetirement,
  retireOpenApiSource,
} from '../actions/openapi/retirement.js';
import {
  CapabilityPlaygroundError,
  runCapabilityPlayground,
} from './capabilityPlayground.js';
import { redact, redactJson } from '../lib/redaction.js';
import {
  getTelemetryAnalytics,
  getTelemetrySpan,
  getTelemetryTrace,
  getTelemetryTraceHistoricalBaseline,
  findPreviousComparableTelemetryTrace,
  listTelemetryTraceFamily,
  listTelemetryTraces,
  workflowTelemetryTraceId,
  type TelemetrySpanRow,
  type TelemetryReadAccess,
  type TelemetryTraceFamilyRow,
  type TelemetryTraceRow,
} from '../observability/telemetryStore.js';
import {
  archiveNativeAlertRule,
  createNativeAlertRule,
  installNativeAlertTemplate,
  listNativeAlerts,
  listNativeAlertTemplates,
  runNativeAlertEvaluation,
  updateNativeAlertRule,
  type NativeAlertMetric,
  type NativeAlertOperator,
  type NativeAlertRuleInput,
  type NativeAlertScopeKind,
  type NativeAlertSeverity,
} from '../observability/nativeAlerts.js';
import { buildNativeServiceHealth } from '../observability/nativeServiceHealth.js';
import { analyzeTelemetryTraceFamily } from '../observability/criticalPath.js';
import { compareTelemetryTraceFamilies, summarizeTelemetryTraceFamily } from '../observability/traceComparison.js';
import { assessHistoricalTraceBaseline } from '../observability/traceBaseline.js';
import { buildRunCodeIntelligenceEvidence } from '../codeIntelligence/runEvidence.js';
import {
  createNativeSlo,
  deleteNativeSlo,
  listNativeSlos,
  updateNativeSlo,
  type NativeSloInput,
  type NativeSloMetric,
} from '../observability/nativeSlos.js';
import { getNativeDependencyMap } from '../observability/nativeDependencyMap.js';
import { listServiceCatalog, refreshServiceCatalog } from '../observability/serviceCatalog.js';
import { getServiceTopology } from '../observability/serviceTopology.js';
import { getIncidentChangeCorrelations } from '../observability/incidentCorrelation.js';
import { getIncidentImpact } from '../observability/incidentImpact.js';
import { getAiopsOutcomes } from '../observability/aiopsOutcomes.js';
import {
  CanaryConfigurationError,
  CanaryRunConflictError,
  getCanaryOperations,
  loadCanaryConfig,
  normalizeCanaryRunAgentIds,
  runCanariesNow,
  saveCanaryConfig,
} from '../observability/canaries.js';
import {
  CiProviderCanaryError,
  getCiProviderCanaryOperations,
  runCiProviderCanaries,
} from '../observability/ciProviderCanaries.js';
import {
  listTraceFeedback,
  submitHumanFeedback,
  summarizeTraceFeedback,
  type FeedbackSentiment,
  type TraceFeedbackRow,
} from '../observability/feedbackStore.js';
import {
  createWidget,
  deleteWidget,
  getWidget,
  listPublicWidgetAgents,
  listWidgets,
  updateWidget,
  type PublicWidget,
  type PublicWidgetAgent,
} from '../public/widgetStore.js';
import { normalizePublicWidgetMutation } from '../public/widgetAdmin.js';
import {
  disablePublicWidgetDemo,
  provisionPublicWidgetDemo,
  PUBLIC_WIDGET_DEMO_AGENT_NAME,
  PUBLIC_WIDGET_DEMO_SLUG,
  PublicWidgetDemoError,
} from '../public/publicWidgetDemo.js';
import {
  createToolFilterAudited,
  deleteToolFilterAudited,
  getToolFilter,
  loadAllToolFilters,
  loadToolFilters,
  setToolFilters,
  testToolFilter,
  updateToolFilterAudited,
  ToolFilterMutationError,
  type ToolFilterRow,
} from '../filters/toolFilters.js';
import { normalizeToolFilterMutation, normalizeToolFilterTest } from '../filters/toolFilterAdmin.js';
import { listHooks } from '../agents/hooks/index.js';
import { createAgent, listChatVisibleAgents } from '../agents/agentStore.js';
import {
  AgentTemplateInstallError,
  installAgentTemplate,
  listAgentTemplates,
} from '../agents/agentTemplates.js';
import {
  createLlmModel,
  createLlmProvider,
  deleteLlmModel,
  deleteLlmProvider,
  listLlmCatalog,
  listLlmOnboardingCatalog,
  normalizeLlmModelInput,
  normalizeLlmProviderInput,
  testLlmProvider,
  updateLlmModel,
  updateLlmProvider,
} from '../llm/modelRegistry.js';
import {
  createLlmCredentialProfile,
  deleteLlmCredentialProfile,
  listLlmCredentialProfiles,
  normalizeLlmCredentialProfileInput,
  updateLlmCredentialProfile,
} from '../llm/credentialProfiles.js';
import {
  assertOnboardingProviderCredentials,
  assertOnboardingProviderUrlSafe,
  canUseOnboardingProvider,
  isSharedOnboardingProvider,
  OnboardingPolicyError,
  scopeOnboardingBundleIds,
} from './onboardingSecurity.js';
import {
  deleteRun as deleteComplianceRun,
  getFrameworkById as getComplianceFrameworkById,
  getRun as getComplianceRun,
  listFindings as listComplianceFindings,
  listFrameworks as listComplianceFrameworks,
  listRuns as listComplianceRuns,
  startRun as startComplianceRun,
} from '../admin/compliance/store.js';
import { executeAuditRun, resolveComplianceAuditorAgentId } from '../admin/compliance/runner.js';
import { exportCsv as exportComplianceCsv, exportPdf as exportCompliancePdf } from '../admin/compliance/export.js';
import { normalizeComplianceRunInput, parseComplianceRunId } from '../admin/compliance/input.js';
import {
  buildComplianceWorkspace,
  mapComplianceFinding,
  mapComplianceFramework,
  mapComplianceRun,
} from './complianceWorkspace.js';
import { loadSkillAdoption, normalizeSkillAdoptionDays } from './skillAdoption.js';
import {
  getNativeServiceTemplateCatalog,
  installNativeServiceTemplate,
  ServiceTemplateCatalogError,
} from './serviceTemplateCatalog.js';
import {
  applyApprovedFabricProfileRestore,
  applyFabricProfileAudited,
  checkFabricProfileDriftAudited,
  diffFabricProfileVersions,
  exportFabricProfileAudited,
  listFabricProfileSsoGroups,
  listFabricProfiles,
  listFabricProfileVersions,
  listFabricProfileRestoreRequests,
  planFabricProfileImportAudited,
  requestFabricProfileRestore,
  decideFabricProfileRestore,
} from './fabricProfiles.js';
import {
  observeFabricProfileOperation,
  recordFabricProfileDriftFindings,
  resolveFabricProfileCorrelation,
} from './fabricProfileTelemetry.js';

type PlatformStatus = Awaited<ReturnType<typeof getStatus>>;

interface ConsoleApiDependencies {
  pool: pg.Pool;
  config: Config;
  requireAuth: RequestHandler;
  requireSameOrigin: RequestHandler;
  loadStatus: () => Promise<PlatformStatus>;
  listActiveSessions: () => ActiveSession[];
  refreshBackends: () => Promise<void>;
  refreshDynamicTools: () => Promise<void>;
  publicWidgetEnabled: boolean;
  loadCodexRuntimeStatus?: () => Promise<Record<string, unknown>>;
  cancelCodexRuntimeRun?: (runId: string) => Promise<Record<string, unknown>>;
  loadClaudeRuntimeStatus?: () => Promise<Record<string, unknown>>;
  cancelClaudeRuntimeRun?: (runId: string) => Promise<Record<string, unknown>>;
  startRuntimeAuthSession?: (provider: 'codex' | 'claude-code', input: { sso: boolean }) => Promise<Record<string, unknown>>;
  loadRuntimeAuthSession?: (provider: 'codex' | 'claude-code', sessionId: string) => Promise<Record<string, unknown>>;
  submitRuntimeAuthCode?: (provider: 'codex' | 'claude-code', sessionId: string, code: string) => Promise<Record<string, unknown>>;
  cancelRuntimeAuthSession?: (provider: 'codex' | 'claude-code', sessionId: string) => Promise<Record<string, unknown>>;
}

interface WorkflowRunRow {
  id: string;
  workflow_id: number;
  workflow_name: string;
  description: string;
  status: 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  triggered_by: string | null;
  error_message: string | null;
}

interface WorkflowRunDetailRow extends WorkflowRunRow {
  workflow_steps: WorkflowStep[];
  input_args: Record<string, unknown>;
  step_results: Record<string, StepResult>;
  execution_snapshot: Record<string, unknown>;
  waiting_approval_id: number | null;
  waiting_step_id: string | null;
  resume_count: number;
  resumed_at: string | null;
  lifecycle_status: string;
  human_oversight_required: boolean;
  tags: string[];
}

interface RuntimeApprovalTimelineRow {
  id: number;
  status: RuntimeApprovalRecord['status'];
  tool_name: string;
  workflow_step_id: string | null;
  requested_at: string;
  decided_at: string | null;
  consumed_at: string | null;
  decided_by_username: string | null;
  decision_comment: string | null;
  risk_level: RiskLevel;
  risk_score: number;
  risk_factors: RiskFactor[];
  risk_model: string;
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

interface WorkflowStatsRow {
  active: string;
  completed_24h: string;
  failed_24h: string;
}

interface WorkflowApprovalRow {
  id: number;
  name: string;
  description: string;
  updated_at: string;
  human_oversight_required: boolean;
  tags: string[];
  submitted_by: string | null;
  submitted_at: string | null;
  submission_comment: string | null;
  workflow_version: number | null;
  bundle_names: string[];
  history: Array<{
    id: string;
    action: 'submitted' | 'approved' | 'rejected' | 'withdrawn';
    actor: string;
    role: string | null;
    comment: string | null;
    createdAt: string;
  }>;
}

interface ApprovalDecisionRow {
  id: string;
  workflow_id: number;
  workflow_name: string;
  action: 'approved' | 'rejected' | 'withdrawn';
  actor_username: string;
  actor_role: string | null;
  comment: string | null;
  created_at: string;
}

interface RuntimeApprovalInboxRow extends RuntimeApprovalRecord {
  subject_label: string;
  requested_by_username: string | null;
  bundle_names: string[];
}

interface RuntimeApprovalDecisionRow {
  id: string;
  subject_label: string;
  tool_name: string;
  status: 'approved' | 'rejected' | 'consumed';
  decided_by_username: string | null;
  decision_comment: string | null;
  decided_at: string | null;
  subject_href: string;
}

export interface WorkflowAgentContractRunEvidence {
  traceId: string;
  title: string;
  taskType: string | null;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  durationMs: number | null;
  runHref: string;
  traceHref: string;
}

export interface WorkflowAgentContractEvidenceAssignment {
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
  runs: WorkflowAgentContractRunEvidence[];
}

export interface WorkflowAgentContractEvidence {
  schemaVersion: 1;
  capturedAt: string | null;
  contractFingerprint: string | null;
  inferredLegacyContract: boolean;
  assignments: WorkflowAgentContractEvidenceAssignment[];
}

interface CodingApprovalThreadRow {
  thread_id: string;
  graph_id?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  values?: Record<string, unknown>;
  updated_at?: string;
  interrupts?: Array<{ id?: string; value?: Record<string, unknown> }>;
}

interface CodingApprovalData {
  pending: Array<{
    threadId: string;
    ticketId: string;
    description: string;
    message: string;
    planSummary: string;
    reviewSummary: string;
    submittedAt: string;
    bundleNames: string[];
  }>;
}

interface McpRegistryViewRow {
  backend_id: number;
  trust_status: McpTrustStatus;
  catalog_fingerprint: string;
  trusted_fingerprint: string | null;
  tool_count: number;
  change_summary: McpCatalogChangeSummary;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
  changed_at: string | Date | null;
  verified_at: string | Date | null;
  verification_comment: string | null;
}

function numberValue(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface FabricBundleMutationInput {
  name?: string;
  label: string;
  description?: string | null;
  icon?: string | null;
  agentRole?: string | null;
  systemPrompt?: string | null;
  backendIds?: number[];
  skillIds?: number[];
  toolPolicies?: Array<{
    backendId?: number;
    mode?: BundleToolPolicyMode;
    allowedToolNames?: string[];
  }>;
}

export interface NormalizedFabricBundleMutation {
  name?: string;
  label: string;
  description: string;
  icon: string;
  agentRole: string | null;
  systemPrompt: string | null;
  backendIds: number[];
  skillIds: number[];
  toolPolicies: Array<{
    backendId: number;
    mode: BundleToolPolicyMode;
    allowedToolNames: string[];
  }>;
}

export interface FabricConnectionMutationInput {
  name?: string;
  type?: 'mcp' | 'http';
  description?: string | null;
  baseUrl?: string;
  mcpEndpoint?: string | null;
  authType?: 'none' | 'bearer' | 'basic' | 'header';
  authValue?: string | null;
  healthPath?: string | null;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  tlsSkipVerify?: boolean;
  enabled?: boolean;
  authMode?: 'service-account' | 'permissive' | 'strict';
  oauthAuthorizeUrl?: string | null;
  oauthTokenUrl?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  oauthScopes?: string[] | string | null;
  oauthRevokeUrl?: string | null;
  bundleIds?: number[];
  executionTarget?: {
    kind?: 'kubernetes';
    platform?: 'kubernetes' | 'aks' | 'eks' | 'gke' | 'openshift';
    targetId?: string;
    label?: string;
    cluster?: string;
    environment?: string;
    namespaces?: string[];
  } | null;
}

export interface NormalizedFabricConnectionMutation {
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
  oauthScopes: string[] | null;
  oauthRevokeUrl: string | null;
  bundleIds: number[];
  executionTarget?: KubernetesExecutionTargetConfig | null;
}

function normalizedOptionalText(value: unknown, maxLength: number, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`${label} muss Text sein`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} darf maximal ${maxLength} Zeichen enthalten`);
  return normalized || null;
}

function normalizedHttpUrl(value: unknown, required: boolean, label: string): string | null {
  const normalized = normalizedOptionalText(value, 2_048, label);
  if (!normalized) {
    if (required) throw new Error(`${label} ist erforderlich`);
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} ist keine gültige URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} muss HTTP oder HTTPS verwenden`);
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function normalizeFabricConnectionMutation(
  value: FabricConnectionMutationInput,
  requireName: boolean,
): NormalizedFabricConnectionMutation {
  if (!value || typeof value !== 'object') throw new Error('Connection-Daten fehlen');
  const rawName = typeof value.name === 'string' ? value.name.trim() : '';
  if (requireName && !rawName) throw new Error('Interner Name ist erforderlich');
  if (rawName && (!/^[a-z0-9][a-z0-9_-]*$/.test(rawName) || rawName.length > 64)) {
    throw new Error('Interner Name darf nur a-z, 0-9, _ und - enthalten');
  }
  const type = value.type === 'http' ? 'http' : value.type === 'mcp' ? 'mcp' : null;
  if (!type) throw new Error('Connection-Typ muss MCP oder HTTP sein');
  const baseUrl = normalizedHttpUrl(value.baseUrl, true, 'Base URL')!;
  const description = normalizedOptionalText(value.description, 5_000, 'Beschreibung') ?? '';
  const normalizePath = (pathValue: unknown, fallback: string | null, label: string) => {
    const path = normalizedOptionalText(pathValue, 256, label);
    const effective = pathValue === undefined ? fallback : path;
    if (effective && !effective.startsWith('/')) throw new Error(`${label} muss mit / beginnen`);
    return effective;
  };
  const mcpEndpoint = type === 'mcp'
    ? normalizePath(value.mcpEndpoint, '/mcp', 'MCP Endpoint')
    : null;
  const healthPath = type === 'http'
    ? normalizePath(value.healthPath, '/health', 'Health Endpoint')
    : null;
  const authTypes = new Set(['none', 'bearer', 'basic', 'header']);
  const authType = authTypes.has(value.authType ?? 'none')
    ? (value.authType ?? 'none') as NormalizedFabricConnectionMutation['authType']
    : 'none';
  const authModes = new Set(['service-account', 'permissive', 'strict']);
  const authMode = authModes.has(value.authMode ?? 'service-account')
    ? (value.authMode ?? 'service-account') as NormalizedFabricConnectionMutation['authMode']
    : 'service-account';
  const timeoutMs = Number(value.timeoutMs ?? 10_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120_000) {
    throw new Error('Timeout muss zwischen 500 und 120000 ms liegen');
  }
  const defaultHeaders = value.defaultHeaders ?? {};
  if (!defaultHeaders || Array.isArray(defaultHeaders) || typeof defaultHeaders !== 'object') {
    throw new Error('Default Headers müssen ein Objekt sein');
  }
  const headerEntries = Object.entries(defaultHeaders);
  if (headerEntries.length > 100 || JSON.stringify(defaultHeaders).length > 10_000) {
    throw new Error('Default Headers sind zu groß');
  }
  if (headerEntries.some(([key, headerValue]) =>
    !key.trim() || key.length > 256 || typeof headerValue !== 'string' || headerValue.length > 4_096)) {
    throw new Error('Default Headers enthalten einen ungültigen Eintrag');
  }
  if (!Array.isArray(value.bundleIds ?? [])) throw new Error('Bundle-Zuordnungen müssen als Liste übergeben werden');
  const bundleIds = [...new Set((value.bundleIds ?? []).map(Number))];
  if (bundleIds.length > 500 || bundleIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('Bundle-Zuordnungen enthalten eine ungültige ID');
  }
  const normalizeSecret = (secret: unknown, label: string): string | null | undefined => {
    if (secret === undefined) return undefined;
    if (secret === null) return null;
    if (typeof secret !== 'string') throw new Error(`${label} muss Text sein`);
    if (secret.length > 20_000) throw new Error(`${label} ist zu lang`);
    return secret || null;
  };
  const scopes = Array.isArray(value.oauthScopes)
    ? value.oauthScopes
    : typeof value.oauthScopes === 'string'
      ? value.oauthScopes.split(/\s+/)
      : [];
  const oauthScopes = [...new Set(scopes.map(scope => String(scope).trim()).filter(Boolean))];
  if (oauthScopes.length > 100 || oauthScopes.some(scope => scope.length > 256)) {
    throw new Error('OAuth Scopes sind ungültig');
  }
  const tlsSkipVerify = value.tlsSkipVerify === true;
  if (tlsSkipVerify && process.env.NODE_ENV === 'production') {
    throw new Error('TLS-Prüfung kann in Production nicht deaktiviert werden');
  }
  const normalized: NormalizedFabricConnectionMutation = {
    ...(rawName ? { name: rawName } : {}),
    type,
    description,
    baseUrl,
    mcpEndpoint,
    authType,
    healthPath,
    defaultHeaders: Object.fromEntries(headerEntries.map(([key, headerValue]) => [key.trim(), headerValue])),
    timeoutMs,
    tlsSkipVerify,
    enabled: value.enabled !== false,
    authMode,
    oauthAuthorizeUrl: normalizedHttpUrl(value.oauthAuthorizeUrl, false, 'OAuth Authorize URL'),
    oauthTokenUrl: normalizedHttpUrl(value.oauthTokenUrl, false, 'OAuth Token URL'),
    oauthClientId: normalizedOptionalText(value.oauthClientId, 2_048, 'OAuth Client ID'),
    oauthScopes: oauthScopes.length > 0 ? oauthScopes : null,
    oauthRevokeUrl: normalizedHttpUrl(value.oauthRevokeUrl, false, 'OAuth Revoke URL'),
    bundleIds,
    ...(value.executionTarget === undefined
      ? {}
      : { executionTarget: value.executionTarget === null ? null : normalizeKubernetesExecutionTargetMutation(value.executionTarget) }),
  };
  if (normalized.executionTarget && normalized.type !== 'mcp') {
    throw new Error('Kubernetes execution targets require an MCP connection');
  }
  if (normalized.executionTarget && normalized.bundleIds.length === 0) {
    throw new Error('Kubernetes execution targets require at least one access bundle');
  }
  const authValue = normalizeSecret(value.authValue, 'Service-Credential');
  const oauthClientSecret = normalizeSecret(value.oauthClientSecret, 'OAuth Client Secret');
  return {
    ...normalized,
    ...(authValue !== undefined ? { authValue } : {}),
    ...(oauthClientSecret !== undefined ? { oauthClientSecret } : {}),
  };
}

export function normalizeFabricBundleMutation(
  value: FabricBundleMutationInput,
  requireName: boolean,
): NormalizedFabricBundleMutation {
  if (!value || typeof value !== 'object') throw new Error('Bundle-Daten fehlen');
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (!label) throw new Error('Bundle-Name ist erforderlich');
  if (label.length > 256) throw new Error('Bundle-Name darf maximal 256 Zeichen enthalten');

  const rawName = typeof value.name === 'string' ? value.name.trim() : '';
  if (requireName && !rawName) throw new Error('Interner Name ist erforderlich');
  if (rawName && (!/^[a-z0-9][a-z0-9_]*$/.test(rawName) || rawName.length > 128)) {
    throw new Error('Interner Name muss mit einer Ziffer oder einem Kleinbuchstaben beginnen und darf nur a-z, 0-9 und _ enthalten');
  }

  const description = typeof value.description === 'string' ? value.description.trim() : '';
  const icon = typeof value.icon === 'string' ? value.icon.trim() : '';
  const agentRole = typeof value.agentRole === 'string' ? value.agentRole.trim() || null : null;
  const systemPrompt = typeof value.systemPrompt === 'string' ? value.systemPrompt.trim() || null : null;
  if (description.length > 5_000) throw new Error('Beschreibung darf maximal 5000 Zeichen enthalten');
  if (icon.length > 32) throw new Error('Icon darf maximal 32 Zeichen enthalten');
  if (agentRole && agentRole.length > 128) throw new Error('Agenten-Rolle darf maximal 128 Zeichen enthalten');
  if (systemPrompt && systemPrompt.length > 20_000) throw new Error('System Prompt darf maximal 20000 Zeichen enthalten');

  const normalizeIds = (ids: number[] | undefined, labelText: string) => {
    if (ids != null && !Array.isArray(ids)) throw new Error(`${labelText}-Zuordnungen müssen als Liste übergeben werden`);
    const normalized = [...new Set((ids ?? []).map(Number))];
    if (normalized.some(id => !Number.isSafeInteger(id) || id < 1)) {
      throw new Error(`${labelText}-Zuordnungen enthalten eine ungültige ID`);
    }
    return normalized;
  };
  const backendIds = normalizeIds(value.backendIds, 'Backend');
  const skillIds = normalizeIds(value.skillIds, 'Skill');
  if (backendIds.length > 500) throw new Error('Ein Bundle kann maximal 500 Backends enthalten');
  if (skillIds.length > 500) throw new Error('Ein Bundle kann maximal 500 Skills enthalten');
  if (!Array.isArray(value.toolPolicies ?? [])) {
    throw new Error('Tool-Policies müssen als Liste übergeben werden');
  }
  const backendIdSet = new Set(backendIds);
  const policyByBackend = new Map<number, {
    backendId: number;
    mode: BundleToolPolicyMode;
    allowedToolNames: string[];
  }>();
  for (const rawPolicy of value.toolPolicies ?? []) {
    const backendId = Number(rawPolicy.backendId);
    if (!Number.isSafeInteger(backendId) || !backendIdSet.has(backendId)) {
      throw new Error('Tool-Policy verweist auf ein nicht ausgewähltes Backend');
    }
    const mode = rawPolicy.mode === 'selected' ? 'selected' : rawPolicy.mode === 'all' ? 'all' : null;
    if (!mode) throw new Error('Tool-Policy-Modus muss all oder selected sein');
    if (!Array.isArray(rawPolicy.allowedToolNames ?? [])) {
      throw new Error('Erlaubte Tool-Namen müssen als Liste übergeben werden');
    }
    const allowedToolNames = [...new Set((rawPolicy.allowedToolNames ?? []).map(tool => String(tool).trim()).filter(Boolean))];
    if (allowedToolNames.length > 5_000 || allowedToolNames.some(tool => tool.length > 256)) {
      throw new Error('Tool-Policy enthält zu viele oder ungültige Tool-Namen');
    }
    policyByBackend.set(backendId, {
      backendId,
      mode,
      allowedToolNames: mode === 'all' ? [] : allowedToolNames,
    });
  }
  const toolPolicies = backendIds.map(backendId => policyByBackend.get(backendId) ?? {
    backendId,
    mode: 'all' as const,
    allowedToolNames: [],
  });

  return {
    ...(rawName ? { name: rawName } : {}),
    label,
    description,
    icon,
    agentRole,
    systemPrompt,
    backendIds,
    skillIds,
    toolPolicies,
  };
}

function isoValue(value: string | Date | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (!value) return new Date(0).toISOString();
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : String(value);
}

function previewValue(value: unknown, maxLength = 500): string | null {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const SENSITIVE_PREVIEW_KEY = /password|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cookie/i;

function redactPreviewKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPreviewKeys);
  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = SENSITIVE_PREVIEW_KEY.test(key) ? '[REDACTED]' : redactPreviewKeys(child);
    }
    return redacted;
  }
  return value;
}

function safePreviewValue(value: unknown, maxLength = 500): string | null {
  if (value == null) return null;
  return previewValue(redactJson(redactPreviewKeys(value)).value, maxLength);
}

// Telemetry is already redacted and bounded to 16 KB before persistence.
// Preserve that retained output for explicit trace/detail views instead of
// applying the generic 500-character list-preview limit a second time.
const RETAINED_OUTPUT_MAX_LENGTH = 16_000;

export function mapWorkflowAgentContractEvidence(value: unknown): WorkflowAgentContractEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (snapshot['kind'] !== 'workflow-agent-contract' || Number(snapshot['schemaVersion']) !== 1) return null;

  const text = (entry: unknown, maxLength = 256): string | null => {
    if (typeof entry !== 'string') return null;
    const normalized = entry.trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  };
  const strings = (entry: unknown, maxItems = 128, maxLength = 256): string[] => {
    if (!Array.isArray(entry)) return [];
    return [...new Set(entry.map(item => text(item, maxLength)).filter((item): item is string => Boolean(item)))].slice(0, maxItems);
  };
  const integer = (entry: unknown): number | null => {
    const parsed = Number(entry);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  };
  const assignments = (Array.isArray(snapshot['assignments']) ? snapshot['assignments'] : [])
    .slice(0, 32)
    .flatMap(rawValue => {
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return [];
      const raw = rawValue as Record<string, unknown>;
      const role = text(raw['role'], 128);
      if (!role) return [];
      const rawRuntime = raw['runtime'];
      let runtime: WorkflowAgentContractEvidenceAssignment['runtime'] = null;
      if (rawRuntime && typeof rawRuntime === 'object' && !Array.isArray(rawRuntime)) {
        const candidate = rawRuntime as Record<string, unknown>;
        const type = ['argus', 'codex', 'claude-code', 'hermes'].includes(String(candidate['type']))
          ? String(candidate['type']) as 'argus' | 'codex' | 'claude-code' | 'hermes'
          : null;
        const state = ['ready', 'warning', 'blocked', 'disabled'].includes(String(candidate['state']))
          ? String(candidate['state']) as 'ready' | 'warning' | 'blocked' | 'disabled'
          : null;
        if (type && state) {
          runtime = {
            type,
            profileId: integer(candidate['profileId']),
            profileName: text(candidate['profileName'], 128),
            profileLabel: text(candidate['profileLabel'], 128),
            model: text(candidate['model'], 256) ?? text(raw['model'], 256) ?? 'unknown',
            state,
            detail: text(candidate['detail'], 1_000) ?? '',
          };
        }
      }
      const statusValue = String(raw['status']);
      const status = ['ready', 'degraded', 'blocked'].includes(statusValue)
        ? statusValue as WorkflowAgentContractEvidenceAssignment['status']
        : 'blocked';
      const modeValue = String(raw['agentMode']);
      const agentMode = ['chat', 'worker', 'reviewer'].includes(modeValue)
        ? modeValue as WorkflowAgentContractEvidenceAssignment['agentMode']
        : null;
      return [{
        role,
        label: text(raw['label'], 128) ?? role,
        stepIds: strings(raw['stepIds'], 64, 128),
        status,
        agentId: integer(raw['agentId']),
        agentName: text(raw['agentName'], 128),
        agentLabel: text(raw['agentLabel'], 128),
        agentMode,
        model: text(raw['model'], 256),
        presetName: text(raw['presetName'], 128),
        installedPresetVersion: integer(raw['installedPresetVersion']),
        skillNames: strings(raw['skillNames'], 64, 128),
        bundleIds: Array.isArray(raw['bundleIds'])
          ? [...new Set(raw['bundleIds'].map(integer).filter((item): item is number => item != null))].slice(0, 64)
          : [],
        toolNames: strings(raw['toolNames'], 256, 256),
        runtime,
        catalogFingerprint: text(raw['catalogFingerprint'], 128),
        blockers: strings(raw['blockers'], 64, 1_000),
        warnings: strings(raw['warnings'], 64, 1_000),
        runs: [],
      } satisfies WorkflowAgentContractEvidenceAssignment];
    });

  return {
    schemaVersion: 1,
    capturedAt: text(snapshot['capturedAt'], 64),
    contractFingerprint: text(snapshot['contractFingerprint'], 128),
    inferredLegacyContract: snapshot['inferredLegacyContract'] === true,
    assignments,
  };
}

interface WorkflowAgentContractTraceFamily {
  rootTraceId?: string;
  runs: Array<{
    id: string;
    agentId?: number | null;
    agentRole?: string | null;
    workflowStepId?: string | null;
    taskType?: string | null;
    parentTraceId?: string | null;
    kind: 'workflow' | 'agent';
    title: string;
    status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
    startedAt: string;
    durationMs: number | null;
    href?: string;
  }>;
}

function normalizedContractKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_+|_+$/g, '');
}

function contractTaskMatches(assignment: WorkflowAgentContractEvidenceAssignment, taskType: string | null | undefined): boolean {
  const task = normalizedContractKey(taskType);
  if (!task) return false;
  return [assignment.role, ...assignment.stepIds].some(value => {
    const candidate = normalizedContractKey(value);
    return candidate === task || task.startsWith(`${candidate}_`) || candidate.startsWith(`${task}_`);
  });
}

export function correlateWorkflowAgentContractRuns(
  evidence: WorkflowAgentContractEvidence | null,
  traceFamily: WorkflowAgentContractTraceFamily | null,
): WorkflowAgentContractEvidence | null {
  if (!evidence || !traceFamily) return evidence;

  const runsByRole = new Map(evidence.assignments.map(assignment => [assignment.role, [] as WorkflowAgentContractRunEvidence[]]));
  for (const run of traceFamily.runs) {
    if (run.kind !== 'agent') continue;
    // Contract roles describe the workflow's own Agent steps. Nested subagents
    // inherit ambient telemetry but are evidence for their parent step, not a
    // second execution of the portable workflow role.
    if (traceFamily.rootTraceId && run.parentTraceId && run.parentTraceId !== traceFamily.rootTraceId) continue;
    let selected: WorkflowAgentContractEvidenceAssignment | null = null;
    let selectedScore = -1;
    const explicitRole = normalizedContractKey(run.agentRole);
    const explicitStep = normalizedContractKey(run.workflowStepId);
    for (const assignment of evidence.assignments) {
      const assignmentRole = normalizedContractKey(assignment.role);
      // Once a new trace carries an explicit role, it is authoritative. The
      // legacy ID/task/name matcher remains exclusively for older traces.
      if (explicitRole && explicitRole !== assignmentRole) continue;
      if (assignment.agentId != null && run.agentId != null && assignment.agentId !== run.agentId) continue;
      const explicitRoleMatch = Boolean(explicitRole) && explicitRole === assignmentRole;
      const workflowStepMatch = Boolean(explicitStep) && assignment.stepIds
        .some(stepId => normalizedContractKey(stepId) === explicitStep);
      const agentIdMatch = assignment.agentId != null && run.agentId === assignment.agentId;
      const taskMatch = contractTaskMatches(assignment, run.taskType);
      const names = [assignment.agentName, assignment.agentLabel].map(normalizedContractKey).filter(Boolean);
      const nameMatch = names.includes(normalizedContractKey(run.title));
      const score = (explicitRoleMatch ? 1_000 : 0)
        + (workflowStepMatch ? 250 : 0)
        + (agentIdMatch ? 100 : 0)
        + (taskMatch ? 50 : 0)
        + (nameMatch ? 10 : 0);
      if (score > selectedScore && (explicitRoleMatch || workflowStepMatch || agentIdMatch || taskMatch || nameMatch)) {
        selected = assignment;
        selectedScore = score;
      }
    }
    if (!selected) continue;
    runsByRole.get(selected.role)?.push({
      traceId: run.id,
      title: run.title,
      taskType: run.taskType ?? null,
      status: run.status,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      runHref: run.href ?? `/runs/agent/${encodeURIComponent(run.id)}`,
      traceHref: `/observe/logs?trace=${encodeURIComponent(run.id)}`,
    });
  }

  return {
    ...evidence,
    assignments: evidence.assignments.map(assignment => ({
      ...assignment,
      runs: (runsByRole.get(assignment.role) ?? [])
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
        .slice(0, 20),
    })),
  };
}

export function buildWorkflowTimeline(
  run: WorkflowRunDetailRow,
  approvals: RuntimeApprovalTimelineRow[],
): RunTimelineEvent[] {
  const stepsById = new Map(run.workflow_steps.map(step => [step.id, step]));
  const events: RunTimelineEvent[] = [{
    id: `run-${run.id}-started`,
    kind: 'run_started',
    title: 'Execution started',
    detail: run.triggered_by ? `Triggered by ${run.triggered_by}` : 'Workflow execution started',
    timestamp: isoValue(run.started_at),
  }];

  for (const [stepId, result] of Object.entries(run.step_results ?? {})) {
    const definition = stepsById.get(stepId);
    const label = definition?.label || stepId;
    const toolName = definition?.tool ?? null;
    const kind = result.status === 'failed'
      ? 'step_failed'
      : result.status === 'skipped'
        ? 'step_skipped'
        : result.status === 'waiting'
          ? 'step_waiting'
          : 'step_completed';
    const verb = result.status === 'failed'
      ? 'failed'
      : result.status === 'skipped'
        ? 'skipped'
        : result.status === 'waiting'
          ? 'waiting for approval'
          : 'completed';
    events.push({
      id: `step-${stepId}-${result.status}`,
      kind,
      title: `${label} ${verb}`,
      detail: toolName ? `Tool · ${toolName}` : (definition?.type ?? 'Workflow step'),
      timestamp: isoValue(result.completed_at ?? result.started_at ?? run.started_at),
      durationMs: result.duration_ms,
      stepId,
      toolName,
      inputPreview: safePreviewValue(definition?.args),
      resultPreview: safePreviewValue(result.error ?? result.result),
    });
  }

  let consumedApprovals = 0;
  for (const approval of approvals) {
    const stepLabel = approval.workflow_step_id
      ? stepsById.get(approval.workflow_step_id)?.label ?? approval.workflow_step_id
      : null;
    events.push({
      id: `approval-${approval.id}-requested`,
      kind: 'approval_requested',
      title: 'Approval requested',
      detail: `${approval.tool_name}${stepLabel ? ` · ${stepLabel}` : ''}`,
      timestamp: isoValue(approval.requested_at),
      stepId: approval.workflow_step_id,
      approvalId: approval.id,
      toolName: approval.tool_name,
      riskLevel: approval.risk_level,
      riskScore: approval.risk_score,
      riskFactors: approval.risk_factors,
    });
    if (approval.decided_at && ['approved', 'rejected', 'consumed'].includes(approval.status)) {
      const approved = approval.status !== 'rejected';
      events.push({
        id: `approval-${approval.id}-decision`,
        kind: approved ? 'approval_approved' : 'approval_rejected',
        title: approved ? 'Approval granted' : 'Approval rejected',
        detail: approval.decided_by_username
          ? `Decision by ${approval.decided_by_username}`
          : 'Runtime governance decision',
        timestamp: isoValue(approval.decided_at),
        stepId: approval.workflow_step_id,
        approvalId: approval.id,
        toolName: approval.tool_name,
        actor: approval.decided_by_username,
        comment: approval.decision_comment,
      });
    }
    if (approval.consumed_at) {
      consumedApprovals++;
      events.push({
        id: `approval-${approval.id}-resumed`,
        kind: 'run_resumed',
        title: 'Execution resumed',
        detail: `Single-use grant consumed for ${approval.tool_name}`,
        timestamp: isoValue(approval.consumed_at),
        stepId: approval.workflow_step_id,
        approvalId: approval.id,
        toolName: approval.tool_name,
      });
    }
  }

  if (run.resume_count > consumedApprovals && run.resumed_at) {
    events.push({
      id: `run-${run.id}-resumed`,
      kind: 'run_resumed',
      title: 'Execution resumed',
      detail: `Resume attempt ${run.resume_count}`,
      timestamp: isoValue(run.resumed_at),
      stepId: run.waiting_step_id,
      approvalId: run.waiting_approval_id ?? undefined,
    });
  }

  if (run.completed_at) {
    const terminalKind = run.status === 'completed'
      ? 'run_completed'
      : run.status === 'cancelled'
        ? 'run_cancelled'
        : 'run_failed';
    events.push({
      id: `run-${run.id}-terminal`,
      kind: terminalKind,
      title: run.status === 'completed'
        ? 'Execution completed'
        : run.status === 'cancelled'
          ? 'Execution cancelled'
          : 'Execution failed',
      detail: run.error_message || `${run.workflow_name.replaceAll('_', ' ')} finished`,
      timestamp: isoValue(run.completed_at),
      durationMs: run.duration_ms,
      resultPreview: safePreviewValue(run.error_message),
    });
  }

  const order: Record<RunTimelineEventKind, number> = {
    run_started: 0,
    tool_started: 1,
    approval_requested: 2,
    approval_approved: 3,
    approval_rejected: 3,
    run_resumed: 4,
    step_waiting: 5,
    step_completed: 6,
    step_skipped: 6,
    step_failed: 6,
    tool_completed: 6,
    tool_failed: 6,
    llm_started: 1,
    llm_completed: 6,
    llm_failed: 6,
    rag_started: 1,
    rag_completed: 6,
    rag_failed: 6,
    run_completed: 7,
    run_failed: 7,
    run_cancelled: 7,
  };
  return events.sort((left, right) => {
    const delta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return delta || order[left.kind] - order[right.kind];
  });
}

function canSeeBundle(bundleIds: number[] | undefined, user: SessionUser): boolean {
  if (user.allowed_bundles == null || !bundleIds?.length) return true;
  const allowed = new Set(user.allowed_bundles);
  return bundleIds.some(id => allowed.has(id));
}

export function canOpenBundle(bundleId: number, allowedBundles: number[] | null): boolean {
  return allowedBundles == null || allowedBundles.includes(bundleId);
}

function workflowScope(user: SessionUser, startingParameter: number): {
  clause: string;
  params: unknown[];
} {
  if (user.allowed_bundles == null) return { clause: '', params: [] };
  return {
    clause: `
      AND (
        NOT EXISTS (
          SELECT 1 FROM mcp_workflow_bundles visible_wb
          WHERE visible_wb.workflow_id = w.id
        )
        OR EXISTS (
          SELECT 1 FROM mcp_workflow_bundles visible_wb
          WHERE visible_wb.workflow_id = w.id
            AND visible_wb.bundle_id = ANY($${startingParameter}::int[])
        )
      )`,
    params: [user.allowed_bundles],
  };
}

async function loadWorkflowRuns(
  pool: pg.Pool,
  user: SessionUser,
  selectedScope: AuthorizedWorkspaceScope,
  limit: number,
): Promise<WorkflowRunRow[]> {
  const scope = workflowScope(user, 4);
  const { rows } = await pool.query<WorkflowRunRow>(
    `SELECT
       e.id::text,
       e.workflow_id,
       w.name AS workflow_name,
       w.description,
       e.status,
       e.started_at,
       e.completed_at,
       e.duration_ms,
       e.triggered_by,
       e.error_message
     FROM mcp_workflow_executions e
     JOIN mcp_workflows w ON w.id = e.workflow_id
     LEFT JOIN LATERAL (
       SELECT golden.tenant_key, golden.workspace_key
         FROM mcp_golden_path_runs golden
        WHERE golden.workflow_execution_id=e.id
        ORDER BY golden.started_at DESC, golden.id
        LIMIT 1
     ) execution_scope ON true
     WHERE COALESCE(execution_scope.tenant_key, e.tenant_key, 'default')=$2
       AND COALESCE(execution_scope.workspace_key, e.workspace_key, 'default')=$3
       AND w.tenant_key = e.tenant_key
       AND w.workspace_key = e.workspace_key
     ${scope.clause}
     ORDER BY e.started_at DESC
     LIMIT $1`,
    [limit, selectedScope.tenantKey, selectedScope.workspaceKey, ...scope.params],
  );
  return rows;
}

async function loadWorkflowRunDetail(
  pool: pg.Pool,
  user: SessionUser,
  selectedScope: AuthorizedWorkspaceScope,
  executionId: number,
): Promise<{ run: WorkflowRunDetailRow; approvals: RuntimeApprovalTimelineRow[] } | null> {
  const scope = workflowScope(user, 4);
  const { rows } = await pool.query<WorkflowRunDetailRow>(
    `SELECT
       e.id::text,
       e.workflow_id,
       w.name AS workflow_name,
       w.description,
       w.steps AS workflow_steps,
       w.lifecycle_status,
       w.human_oversight_required,
       coalesce(w.tags, ARRAY[]::text[]) AS tags,
       e.status,
       e.started_at,
       e.completed_at,
       e.duration_ms,
       e.triggered_by,
       e.error_message,
       e.input_args,
       e.step_results,
       e.execution_snapshot,
       e.waiting_approval_id,
       e.waiting_step_id,
       e.resume_count,
       e.resumed_at
     FROM mcp_workflow_executions e
     JOIN mcp_workflows w ON w.id = e.workflow_id
     LEFT JOIN LATERAL (
       SELECT golden.tenant_key, golden.workspace_key
         FROM mcp_golden_path_runs golden
        WHERE golden.workflow_execution_id=e.id
        ORDER BY golden.started_at DESC, golden.id
        LIMIT 1
     ) execution_scope ON true
     WHERE e.id = $1
       AND COALESCE(execution_scope.tenant_key, e.tenant_key, 'default')=$2
       AND COALESCE(execution_scope.workspace_key, e.workspace_key, 'default')=$3
       AND w.tenant_key = e.tenant_key
       AND w.workspace_key = e.workspace_key
     ${scope.clause}
     LIMIT 1`,
    [executionId, selectedScope.tenantKey, selectedScope.workspaceKey, ...scope.params],
  );
  const run = rows[0];
  if (!run) return null;
  const approvals = await pool.query<RuntimeApprovalTimelineRow>(
    `SELECT
       id,
       status,
       tool_name,
       workflow_step_id,
       requested_at,
       decided_at,
       consumed_at,
       decided_by_username,
       decision_comment,
       risk_level,
       risk_score,
       risk_factors,
       risk_model
     FROM mcp_runtime_approvals
     WHERE workflow_execution_id = $1
       AND tenant_key = $2
       AND workspace_key = $3
     ORDER BY requested_at ASC`,
    [executionId, selectedScope.tenantKey, selectedScope.workspaceKey],
  );
  return { run, approvals: approvals.rows };
}

async function loadWorkflowStats(
  pool: pg.Pool,
  user: SessionUser,
  selectedScope: AuthorizedWorkspaceScope,
): Promise<WorkflowStatsRow> {
  const scope = workflowScope(user, 3);
  const { rows } = await pool.query<WorkflowStatsRow>(
    `SELECT
       count(*) FILTER (WHERE e.status IN ('running', 'waiting_for_approval'))::text AS active,
       count(*) FILTER (
         WHERE e.status = 'completed'
           AND e.started_at >= now() - interval '24 hours'
       )::text AS completed_24h,
       count(*) FILTER (
         WHERE e.status = 'failed'
           AND e.started_at >= now() - interval '24 hours'
       )::text AS failed_24h
     FROM mcp_workflow_executions e
     JOIN mcp_workflows w ON w.id = e.workflow_id
     LEFT JOIN LATERAL (
       SELECT golden.tenant_key, golden.workspace_key
         FROM mcp_golden_path_runs golden
        WHERE golden.workflow_execution_id=e.id
        ORDER BY golden.started_at DESC, golden.id
        LIMIT 1
     ) execution_scope ON true
     WHERE COALESCE(execution_scope.tenant_key, e.tenant_key, 'default')=$1
       AND COALESCE(execution_scope.workspace_key, e.workspace_key, 'default')=$2
       AND w.tenant_key = e.tenant_key
       AND w.workspace_key = e.workspace_key
     ${scope.clause}`,
    [selectedScope.tenantKey, selectedScope.workspaceKey, ...scope.params],
  );
  return rows[0] ?? { active: '0', completed_24h: '0', failed_24h: '0' };
}

async function loadReviewCount(
  pool: pg.Pool,
  user: SessionUser,
  selectedScope: AuthorizedWorkspaceScope,
): Promise<number> {
  const scope = workflowScope(user, 3);
  try {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM mcp_workflows w
       WHERE w.lifecycle_status = 'review'
         AND w.tenant_key = $1
         AND w.workspace_key = $2
       ${scope.clause}`,
      [selectedScope.tenantKey, selectedScope.workspaceKey, ...scope.params],
    );
    return numberValue(rows[0]?.count);
  } catch {
    // Older installations may not have migration 093 yet.
    return 0;
  }
}

/**
 * LangGraph coding approvals are checkpoint interrupts, not rows in the
 * legacy workflow-approval tables. Project the pending interrupts into the
 * same governance inbox so every human gate has one discoverable place.
 */
async function loadCodingApprovalData(pool: pg.Pool, user: SessionUser): Promise<CodingApprovalData> {
  try {
    const response = await fetch(`${LANGGRAPH_URL}/threads/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workspace-Secret': WORKSPACE_SECRET,
      },
      body: JSON.stringify({ limit: 100 }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { pending: [] };
    const payload = await response.json() as unknown;
    const threads = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { value?: unknown })['value'])
        ? (payload as { value: unknown[] }).value
        : [];
    const bundles = await listBundles(pool).catch(() => []);
    const bundleLabel = new Map(bundles.map(bundle => [bundle.id, bundle.label]));
    const visible = user.allowed_bundles;
    const pending = threads.flatMap(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const thread = raw as CodingApprovalThreadRow;
      if (thread.status !== 'interrupted' || thread.graph_id !== 'coding_workflow' || !thread.thread_id) return [];
      const metadata = thread.metadata ?? {};
      const values = thread.values ?? {};
      const bundleId = Number(metadata['argus_bundle_id'] ?? values['argus_bundle_id'] ?? 0) || null;
      if (visible !== null && bundleId !== null && !visible.includes(bundleId)) return [];
      const interrupt = (thread.interrupts ?? []).find(item => item?.value && typeof item.value === 'object')?.value ?? {};
      const text = (key: string): string => typeof interrupt[key] === 'string' ? String(interrupt[key]) : '';
      const ticketId = typeof values['ticket_id'] === 'string'
        ? values['ticket_id']
        : typeof metadata['ticket_id'] === 'string' ? metadata['ticket_id'] : 'Development run';
      return [{
        threadId: thread.thread_id,
        ticketId,
        description: typeof values['description'] === 'string'
          ? values['description']
          : typeof metadata['description'] === 'string' ? metadata['description'] : '',
        message: text('message') || 'Human approval is required before this Argus Dev workflow can continue.',
        planSummary: text('plan_summary'),
        reviewSummary: text('review_summary'),
        submittedAt: thread.updated_at ?? new Date().toISOString(),
        bundleNames: bundleId === null ? [] : [bundleLabel.get(bundleId) ?? `Bundle #${bundleId}`],
      }];
    });
    return { pending };
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load LangGraph coding approvals for governance inbox');
    return { pending: [] };
  }
}

async function loadGovernancePayload(
  pool: pg.Pool,
  user: SessionUser,
  selectedScope: AuthorizedWorkspaceScope,
) {
  const pendingScope = workflowScope(user, 3);
  const decisionsScope = workflowScope(user, 3);
  const [pendingResult, decisionsResult, runtimeData, codingData] = await Promise.all([
    pool.query<WorkflowApprovalRow>(
      `SELECT
         w.id,
         w.name,
         w.description,
         w.updated_at,
         w.human_oversight_required,
         coalesce(w.tags, ARRAY[]::text[]) AS tags,
         submission.actor_username AS submitted_by,
         submission.created_at AS submitted_at,
         submission.comment AS submission_comment,
         submission.workflow_version,
         ARRAY(
           SELECT b.label
           FROM mcp_workflow_bundles wb
           JOIN mcp_service_bundles b ON b.id = wb.bundle_id
           WHERE wb.workflow_id = w.id
           ORDER BY b.label
         ) AS bundle_names,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
             'id', approval_history.id::text,
             'action', approval_history.action,
             'actor', approval_history.actor_username,
             'role', approval_history.actor_role,
             'comment', approval_history.comment,
             'createdAt', approval_history.created_at
           ) ORDER BY approval_history.created_at DESC)
           FROM (
             SELECT id, action, actor_username, actor_role, comment, created_at
             FROM mcp_workflow_approvals
             WHERE workflow_id = w.id
               AND tenant_key = $1
               AND workspace_key = $2
             ORDER BY created_at DESC
             LIMIT 8
           ) approval_history
         ), '[]'::jsonb) AS history
       FROM mcp_workflows w
       LEFT JOIN LATERAL (
         SELECT actor_username, created_at, comment, workflow_version
         FROM mcp_workflow_approvals
         WHERE workflow_id = w.id AND action = 'submitted'
           AND tenant_key = $1
           AND workspace_key = $2
         ORDER BY created_at DESC
         LIMIT 1
       ) submission ON true
       WHERE w.lifecycle_status = 'review'
         AND w.tenant_key = $1
         AND w.workspace_key = $2
       ${pendingScope.clause}
       ORDER BY coalesce(submission.created_at, w.updated_at) ASC
       LIMIT 75`,
      [selectedScope.tenantKey, selectedScope.workspaceKey, ...pendingScope.params],
    ),
    pool.query<ApprovalDecisionRow>(
      `SELECT
         a.id::text,
         a.workflow_id,
         w.name AS workflow_name,
         a.action,
         a.actor_username,
         a.actor_role,
         a.comment,
         a.created_at
       FROM mcp_workflow_approvals a
       JOIN mcp_workflows w ON w.id = a.workflow_id
       WHERE a.action IN ('approved', 'rejected', 'withdrawn')
         AND a.tenant_key = $1
         AND a.workspace_key = $2
         AND w.tenant_key = $1
         AND w.workspace_key = $2
       ${decisionsScope.clause}
       ORDER BY a.created_at DESC
       LIMIT 25`,
      [selectedScope.tenantKey, selectedScope.workspaceKey, ...decisionsScope.params],
    ),
    loadRuntimeGovernanceData(pool, user, selectedScope),
    selectedScope.tenantKey === 'default' && selectedScope.workspaceKey === 'default'
      ? loadCodingApprovalData(pool, user)
      : Promise.resolve({ pending: [] }),
  ]);

  const canReview = hasRole(user.role, 'agent_operator');
  const canOverrideFourEyes = hasRole(user.role, 'platform_admin');
  const workflowApprovals = pendingResult.rows.map(row => {
    const ownSubmission = row.submitted_by === user.username;
    const canApprove = canReview && (!ownSubmission || canOverrideFourEyes);
    return {
      id: `workflow-${row.id}`,
      kind: 'workflow_review' as const,
      workflowId: row.id,
      title: row.name.replaceAll('_', ' '),
      description: row.description,
      status: 'pending' as const,
      risk: row.human_oversight_required ? 'high' as const : 'medium' as const,
      submittedBy: row.submitted_by ?? 'unknown',
      submittedAt: row.submitted_at ?? row.updated_at,
      comment: row.submission_comment,
      version: row.workflow_version,
      bundles: row.bundle_names,
      tags: row.tags,
      humanOversightRequired: row.human_oversight_required,
      history: row.history,
      href: `/build/workflows/studio/${row.id}`,
      actions: {
        canApprove,
        canReject: canReview,
        blockedReason: !canReview
          ? 'Reviewer role required'
          : ownSubmission && !canOverrideFourEyes
            ? 'Four-eyes policy: another reviewer must approve'
            : null,
      },
    };
  });

  const runtimeApprovals = runtimeData.pending.map(row => {
    const ownRequest = row.requested_by_user_id === user.id;
    return {
      id: `runtime-${row.id}`,
      kind: 'runtime_tool' as const,
      runtimeApprovalId: row.id,
      workflowId: row.workflow_id,
      agentId: row.agent_id,
      title: row.tool_name,
      description: row.reason,
      subjectLabel: row.subject_label,
      sessionId: row.session_id,
      workflowExecutionId: row.workflow_execution_id,
      workflowStepId: row.workflow_step_id,
      autoResume: row.subject_type === 'workflow' && row.workflow_execution_id != null,
      toolName: row.tool_name,
      toolArgs: row.tool_args,
      status: 'pending' as const,
      risk: row.risk_level,
      riskScore: row.risk_score,
      riskFactors: row.risk_factors,
      riskModel: row.risk_model,
      submittedBy: row.requested_by_username ?? (row.requested_by_user_id ? `user #${row.requested_by_user_id}` : 'service identity'),
      submittedAt: row.requested_at,
      comment: null,
      version: null,
      bundles: row.bundle_names,
      tags: [row.subject_type, 'runtime'],
      humanOversightRequired: true,
      occurrenceCount: row.occurrence_count,
      history: [],
      href: row.workflow_id
        ? `/build/workflows/studio/${row.workflow_id}`
        : `/agents/manage?id=${row.agent_id}`,
      actions: {
        canApprove: canReview && (!ownRequest || canOverrideFourEyes),
        canReject: canReview,
        blockedReason: !canReview
          ? 'Reviewer role required'
          : ownRequest && !canOverrideFourEyes
            ? 'Four-eyes policy: another reviewer must approve'
            : null,
      },
    };
  });

  const codingApprovals = codingData.pending.map(row => ({
    id: `coding-${row.threadId}`,
    kind: 'coding_workflow' as const,
    codingThreadId: row.threadId,
    workflowId: null,
    title: `${row.ticketId} · Argus Dev approval`,
    description: row.message,
    status: 'pending' as const,
    risk: 'high' as const,
    submittedBy: 'Argus Dev',
    submittedAt: row.submittedAt,
    comment: [row.planSummary, row.reviewSummary].filter(Boolean).join('\n\n') || row.description || null,
    version: null,
    bundles: row.bundleNames,
    tags: ['argus.dev', 'coding', 'human-approval'],
    humanOversightRequired: true,
    history: [],
    href: `/solutions/argus.dev?thread=${encodeURIComponent(row.threadId)}`,
    actions: {
      canApprove: canReview,
      canReject: canReview,
      blockedReason: canReview ? null : 'Reviewer role required',
    },
  }));

  const approvals = [...runtimeApprovals, ...workflowApprovals, ...codingApprovals]
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));

  const oldestSubmittedAt = approvals[0]?.submittedAt ?? null;
  return {
    generatedAt: new Date().toISOString(),
    user: {
      username: user.username,
    },
    permissions: {
      canReview,
      canOverrideFourEyes,
      canManagePlatform: hasRole(user.role, 'platform_admin'),
    },
    stats: {
      pending: approvals.length,
      submittedByMe: approvals.filter(item => item.submittedBy === user.username).length,
      highRisk: approvals.filter(item => item.risk === 'high' || item.risk === 'critical').length,
      oldestSubmittedAt,
    },
    approvals,
    recentDecisions: [
      ...runtimeData.decisions.map(row => ({
        id: `runtime-${row.id}`,
        title: `${row.tool_name} · ${row.subject_label}`,
        action: row.status,
        actor: row.decided_by_username ?? 'Argus runtime',
        actorRole: null,
        comment: row.decision_comment,
        createdAt: row.decided_at ?? new Date().toISOString(),
        href: row.subject_href,
        kind: 'runtime_tool' as const,
      })),
      ...decisionsResult.rows.map(row => ({
      id: row.id,
      title: row.workflow_name.replaceAll('_', ' '),
      action: row.action,
      actor: row.actor_username,
      actorRole: row.actor_role,
      comment: row.comment,
      createdAt: row.created_at,
      href: `/build/workflows/studio/${row.workflow_id}`,
      kind: 'workflow_review' as const,
      })),
    ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 25),
  };
}

async function loadRuntimeGovernanceData(
  pool: pg.Pool,
  user: SessionUser,
  selectedScope: AuthorizedWorkspaceScope,
): Promise<{ pending: RuntimeApprovalInboxRow[]; decisions: RuntimeApprovalDecisionRow[] }> {
  const params: unknown[] = [selectedScope.tenantKey, selectedScope.workspaceKey];
  const visibility = user.allowed_bundles === null
    ? ''
    : `AND (
        (
          r.subject_type = 'workflow'
          AND (
            NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = r.workflow_id)
            OR EXISTS (
              SELECT 1 FROM mcp_workflow_bundles wb
              WHERE wb.workflow_id = r.workflow_id AND wb.bundle_id = ANY($3::int[])
            )
          )
        )
        OR (
          r.subject_type = 'agent'
          AND EXISTS (
            SELECT 1 FROM mcp_agents scoped_agent
            WHERE scoped_agent.id = r.agent_id
              AND (
                scoped_agent.bundle_ids IS NULL
                OR cardinality(scoped_agent.bundle_ids) = 0
                OR scoped_agent.bundle_ids && $3::int[]
              )
          )
        )
      )`;
  if (user.allowed_bundles !== null) params.push(user.allowed_bundles);

  try {
    const [pending, decisions] = await Promise.all([
      pool.query<RuntimeApprovalInboxRow>(
        `SELECT
           r.*,
           coalesce(w.name, a.label, 'Unknown subject') AS subject_label,
           requester.username AS requested_by_username,
           CASE
             WHEN r.subject_type = 'workflow' THEN ARRAY(
               SELECT b.label
               FROM mcp_workflow_bundles wb
               JOIN mcp_service_bundles b ON b.id = wb.bundle_id
               WHERE wb.workflow_id = r.workflow_id
               ORDER BY b.label
             )
             ELSE ARRAY(
               SELECT b.label
               FROM mcp_service_bundles b
               WHERE b.id = ANY(coalesce(a.bundle_ids, ARRAY[]::int[]))
               ORDER BY b.label
             )
           END AS bundle_names
         FROM mcp_runtime_approvals r
         LEFT JOIN mcp_workflows w ON w.id = r.workflow_id
         LEFT JOIN mcp_agents a ON a.id = r.agent_id
         LEFT JOIN mcp_users requester ON requester.id = r.requested_by_user_id
         WHERE r.status = 'pending'
           AND r.tenant_key = $1
           AND r.workspace_key = $2
         ${visibility}
         ORDER BY r.requested_at ASC
         LIMIT 100`,
        params,
      ),
      pool.query<RuntimeApprovalDecisionRow>(
        `SELECT
           r.id::text,
           coalesce(w.name, a.label, 'Unknown subject') AS subject_label,
           r.tool_name,
           r.status,
           r.decided_by_username,
           r.decision_comment,
           coalesce(r.consumed_at, r.decided_at) AS decided_at,
           CASE
             WHEN r.workflow_id IS NOT NULL THEN '/build/workflows/studio/' || r.workflow_id::text
             ELSE '/agents/manage?id=' || r.agent_id::text
           END AS subject_href
         FROM mcp_runtime_approvals r
         LEFT JOIN mcp_workflows w ON w.id = r.workflow_id
         LEFT JOIN mcp_agents a ON a.id = r.agent_id
         WHERE r.status IN ('approved', 'rejected', 'consumed')
           AND r.tenant_key = $1
           AND r.workspace_key = $2
         ${visibility}
         ORDER BY coalesce(r.consumed_at, r.decided_at) DESC
         LIMIT 25`,
        params,
      ),
    ]);
    return { pending: pending.rows, decisions: decisions.rows };
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return { pending: [], decisions: [] };
    throw error;
  }
}

async function canSeeRuntimeApproval(
  pool: pg.Pool,
  approval: RuntimeApprovalRecord,
  user: SessionUser,
  selectedScope: AuthorizedWorkspaceScope,
): Promise<boolean> {
  if ((approval.tenant_key ?? 'default') !== selectedScope.tenantKey
    || (approval.workspace_key ?? 'default') !== selectedScope.workspaceKey) return false;
  if (user.allowed_bundles === null) return true;
  if (approval.subject_type === 'workflow' && approval.workflow_id) {
    const { rows } = await pool.query<{ visible: boolean }>(
      `SELECT (
         NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = $1)
         OR EXISTS (
           SELECT 1 FROM mcp_workflow_bundles wb
           WHERE wb.workflow_id = $1 AND wb.bundle_id = ANY($2::int[])
         )
       ) AS visible`,
      [approval.workflow_id, user.allowed_bundles],
    );
    return rows[0]?.visible === true;
  }
  if (approval.subject_type === 'agent' && approval.agent_id) {
    const { rows } = await pool.query<{ visible: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM mcp_agents a
         WHERE a.id = $1
           AND (
             a.bundle_ids IS NULL
             OR cardinality(a.bundle_ids) = 0
             OR a.bundle_ids && $2::int[]
           )
       ) AS visible`,
      [approval.agent_id, user.allowed_bundles],
    );
    return rows[0]?.visible === true;
  }
  return false;
}

async function loadAgentCount(pool: pg.Pool): Promise<number> {
  try {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM mcp_agents',
    );
    return numberValue(rows[0]?.count);
  } catch {
    return 0;
  }
}

function mapWorkflowRun(row: WorkflowRunRow) {
  const status = row.status === 'waiting_for_approval' ? 'waiting' as const : row.status;
  return {
    id: row.id,
    numericId: numberValue(row.id),
    workflowId: row.workflow_id,
    kind: 'workflow' as const,
    title: row.workflow_name.replaceAll('_', ' '),
    subtitle: row.triggered_by ? `Triggered by ${row.triggered_by}` : (row.description || 'Workflow execution'),
    status,
    risk: row.status === 'failed'
      ? 'high' as const
      : row.status === 'waiting_for_approval'
        ? 'medium' as const
        : 'low' as const,
    startedAt: row.started_at,
    updatedAt: row.completed_at ?? row.started_at,
    durationMs: row.duration_ms,
    error: row.error_message,
    href: `/runs/workflow/${row.id}`,
  };
}

function mapAgentRun(session: ActiveSession) {
  const status = session.status === 'error'
    ? 'failed' as const
    : session.status === 'done'
      ? 'completed' as const
      : 'running' as const;
  return {
    id: session.sessionId,
    numericId: session.agentId,
    kind: 'agent' as const,
    title: session.agentName,
    subtitle: session.lastMessage || `${session.agentMode} agent · ${session.toolCallCount} tool calls`,
    status,
    risk: status === 'failed' ? 'high' as const : 'low' as const,
    startedAt: new Date(session.startedAt).toISOString(),
    updatedAt: new Date(session.lastActivityAt).toISOString(),
    durationMs: Math.max(0, session.lastActivityAt - session.startedAt),
    error: session.errorMessage ?? null,
    href: `/runs/agent/${encodeURIComponent(session.sessionId)}`,
  };
}

export function visualWorkflowIdFromTraceMetadata(metadata: Record<string, unknown>): number | null {
  const workflowId = typeof metadata['workflow_id'] === 'string' ? metadata['workflow_id'] : '';
  const workflowType = typeof metadata['workflow_type'] === 'string' ? metadata['workflow_type'] : '';
  const rawId = /^visual-([1-9][0-9]*)(?:-|$)/.exec(workflowId)?.[1]
    ?? /^visual_workflow_([1-9][0-9]*)$/.exec(workflowType)?.[1];
  if (!rawId) return null;
  const parsed = Number(rawId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function mapTelemetryRun(trace: TelemetryTraceRow) {
  const metadata = trace.metadata ?? {};
  const visualWorkflowId = visualWorkflowIdFromTraceMetadata(metadata);
  const agentMode = typeof metadata['agent_mode'] === 'string' ? metadata['agent_mode'] : null;
  const kind = trace.kind === 'workflow' ? 'workflow' as const : 'agent' as const;
  const title = trace.agent_name
    || (typeof metadata['agent_name'] === 'string' ? metadata['agent_name'] : null)
    || trace.name.replaceAll('.', ' ');
  const target = [trace.provider, trace.model].filter(Boolean).join(' · ');
  const workflowType = typeof metadata['workflow_type'] === 'string' ? metadata['workflow_type'] : null;
  const runtime = typeof metadata['runtime'] === 'string' ? metadata['runtime'] : null;
  const a2aTaskId = typeof metadata['a2a_task_id'] === 'string' ? metadata['a2a_task_id'] : null;
  const ticketId = typeof metadata['ticket_id'] === 'string' ? metadata['ticket_id'] : null;
  const runTitle = typeof metadata['run_title'] === 'string' ? metadata['run_title'] : ticketId;
  const workflowLabel = typeof metadata['workflow_label'] === 'string'
    ? metadata['workflow_label']
    : 'Ticket to pull request';
  const isArgusDev = kind === 'workflow' && runtime === 'argus-langgraph' && a2aTaskId != null;
  return {
    id: trace.id,
    numericId: trace.agent_id ?? undefined,
    ...(visualWorkflowId == null ? {} : {
      workflowId: visualWorkflowId,
      workflowHref: `/build/workflows/studio/${visualWorkflowId}?replay=${encodeURIComponent(trace.id)}`,
    }),
    kind,
    title: isArgusDev ? `Argus Dev · ${runTitle ?? 'Development run'}` : title,
    subtitle: kind === 'workflow'
      ? isArgusDev
        ? `${workflowLabel} · governed A2A run`
        : [workflowType, runtime].filter(Boolean).join(' · ') || 'Workflow execution'
      : target || (agentMode ? `${agentMode} agent` : 'Agent execution'),
    status: trace.status,
    risk: trace.status === 'failed'
      ? 'high' as const
      : trace.status === 'waiting'
        ? 'medium' as const
        : 'low' as const,
    startedAt: isoValue(trace.started_at),
    updatedAt: isoValue(trace.ended_at ?? trace.started_at),
    durationMs: trace.duration_ms == null ? null : numberValue(trace.duration_ms),
    error: trace.error_message,
    href: isArgusDev
      ? `/solutions/argus.dev?task=${encodeURIComponent(a2aTaskId)}`
      : `/runs/${kind}/${encodeURIComponent(trace.id)}`,
  };
}

function mapDistributedTraceRun(trace: TelemetryTraceFamilyRow) {
  const metadata = trace.metadata ?? {};
  const taskType = typeof metadata['task_type'] === 'string' ? metadata['task_type'] : null;
  const agentRole = typeof metadata['agent_role'] === 'string' ? metadata['agent_role'] : null;
  const workflowStepId = typeof metadata['workflow_step_id'] === 'string' ? metadata['workflow_step_id'] : null;
  const title = trace.kind === 'workflow'
    ? trace.workflow_name
      || (typeof metadata['workflow_name'] === 'string' ? metadata['workflow_name'] : null)
      || trace.name.replaceAll('.', ' ')
    : trace.agent_name
      || (typeof metadata['agent_name'] === 'string' ? metadata['agent_name'] : null)
      || trace.name.replaceAll('.', ' ');
  const subtitle = trace.kind === 'workflow'
    ? typeof metadata['triggered_by'] === 'string' ? metadata['triggered_by'] : 'Workflow execution'
    : [trace.provider, trace.model].filter(Boolean).join(' · ') || 'Agent execution';
  return {
    id: trace.id,
    agentId: trace.agent_id,
    agentRole,
    workflowStepId,
    taskType,
    parentTraceId: trace.parent_trace_id,
    parentSpanId: trace.parent_span_id,
    kind: trace.kind === 'workflow' ? 'workflow' as const : 'agent' as const,
    title,
    subtitle,
    status: trace.status,
    startedAt: isoValue(trace.started_at),
    endedAt: trace.ended_at ? isoValue(trace.ended_at) : null,
    durationMs: trace.duration_ms == null ? null : numberValue(trace.duration_ms),
    inputPreview: safePreviewValue(trace.input_preview),
    outputPreview: safePreviewValue(trace.output_preview, RETAINED_OUTPUT_MAX_LENGTH),
    error: trace.error_message,
    href: trace.kind === 'workflow' && trace.workflow_execution_id != null
      ? `/runs/workflow/${trace.workflow_execution_id}`
      : trace.kind === 'agent'
        ? `/runs/agent/${encodeURIComponent(trace.id)}`
        : undefined,
  };
}

function mapDistributedTraceSpan(span: TelemetrySpanRow) {
  return {
    id: span.id,
    traceId: span.trace_id,
    parentSpanId: span.parent_span_id,
    name: span.tool_name || span.name,
    kind: span.kind,
    status: span.status,
    startedAt: isoValue(span.started_at),
    endedAt: span.ended_at ? isoValue(span.ended_at) : null,
    durationMs: span.duration_ms == null ? null : numberValue(span.duration_ms),
    toolName: span.tool_name,
    model: span.model,
    provider: span.provider,
    inputPreview: safePreviewValue(span.input_preview),
    outputPreview: safePreviewValue(span.output_preview, RETAINED_OUTPUT_MAX_LENGTH),
    metadataPreview: safePreviewValue(span.metadata),
    error: span.error_message,
  };
}

async function loadDistributedTraceFamily(
  pool: pg.Pool,
  anchor: TelemetryTraceRow | null,
  access: TelemetryReadAccess,
) {
  if (!anchor) return null;
  const family = await listTelemetryTraceFamily(pool, anchor.root_trace_id, access);
  const visibleTraces = family.traces.filter(trace => trace.kind === 'agent' || trace.kind === 'workflow');
  const visibleTraceIds = new Set(visibleTraces.map(trace => trace.id));
  const visibleSpans = family.spans.filter(span => visibleTraceIds.has(span.trace_id));
  const [baselineAnchor, historicalWindows] = await Promise.all([
    findPreviousComparableTelemetryTrace(pool, anchor.root_trace_id, access),
    getTelemetryTraceHistoricalBaseline(pool, anchor.root_trace_id, access),
  ]);
  const baselineFamily = baselineAnchor
    ? await listTelemetryTraceFamily(pool, baselineAnchor.root_trace_id, access)
    : null;
  const baselineTraces = baselineFamily?.traces.filter(trace => trace.kind === 'agent' || trace.kind === 'workflow') ?? [];
  const baselineTraceIds = new Set(baselineTraces.map(trace => trace.id));
  const comparison = baselineFamily
    ? compareTelemetryTraceFamilies(
      { traces: visibleTraces, spans: visibleSpans },
      { traces: baselineTraces, spans: baselineFamily.spans.filter(span => baselineTraceIds.has(span.trace_id)) },
    )
    : null;
  const currentSummary = summarizeTelemetryTraceFamily({ traces: visibleTraces, spans: visibleSpans });
  const historicalBaseline = assessHistoricalTraceBaseline(
    { durationMs: currentSummary.durationMs, costUsd: currentSummary.costUsd },
    historicalWindows,
  );
  return {
    rootTraceId: anchor.root_trace_id,
    currentTraceId: anchor.id,
    truncated: family.truncated,
    spansTruncated: family.spansTruncated,
    runs: visibleTraces.map(mapDistributedTraceRun),
    spans: visibleSpans.map(mapDistributedTraceSpan),
    codeIntelligence: buildRunCodeIntelligenceEvidence(visibleSpans, visibleTraces),
    analysis: analyzeTelemetryTraceFamily(visibleTraces, visibleSpans),
    historicalBaseline,
    comparison: comparison ? {
      ...comparison,
      baseline: {
        ...comparison.baseline,
        href: baselineAnchor?.kind === 'workflow' && baselineAnchor.workflow_execution_id != null
          ? `/runs/workflow/${baselineAnchor.workflow_execution_id}`
          : baselineAnchor?.kind === 'agent'
            ? `/runs/agent/${encodeURIComponent(baselineAnchor.id)}`
            : undefined,
      },
    } : null,
  };
}

function telemetrySpanEventKind(span: TelemetrySpanRow): RunTimelineEventKind {
  if (span.status === 'waiting') return 'step_waiting';
  const suffix = span.status === 'running'
    ? 'started'
    : span.status === 'completed'
      ? 'completed'
      : 'failed';
  if (span.kind === 'tool') return `tool_${suffix}` as RunTimelineEventKind;
  if (span.kind === 'llm') return `llm_${suffix}` as RunTimelineEventKind;
  if (span.kind === 'rag') return `rag_${suffix}` as RunTimelineEventKind;
  if (span.kind === 'approval') {
    if (span.status === 'running') return 'approval_requested';
    return span.status === 'completed' ? 'approval_approved' : 'approval_rejected';
  }
  return span.status === 'running'
    ? 'step_waiting'
    : span.status === 'completed'
      ? 'step_completed'
      : 'step_failed';
}

function buildTelemetryTimeline(trace: TelemetryTraceRow, spans: TelemetrySpanRow[]): RunTimelineEvent[] {
  const metadata = trace.metadata ?? {};
  const agentMode = typeof metadata['agent_mode'] === 'string' ? metadata['agent_mode'] : 'agent';
  const events: RunTimelineEvent[] = [{
    id: `trace-${trace.id}-started`,
    kind: 'run_started',
    title: 'Agent run started',
    detail: `${agentMode} mode${trace.model ? ` · ${trace.model}` : ''}`,
    timestamp: isoValue(trace.started_at),
    inputPreview: safePreviewValue(trace.input_preview),
  }];
  for (const span of spans) {
    const kind = telemetrySpanEventKind(span);
    const label = span.tool_name || span.name;
    events.push({
      id: span.id,
      kind,
      title: `${label} ${kind.endsWith('started') ? 'running' : kind.endsWith('completed') ? 'completed' : 'failed'}`,
      detail: [span.kind.toUpperCase(), span.provider, span.model].filter(Boolean).join(' · '),
      timestamp: isoValue(span.ended_at ?? span.started_at),
      durationMs: span.duration_ms == null ? null : numberValue(span.duration_ms),
      spanId: span.id,
      parentSpanId: span.parent_span_id,
      spanKind: span.kind,
      toolName: span.tool_name,
      inputPreview: safePreviewValue(span.input_preview),
      resultPreview: safePreviewValue(span.error_message ?? span.output_preview),
    });
  }
  if (trace.status !== 'running' && trace.status !== 'waiting') {
    const terminalKind = trace.status === 'completed'
      ? 'run_completed'
      : trace.status === 'cancelled'
        ? 'run_cancelled'
        : 'run_failed';
    events.push({
      id: `trace-${trace.id}-terminal`,
      kind: terminalKind,
      title: trace.status === 'completed'
        ? 'Agent run completed'
        : trace.status === 'cancelled'
          ? 'Agent run cancelled'
          : 'Agent run failed',
      detail: trace.error_message || `${spans.length} child spans`,
      timestamp: isoValue(trace.ended_at ?? trace.started_at),
      durationMs: trace.duration_ms == null ? null : numberValue(trace.duration_ms),
      resultPreview: safePreviewValue(trace.error_message ?? trace.output_preview),
    });
  }
  return events.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export function telemetryAccess(user: SessionUser, scope: AuthorizedWorkspaceScope): TelemetryReadAccess {
  return {
    userId: user.id,
    observeAll: hasRole(user.role, 'agent_operator'),
    allowedBundleIds: user.allowed_bundles,
    tenantKey: scope.tenantKey,
    workspaceKey: scope.workspaceKey,
  };
}

export function resolveConsoleWorkspaceScope(
  req: Request,
  res: Response,
  user: SessionUser,
): AuthorizedWorkspaceScope | null {
  try {
    return resolveAuthorizedWorkspaceScope(req, user);
  } catch (error) {
    if (error instanceof WorkspaceScopeAccessError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return null;
    }
    throw error;
  }
}

function activeSessionMatchesScope(session: ActiveSession, scope: AuthorizedWorkspaceScope): boolean {
  return (session.tenantKey ?? 'default') === scope.tenantKey
    && (session.workspaceKey ?? 'default') === scope.workspaceKey;
}

function mapTraceFeedback(row: TraceFeedbackRow) {
  return {
    id: Number(row.id),
    traceId: row.trace_id,
    spanId: row.span_id,
    source: row.source,
    label: row.label,
    score: row.score == null ? null : Number(row.score),
    sentiment: row.sentiment,
    comment: row.comment,
    tags: row.tags ?? [],
    metadata: redactJson(row.metadata ?? {}).value,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    supersedesId: row.supersedes_id == null ? null : Number(row.supersedes_id),
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
  };
}

function publicWidgetRuntimeState(
  widget: PublicWidget,
  agent: PublicWidgetAgent | null,
  masterEnabled: boolean,
): 'active' | 'master_disabled' | 'widget_disabled' | 'agent_unavailable' | 'origins_missing' {
  if (!masterEnabled) return 'master_disabled';
  if (!widget.enabled) return 'widget_disabled';
  if (!agent || !agent.enabled || agent.visibility !== 'public') return 'agent_unavailable';
  if (widget.allowed_origins.length === 0) return 'origins_missing';
  return 'active';
}

function mapPublicWidget(
  widget: PublicWidget,
  agents: PublicWidgetAgent[],
  masterEnabled: boolean,
) {
  const agent = agents.find(candidate => candidate.id === widget.agent_id) ?? null;
  return {
    id: Number(widget.id),
    agentId: Number(widget.agent_id),
    agent: agent ? {
      id: Number(agent.id),
      name: agent.name,
      label: agent.label,
      enabled: agent.enabled,
      visibility: agent.visibility,
    } : null,
    slug: widget.slug,
    allowedOrigins: widget.allowed_origins ?? [],
    enabled: widget.enabled,
    runtimeState: publicWidgetRuntimeState(widget, agent, masterEnabled),
    greeting: widget.greeting,
    accent: widget.accent,
    title: widget.title,
    inputPlaceholder: widget.input_placeholder,
    launcherIconUrl: widget.launcher_icon_url,
    launcherIconAlt: widget.launcher_icon_alt,
    launcherPosition: widget.launcher_position,
    rateLimitPerIp: Number(widget.rate_limit_per_ip),
    dailyTokenCap: Number(widget.daily_token_cap),
    createdBy: widget.created_by == null ? null : String(widget.created_by),
    createdAt: isoValue(widget.created_at),
    publicPath: `/public/widget/${encodeURIComponent(widget.slug)}`,
    scriptPath: '/assets/argus-widget.js',
  };
}

function mapRuntimePolicy(filter: ToolFilterRow) {
  return {
    id: Number(filter.id),
    name: filter.name,
    description: filter.description,
    webhookUrl: filter.webhook_url,
    timeoutMs: Number(filter.timeout_ms),
    toolPatterns: filter.tool_patterns ?? [],
    enabled: filter.enabled,
    onFailure: filter.on_timeout,
    hasHmacSecret: Boolean(filter.hmac_secret),
    createdAt: isoValue(filter.created_at),
    updatedAt: isoValue(filter.updated_at),
  };
}

const FEEDBACK_SENTIMENTS = new Set<FeedbackSentiment>(['positive', 'neutral', 'negative', 'mixed']);
const FEEDBACK_LABEL_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const FEEDBACK_TAG_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

const NATIVE_ALERT_METRICS = new Set<NativeAlertMetric>(['error_rate', 'success_rate', 'p95_latency_ms', 'total_cost_usd', 'failure_count', 'latency_regression_percent', 'cost_regression_percent']);
const NATIVE_ALERT_OPERATORS = new Set<NativeAlertOperator>(['gt', 'gte', 'lt', 'lte']);
const NATIVE_ALERT_SEVERITIES = new Set<NativeAlertSeverity>(['info', 'warning', 'critical']);
const NATIVE_ALERT_SCOPES = new Set<NativeAlertScopeKind>(['all', 'agent', 'workflow', 'model', 'tool']);
const NATIVE_SLO_METRICS = new Set<NativeSloMetric>(['success_rate', 'p95_latency_ms']);

function parseNativeAlertRuleInput(value: unknown): NativeAlertRuleInput {
  const input = (value ?? {}) as Record<string, unknown>;
  const name = typeof input['name'] === 'string' ? input['name'].trim() : '';
  const metric = input['metric'] as NativeAlertMetric;
  const operator = input['operator'] as NativeAlertOperator;
  const severity = input['severity'] as NativeAlertSeverity;
  const scopeKind = input['scopeKind'] as NativeAlertScopeKind;
  const threshold = Number(input['threshold']);
  const windowMinutes = Number(input['windowMinutes']);
  const minSamples = Number(input['minSamples']);
  const cooldownMinutes = Number(input['cooldownMinutes']);
  if (!name || name.length > 160) throw new Error('Name muss zwischen 1 und 160 Zeichen lang sein');
  if (!NATIVE_ALERT_METRICS.has(metric)) throw new Error('Ungültige Alert-Metrik');
  if (!NATIVE_ALERT_OPERATORS.has(operator)) throw new Error('Ungültiger Vergleichsoperator');
  if (!NATIVE_ALERT_SEVERITIES.has(severity)) throw new Error('Ungültige Alert-Schwere');
  if (!NATIVE_ALERT_SCOPES.has(scopeKind)) throw new Error('Ungültiger Alert-Scope');
  if (!Number.isFinite(threshold)) throw new Error('Threshold muss eine Zahl sein');
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 10080) throw new Error('Zeitfenster muss zwischen 1 und 10080 Minuten liegen');
  if (!Number.isInteger(minSamples) || minSamples < 1 || minSamples > 1_000_000) throw new Error('Minimum Samples ist ungültig');
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 10080) throw new Error('Cooldown muss zwischen 1 und 10080 Minuten liegen');
  const rawScopeValue = typeof input['scopeValue'] === 'string' ? input['scopeValue'].trim() : '';
  if ((scopeKind === 'agent' || scopeKind === 'workflow') && rawScopeValue && !/^\d+$/.test(rawScopeValue)) {
    throw new Error('Agent- und Workflow-Scope erwarten eine numerische ID');
  }
  const aiopsAutoInvestigate = input['aiopsAutoInvestigate'] === true;
  const rawBundleIds = input['aiopsBundleIds'];
  const aiopsBundleIds = Array.isArray(rawBundleIds)
    ? [...new Set(rawBundleIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
    : [];
  const rawResourceScope = input['aiopsResourceScope'];
  let aiopsResourceScope: NativeAlertRuleInput['aiopsResourceScope'] = null;
  if (rawResourceScope != null) {
    if (typeof rawResourceScope !== 'object' || Array.isArray(rawResourceScope)) throw new Error('UngÃ¼ltiger AIOps-Ressourcen-Scope');
    const resourceScope = rawResourceScope as Record<string, unknown>;
    if (Object.keys(resourceScope).some(key => !['kind', 'backendId', 'targetId', 'namespace'].includes(key))
      || resourceScope['kind'] !== 'kubernetes'
      || !Number.isSafeInteger(resourceScope['backendId']) || Number(resourceScope['backendId']) <= 0
      || typeof resourceScope['targetId'] !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(resourceScope['targetId'])
      || typeof resourceScope['namespace'] !== 'string' || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(resourceScope['namespace'])) {
      throw new Error('UngÃ¼ltiger AIOps-Ressourcen-Scope');
    }
    aiopsResourceScope = {
      kind: 'kubernetes',
      backendId: Number(resourceScope['backendId']),
      targetId: resourceScope['targetId'],
      namespace: resourceScope['namespace'],
    };
  }
  const aiopsService = typeof input['aiopsService'] === 'string' ? input['aiopsService'].trim().slice(0, 200) : '';
  const aiopsEnvironment = typeof input['aiopsEnvironment'] === 'string' ? input['aiopsEnvironment'].trim().slice(0, 120) : '';
  if (aiopsAutoInvestigate && (aiopsBundleIds.length === 0 || aiopsBundleIds.length > 64)) {
    throw new Error('Automatische AIOps-Untersuchungen benÃ¶tigen mindestens ein MCP-Bundle');
  }
  if (aiopsAutoInvestigate && (!aiopsResourceScope || !aiopsService || !aiopsEnvironment)) {
    throw new Error('Automatische AIOps-Untersuchungen benÃ¶tigen Service, Umgebung und ein zertifiziertes Ziel');
  }
  return {
    name,
    description: typeof input['description'] === 'string' ? input['description'].trim().slice(0, 2000) : '',
    metric,
    operator,
    threshold,
    windowMinutes,
    minSamples,
    severity,
    scopeKind,
    scopeValue: scopeKind === 'all' ? null : rawScopeValue || null,
    cooldownMinutes,
    notify: input['notify'] !== false,
    enabled: input['enabled'] !== false,
    aiopsAutoInvestigate,
    aiopsBundleIds: aiopsAutoInvestigate ? aiopsBundleIds : [],
    aiopsResourceScope: aiopsAutoInvestigate ? aiopsResourceScope : null,
    aiopsService: aiopsAutoInvestigate ? aiopsService : null,
    aiopsEnvironment: aiopsAutoInvestigate ? aiopsEnvironment : null,
  };
}

function mapPublicWidgetDemo(
  widgets: PublicWidget[],
  agents: PublicWidgetAgent[],
  masterEnabled: boolean,
) {
  const agent = agents.find(candidate => candidate.name === PUBLIC_WIDGET_DEMO_AGENT_NAME) ?? null;
  const widget = widgets.find(candidate => candidate.slug === PUBLIC_WIDGET_DEMO_SLUG) ?? null;
  const agentReady = Boolean(agent?.enabled && agent.visibility === 'public');
  const widgetReady = Boolean(widget?.enabled && widget.allowed_origins.length > 0);
  return {
    configured: Boolean(agent && widget),
    reachable: Boolean(masterEnabled && agentReady && widgetReady),
    agentId: agent ? Number(agent.id) : null,
    agentReady,
    widgetId: widget ? Number(widget.id) : null,
    widgetEnabled: Boolean(widget?.enabled),
    origin: widget?.allowed_origins[0] ?? null,
    publicPath: widget ? `/public/widget/${encodeURIComponent(widget.slug)}` : null,
  };
}

async function validateNativeAlertAiopsPolicy(pool: pg.Pool, input: NativeAlertRuleInput): Promise<void> {
  if (!input.aiopsAutoInvestigate) return;
  const bundleIds = input.aiopsBundleIds ?? [];
  const scope = input.aiopsResourceScope;
  if (!scope) throw new Error('Automatische AIOps-Untersuchungen benötigen ein Kubernetes-Ziel');
  const capabilities = await checkBundleCapabilities(pool, bundleIds, ['metrics', 'runtime']);
  if (!capabilities.ok) {
    throw new Error(`Das gewählte MCP-Bundle erfüllt die AIOps-Anforderungen nicht: ${capabilities.missing.join(', ')}`);
  }
  const target = await resolveExecutionResourceScope(pool, bundleIds, scope);
  if (target.environment !== input.aiopsEnvironment) {
    throw new Error(`Die AIOps-Umgebung muss dem Fabric-Ziel entsprechen: ${target.environment}`);
  }
  const certification = (await listLatestKubernetesCertifications(pool)).find(item =>
    item.backendId === scope.backendId && item.targetId === scope.targetId);
  if (certification?.status !== 'passed' || certification.freshness === 'stale') {
    throw new Error('Das gewählte Kubernetes-Ziel besitzt keine gültige, aktuelle Certification');
  }
}

function parseNativeSloInput(value: unknown): NativeSloInput {
  const input = (value ?? {}) as Record<string, unknown>;
  const name = typeof input['name'] === 'string' ? input['name'].trim() : '';
  const metric = input['metric'] as NativeSloMetric;
  const scopeKind = input['scopeKind'] as NativeAlertScopeKind;
  const target = Number(input['target']);
  const windowMinutes = Number(input['windowMinutes']);
  const minSamples = Number(input['minSamples']);
  if (!name || name.length > 160) throw new Error('Name muss zwischen 1 und 160 Zeichen lang sein');
  if (!NATIVE_SLO_METRICS.has(metric)) throw new Error('Ungültige SLO-Metrik');
  if (!NATIVE_ALERT_SCOPES.has(scopeKind)) throw new Error('Ungültiger SLO-Scope');
  if (!Number.isFinite(target) || target <= 0 || metric === 'success_rate' && target > 100) throw new Error('SLO-Zielwert ist ungültig');
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 129600) throw new Error('SLO-Zeitfenster muss zwischen 1 und 129600 Minuten liegen');
  if (!Number.isInteger(minSamples) || minSamples < 1 || minSamples > 1_000_000) throw new Error('Minimum Samples ist ungültig');
  const rawScopeValue = typeof input['scopeValue'] === 'string' ? input['scopeValue'].trim() : '';
  if (scopeKind !== 'all' && !rawScopeValue) throw new Error('Für komponentenspezifische SLOs ist ein Scope-Wert erforderlich');
  if ((scopeKind === 'agent' || scopeKind === 'workflow') && rawScopeValue && !/^\d+$/.test(rawScopeValue)) {
    throw new Error('Agent- und Workflow-Scope erwarten eine numerische ID');
  }
  return {
    name,
    description: typeof input['description'] === 'string' ? input['description'].trim().slice(0, 2000) : '',
    metric,
    target,
    windowMinutes,
    minSamples,
    scopeKind,
    scopeValue: scopeKind === 'all' ? null : rawScopeValue,
    enabled: input['enabled'] !== false,
  };
}

function visibleStatus(status: PlatformStatus, user: SessionUser): PlatformStatus {
  return {
    ...status,
    dynamicTools: status.dynamicTools.filter(tool => canSeeBundle(tool.bundle_ids, user)),
    remoteTools: status.remoteTools.filter(tool => canSeeBundle(tool.bundle_ids, user)),
    customBackends: status.customBackends.filter(backend => canSeeBundle(backend.bundle_ids, user)),
    backends: status.backends.filter(backend => canSeeBundle(backend.bundleIds, user)),
    bundles: status.bundles.filter(bundle =>
      user.allowed_bundles == null || user.allowed_bundles.includes(bundle.id),
    ),
  };
}

function healthFromStatus(status: PlatformStatus) {
  const enabled = status.backends.filter(backend => backend.enabled);
  const healthy = enabled.filter(backend => backend.reachable === true).length;
  const degraded = enabled.filter(backend => backend.reachable === false).length;
  const issues = enabled
    .filter(backend => backend.reachable !== true)
    .map(backend => ({
      id: String(backend.customId ?? backend.name),
      name: backend.name,
      state: backend.reachable === false ? 'degraded' as const : 'offline' as const,
      error: backend.error || (backend.reachable === false ? 'The latest connection check failed.' : 'No successful health check has been recorded.'),
      href: `/mcp-fabric?view=backends&server=${encodeURIComponent(backend.name)}`,
    }));
  const state = enabled.length === 0
    ? 'not_configured'
    : degraded > 0
      ? 'degraded'
      : healthy === enabled.length
        ? 'healthy'
        : 'offline';
  return { state, healthy, total: enabled.length, degraded, issues };
}

function safeEndpoint(config: Record<string, string>): string {
  const raw = config.url
    ? `${config.url.replace(/\/$/, '')}${config.endpoint ?? ''}`
    : config.connectionUrl ?? '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return raw.includes('****') ? 'Protected connection' : '';
  }
}

function serverState(backend: PlatformStatus['backends'][number]) {
  if (!backend.enabled) return 'not_configured' as const;
  if (backend.reachable === true) return 'healthy' as const;
  if (backend.reachable === false) return 'degraded' as const;
  return 'offline' as const;
}

interface AccessPrincipalRow {
  id: string;
  label: string;
  secondary: string;
  kind: 'user' | 'api_key' | 'agent' | 'workflow' | 'group' | 'policy';
  source: 'direct' | 'unrestricted' | 'composite' | 'group';
  enabled: boolean;
}

type ManageableAccessKind = 'user' | 'api_key' | 'agent' | 'workflow';
type AccessCandidateMode = 'none' | 'direct' | 'unrestricted' | 'inherited';

interface AccessCandidateRow {
  id: string;
  label: string;
  secondary: string;
  kind: AccessPrincipalRow['kind'];
  access: AccessCandidateMode;
  enabled: boolean;
  editable: boolean;
  reason: string;
}

interface FabricAccessMutationInput {
  kind?: string;
  id?: number | string;
  granted?: boolean;
}

interface FabricToolAssignmentInput {
  bundleId?: number | string;
  tools?: Array<{
    backendId?: number | string | null;
    name?: string;
  }>;
}

interface FabricToolTransferInput {
  action?: 'remove' | 'move';
  targetBundleId?: number | string | null;
  tools?: Array<{
    backendId?: number | string | null;
    name?: string;
  }>;
}

interface FabricCompositeMutationInput {
  name?: string;
  description?: string;
  bundleMode?: 'all' | 'selected';
  includedBundleIds?: number[];
  toolAllowPatterns?: string[];
  toolDenyPatterns?: string[];
  systemPrompt?: string | null;
  agentRole?: string | null;
  enabled?: boolean;
}

interface FabricGroupPolicyMutationInput {
  groupName?: string;
  compositeIds?: number[];
  agentIds?: number[];
  rules?: Array<{
    toolPattern?: string;
    effect?: 'allow' | 'deny';
    reason?: string | null;
  }>;
}

interface FabricUserPolicyMutationInput {
  userId?: number | string;
  compositeIds?: number[];
  agentIds?: number[];
  rules?: Array<{
    toolPattern?: string;
    effect?: 'allow' | 'deny';
    reason?: string | null;
    expiresAt?: string | null;
  }>;
}

interface FabricTechnicalPolicyMutationInput {
  kind?: 'agent' | 'api_key';
  id?: number | string;
  compositeId?: number | string | null;
  bundleMode?: 'all' | 'selected';
  allowedBundleIds?: number[];
  toolMode?: 'all' | 'selected';
  allowedTools?: string[];
  deniedTools?: string[];
}

type PolicySimulatorPrincipalKind = 'user' | 'agent' | 'api_key' | 'group' | 'composite';

interface PolicySimulationInput {
  principalKind?: string;
  principalId?: number | string;
  toolName?: string;
}

function normalizePolicyPatterns(value: unknown, label: string): string[] {
  if (value != null && !Array.isArray(value)) throw new Error(`${label} müssen als Liste übergeben werden`);
  const rawPatterns = (value as unknown[] | undefined) ?? [];
  if (rawPatterns.some(pattern => typeof pattern !== 'string')) {
    throw new Error(`${label} enthalten ein ungültiges Tool-Pattern`);
  }
  const patterns = [...new Set(rawPatterns
    .map(pattern => (pattern as string).trim())
    .filter(Boolean))];
  if (patterns.length > 200) throw new Error(`${label} dürfen maximal 200 Einträge enthalten`);
  if (patterns.some(pattern => pattern.length > 256 || !/^[A-Za-z0-9_.:*-]+$/.test(pattern))) {
    throw new Error(`${label} enthalten ein ungültiges Tool-Pattern`);
  }
  return patterns;
}

function normalizePolicyIds(value: unknown, label: string): number[] {
  if (value != null && !Array.isArray(value)) throw new Error(`${label} müssen als Liste übergeben werden`);
  const ids = [...new Set(((value as unknown[] | undefined) ?? []).map(Number))];
  if (ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error(`${label} enthalten eine ungültige ID`);
  }
  return ids;
}

export function normalizeFabricToolAssignment(
  value: FabricToolAssignmentInput,
): {
  bundleId: number;
  tools: Array<{ backendId: number | null; name: string }>;
} {
  if (!value || typeof value !== 'object') throw new Error('Tool-Zuordnungsdaten fehlen');
  const bundleId = Number(value.bundleId);
  if (!Number.isSafeInteger(bundleId) || bundleId < 1) throw new Error('Bundle-ID ist ungültig');
  if (!Array.isArray(value.tools) || value.tools.length === 0) {
    throw new Error('Mindestens ein Tool muss ausgewählt werden');
  }
  if (value.tools.length > 500) throw new Error('Maximal 500 Tools können gleichzeitig zugeordnet werden');
  const tools = value.tools.map(tool => {
    const backendId = tool?.backendId == null ? null : Number(tool.backendId);
    const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
    if (backendId != null && (!Number.isSafeInteger(backendId) || backendId < 1)) {
      throw new Error('Backend-ID eines Tools ist ungültig');
    }
    if (!name || name.length > 256 || !/^[A-Za-z0-9_.:*-]+$/.test(name)) {
      throw new Error('Tool-Name ist ungültig');
    }
    return { backendId, name };
  });
  const unique = [...new Map(tools.map(tool => [`${tool.backendId ?? 'direct'}:${tool.name}`, tool])).values()];
  return { bundleId, tools: unique };
}

export function normalizeFabricToolTransfer(
  value: FabricToolTransferInput,
  sourceBundleId: number,
): {
  action: 'remove' | 'move';
  targetBundleId: number | null;
  tools: Array<{ backendId: number | null; name: string }>;
} {
  if (!Number.isSafeInteger(sourceBundleId) || sourceBundleId < 1) throw new Error('Bundle-ID ist ungültig');
  if (!value || typeof value !== 'object') throw new Error('Tool-Änderungsdaten fehlen');
  if (value.action !== 'remove' && value.action !== 'move') throw new Error('Tool-Aktion ist ungültig');
  const normalized = normalizeFabricToolAssignment({ bundleId: sourceBundleId, tools: value.tools });
  const targetBundleId = value.action === 'move' ? Number(value.targetBundleId) : null;
  if (value.action === 'move' && (targetBundleId == null || !Number.isSafeInteger(targetBundleId) || targetBundleId < 1)) {
    throw new Error('Ziel-Bundle ist ungültig');
  }
  if (targetBundleId === sourceBundleId) throw new Error('Quell- und Ziel-Bundle müssen verschieden sein');
  return { action: value.action, targetBundleId, tools: normalized.tools };
}

export function mutateBundleToolPolicy(
  catalogNames: string[],
  currentMode: BundleToolPolicyMode,
  currentAllowedNames: string[],
  changedNames: string[],
  operation: 'add' | 'remove',
): { mode: BundleToolPolicyMode; allowedToolNames: string[] } {
  const catalog = new Set(catalogNames);
  const effective = currentMode === 'all'
    ? new Set(catalog)
    : new Set(currentAllowedNames.filter(name => catalog.has(name)));
  for (const name of changedNames) {
    if (!catalog.has(name)) continue;
    if (operation === 'add') effective.add(name);
    else effective.delete(name);
  }
  const allowedToolNames = [...effective].sort();
  return allowedToolNames.length === catalog.size
    ? { mode: 'all', allowedToolNames: [] }
    : { mode: 'selected', allowedToolNames };
}

export function normalizeFabricCompositeMutation(
  value: FabricCompositeMutationInput,
): {
  name: string;
  description: string;
  includedBundleIds: number[];
  toolAllowPatterns: string[];
  toolDenyPatterns: string[];
  systemPrompt: string | null;
  agentRole: string | null;
  enabled: boolean;
} {
  if (!value || typeof value !== 'object') throw new Error('Composite-Daten fehlen');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 128 || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error('Interner Name darf nur a-z, 0-9, _ und - enthalten');
  }
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  if (description.length > 5_000) throw new Error('Beschreibung darf maximal 5000 Zeichen enthalten');
  const bundleMode = value.bundleMode === 'all' || value.bundleMode == null
    ? 'all'
    : value.bundleMode === 'selected' ? 'selected' : null;
  if (!bundleMode) throw new Error('Bundle-Modus muss all oder selected sein');
  const selectedBundleIds = normalizePolicyIds(value.includedBundleIds, 'Bundle-Zuordnungen');
  if (bundleMode === 'selected' && selectedBundleIds.length === 0) {
    throw new Error('Selected-Modus benötigt mindestens ein Bundle');
  }
  const toolAllowPatterns = normalizePolicyPatterns(value.toolAllowPatterns, 'Allow-Patterns');
  const toolDenyPatterns = normalizePolicyPatterns(value.toolDenyPatterns, 'Deny-Patterns');
  const systemPrompt = typeof value.systemPrompt === 'string' ? value.systemPrompt.trim() || null : null;
  const agentRole = typeof value.agentRole === 'string' ? value.agentRole.trim() || null : null;
  if (systemPrompt && systemPrompt.length > 20_000) throw new Error('System Prompt darf maximal 20000 Zeichen enthalten');
  if (agentRole && agentRole.length > 128) throw new Error('Agenten-Rolle darf maximal 128 Zeichen enthalten');
  return {
    name,
    description,
    includedBundleIds: bundleMode === 'all' ? [] : selectedBundleIds,
    toolAllowPatterns,
    toolDenyPatterns,
    systemPrompt,
    agentRole,
    enabled: value.enabled !== false,
  };
}

export function normalizeFabricGroupPolicyMutation(
  value: FabricGroupPolicyMutationInput,
): {
  groupName: string;
  compositeIds: number[];
  agentIds: number[];
  rules: Array<{ toolPattern: string; effect: 'allow' | 'deny'; reason: string | null }>;
} {
  if (!value || typeof value !== 'object') throw new Error('Gruppen-Policy-Daten fehlen');
  const groupName = typeof value.groupName === 'string' ? value.groupName.trim() : '';
  if (!groupName || groupName.length > 128 || /[\u0000-\u001f/]/.test(groupName)) {
    throw new Error('Gruppenname ist ungültig');
  }
  const compositeIds = normalizePolicyIds(value.compositeIds, 'Composite-Zuordnungen');
  const agentIds = normalizePolicyIds(value.agentIds, 'Agent-Zuordnungen');
  if (value.rules != null && !Array.isArray(value.rules)) throw new Error('Tool-Regeln müssen als Liste übergeben werden');
  const rules = (value.rules ?? []).map(rule => {
    const [toolPattern] = normalizePolicyPatterns([rule.toolPattern], 'Tool-Regeln');
    if (!toolPattern) throw new Error('Tool-Regel benötigt ein Pattern');
    if (rule.effect !== 'allow' && rule.effect !== 'deny') throw new Error('Tool-Regel benötigt allow oder deny');
    const reason = typeof rule.reason === 'string' ? rule.reason.trim() || null : null;
    if (reason && reason.length > 1_000) throw new Error('Regelbegründung darf maximal 1000 Zeichen enthalten');
    return { toolPattern, effect: rule.effect, reason };
  });
  if (rules.length > 200) throw new Error('Eine Gruppe darf maximal 200 Tool-Regeln enthalten');
  return { groupName, compositeIds, agentIds, rules };
}

export function normalizeFabricUserPolicyMutation(
  value: FabricUserPolicyMutationInput,
): {
  userId: number;
  compositeIds: number[];
  agentIds: number[];
  rules: Array<{
    toolPattern: string;
    effect: 'allow' | 'deny';
    reason: string | null;
    expiresAt: string | null;
  }>;
} {
  if (!value || typeof value !== 'object') throw new Error('Benutzer-Policy-Daten fehlen');
  const userId = Number(value.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Benutzer-ID ist ungültig');
  const compositeIds = normalizePolicyIds(value.compositeIds, 'Composite-Zuordnungen');
  const agentIds = normalizePolicyIds(value.agentIds, 'Agent-Zuordnungen');
  if (value.rules != null && !Array.isArray(value.rules)) throw new Error('Tool-Regeln müssen als Liste übergeben werden');
  const rules = (value.rules ?? []).map(rule => {
    const [toolPattern] = normalizePolicyPatterns([rule.toolPattern], 'Tool-Regeln');
    if (!toolPattern) throw new Error('Tool-Regel benötigt ein Pattern');
    if (rule.effect !== 'allow' && rule.effect !== 'deny') throw new Error('Tool-Regel benötigt allow oder deny');
    const reason = typeof rule.reason === 'string' ? rule.reason.trim() || null : null;
    if (reason && reason.length > 1_000) throw new Error('Regelbegründung darf maximal 1000 Zeichen enthalten');
    let expiresAt: string | null = null;
    if (typeof rule.expiresAt === 'string' && rule.expiresAt.trim()) {
      const timestamp = Date.parse(rule.expiresAt);
      if (!Number.isFinite(timestamp)) throw new Error('Ablaufzeit einer Tool-Regel ist ungültig');
      expiresAt = new Date(timestamp).toISOString();
    }
    return { toolPattern, effect: rule.effect, reason, expiresAt };
  });
  if (rules.length > 200) throw new Error('Ein Benutzer darf maximal 200 Tool-Regeln enthalten');
  return { userId, compositeIds, agentIds, rules };
}

export function normalizeFabricTechnicalPolicyMutation(
  value: FabricTechnicalPolicyMutationInput,
): {
  kind: 'agent' | 'api_key';
  id: number;
  compositeId: number | null;
  allowedBundleIds: number[] | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
} {
  if (!value || typeof value !== 'object') throw new Error('Technical-Identity-Daten fehlen');
  if (value.kind !== 'agent' && value.kind !== 'api_key') throw new Error('Technical-Identity-Typ ist ungültig');
  const id = Number(value.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Technical-Identity-ID ist ungültig');
  const rawCompositeId = value.compositeId == null || value.compositeId === '' ? null : Number(value.compositeId);
  if (rawCompositeId != null && (!Number.isSafeInteger(rawCompositeId) || rawCompositeId < 1)) {
    throw new Error('Composite-ID ist ungültig');
  }
  if (value.kind === 'agent') {
    return {
      kind: value.kind,
      id,
      compositeId: rawCompositeId,
      allowedBundleIds: null,
      allowedTools: null,
      deniedTools: null,
    };
  }
  const bundleMode = value.bundleMode === 'all' || value.bundleMode == null
    ? 'all'
    : value.bundleMode === 'selected' ? 'selected' : null;
  if (!bundleMode) throw new Error('Bundle-Modus muss all oder selected sein');
  const bundleIds = normalizePolicyIds(value.allowedBundleIds, 'Bundle-Zuordnungen');
  if (bundleMode === 'selected' && bundleIds.length === 0) {
    throw new Error('Selected-Modus benötigt mindestens ein Bundle');
  }
  const toolMode = value.toolMode === 'all' || value.toolMode == null
    ? 'all'
    : value.toolMode === 'selected' ? 'selected' : null;
  if (!toolMode) throw new Error('Tool-Modus muss all oder selected sein');
  const normalizeLegacyPatterns = (patterns: unknown) =>
    normalizePolicyPatterns(
      Array.isArray(patterns)
        ? patterns.map(pattern => typeof pattern === 'string' ? pattern.replace(/%/g, '*') : pattern)
        : patterns,
      'Tool-Patterns',
    );
  const allowedTools = normalizeLegacyPatterns(value.allowedTools);
  const deniedTools = normalizeLegacyPatterns(value.deniedTools);
  if (toolMode === 'selected' && allowedTools.length === 0) {
    throw new Error('Selected-Modus benötigt mindestens ein Tool-Pattern');
  }
  return {
    kind: value.kind,
    id,
    compositeId: rawCompositeId,
    allowedBundleIds: bundleMode === 'all' ? null : bundleIds,
    allowedTools: toolMode === 'all' ? null : allowedTools,
    deniedTools: deniedTools.length === 0 ? null : deniedTools,
  };
}

export function normalizePolicySimulationInput(value: PolicySimulationInput): {
  principalKind: PolicySimulatorPrincipalKind;
  principalId: string;
  toolName: string;
} {
  if (!value || typeof value !== 'object') throw new Error('Simulationsdaten fehlen');
  const kinds = new Set<PolicySimulatorPrincipalKind>(['user', 'agent', 'api_key', 'group', 'composite']);
  if (!kinds.has(value.principalKind as PolicySimulatorPrincipalKind)) {
    throw new Error('Principal-Typ ist ungültig');
  }
  const principalKind = value.principalKind as PolicySimulatorPrincipalKind;
  const principalId = String(value.principalId ?? '').trim();
  if (!principalId || principalId.length > 128 || /[\u0000-\u001f/]/.test(principalId)) {
    throw new Error('Principal-ID ist ungültig');
  }
  if (principalKind !== 'group' && (!/^\d+$/.test(principalId) || Number(principalId) < 1)) {
    throw new Error('Principal-ID ist ungültig');
  }
  const toolName = typeof value.toolName === 'string' ? value.toolName.trim() : '';
  if (!toolName || toolName.length > 256 || !/^[A-Za-z0-9_.:*-]+$/.test(toolName)) {
    throw new Error('Tool-Name ist ungültig');
  }
  return { principalKind, principalId, toolName };
}

export function normalizeFabricAccessMutation(value: FabricAccessMutationInput): {
  kind: ManageableAccessKind;
  id: number;
  granted: boolean;
} {
  if (!value || typeof value !== 'object') throw new Error('Access-Daten fehlen');
  const allowedKinds = new Set<ManageableAccessKind>(['user', 'api_key', 'agent', 'workflow']);
  if (!allowedKinds.has(value.kind as ManageableAccessKind)) {
    throw new Error('Principal-Typ wird nicht unterstützt');
  }
  const id = Number(value.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Principal-ID ist ungültig');
  if (typeof value.granted !== 'boolean') throw new Error('Access-Status muss true oder false sein');
  return { kind: value.kind as ManageableAccessKind, id, granted: value.granted };
}

async function loadBundleAccess(pool: pg.Pool, bundleId: number): Promise<AccessPrincipalRow[]> {
  const [users, apiKeys, agents, workflows, policies, groups] = await Promise.all([
    pool.query<AccessPrincipalRow>(
      `SELECT
         u.id::text,
         u.display_name AS label,
         u.username || ' · ' || replace(u.role, '_', ' ') AS secondary,
         'user'::text AS kind,
         CASE WHEN u.allowed_bundles IS NULL THEN 'unrestricted' ELSE 'direct' END::text AS source,
         u.enabled
       FROM mcp_users u
       WHERE u.enabled = true
         AND (u.allowed_bundles IS NULL OR $1 = ANY(u.allowed_bundles))
       ORDER BY u.display_name`,
      [bundleId],
    ),
    pool.query<AccessPrincipalRow>(
      `SELECT
         k.id::text,
         k.label,
         k.key_prefix || '… · ' || k.scope AS secondary,
         'api_key'::text AS kind,
         CASE WHEN k.allowed_bundles IS NULL THEN 'unrestricted' ELSE 'direct' END::text AS source,
         k.enabled
       FROM mcp_api_keys k
       WHERE k.enabled = true
         AND k.deleted_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > now())
         AND k.scope IN ('mcp', 'both')
         AND (k.allowed_bundles IS NULL OR $1 = ANY(k.allowed_bundles))
       ORDER BY k.label`,
      [bundleId],
    ),
    pool.query<AccessPrincipalRow>(
      `SELECT
         a.id::text,
         a.label,
         CASE
           WHEN c.id IS NOT NULL THEN c.name || ' policy'
           ELSE replace(a.agent_mode, '_', ' ') || ' agent'
         END AS secondary,
         'agent'::text AS kind,
         CASE
           WHEN c.id IS NOT NULL THEN 'composite'
           WHEN a.bundle_ids IS NULL OR cardinality(a.bundle_ids) = 0 THEN 'unrestricted'
           ELSE 'direct'
         END::text AS source,
         a.enabled
       FROM mcp_agents a
       LEFT JOIN mcp_composites c ON c.id = a.composite_id AND c.enabled = true
       WHERE a.enabled = true
         AND (
           (c.id IS NOT NULL AND (cardinality(c.included_bundle_ids) = 0 OR $1 = ANY(c.included_bundle_ids)))
           OR (c.id IS NULL AND (a.bundle_ids IS NULL OR cardinality(a.bundle_ids) = 0 OR $1 = ANY(a.bundle_ids)))
         )
       ORDER BY a.label`,
      [bundleId],
    ),
    pool.query<AccessPrincipalRow>(
      `SELECT
         w.id::text,
         w.name AS label,
         coalesce(nullif(w.lifecycle_status, ''), 'draft') || ' workflow' AS secondary,
         'workflow'::text AS kind,
         'direct'::text AS source,
         w.enabled
       FROM mcp_workflows w
       JOIN mcp_workflow_bundles wb ON wb.workflow_id = w.id
       WHERE wb.bundle_id = $1
       ORDER BY w.name`,
      [bundleId],
    ),
    pool.query<AccessPrincipalRow>(
      `SELECT
         c.id::text,
         c.name AS label,
         (
           (SELECT count(*) FROM mcp_user_composites uc WHERE uc.composite_id = c.id)
           + (SELECT count(*) FROM mcp_agents a WHERE a.composite_id = c.id)
         )::text || ' direct assignments · '
           || cardinality(c.tool_allow_patterns)::text || ' allow / '
           || cardinality(c.tool_deny_patterns)::text || ' deny patterns' AS secondary,
         'policy'::text AS kind,
         'composite'::text AS source,
         c.enabled
       FROM mcp_composites c
       WHERE c.enabled = true
         AND (cardinality(c.included_bundle_ids) = 0 OR $1 = ANY(c.included_bundle_ids))
       ORDER BY c.name`,
      [bundleId],
    ),
    pool.query<AccessPrincipalRow>(
      `SELECT
         gc.group_name AS id,
         gc.group_name AS label,
         string_agg(c.name, ', ' ORDER BY c.name) || ' · '
           || (SELECT count(*) FROM mcp_group_tool_rules gr WHERE gr.group_name = gc.group_name)::text
           || ' group overrides' AS secondary,
         'group'::text AS kind,
         'group'::text AS source,
         bool_or(c.enabled) AS enabled
       FROM mcp_group_composites gc
       JOIN mcp_composites c ON c.id = gc.composite_id
       WHERE c.enabled = true
         AND (cardinality(c.included_bundle_ids) = 0 OR $1 = ANY(c.included_bundle_ids))
       GROUP BY gc.group_name
       ORDER BY gc.group_name`,
      [bundleId],
    ),
  ]);

  return [
    ...users.rows,
    ...apiKeys.rows,
    ...agents.rows,
    ...workflows.rows,
    ...policies.rows,
    ...groups.rows,
  ];
}

export async function loadBundleAccessCandidates(pool: pg.Pool, bundleId: number): Promise<AccessCandidateRow[]> {
  const [users, apiKeys, agents, workflows, inherited] = await Promise.all([
    pool.query<AccessCandidateRow>(
      `SELECT
         u.id::text,
         u.display_name AS label,
         u.username || ' · ' || replace(u.role, '_', ' ') AS secondary,
         'user'::text AS kind,
         CASE
           WHEN u.allowed_bundles IS NULL THEN 'unrestricted'
           WHEN $1 = ANY(u.allowed_bundles) THEN 'direct'
           ELSE 'none'
         END::text AS access,
         u.enabled,
         (u.allowed_bundles IS NOT NULL) AS editable,
         CASE
           WHEN u.allowed_bundles IS NULL THEN 'Global bundle access'
           ELSE 'Direct user bundle scope'
         END AS reason
       FROM mcp_users u
       ORDER BY u.enabled DESC, u.display_name`,
      [bundleId],
    ),
    pool.query<AccessCandidateRow>(
      `SELECT
         k.id::text,
         k.label,
         k.key_prefix || '… · ' || k.scope AS secondary,
         'api_key'::text AS kind,
         CASE
           WHEN k.allowed_bundles IS NULL AND k.scope IN ('mcp', 'both') THEN 'unrestricted'
           WHEN $1 = ANY(k.allowed_bundles) AND k.scope IN ('mcp', 'both') THEN 'direct'
           ELSE 'none'
         END::text AS access,
         (k.enabled AND k.deleted_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())) AS enabled,
         (k.allowed_bundles IS NOT NULL AND k.scope IN ('mcp', 'both') AND k.deleted_at IS NULL) AS editable,
         CASE
           WHEN k.scope NOT IN ('mcp', 'both') THEN 'Key scope does not permit MCP'
           WHEN k.allowed_bundles IS NULL THEN 'Global bundle access'
           ELSE 'Direct API-key bundle scope'
         END AS reason
       FROM mcp_api_keys k
       WHERE k.deleted_at IS NULL
       ORDER BY k.enabled DESC, k.label`,
      [bundleId],
    ),
    pool.query<AccessCandidateRow>(
      `SELECT
         a.id::text,
         a.label,
         CASE WHEN c.id IS NOT NULL
           THEN c.name || ' composite'
           ELSE replace(a.agent_mode, '_', ' ') || ' agent'
         END AS secondary,
         'agent'::text AS kind,
         CASE
           WHEN c.id IS NOT NULL AND c.enabled
             AND (cardinality(c.included_bundle_ids) = 0 OR $1 = ANY(c.included_bundle_ids))
             THEN 'inherited'
           WHEN c.id IS NOT NULL THEN 'none'
           WHEN a.bundle_ids IS NULL OR cardinality(a.bundle_ids) = 0 THEN 'unrestricted'
           WHEN $1 = ANY(a.bundle_ids) THEN 'direct'
           ELSE 'none'
         END::text AS access,
         a.enabled,
         (c.id IS NULL AND a.bundle_ids IS NOT NULL AND cardinality(a.bundle_ids) > 0) AS editable,
         CASE
           WHEN c.id IS NOT NULL AND NOT c.enabled THEN 'Assigned composite is disabled'
           WHEN c.id IS NOT NULL THEN 'Managed by ' || c.name || ' composite'
           WHEN a.bundle_ids IS NULL OR cardinality(a.bundle_ids) = 0 THEN 'Global agent bundle access'
           ELSE 'Direct agent bundle scope'
         END AS reason
       FROM mcp_agents a
       LEFT JOIN mcp_composites c ON c.id = a.composite_id
       ORDER BY a.enabled DESC, a.label`,
      [bundleId],
    ),
    pool.query<AccessCandidateRow>(
      `SELECT
         w.id::text,
         w.name AS label,
         coalesce(nullif(w.lifecycle_status, ''), 'draft') || ' workflow' AS secondary,
         'workflow'::text AS kind,
         CASE WHEN wb.workflow_id IS NULL THEN 'none' ELSE 'direct' END::text AS access,
         w.enabled,
         true AS editable,
         'Direct workflow bundle binding' AS reason
       FROM mcp_workflows w
       LEFT JOIN mcp_workflow_bundles wb
         ON wb.workflow_id = w.id AND wb.bundle_id = $1
       ORDER BY w.enabled DESC, w.name`,
      [bundleId],
    ),
    loadBundleAccess(pool, bundleId),
  ]);

  const inheritedCandidates: AccessCandidateRow[] = inherited
    .filter(principal => principal.kind === 'group' || principal.kind === 'policy')
    .map(principal => ({
      id: principal.id,
      label: principal.label,
      secondary: principal.secondary,
      kind: principal.kind,
      access: 'inherited',
      enabled: principal.enabled,
      editable: false,
      reason: principal.kind === 'group'
        ? 'Managed through group composite policy'
        : 'Composite policy controls this path',
    }));

  return [
    ...users.rows,
    ...apiKeys.rows,
    ...agents.rows,
    ...workflows.rows,
    ...inheritedCandidates,
  ];
}

export async function loadAccessPolicyManagement(pool: pg.Pool) {
  const [bundles, composites, groups, tools, bundleTools, users, agents, apiKeys] = await Promise.all([
    listBundles(pool),
    pool.query<{
      id: number;
      name: string;
      description: string;
      included_bundle_ids: number[];
      tool_allow_patterns: string[];
      tool_deny_patterns: string[];
      system_prompt: string | null;
      agent_role: string | null;
      enabled: boolean;
      created_at: string | Date;
      updated_at: string | Date;
      user_count: number;
      group_count: number;
      agent_count: number;
      api_key_count: number;
      group_names: string[];
    }>(
      `SELECT c.*,
         (SELECT count(*) FROM mcp_user_composites uc WHERE uc.composite_id = c.id)::int AS user_count,
         (SELECT count(*) FROM mcp_group_composites gc WHERE gc.composite_id = c.id)::int AS group_count,
         (SELECT count(*) FROM mcp_agents a WHERE a.composite_id = c.id)::int AS agent_count,
         (SELECT count(*) FROM mcp_api_keys k WHERE k.composite_id = c.id AND k.deleted_at IS NULL)::int AS api_key_count,
         COALESCE(
           (SELECT array_agg(gc.group_name ORDER BY gc.group_name)
              FROM mcp_group_composites gc WHERE gc.composite_id = c.id),
           '{}'
         )::text[] AS group_names
       FROM mcp_composites c
       ORDER BY c.name`,
    ),
    pool.query<{
      name: string;
      member_count: number;
      composite_ids: number[];
      agent_ids: number[];
      denied_agent_ids: number[];
      rules: Array<{ id: number; toolPattern: string; effect: 'allow' | 'deny'; reason: string | null }>;
    }>(
      `WITH known_groups AS (
         SELECT DISTINCT unnest(u.entra_groups) AS name
           FROM mcp_users u
         UNION
         SELECT DISTINCT gc.group_name AS name FROM mcp_group_composites gc
         UNION
         SELECT DISTINCT gr.group_name AS name FROM mcp_group_tool_rules gr
         UNION
         SELECT DISTINCT gar.group_name AS name FROM mcp_group_agent_rules gar
       )
       SELECT known.name,
         (SELECT count(*) FROM mcp_users u WHERE known.name = ANY(u.entra_groups))::int AS member_count,
         COALESCE(
           (SELECT array_agg(gc.composite_id ORDER BY gc.composite_id)
              FROM mcp_group_composites gc WHERE gc.group_name = known.name),
           '{}'
         )::int[] AS composite_ids,
         COALESCE(
           (SELECT array_agg(gar.agent_id ORDER BY gar.agent_id)
              FROM mcp_group_agent_rules gar
             WHERE gar.group_name = known.name AND gar.effect = 'allow'),
           '{}'
         )::int[] AS agent_ids,
         COALESCE(
           (SELECT array_agg(gar.agent_id ORDER BY gar.agent_id)
              FROM mcp_group_agent_rules gar
             WHERE gar.group_name = known.name AND gar.effect = 'deny'),
           '{}'
         )::int[] AS denied_agent_ids,
         COALESCE(
           (SELECT json_agg(json_build_object(
             'id', gr.id,
             'toolPattern', gr.tool_pattern,
             'effect', gr.effect,
             'reason', gr.reason
           ) ORDER BY gr.id)
              FROM mcp_group_tool_rules gr WHERE gr.group_name = known.name),
           '[]'::json
         ) AS rules
       FROM known_groups known
       WHERE known.name IS NOT NULL AND known.name <> ''
       ORDER BY known.name`,
    ),
    pool.query<{ name: string }>(
      `SELECT name FROM mcp_tools WHERE enabled = true
       UNION
       SELECT prefixed_name AS name FROM mcp_remote_tools
       ORDER BY name`,
    ),
    pool.query<{ bundle_id: number; tool_names: string[] }>(
      `SELECT scoped.bundle_id,
         array_agg(DISTINCT scoped.tool_name ORDER BY scoped.tool_name)::text[] AS tool_names
       FROM (
         SELECT tb.bundle_id, t.name AS tool_name
           FROM mcp_tool_bundles tb
           JOIN mcp_tools t ON t.id = tb.tool_id
          WHERE t.enabled = true
         UNION ALL
         SELECT bb.bundle_id, rt.prefixed_name AS tool_name
           FROM mcp_backend_bundles bb
           JOIN mcp_remote_tools rt ON rt.backend_id = bb.backend_id
           LEFT JOIN mcp_bundle_backend_tool_policies policy
             ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
          WHERE policy.mode IS NULL
             OR policy.mode = 'all'
             OR rt.prefixed_name = ANY(policy.allowed_tool_names)
       ) scoped
       GROUP BY scoped.bundle_id
       ORDER BY scoped.bundle_id`,
    ),
    pool.query<{
      id: number;
      label: string;
      secondary: string;
      username: string;
      role: string;
      enabled: boolean;
      allowed_bundles: number[] | null;
      entra_groups: string[];
      composite_ids: number[];
      agent_ids: number[];
      denied_agent_ids: number[];
      rules: Array<{
        id: number;
        toolPattern: string;
        effect: 'allow' | 'deny';
        reason: string | null;
        expiresAt: string | null;
      }>;
    }>(
      `SELECT id,
         CASE WHEN display_name <> '' THEN display_name ELSE username END AS label,
         username || ' · ' || role AS secondary,
         username, role, enabled, allowed_bundles, entra_groups,
         COALESCE(
           (SELECT array_agg(uc.composite_id ORDER BY uc.composite_id)
              FROM mcp_user_composites uc WHERE uc.user_id = mcp_users.id),
           '{}'
         )::int[] AS composite_ids,
         COALESCE(
           (SELECT array_agg(uar.agent_id ORDER BY uar.agent_id)
              FROM mcp_user_agent_rules uar
             WHERE uar.user_id = mcp_users.id AND uar.effect = 'allow'
               AND (uar.expires_at IS NULL OR uar.expires_at > now())),
           '{}'
         )::int[] AS agent_ids,
         COALESCE(
           (SELECT array_agg(uar.agent_id ORDER BY uar.agent_id)
              FROM mcp_user_agent_rules uar
             WHERE uar.user_id = mcp_users.id AND uar.effect = 'deny'
               AND (uar.expires_at IS NULL OR uar.expires_at > now())),
           '{}'
         )::int[] AS denied_agent_ids,
         COALESCE(
           (SELECT json_agg(json_build_object(
             'id', utr.id,
             'toolPattern', utr.tool_pattern,
             'effect', utr.effect,
             'reason', utr.reason,
             'expiresAt', utr.expires_at
           ) ORDER BY utr.id)
              FROM mcp_user_tool_rules utr WHERE utr.user_id = mcp_users.id),
           '[]'::json
         ) AS rules
       FROM mcp_users
       ORDER BY label`,
    ),
    pool.query<{
      id: number;
      label: string;
      secondary: string;
      name: string;
      model: string;
      enabled: boolean;
      composite_id: number | null;
    }>(
      `SELECT id, label, name || ' · ' || model AS secondary,
         name, model, enabled, composite_id
       FROM mcp_agents
       ORDER BY label`,
    ),
    pool.query<{
      id: number;
      label: string;
      secondary: string;
      enabled: boolean;
      key_prefix: string;
      key_suffix: string | null;
      scope: 'mcp' | 'agents' | 'both';
      composite_id: number | null;
      allowed_bundles: number[] | null;
      allowed_tools: string[] | null;
      denied_tools: string[] | null;
    }>(
      `SELECT id, label,
         key_prefix || coalesce('••••' || key_suffix, '') || ' · ' || scope AS secondary,
         enabled, key_prefix, key_suffix, scope, composite_id,
         allowed_bundles, allowed_tools, denied_tools
       FROM mcp_api_keys
       WHERE deleted_at IS NULL
       ORDER BY label`,
    ),
  ]);

  const payload = {
    generatedAt: new Date().toISOString(),
    permissions: { canManage: true },
    stats: {
      composites: composites.rows.length,
      enabled: composites.rows.filter(composite => composite.enabled).length,
      groups: groups.rows.length,
      rules: groups.rows.reduce((sum, group) => sum + group.rules.length, 0),
    },
    bundles: bundles.map(bundle => ({
      id: bundle.id,
      name: bundle.name,
      label: bundle.label,
      icon: bundle.icon,
      toolCount: bundle.tool_count,
      toolNames: bundleTools.rows.find(row => row.bundle_id === bundle.id)?.tool_names ?? [],
    })),
    tools: tools.rows.map(tool => tool.name),
    technicalIdentities: [
      ...agents.rows.map(agent => ({
        id: agent.id,
        kind: 'agent' as const,
        label: agent.label,
        secondary: agent.secondary,
        enabled: agent.enabled,
        compositeId: agent.composite_id,
        scope: null,
        allowedBundleIds: null,
        allowedTools: null,
        deniedTools: null,
      })),
      ...apiKeys.rows.map(key => ({
        id: key.id,
        kind: 'api_key' as const,
        label: key.label,
        secondary: key.secondary,
        enabled: key.enabled,
        compositeId: key.composite_id,
        scope: key.scope,
        allowedBundleIds: key.allowed_bundles,
        allowedTools: key.allowed_tools?.map(pattern => pattern.replace(/%/g, '*')) ?? null,
        deniedTools: key.denied_tools?.map(pattern => pattern.replace(/%/g, '*')) ?? null,
      })),
    ],
    users: users.rows.map(user => ({
      id: user.id,
      label: user.label,
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      allowedBundleIds: user.allowed_bundles,
      entraGroups: user.entra_groups,
      compositeIds: user.composite_ids,
      agentIds: user.agent_ids,
      deniedAgentIds: user.denied_agent_ids,
      rules: user.rules.map(rule => ({
        ...rule,
        expiresAt: rule.expiresAt ? isoValue(rule.expiresAt) : null,
      })),
    })),
    simulatorPrincipals: [
      ...users.rows.map(principal => ({ ...principal, id: String(principal.id), kind: 'user' as const })),
      ...agents.rows.map(principal => ({ ...principal, id: String(principal.id), kind: 'agent' as const })),
      ...apiKeys.rows.map(principal => ({ ...principal, id: String(principal.id), kind: 'api_key' as const })),
      ...groups.rows.map(group => ({
        id: group.name,
        label: group.name,
        secondary: `${group.member_count} members · ${group.composite_ids.length} composites`,
        enabled: true,
        kind: 'group' as const,
      })),
      ...composites.rows.map(composite => ({
        id: String(composite.id),
        label: composite.name,
        secondary: `${composite.included_bundle_ids.length === 0 ? 'All bundles' : `${composite.included_bundle_ids.length} bundles`} · composite`,
        enabled: composite.enabled,
        kind: 'composite' as const,
      })),
    ],
    composites: composites.rows.map(composite => ({
      id: composite.id,
      name: composite.name,
      description: composite.description,
      bundleMode: composite.included_bundle_ids.length === 0 ? 'all' as const : 'selected' as const,
      includedBundleIds: composite.included_bundle_ids,
      toolAllowPatterns: composite.tool_allow_patterns,
      toolDenyPatterns: composite.tool_deny_patterns,
      systemPrompt: composite.system_prompt,
      agentRole: composite.agent_role,
      enabled: composite.enabled,
      userCount: composite.user_count,
      groupCount: composite.group_count,
      agentCount: composite.agent_count,
      apiKeyCount: composite.api_key_count,
      groupNames: composite.group_names,
      createdAt: isoValue(composite.created_at),
      updatedAt: isoValue(composite.updated_at),
    })),
    groups: groups.rows.map(group => ({
      name: group.name,
      memberCount: group.member_count,
      compositeIds: group.composite_ids,
      agentIds: group.agent_ids,
      deniedAgentIds: group.denied_agent_ids,
      rules: group.rules,
    })),
  };
  return {
    ...payload,
    posture: buildPolicyPosture(payload),
  };
}

interface PolicySimulationStep extends PolicyExplanationStep {
  source?: string;
}

interface PolicySimulationResult {
  generatedAt: string;
  principal: {
    kind: PolicySimulatorPrincipalKind;
    id: string;
    label: string;
    secondary: string;
    enabled: boolean;
  };
  toolName: string;
  decision: 'allow' | 'deny';
  rawDecision: 'allow' | 'deny' | 'no_rule';
  reason: string;
  policyMode: boolean;
  steps: PolicySimulationStep[];
  sources: string[];
}

function simulatorGlobMatch(pattern: string, toolName: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(toolName);
}

function matchingSimulatorPatterns(patterns: string[] | null, toolName: string): string[] {
  return (patterns ?? []).filter(pattern => simulatorGlobMatch(pattern, toolName));
}

async function evaluateCompositeForSimulation(
  pool: pg.Pool,
  composite: {
    id: number;
    name: string;
    enabled: boolean;
    included_bundle_ids: number[];
    tool_allow_patterns: string[];
    tool_deny_patterns: string[];
  },
  toolName: string,
  options: { enforceEnabled: boolean },
): Promise<{ decision: 'allow' | 'deny'; reason: string; steps: PolicySimulationStep[] }> {
  const steps: PolicySimulationStep[] = [];
  if (options.enforceEnabled && !composite.enabled) {
    steps.push({
      key: 'composite-enabled',
      label: 'Composite state',
      outcome: 'matched',
      detail: `${composite.name} is disabled and grants no access.`,
      evidence: ['disabled'],
      source: composite.name,
    });
    return { decision: 'deny', reason: 'assigned composite is disabled', steps };
  }
  steps.push({
    key: 'composite-enabled',
    label: 'Composite state',
    outcome: 'passed',
    detail: composite.enabled
      ? `${composite.name} is enabled.`
      : `${composite.name} is disabled, but the agent runtime currently evaluates an assigned composite by ID.`,
    evidence: [composite.enabled ? 'enabled' : 'runtime compatibility'],
    source: composite.name,
  });

  if (composite.included_bundle_ids.length > 0 && !toolName.startsWith('workspace_') && !toolName.startsWith('rag_')) {
    const tools = await loadAllowedToolNames(pool, composite.included_bundle_ids, {
      includeUnscoped: false,
    });
    const inScope = tools.has(toolName);
    steps.push({
      key: 'composite-bundle-scope',
      label: 'Bundle scope',
      outcome: inScope ? 'passed' : 'matched',
      detail: inScope
        ? 'The tool belongs to an included bundle.'
        : 'The tool is outside every included bundle.',
      evidence: composite.included_bundle_ids.map(String),
      source: composite.name,
    });
    if (!inScope) return { decision: 'deny', reason: 'tool is outside the composite bundle scope', steps };
  } else {
    steps.push({
      key: 'composite-bundle-scope',
      label: 'Bundle scope',
      outcome: 'passed',
      detail: composite.included_bundle_ids.length === 0
        ? 'The composite includes all bundles.'
        : 'Built-in workspace and RAG tools bypass bundle membership.',
      evidence: composite.included_bundle_ids.length === 0 ? ['all bundles'] : ['built-in tool'],
      source: composite.name,
    });
  }

  const denied = matchingSimulatorPatterns(composite.tool_deny_patterns, toolName);
  steps.push({
    key: 'composite-deny',
    label: 'Composite deny patterns',
    outcome: denied.length > 0 ? 'matched' : 'passed',
    detail: denied.length > 0 ? 'A deny pattern blocks this tool.' : 'No deny pattern matched.',
    evidence: denied,
    source: composite.name,
  });
  if (denied.length > 0) return { decision: 'deny', reason: `denied by composite ${composite.name}`, steps };

  const allowed = matchingSimulatorPatterns(composite.tool_allow_patterns, toolName);
  const wildcard = composite.tool_allow_patterns.length === 0;
  steps.push({
    key: 'composite-allow',
    label: 'Composite allow patterns',
    outcome: wildcard || allowed.length > 0 ? 'matched' : 'passed',
    detail: wildcard
      ? 'The empty allow list permits every tool inside the bundle scope.'
      : allowed.length > 0 ? 'An allow pattern permits this tool.' : 'No allow pattern matched.',
    evidence: wildcard ? ['* (empty allow list)'] : allowed,
    source: composite.name,
  });
  return wildcard || allowed.length > 0
    ? { decision: 'allow', reason: `allowed by composite ${composite.name}`, steps }
    : { decision: 'deny', reason: `no allow pattern matched composite ${composite.name}`, steps };
}

async function loadSimulatorComposite(pool: pg.Pool, id: number) {
  const result = await pool.query<{
    id: number;
    name: string;
    enabled: boolean;
    included_bundle_ids: number[];
    tool_allow_patterns: string[];
    tool_deny_patterns: string[];
  }>(
    `SELECT id, name, enabled, included_bundle_ids, tool_allow_patterns, tool_deny_patterns
     FROM mcp_composites WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function simulateAccessPolicy(
  pool: pg.Pool,
  input: ReturnType<typeof normalizePolicySimulationInput>,
): Promise<PolicySimulationResult | null> {
  const base = {
    generatedAt: new Date().toISOString(),
    toolName: input.toolName,
  };

  if (input.principalKind === 'user') {
    const userResult = await pool.query<{
      id: number;
      username: string;
      display_name: string;
      role: string;
      enabled: boolean;
      entra_groups: string[];
    }>(
      `SELECT id, username, display_name, role, enabled, entra_groups
       FROM mcp_users WHERE id = $1`,
      [Number(input.principalId)],
    );
    const user = userResult.rows[0];
    if (!user) return null;
    if (!user.enabled) {
      return {
        ...base,
        principal: {
          kind: 'user',
          id: input.principalId,
          label: user.display_name || user.username,
          secondary: `${user.username} · ${user.role}`,
          enabled: false,
        },
        decision: 'deny',
        rawDecision: 'deny',
        reason: 'user account is disabled',
        policyMode: false,
        steps: [{
          key: 'principal-enabled',
          label: 'Principal state',
          outcome: 'matched',
          detail: 'Disabled users cannot invoke tools.',
          evidence: ['disabled'],
        }],
        sources: [],
      };
    }
    const data = await fetchUserPolicyData(pool, user.id, user.entra_groups ?? []);
    const explained = explainUserPolicy({ toolName: input.toolName, ...data });
    const sourceRows = await pool.query<{ name: string }>(
      `SELECT DISTINCT c.name
       FROM mcp_composites c
       WHERE c.enabled = true AND (
         EXISTS (SELECT 1 FROM mcp_user_composites uc WHERE uc.user_id = $1 AND uc.composite_id = c.id)
         OR EXISTS (
           SELECT 1 FROM mcp_group_composites gc
           WHERE gc.composite_id = c.id AND gc.group_name = ANY($2::text[])
         )
       )
       ORDER BY c.name`,
      [user.id, user.entra_groups ?? []],
    );
    const rawDecision = explained.result.decision;
    return {
      ...base,
      principal: {
        kind: 'user',
        id: input.principalId,
        label: user.display_name || user.username,
        secondary: `${user.username} · ${user.role}`,
        enabled: true,
      },
      decision: rawDecision === 'allow' ? 'allow' : 'deny',
      rawDecision,
      reason: explained.result.reason,
      policyMode: explained.policyMode,
      steps: explained.steps,
      sources: [
        ...sourceRows.rows.map(row => row.name),
        ...(user.entra_groups ?? []).map(group => `group:${group}`),
      ],
    };
  }

  if (input.principalKind === 'group') {
    const compositeRows = await pool.query<{
      id: number;
      name: string;
      tool_allow_patterns: string[];
      tool_deny_patterns: string[];
    }>(
      `SELECT c.id, c.name, c.tool_allow_patterns, c.tool_deny_patterns
       FROM mcp_group_composites gc
       JOIN mcp_composites c ON c.id = gc.composite_id
       WHERE gc.group_name = $1 AND c.enabled = true
       ORDER BY c.name`,
      [input.principalId],
    );
    const ruleRows = await pool.query<{
      id: number;
      tool_pattern: string;
      effect: 'allow' | 'deny';
    }>(
      `SELECT id, tool_pattern, effect FROM mcp_group_tool_rules
       WHERE group_name = $1 ORDER BY id`,
      [input.principalId],
    );
    const explained = explainUserPolicy({
      toolName: input.toolName,
      hasUserComposites: false,
      hasGroupComposites: compositeRows.rows.length > 0,
      userCompositeAllowPatterns: [],
      userCompositeDenyPatterns: [],
      groupCompositeAllowPatterns: compositeRows.rows.flatMap(row => row.tool_allow_patterns ?? []),
      groupCompositeDenyPatterns: compositeRows.rows.flatMap(row => row.tool_deny_patterns ?? []),
      userAllowRules: [],
      userDenyRules: [],
      groupAllowRules: ruleRows.rows.filter(row => row.effect === 'allow')
        .map(row => ({ id: row.id, pattern: row.tool_pattern, source: `group:${input.principalId}` })),
      groupDenyRules: ruleRows.rows.filter(row => row.effect === 'deny')
        .map(row => ({ id: row.id, pattern: row.tool_pattern, source: `group:${input.principalId}` })),
      legacyAllowedBundleTools: null,
    });
    const rawDecision = explained.result.decision;
    return {
      ...base,
      principal: {
        kind: 'group',
        id: input.principalId,
        label: input.principalId,
        secondary: `${compositeRows.rows.length} composites · ${ruleRows.rows.length} rules`,
        enabled: true,
      },
      decision: rawDecision === 'allow' ? 'allow' : 'deny',
      rawDecision,
      reason: explained.result.reason,
      policyMode: explained.policyMode,
      steps: explained.steps,
      sources: compositeRows.rows.map(row => row.name),
    };
  }

  if (input.principalKind === 'composite') {
    const composite = await loadSimulatorComposite(pool, Number(input.principalId));
    if (!composite) return null;
    const evaluated = await evaluateCompositeForSimulation(pool, composite, input.toolName, { enforceEnabled: true });
    return {
      ...base,
      principal: {
        kind: 'composite',
        id: input.principalId,
        label: composite.name,
        secondary: 'Composite policy',
        enabled: composite.enabled,
      },
      decision: evaluated.decision,
      rawDecision: evaluated.decision,
      reason: evaluated.reason,
      policyMode: true,
      steps: evaluated.steps,
      sources: [composite.name],
    };
  }

  if (input.principalKind === 'agent') {
    const result = await pool.query<{
      id: number;
      name: string;
      label: string;
      model: string;
      enabled: boolean;
      composite_id: number | null;
    }>(
      'SELECT id, name, label, model, enabled, composite_id FROM mcp_agents WHERE id = $1',
      [Number(input.principalId)],
    );
    const agent = result.rows[0];
    if (!agent) return null;
    const principal = {
      kind: 'agent' as const,
      id: input.principalId,
      label: agent.label,
      secondary: `${agent.name} · ${agent.model}`,
      enabled: agent.enabled,
    };
    if (!agent.enabled) {
      return {
        ...base,
        principal,
        decision: 'deny',
        rawDecision: 'deny',
        reason: 'agent is disabled',
        policyMode: Boolean(agent.composite_id),
        steps: [{
          key: 'principal-enabled',
          label: 'Principal state',
          outcome: 'matched',
          detail: 'Disabled agents cannot be executed.',
          evidence: ['disabled'],
        }],
        sources: [],
      };
    }
    if (agent.composite_id == null) {
      return {
        ...base,
        principal,
        decision: 'allow',
        rawDecision: 'allow',
        reason: 'agent has no composite restriction',
        policyMode: false,
        steps: [{
          key: 'agent-composite',
          label: 'Agent composite',
          outcome: 'matched',
          detail: 'No composite is assigned, so the agent tool catalog is unrestricted.',
          evidence: ['unrestricted'],
        }],
        sources: [],
      };
    }
    const composite = await loadSimulatorComposite(pool, agent.composite_id);
    if (!composite) return null;
    const evaluated = await evaluateCompositeForSimulation(pool, composite, input.toolName, { enforceEnabled: false });
    return {
      ...base,
      principal,
      decision: evaluated.decision,
      rawDecision: evaluated.decision,
      reason: evaluated.reason,
      policyMode: true,
      steps: evaluated.steps,
      sources: [composite.name],
    };
  }

  const result = await pool.query<{
    id: number;
    key_prefix: string;
    key_suffix: string | null;
    label: string;
    allowed_bundles: number[] | null;
    allowed_tools: string[] | null;
    denied_tools: string[] | null;
    scope: 'mcp' | 'agents' | 'both';
    enabled: boolean;
    key_hash: string | null;
    composite_id: number | null;
  }>(
    `SELECT id, key_prefix, key_suffix, label, allowed_bundles, allowed_tools,
       denied_tools, scope, enabled, key_hash, composite_id
     FROM mcp_api_keys WHERE id = $1 AND deleted_at IS NULL`,
    [Number(input.principalId)],
  );
  const key = result.rows[0];
  if (!key) return null;
  const principal = {
    kind: 'api_key' as const,
    id: input.principalId,
    label: key.label,
    secondary: `${key.key_prefix}${key.key_suffix ? `••••${key.key_suffix}` : ''} · ${key.scope}`,
    enabled: key.enabled,
  };
  const steps: PolicySimulationStep[] = [];
  if (!key.enabled) {
    steps.push({
      key: 'principal-enabled',
      label: 'Principal state',
      outcome: 'matched',
      detail: 'Disabled API keys cannot authenticate.',
      evidence: ['disabled'],
    });
    return {
      ...base, principal, decision: 'deny', rawDecision: 'deny',
      reason: 'API key is disabled', policyMode: true, steps, sources: [],
    };
  }
  steps.push({
    key: 'principal-enabled',
    label: 'Principal state',
    outcome: 'passed',
    detail: 'The API key is enabled.',
    evidence: ['enabled'],
  });
  const keyEntry: ApiKeyRbacEntry = {
    key_prefix: key.key_prefix,
    label: key.label,
    allowed_bundles: key.allowed_bundles,
    allowed_tools: key.allowed_tools,
    denied_tools: key.denied_tools,
    scope: key.scope,
    enabled: key.enabled,
    key_hash: key.key_hash,
  };
  const denied = matchingSimulatorPatterns(key.denied_tools, input.toolName);
  const allowed = matchingSimulatorPatterns(key.allowed_tools, input.toolName);
  const directAllowed = isToolAllowed(keyEntry, input.toolName);
  steps.push({
    key: 'api-key-tool-rules',
    label: 'API-key tool rules',
    outcome: directAllowed ? 'passed' : 'matched',
    detail: directAllowed
      ? 'The key-level allow/deny patterns permit this tool.'
      : denied.length > 0 ? 'A key-level deny pattern blocks this tool.' : 'No key-level allow pattern matched.',
    evidence: denied.length > 0 ? denied : allowed,
  });
  if (!directAllowed) {
    return {
      ...base, principal, decision: 'deny', rawDecision: 'deny',
      reason: denied.length > 0 ? 'denied by API-key tool rule' : 'not allowed by API-key tool rules',
      policyMode: true, steps, sources: [],
    };
  }
  if (key.allowed_bundles != null) {
    const scopedTools = await loadAllowedToolNames(pool, key.allowed_bundles, {
      includeUnscoped: false,
    });
    const inScope = scopedTools.has(input.toolName);
    steps.push({
      key: 'api-key-bundle-scope',
      label: 'API-key bundle scope',
      outcome: inScope ? 'passed' : 'matched',
      detail: inScope ? 'The tool belongs to an allowed bundle.' : 'The tool is outside the API key bundle scope.',
      evidence: key.allowed_bundles.map(String),
    });
    if (!inScope) {
      return {
        ...base, principal, decision: 'deny', rawDecision: 'deny',
        reason: 'tool is outside the API-key bundle scope', policyMode: true, steps, sources: [],
      };
    }
  }
  if (key.composite_id != null) {
    const composite = await loadSimulatorComposite(pool, key.composite_id);
    if (!composite) return null;
    const evaluated = await evaluateCompositeForSimulation(pool, composite, input.toolName, { enforceEnabled: true });
    return {
      ...base,
      principal,
      decision: evaluated.decision,
      rawDecision: evaluated.decision,
      reason: evaluated.reason,
      policyMode: true,
      steps: [...steps, ...evaluated.steps],
      sources: [composite.name],
    };
  }
  steps.push({
    key: 'api-key-composite',
    label: 'Composite policy',
    outcome: 'passed',
    detail: 'No additional composite is assigned to this API key.',
    evidence: [],
  });
  return {
    ...base, principal, decision: 'allow', rawDecision: 'allow',
    reason: 'allowed by API-key policy', policyMode: key.allowed_bundles != null || key.allowed_tools != null || key.denied_tools != null,
    steps, sources: [],
  };
}

async function bundleDetailPayload(
  dependencies: ConsoleApiDependencies,
  bundleId: number,
  user: SessionUser,
) {
  const canInspectAccess = hasRole(user.role, 'platform_admin');
  const [bundle, bundleBackends, directTools, rawStatus, access, accessCandidates] = await Promise.all([
    getBundle(dependencies.pool, bundleId),
    getBundleBackends(dependencies.pool, bundleId),
    getBundleTools(dependencies.pool, bundleId),
    dependencies.loadStatus(),
    canInspectAccess ? loadBundleAccess(dependencies.pool, bundleId) : Promise.resolve([]),
    canInspectAccess ? loadBundleAccessCandidates(dependencies.pool, bundleId) : Promise.resolve([]),
  ]);
  if (!bundle) return null;

  const statusBackend = (id: number, name: string) =>
    rawStatus.backends.find(item => item.customId === id || item.name === name);
  const connections = bundleBackends.map(backend => {
    const current = statusBackend(backend.id, backend.name);
    return {
      id: String(backend.id),
      name: backend.name,
      description: backend.description,
      type: backend.backend_type === 'mcp' ? 'mcp' as const : 'http' as const,
      state: current ? serverState(current) : backend.enabled ? 'offline' as const : 'not_configured' as const,
      endpoint: safeEndpoint({ url: backend.base_url, endpoint: backend.mcp_endpoint ?? '' }),
      enabled: backend.enabled,
      toolCount: backend.remote_tools.length + backend.dynamic_tools.length,
      toolAccessMode: backend.tool_policy.mode,
      allowedToolCount: backend.tool_policy.mode === 'selected'
        ? backend.tool_policy.allowed_tool_names.length
        : backend.remote_tools.length + backend.dynamic_tools.length,
    };
  });

  const tools = new Map<string, {
    id: string;
    backendId: number | null;
    name: string;
    server: string;
    description: string;
    enabled: boolean;
    membership: 'direct' | 'connection' | 'direct_and_connection';
  }>();
  for (const tool of directTools) {
    const owningBackend = bundleBackends.find(backend =>
      tool.backend === backend.name || tool.backend === `custom:${backend.name}`,
    );
    tools.set(`dynamic-${tool.id}`, {
      id: `dynamic-${tool.id}`,
      backendId: owningBackend?.id ?? null,
      name: tool.name,
      server: tool.backend,
      description: tool.description,
      enabled: tool.enabled,
      membership: 'direct',
    });
  }
  for (const backend of bundleBackends) {
    for (const tool of backend.remote_tools) {
      tools.set(`remote-${tool.id}`, {
        id: `remote-${tool.id}`,
        backendId: backend.id,
        name: tool.prefixed_name || tool.tool_name,
        server: backend.name,
        description: tool.description,
        enabled: backend.enabled,
        membership: 'connection',
      });
    }
    for (const tool of backend.dynamic_tools) {
      const id = `dynamic-${tool.id}`;
      const existing = tools.get(id);
      tools.set(id, {
        id,
        backendId: backend.id,
        name: tool.name,
        server: backend.name,
        description: tool.description,
        enabled: tool.enabled && backend.enabled,
        membership: existing ? 'direct_and_connection' : 'connection',
      });
    }
  }

  const principals = access.map(principal => ({
    ...principal,
    enabled: Boolean(principal.enabled),
  }));

  return {
    generatedAt: new Date().toISOString(),
    permissions: {
      canManage: hasRole(user.role, 'platform_admin'),
      canInspectAccess,
    },
    bundle: {
      id: bundle.id,
      name: bundle.name,
      label: bundle.label,
      description: bundle.description,
      icon: bundle.icon,
      agentRole: bundle.agent_role,
      endpoint: `/mcp/group/${bundle.name}`,
    },
    stats: {
      connections: connections.length,
      tools: tools.size,
      identities: principals.filter(item => ['user', 'api_key', 'agent', 'group'].includes(item.kind)).length,
      workflows: principals.filter(item => item.kind === 'workflow').length,
    },
    access: {
      redacted: !canInspectAccess,
      principals,
      candidates: accessCandidates,
      note: 'Connection tool policies are reflected in this graph. User, agent, API-key and composite rules are evaluated afterward and can further reduce final access.',
    },
    connections,
    tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function overviewPayload(
  dependencies: ConsoleApiDependencies,
  user: SessionUser,
  selectedScope: AuthorizedWorkspaceScope,
) {
  const [workflowRuns, workflowStats, workflowsInReview, agents, rawStatus, storedAgentTraces, storedWorkflowTraces] = await Promise.all([
    loadWorkflowRuns(dependencies.pool, user, selectedScope, 12),
    loadWorkflowStats(dependencies.pool, user, selectedScope),
    loadReviewCount(dependencies.pool, user, selectedScope),
    loadAgentCount(dependencies.pool),
    dependencies.loadStatus(),
    listTelemetryTraces(dependencies.pool, {
      ...telemetryAccess(user, selectedScope),
      kind: 'agent',
      limit: 25,
      hours: 24 * 7,
    }),
    listTelemetryTraces(dependencies.pool, {
      ...telemetryAccess(user, selectedScope),
      kind: 'workflow',
      limit: 25,
      hours: 24 * 7,
    }),
  ]);
  const status = visibleStatus(rawStatus, user);
  const activeSessions = dependencies.listActiveSessions()
    .filter(session => activeSessionMatchesScope(session, selectedScope));
  const activeSessionIds = new Set(activeSessions.map(session => session.sessionId));
  const agentRuns = [
    ...activeSessions.map(mapAgentRun),
    ...storedAgentTraces
      .filter(trace => !trace.session_id || !activeSessionIds.has(trace.session_id))
      .map(mapTelemetryRun),
  ];
  const argusDevRuns = storedWorkflowTraces
    .filter(trace => trace.metadata?.['runtime'] === 'argus-langgraph' && typeof trace.metadata?.['a2a_task_id'] === 'string')
    .map(mapTelemetryRun);
  const runs = [...argusDevRuns, ...agentRuns, ...workflowRuns.map(mapWorkflowRun)]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const activeWorkflowRuns = numberValue(workflowStats.active);
  const completed24h = numberValue(workflowStats.completed_24h);
  const failed24h = numberValue(workflowStats.failed_24h);
  const terminal24h = completed24h + failed24h;
  const connectedTools = status.dynamicTools.length + status.remoteTools.length;
  const health = healthFromStatus(status);
  const attention = [];

  for (const run of runs.filter(item => item.status === 'failed').slice(0, 2)) {
    attention.push({
      id: `failure-${run.kind}-${run.id}`,
      kind: 'failure' as const,
      title: `${run.title} failed`,
      detail: run.error || `${run.kind === 'agent' ? 'Agent' : 'Workflow'} execution requires review.`,
      href: run.href || '/runs',
      severity: 'critical' as const,
    });
  }
  if (workflowsInReview > 0) {
    attention.push({
      id: 'workflow-reviews',
      kind: 'approval' as const,
      title: `${workflowsInReview} workflow${workflowsInReview === 1 ? '' : 's'} awaiting review`,
      detail: 'Review lifecycle decisions before production promotion.',
      href: '/governance',
      severity: 'warning' as const,
    });
  }
  for (const backend of status.backends.filter(item => item.enabled && item.reachable === false).slice(0, 2)) {
    attention.push({
      id: `health-${backend.customId ?? backend.name}`,
      kind: 'health' as const,
      title: `${backend.name} is unavailable`,
      detail: backend.error || 'The latest connection check did not succeed.',
      href: '/mcp-fabric',
      severity: 'warning' as const,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    },
    attention,
    stats: {
      activeRuns: activeWorkflowRuns
        + agentRuns.filter(run => run.status === 'running').length
        + argusDevRuns.filter(run => run.status === 'running' || run.status === 'waiting').length,
      successRate24h: terminal24h === 0 ? null : Math.round((completed24h / terminal24h) * 100),
      completed24h,
      failed24h,
      workflowsInReview,
      connectedTools,
      agents,
    },
    health,
    runs: runs.slice(0, 12),
  };
}

export function registerConsoleApi(app: Express, dependencies: ConsoleApiDependencies): void {
  const configuredFabricMutationLimit = Number.parseInt(
    process.env['FABRIC_MUTATION_RATE_LIMIT_PER_MINUTE'] ?? '30',
    10,
  );
  const fabricMutationLimiter = new RateLimiter(
    Number.isSafeInteger(configuredFabricMutationLimit) && configuredFabricMutationLimit > 0
      ? configuredFabricMutationLimit
      : 30,
  );
  const canaryRunLimiter = new RateLimiter(3);
  const serviceCatalogRefreshLimiter = new RateLimiter(3);
  const runtimeAuthLimiter = new RateLimiter(8);
  setInterval(() => {
    fabricMutationLimiter.cleanup();
    canaryRunLimiter.cleanup();
    serviceCatalogRefreshLimiter.cleanup();
    runtimeAuthLimiter.cleanup();
  }, 300_000).unref();
  const fabricMutationRateLimit: RequestHandler = (req, res, next) => {
    const userId = (req as AuthenticatedRequest).user?.id;
    fabricMutationLimiter.isAllowed(`fabric:${userId ?? req.ip ?? 'unknown'}`)
      .then(allowed => {
        if (!allowed) {
          res.status(429).json({ error: 'Zu viele Änderungen – bitte kurz warten' });
          return;
        }
        next();
      })
      .catch(next);
  };
  const canaryRunRateLimit: RequestHandler = (req, res, next) => {
    const userId = (req as AuthenticatedRequest).user?.id;
    canaryRunLimiter.isAllowed(`canary-run:${userId ?? req.ip ?? 'unknown'}`)
      .then(allowed => {
        if (!allowed) {
          res.status(429).json({ error: 'Zu viele Canary-Runs – bitte kurz warten' });
          return;
        }
        next();
      })
      .catch(next);
  };
  const serviceCatalogRefreshRateLimit: RequestHandler = (req, res, next) => {
    const userId = (req as AuthenticatedRequest).user?.id;
    serviceCatalogRefreshLimiter.isAllowed(`service-catalog:${userId ?? req.ip ?? 'unknown'}`)
      .then(allowed => {
        if (!allowed) {
          res.status(429).json({ error: 'Zu viele Service-Discovery-Läufe – bitte kurz warten' });
          return;
        }
        next();
      })
      .catch(next);
  };
  const runtimeAuthRateLimit: RequestHandler = (req, res, next) => {
    const userId = (req as AuthenticatedRequest).user?.id;
    runtimeAuthLimiter.isAllowed(`runtime-auth:${userId ?? req.ip ?? 'unknown'}`)
      .then(allowed => {
        if (!allowed) {
          res.status(429).json({ error: 'Too many runtime authentication requests. Please wait briefly.' });
          return;
        }
        next();
      })
      .catch(next);
  };

  app.get('/api/ui/runtime/codex', dependencies.requireAuth, async (req, res) => {
    const user = requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Codex-Runtime-Sessions einsehen');
    if (!user) return;
    if (!dependencies.loadCodexRuntimeStatus) {
      res.status(503).json({ error: 'Codex runtime status is not configured' });
      return;
    }
    try {
      res.json(await dependencies.loadCodexRuntimeStatus());
    } catch (error) {
      logger.warn({ err: error }, 'Codex runtime status unavailable');
      res.status(503).json({ error: error instanceof Error ? error.message : 'Codex runtime status unavailable' });
    }
  });

  app.post('/api/ui/runtime/codex/runs/:runId/cancel', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    const user = requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Codex-Runtime-Sessions beenden');
    if (!user) return;
    if (!dependencies.cancelCodexRuntimeRun) {
      res.status(503).json({ error: 'Codex runtime cancellation is not configured' });
      return;
    }
    const runId = String(req.params['runId'] ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(runId)) {
      res.status(400).json({ error: 'Invalid Codex runtime run id' });
      return;
    }
    try {
      res.json(await dependencies.cancelCodexRuntimeRun(runId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Codex runtime cancellation failed';
      logger.warn({ err: error, runId }, 'Codex runtime cancellation failed');
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/ui/runtime/claude', dependencies.requireAuth, async (req, res) => {
    const user = requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Claude-Code-Runtime-Sessions einsehen');
    if (!user) return;
    if (!dependencies.loadClaudeRuntimeStatus) {
      res.status(503).json({ error: 'Claude Code runtime status is not configured' });
      return;
    }
    try {
      res.json(await dependencies.loadClaudeRuntimeStatus());
    } catch (error) {
      logger.warn({ err: error }, 'Claude Code runtime status unavailable');
      res.status(503).json({ error: error instanceof Error ? error.message : 'Claude Code runtime status unavailable' });
    }
  });

  app.post('/api/ui/runtime/claude/runs/:runId/cancel', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    const user = requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Claude-Code-Runtime-Sessions beenden');
    if (!user) return;
    if (!dependencies.cancelClaudeRuntimeRun) {
      res.status(503).json({ error: 'Claude Code runtime cancellation is not configured' });
      return;
    }
    const runId = String(req.params['runId'] ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(runId)) {
      res.status(400).json({ error: 'Invalid Claude Code runtime run id' });
      return;
    }
    try {
      res.json(await dependencies.cancelClaudeRuntimeRun(runId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Claude Code runtime cancellation failed';
      logger.warn({ err: error, runId }, 'Claude Code runtime cancellation failed');
      res.status(502).json({ error: message });
    }
  });

  const runtimeAuthProvider = (value: string): 'codex' | 'claude-code' | null =>
    value === 'codex' || value === 'claude-code' ? value : null;
  const runtimeAuthSessionId = (value: string): string | null =>
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value) ? value : null;
  const runtimeAuthError = (res: Response, error: unknown, fallback: string): void => {
    const statusCode = Number((error as { statusCode?: unknown })?.statusCode);
    const safeStatus = statusCode === 400 || statusCode === 404 || statusCode === 409 || statusCode === 429
      ? statusCode
      : 502;
    logger.warn({ err: error }, fallback);
    res.status(safeStatus).json({ error: error instanceof Error ? error.message : fallback });
  };

  app.post('/api/ui/runtime/:provider/auth/sessions', dependencies.requireAuth, dependencies.requireSameOrigin, runtimeAuthRateLimit, async (req, res) => {
    const user = requirePlatformAdmin(req, res, 'Only platform administrators can connect shared Agent runtimes');
    if (!user) return;
    const provider = runtimeAuthProvider(String(req.params['provider'] ?? ''));
    if (!provider) { res.status(404).json({ error: 'Unsupported runtime provider' }); return; }
    if (!dependencies.startRuntimeAuthSession) { res.status(503).json({ error: 'Runtime authentication is not configured' }); return; }
    try {
      const session = await dependencies.startRuntimeAuthSession(provider, { sso: req.body?.sso === true });
      const sessionId = typeof session['id'] === 'string' ? session['id'] : provider;
      writeAdminAudit(dependencies.pool, req, 'authentication_started', 'agent_runtime_profiles', provider, provider, null, {
        sessionId,
        provider,
        sso: provider === 'claude-code' && req.body?.sso === true,
      });
      res.status(201).json(session);
    } catch (error) {
      runtimeAuthError(res, error, 'Runtime authentication could not start');
    }
  });

  app.get('/api/ui/runtime/:provider/auth/sessions/:sessionId', dependencies.requireAuth, async (req, res) => {
    const user = requirePlatformAdmin(req, res, 'Only platform administrators can inspect shared runtime authentication');
    if (!user) return;
    const provider = runtimeAuthProvider(String(req.params['provider'] ?? ''));
    const sessionId = runtimeAuthSessionId(String(req.params['sessionId'] ?? ''));
    if (!provider || !sessionId) { res.status(404).json({ error: 'Runtime authentication session not found' }); return; }
    if (!dependencies.loadRuntimeAuthSession) { res.status(503).json({ error: 'Runtime authentication is not configured' }); return; }
    try {
      res.json(await dependencies.loadRuntimeAuthSession(provider, sessionId));
    } catch (error) {
      runtimeAuthError(res, error, 'Runtime authentication status unavailable');
    }
  });

  app.post('/api/ui/runtime/:provider/auth/sessions/:sessionId/code', dependencies.requireAuth, dependencies.requireSameOrigin, runtimeAuthRateLimit, async (req, res) => {
    const user = requirePlatformAdmin(req, res, 'Only platform administrators can complete shared runtime authentication');
    if (!user) return;
    const provider = runtimeAuthProvider(String(req.params['provider'] ?? ''));
    const sessionId = runtimeAuthSessionId(String(req.params['sessionId'] ?? ''));
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!provider || !sessionId) { res.status(404).json({ error: 'Runtime authentication session not found' }); return; }
    if (!code.trim() || code.length > 4096 || /[\u0000-\u001F\u007F]/.test(code)) {
      res.status(400).json({ error: 'Authentication code is invalid' });
      return;
    }
    if (!dependencies.submitRuntimeAuthCode) { res.status(503).json({ error: 'Runtime authentication is not configured' }); return; }
    try {
      const session = await dependencies.submitRuntimeAuthCode(provider, sessionId, code);
      // Never include the submitted OAuth code in logs or audit state.
      writeAdminAudit(dependencies.pool, req, 'authentication_code_submitted', 'agent_runtime_profiles', provider, provider, null, { sessionId, provider });
      res.status(202).json(session);
    } catch (error) {
      runtimeAuthError(res, error, 'Runtime authentication code could not be submitted');
    }
  });

  app.delete('/api/ui/runtime/:provider/auth/sessions/:sessionId', dependencies.requireAuth, dependencies.requireSameOrigin, runtimeAuthRateLimit, async (req, res) => {
    const user = requirePlatformAdmin(req, res, 'Only platform administrators can cancel shared runtime authentication');
    if (!user) return;
    const provider = runtimeAuthProvider(String(req.params['provider'] ?? ''));
    const sessionId = runtimeAuthSessionId(String(req.params['sessionId'] ?? ''));
    if (!provider || !sessionId) { res.status(404).json({ error: 'Runtime authentication session not found' }); return; }
    if (!dependencies.cancelRuntimeAuthSession) { res.status(503).json({ error: 'Runtime authentication is not configured' }); return; }
    try {
      const session = await dependencies.cancelRuntimeAuthSession(provider, sessionId);
      writeAdminAudit(dependencies.pool, req, 'authentication_canceled', 'agent_runtime_profiles', provider, provider, null, { sessionId, provider });
      res.json(session);
    } catch (error) {
      runtimeAuthError(res, error, 'Runtime authentication could not be canceled');
    }
  });

  const requirePlatformAdmin = (
    req: Request,
    res: Response,
    forbiddenMessage: string,
  ): SessionUser | null => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Nicht authentifiziert' });
      return null;
    }
    if (!hasRole(user.role, 'platform_admin')) {
      res.status(403).json({ error: forbiddenMessage });
      return null;
    }
    return user;
  };
  const requireCertificationAutomationKey = (req: Request, res: Response): string | null => {
    const state = req as unknown as Record<string, unknown>;
    const apiKeyPrefix = typeof state['apiKeyPrefix'] === 'string' ? state['apiKeyPrefix'] : '';
    const apiKeyScope = typeof state['apiKeyScope'] === 'string' ? state['apiKeyScope'] : '';
    const allowedTools = Array.isArray(state['allowedTools'])
      ? state['allowedTools'].filter((value): value is string => typeof value === 'string')
      : null;
    const deniedTools = Array.isArray(state['deniedTools'])
      ? state['deniedTools'].filter((value): value is string => typeof value === 'string')
      : null;
    if (!apiKeyPrefix) {
      res.status(401).json({ error: 'A scoped Argus API key is required' });
      return null;
    }
    const capability = 'system.kubernetes-certification.import';
    if (apiKeyScope === 'mcp'
      || !allowedTools
      || allowedTools.length === 0
      || !allowedTools.includes(capability)
      || !isToolAllowedByPatterns({ allowedTools, deniedTools }, capability)) {
      res.status(403).json({ error: `API key must explicitly allow ${capability}` });
      return null;
    }
    return apiKeyPrefix;
  };
  const requirePolicyAdmin = (req: Request, res: Response): SessionUser | null =>
    requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Access Policies verwalten');
  const requireLlmAdmin = (req: Request, res: Response): SessionUser | null =>
    requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können AI Provider und Modelle verwalten');
  const requireRuntimeAdmin = (req: Request, res: Response): SessionUser | null =>
    requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Runtime Controls verwalten');
  const requireComplianceAdmin = (req: Request, res: Response): SessionUser | null =>
    requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Compliance Assessments verwalten');
  const requireSkillAdmin = (req: Request, res: Response): SessionUser | null =>
    requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Skill Analytics einsehen');
  const numericId = (value: unknown): number | null => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const llmMutationError = (res: Response, error: unknown, fallback: string): void => {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : fallback;
    const expected = /(?:ungültig|erforderlich|zu lang|darf nur|muss |nicht gefunden|kann nicht|existiert bereits|Credentials)/i.test(message);
    const ssrfExpected = /URL nicht erlaubt|interne\/private|could not be resolved safely/i.test(message);
    const status = code === '23505' || code === '23503' || /kann nicht|existiert bereits/i.test(message)
      ? 409
      : expected || ssrfExpected ? 400 : 500;
    if (status === 500) logger.error({ err: error }, fallback);
    res.status(status).json({ error: status === 500 ? fallback : message });
  };
  const runtimePolicyError = (res: Response, error: unknown, fallback: string): void => {
    if (error instanceof ToolFilterMutationError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : fallback;
    if (code === '23505' || /duplicate|unique/i.test(message)) {
      res.status(409).json({ error: 'A runtime policy with this name already exists' });
      return;
    }
    const expected = /(?:required|must |may contain|too long|at most|unsupported|immutable|URL nicht erlaubt|gesperrt|allow or deny)/i.test(message);
    if (!expected) logger.error({ err: error }, fallback);
    res.status(expected ? 400 : 500).json({ error: expected ? message : fallback });
  };

  app.get('/api/ui/llm/catalog', dependencies.requireAuth, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    try {
      res.json(await listLlmCatalog(dependencies.pool));
    } catch (error) {
      logger.error({ err: error }, 'Failed to load LLM catalog');
      res.status(500).json({ error: 'AI Provider und Modelle konnten nicht geladen werden' });
    }
  });

  /**
   * Home onboarding deliberately exposes only safe catalog metadata. The
   * existing admin catalog contains credential/profile details and remains
   * restricted to platform administrators.
   */
  app.get('/api/ui/onboarding/catalog', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }
      const [catalog, visibleAgents, starterAgents, bundles, starterInstallations] = await Promise.all([
        listLlmOnboardingCatalog(dependencies.pool, user),
        listChatVisibleAgents(dependencies.pool, user),
        listAgentTemplates(dependencies.pool),
        user.allowed_bundles == null
          ? dependencies.pool.query<{
            id: number;
            name: string;
            label: string;
            description: string;
          }>('SELECT id, name, label, description FROM mcp_service_bundles ORDER BY label')
          : dependencies.pool.query<{
            id: number;
            name: string;
            label: string;
            description: string;
          }>(
            'SELECT id, name, label, description FROM mcp_service_bundles WHERE id=ANY($1::int[]) ORDER BY label',
            [user.allowed_bundles],
          ),
        dependencies.pool.query<{
          template_name: string;
          id: number;
          name: string;
          label: string;
          description: string | null;
          model: string;
        }>(
          `SELECT installation.template_name,
                  agent.id,
                  agent.name,
                  agent.label,
                  agent.description,
                  agent.model
             FROM mcp_agent_template_installations installation
             JOIN mcp_agents agent ON agent.id=installation.agent_id
            ORDER BY installation.template_name, agent.id`,
        ),
      ]);
      const installedAgentsByTemplate = new Map<string, Array<{
        id: number;
        name: string;
        label: string;
        description: string;
        model: string;
      }>>();
      const visibleAgentIds = new Set(visibleAgents.map(agent => Number(agent.id)));
      for (const installation of starterInstallations.rows) {
        if (!visibleAgentIds.has(Number(installation.id))) continue;
        const installedAgents = installedAgentsByTemplate.get(installation.template_name) ?? [];
        installedAgents.push({
          id: Number(installation.id),
          name: installation.name,
          label: installation.label,
          description: installation.description ?? '',
          model: installation.model,
        });
        installedAgentsByTemplate.set(installation.template_name, installedAgents);
      }
      res.json({
        generatedAt: new Date().toISOString(),
        providers: catalog.providers,
        models: catalog.models,
        agents: visibleAgents.map(agent => ({
          id: agent.id,
          name: agent.name,
          label: agent.label,
          description: agent.description,
          model: agent.model,
        })),
        starterAgents: starterAgents.map(template => {
          const installedAgents = installedAgentsByTemplate.get(template.name) ?? [];
          return {
            id: template.id,
            name: template.name,
            label: template.label,
            description: template.description,
            category: template.category,
            agentMode: template.agentMode,
            recommendedCapabilities: template.recommendedCapabilities,
            requiredToolPatterns: template.requiredToolPatterns,
            minimumBundleCount: template.minimumBundleCount,
            compatibleBundleIds: user.allowed_bundles == null
              ? template.compatibleBundleIds
              : template.compatibleBundleIds.filter(bundleId => user.allowed_bundles!.includes(bundleId)),
            installed: template.installed || installedAgents.length > 0,
            installedAgentId: template.installedAgentId ?? installedAgents[0]?.id ?? null,
            installedAgents,
            version: template.version,
          };
        }),
        bundles: bundles.rows.map(bundle => ({
          id: Number(bundle.id),
          name: bundle.name,
          label: bundle.label,
          description: bundle.description,
        })),
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to load onboarding catalog');
      res.status(500).json({ error: 'The onboarding catalog could not be loaded' });
    }
  });

  app.post('/api/ui/onboarding/providers', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const input = normalizeLlmProviderInput(req.body);
      const isPlatformAdmin = hasRole(user.role, 'platform_admin');
      assertOnboardingProviderCredentials(isPlatformAdmin, input.secretName, input.credentialProfileId);
      if (!isPlatformAdmin) await assertOnboardingProviderUrlSafe(input.baseUrl);
      const provider = await createLlmProvider(
        dependencies.pool,
        input,
        user.id,
      );
      res.status(201).json({
        id: provider.id,
        name: provider.name,
        label: provider.label,
        providerType: provider.providerType,
        baseUrl: provider.baseUrl,
        authType: provider.authType,
        enabled: provider.enabled,
        credentialConfigured: provider.credentialConfigured,
        lastTestStatus: provider.lastTestStatus,
        modelCount: provider.modelCount,
        canTest: true,
      });
    } catch (error) {
      if (error instanceof OnboardingPolicyError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      llmMutationError(res, error, 'AI provider could not be created');
    }
  });

  app.post('/api/ui/onboarding/providers/:id/test', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const id = numericId(req.params['id']);
    if (!id) {
      res.status(400).json({ error: 'Provider ID is invalid' });
      return;
    }
    try {
      const providerResult = await dependencies.pool.query<{
        id: number;
        enabled: boolean;
        base_url: string;
        secret_name: string | null;
        credential_profile_id: number | null;
        created_by: number | null;
        created_by_role: string | null;
      }>(
        `SELECT provider.id, provider.enabled, provider.base_url, provider.secret_name,
                provider.credential_profile_id, provider.created_by,
                creator.role AS created_by_role
           FROM mcp_llm_providers provider
           LEFT JOIN mcp_users creator ON creator.id=provider.created_by
          WHERE provider.id=$1`,
        [id],
      );
      if (!providerResult.rows[0]) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }
      if (!providerResult.rows[0].enabled) {
        res.status(409).json({ error: 'The selected provider is disabled' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        const provider = providerResult.rows[0];
        if (!canUseOnboardingProvider(user.id, user.role, provider.created_by, provider.created_by_role)) {
          res.status(403).json({ error: 'This provider is not available to your account' });
          return;
        }
        // A provider created by a normal user must never be able to resolve a
        // server-side environment/Vault reference, including records created
        // before this guard was added.
        if (!isSharedOnboardingProvider(provider.created_by, provider.created_by_role)
          && provider.created_by === user.id
          && (provider.secret_name || provider.credential_profile_id != null)) {
          res.status(403).json({
            error: 'Providers using environment/Vault secrets or credential profiles can only be tested by platform administrators',
          });
          return;
        }
        if (!isSharedOnboardingProvider(provider.created_by, provider.created_by_role)) {
          await assertOnboardingProviderUrlSafe(provider.base_url);
        }
      }
      const result = await testLlmProvider(dependencies.pool, id);
      if (!result) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }
      res.json(result);
    } catch (error) {
      if (error instanceof OnboardingPolicyError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      llmMutationError(res, error, 'The provider connection could not be tested');
    }
  });

  app.post('/api/ui/onboarding/models', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const input = normalizeLlmModelInput(req.body);
      const providerResult = await dependencies.pool.query<{
        base_url: string;
        secret_name: string | null;
        credential_profile_id: number | null;
        created_by: number | null;
        created_by_role: string | null;
      }>(
        `SELECT provider.base_url, provider.secret_name, provider.credential_profile_id,
                provider.created_by, creator.role AS created_by_role
           FROM mcp_llm_providers provider
           LEFT JOIN mcp_users creator ON creator.id=provider.created_by
          WHERE provider.id=$1`,
        [input.providerId],
      );
      const provider = providerResult.rows[0];
      if (!provider) throw new OnboardingPolicyError('Provider not found', 400);
      if (!canUseOnboardingProvider(user.id, user.role, provider.created_by, provider.created_by_role)) {
        throw new OnboardingPolicyError('This provider is not available to your account', 403);
      }
      if (!hasRole(user.role, 'platform_admin') && !isSharedOnboardingProvider(provider.created_by, provider.created_by_role)) {
        if (provider.secret_name || provider.credential_profile_id != null) {
          throw new OnboardingPolicyError('Providers using environment/Vault secrets or credential profiles can only be used by platform administrators', 403);
        }
        await assertOnboardingProviderUrlSafe(provider.base_url);
      }
      const model = await createLlmModel(dependencies.pool, input);
      res.status(201).json(model);
    } catch (error) {
      if (error instanceof OnboardingPolicyError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      llmMutationError(res, error, 'The model could not be created');
    }
  });

  app.post('/api/ui/onboarding/agents', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const body = req.body != null && typeof req.body === 'object'
        ? req.body as Record<string, unknown>
        : {};
      const name = typeof body['name'] === 'string' ? body['name'].trim().toLowerCase() : '';
      const label = typeof body['label'] === 'string' ? body['label'].trim() : '';
      const description = typeof body['description'] === 'string' ? body['description'].trim() : '';
      const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
      const systemPrompt = typeof body['system_prompt'] === 'string' ? body['system_prompt'].trim() : '';
      if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        res.status(400).json({ error: 'Name may only contain lowercase letters, numbers, _ and -' });
        return;
      }
      if (!label || label.length > 160) {
        res.status(400).json({ error: 'Display name is required and may contain at most 160 characters' });
        return;
      }
      if (!model || model.length > 128) {
        res.status(400).json({ error: 'A valid model must be selected' });
        return;
      }
      const modelCheck = await dependencies.pool.query<{
        model_name: string;
        base_url: string;
        secret_name: string | null;
        credential_profile_id: number | null;
        created_by: number | null;
        created_by_role: string | null;
      }>(
        `SELECT model.model_name, provider.base_url, provider.secret_name,
                provider.credential_profile_id, provider.created_by,
                creator.role AS created_by_role
           FROM mcp_models model
           JOIN mcp_llm_providers provider ON provider.id=model.provider_id
           LEFT JOIN mcp_users creator ON creator.id=provider.created_by
          WHERE model.model_name=$1 AND model.enabled=true AND provider.enabled=true`,
        [model],
      );
      if (!modelCheck.rows[0]) {
        res.status(400).json({ error: 'The selected model is not available' });
        return;
      }
      const selectedProvider = modelCheck.rows[0];
      if (!canUseOnboardingProvider(user.id, user.role, selectedProvider.created_by, selectedProvider.created_by_role)) {
        res.status(400).json({ error: 'The selected model is not available' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin') && !isSharedOnboardingProvider(selectedProvider.created_by, selectedProvider.created_by_role)) {
        if (selectedProvider.secret_name || selectedProvider.credential_profile_id != null) {
          res.status(403).json({ error: 'Providers using environment/Vault secrets or credential profiles can only be used by platform administrators' });
          return;
        }
        await assertOnboardingProviderUrlSafe(selectedProvider.base_url);
      }
      const bundleIds = scopeOnboardingBundleIds(user.allowed_bundles, body['bundleIds']);
      const agent = await createAgent(dependencies.pool, {
        name,
        label,
        description,
        model,
        ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
        agent_mode: 'chat',
        enabled: true,
        visibility: 'internal',
        min_role: null,
        bundle_ids: bundleIds,
      }, user.id);
      res.status(201).json({
        id: agent.id,
        name: agent.name,
        label: agent.label,
        description: agent.description,
        model: agent.model,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : 'The agent could not be created';
      res.status(code === '23505' ? 409 : 500).json({
        error: code === '23505' ? 'An agent with this name already exists' : message,
      });
    }
  });

  app.post('/api/ui/onboarding/starter-agents/:name/install', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const name = String(req.params['name'] ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      res.status(400).json({ error: 'Starter agent ID is invalid' });
      return;
    }
    try {
      const body = req.body != null && typeof req.body === 'object'
        ? req.body as Record<string, unknown>
        : {};
      const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
      const bundleIds = scopeOnboardingBundleIds(user.allowed_bundles, body['bundleIds']);
      if (!model) {
        res.status(400).json({ error: 'A model must be selected' });
        return;
      }
      const modelProvider = await dependencies.pool.query<{
        base_url: string;
        secret_name: string | null;
        credential_profile_id: number | null;
        created_by: number | null;
        created_by_role: string | null;
      }>(
        `SELECT provider.base_url, provider.secret_name, provider.credential_profile_id,
                provider.created_by, creator.role AS created_by_role
           FROM mcp_models model
           JOIN mcp_llm_providers provider ON provider.id=model.provider_id
           LEFT JOIN mcp_users creator ON creator.id=provider.created_by
          WHERE model.model_name=$1 AND model.enabled=true AND provider.enabled=true`,
        [model],
      );
      const provider = modelProvider.rows[0];
      if (!provider || !canUseOnboardingProvider(user.id, user.role, provider.created_by, provider.created_by_role)) {
        res.status(400).json({ error: 'The selected model is not available' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin') && !isSharedOnboardingProvider(provider.created_by, provider.created_by_role)) {
        if (provider.secret_name || provider.credential_profile_id != null) {
          res.status(403).json({ error: 'Providers using environment/Vault secrets or credential profiles can only be used by platform administrators' });
          return;
        }
        await assertOnboardingProviderUrlSafe(provider.base_url);
      }
      const visibleAgents = await listChatVisibleAgents(dependencies.pool, user);
      const agent = await installAgentTemplate(dependencies.pool, name, { model, bundleIds: bundleIds ?? [] }, user.id, {
        allowMultiple: true,
        allowedAgentModes: ['chat'],
        visibleAgentIds: visibleAgents.map(visibleAgent => Number(visibleAgent.id)),
        allowedBundleIds: user.allowed_bundles,
      });
      res.status(201).json({
        id: agent.id,
        name: agent.name,
        label: agent.label,
        description: agent.description,
        model: agent.model,
      });
    } catch (error) {
      if (error instanceof OnboardingPolicyError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof AgentTemplateInstallError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : 'The starter agent could not be installed';
      res.status(code === '23505' ? 409 : 500).json({
        error: code === '23505' ? 'This starter agent is already installed' : message,
      });
    }
  });

  app.get('/api/ui/llm/credential-profiles', dependencies.requireAuth, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    try {
      res.json(await listLlmCredentialProfiles(dependencies.pool));
    } catch (error) {
      logger.error({ err: error }, 'Failed to load LLM credential profiles');
      res.status(500).json({ error: 'Credential Profiles konnten nicht geladen werden' });
    }
  });

  app.post('/api/ui/llm/credential-profiles', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    const user = requireLlmAdmin(req, res);
    if (!user) return;
    try {
      const profile = await createLlmCredentialProfile(
        dependencies.pool,
        normalizeLlmCredentialProfileInput(req.body),
        user.id,
      );
      writeAdminAudit(dependencies.pool, req, 'created', 'mcp_llm_credential_profiles', String(profile.id), profile.label, null, profile);
      res.status(201).json(profile);
    } catch (error) {
      llmMutationError(res, error, 'Credential Profile konnte nicht erstellt werden');
    }
  });

  app.put('/api/ui/llm/credential-profiles/:id', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    const id = numericId(req.params['id']);
    if (!id) { res.status(400).json({ error: 'Credential-Profile-ID ist ungültig' }); return; }
    try {
      const before = (await listLlmCredentialProfiles(dependencies.pool)).find(item => item.id === id) ?? null;
      const profile = await updateLlmCredentialProfile(dependencies.pool, id, normalizeLlmCredentialProfileInput(req.body));
      if (!profile) { res.status(404).json({ error: 'Credential Profile nicht gefunden' }); return; }
      writeAdminAudit(dependencies.pool, req, 'updated', 'mcp_llm_credential_profiles', String(id), profile.label, before, profile);
      res.json(profile);
    } catch (error) {
      llmMutationError(res, error, 'Credential Profile konnte nicht aktualisiert werden');
    }
  });

  app.delete('/api/ui/llm/credential-profiles/:id', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    const id = numericId(req.params['id']);
    if (!id) { res.status(400).json({ error: 'Credential-Profile-ID ist ungültig' }); return; }
    try {
      const before = (await listLlmCredentialProfiles(dependencies.pool)).find(item => item.id === id) ?? null;
      const deleted = await deleteLlmCredentialProfile(dependencies.pool, id);
      if (!deleted) { res.status(404).json({ error: 'Credential Profile nicht gefunden' }); return; }
      writeAdminAudit(dependencies.pool, req, 'deleted', 'mcp_llm_credential_profiles', String(id), before?.label ?? null, before, null);
      res.json({ deleted: true });
    } catch (error) {
      llmMutationError(res, error, 'Credential Profile konnte nicht gelöscht werden');
    }
  });

  app.post('/api/ui/llm/providers', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    const user = requireLlmAdmin(req, res);
    if (!user) return;
    try {
      const input = normalizeLlmProviderInput(req.body);
      const provider = await createLlmProvider(dependencies.pool, input, user.id);
      writeAdminAudit(dependencies.pool, req, 'created', 'mcp_llm_providers', String(provider.id), provider.label, null, provider);
      res.status(201).json(provider);
    } catch (error) {
      llmMutationError(res, error, 'AI Provider konnte nicht erstellt werden');
    }
  });

  app.put('/api/ui/llm/providers/:id', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    const id = numericId(req.params['id']);
    if (!id) { res.status(400).json({ error: 'Provider-ID ist ungültig' }); return; }
    try {
      const before = (await listLlmCatalog(dependencies.pool)).providers.find(item => item.id === id) ?? null;
      const provider = await updateLlmProvider(dependencies.pool, id, normalizeLlmProviderInput(req.body));
      if (!provider) { res.status(404).json({ error: 'Provider nicht gefunden' }); return; }
      writeAdminAudit(dependencies.pool, req, 'updated', 'mcp_llm_providers', String(id), provider.label, before, provider);
      res.json(provider);
    } catch (error) {
      llmMutationError(res, error, 'AI Provider konnte nicht aktualisiert werden');
    }
  });

  app.delete('/api/ui/llm/providers/:id', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    const id = numericId(req.params['id']);
    if (!id) { res.status(400).json({ error: 'Provider-ID ist ungültig' }); return; }
    try {
      const before = (await listLlmCatalog(dependencies.pool)).providers.find(item => item.id === id) ?? null;
      const deleted = await deleteLlmProvider(dependencies.pool, id);
      if (!deleted) { res.status(404).json({ error: 'Provider nicht gefunden' }); return; }
      writeAdminAudit(dependencies.pool, req, 'deleted', 'mcp_llm_providers', String(id), before?.label ?? null, before, null);
      res.json({ deleted: true });
    } catch (error) {
      llmMutationError(res, error, 'AI Provider konnte nicht gelöscht werden');
    }
  });

  app.post('/api/ui/llm/providers/:id/test', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    const id = numericId(req.params['id']);
    if (!id) { res.status(400).json({ error: 'Provider-ID ist ungültig' }); return; }
    try {
      const result = await testLlmProvider(dependencies.pool, id);
      if (!result) { res.status(404).json({ error: 'Provider nicht gefunden' }); return; }
      writeAdminAudit(dependencies.pool, req, 'tested', 'mcp_llm_providers', String(id), 'Provider connection', null, {
        ok: result.ok,
        latencyMs: result.latencyMs,
        discoveredModels: result.models.length,
        error: result.error ?? null,
      });
      res.json(result);
    } catch (error) {
      llmMutationError(res, error, 'Provider-Verbindung konnte nicht getestet werden');
    }
  });

  app.post('/api/ui/llm/models', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    try {
      const model = await createLlmModel(dependencies.pool, normalizeLlmModelInput(req.body));
      writeAdminAudit(dependencies.pool, req, 'created', 'mcp_models', String(model.id), model.modelName, null, model);
      res.status(201).json(model);
    } catch (error) {
      llmMutationError(res, error, 'Modell konnte nicht erstellt werden');
    }
  });

  app.put('/api/ui/llm/models/:id', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    const id = numericId(req.params['id']);
    if (!id) { res.status(400).json({ error: 'Modell-ID ist ungültig' }); return; }
    try {
      const before = (await listLlmCatalog(dependencies.pool)).models.find(item => item.id === id) ?? null;
      const model = await updateLlmModel(dependencies.pool, id, normalizeLlmModelInput(req.body));
      if (!model) { res.status(404).json({ error: 'Modell nicht gefunden' }); return; }
      writeAdminAudit(dependencies.pool, req, 'updated', 'mcp_models', String(id), model.modelName, before, model);
      res.json(model);
    } catch (error) {
      llmMutationError(res, error, 'Modell konnte nicht aktualisiert werden');
    }
  });

  app.delete('/api/ui/llm/models/:id', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    if (!requireLlmAdmin(req, res)) return;
    const id = numericId(req.params['id']);
    if (!id) { res.status(400).json({ error: 'Modell-ID ist ungültig' }); return; }
    try {
      const before = (await listLlmCatalog(dependencies.pool)).models.find(item => item.id === id) ?? null;
      const deleted = await deleteLlmModel(dependencies.pool, id);
      if (!deleted) { res.status(404).json({ error: 'Modell nicht gefunden' }); return; }
      writeAdminAudit(dependencies.pool, req, 'deleted', 'mcp_models', String(id), before?.modelName ?? null, before, null);
      res.json({ deleted: true });
    } catch (error) {
      llmMutationError(res, error, 'Modell konnte nicht gelöscht werden');
    }
  });

  app.get('/api/ui/access-policies', dependencies.requireAuth, async (req, res) => {
    if (!requirePolicyAdmin(req, res)) return;
    try {
      res.json(await loadAccessPolicyManagement(dependencies.pool));
    } catch (error) {
      logger.error({ err: error }, 'Failed to load access policy management');
      res.status(500).json({ error: 'Access Policies konnten nicht geladen werden' });
    }
  });

  app.post(
    '/api/ui/access-policies/simulate',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      let input: ReturnType<typeof normalizePolicySimulationInput>;
      try {
        input = normalizePolicySimulationInput(req.body as PolicySimulationInput);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Simulationsdaten' });
        return;
      }
      try {
        const result = await simulateAccessPolicy(dependencies.pool, input);
        if (!result) {
          res.status(404).json({ error: 'Principal oder zugewiesene Policy nicht gefunden' });
          return;
        }
        res.json(result);
      } catch (error) {
        logger.error({ err: error, input }, 'Failed to simulate access policy');
        res.status(500).json({ error: 'Policy-Simulation konnte nicht ausgeführt werden' });
      }
    },
  );

  app.put(
    '/api/ui/access-policies/users',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const admin = requirePolicyAdmin(req, res);
      if (!admin) return;
      let input: ReturnType<typeof normalizeFabricUserPolicyMutation>;
      try {
        input = normalizeFabricUserPolicyMutation(req.body as FabricUserPolicyMutationInput);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Benutzer-Policy' });
        return;
      }
      const client = await dependencies.pool.connect();
      try {
        await client.query('BEGIN');
        const user = (await client.query<{ id: number; username: string }>(
          'SELECT id, username FROM mcp_users WHERE id = $1 FOR UPDATE',
          [input.userId],
        )).rows[0];
        if (!user) throw new Error('Benutzer nicht gefunden');

        if (input.compositeIds.length > 0) {
          const existing = await client.query<{ id: number }>(
            'SELECT id FROM mcp_composites WHERE id = ANY($1::int[]) FOR SHARE',
            [input.compositeIds],
          );
          if (existing.rows.length !== input.compositeIds.length) {
            throw new Error('Mindestens ein ausgewähltes Composite existiert nicht mehr');
          }
        }
        if (input.agentIds.length > 0) {
          const existing = await client.query<{ id: number }>(
            'SELECT id FROM mcp_agents WHERE id = ANY($1::int[]) FOR SHARE',
            [input.agentIds],
          );
          if (existing.rows.length !== input.agentIds.length) {
            throw new Error('Mindestens ein ausgewählter Agent existiert nicht mehr');
          }
        }

        const deniedAgentIds = (await client.query<{ agent_id: number }>(
          `SELECT agent_id FROM mcp_user_agent_rules
           WHERE user_id = $1 AND effect = 'deny'
             AND (expires_at IS NULL OR expires_at > now())`,
          [input.userId],
        )).rows.map(row => row.agent_id);
        if (input.agentIds.some(agentId => deniedAgentIds.includes(agentId))) {
          throw new Error('Ein explizit verweigerter Agent kann nicht gleichzeitig erlaubt werden');
        }

        const before = {
          composites: (await client.query<{ composite_id: number }>(
            'SELECT composite_id FROM mcp_user_composites WHERE user_id = $1 ORDER BY composite_id',
            [input.userId],
          )).rows.map(row => row.composite_id),
          rules: (await client.query(
            `SELECT tool_pattern, effect, reason, expires_at
             FROM mcp_user_tool_rules WHERE user_id = $1 ORDER BY id`,
            [input.userId],
          )).rows,
          agents: (await client.query<{ agent_id: number }>(
            `SELECT agent_id FROM mcp_user_agent_rules
             WHERE user_id = $1 AND effect = 'allow' ORDER BY agent_id`,
            [input.userId],
          )).rows.map(row => row.agent_id),
        };

        await client.query('DELETE FROM mcp_user_composites WHERE user_id = $1', [input.userId]);
        for (const compositeId of input.compositeIds) {
          await client.query(
            `INSERT INTO mcp_user_composites (user_id, composite_id, granted_by)
             VALUES ($1, $2, $3)`,
            [input.userId, compositeId, admin.id],
          );
        }

        await client.query('DELETE FROM mcp_user_tool_rules WHERE user_id = $1', [input.userId]);
        for (const rule of input.rules) {
          await client.query(
            `INSERT INTO mcp_user_tool_rules (
               user_id, tool_pattern, effect, reason, expires_at, created_by
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [input.userId, rule.toolPattern, rule.effect, rule.reason, rule.expiresAt, admin.id],
          );
        }

        await client.query(
          `DELETE FROM mcp_user_agent_rules WHERE user_id = $1 AND effect = 'allow'`,
          [input.userId],
        );
        for (const agentId of input.agentIds) {
          await client.query(
            `INSERT INTO mcp_user_agent_rules (user_id, agent_id, effect, created_by)
             VALUES ($1, $2, 'allow', $3)`,
            [input.userId, agentId, `admin:${admin.username}`],
          );
        }

        await client.query('COMMIT');
        writeAdminAudit(
          dependencies.pool,
          req,
          'updated',
          'mcp_user_policies',
          String(input.userId),
          user.username,
          before,
          {
            composites: input.compositeIds,
            rules: input.rules,
            agents: input.agentIds,
          },
        );
        res.json({ ok: true, userId: input.userId });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message : 'Benutzer-Policy konnte nicht gespeichert werden';
        const status = message.includes('nicht gefunden') || message.includes('existiert nicht mehr') ? 404
          : message.includes('verweigerter Agent') ? 409
            : 500;
        logger.error({ err: error, userId: input.userId }, 'Failed to save user access policy');
        res.status(status).json({ error: message });
      } finally {
        client.release();
      }
    },
  );

  app.put(
    '/api/ui/access-policies/technical-identities',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      let input: ReturnType<typeof normalizeFabricTechnicalPolicyMutation>;
      try {
        input = normalizeFabricTechnicalPolicyMutation(req.body as FabricTechnicalPolicyMutationInput);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Technical-Identity-Policy' });
        return;
      }
      const client = await dependencies.pool.connect();
      try {
        await client.query('BEGIN');
        if (input.compositeId != null) {
          const composite = await client.query<{ id: number }>(
            'SELECT id FROM mcp_composites WHERE id = $1 FOR SHARE',
            [input.compositeId],
          );
          if (composite.rows.length === 0) throw new Error('Ausgewähltes Composite existiert nicht mehr');
        }
        if (input.allowedBundleIds != null) {
          const bundles = await client.query<{ id: number }>(
            'SELECT id FROM mcp_service_bundles WHERE id = ANY($1::int[]) FOR SHARE',
            [input.allowedBundleIds],
          );
          if (bundles.rows.length !== input.allowedBundleIds.length) {
            throw new Error('Mindestens ein ausgewähltes Bundle existiert nicht mehr');
          }
        }

        if (input.kind === 'agent') {
          const before = (await client.query<{
            id: number;
            name: string;
            label: string;
            composite_id: number | null;
          }>(
            'SELECT id, name, label, composite_id FROM mcp_agents WHERE id = $1 FOR UPDATE',
            [input.id],
          )).rows[0];
          if (!before) throw new Error('Agent nicht gefunden');
          const saved = (await client.query<{
            id: number;
            name: string;
            label: string;
            composite_id: number | null;
          }>(
            'UPDATE mcp_agents SET composite_id = $1 WHERE id = $2 RETURNING id, name, label, composite_id',
            [input.compositeId, input.id],
          )).rows[0]!;
          await client.query('COMMIT');
          writeAdminAudit(
            dependencies.pool,
            req,
            'updated',
            'mcp_agents',
            String(input.id),
            before.label,
            { composite_id: before.composite_id },
            { composite_id: saved.composite_id },
          );
          res.json({ ok: true, kind: input.kind, id: input.id });
          return;
        }

        const before = (await client.query<{
          id: number;
          label: string;
          composite_id: number | null;
          allowed_bundles: number[] | null;
          allowed_tools: string[] | null;
          denied_tools: string[] | null;
        }>(
          `SELECT id, label, composite_id, allowed_bundles, allowed_tools, denied_tools
           FROM mcp_api_keys WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [input.id],
        )).rows[0];
        if (!before) throw new Error('API-Key nicht gefunden');
        const saved = (await client.query(
          `UPDATE mcp_api_keys
              SET composite_id = $1, allowed_bundles = $2,
                  allowed_tools = $3, denied_tools = $4
            WHERE id = $5
            RETURNING id, label, composite_id, allowed_bundles, allowed_tools, denied_tools`,
          [
            input.compositeId,
            input.allowedBundleIds,
            input.allowedTools,
            input.deniedTools,
            input.id,
          ],
        )).rows[0];
        await client.query('COMMIT');
        await loadApiKeyRbac(dependencies.pool);
        writeAdminAudit(
          dependencies.pool,
          req,
          'updated',
          'mcp_api_keys',
          String(input.id),
          before.label,
          before,
          saved,
        );
        res.json({ ok: true, kind: input.kind, id: input.id });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message : 'Technical-Identity-Policy konnte nicht gespeichert werden';
        const status = message.includes('nicht gefunden') || message.includes('existiert nicht mehr') ? 404 : 500;
        logger.error({ err: error, kind: input.kind, id: input.id }, 'Failed to save technical identity policy');
        res.status(status).json({ error: message });
      } finally {
        client.release();
      }
    },
  );

  const saveCompositePolicy = async (req: Request, res: Response, compositeId?: number) => {
    if (!requirePolicyAdmin(req, res)) return;
    if (compositeId != null && (!Number.isSafeInteger(compositeId) || compositeId < 1)) {
      res.status(400).json({ error: 'Ungültige Composite-ID' });
      return;
    }
    let input: ReturnType<typeof normalizeFabricCompositeMutation>;
    try {
      input = normalizeFabricCompositeMutation(req.body as FabricCompositeMutationInput);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Composite-Daten' });
      return;
    }
    const client = await dependencies.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.includedBundleIds.length > 0) {
        const existing = await client.query<{ id: number }>(
          'SELECT id FROM mcp_service_bundles WHERE id = ANY($1::int[]) FOR SHARE',
          [input.includedBundleIds],
        );
        if (existing.rows.length !== input.includedBundleIds.length) {
          throw new Error('Mindestens ein ausgewähltes Bundle existiert nicht mehr');
        }
      }
      const before = compositeId == null
        ? null
        : (await client.query(
          'SELECT * FROM mcp_composites WHERE id = $1 FOR UPDATE',
          [compositeId],
        )).rows[0] ?? null;
      if (compositeId != null && !before) throw new Error('Composite nicht gefunden');
      const result = compositeId == null
        ? await client.query(
          `INSERT INTO mcp_composites (
             name, description, included_bundle_ids, tool_allow_patterns,
             tool_deny_patterns, system_prompt, agent_role, enabled
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`,
          [
            input.name, input.description, input.includedBundleIds,
            input.toolAllowPatterns, input.toolDenyPatterns,
            input.systemPrompt, input.agentRole, input.enabled,
          ],
        )
        : await client.query(
          `UPDATE mcp_composites
              SET name = $1, description = $2, included_bundle_ids = $3,
                  tool_allow_patterns = $4, tool_deny_patterns = $5,
                  system_prompt = $6, agent_role = $7, enabled = $8
            WHERE id = $9
            RETURNING *`,
          [
            input.name, input.description, input.includedBundleIds,
            input.toolAllowPatterns, input.toolDenyPatterns,
            input.systemPrompt, input.agentRole, input.enabled, compositeId,
          ],
        );
      await client.query('COMMIT');
      const saved = result.rows[0];
      writeAdminAudit(
        dependencies.pool,
        req,
        before ? 'updated' : 'created',
        'mcp_composites',
        String(saved.id),
        saved.name,
        before,
        saved,
      );
      res.status(before ? 200 : 201).json({ composite: saved });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : 'Composite konnte nicht gespeichert werden';
      const status = code === '23505' ? 409
        : message.includes('nicht gefunden') ? 404
          : message.includes('Bundle') ? 400
            : 500;
      logger.error({ err: error, compositeId }, 'Failed to save access policy composite');
      res.status(status).json({ error: code === '23505' ? 'Ein Composite mit diesem Namen existiert bereits' : message });
    } finally {
      client.release();
    }
  };

  app.post(
    '/api/ui/access-policies/composites',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => saveCompositePolicy(req, res),
  );

  app.put(
    '/api/ui/access-policies/composites/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => saveCompositePolicy(req, res, Number(req.params.id)),
  );

  app.delete(
    '/api/ui/access-policies/composites/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      const compositeId = Number(req.params.id);
      if (!Number.isSafeInteger(compositeId) || compositeId < 1) {
        res.status(400).json({ error: 'Ungültige Composite-ID' });
        return;
      }
      try {
        const result = await dependencies.pool.query<{
          id: number;
          name: string;
          user_count: number;
          group_count: number;
          agent_count: number;
          api_key_count: number;
        }>(
          `SELECT c.id, c.name,
             (SELECT count(*) FROM mcp_user_composites uc WHERE uc.composite_id = c.id)::int AS user_count,
             (SELECT count(*) FROM mcp_group_composites gc WHERE gc.composite_id = c.id)::int AS group_count,
             (SELECT count(*) FROM mcp_agents a WHERE a.composite_id = c.id)::int AS agent_count,
             (SELECT count(*) FROM mcp_api_keys k WHERE k.composite_id = c.id AND k.deleted_at IS NULL)::int AS api_key_count
           FROM mcp_composites c WHERE c.id = $1`,
          [compositeId],
        );
        const composite = result.rows[0];
        if (!composite) {
          res.status(404).json({ error: 'Composite nicht gefunden' });
          return;
        }
        const usage = composite.user_count + composite.group_count + composite.agent_count + composite.api_key_count;
        if (usage > 0) {
          res.status(409).json({
            error: `Composite wird noch von ${usage} Zuweisung${usage === 1 ? '' : 'en'} verwendet`,
          });
          return;
        }
        await dependencies.pool.query('DELETE FROM mcp_composites WHERE id = $1', [compositeId]);
        writeAdminAudit(
          dependencies.pool,
          req,
          'deleted',
          'mcp_composites',
          String(compositeId),
          composite.name,
          composite,
          null,
        );
        res.json({ ok: true });
      } catch (error) {
        logger.error({ err: error, compositeId }, 'Failed to delete access policy composite');
        res.status(500).json({ error: 'Composite konnte nicht gelöscht werden' });
      }
    },
  );

  app.put(
    '/api/ui/access-policies/groups',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      let input: ReturnType<typeof normalizeFabricGroupPolicyMutation>;
      try {
        input = normalizeFabricGroupPolicyMutation(req.body as FabricGroupPolicyMutationInput);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Gruppen-Policy' });
        return;
      }
      const client = await dependencies.pool.connect();
      try {
        await client.query('BEGIN');
        if (input.compositeIds.length > 0) {
          const existing = await client.query<{ id: number }>(
            'SELECT id FROM mcp_composites WHERE id = ANY($1::int[]) FOR SHARE',
            [input.compositeIds],
          );
          if (existing.rows.length !== input.compositeIds.length) {
            throw new Error('Mindestens ein ausgewähltes Composite existiert nicht mehr');
          }
        }
        if (input.agentIds.length > 0) {
          const existing = await client.query<{ id: number }>(
            'SELECT id FROM mcp_agents WHERE id = ANY($1::int[]) FOR SHARE',
            [input.agentIds],
          );
          if (existing.rows.length !== input.agentIds.length) {
            throw new Error('Mindestens ein ausgewählter Agent existiert nicht mehr');
          }
        }
        const deniedAgentIds = (await client.query<{ agent_id: number }>(
          `SELECT agent_id FROM mcp_group_agent_rules
           WHERE group_name = $1 AND effect = 'deny'`,
          [input.groupName],
        )).rows.map(row => row.agent_id);
        if (input.agentIds.some(agentId => deniedAgentIds.includes(agentId))) {
          throw new Error('Ein explizit verweigerter Agent kann nicht gleichzeitig erlaubt werden');
        }
        const before = {
          composites: (await client.query<{ composite_id: number }>(
            'SELECT composite_id FROM mcp_group_composites WHERE group_name = $1 ORDER BY composite_id',
            [input.groupName],
          )).rows.map(row => row.composite_id),
          rules: (await client.query(
            'SELECT tool_pattern, effect, reason FROM mcp_group_tool_rules WHERE group_name = $1 ORDER BY id',
            [input.groupName],
          )).rows,
          agents: (await client.query<{ agent_id: number }>(
            `SELECT agent_id FROM mcp_group_agent_rules
             WHERE group_name = $1 AND effect = 'allow' ORDER BY agent_id`,
            [input.groupName],
          )).rows.map(row => row.agent_id),
        };
        await client.query('DELETE FROM mcp_group_composites WHERE group_name = $1', [input.groupName]);
        for (const compositeId of input.compositeIds) {
          await client.query(
            'INSERT INTO mcp_group_composites (group_name, composite_id) VALUES ($1, $2)',
            [input.groupName, compositeId],
          );
        }
        await client.query('DELETE FROM mcp_group_tool_rules WHERE group_name = $1', [input.groupName]);
        for (const rule of input.rules) {
          await client.query(
            `INSERT INTO mcp_group_tool_rules (group_name, tool_pattern, effect, reason)
             VALUES ($1, $2, $3, $4)`,
            [input.groupName, rule.toolPattern, rule.effect, rule.reason],
          );
        }
        await client.query(
          `DELETE FROM mcp_group_agent_rules WHERE group_name = $1 AND effect = 'allow'`,
          [input.groupName],
        );
        for (const agentId of input.agentIds) {
          await client.query(
            `INSERT INTO mcp_group_agent_rules (group_name, agent_id, effect)
             VALUES ($1, $2, 'allow')`,
            [input.groupName, agentId],
          );
        }
        await client.query('COMMIT');
        writeAdminAudit(
          dependencies.pool,
          req,
          'updated',
          'mcp_group_policies',
          input.groupName,
          input.groupName,
          before,
          { composites: input.compositeIds, rules: input.rules, agents: input.agentIds },
        );
        res.json({ ok: true, groupName: input.groupName });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message : 'Gruppen-Policy konnte nicht gespeichert werden';
        logger.error({ err: error, groupName: input.groupName }, 'Failed to save group access policy');
        const status = message.includes('existiert nicht mehr') ? 400
          : message.includes('verweigerter Agent') ? 409
            : 500;
        res.status(status).json({ error: message });
      } finally {
        client.release();
      }
    },
  );

  app.get('/api/ui/overview', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      res.json(await overviewPayload(dependencies, user, selectedScope));
    } catch (error) {
      logger.error({ err: error }, 'Failed to build console overview');
      res.status(500).json({ error: 'Command Center konnte nicht geladen werden' });
    }
  });

  app.get('/api/ui/navigation-capabilities', dependencies.requireAuth, (req, res) => {
    const user = (req as AuthenticatedRequest).user!;
    const configuredPackIds = dependencies.config.solutionPackEndpoints
      .map(endpoint => endpoint.packId)
      .filter((packId): packId is ConsoleModuleId => CONSOLE_MODULE_IDS.includes(packId as ConsoleModuleId));
    const installedModules = [...new Set<ConsoleModuleId>([
      'argus.core',
      'compliance',
      'public-channels',
      ...configuredPackIds,
    ])];
    // Licensing/entitlement persistence is intentionally a separate contract.
    // Until it exists, installed modules remain entitled so this endpoint does
    // not silently remove access from existing deployments.
    res.json(buildConsoleNavigationCapabilities(user, {
      installedModules,
      entitledModules: installedModules,
    }));
  });

  app.get('/api/ui/runtime-controls', dependencies.requireAuth, async (req, res) => {
    if (!requireRuntimeAdmin(req, res)) return;
    try {
      const policies = (await loadAllToolFilters(dependencies.pool)).map(mapRuntimePolicy);
      const hooks = listHooks().map(hook => ({
        name: hook.name,
        priority: hook.priority,
        description: hook.description,
        kind: hook.name === 'external-policy-filter' ? 'external' as const : 'built_in' as const,
      }));
      res.json({
        generatedAt: new Date().toISOString(),
        hooks,
        policies,
        limits: { minTimeoutMs: 100, maxTimeoutMs: 30_000, maxPatterns: 50, maxPatternLength: 256 },
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to load runtime controls');
      res.status(500).json({ error: 'Runtime Controls could not be loaded' });
    }
  });

  app.post(
    '/api/ui/runtime-controls/policies',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      if (!requireRuntimeAdmin(req, res)) return;
      try {
        const input = normalizeToolFilterMutation(req.body, true);
        const result = await createToolFilterAudited(dependencies.pool, {
          name: input.name!,
          description: input.description!,
          webhook_url: input.webhookUrl!,
          hmac_secret: input.hmacSecret ?? null,
          timeout_ms: input.timeoutMs!,
          tool_patterns: input.toolPatterns!,
          enabled: input.enabled!,
          on_timeout: input.onFailure!,
        }, buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!));
        const created = result.value;
        await loadToolFilters(dependencies.pool).then(setToolFilters);
        const policy = mapRuntimePolicy(created);
        if (!result.replayed) {
          writeAdminAudit(dependencies.pool, req, 'created', 'mcp_tool_filters', String(created.id), created.name, null, policy);
        }
        res.status(result.replayed ? 200 : 201).json({ ...policy, replayed: result.replayed, auditEventId: result.auditEvent.eventId });
      } catch (error) {
        runtimePolicyError(res, error, 'Runtime policy could not be created');
      }
    },
  );

  app.put(
    '/api/ui/runtime-controls/policies/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      if (!requireRuntimeAdmin(req, res)) return;
      const id = numericId(req.params['id']);
      if (!id) { res.status(400).json({ error: 'Invalid runtime policy ID' }); return; }
      try {
        const input = normalizeToolFilterMutation(req.body, false);
        const before = await getToolFilter(dependencies.pool, id);
        if (!before) { res.status(404).json({ error: 'Runtime policy not found' }); return; }
        const result = await updateToolFilterAudited(dependencies.pool, id, {
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.webhookUrl !== undefined ? { webhook_url: input.webhookUrl } : {}),
          ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}),
          ...(input.toolPatterns !== undefined ? { tool_patterns: input.toolPatterns } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.onFailure !== undefined ? { on_timeout: input.onFailure } : {}),
          ...(input.secretAction !== 'keep' ? { hmac_secret: input.hmacSecret ?? null } : {}),
        }, buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!));
        const updated = result.value;
        await loadToolFilters(dependencies.pool).then(setToolFilters);
        const beforeState = mapRuntimePolicy(before);
        const policy = mapRuntimePolicy(updated);
        if (!result.replayed) {
          writeAdminAudit(dependencies.pool, req, 'updated', 'mcp_tool_filters', String(id), updated.name, beforeState, policy);
        }
        res.json({ ...policy, replayed: result.replayed, auditEventId: result.auditEvent.eventId });
      } catch (error) {
        runtimePolicyError(res, error, 'Runtime policy could not be updated');
      }
    },
  );

  app.delete(
    '/api/ui/runtime-controls/policies/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      if (!requireRuntimeAdmin(req, res)) return;
      const id = numericId(req.params['id']);
      if (!id) { res.status(400).json({ error: 'Invalid runtime policy ID' }); return; }
      try {
        const before = await getToolFilter(dependencies.pool, id);
        const result = await deleteToolFilterAudited(
          dependencies.pool, id,
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        await loadToolFilters(dependencies.pool).then(setToolFilters);
        if (!result.replayed) {
          writeAdminAudit(
            dependencies.pool, req, 'deleted', 'mcp_tool_filters', String(id), before?.name ?? null,
            before ? mapRuntimePolicy(before) : null, null,
          );
        }
        res.json({ deleted: true, replayed: result.replayed, auditEventId: result.auditEvent.eventId });
      } catch (error) {
        runtimePolicyError(res, error, 'Runtime policy could not be deleted');
      }
    },
  );

  app.post(
    '/api/ui/runtime-controls/policies/:id/test',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      if (!requireRuntimeAdmin(req, res)) return;
      const id = numericId(req.params['id']);
      if (!id) { res.status(400).json({ error: 'Invalid runtime policy ID' }); return; }
      try {
        const input = normalizeToolFilterTest(req.body);
        const policy = await getToolFilter(dependencies.pool, id);
        if (!policy) { res.status(404).json({ error: 'Runtime policy not found' }); return; }
        const result = await testToolFilter(policy, input.toolName, input.args);
        writeAdminAudit(dependencies.pool, req, 'tested', 'mcp_tool_filters', String(id), policy.name, null, {
          toolName: input.toolName,
          reachable: result.reachable,
          status: result.status,
          decision: result.decision,
          latencyMs: result.latencyMs,
          signed: result.signed,
        });
        res.json(result);
      } catch (error) {
        runtimePolicyError(res, error, 'Runtime policy test could not be executed');
      }
    },
  );

  app.get('/api/ui/public-widgets', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const [widgets, allAgents] = await Promise.all([
        listWidgets(dependencies.pool),
        listPublicWidgetAgents(dependencies.pool),
      ]);
      res.json({
        generatedAt: new Date().toISOString(),
        masterEnabled: dependencies.publicWidgetEnabled,
        demo: mapPublicWidgetDemo(widgets, allAgents, dependencies.publicWidgetEnabled),
        widgets: widgets.map(widget => mapPublicWidget(widget, allAgents, dependencies.publicWidgetEnabled)),
        agents: allAgents
          .filter(agent => agent.enabled && agent.visibility === 'public')
          .map(agent => ({ id: Number(agent.id), name: agent.name, label: agent.label })),
        limits: { maxOrigins: 20, minDailyTokenCap: 1000, maxDailyTokenCap: 10_000_000, maxRateLimitPerIp: 1000 },
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to load public widget catalog');
      res.status(500).json({ error: 'Public Widgets konnten nicht geladen werden' });
    }
  });

  app.post(
    '/api/ui/public-widgets',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      let input;
      try {
        input = normalizePublicWidgetMutation(req.body, true);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Widget-Konfiguration' });
        return;
      }
      try {
        const allAgents = await listPublicWidgetAgents(dependencies.pool);
        const agent = allAgents.find(candidate => candidate.id === input.agentId);
        if (!agent || !agent.enabled || agent.visibility !== 'public') {
          res.status(400).json({ error: 'Der ausgewählte Agent muss aktiviert und öffentlich sichtbar sein' });
          return;
        }
        if ((input.enabled ?? true) && (input.allowedOrigins?.length ?? 0) === 0) {
          res.status(400).json({ error: 'Ein aktiviertes Widget benötigt mindestens eine exakte Allowed Origin' });
          return;
        }
        const created = await createWidget(dependencies.pool, {
          agent_id: input.agentId!,
          slug: input.slug!,
          allowed_origins: input.allowedOrigins ?? [],
          enabled: input.enabled ?? true,
          greeting: input.greeting ?? null,
          accent: input.accent ?? null,
          title: input.title ?? null,
          input_placeholder: input.inputPlaceholder ?? null,
          launcher_icon_url: input.launcherIconUrl ?? null,
          launcher_icon_alt: input.launcherIconAlt ?? null,
          launcher_position: input.launcherPosition ?? 'right',
          rate_limit_per_ip: input.rateLimitPerIp ?? 20,
          daily_token_cap: input.dailyTokenCap ?? 50_000,
          created_by: user.id,
        });
        const widget = mapPublicWidget(created, allAgents, dependencies.publicWidgetEnabled);
        writeAdminAudit(dependencies.pool, req, 'created', 'mcp_public_widgets', String(created.id), created.slug, null, widget);
        res.status(201).json(widget);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/unique|duplicate|slug/i.test(message)) {
          res.status(409).json({ error: 'Slug bereits vergeben' });
          return;
        }
        logger.error({ err: error }, 'Failed to create public widget');
        res.status(500).json({ error: 'Public Widget konnte nicht erstellt werden' });
      }
    },
  );

  app.post(
    '/api/ui/public-widgets/demo',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      try {
        const beforeWidgets = await listWidgets(dependencies.pool);
        const beforeAgents = await listPublicWidgetAgents(dependencies.pool);
        const before = mapPublicWidgetDemo(beforeWidgets, beforeAgents, dependencies.publicWidgetEnabled);
        const result = await provisionPublicWidgetDemo(dependencies.pool, {
          origin: String(req.body?.origin ?? ''),
          websiteOrigins: Array.isArray(req.body?.websiteOrigins)
            ? req.body.websiteOrigins.map((value: unknown) => String(value))
            : undefined,
          createdBy: user.id,
        });
        const agents = result.agent ? [result.agent] : [];
        const widgets = result.widget ? [result.widget] : [];
        const demo = mapPublicWidgetDemo(widgets, agents, dependencies.publicWidgetEnabled);
        const widget = result.widget
          ? mapPublicWidget(result.widget, agents, dependencies.publicWidgetEnabled)
          : null;
        writeAdminAudit(
          dependencies.pool,
          req,
          before.configured ? 'updated' : 'created',
          'public_widget_demo',
          String(result.widget?.id ?? result.agent?.id ?? PUBLIC_WIDGET_DEMO_SLUG),
          PUBLIC_WIDGET_DEMO_SLUG,
          before,
          demo,
        );
        res.status(before.configured ? 200 : 201).json({ demo, widget });
      } catch (error) {
        logger.error({ err: error }, 'Failed to provision public widget demo');
        res.status(error instanceof PublicWidgetDemoError ? error.status : 500).json({
          error: error instanceof Error ? error.message : 'Public Widget Demo konnte nicht vorbereitet werden',
        });
      }
    },
  );

  app.post(
    '/api/ui/public-widgets/demo/disable',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      try {
        const beforeWidgets = await listWidgets(dependencies.pool);
        const beforeAgents = await listPublicWidgetAgents(dependencies.pool);
        const before = mapPublicWidgetDemo(beforeWidgets, beforeAgents, dependencies.publicWidgetEnabled);
        const result = await disablePublicWidgetDemo(dependencies.pool);
        const agents = result.agent ? [result.agent] : [];
        const widgets = result.widget ? [result.widget] : [];
        const demo = mapPublicWidgetDemo(widgets, agents, dependencies.publicWidgetEnabled);
        writeAdminAudit(
          dependencies.pool,
          req,
          'updated',
          'public_widget_demo',
          String(result.widget?.id ?? result.agent?.id ?? PUBLIC_WIDGET_DEMO_SLUG),
          PUBLIC_WIDGET_DEMO_SLUG,
          before,
          demo,
        );
        res.json({ demo });
      } catch (error) {
        logger.error({ err: error }, 'Failed to disable public widget demo');
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Public Widget Demo konnte nicht deaktiviert werden',
        });
      }
    },
  );

  app.put(
    '/api/ui/public-widgets/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const id = Number(req.params['id']);
      if (!Number.isSafeInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Ungültige Widget-ID' });
        return;
      }
      let input;
      try {
        input = normalizePublicWidgetMutation(req.body, false);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Widget-Konfiguration' });
        return;
      }
      try {
        const [before, allAgents] = await Promise.all([
          getWidget(dependencies.pool, id),
          listPublicWidgetAgents(dependencies.pool),
        ]);
        if (!before) {
          res.status(404).json({ error: 'Widget nicht gefunden' });
          return;
        }
        const agentId = input.agentId ?? before.agent_id;
        const agent = allAgents.find(candidate => candidate.id === agentId) ?? null;
        const enabled = input.enabled ?? before.enabled;
        const allowedOrigins = input.allowedOrigins ?? before.allowed_origins;
        if ((input.agentId !== undefined || enabled) && (!agent || !agent.enabled || agent.visibility !== 'public')) {
          res.status(400).json({ error: 'Der ausgewählte Agent muss aktiviert und öffentlich sichtbar sein' });
          return;
        }
        if (enabled && allowedOrigins.length === 0) {
          res.status(400).json({ error: 'Ein aktiviertes Widget benötigt mindestens eine exakte Allowed Origin' });
          return;
        }
        const updated = await updateWidget(dependencies.pool, id, {
          ...(input.agentId !== undefined ? { agent_id: input.agentId } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.allowedOrigins !== undefined ? { allowed_origins: input.allowedOrigins } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.greeting !== undefined ? { greeting: input.greeting } : {}),
          ...(input.accent !== undefined ? { accent: input.accent } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.inputPlaceholder !== undefined ? { input_placeholder: input.inputPlaceholder } : {}),
          ...(input.launcherIconUrl !== undefined ? { launcher_icon_url: input.launcherIconUrl } : {}),
          ...(input.launcherIconAlt !== undefined ? { launcher_icon_alt: input.launcherIconAlt } : {}),
          ...(input.launcherPosition !== undefined ? { launcher_position: input.launcherPosition } : {}),
          ...(input.rateLimitPerIp !== undefined ? { rate_limit_per_ip: input.rateLimitPerIp } : {}),
          ...(input.dailyTokenCap !== undefined ? { daily_token_cap: input.dailyTokenCap } : {}),
        });
        const beforeState = mapPublicWidget(before, allAgents, dependencies.publicWidgetEnabled);
        const widget = mapPublicWidget(updated, allAgents, dependencies.publicWidgetEnabled);
        writeAdminAudit(dependencies.pool, req, 'updated', 'mcp_public_widgets', String(id), updated.slug, beforeState, widget);
        res.json(widget);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/unique|duplicate/i.test(message)) {
          res.status(409).json({ error: 'Slug bereits vergeben' });
          return;
        }
        logger.error({ err: error, widgetId: id }, 'Failed to update public widget');
        res.status(500).json({ error: 'Public Widget konnte nicht aktualisiert werden' });
      }
    },
  );

  app.delete(
    '/api/ui/public-widgets/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const id = Number(req.params['id']);
      if (!Number.isSafeInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Ungültige Widget-ID' });
        return;
      }
      try {
        const before = await getWidget(dependencies.pool, id);
        if (!before) {
          res.status(404).json({ error: 'Widget nicht gefunden' });
          return;
        }
        await deleteWidget(dependencies.pool, id);
        writeAdminAudit(dependencies.pool, req, 'deleted', 'mcp_public_widgets', String(id), before.slug, before, null);
        res.json({ deleted: true });
      } catch (error) {
        logger.error({ err: error, widgetId: id }, 'Failed to delete public widget');
        res.status(500).json({ error: 'Public Widget konnte nicht gelöscht werden' });
      }
    },
  );

  app.get('/api/ui/observability/traces', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const rawHours = Number(req.query['hours'] ?? 24);
      const rawLimit = Number(req.query['limit'] ?? 100);
      const status = typeof req.query['status'] === 'string'
        && ['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(req.query['status'])
        ? req.query['status']
        : undefined;
      const kind = typeof req.query['kind'] === 'string'
        && ['agent', 'workflow', 'compliance', 'evaluation', 'unknown'].includes(req.query['kind'])
        ? req.query['kind']
        : undefined;
      const traces = await listTelemetryTraces(dependencies.pool, {
        ...telemetryAccess(user, selectedScope),
        hours: Number.isFinite(rawHours) ? rawHours : 24,
        limit: Number.isFinite(rawLimit) ? rawLimit : 100,
        status,
        kind,
      });
      res.json({ generatedAt: new Date().toISOString(), traces });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list native observability traces');
      res.status(500).json({ error: 'Traces konnten nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/service-catalog', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      res.json(await listServiceCatalog(dependencies.pool));
    } catch (error) {
      logger.error({ err: error }, 'Failed to list observability service catalog');
      res.status(500).json({ error: 'Service-Katalog konnte nicht geladen werden' });
    }
  });

  app.post(
    '/api/ui/observability/service-catalog/refresh',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    serviceCatalogRefreshRateLimit,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user;
        if (!user) {
          res.status(401).json({ error: 'Nicht authentifiziert' });
          return;
        }
        if (!hasRole(user.role, 'platform_admin')) {
          res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
          return;
        }
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? req.body as Record<string, unknown>
          : {};
        const bundleId = Number(body['bundleId']);
        const rawScope = body['resourceScope'];
        if (!Number.isSafeInteger(bundleId) || bundleId <= 0
          || !rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
          res.status(400).json({ error: 'Ein gültiges Bundle und Kubernetes-Ziel sind erforderlich' });
          return;
        }
        const candidate = rawScope as Record<string, unknown>;
        const scope = {
          kind: 'kubernetes' as const,
          backendId: Number(candidate['backendId']),
          targetId: typeof candidate['targetId'] === 'string' ? candidate['targetId'].trim() : '',
          namespace: typeof candidate['namespace'] === 'string' ? candidate['namespace'].trim() : '',
        };
        const capabilities = await checkBundleCapabilities(dependencies.pool, [bundleId], ['metrics', 'runtime']);
        if (!capabilities.ok) {
          res.status(409).json({ error: `Das gewählte Bundle erfüllt die Discovery-Anforderungen nicht: ${capabilities.missing.join(', ')}` });
          return;
        }
        const resolvedScope = await resolveExecutionResourceScope(dependencies.pool, [bundleId], scope);
        const certification = (await listLatestKubernetesCertifications(dependencies.pool)).find(item =>
          item.backendId === scope.backendId && item.targetId === scope.targetId);
        if (certification?.status !== 'passed' || certification.freshness === 'stale') {
          res.status(409).json({ error: 'Service Discovery benötigt ein gültiges, aktuell zertifiziertes Kubernetes-Ziel' });
          return;
        }
        const refresh = await refreshServiceCatalog(dependencies.pool, dependencies.config, {
          bundleId,
          scope,
          resolvedScope,
        });
        const catalog = await listServiceCatalog(dependencies.pool);
        writeAdminAudit(
          dependencies.pool,
          req,
          'executed',
          'mcp_observability_service_catalog_evidence',
          `${scope.backendId}:${scope.targetId}:${scope.namespace}`,
          'Governed service discovery',
          null,
          { bundleId, resourceScope: scope, ...refresh },
        );
        res.json({ ...catalog, refresh });
      } catch (error) {
        logger.warn({ err: error }, 'Governed service catalog refresh failed');
        res.status(400).json({ error: error instanceof Error ? error.message : 'Service Discovery fehlgeschlagen' });
      }
    },
  );

  app.get('/api/ui/observability/alerts', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const [alerts, templates] = await Promise.all([
        listNativeAlerts(dependencies.pool),
        listNativeAlertTemplates(dependencies.pool),
      ]);
      res.json({ generatedAt: new Date().toISOString(), ...alerts, templates });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list native observability alerts');
      res.status(500).json({ error: 'Alert-Regeln konnten nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/aiops/outcomes', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const days = Number(req.query['days'] ?? 30);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await getAiopsOutcomes(dependencies.pool, days));
    } catch (error) {
      logger.error({ err: error }, 'Failed to calculate AIOps outcomes');
      res.status(500).json({ error: 'AIOps-Outcomes konnten nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/alerts/:id/correlations', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const id = Number(req.params['id']);
      if (!Number.isSafeInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Ungültige Incident-ID' });
        return;
      }
      const correlations = await getIncidentChangeCorrelations(dependencies.pool, id);
      if (!correlations) {
        res.status(404).json({ error: 'Incident nicht gefunden' });
        return;
      }
      res.json(correlations);
    } catch (error) {
      logger.error({ err: error, incidentId: req.params['id'] }, 'Failed to correlate incident changes');
      res.status(500).json({ error: 'Incident-Änderungen konnten nicht korreliert werden' });
    }
  });

  app.post(
    '/api/ui/observability/alerts/templates/:templateId/install',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user;
        if (!user) {
          res.status(401).json({ error: 'Nicht authentifiziert' });
          return;
        }
        if (!hasRole(user.role, 'platform_admin')) {
          res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
          return;
        }
        const templateId = String(req.params['templateId'] ?? '').trim();
        const result = await installNativeAlertTemplate(dependencies.pool, templateId, user.id);
        writeAdminAudit(
          dependencies.pool,
          req,
          'installed',
          'mcp_observability_alert_templates',
          templateId,
          result.template.name,
          null,
          { created: result.created, skipped: result.skipped },
        );
        res.status(result.created > 0 ? 201 : 200).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Alert-Preset konnte nicht installiert werden';
        const status = message.includes('nicht gefunden') ? 404 : 500;
        logger.warn({ err: error, templateId: req.params['templateId'] }, 'Failed to install native alert template');
        res.status(status).json({ error: message });
      }
    },
  );

  app.post(
    '/api/ui/observability/alerts',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user;
        if (!user) {
          res.status(401).json({ error: 'Nicht authentifiziert' });
          return;
        }
        if (!hasRole(user.role, 'platform_admin')) {
          res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
          return;
        }
        const input = parseNativeAlertRuleInput(req.body);
        await validateNativeAlertAiopsPolicy(dependencies.pool, input);
        const rule = await createNativeAlertRule(dependencies.pool, input, user.id);
        writeAdminAudit(dependencies.pool, req, 'created', 'mcp_observability_alert_rules', String(rule.id), rule.name, null, rule);
        res.status(201).json(rule);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Alert-Regel konnte nicht erstellt werden';
        logger.warn({ err: error }, 'Failed to create native observability alert rule');
        res.status(400).json({ error: message });
      }
    },
  );

  app.put(
    '/api/ui/observability/alerts/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user;
        if (!user) {
          res.status(401).json({ error: 'Nicht authentifiziert' });
          return;
        }
        if (!hasRole(user.role, 'platform_admin')) {
          res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
          return;
        }
        const id = Number(req.params['id']);
        if (!Number.isSafeInteger(id) || id <= 0) {
          res.status(400).json({ error: 'Ungültige Alert-Regel-ID' });
          return;
        }
        const before = (await listNativeAlerts(dependencies.pool)).rules.find(rule => rule.id === id) ?? null;
        const input = parseNativeAlertRuleInput(req.body);
        await validateNativeAlertAiopsPolicy(dependencies.pool, input);
        const rule = await updateNativeAlertRule(dependencies.pool, id, input);
        if (!rule) {
          res.status(404).json({ error: 'Alert-Regel nicht gefunden' });
          return;
        }
        writeAdminAudit(dependencies.pool, req, 'updated', 'mcp_observability_alert_rules', String(rule.id), rule.name, before, rule);
        res.json(rule);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Alert-Regel konnte nicht gespeichert werden';
        logger.warn({ err: error }, 'Failed to update native observability alert rule');
        res.status(400).json({ error: message });
      }
    },
  );

  app.delete(
    '/api/ui/observability/alerts/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user;
        if (!user) {
          res.status(401).json({ error: 'Nicht authentifiziert' });
          return;
        }
        if (!hasRole(user.role, 'platform_admin')) {
          res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
          return;
        }
        const id = Number(req.params['id']);
        if (!Number.isSafeInteger(id) || id <= 0) {
          res.status(400).json({ error: 'Ungültige Alert-Regel-ID' });
          return;
        }
        const before = (await listNativeAlerts(dependencies.pool)).rules.find(rule => rule.id === id) ?? null;
        if (!await archiveNativeAlertRule(dependencies.pool, id, user.id)) {
          res.status(404).json({ error: 'Alert-Regel nicht gefunden' });
          return;
        }
        writeAdminAudit(dependencies.pool, req, 'archived', 'mcp_observability_alert_rules', String(id), before?.name ?? null, before, null);
        res.json({ deleted: true, archived: true });
      } catch (error) {
        logger.error({ err: error }, 'Failed to archive native observability alert rule');
        res.status(500).json({ error: 'Alert-Regel konnte nicht archiviert werden' });
      }
    },
  );

  app.post(
    '/api/ui/observability/alerts/evaluate',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user;
        if (!user) {
          res.status(401).json({ error: 'Nicht authentifiziert' });
          return;
        }
        if (!hasRole(user.role, 'platform_admin')) {
          res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
          return;
        }
        const result = await runNativeAlertEvaluation(dependencies.pool);
        writeAdminAudit(dependencies.pool, req, 'evaluated', 'mcp_observability_alert_rules', 'all', 'Native observability alerts', null, result);
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, 'Failed to evaluate native observability alerts');
        res.status(500).json({ error: 'Alert-Auswertung ist fehlgeschlagen' });
      }
    },
  );

  app.get('/api/ui/observability/analytics', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const rawHours = Number(req.query['hours'] ?? 24);
      const analytics = await getTelemetryAnalytics(dependencies.pool, {
        ...telemetryAccess(user, selectedScope),
        hours: Number.isFinite(rawHours) ? rawHours : 24,
      });
      res.json({ generatedAt: new Date().toISOString(), hours: Math.max(1, Math.min(rawHours || 24, 24 * 90)), ...analytics });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build native observability analytics');
      res.status(500).json({ error: 'Observability Analytics konnten nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/canaries', dependencies.requireAuth, async (req, res) => {
    if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Synthetic Canaries einsehen')) return;
    try {
      const operations = await getCanaryOperations(dependencies.pool);
      res.setHeader('Cache-Control', 'no-store');
      res.json(operations);
    } catch (error) {
      logger.error({ err: error }, 'Failed to build native Canary Operations');
      res.status(500).json({ error: 'Canary Operations konnten nicht geladen werden' });
    }
  });

  app.put(
    '/api/ui/observability/canaries/config',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    async (req, res) => {
      const user = requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Synthetic Canaries konfigurieren');
      if (!user) return;
      try {
        const before = await loadCanaryConfig(dependencies.pool);
        const config = await saveCanaryConfig(dependencies.pool, req.body, user.id);
        writeAdminAudit(
          dependencies.pool, req, 'updated', 'mcp_platform_settings', 'synthetic_canaries:config',
          'Synthetic Canary configuration', before, config,
        );
        res.json(config);
      } catch (error) {
        if (error instanceof CanaryConfigurationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Failed to update native Canary configuration');
        res.status(500).json({ error: 'Canary-Konfiguration konnte nicht gespeichert werden' });
      }
    },
  );

  app.post(
    '/api/ui/observability/canaries/run',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    canaryRunRateLimit,
    async (req, res) => {
      const user = requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Synthetic Canaries ausführen');
      if (!user) return;
      try {
        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        const agentIds = normalizeCanaryRunAgentIds(body['agentIds']);
        const results = await runCanariesNow(dependencies.pool, {
          source: 'manual', triggeredBy: user.username, agentIds,
        });
        writeAdminAudit(
          dependencies.pool, req, 'executed', 'mcp_observability_canary_runs', 'manual',
          'Synthetic Canary run', null,
          { agentIds: results.map(result => result.agentId), total: results.length, failed: results.filter(result => result.status !== 'ok').length },
        );
        res.json({ results, operations: await getCanaryOperations(dependencies.pool) });
      } catch (error) {
        if (error instanceof CanaryRunConflictError) {
          res.status(409).json({ error: error.message });
          return;
        }
        if (error instanceof CanaryConfigurationError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Failed to execute native Canaries');
        res.status(500).json({ error: 'Canary-Run ist fehlgeschlagen' });
      }
    },
  );

  app.get('/api/ui/observability/ci-canaries', dependencies.requireAuth, async (req, res) => {
    if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können CI Provider Canaries einsehen')) return;
    try {
      const operations = await getCiProviderCanaryOperations(dependencies.pool);
      res.setHeader('Cache-Control', 'no-store');
      res.json(operations);
    } catch (error) {
      logger.error({ err: error }, 'Failed to build CI provider Canary operations');
      res.status(500).json({ error: 'CI Provider Canary Evidence konnte nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/alerts/:id/impact', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const id = Number(req.params['id']);
      if (!Number.isSafeInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Ungültige Incident-ID' });
        return;
      }
      const impact = await getIncidentImpact(dependencies.pool, id);
      if (!impact) {
        res.status(404).json({ error: 'Incident nicht gefunden' });
        return;
      }
      res.json(impact);
    } catch (error) {
      logger.error({ err: error }, 'Failed to build incident dependency impact');
      res.status(500).json({ error: 'Incident-Auswirkungsanalyse konnte nicht geladen werden' });
    }
  });

  app.post(
    '/api/ui/observability/ci-canaries/run',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    canaryRunRateLimit,
    async (req, res) => {
      const user = requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können CI Provider Canaries ausführen');
      if (!user) return;
      try {
        const records = await runCiProviderCanaries(dependencies.pool, {
          source: 'manual',
          triggeredBy: user.username,
        });
        writeAdminAudit(
          dependencies.pool, req, 'executed', 'mcp_observability_ci_canary_runs', 'manual',
          'CI provider canary run', null,
          { total: records.length, failed: records.filter(record => record.status !== 'ok').length },
        );
        res.json({ results: records, operations: await getCiProviderCanaryOperations(dependencies.pool) });
      } catch (error) {
        if (error instanceof CiProviderCanaryError) {
          res.status(error.status === 429 ? 429 : error.status === 400 ? 400 : 502).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Failed to execute CI provider Canaries');
        res.status(500).json({ error: 'CI Provider Canary run ist fehlgeschlagen' });
      }
    },
  );

  app.get('/api/ui/observability/health', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const rawHours = Number(req.query['hours'] ?? 24);
      const hours = Math.max(1, Math.min(rawHours || 24, 24 * 90));
      const [analytics, alerts, customSlos] = await Promise.all([
        getTelemetryAnalytics(dependencies.pool, { ...telemetryAccess(user, selectedScope), hours }),
        listNativeAlerts(dependencies.pool),
        listNativeSlos(dependencies.pool),
      ]);
      const health = buildNativeServiceHealth(analytics, alerts);
      const breachedSlos = customSlos.filter(slo => slo.evaluation.state === 'breached');
      if (breachedSlos.length > 0) {
        if (health.state === 'healthy' || health.state === 'no_data') health.state = 'degraded';
        if (health.score != null) health.score = Math.max(0, health.score - Math.min(30, breachedSlos.length * 8));
        health.recommendations.unshift({
          severity: 'warning',
          title: `${breachedSlos.length} configured SLO${breachedSlos.length === 1 ? ' is' : 's are'} breached`,
          description: breachedSlos.slice(0, 2).map(slo => slo.name).join(' · '),
          href: '/observe/slos',
        });
      }
      res.json({
        generatedAt: new Date().toISOString(),
        hours,
        ...health,
        customSlos,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build native service health');
      res.status(500).json({ error: 'Service Health konnte nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/slos', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const slos = await listNativeSlos(dependencies.pool);
      res.json({
        generatedAt: new Date().toISOString(),
        slos,
        summary: {
          enabled: slos.filter(slo => slo.enabled).length,
          met: slos.filter(slo => slo.evaluation.state === 'met').length,
          breached: slos.filter(slo => slo.evaluation.state === 'breached').length,
          noData: slos.filter(slo => slo.evaluation.state === 'no_data').length,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list native SLOs');
      res.status(500).json({ error: 'SLOs konnten nicht geladen werden' });
    }
  });

  app.post('/api/ui/observability/slos', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const slo = await createNativeSlo(dependencies.pool, parseNativeSloInput(req.body), user.id);
      writeAdminAudit(dependencies.pool, req, 'created', 'mcp_observability_slos', String(slo.id), slo.name, null, slo);
      res.status(201).json(slo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SLO konnte nicht erstellt werden';
      logger.warn({ err: error }, 'Failed to create native SLO');
      res.status(400).json({ error: message });
    }
  });

  app.put('/api/ui/observability/slos/:id', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const id = Number(req.params['id']);
      if (!Number.isSafeInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Ungültige SLO-ID' });
        return;
      }
      const before = (await listNativeSlos(dependencies.pool)).find(slo => slo.id === id) ?? null;
      const slo = await updateNativeSlo(dependencies.pool, id, parseNativeSloInput(req.body));
      if (!slo) {
        res.status(404).json({ error: 'SLO nicht gefunden' });
        return;
      }
      writeAdminAudit(dependencies.pool, req, 'updated', 'mcp_observability_slos', String(id), slo.name, before, slo);
      res.json(slo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SLO konnte nicht gespeichert werden';
      logger.warn({ err: error }, 'Failed to update native SLO');
      res.status(400).json({ error: message });
    }
  });

  app.delete('/api/ui/observability/slos/:id', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const id = Number(req.params['id']);
      if (!Number.isSafeInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Ungültige SLO-ID' });
        return;
      }
      const before = (await listNativeSlos(dependencies.pool)).find(slo => slo.id === id) ?? null;
      if (!await deleteNativeSlo(dependencies.pool, id)) {
        res.status(404).json({ error: 'SLO nicht gefunden' });
        return;
      }
      writeAdminAudit(dependencies.pool, req, 'deleted', 'mcp_observability_slos', String(id), before?.name ?? null, before, null);
      res.json({ deleted: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete native SLO');
      res.status(500).json({ error: 'SLO konnte nicht gelöscht werden' });
    }
  });

  app.get('/api/ui/observability/dependencies', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const rawHours = Number(req.query['hours'] ?? 24);
      const hours = Math.max(1, Math.min(rawHours || 24, 24 * 90));
      const [analytics, alerts] = await Promise.all([
        getTelemetryAnalytics(dependencies.pool, { ...telemetryAccess(user, selectedScope), hours }),
        listNativeAlerts(dependencies.pool),
      ]);
      const health = buildNativeServiceHealth(analytics, alerts);
      res.json({
        generatedAt: new Date().toISOString(),
        hours,
        ...(await getNativeDependencyMap(dependencies.pool, hours, health.components)),
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build native dependency map');
      res.status(500).json({ error: 'Dependency Map konnte nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/service-topology', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Platform-Admin-Zugriff erforderlich' });
        return;
      }
      res.json(await getServiceTopology(dependencies.pool));
    } catch (error) {
      logger.error({ err: error }, 'Failed to build native service topology');
      res.status(500).json({ error: 'Service-Topologie konnte nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/spans/:id', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const spanId = String(req.params['id'] ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(spanId)) {
        res.status(400).json({ error: 'Ungültige Span-ID' });
        return;
      }
      const span = await getTelemetrySpan(dependencies.pool, spanId, telemetryAccess(user, selectedScope));
      if (!span) {
        res.status(404).json({ error: 'Span nicht gefunden' });
        return;
      }
      res.json({
        generatedAt: new Date().toISOString(),
        trace: {
          id: span.trace_id,
          rootTraceId: span.root_trace_id,
          parentTraceId: span.parent_trace_id,
          name: span.trace_name,
          kind: span.trace_kind,
        },
        span: {
          id: span.id,
          parentSpanId: span.parent_span_id,
          name: span.name,
          kind: span.kind,
          status: span.status,
          startedAt: isoValue(span.started_at),
          endedAt: span.ended_at ? isoValue(span.ended_at) : null,
          durationMs: span.duration_ms == null ? null : numberValue(span.duration_ms),
          model: span.model,
          provider: span.provider,
          toolName: span.tool_name,
          inputTokens: numberValue(span.input_tokens),
          outputTokens: numberValue(span.output_tokens),
          totalCostUsd: numberValue(span.total_cost_usd),
          inputPreview: safePreviewValue(span.input_preview),
          outputPreview: safePreviewValue(span.output_preview, RETAINED_OUTPUT_MAX_LENGTH),
          metadataPreview: safePreviewValue(span.metadata),
          error: span.error_message,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to load native observability span');
      res.status(500).json({ error: 'Span konnte nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/traces/:id', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const detail = await getTelemetryTrace(
        dependencies.pool,
        String(req.params['id'] ?? ''),
        telemetryAccess(user, selectedScope),
      );
      if (!detail) {
        res.status(404).json({ error: 'Trace nicht gefunden' });
        return;
      }
      const family = await loadDistributedTraceFamily(
        dependencies.pool,
        detail.trace,
        telemetryAccess(user, selectedScope),
      );
      res.json({ generatedAt: new Date().toISOString(), ...detail, family });
    } catch (error) {
      logger.error({ err: error }, 'Failed to load native observability trace');
      res.status(500).json({ error: 'Trace konnte nicht geladen werden' });
    }
  });

  app.get('/api/ui/observability/traces/:id/feedback', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const traceId = String(req.params['id'] ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(traceId)) {
        res.status(400).json({ error: 'Ungültige Trace-ID' });
        return;
      }
      if (!await getTelemetryTrace(dependencies.pool, traceId, telemetryAccess(user, selectedScope))) {
        res.status(404).json({ error: 'Trace nicht gefunden' });
        return;
      }
      const rows = await listTraceFeedback(dependencies.pool, traceId);
      res.json({
        generatedAt: new Date().toISOString(),
        traceId,
        feedback: rows.map(mapTraceFeedback),
        summary: summarizeTraceFeedback(rows),
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to load native trace feedback');
      res.status(500).json({ error: 'Trace-Feedback konnte nicht geladen werden' });
    }
  });

  app.post('/api/ui/observability/traces/:id/feedback', dependencies.requireAuth, dependencies.requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const traceId = String(req.params['id'] ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(traceId)) {
        res.status(400).json({ error: 'Ungültige Trace-ID' });
        return;
      }
      if (!await getTelemetryTrace(dependencies.pool, traceId, telemetryAccess(user, selectedScope))) {
        res.status(404).json({ error: 'Trace nicht gefunden' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const label = typeof body['label'] === 'string' ? body['label'].trim().toLowerCase() : 'overall';
      if (!FEEDBACK_LABEL_PATTERN.test(label)) {
        res.status(400).json({ error: 'Feedback-Label ist ungültig' });
        return;
      }
      let score: number | null = null;
      if (body['score'] != null) {
        if (typeof body['score'] !== 'number' || !Number.isFinite(body['score']) || body['score'] < 0 || body['score'] > 1) {
          res.status(400).json({ error: 'Feedback-Score muss zwischen 0 und 1 liegen' });
          return;
        }
        score = body['score'];
      }
      let sentiment: FeedbackSentiment | null = null;
      if (body['sentiment'] != null) {
        if (typeof body['sentiment'] !== 'string' || !FEEDBACK_SENTIMENTS.has(body['sentiment'] as FeedbackSentiment)) {
          res.status(400).json({ error: 'Feedback-Stimmung ist ungültig' });
          return;
        }
        sentiment = body['sentiment'] as FeedbackSentiment;
      }
      let comment: string | null = null;
      if (body['comment'] != null) {
        if (typeof body['comment'] !== 'string' || body['comment'].length > 2_000) {
          res.status(400).json({ error: 'Feedback-Kommentar darf maximal 2.000 Zeichen enthalten' });
          return;
        }
        comment = redact(body['comment'].trim()).text || null;
      }
      if (score == null && sentiment == null && comment == null) {
        res.status(400).json({ error: 'Score, Stimmung oder Kommentar ist erforderlich' });
        return;
      }

      const rawTags = body['tags'] ?? [];
      if (!Array.isArray(rawTags) || rawTags.length > 10 || rawTags.some(tag => typeof tag !== 'string')) {
        res.status(400).json({ error: 'Maximal 10 Feedback-Tags sind erlaubt' });
        return;
      }
      const tags = [...new Set(rawTags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean))];
      if (tags.some(tag => !FEEDBACK_TAG_PATTERN.test(tag))) {
        res.status(400).json({ error: 'Feedback-Tag ist ungültig' });
        return;
      }

      let spanId: string | null = null;
      if (body['spanId'] != null) {
        spanId = typeof body['spanId'] === 'string' ? body['spanId'] : '';
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(spanId)) {
          res.status(400).json({ error: 'Ungültige Span-ID' });
          return;
        }
        const span = await getTelemetrySpan(dependencies.pool, spanId, telemetryAccess(user, selectedScope));
        if (!span || span.trace_id !== traceId) {
          res.status(400).json({ error: 'Span gehört nicht zu diesem Trace' });
          return;
        }
      }

      const inserted = await submitHumanFeedback(dependencies.pool, {
        traceId,
        spanId,
        label,
        score,
        sentiment,
        comment,
        tags,
        userId: user.id,
      });
      const rows = await listTraceFeedback(dependencies.pool, traceId);
      const mappedRows = rows.map(mapTraceFeedback);
      const submitted = mappedRows.find(row => row.id === Number(inserted.id)) ?? mapTraceFeedback(inserted);
      writeAdminAudit(
        dependencies.pool,
        req,
        'feedback_submitted',
        'mcp_observability_feedback',
        String(inserted.id),
        label,
        null,
        submitted,
      );
      res.status(201).json({
        generatedAt: new Date().toISOString(),
        traceId,
        submitted,
        feedback: mappedRows,
        summary: summarizeTraceFeedback(rows),
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to submit native trace feedback');
      res.status(500).json({ error: 'Trace-Feedback konnte nicht gespeichert werden' });
    }
  });

  app.get('/api/ui/runs', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const [workflowRuns, storedTelemetryTraces] = await Promise.all([
        loadWorkflowRuns(dependencies.pool, user, selectedScope, 75),
        listTelemetryTraces(dependencies.pool, {
          ...telemetryAccess(user, selectedScope),
          limit: 150,
          hours: 24 * 90,
        }),
      ]);
      const activeSessions = dependencies.listActiveSessions()
        .filter(session => activeSessionMatchesScope(session, selectedScope));
      const activeSessionIds = new Set(activeSessions.map(session => session.sessionId));
      const runs = [
        ...activeSessions.map(mapAgentRun),
        ...storedTelemetryTraces
          .filter(trace => (trace.kind === 'agent' || (trace.kind === 'workflow' && trace.workflow_execution_id == null)))
          .filter(trace => trace.kind !== 'agent' || !trace.session_id || !activeSessionIds.has(trace.session_id))
          .map(mapTelemetryRun),
        ...workflowRuns.map(mapWorkflowRun),
      ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      res.json({ generatedAt: new Date().toISOString(), runs });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list console runs');
      res.status(500).json({ error: 'Runs konnten nicht geladen werden' });
    }
  });

  app.get('/api/ui/runs/:kind/:id', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const traceAccess = telemetryAccess(user, selectedScope);
      const kind = String(req.params['kind'] ?? '');
      const rawId = String(req.params['id'] ?? '');

      if (kind === 'workflow') {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawId)) {
          const persisted = await getTelemetryTrace(dependencies.pool, rawId, traceAccess);
          if (!persisted || persisted.trace.kind !== 'workflow') {
            res.status(404).json({ error: 'Workflow-Trace nicht gefunden' });
            return;
          }
          const { trace, spans } = persisted;
          const [traceFamily, feedback] = await Promise.all([
            loadDistributedTraceFamily(dependencies.pool, trace, traceAccess),
            listTraceFeedback(dependencies.pool, trace.id),
          ]);
          const childRuns = traceFamily?.runs.filter(run => run.id !== trace.id) ?? [];
          const completedSteps = childRuns.filter(run => ['completed', 'failed', 'cancelled'].includes(run.status)).length;
          const approvalCount = feedback.filter(item => item.label.includes('approval') || item.tags.includes('human-approval')).length;
          const metadata = trace.metadata ?? {};
          const visualWorkflowId = visualWorkflowIdFromTraceMetadata(metadata);
          const inputPreview = trace.input_preview && typeof trace.input_preview === 'object' && !Array.isArray(trace.input_preview)
            ? trace.input_preview as Record<string, unknown>
            : {};
          res.json({
            generatedAt: new Date().toISOString(),
            run: {
              ...mapTelemetryRun(trace),
              trigger: typeof metadata['source'] === 'string' ? metadata['source'] : 'Argus LangGraph runtime',
              resumeCount: Number(metadata['resume_count'] ?? 0) || 0,
              lifecycleStatus: trace.status,
              humanOversightRequired: approvalCount > 0 || trace.status === 'waiting',
              inputKeys: Object.keys(inputPreview),
              traceId: trace.id,
              rootTraceId: trace.root_trace_id,
              parentTraceId: trace.parent_trace_id,
              parentSpanId: trace.parent_span_id,
              ...(visualWorkflowId == null ? {} : {
                workflowId: visualWorkflowId,
                workflowHref: `/build/workflows/studio/${visualWorkflowId}?replay=${encodeURIComponent(trace.id)}`,
              }),
              totalSteps: childRuns.length,
              completedSteps,
            },
            currentApproval: null,
            metrics: {
              resumeCount: Number(metadata['resume_count'] ?? 0) || 0,
              approvalCount,
              totalSteps: childRuns.length,
              completedSteps,
              agentCount: childRuns.filter(run => run.kind === 'agent').length,
              spanCount: traceFamily?.spans.length ?? spans.length,
              llmCallCount: traceFamily?.spans.filter(span => span.kind === 'llm').length ?? 0,
              ragCallCount: traceFamily?.spans.filter(span => span.kind === 'rag').length ?? 0,
              toolCallCount: traceFamily?.spans.filter(span => span.kind === 'tool').length ?? 0,
            },
            steps: childRuns.map(run => ({
              id: run.id,
              label: run.title,
              type: run.kind,
              toolName: null,
              status: run.status === 'cancelled' ? 'failed' : run.status,
              durationMs: run.durationMs,
              resultPreview: null,
            })),
            timeline: buildTelemetryTimeline(trace, spans),
            traceFamily,
          });
          return;
        }
        const executionId = Number(rawId);
        if (!Number.isSafeInteger(executionId) || executionId <= 0) {
          res.status(400).json({ error: 'Ungültige Run-ID' });
          return;
        }
        const detail = await loadWorkflowRunDetail(dependencies.pool, user, selectedScope, executionId);
        if (!detail) {
          res.status(404).json({ error: 'Run nicht gefunden' });
          return;
        }
        const { run, approvals } = detail;
        const summary = mapWorkflowRun(run);
        const stepDefinitions = new Map(run.workflow_steps.map(step => [step.id, step]));
        const steps = run.workflow_steps.map(step => {
          const result = run.step_results?.[step.id];
          return {
            id: step.id,
            label: step.label,
            type: step.type ?? 'argus.tool',
            toolName: step.tool ?? null,
            status: result?.status ?? 'pending',
            durationMs: result?.duration_ms ?? null,
            resultPreview: safePreviewValue(result?.error ?? result?.result),
          };
        });
        for (const [stepId, result] of Object.entries(run.step_results ?? {})) {
          if (stepDefinitions.has(stepId)) continue;
          steps.push({
            id: stepId,
            label: stepId,
            type: 'unknown',
            toolName: null,
            status: result.status,
            durationMs: result.duration_ms,
            resultPreview: safePreviewValue(result.error ?? result.result),
          });
        }
        const completedSteps = steps.filter(step =>
          ['completed', 'failed', 'skipped'].includes(step.status)).length;
        const currentApproval = approvals.find(approval => approval.id === run.waiting_approval_id)
          ?? approvals.at(-1)
          ?? null;
        const nativeWorkflowTrace = await getTelemetryTrace(
          dependencies.pool,
          workflowTelemetryTraceId(executionId),
          traceAccess,
        );
        const traceFamily = await loadDistributedTraceFamily(
          dependencies.pool,
          nativeWorkflowTrace?.trace ?? null,
          traceAccess,
        );
        res.json({
          generatedAt: new Date().toISOString(),
          run: {
            ...summary,
            workflowId: run.workflow_id,
            workflowHref: `/build/workflows/studio/${run.workflow_id}`,
            trigger: run.triggered_by,
            resumeCount: run.resume_count,
            waitingApprovalId: run.waiting_approval_id,
            waitingStepId: run.waiting_step_id,
            lifecycleStatus: run.lifecycle_status,
            humanOversightRequired: run.human_oversight_required,
            tags: run.tags,
            inputKeys: Object.keys(run.input_args ?? {}),
            totalSteps: steps.length,
            completedSteps,
            traceId: nativeWorkflowTrace?.trace.id,
            rootTraceId: nativeWorkflowTrace?.trace.root_trace_id,
            parentTraceId: nativeWorkflowTrace?.trace.parent_trace_id,
            parentSpanId: nativeWorkflowTrace?.trace.parent_span_id,
          },
          currentApproval: currentApproval ? {
            id: currentApproval.id,
            status: currentApproval.status,
            toolName: currentApproval.tool_name,
            stepId: currentApproval.workflow_step_id,
            requestedAt: currentApproval.requested_at,
            reviewer: currentApproval.decided_by_username,
            comment: currentApproval.decision_comment,
            riskLevel: currentApproval.risk_level,
            riskScore: currentApproval.risk_score,
            riskFactors: currentApproval.risk_factors,
            riskModel: currentApproval.risk_model,
          } : null,
          metrics: {
            resumeCount: run.resume_count,
            approvalCount: approvals.length,
            totalSteps: steps.length,
            completedSteps,
          },
          agentContract: correlateWorkflowAgentContractRuns(
            mapWorkflowAgentContractEvidence(run.execution_snapshot),
            traceFamily,
          ),
          steps,
          timeline: buildWorkflowTimeline(run, approvals),
          traceFamily,
        });
        return;
      }

      if (kind === 'agent') {
        const session = dependencies.listActiveSessions()
          .find(item => item.sessionId === rawId && activeSessionMatchesScope(item, selectedScope));
        if (!session) {
          const persisted = await getTelemetryTrace(dependencies.pool, rawId, traceAccess);
          if (!persisted || persisted.trace.kind !== 'agent') {
            res.status(404).json({ error: 'Agent-Run nicht gefunden' });
            return;
          }
          const { trace, spans } = persisted;
          const summary = mapTelemetryRun(trace);
          const completedSteps = spans.filter(span => span.status !== 'running').length;
          const metadata = trace.metadata ?? {};
          const traceFamily = await loadDistributedTraceFamily(dependencies.pool, trace, traceAccess);
          res.json({
            generatedAt: new Date().toISOString(),
            run: {
              ...summary,
              agentId: trace.agent_id ?? undefined,
              agentMode: typeof metadata['agent_mode'] === 'string' ? metadata['agent_mode'] : undefined,
              iteration: typeof metadata['iterations'] === 'number' ? metadata['iterations'] : undefined,
              termination: typeof metadata['termination'] === 'string' ? metadata['termination'] : undefined,
              inputTokens: numberValue(trace.input_tokens),
              outputTokens: numberValue(trace.output_tokens),
              estimatedCostUsd: numberValue(trace.total_cost_usd),
              traceId: trace.id,
              rootTraceId: trace.root_trace_id,
              parentTraceId: trace.parent_trace_id,
              parentSpanId: trace.parent_span_id,
              totalSteps: spans.length,
              completedSteps,
            },
            currentApproval: null,
            metrics: {
              spanCount: spans.length,
              toolCallCount: spans.filter(span => span.kind === 'tool').length,
              llmCallCount: spans.filter(span => span.kind === 'llm').length,
              ragCallCount: spans.filter(span => span.kind === 'rag').length,
              inputTokens: numberValue(trace.input_tokens),
              outputTokens: numberValue(trace.output_tokens),
              estimatedCostUsd: numberValue(trace.total_cost_usd),
            },
            steps: spans.map(span => ({
              id: span.id,
              label: span.tool_name || span.name,
              type: span.kind,
              toolName: span.tool_name,
              status: span.status === 'cancelled' ? 'failed' : span.status,
              durationMs: span.duration_ms == null ? null : numberValue(span.duration_ms),
              resultPreview: safePreviewValue(span.error_message ?? span.output_preview),
            })),
            timeline: buildTelemetryTimeline(trace, spans),
            traceFamily,
          });
          return;
        }
        if (
          session.callingUserId != null
          && session.callingUserId !== user.id
          && !hasRole(user.role, 'agent_operator')
        ) {
          res.status(404).json({ error: 'Aktiver Agent-Run nicht gefunden' });
          return;
        }
        const agentScope = await dependencies.pool.query<{ bundle_ids: number[] | null }>(
          'SELECT bundle_ids FROM mcp_agents WHERE id = $1 AND enabled = true',
          [session.agentId],
        );
        if (!agentScope.rows[0] || !canSeeBundle(agentScope.rows[0].bundle_ids ?? undefined, user)) {
          res.status(404).json({ error: 'Aktiver Agent-Run nicht gefunden' });
          return;
        }
        const nativeActiveTrace = await getTelemetryTrace(
          dependencies.pool,
          session.sessionId,
          traceAccess,
        );
        const traceFamily = await loadDistributedTraceFamily(
          dependencies.pool,
          nativeActiveTrace?.trace ?? null,
          traceAccess,
        );
        const summary = mapAgentRun(session);
        const timeline: RunTimelineEvent[] = [{
          id: `agent-${session.sessionId}-started`,
          kind: 'run_started',
          title: 'Agent run started',
          detail: `${session.agentMode} mode · ${session.lastMessage || 'No prompt preview'}`,
          timestamp: new Date(session.startedAt).toISOString(),
        }];
        for (const call of session.toolCalls) {
          timeline.push({
            id: `tool-${call.id}`,
            kind: call.finishedAt
              ? call.isError ? 'tool_failed' : 'tool_completed'
              : 'tool_started',
            title: call.finishedAt
              ? `${call.name} ${call.isError ? 'failed' : 'completed'}`
              : `${call.name} running`,
            detail: previewValue(call.args, 300) ?? 'No arguments',
            timestamp: new Date(call.finishedAt ?? call.startedAt).toISOString(),
            durationMs: call.finishedAt ? Math.max(0, call.finishedAt - call.startedAt) : null,
            toolName: call.name,
            inputPreview: safePreviewValue(call.args),
            resultPreview: safePreviewValue(call.previewTrunc),
          });
        }
        if (session.status === 'done' || session.status === 'error') {
          timeline.push({
            id: `agent-${session.sessionId}-terminal`,
            kind: session.status === 'done' ? 'run_completed' : 'run_failed',
            title: session.status === 'done' ? 'Agent run completed' : 'Agent run failed',
            detail: session.errorMessage ?? `${session.toolCallCount} tool calls`,
            timestamp: new Date(session.lastActivityAt).toISOString(),
            durationMs: Math.max(0, session.lastActivityAt - session.startedAt),
          });
        }
        res.json({
          generatedAt: new Date().toISOString(),
          run: {
            ...summary,
            agentId: session.agentId,
            agentMode: session.agentMode,
            iteration: session.iteration,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
            estimatedCostUsd: session.estimatedCostUsd,
            traceId: nativeActiveTrace?.trace.id,
            rootTraceId: nativeActiveTrace?.trace.root_trace_id,
            parentTraceId: nativeActiveTrace?.trace.parent_trace_id,
            parentSpanId: nativeActiveTrace?.trace.parent_span_id,
            totalSteps: session.toolCallCount,
            completedSteps: session.toolCalls.filter(call => call.finishedAt).length,
          },
          currentApproval: null,
          metrics: {
            toolCallCount: session.toolCallCount,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
            estimatedCostUsd: session.estimatedCostUsd,
          },
          steps: session.toolCalls.map(call => ({
            id: call.id,
            label: call.name,
            type: 'tool',
            toolName: call.name,
            status: call.finishedAt ? call.isError ? 'failed' : 'completed' : 'running',
            durationMs: call.finishedAt ? Math.max(0, call.finishedAt - call.startedAt) : null,
            resultPreview: safePreviewValue(call.previewTrunc),
          })),
          timeline: timeline.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)),
          traceFamily,
        });
        return;
      }

      res.status(404).json({ error: 'Run-Typ nicht gefunden' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to load console run detail');
      res.status(500).json({ error: 'Run-Details konnten nicht geladen werden' });
    }
  });

  app.get('/api/ui/governance', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      res.json(await loadGovernancePayload(dependencies.pool, user, selectedScope));
    } catch (error) {
      logger.error({ err: error }, 'Failed to build governance inbox');
      res.status(500).json({ error: 'Approval Inbox konnte nicht geladen werden' });
    }
  });

  app.post('/api/ui/governance/runtime-approvals/:id/:decision', dependencies.requireSameOrigin, dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'agent_operator')) {
        res.status(403).json({ error: 'Reviewer-Rolle erforderlich' });
        return;
      }
      const id = Number(req.params.id);
      const decision = req.params.decision;
      if (!Number.isInteger(id) || id < 1 || (decision !== 'approve' && decision !== 'reject')) {
        res.status(400).json({ error: 'Ungültige Approval-Entscheidung' });
        return;
      }
      const comment = String((req.body as { comment?: string } | undefined)?.comment ?? '').trim().slice(0, 1000);
      if (decision === 'reject' && !comment) {
        res.status(400).json({ error: 'Eine Begründung ist für Ablehnungen erforderlich' });
        return;
      }
      const selectedScope = resolveConsoleWorkspaceScope(req, res, user);
      if (!selectedScope) return;
      const approval = await getRuntimeApproval(dependencies.pool, id, selectedScope);
      if (!approval || !await canSeeRuntimeApproval(dependencies.pool, approval, user, selectedScope)) {
        res.status(404).json({ error: 'Approval nicht gefunden' });
        return;
      }
      if (
        decision === 'approve'
        && approval.requested_by_user_id === user.id
        && !hasRole(user.role, 'platform_admin')
      ) {
        res.status(403).json({ error: 'Vier-Augen-Prinzip: Eigene Requests dürfen nicht freigegeben werden' });
        return;
      }
      const result = await decideRuntimeApprovalAudited(
        dependencies.pool,
        id,
        decision,
        { id: user.id, username: user.username },
        comment || null,
        hasRole(user.role, 'platform_admin'),
        { ...buildUserLifecycleAuditContext(req, user), ...selectedScope },
      );
      const updated = result.value;
      if (!result.replayed) await dependencies.pool.query(
        `INSERT INTO mcp_audit_log (api_key_prefix, tool, parameters, is_error)
         VALUES ($1, 'runtime_approval_decision', $2::jsonb, false)`,
        [
          `user:${user.username.slice(0, 8)}`,
          JSON.stringify({
            approval_id: id,
            decision,
            subject_type: updated.subject_type,
            agent_id: updated.agent_id,
            workflow_id: updated.workflow_id,
            tool_name: updated.tool_name,
          }),
        ],
      ).catch(error => logger.warn({ err: error, approvalId: id }, 'Failed to append runtime approval audit'));
      const resumeScheduled = result.replayed
        ? false
        : dispatchRuntimeApprovalDecision(updated.id, result.decision);
      res.json({
        ok: true,
        status: result.decision,
        expiresAt: updated.approval_expires_at,
        resumeScheduled,
        replayed: result.replayed,
        auditEventId: result.auditEvent.eventId,
      });
    } catch (error) {
      if (error instanceof RuntimeApprovalDecisionError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      logger.error({ err: error }, 'Failed to decide runtime approval');
      res.status(500).json({ error: 'Runtime-Approval konnte nicht entschieden werden' });
    }
  });

  app.get('/api/ui/identity-access/workforce', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const [portalResult, launchResult] = await Promise.all([
        dependencies.pool.query<{
          id: number;
          name: string;
          sso_portal: unknown;
          bundle_ids: number[];
        }>(
          `SELECT backend.id,
                  backend.name,
                  backend.config->'sso_portal' AS sso_portal,
                  COALESCE(
                    array_agg(assignment.bundle_id ORDER BY assignment.bundle_id)
                      FILTER (WHERE assignment.bundle_id IS NOT NULL),
                    ARRAY[]::integer[]
                  )::integer[] AS bundle_ids
             FROM mcp_backends backend
             LEFT JOIN mcp_backend_bundles assignment ON assignment.backend_id = backend.id
            WHERE backend.enabled = true
              AND backend.config ? 'sso_portal'
            GROUP BY backend.id, backend.name, backend.config
            ORDER BY backend.name`,
        ),
        dependencies.pool.query<{
          id: number | string;
          object_id: string;
          created_at: Date | string;
        }>(
          `SELECT DISTINCT ON (object_id) id, object_id, created_at
             FROM mcp_admin_audit_log
            WHERE action = 'backend_sso_launched'
              AND table_name = 'mcp_backends'
              AND changed_by = $1
            ORDER BY object_id, created_at DESC`,
          [user.username],
        ),
      ]);
      const lastLaunchByBackend = new Map(launchResult.rows.map(row => [row.object_id, {
        auditId: Number(row.id),
        launchedAt: isoValue(row.created_at),
      }]));
      const portalGroupKeyByBackend = new Map<number, string>();
      const discoveredPortals = portalResult.rows.flatMap(row => {
        if (!canSeeBundle(row.bundle_ids, user)) return [];
        const configuredPortal = parseBackendSsoPortal(row.sso_portal);
        const descriptor = describeBackendSso(dependencies.config, user, row.id, row.sso_portal);
        if (!configuredPortal || !descriptor) return [];
        portalGroupKeyByBackend.set(row.id, [
          descriptor.mode,
          descriptor.application,
          descriptor.providerName,
          descriptor.label,
          configuredPortal.launchUrl,
        ].join('\u0000'));
        return [{
          backendId: row.id,
          backendName: row.name,
          bundleIds: row.bundle_ids,
          ...descriptor,
          lastLaunch: lastLaunchByBackend.get(String(row.id)) ?? null,
        }];
      });
      const portalGroups = new Map<string, (typeof discoveredPortals)[number] & {
        backendIds: number[];
        backendNames: string[];
        connectionCount: number;
      }>();
      for (const portal of discoveredPortals) {
        // Only collapse technical backend records that lead to the exact same
        // validated workforce portal. Similar labels must never hide distinct
        // tenants or launch destinations from the user.
        const key = portalGroupKeyByBackend.get(portal.backendId) ?? String(portal.backendId);
        const existing = portalGroups.get(key);
        if (!existing) {
          portalGroups.set(key, {
            ...portal,
            backendIds: [portal.backendId],
            backendNames: [portal.backendName],
            connectionCount: 1,
          });
          continue;
        }
        existing.backendIds.push(portal.backendId);
        existing.backendNames.push(portal.backendName);
        existing.connectionCount += 1;
        existing.bundleIds = [...new Set([...existing.bundleIds, ...portal.bundleIds])].sort((left, right) => left - right);
        if (portal.lastLaunch && (!existing.lastLaunch
          || Date.parse(portal.lastLaunch.launchedAt) > Date.parse(existing.lastLaunch.launchedAt))) {
          existing.lastLaunch = portal.lastLaunch;
        }
      }
      const portals = [...portalGroups.values()].sort((left, right) => left.application.localeCompare(right.application));
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        provider: {
          enabled: dependencies.config.oidcSsoEnabled || dependencies.config.entraSsoEnabled,
          name: dependencies.config.oidcProviderName,
        },
        session: {
          authMethod: user.auth_method ?? 'local',
          mfaFresh: hasFreshMfaSession(user, dependencies.config.oidcMfaMaxAgeSeconds),
          mfaVerifiedAt: user.mfa_verified_at ?? null,
          mfaMethod: user.mfa_method ?? null,
        },
        entitlement: {
          enabled: dependencies.config.backendSsoEnabled,
          name: 'Workforce SSO',
        },
        stats: {
          available: portals.length,
          ready: portals.filter(portal => portal.state === 'ready').length,
          launched: portals.filter(portal => portal.lastLaunch != null).length,
          configuredBackends: discoveredPortals.length,
        },
        portals,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build workforce identity access view');
      res.status(500).json({ error: 'Workforce-Zugriffe konnten nicht geladen werden' });
    }
  });

  app.get('/api/ui/mcp-fabric', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const status = visibleStatus(await dependencies.loadStatus(), user);
      const registryResult = await dependencies.pool.query<McpRegistryViewRow>(
        `SELECT backend_id, trust_status, catalog_fingerprint, trusted_fingerprint,
                tool_count, change_summary, first_seen_at, last_seen_at, changed_at,
                verified_at, verification_comment
         FROM mcp_registry_entries`,
      );
      const portalResult = await dependencies.pool.query<{ id: number; sso_portal: unknown }>(
        `SELECT id, config->'sso_portal' AS sso_portal
           FROM mcp_backends
          WHERE config ? 'sso_portal'`,
      );
      const registryByBackend = new Map(registryResult.rows.map(entry => [entry.backend_id, entry]));
      const portalByBackend = new Map(portalResult.rows.map(entry => [entry.id, entry.sso_portal]));
      const bundleLabels = new Map(status.bundles.map(bundle => [bundle.id, bundle.label]));
      const namesForBundles = (ids: number[] | undefined) =>
        (ids ?? []).map(id => bundleLabels.get(id)).filter((label): label is string => Boolean(label));
      const servers = status.backends.map((backend, index) => {
        const bundleNames = namesForBundles(backend.bundleIds);
        const registry = backend.customId == null ? undefined : registryByBackend.get(backend.customId);
        return {
          id: String(backend.customId ?? `system-${index}`),
          name: backend.name,
          type: backend.type === 'mcp'
            ? 'mcp' as const
            : backend.name === 'PostgreSQL'
              ? 'database' as const
              : 'http' as const,
          state: serverState(backend),
          latencyMs: backend.latencyMs,
          toolCount: backend.toolCount
            ?? status.dynamicTools.filter(tool =>
              tool.backend === backend.name || tool.backend === `custom:${backend.name}`,
            ).length,
          authType: backend.config.auth ?? (backend.name === 'PostgreSQL' ? 'internal' : 'configured'),
          endpoint: safeEndpoint(backend.config),
          bundleCount: bundleNames.length,
          bundleNames,
          error: backend.error,
          trustStatus: backend.type === 'mcp'
            ? registry?.trust_status ?? 'unverified' as const
            : 'not_applicable' as const,
          catalogFingerprint: registry?.catalog_fingerprint ?? null,
          trustedFingerprint: registry?.trusted_fingerprint ?? null,
          registryToolCount: registry?.tool_count ?? null,
          firstSeenAt: registry ? isoValue(registry.first_seen_at) : null,
          lastSeenAt: registry ? isoValue(registry.last_seen_at) : null,
          changedAt: registry?.changed_at ? isoValue(registry.changed_at) : null,
          verifiedAt: registry?.verified_at ? isoValue(registry.verified_at) : null,
          verificationComment: registry?.verification_comment ?? null,
          changeSummary: registry?.change_summary ?? { added: [], removed: [], changed: [] },
          ssoPortal: backend.customId == null
            ? null
            : describeBackendSso(dependencies.config, user, backend.customId, portalByBackend.get(backend.customId)),
        };
      });
      const remoteTools = status.remoteTools.map(tool => {
        const bundleNames = namesForBundles(tool.bundle_ids);
        return {
          id: `remote-${tool.id}`,
          name: tool.prefixed_name || tool.tool_name,
          server: tool.backend_name,
          description: tool.description,
          bundleCount: bundleNames.length,
          bundleNames,
        };
      });
      const dynamicTools = status.dynamicTools.map((tool: DynamicToolRow) => {
        const bundleNames = namesForBundles(tool.bundle_ids);
        return {
          id: `dynamic-${tool.id}`,
          name: tool.name,
          server: tool.backend,
          description: tool.description,
          bundleCount: bundleNames.length,
          bundleNames,
        };
      });
      const bundles = status.bundles.map(bundle => ({
        id: bundle.id,
        label: bundle.label,
        icon: bundle.icon,
        serverCount: numberValue(bundle.backend_count),
        toolCount: numberValue(bundle.tool_count),
        access: user.allowed_bundles == null ? 'unrestricted' as const : 'granted' as const,
      }));
      const remoteMcpServers = servers.filter(server => server.type === 'mcp');
      res.json({
        generatedAt: new Date().toISOString(),
        permissions: {
          canManage: hasRole(user.role, 'platform_admin'),
        },
        stats: {
          servers: servers.filter(server => server.state !== 'not_configured').length,
          healthy: servers.filter(server => server.state === 'healthy').length,
          tools: remoteTools.length + dynamicTools.length,
          bundles: status.bundles.length,
          trusted: remoteMcpServers.filter(server => server.trustStatus === 'trusted').length,
          trustAttention: remoteMcpServers.filter(server =>
            server.trustStatus === 'changed' || server.trustStatus === 'quarantined',
          ).length,
          mcpServers: remoteMcpServers.length,
          ssoPortals: servers.filter(server => server.ssoPortal != null).length,
          readySsoPortals: servers.filter(server => server.ssoPortal?.state === 'ready').length,
        },
        servers,
        bundles,
        tools: [...remoteTools, ...dynamicTools].sort((a, b) => a.name.localeCompare(b.name)),
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build MCP Fabric view');
      res.status(500).json({ error: 'MCP Fabric konnte nicht geladen werden' });
    }
  });

  app.get('/api/ui/mcp-fabric/manage', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Nur Platform-Administratoren können die MCP Fabric verwalten' });
        return;
      }
      const [
        bundles,
        assignmentResult,
        skillAssignmentResult,
        workflowAssignmentResult,
        backendResult,
        skillsResult,
        toolPolicies,
        managementTools,
        rawStatus,
      ] = await Promise.all([
        listBundles(dependencies.pool),
        dependencies.pool.query<{ bundle_id: number; backend_ids: number[] }>(
          `SELECT bundle_id, array_agg(backend_id ORDER BY backend_id)::int[] AS backend_ids
             FROM mcp_backend_bundles
            GROUP BY bundle_id`,
        ),
        dependencies.pool.query<{ bundle_id: number; skill_ids: number[] }>(
          `SELECT bundle_id, array_agg(skill_id ORDER BY position, skill_id)::int[] AS skill_ids
             FROM mcp_bundle_skills
            GROUP BY bundle_id`,
        ),
        dependencies.pool.query<{ bundle_id: number; workflow_ids: number[] }>(
          `SELECT wb.bundle_id,
                  array_agg(wb.workflow_id ORDER BY w.name, wb.workflow_id)::int[] AS workflow_ids
             FROM mcp_workflow_bundles wb
             JOIN mcp_workflows w ON w.id = wb.workflow_id
            GROUP BY wb.bundle_id`,
        ),
        dependencies.pool.query<{
          id: number;
          name: string;
          description: string;
          base_url: string;
          backend_type: string;
          enabled: boolean;
          mcp_endpoint: string | null;
          auth_type: string;
          has_auth_value: boolean;
          health_path: string | null;
          default_headers: Record<string, string>;
          timeout_ms: number;
          tls_skip_verify: boolean;
          auth_mode: string;
          oauth_authorize_url: string | null;
          oauth_token_url: string | null;
          oauth_client_id: string | null;
          has_oauth_client_secret: boolean;
          oauth_scopes: string[] | null;
          oauth_revoke_url: string | null;
          bundle_ids: number[];
          tool_count: number;
          capability_source_id: number | null;
          source_controlled: boolean;
          config: Record<string, unknown>;
          created_at: string | Date;
          updated_at: string | Date;
        }>(
          `SELECT b.id, b.name, b.description, b.base_url, b.backend_type, b.enabled, b.mcp_endpoint,
                  b.auth_type, b.auth_value IS NOT NULL AND b.auth_value <> '' AS has_auth_value,
                  b.health_path, b.default_headers, b.timeout_ms, b.tls_skip_verify,
                  b.auth_mode, b.oauth_authorize_url, b.oauth_token_url, b.oauth_client_id,
                  b.oauth_client_secret IS NOT NULL AND b.oauth_client_secret <> '' AS has_oauth_client_secret,
                  b.oauth_scopes, b.oauth_revoke_url, b.config, b.created_at, b.updated_at,
                  source.id AS capability_source_id,
                  (source.id IS NOT NULL OR b.config->>'managed_by' = 'openapi') AS source_controlled,
                  COALESCE(array_agg(DISTINCT bb.bundle_id) FILTER (WHERE bb.bundle_id IS NOT NULL), '{}')::int[] AS bundle_ids,
                  (
                    (SELECT count(*) FROM mcp_remote_tools rt WHERE rt.backend_id = b.id)
                    + (SELECT count(*) FROM mcp_tools t WHERE t.backend = b.name OR t.backend = 'custom:' || b.name)
                  )::int AS tool_count
             FROM mcp_backends b
             LEFT JOIN mcp_backend_bundles bb ON bb.backend_id = b.id
             LEFT JOIN mcp_capability_sources source ON source.backend_id = b.id
            GROUP BY b.id, source.id
            ORDER BY b.name`,
        ),
        dependencies.pool.query<{
          id: number;
          name: string;
          label: string;
          description: string;
          category: string | null;
          icon: string;
        }>(
          `SELECT id, name, label, description, category, icon
             FROM mcp_skills
            ORDER BY category NULLS LAST, label`,
        ),
        listBundleToolPolicies(dependencies.pool),
        dependencies.pool.query<{
          backend_id: number | null;
          name: string;
          description: string;
          source: 'dynamic' | 'remote';
          enabled: boolean;
          is_write: boolean;
          bundle_ids: number[];
        }>(
          `SELECT DISTINCT ON (candidate.backend_id, candidate.name)
                  candidate.backend_id, candidate.name, candidate.description,
                  candidate.source, candidate.enabled, candidate.is_write,
                  CASE WHEN candidate.backend_id IS NULL THEN
                    COALESCE(ARRAY(
                      SELECT tb.bundle_id
                        FROM mcp_tools direct_tool
                        JOIN mcp_tool_bundles tb ON tb.tool_id = direct_tool.id
                       WHERE direct_tool.name = candidate.name
                       ORDER BY tb.bundle_id
                    ), '{}')::int[]
                  ELSE
                    COALESCE(ARRAY(
                      SELECT bb.bundle_id
                        FROM mcp_backend_bundles bb
                        LEFT JOIN mcp_bundle_backend_tool_policies policy
                          ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
                       WHERE bb.backend_id = candidate.backend_id
                         AND (
                           policy.mode IS NULL
                           OR policy.mode = 'all'
                           OR candidate.name = ANY(policy.allowed_tool_names)
                         )
                       ORDER BY bb.bundle_id
                    ), '{}')::int[]
                  END AS bundle_ids
             FROM (
               SELECT b.id AS backend_id, tool.name, tool.description,
                      'dynamic'::text AS source, tool.enabled,
                      COALESCE(tool.is_write, false) AS is_write
                 FROM mcp_tools tool
                 LEFT JOIN mcp_backends b
                   ON tool.backend = b.name OR tool.backend = 'custom:' || b.name
               UNION ALL
               SELECT remote.backend_id, remote.prefixed_name AS name, remote.description,
                      'remote'::text AS source, true AS enabled, false AS is_write
                 FROM mcp_remote_tools remote
             ) candidate
            ORDER BY candidate.backend_id, candidate.name, candidate.source DESC`,
        ),
        dependencies.loadStatus(),
      ]);
      // Capability tags are derived from the same live backend/tool
      // assignments used by the grant gate, keeping the picker honest.
      let bundleCapabilities: Awaited<ReturnType<typeof loadBundleCapabilities>> = [];
      try {
        bundleCapabilities = await loadBundleCapabilities(
          dependencies.pool,
          bundles.map(bundle => bundle.id),
        );
      } catch (error) {
        // Older/test databases can lack remote-tool tables. The management
        // view remains usable; the actual workflow grant gate still fails
        // closed because it calls the checker directly.
        logger.warn({ err: error }, 'Failed to derive MCP bundle capability tags');
      }
      let kubernetesCertifications: Awaited<ReturnType<typeof listLatestKubernetesCertifications>> = [];
      try {
        kubernetesCertifications = await listLatestKubernetesCertifications(dependencies.pool);
      } catch (error) {
        logger.warn({ err: error }, 'Failed to load Kubernetes connector certification evidence');
      }
      const assignments = new Map(assignmentResult.rows.map(row => [row.bundle_id, row.backend_ids]));
      const skillAssignments = new Map(skillAssignmentResult.rows.map(row => [row.bundle_id, row.skill_ids]));
      const workflowAssignments = new Map(
        workflowAssignmentResult.rows.map(row => [row.bundle_id, row.workflow_ids]),
      );
      const policiesByBundle = new Map<number, BundleBackendToolPolicy[]>();
      for (const policy of toolPolicies) {
        const policies = policiesByBundle.get(policy.bundleId) ?? [];
        policies.push(policy);
        policiesByBundle.set(policy.bundleId, policies);
      }
      const currentBackend = (id: number) => rawStatus.backends.find(backend => backend.customId === id);
      res.json({
        generatedAt: new Date().toISOString(),
        bundles: bundles.map(bundle => ({
          id: bundle.id,
          name: bundle.name,
          label: bundle.label,
          description: bundle.description,
          icon: bundle.icon,
          agentRole: bundle.agent_role,
          systemPrompt: bundle.system_prompt,
          backendIds: assignments.get(bundle.id) ?? [],
          skillIds: skillAssignments.get(bundle.id) ?? [],
          workflowIds: workflowAssignments.get(bundle.id) ?? [],
          workflowCount: workflowAssignments.get(bundle.id)?.length ?? 0,
          toolPolicies: policiesByBundle.get(bundle.id) ?? [],
          backendCount: bundle.backend_count,
          toolCount: bundle.tool_count,
          compositeCount: bundle.composite_count ?? 0,
          createdAt: isoValue(bundle.created_at),
          updatedAt: isoValue(bundle.updated_at),
          capabilityCategories: bundleCapabilities.find(item => item.bundleId === bundle.id)?.categories ?? [],
          capabilitySignals: bundleCapabilities.find(item => item.bundleId === bundle.id)?.signals ?? [],
        })),
        backends: backendResult.rows.map(backend => {
          const current = currentBackend(backend.id);
          const workflowIds = new Set(
            backend.bundle_ids.flatMap(bundleId => workflowAssignments.get(bundleId) ?? []),
          );
          return {
            id: backend.id,
            name: backend.name,
            description: backend.description,
            type: backend.backend_type === 'mcp'
              ? 'mcp'
              : backend.backend_type === 'builtin'
                ? 'builtin'
                : 'http',
            managed: backend.backend_type !== 'builtin',
            managedBy: backend.source_controlled ? 'openapi' as const : null,
            sourceId: backend.capability_source_id,
            enabled: backend.enabled,
            state: current ? serverState(current) : backend.enabled ? 'offline' : 'not_configured',
            endpoint: safeEndpoint({ url: backend.base_url, endpoint: backend.mcp_endpoint ?? '' }),
            baseUrl: safeEndpoint({ url: backend.base_url }).replace(/\/$/, ''),
            mcpEndpoint: backend.mcp_endpoint,
            authType: backend.auth_type,
            hasAuthValue: backend.has_auth_value,
            healthPath: backend.health_path,
            defaultHeaders: redactHeaders(backend.default_headers),
            timeoutMs: backend.timeout_ms,
            tlsSkipVerify: backend.tls_skip_verify,
            authMode: backend.auth_mode,
            oauthAuthorizeUrl: backend.oauth_authorize_url,
            oauthTokenUrl: backend.oauth_token_url,
            oauthClientId: backend.oauth_client_id,
            hasOauthClientSecret: backend.has_oauth_client_secret,
            oauthScopes: backend.oauth_scopes ?? [],
            oauthRevokeUrl: backend.oauth_revoke_url,
            toolCount: backend.tool_count,
            bundleIds: backend.bundle_ids,
            workflowCount: workflowIds.size,
            executionTargets: executionTargetsFromBackend(backend),
            ssoPortal: describeBackendSso(
              dependencies.config,
              user,
              backend.id,
              backend.config?.['sso_portal'],
            ),
            createdAt: isoValue(backend.created_at),
            updatedAt: isoValue(backend.updated_at),
          };
        }),
        skills: skillsResult.rows,
        tools: managementTools.rows.map(tool => ({
          backendId: tool.backend_id,
          name: tool.name,
          description: tool.description,
          source: tool.source,
          enabled: tool.enabled,
          isWrite: tool.is_write,
          bundleIds: tool.bundle_ids,
        })),
        kubernetesCertifications,
        kubernetesCertificationPolicy: loadKubernetesCertificationPolicy(),
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build MCP Fabric management view');
      res.status(500).json({ error: 'MCP-Fabric-Verwaltung konnte nicht geladen werden' });
    }
  });

  // Machine-to-machine import surface for an external CI runner or Kubernetes
  // CronJob. The global API-key middleware authenticates this non-UI route;
  // the explicit synthetic capability below prevents a default/unscoped key
  // from becoming a certification writer.
  app.post(
    '/api/certifications/kubernetes',
    fabricMutationRateLimit,
    async (req, res) => {
      const apiKeyPrefix = requireCertificationAutomationKey(req, res);
      if (!apiKeyPrefix) return;
      try {
        const normalized = normalizeKubernetesCertificationReport(req.body?.report);
        const requestedBackendId = req.body?.backendId;
        const backendId = requestedBackendId === undefined || requestedBackendId === null
          ? await resolveKubernetesCertificationBackendId(dependencies.pool, normalized.targetId)
          : Number(requestedBackendId);
        const certification = await importKubernetesCertification(dependencies.pool, {
          backendId,
          report: req.body?.report,
          importedBy: `automation:${apiKeyPrefix}`,
        });
        writeAdminAudit(
          dependencies.pool,
          req,
          'renewed',
          'mcp_kubernetes_connector_certifications',
          String(certification.id),
          `${certification.platform}:${certification.targetId}`,
          null,
          {
            backendId: certification.backendId,
            targetId: certification.targetId,
            platform: certification.platform,
            status: certification.status,
            reportSha256: certification.reportSha256,
            checkCount: certification.checkCount,
            failedCount: certification.failedCount,
            generatedAt: certification.generatedAt,
          },
        );
        res.status(201).json({ certification, policy: loadKubernetesCertificationPolicy() });
      } catch (error) {
        if (error instanceof KubernetesCertificationError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Failed to renew Kubernetes connector certification');
        res.status(500).json({ error: 'Connector certification renewal could not be imported' });
      }
    },
  );

  app.get(
    '/api/ui/mcp-fabric/kubernetes-certifications/:backendId/:targetId/history',
    dependencies.requireAuth,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Connector-Zertifizierungen einsehen')) return;
      try {
        const history = await listKubernetesCertificationHistory(dependencies.pool, {
          backendId: Number(req.params['backendId']),
          targetId: String(req.params['targetId'] ?? ''),
          limit: req.query['limit'] === undefined ? 10 : Number(req.query['limit']),
        });
        res.set('Cache-Control', 'no-store');
        res.json({ history, policy: loadKubernetesCertificationPolicy() });
      } catch (error) {
        if (error instanceof KubernetesCertificationError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Failed to load Kubernetes connector certification history');
        res.status(500).json({ error: 'Connector-Zertifizierungshistorie konnte nicht geladen werden' });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/kubernetes-certifications',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Connector-Zertifizierungen importieren');
      if (!user) return;
      try {
        const backendId = Number(req.body?.backendId);
        const certification = await importKubernetesCertification(dependencies.pool, {
          backendId,
          report: req.body?.report,
          importedBy: user.username,
        });
        writeAdminAudit(
          dependencies.pool,
          req,
          'imported',
          'mcp_kubernetes_connector_certifications',
          String(certification.id),
          `${certification.platform}:${certification.targetId}`,
          null,
          {
            backendId: certification.backendId,
            targetId: certification.targetId,
            platform: certification.platform,
            status: certification.status,
            contractSha256: certification.contractSha256,
            reportSha256: certification.reportSha256,
            checkCount: certification.checkCount,
            failedCount: certification.failedCount,
            generatedAt: certification.generatedAt,
          },
        );
        res.status(201).json({ certification });
      } catch (error) {
        if (error instanceof KubernetesCertificationError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        const postgresCode = (error as { code?: string }).code;
        if (postgresCode === '23503') {
          res.status(404).json({ error: 'MCP Fabric backend not found' });
          return;
        }
        logger.error({ err: error }, 'Failed to import Kubernetes connector certification');
        res.status(500).json({ error: 'Connector-Zertifizierung konnte nicht importiert werden' });
      }
    },
  );

  app.get('/api/ui/mcp-fabric/templates', dependencies.requireAuth, async (req, res) => {
    if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Connection Templates einsehen')) return;
    res.set('Cache-Control', 'no-store');
    res.json(getNativeServiceTemplateCatalog());
  });

  app.post(
    '/api/ui/mcp-fabric/templates/:templateId/install',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Connection Templates installieren')) return;
      const templateId = String(req.params['templateId'] ?? '');
      try {
        const installed = await installNativeServiceTemplate(dependencies.pool, templateId, req.body);
        const warnings: string[] = [];
        await dependencies.refreshBackends().catch(error => {
          warnings.push('Connection cache could not be refreshed immediately');
          logger.warn({ err: error, templateId, backendId: installed.result.backend.id }, 'Template backend refresh failed');
        });
        await dependencies.refreshDynamicTools().catch(error => {
          warnings.push('Capability runtime catalog could not be refreshed immediately');
          logger.warn({ err: error, templateId, backendId: installed.result.backend.id }, 'Template capability refresh failed');
        });
        writeAdminAudit(
          dependencies.pool,
          req,
          'installed',
          'mcp_service_templates',
          templateId,
          installed.result.backend.name,
          null,
          {
            template_id: templateId,
            backend_id: installed.result.backend.id,
            bundle_id: installed.input.bundleId,
            capability_count: installed.result.tools.length,
          },
        );
        res.status(201).json({
          templateId,
          connection: installed.result.backend,
          capabilities: installed.result.tools,
          warnings,
        });
      } catch (error) {
        if (error instanceof ServiceTemplateCatalogError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        const postgresCode = (error as { code?: string }).code;
        if (postgresCode === '23505') {
          res.status(409).json({ error: 'A connection or capability with this prefix already exists' });
          return;
        }
        logger.error({ err: error, templateId }, 'Native service template installation failed');
        res.status(500).json({ error: 'Connection Template could not be installed' });
      }
    },
  );

  interface ManagedCapabilityDbRow {
    id: number;
    name: string;
    description: string;
    backend: string;
    backend_id: number | null;
    backend_label: string | null;
    query_template: string | null;
    parameters: unknown;
    category: string | null;
    enabled: boolean;
    tool_type: 'dynamic' | 'builtin';
    is_write: boolean;
    risk_level: 'low' | 'medium' | 'high';
    required_auth_mode: 'service-account' | 'permissive' | 'strict' | null;
    bundle_ids: number[];
    workflow_count: number;
    source_controlled?: boolean;
    created_at: string | Date;
    updated_at: string | Date;
  }

  interface RemoteCapabilityDbRow {
    id: number;
    name: string;
    description: string;
    backend_id: number;
    backend_label: string;
    backend_enabled: boolean;
    input_schema: Record<string, unknown>;
    bundle_ids: number[];
    discovered_at: string | Date;
    updated_at: string | Date;
  }

  const capabilityAuditSnapshot = (value: {
    name?: string;
    description?: string;
    backend?: string;
    query_template?: string | null;
    queryTemplate?: string | null;
    parameters?: unknown;
    category?: string | null;
    enabled?: boolean;
    is_write?: boolean;
    isWrite?: boolean;
    risk_level?: string;
    riskLevel?: string;
    required_auth_mode?: string | null;
    requiredAuthMode?: string | null;
    bundle_ids?: number[];
    bundleIds?: number[];
  }) => ({
    name: value.name,
    description: value.description,
    backend: value.backend,
    implementation_configured: Boolean(value.query_template ?? value.queryTemplate),
    parameters: Array.isArray(value.parameters)
      ? value.parameters.map(parameter => {
        const item = parameter as { name?: string; type?: string; required?: boolean };
        return { name: item.name, type: item.type, required: item.required };
      })
      : [],
    category: value.category ?? null,
    enabled: value.enabled,
    is_write: value.is_write ?? value.isWrite,
    risk_level: value.risk_level ?? value.riskLevel,
    required_auth_mode: value.required_auth_mode ?? value.requiredAuthMode ?? null,
    bundle_ids: value.bundle_ids ?? value.bundleIds ?? [],
  });

  const ensureCapabilityBundles = async (client: pg.PoolClient, bundleIds: number[]) => {
    if (bundleIds.length === 0) return;
    const result = await client.query<{ id: number }>(
      'SELECT id FROM mcp_service_bundles WHERE id = ANY($1::int[]) FOR UPDATE',
      [bundleIds],
    );
    if (result.rows.length !== bundleIds.length) throw new Error('Mindestens ein ausgewähltes Bundle existiert nicht mehr');
  };

  const loadCapabilityStudio = async () => {
    const [managedResult, remoteResult, bundleResult, backendResult] = await Promise.all([
      dependencies.pool.query<ManagedCapabilityDbRow>(
        `SELECT tool.id, tool.name, tool.description, tool.backend,
                backend.id AS backend_id, backend.name AS backend_label,
                tool.query_template, tool.parameters, tool.category, tool.enabled,
                tool.tool_type, COALESCE(tool.is_write, false) AS is_write,
                COALESCE(tool.risk_level, 'low') AS risk_level,
                tool.required_auth_mode,
                CASE WHEN backend.id IS NULL THEN
                  COALESCE(ARRAY(
                    SELECT assignment.bundle_id
                      FROM mcp_tool_bundles assignment
                     WHERE assignment.tool_id = tool.id
                     ORDER BY assignment.bundle_id
                  ), '{}')::int[]
                ELSE
                  COALESCE(ARRAY(
                    SELECT assignment.bundle_id
                      FROM mcp_backend_bundles assignment
                      LEFT JOIN mcp_bundle_backend_tool_policies policy
                        ON policy.backend_id = assignment.backend_id
                       AND policy.bundle_id = assignment.bundle_id
                     WHERE assignment.backend_id = backend.id
                       AND (
                         policy.mode IS NULL
                         OR policy.mode = 'all'
                         OR tool.name = ANY(policy.allowed_tool_names)
                       )
                     ORDER BY assignment.bundle_id
                  ), '{}')::int[]
                END AS bundle_ids,
                (
                  SELECT count(*)::int
                    FROM mcp_workflows workflow
                   WHERE EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements(workflow.steps) step
                      WHERE step->>'tool' = tool.name
                   )
                ) AS workflow_count,
                EXISTS (
                  SELECT 1
                    FROM mcp_capability_source_operations source_operation
                   WHERE source_operation.tool_id = tool.id
                ) AS source_controlled,
                tool.created_at, tool.updated_at
           FROM mcp_tools tool
           LEFT JOIN mcp_backends backend
             ON tool.backend = 'custom:' || backend.name
          ORDER BY tool.category NULLS LAST, tool.name`,
      ),
      dependencies.pool.query<RemoteCapabilityDbRow>(
        `SELECT remote.id, remote.prefixed_name AS name, remote.description,
                backend.id AS backend_id, backend.name AS backend_label,
                backend.enabled AS backend_enabled, remote.input_schema,
                COALESCE(ARRAY(
                  SELECT assignment.bundle_id
                    FROM mcp_backend_bundles assignment
                    LEFT JOIN mcp_bundle_backend_tool_policies policy
                      ON policy.backend_id = assignment.backend_id
                     AND policy.bundle_id = assignment.bundle_id
                   WHERE assignment.backend_id = backend.id
                     AND (
                       policy.mode IS NULL
                       OR policy.mode = 'all'
                       OR remote.prefixed_name = ANY(policy.allowed_tool_names)
                     )
                   ORDER BY assignment.bundle_id
                ), '{}')::int[] AS bundle_ids,
                remote.discovered_at, remote.updated_at
           FROM mcp_remote_tools remote
           JOIN mcp_backends backend ON backend.id = remote.backend_id
          ORDER BY backend.name, remote.prefixed_name`,
      ),
      dependencies.pool.query<{
        id: number;
        name: string;
        label: string;
        icon: string;
      }>('SELECT id, name, label, icon FROM mcp_service_bundles ORDER BY label'),
      dependencies.pool.query<{
        id: number;
        name: string;
        description: string;
        backend_type: 'http' | 'mcp' | 'builtin';
        enabled: boolean;
      }>('SELECT id, name, description, backend_type, enabled FROM mcp_backends ORDER BY name'),
    ]);
    const managed = managedResult.rows.map(tool => ({
      id: `managed:${tool.id}`,
      managedId: tool.id,
      name: tool.name,
      description: tool.description,
      source: tool.tool_type === 'dynamic' ? 'managed' as const : 'builtin' as const,
      backend: tool.backend,
      backendId: tool.backend_id,
      backendLabel: tool.backend_label ?? (tool.backend === 'postgresql' ? 'Argus PostgreSQL' : tool.backend),
      queryTemplate: tool.query_template,
      parameters: Array.isArray(tool.parameters) ? tool.parameters : [],
      inputSchema: null,
      category: tool.category,
      enabled: tool.enabled,
      isWrite: tool.is_write,
      riskLevel: tool.risk_level,
      requiredAuthMode: tool.required_auth_mode,
      bundleIds: tool.bundle_ids,
      workflowCount: tool.workflow_count,
      managedBy: tool.source_controlled || isOpenApiCategory(tool.category) ? 'openapi' as const : null,
      editable: tool.tool_type === 'dynamic' && (
        tool.backend === 'postgresql'
        || tool.backend === 'http'
        || tool.backend.startsWith('custom:')
      ) && !tool.source_controlled && !isOpenApiCategory(tool.category),
      createdAt: isoValue(tool.created_at),
      updatedAt: isoValue(tool.updated_at),
    }));
    const remote = remoteResult.rows.map(tool => ({
      id: `remote:${tool.id}`,
      managedId: null,
      name: tool.name,
      description: tool.description,
      source: 'remote' as const,
      backend: `remote:${tool.backend_label}`,
      backendId: tool.backend_id,
      backendLabel: tool.backend_label,
      queryTemplate: null,
      parameters: [],
      inputSchema: tool.input_schema ?? {},
      category: 'Remote MCP',
      enabled: tool.backend_enabled,
      isWrite: false,
      riskLevel: 'low' as const,
      requiredAuthMode: null,
      bundleIds: tool.bundle_ids,
      workflowCount: 0,
      managedBy: null,
      editable: false,
      createdAt: isoValue(tool.discovered_at),
      updatedAt: isoValue(tool.updated_at),
    }));
    const capabilities = [...managed, ...remote].sort((left, right) => left.name.localeCompare(right.name));
    return {
      generatedAt: new Date().toISOString(),
      stats: {
        total: capabilities.length,
        active: capabilities.filter(capability => capability.enabled).length,
        managed: managed.filter(capability => capability.source === 'managed').length,
        remote: remote.length,
        writeFlagged: capabilities.filter(capability => capability.isWrite).length,
        unscoped: capabilities.filter(capability => capability.bundleIds.length === 0).length,
        disabled: capabilities.filter(capability => !capability.enabled).length,
      },
      bundles: bundleResult.rows,
      backends: backendResult.rows.map(backend => ({
        id: backend.id,
        name: backend.name,
        description: backend.description,
        type: backend.backend_type,
        enabled: backend.enabled,
      })),
      capabilities,
    };
  };

  app.get('/api/ui/mcp-fabric/capabilities', dependencies.requireAuth, async (req, res) => {
    if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können das Capability Studio öffnen')) return;
    try {
      res.json(await loadCapabilityStudio());
    } catch (error) {
      logger.error({ err: error }, 'Failed to load Capability Studio');
      res.status(500).json({ error: 'Capability Studio konnte nicht geladen werden' });
    }
  });

  app.post(
    '/api/ui/mcp-fabric/capabilities/:id/playground',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können den Capability Playground verwenden')) return;
      const capabilityId = String(req.params['id'] ?? '');
      const executeRequested = Boolean(req.body && typeof req.body === 'object'
        && (req.body as { execute?: unknown }).execute === true);
      try {
        const result = await runCapabilityPlayground(
          dependencies.pool,
          capabilityId,
          req.body as Record<string, unknown>,
        );
        const auditId = await writeAdminAudit(
          dependencies.pool,
          req,
          result.executed ? 'executed' : 'previewed',
          'capability_playground',
          String(result.capability.id),
          result.capability.name,
          null,
          {
            executed: result.executed,
            write: result.capability.isWrite,
            status: result.response?.status ?? null,
            duration_ms: result.response?.durationMs ?? null,
            truncated: result.response?.truncated ?? null,
          },
        );
        res.json({ ...result, auditId });
      } catch (error) {
        const known = error instanceof CapabilityPlaygroundError;
        const status = known ? error.status : 500;
        if (executeRequested && status === 502 && /^(?:managed:)?[1-9]\d*$/.test(capabilityId)) {
          writeAdminAudit(
            dependencies.pool,
            req,
            'execution_failed',
            'capability_playground',
            capabilityId,
            null,
            null,
            { executed: false, upstream_failed: true },
          );
        }
        if (known) {
          logger.warn({ status, capabilityId, executeRequested }, 'Capability Playground request rejected');
        } else {
          logger.error({ err: error, capabilityId, executeRequested }, 'Capability Playground request failed');
        }
        res.status(status).json({
          error: known ? error.message : 'Capability Playground konnte nicht ausgeführt werden',
        });
      }
    },
  );

  app.get(
    '/api/ui/mcp-fabric/capability-sources',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Capability Sources einsehen')) return;
      try {
        res.json(await listCapabilitySources(dependencies.pool));
      } catch (error) {
        logger.error({ err: error }, 'Capability Sources could not be loaded');
        res.status(500).json({ error: 'Capability Sources konnten nicht geladen werden' });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/capability-sources/:id/check',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Capability Sources prüfen')) return;
      const sourceId = String(req.params['id'] ?? '');
      try {
        const result = await checkCapabilitySource(dependencies.pool, sourceId, req.body);
        writeAdminAudit(
          dependencies.pool,
          req,
          'checked',
          'capability_source',
          String(result.source.id),
          result.source.prefix,
          null,
          {
            status: result.status,
            baseline_manifest_digest: result.baseline.manifestDigest,
            observed_manifest_digest: result.observed.manifestDigest,
            added: result.diff.summary.added,
            changed: result.diff.summary.changed,
            removed: result.diff.summary.removed,
            auth_changed: result.diff.summary.authChanged,
            base_url_changed: result.diff.summary.baseUrlChanged,
          },
        );
        res.json(result);
      } catch (error) {
        if (error instanceof CapabilitySourceError) {
          logger.warn({ sourceId, status: error.status, code: error.code }, 'Capability Source check rejected');
          if (!['invalid_request', 'not_found', 'baseline_required', 'source_busy', 'baseline_changed'].includes(error.code)) {
            writeAdminAudit(
              dependencies.pool,
              req,
              'check_failed',
              'capability_source',
              sourceId.slice(0, 32),
              null,
              null,
              { status: 'error', error_code: error.code },
            );
          }
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        logger.error({ err: error, sourceId }, 'Capability Source check failed');
        res.status(500).json({ error: 'Capability Source konnte nicht geprüft werden', code: 'internal_error' });
      }
    },
  );

  app.get(
    '/api/ui/mcp-fabric/capability-sources/:id/retirement',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Capability Sources stilllegen')) return;
      const sourceId = String(req.params['id'] ?? '');
      try {
        res.json(await previewOpenApiSourceRetirement(dependencies.pool, sourceId));
      } catch (error) {
        if (error instanceof OpenApiSourceRetirementError) {
          logger.warn({ sourceId, status: error.status, code: error.code }, 'Capability Source retirement preview rejected');
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        logger.error({ err: error, sourceId }, 'Capability Source retirement preview failed');
        res.status(500).json({ error: 'Retirement-Vorschau konnte nicht erstellt werden', code: 'internal_error' });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/capability-sources/:id/retire',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Capability Sources stilllegen')) return;
      const sourceId = String(req.params['id'] ?? '');
      try {
        const result = await retireOpenApiSource(dependencies.pool, sourceId, req.body);
        const warnings: string[] = [];
        try { await dependencies.refreshBackends(); }
        catch (error) {
          warnings.push('Connection cache could not be refreshed immediately');
          logger.warn({ err: error, sourceId: result.sourceId, backendId: result.backendId }, 'Retired OpenAPI source backend refresh failed');
        }
        try { await dependencies.refreshDynamicTools(); }
        catch (error) {
          warnings.push('Capability runtime catalog could not be refreshed immediately');
          logger.warn({ err: error, sourceId: result.sourceId, backendId: result.backendId }, 'Retired OpenAPI source tool refresh failed');
        }
        writeAdminAudit(
          dependencies.pool,
          req,
          'retired',
          'capability_source',
          String(result.sourceId),
          result.prefix,
          null,
          {
            backend_id: result.backendId,
            deleted_capability_count: result.deletedCapabilityCount,
            deleted_capability_ids: result.deletedCapabilities.map(capability => capability.id),
            deleted_capability_names: result.deletedCapabilities.map(capability => capability.name),
            preserved_bundle_ids: result.preservedBundleIds,
            preserved_workflow_ids: result.preservedWorkflowIds,
          },
        );
        res.json({ ...result, warnings });
      } catch (error) {
        if (error instanceof OpenApiSourceRetirementError) {
          logger.warn({ sourceId, status: error.status, code: error.code }, 'Capability Source retirement rejected');
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        logger.error({ err: error, sourceId }, 'Capability Source retirement failed');
        res.status(500).json({ error: 'Capability Source konnte nicht stillgelegt werden', code: 'internal_error' });
      }
    },
  );

  const openApiErrorStatus = (error: unknown): number => {
    const message = error instanceof Error ? error.message : '';
    const errorCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (errorCode === 'openapi_parse_failed') return 400;
    if ((typeof errorCode === 'string' && errorCode.length > 0) || message.includes('DB_ENCRYPTION_KEY')) return 500;
    if (message.includes('MB limit')) return 413;
    if (message.includes('already owned')
      || message.includes('origin changes')
      || message.includes('no longer exists')
      || message.includes('changed after preview')
      || message.includes('became owned by another source')) return 409;
    return 400;
  };

  const safeOpenApiError = (error: unknown, status: number, fallback: string) => {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (code === 'openapi_parse_failed') {
      return { message: 'OpenAPI-Spezifikation konnte nicht geparst werden', code: 'invalid_spec' };
    }
    return {
      message: status === 500 ? fallback : error instanceof Error ? error.message : fallback,
      code: status === 413 ? 'spec_too_large' : status === 409 ? 'state_conflict'
        : status === 500 ? 'internal_error' : 'invalid_request',
    };
  };

  app.post(
    '/api/ui/mcp-fabric/capabilities/openapi/preview',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können OpenAPI-Spezifikationen importieren')) return;
      try {
        const prepared = await prepareOpenApiStudioPreview(dependencies.pool, req.body as OpenApiStudioSourceInput);
        res.json(prepared.preview);
      } catch (error) {
        const status = openApiErrorStatus(error);
        const safe = safeOpenApiError(error, status, 'OpenAPI-Vorschau konnte nicht erstellt werden');
        logger.warn({ status, code: safe.code }, 'OpenAPI Studio preview failed');
        res.status(status).json({ error: safe.message });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/capabilities/openapi/import',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können OpenAPI-Spezifikationen importieren')) return;
      try {
        const body = req.body as OpenApiStudioSourceInput & {
          previewDigest?: unknown;
          selectedOperationKeys?: unknown;
          bundleIds?: unknown;
          createDefaultBundle?: unknown;
          enabled?: unknown;
          confirmWrites?: unknown;
          confirmReimport?: unknown;
          confirmRemovals?: unknown;
          acknowledgeUnsupportedAuth?: unknown;
          credential?: unknown;
          basicUser?: unknown;
          basicPassword?: unknown;
        };
        const prepared = await prepareOpenApiStudioPreview(dependencies.pool, body);
        if (typeof body.previewDigest !== 'string' || body.previewDigest !== prepared.preview.previewDigest) {
          res.status(409).json({ error: 'Die OpenAPI-Vorschau ist veraltet. Bitte Vorschau erneut laden.' });
          return;
        }
        if (!prepared.preview.existing.backendOwned) {
          res.status(409).json({ error: `Connection '${prepared.preview.prefix}' gehört nicht dem OpenAPI-Importer` });
          return;
        }
        if (!Array.isArray(body.selectedOperationKeys) || body.selectedOperationKeys.length === 0
          || body.selectedOperationKeys.length > 500
          || body.selectedOperationKeys.some(key => typeof key !== 'string' || key.length > 2_056)) {
          res.status(400).json({ error: 'Mindestens eine gültige OpenAPI-Operation muss ausgewählt werden' });
          return;
        }
        const selectedKeys = [...new Set(body.selectedOperationKeys as string[])];
        if (selectedKeys.length !== body.selectedOperationKeys.length) {
          res.status(400).json({ error: 'OpenAPI-Operationsauswahl enthält Duplikate' });
          return;
        }
        const previewByKey = new Map(prepared.preview.operations.map(operation => [operation.key, operation]));
        const mappedByKey = new Map(prepared.operations.map(operation => [`${operation.method} ${operation.path}`, operation]));
        const selectedOperations = selectedKeys.map(key => {
          const preview = previewByKey.get(key);
          const operation = mappedByKey.get(key);
          if (!preview || !operation || !preview.supported || preview.change === 'collision') {
            throw new Error(`OpenAPI operation '${key}' is unknown, unsupported or colliding`);
          }
          return operation;
        });
        if (selectedOperations.some(operation => operation.isWrite) && body.confirmWrites !== true) {
          res.status(400).json({ error: 'Schreibende OpenAPI-Operations müssen explizit bestätigt werden' });
          return;
        }
        const reimporting = prepared.preview.existing.importedToolCount > 0;
        if (reimporting && body.confirmReimport !== true) {
          res.status(409).json({ error: 'Reimport muss explizit bestätigt werden' });
          return;
        }
        if (prepared.preview.removals.length > 0 && body.confirmRemovals !== true) {
          res.status(409).json({ error: 'Entfernte Source-Operations müssen explizit bestätigt werden' });
          return;
        }
        if (prepared.preview.security.note && body.acknowledgeUnsupportedAuth !== true) {
          res.status(400).json({ error: 'Nicht vollständig unterstützte API-Authentifizierung muss bestätigt werden' });
          return;
        }
        if (prepared.preview.security.note && body.enabled === true) {
          res.status(400).json({ error: 'APIs mit nicht vollständig unterstützter Authentifizierung können nur deaktiviert importiert werden' });
          return;
        }
        if (typeof body.createDefaultBundle !== 'boolean' || typeof body.enabled !== 'boolean') {
          res.status(400).json({ error: 'Import-Aktivierung oder Default-Bundle-Einstellung ist ungültig' });
          return;
        }
        if (!Array.isArray(body.bundleIds)) {
          res.status(400).json({ error: 'Bundle-Auswahl muss als Liste übergeben werden' });
          return;
        }
        const bundleIds = [...new Set(body.bundleIds)];
        if (body.bundleIds.length > 500 || bundleIds.length > 500 || bundleIds.some(id =>
          typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647)) {
          res.status(400).json({ error: 'Bundle-Auswahl ist ungültig' });
          return;
        }
        if (!body.createDefaultBundle && bundleIds.length === 0) {
          res.status(400).json({ error: 'OpenAPI-Imports benötigen mindestens eine Bundle-Grenze' });
          return;
        }
        if (body.createDefaultBundle && !prepared.preview.existing.defaultBundleOwned) {
          res.status(409).json({ error: `Bundle '${prepared.preview.prefix}' gehört nicht dem OpenAPI-Importer` });
          return;
        }

        const credentialFields = [
          ['credential', body.credential],
          ['basicUser', body.basicUser],
          ['basicPassword', body.basicPassword],
        ] as const;
        if (credentialFields.some(([, value]) => value !== undefined && typeof value !== 'string')) {
          res.status(400).json({ error: 'OpenAPI-Credentials müssen als Text übergeben werden' });
          return;
        }
        const credential = typeof body.credential === 'string' ? body.credential : '';
        const basicUser = typeof body.basicUser === 'string' ? body.basicUser : '';
        const basicPassword = typeof body.basicPassword === 'string' ? body.basicPassword : '';
        if (credential.length > 8_192 || basicUser.length > 512 || basicPassword.length > 8_192) {
          res.status(400).json({ error: 'OpenAPI-Credential überschreitet das erlaubte Limit' });
          return;
        }
        const security = prepared.preview.security;
        const containsControlCharacter = (value: string) => /[\u0000-\u001f\u007f-\u009f]/u.test(value);
        if ((security.auth_type === 'header' || security.auth_type === 'bearer')
          && credential
          && (!credential.trim() || containsControlCharacter(credential))) {
          res.status(400).json({ error: 'API-Key- und Bearer-Credentials dürfen nicht leer sein oder Steuerzeichen enthalten' });
          return;
        }
        if (security.auth_type === 'basic' && (basicUser || basicPassword)) {
          if (!basicUser.trim() || basicUser.includes(':') || containsControlCharacter(basicUser)
            || containsControlCharacter(basicPassword)) {
            res.status(400).json({ error: 'Basic-Credentials enthalten einen ungültigen Benutzernamen oder Steuerzeichen' });
            return;
          }
        }
        let authValue: string | null = null;
        if (security.auth_type === 'header' && credential) authValue = `${security.headerName}:${credential}`;
        else if (security.auth_type === 'bearer' && credential) authValue = credential;
        else if (security.auth_type === 'basic' && basicUser) authValue = `${basicUser}:${basicPassword}`;
        const canPreserveCredential = prepared.preview.existing.credentialReusable;
        if (security.auth_type !== 'none' && authValue == null && !canPreserveCredential && body.enabled) {
          res.status(400).json({ error: 'Eine authentifizierte API kann ohne Credential nur deaktiviert importiert werden' });
          return;
        }
        const credentialMode = security.auth_type === 'none'
          ? 'clear' as const
          : authValue != null ? 'replace' as const
            : canPreserveCredential ? 'preserve' as const : 'clear' as const;
        const sourceOperationNames = prepared.preview.operations
          .filter(operation => operation.supported && operation.change !== 'collision')
          .map(operation => operation.name);
        const sourceManifest = buildOpenApiCapabilityManifest({
          prefix: prepared.preview.prefix,
          sourceKind: prepared.preview.sourceKind,
          specUrl: body.specUrl,
          title: prepared.preview.title,
          openapiVersion: prepared.preview.openapiVersion,
          baseUrl: prepared.preview.baseUrl,
          baseUrlOverridden: typeof body.baseUrl === 'string' && body.baseUrl.trim().length > 0,
          security,
          specDigest: prepared.preview.specDigest,
          operations: prepared.operations,
        });
        const result = await importOpenApi(dependencies.pool, {
          backendName: prepared.preview.prefix,
          baseUrl: prepared.preview.baseUrl,
          authType: security.auth_type,
          authValue,
          credentialMode,
          namePrefix: prepared.preview.prefix,
          operations: selectedOperations,
          sourceOperationNames,
          bundleIds,
          createDefaultBundle: body.createDefaultBundle,
          enabled: body.enabled,
          allowReimport: body.confirmReimport === true,
          allowRemoval: body.confirmRemovals === true,
          expectedRemovalNames: prepared.preview.removals.map(removal => removal.name),
          expectedRemovalImpacts: prepared.preview.removals,
          sourceManifest,
          expectedSourceRevision: prepared.preview.existing.sourceRevision,
          expectedSourceManifestDigest: prepared.preview.existing.sourceManifestDigest,
          expectedExistingBundleIds: prepared.preview.existing.assignedBundleIds,
        });

        const refreshWarnings: string[] = [];
        try { await dependencies.refreshBackends(); }
        catch (error) {
          refreshWarnings.push('Connection cache could not be refreshed immediately');
          logger.warn({ err: error, backendId: result.backendId }, 'OpenAPI import backend refresh failed after commit');
        }
        try { await dependencies.refreshDynamicTools(); }
        catch (error) {
          refreshWarnings.push('Capability runtime catalog could not be refreshed immediately');
          logger.warn({ err: error, backendId: result.backendId }, 'OpenAPI import tool refresh failed after commit');
        }
        writeAdminAudit(
          dependencies.pool,
          req,
          reimporting ? 'updated' : 'created',
          'openapi_import',
          String(result.backendId),
          prepared.preview.prefix,
          reimporting ? { imported_tool_count: prepared.preview.existing.importedToolCount } : null,
          {
            spec_digest: prepared.preview.specDigest,
            selected_operations: selectedOperations.length,
            writes: selectedOperations.filter(operation => operation.isWrite).length,
            bundle_ids: result.bundleIds,
            enabled: body.enabled,
            removed: result.removed,
          },
        );
        res.status(201).json({ ...result, warnings: refreshWarnings });
      } catch (error) {
        const status = openApiErrorStatus(error);
        const safe = safeOpenApiError(error, status, 'OpenAPI-Import fehlgeschlagen');
        logger.warn({ status, code: safe.code }, 'OpenAPI Studio import failed');
        res.status(status).json({ error: safe.message });
      }
    },
  );

  const saveManagedCapability = async (req: Request, res: Response, capabilityId?: number) => {
    if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Capabilities verändern')) return;
    let input: NormalizedCapabilityMutation;
    try {
      input = normalizeCapabilityMutation(req.body);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Capability-Daten' });
      return;
    }
    if (capabilityId != null && (!Number.isSafeInteger(capabilityId) || capabilityId < 1)) {
      res.status(400).json({ error: 'Capability-ID ist ungültig' });
      return;
    }

    const client = await dependencies.pool.connect();
    let before: ManagedCapabilityDbRow | null = null;
    let saved: { id: number; name: string; updated_at: string | Date };
    try {
      await client.query('BEGIN');
      await ensureCapabilityBundles(client, input.bundleIds);
      if (capabilityId != null) {
        before = (await client.query<ManagedCapabilityDbRow>(
          `SELECT tool.*, NULL::int AS backend_id, NULL::text AS backend_label,
                  COALESCE(ARRAY(
                    SELECT assignment.bundle_id
                      FROM mcp_tool_bundles assignment
                     WHERE assignment.tool_id = tool.id
                     ORDER BY assignment.bundle_id
                  ), '{}')::int[] AS bundle_ids,
                  0::int AS workflow_count,
                  EXISTS (
                    SELECT 1
                      FROM mcp_capability_source_operations source_operation
                     WHERE source_operation.tool_id = tool.id
                  ) AS source_controlled
             FROM mcp_tools tool
            WHERE tool.id = $1
            FOR UPDATE`,
          [capabilityId],
        )).rows[0] ?? null;
        if (!before) throw new Error('Capability nicht gefunden');
        if (before.tool_type !== 'dynamic') throw new Error('Integrierte Capabilities können nicht verändert werden');
        if (before.source_controlled || isOpenApiCategory(before.category)) {
          throw new OpenApiOwnershipError(
            'OpenAPI-importierte Capabilities können nur durch einen kontrollierten Reimport im Capability Studio verändert werden',
          );
        }
        if (isOpenApiCategory(input.category)) {
          throw new OpenApiOwnershipError('Die OpenAPI-Kategorie ist für importierte Capabilities reserviert');
        }
        if (before.name !== input.name) throw new Error('Der stabile Capability-Name kann nach der Erstellung nicht geändert werden');
        if (before.backend !== input.backend) throw new Error('Die Capability-Quelle kann nach der Erstellung nicht geändert werden');
        saved = (await client.query<{ id: number; name: string; updated_at: string | Date }>(
          `UPDATE mcp_tools SET
             description = $1,
             query_template = $2,
             parameters = $3::jsonb,
             category = $4,
             enabled = $5,
             is_write = $6,
             risk_level = $7,
             required_auth_mode = $8
           WHERE id = $9
           RETURNING id, name, updated_at`,
          [
            input.description,
            input.queryTemplate,
            JSON.stringify(input.parameters),
            input.category,
            input.enabled,
            input.isWrite,
            input.riskLevel,
            input.requiredAuthMode,
            capabilityId,
          ],
        )).rows[0]!;
      } else {
        if (isOpenApiCategory(input.category)) {
          throw new OpenApiOwnershipError('Die OpenAPI-Kategorie ist für importierte Capabilities reserviert');
        }
        saved = (await client.query<{ id: number; name: string; updated_at: string | Date }>(
          `INSERT INTO mcp_tools (
             name, description, backend, query_template, parameters, category,
             enabled, tool_type, is_write, risk_level, required_auth_mode
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'dynamic', $8, $9, $10)
           RETURNING id, name, updated_at`,
          [
            input.name,
            input.description,
            input.backend,
            input.queryTemplate,
            JSON.stringify(input.parameters),
            input.category,
            input.enabled,
            input.isWrite,
            input.riskLevel,
            input.requiredAuthMode,
          ],
        )).rows[0]!;
      }
      await syncCapabilityBundleAssignments(client, {
        toolId: saved.id,
        name: input.name,
        backend: input.backend,
        bundleIds: input.bundleIds,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof OpenApiOwnershipError) {
        res.status(409).json(openApiConflictBody(error));
        return;
      }
      const message = error instanceof Error ? error.message : 'Capability konnte nicht gespeichert werden';
      const postgresCode = (error as { code?: string }).code;
      const status = postgresCode === '23505'
        ? 409
        : message.includes('nicht gefunden') ? 404
          : message.includes('können nicht') || message.includes('kann nach') || message.includes('Bundle') || message.includes('Connected System')
            ? 400
            : 500;
      logger.error({ err: error, capabilityId }, 'Failed to save managed capability');
      res.status(status).json({
        error: postgresCode === '23505'
          ? 'Eine Capability mit diesem Namen existiert bereits'
          : message,
      });
      return;
    } finally {
      client.release();
    }

    let warning: string | null = null;
    try {
      await dependencies.refreshDynamicTools();
    } catch (error) {
      warning = 'Capability gespeichert, Runtime-Katalog konnte aber nicht sofort aktualisiert werden';
      logger.warn({ err: error, capabilityId: saved.id }, 'Capability saved but runtime refresh failed');
    }
    writeAdminAudit(
      dependencies.pool,
      req,
      before ? 'updated' : 'created',
      'mcp_tools',
      String(saved.id),
      saved.name,
      before ? capabilityAuditSnapshot(before) : null,
      capabilityAuditSnapshot(input),
    );
    res.status(before ? 200 : 201).json({
      capability: { id: saved.id, name: saved.name, updatedAt: isoValue(saved.updated_at) },
      warning,
    });
  };

  app.post(
    '/api/ui/mcp-fabric/capabilities',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => saveManagedCapability(req, res),
  );

  app.put(
    '/api/ui/mcp-fabric/capabilities/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => saveManagedCapability(req, res, Number(req.params.id)),
  );

  app.patch(
    '/api/ui/mcp-fabric/capabilities/:id/state',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Capabilities verändern')) return;
      const capabilityId = Number(req.params.id);
      if (!Number.isSafeInteger(capabilityId) || capabilityId < 1) {
        res.status(400).json({ error: 'Capability-ID ist ungültig' });
        return;
      }
      if (typeof req.body?.enabled !== 'boolean') {
        res.status(400).json({ error: 'Capability-Status ist ungültig' });
        return;
      }
      const client = await dependencies.pool.connect();
      let before: ManagedCapabilityDbRow;
      let updatedAt: string | Date;
      try {
        await client.query('BEGIN');
        const row = (await client.query<ManagedCapabilityDbRow>(
          `SELECT tool.*, NULL::int AS backend_id, NULL::text AS backend_label,
                  '{}'::int[] AS bundle_ids, 0::int AS workflow_count
             FROM mcp_tools tool
            WHERE tool.id = $1
            FOR UPDATE`,
          [capabilityId],
        )).rows[0];
        if (!row) throw new Error('Capability nicht gefunden');
        if (row.tool_type !== 'dynamic') throw new Error('Integrierte Capabilities können nicht verändert werden');
        before = row;
        updatedAt = (await client.query<{ updated_at: string | Date }>(
          'UPDATE mcp_tools SET enabled = $1 WHERE id = $2 RETURNING updated_at',
          [req.body.enabled, capabilityId],
        )).rows[0]!.updated_at;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message : 'Capability-Status konnte nicht geändert werden';
        res.status(message.includes('nicht gefunden') ? 404 : message.includes('Integrierte') ? 400 : 500).json({ error: message });
        return;
      } finally {
        client.release();
      }
      await dependencies.refreshDynamicTools().catch(error =>
        logger.warn({ err: error, capabilityId }, 'Capability state changed but runtime refresh failed'));
      writeAdminAudit(
        dependencies.pool,
        req,
        req.body.enabled ? 'enabled' : 'disabled',
        'mcp_tools',
        String(capabilityId),
        before!.name,
        capabilityAuditSnapshot(before!),
        capabilityAuditSnapshot({ ...before!, enabled: req.body.enabled }),
      );
      res.json({ ok: true, enabled: req.body.enabled, updatedAt: isoValue(updatedAt!) });
    },
  );

  app.delete(
    '/api/ui/mcp-fabric/capabilities/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePlatformAdmin(req, res, 'Nur Platform-Administratoren können Capabilities löschen')) return;
      const capabilityId = Number(req.params.id);
      if (!Number.isSafeInteger(capabilityId) || capabilityId < 1) {
        res.status(400).json({ error: 'Capability-ID ist ungültig' });
        return;
      }
      if (typeof req.body?.confirmName !== 'string' || !req.body.confirmName.trim()) {
        res.status(400).json({ error: 'Capability-Name muss zum Löschen bestätigt werden' });
        return;
      }
      const client = await dependencies.pool.connect();
      let before: ManagedCapabilityDbRow;
      try {
        await client.query('BEGIN');
        const row = (await client.query<ManagedCapabilityDbRow>(
          `SELECT tool.*, NULL::int AS backend_id, NULL::text AS backend_label,
                  COALESCE(ARRAY(
                    SELECT assignment.bundle_id FROM mcp_tool_bundles assignment
                     WHERE assignment.tool_id = tool.id ORDER BY assignment.bundle_id
                  ), '{}')::int[] AS bundle_ids,
                  0::int AS workflow_count,
                  EXISTS (
                    SELECT 1
                      FROM mcp_capability_source_operations source_operation
                     WHERE source_operation.tool_id = tool.id
                  ) AS source_controlled
             FROM mcp_tools tool
            WHERE tool.id = $1
            FOR UPDATE`,
          [capabilityId],
        )).rows[0];
        if (!row) throw new Error('Capability nicht gefunden');
        if (row.tool_type !== 'dynamic') throw new Error('Integrierte Capabilities können nicht gelöscht werden');
        if (row.source_controlled || isOpenApiCategory(row.category)) {
          throw new OpenApiOwnershipError(
            'OpenAPI-importierte Capabilities können nur über ihre Quelle im Capability Studio stillgelegt werden',
          );
        }
        if (req.body.confirmName.trim() !== row.name) throw new Error('Capability-Name stimmt nicht überein');
        const workflows = await client.query<{ id: number; name: string }>(
          `SELECT workflow.id, workflow.name
             FROM mcp_workflows workflow
            WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(workflow.steps) step
               WHERE step->>'tool' = $1
            )
            ORDER BY workflow.name
            LIMIT 6`,
          [row.name],
        );
        if (workflows.rows.length > 0) {
          throw new Error(`Capability wird noch von ${workflows.rows.map(workflow => workflow.name).join(', ')} verwendet`);
        }
        before = row;
        await client.query('DELETE FROM mcp_tools WHERE id = $1', [capabilityId]);
        await cleanDeletedCapabilityPolicies(client, row.backend, row.name);
        await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof OpenApiOwnershipError) {
        res.status(409).json(openApiConflictBody(error));
        return;
      }
      const message = error instanceof Error ? error.message : 'Capability konnte nicht gelöscht werden';
        const status = message.includes('nicht gefunden') ? 404
          : message.includes('verwendet') ? 409
            : message.includes('Integrierte') || message.includes('stimmt nicht') ? 400
              : 500;
        res.status(status).json({ error: message });
        return;
      } finally {
        client.release();
      }
      await dependencies.refreshDynamicTools().catch(error =>
        logger.warn({ err: error, capabilityId }, 'Capability deleted but runtime refresh failed'));
      writeAdminAudit(
        dependencies.pool,
        req,
        'deleted',
        'mcp_tools',
        String(capabilityId),
        before!.name,
        capabilityAuditSnapshot(before!),
        null,
      );
      res.json({ ok: true });
    },
  );

  const saveManagedBundle = async (
    req: Request,
    res: Response,
    bundleId?: number,
  ) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Nicht authentifiziert' });
      return;
    }
    if (!hasRole(user.role, 'platform_admin')) {
      res.status(403).json({ error: 'Nur Platform-Administratoren können Bundles verändern' });
      return;
    }
    let input: NormalizedFabricBundleMutation;
    try {
      input = normalizeFabricBundleMutation(req.body as FabricBundleMutationInput, bundleId == null);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Bundle-Daten' });
      return;
    }
    if (bundleId != null && (!Number.isSafeInteger(bundleId) || bundleId < 1)) {
      res.status(400).json({ error: 'Ungültige Bundle-ID' });
      return;
    }

    const before = bundleId == null ? null : await getBundle(dependencies.pool, bundleId);
    const client = await dependencies.pool.connect();
    try {
      await client.query('BEGIN');
      const existingBackends = input.backendIds.length === 0
        ? []
        : (await client.query<{ id: number }>(
          'SELECT id FROM mcp_backends WHERE id = ANY($1::int[]) FOR SHARE',
          [input.backendIds],
        )).rows.map(row => row.id);
      if (existingBackends.length !== input.backendIds.length) {
        throw new Error('Mindestens ein ausgewähltes Backend existiert nicht mehr');
      }
      const existingSkills = input.skillIds.length === 0
        ? []
        : (await client.query<{ id: number }>(
          'SELECT id FROM mcp_skills WHERE id = ANY($1::int[]) FOR SHARE',
          [input.skillIds],
        )).rows.map(row => row.id);
      if (existingSkills.length !== input.skillIds.length) {
        throw new Error('Mindestens ein ausgewählter Skill existiert nicht mehr');
      }

      let saved;
      if (bundleId == null) {
        const result = await client.query(
          `INSERT INTO mcp_service_bundles (name, label, description, icon, system_prompt, agent_role)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [input.name, input.label, input.description, input.icon, input.systemPrompt, input.agentRole],
        );
        saved = result.rows[0];
        bundleId = Number(saved.id);
      } else {
        const result = await client.query(
          `UPDATE mcp_service_bundles
              SET label = $1, description = $2, icon = $3, system_prompt = $4, agent_role = $5
            WHERE id = $6
            RETURNING *`,
          [input.label, input.description, input.icon, input.systemPrompt, input.agentRole, bundleId],
        );
        if (!result.rows[0]) throw new Error(`Bundle ${bundleId} nicht gefunden`);
        saved = result.rows[0];
      }

      // Keep the legacy assignment semantics: backend-owned dynamic tools follow
      // the backend into or out of this bundle. Other bundle memberships remain untouched.
      await client.query(
        `DELETE FROM mcp_tool_bundles tb
          USING mcp_tools t
          WHERE tb.tool_id = t.id
            AND tb.bundle_id = $1
            AND EXISTS (
              SELECT 1 FROM mcp_backends b
               WHERE t.backend = b.name OR t.backend = 'custom:' || b.name
            )`,
        [bundleId],
      );
      await client.query('DELETE FROM mcp_backend_bundles WHERE bundle_id = $1', [bundleId]);
      if (input.backendIds.length > 0) {
        await client.query(
          `INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
           SELECT unnest($1::int[]), $2::int`,
          [input.backendIds, bundleId],
        );
        for (const policy of input.toolPolicies) {
          await client.query(
            `INSERT INTO mcp_bundle_backend_tool_policies (
               backend_id, bundle_id, mode, allowed_tool_names
             ) VALUES ($1, $2, $3, $4)
             ON CONFLICT (backend_id, bundle_id) DO UPDATE SET
               mode = EXCLUDED.mode,
               allowed_tool_names = EXCLUDED.allowed_tool_names,
               updated_at = now()`,
            [policy.backendId, bundleId, policy.mode, policy.allowedToolNames],
          );
        }
        await client.query(
          `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
           SELECT DISTINCT t.id, $2::int
             FROM mcp_tools t
             JOIN mcp_backends b ON t.backend = b.name OR t.backend = 'custom:' || b.name
             LEFT JOIN mcp_bundle_backend_tool_policies policy
               ON policy.backend_id = b.id AND policy.bundle_id = $2::int
            WHERE b.id = ANY($1::int[])
              AND (
                policy.mode IS NULL
                OR policy.mode = 'all'
                OR t.name = ANY(policy.allowed_tool_names)
              )
           ON CONFLICT DO NOTHING`,
          [input.backendIds, bundleId],
        );
      }
      await client.query('DELETE FROM mcp_bundle_skills WHERE bundle_id = $1', [bundleId]);
      for (let position = 0; position < input.skillIds.length; position++) {
        await client.query(
          `INSERT INTO mcp_bundle_skills (bundle_id, skill_id, position)
           VALUES ($1, $2, $3)`,
          [bundleId, input.skillIds[position], position],
        );
      }
      await client.query('COMMIT');

      await dependencies.refreshBackends();
      writeAdminAudit(
        dependencies.pool,
        req,
        before ? 'updated' : 'created',
        'mcp_service_bundles',
        String(bundleId),
        input.label,
        before,
        {
          ...saved,
          backend_ids: input.backendIds,
          skill_ids: input.skillIds,
          tool_policies: input.toolPolicies,
        },
      );
      res.status(before ? 200 : 201).json({
        bundle: saved,
        backendIds: input.backendIds,
        toolPolicies: input.toolPolicies,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const postgresCode = (error as { code?: string }).code;
      const notFound = error instanceof Error && error.message.includes('nicht gefunden');
      const invalidAssignment = error instanceof Error
        && (error.message.includes('Backend') || error.message.includes('Skill'));
      const status = postgresCode === '23505' ? 409 : notFound ? 404 : invalidAssignment ? 400 : 500;
      logger.error({ err: error, bundleId }, 'Failed to save managed MCP bundle');
      res.status(status).json({
        error: postgresCode === '23505'
          ? 'Ein Bundle mit diesem internen Namen existiert bereits'
          : error instanceof Error ? error.message : 'Bundle konnte nicht gespeichert werden',
      });
    } finally {
      client.release();
    }
  };

  app.get(
    '/api/ui/mcp-fabric/profiles',
    dependencies.requireAuth,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      try {
        const { profiles, groups } = await observeFabricProfileOperation('list', async telemetry => {
          const [loadedProfiles, loadedGroups] = await Promise.all([
            listFabricProfiles(dependencies.pool),
            listFabricProfileSsoGroups(dependencies.pool),
          ]);
          telemetry.setAttributes({
            'argus.fabric_profile.profile_count': loadedProfiles.length,
            'argus.fabric_profile.sso_group_count': loadedGroups.length,
          });
          return { profiles: loadedProfiles, groups: loadedGroups };
        });
        res.json({ profiles, groups });
      } catch (error) {
        logger.error({ err: error }, 'Failed to list MCP Fabric profiles');
        res.status(500).json({ error: 'Bundle Sets konnten nicht geladen werden' });
      }
    },
  );

  app.get(
    '/api/ui/mcp-fabric/profiles/:id/versions',
    dependencies.requireAuth,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      const profileId = Number(req.params.id);
      if (!Number.isSafeInteger(profileId) || profileId < 1) {
        res.status(400).json({ error: 'Bundle Set ID ist ungültig' });
        return;
      }
      try {
        const versions = await observeFabricProfileOperation('versions', async telemetry => {
          const loaded = await listFabricProfileVersions(dependencies.pool, profileId);
          telemetry.setAttributes({
            'argus.fabric_profile.id': profileId,
            'argus.fabric_profile.version_count': loaded.length,
          });
          return loaded;
        });
        if (versions.length === 0) {
          res.status(404).json({ error: 'Bundle Set oder Versionshistorie wurde nicht gefunden' });
          return;
        }
        res.json({ versions });
      } catch (error) {
        logger.error({ err: error, profileId }, 'Failed to list MCP Fabric profile versions');
        res.status(500).json({ error: 'Bundle Set Versionshistorie konnte nicht geladen werden' });
      }
    },
  );

  app.get(
    '/api/ui/mcp-fabric/profiles/:id/versions/diff',
    dependencies.requireAuth,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      const profileId = Number(req.params.id);
      const fromRevision = Number(req.query.from);
      const toRevision = Number(req.query.to);
      if (![profileId, fromRevision, toRevision].every(value => Number.isSafeInteger(value) && value > 0)
        || fromRevision === toRevision) {
        res.status(400).json({ error: 'Bundle Set ID und zwei unterschiedliche Revisionen sind erforderlich' });
        return;
      }
      try {
        const diff = await observeFabricProfileOperation('diff', async telemetry => {
          const result = await diffFabricProfileVersions(dependencies.pool, profileId, fromRevision, toRevision);
          telemetry.setAttributes({
            'argus.fabric_profile.id': profileId,
            'argus.fabric_profile.from_revision': fromRevision,
            'argus.fabric_profile.to_revision': toRevision,
            'argus.fabric_profile.change_count': result?.counts.total ?? 0,
          });
          return result;
        });
        if (!diff) {
          res.status(404).json({ error: 'Mindestens eine Bundle Set Revision wurde nicht gefunden' });
          return;
        }
        res.json({ diff });
      } catch (error) {
        logger.error({ err: error, profileId, fromRevision, toRevision }, 'Failed to diff MCP Fabric profile versions');
        res.status(500).json({ error: 'Bundle Set Versionsvergleich konnte nicht geladen werden' });
      }
    },
  );

  app.get(
    '/api/ui/mcp-fabric/profiles/restores',
    dependencies.requireAuth,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      const profileId = req.query.profileId == null ? undefined : Number(req.query.profileId);
      if (profileId !== undefined && (!Number.isSafeInteger(profileId) || profileId < 1)) {
        res.status(400).json({ error: 'Bundle Set ID ist ungültig' });
        return;
      }
      try {
        res.json({ requests: await listFabricProfileRestoreRequests(dependencies.pool, profileId) });
      } catch (error) {
        logger.error({ err: error, profileId }, 'Failed to list MCP Fabric profile restore requests');
        res.status(500).json({ error: 'Restore-Anfragen konnten nicht geladen werden' });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/profiles/:id/restores',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = requirePolicyAdmin(req, res);
      if (!user) return;
      try {
        const profileId = Number(req.params.id);
        const body = req.body as Record<string, unknown>;
        const request = await requestFabricProfileRestore(dependencies.pool, {
          profileId,
          targetRevision: Number(body.targetRevision),
          mappings: body.mappings && typeof body.mappings === 'object' && !Array.isArray(body.mappings)
            ? body.mappings as { backends?: Record<string, string>; skills?: Record<string, string>; groups?: Record<string, string> }
            : {},
          planToken: typeof body.planToken === 'string' ? body.planToken : '',
          requestedBy: user.id,
          requestedByUsername: user.username,
          comment: typeof body.comment === 'string' ? body.comment : '',
        });
        writeAdminAudit(dependencies.pool, req, 'restore_requested', 'mcp_fabric_profiles', String(profileId), request.profileLabel, null, {
          restore_request_id: request.id,
          from_revision: request.requestedFromRevision,
          target_revision: request.targetRevision,
          target_manifest_digest: request.targetManifestDigest,
          plan_binding_digest: createHash('sha256').update(request.planToken).digest('hex'),
        });
        res.status(201).json({ request });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Restore-Anfrage konnte nicht erstellt werden';
        res.status(/not found/i.test(message) ? 404 : /open restore/i.test(message) ? 409 : 400).json({ error: message });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/profiles/restores/:requestId/decision',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = requirePolicyAdmin(req, res);
      if (!user) return;
      try {
        const body = req.body as Record<string, unknown>;
        const decision = body.decision;
        if (decision !== 'approved' && decision !== 'rejected') {
          res.status(400).json({ error: 'decision must be approved or rejected' });
          return;
        }
        const request = await decideFabricProfileRestore(dependencies.pool, {
          requestId: String(req.params.requestId),
          decision,
          actorId: user.id,
          actorUsername: user.username,
          comment: typeof body.comment === 'string' ? body.comment : '',
        });
        writeAdminAudit(dependencies.pool, req, `restore_${decision}`, 'mcp_fabric_profiles', String(request.profileId), request.profileLabel, null, {
          restore_request_id: request.id,
          target_revision: request.targetRevision,
          target_manifest_digest: request.targetManifestDigest,
          decision_comment: request.decisionComment,
        });
        res.json({ request });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Restore-Entscheidung konnte nicht gespeichert werden';
        res.status(/not found/i.test(message) ? 404 : /different policy admin|no longer pending/i.test(message) ? 409 : 400).json({ error: message });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/profiles/restores/:requestId/apply',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = requirePolicyAdmin(req, res);
      if (!user) return;
      try {
        const result = await applyApprovedFabricProfileRestore(dependencies.pool, {
          requestId: String(req.params.requestId),
          actor: user.username,
        });
        await dependencies.refreshBackends();
        writeAdminAudit(dependencies.pool, req, 'restore_applied', 'mcp_fabric_profiles', String(result.profile.id), result.profile.label, null, {
          restore_request_id: result.restoreRequest.id,
          restored_from_revision: result.restoreRequest.targetRevision,
          new_head_revision: result.profile.revision,
          manifest_digest: result.profile.manifestDigest,
          bundle_ids: result.bundleIds,
        });
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Restore konnte nicht angewendet werden';
        res.status(/not found/i.test(message) ? 404 : /stale|approved|digest/i.test(message) ? 409 : 400).json({ error: message });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/profiles/export',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = requirePolicyAdmin(req, res);
      if (!user) return;
      try {
        const body = req.body as Record<string, unknown>;
        const bundleIds = Array.isArray(body.bundleIds) ? body.bundleIds.map(Number) : [];
        const lifecycleAudit = buildUserLifecycleAuditContext(req, user);
        const audited = await observeFabricProfileOperation('export', async telemetry => {
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          telemetry.setAttributes({
            'argus.fabric_profile.name': name,
            'argus.fabric_profile.bundle_count': bundleIds.length,
          });
          return exportFabricProfileAudited(dependencies.pool, {
            name,
            label: typeof body.label === 'string' ? body.label.trim() : '',
            description: typeof body.description === 'string' ? body.description.trim() : '',
            version: typeof body.version === 'string' ? body.version.trim() : '1.0.0',
            bundleIds,
            createComposite: body.createComposite !== false,
            groupBindings: Array.isArray(body.groupBindings)
              ? body.groupBindings as Array<{ logicalName: string; required?: boolean }>
              : [],
            actor: user.username,
            audit: { ...lifecycleAudit, ...resolveFabricProfileCorrelation(req.headers.traceparent, telemetry) },
          });
        });
        const profile = audited.profile;
        writeAdminAudit(
          dependencies.pool,
          req,
          'exported',
          'mcp_fabric_profiles',
          String(profile.id),
          profile.label,
          null,
          {
            name: profile.name,
            version: profile.manifestVersion,
            revision: profile.revision,
            manifest_digest: profile.manifestDigest,
            bundle_ids: profile.installedBundleIds,
          },
        );
        res.status(201).json({ profile });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Bundle Set konnte nicht erstellt werden';
        const status = /must|required|invalid|select|exist|exceed|contain|semantic/i.test(message) ? 400 : 500;
        if (status === 500) logger.error({ err: error }, 'Failed to export MCP Fabric profile');
        res.status(status).json({ error: message });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/profiles/import/preview',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      try {
        const user = (req as AuthenticatedRequest).user!;
        const body = req.body as Record<string, unknown>;
        const mappings = body.mappings && typeof body.mappings === 'object' && !Array.isArray(body.mappings)
          ? body.mappings as { backends?: Record<string, string>; skills?: Record<string, string>; groups?: Record<string, string> }
          : {};
        const lifecycleAudit = buildUserLifecycleAuditContext(req, user);
        const audited = await observeFabricProfileOperation('preview', async telemetry => {
          const result = await planFabricProfileImportAudited(
            dependencies.pool,
            body.manifest,
            mappings,
            { ...lifecycleAudit, ...resolveFabricProfileCorrelation(req.headers.traceparent, telemetry) },
          );
          telemetry.setAttributes({
            'argus.fabric_profile.name': result.plan.manifest.metadata.name,
            'argus.fabric_profile.action_count': result.plan.actions.length,
            'argus.fabric_profile.blocker_count': result.plan.blockers.length,
          });
          return result;
        });
        const plan = audited.plan;
        res.json({ plan });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Bundle Set ist ungültig';
        res.status(400).json({ error: message });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/profiles/import/apply',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = requirePolicyAdmin(req, res);
      if (!user) return;
      try {
        const body = req.body as Record<string, unknown>;
        const mappings = body.mappings && typeof body.mappings === 'object' && !Array.isArray(body.mappings)
          ? body.mappings as { backends?: Record<string, string>; skills?: Record<string, string>; groups?: Record<string, string> }
          : {};
        const lifecycleAudit = buildUserLifecycleAuditContext(req, user);
        const result = await observeFabricProfileOperation('apply', async telemetry => {
          const applied = await applyFabricProfileAudited(dependencies.pool, {
            manifest: body.manifest,
            mappings,
            planToken: typeof body.planToken === 'string' ? body.planToken : '',
            actor: user.username,
            audit: { ...lifecycleAudit, ...resolveFabricProfileCorrelation(req.headers.traceparent, telemetry) },
          });
          telemetry.setAttributes({
            'argus.fabric_profile.name': applied.profile.name,
            'argus.fabric_profile.bundle_count': applied.bundleIds.length,
            'argus.fabric_profile.sso_binding_count': applied.groupBindings.length,
            'argus.audit.event_id': applied.auditEvent.eventId,
          });
          return applied;
        });
        await dependencies.refreshBackends();
        writeAdminAudit(
          dependencies.pool,
          req,
          'applied',
          'mcp_fabric_profiles',
          String(result.profile.id),
          result.profile.label,
          null,
          {
            name: result.profile.name,
            version: result.profile.manifestVersion,
            revision: result.profile.revision,
            manifest_digest: result.profile.manifestDigest,
            bundle_ids: result.bundleIds,
            composite_id: result.compositeId,
            group_bindings: result.groupBindings.map(binding => ({
              logical_name: binding.logicalName,
              group_name: binding.groupName,
              composite_id: binding.compositeId,
            })),
          },
        );
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Bundle Set konnte nicht angewendet werden';
        const status = /stale|requires|unavailable|not installed|cannot contain|invalid|must |unknown|exceeds/i.test(message) ? 409 : 500;
        if (status === 500) logger.error({ err: error }, 'Failed to apply MCP Fabric profile');
        res.status(status).json({ error: message });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/profiles/:id/drift/check',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = requirePolicyAdmin(req, res);
      if (!user) return;
      const profileId = Number(req.params.id);
      if (!Number.isSafeInteger(profileId) || profileId < 1) {
        res.status(400).json({ error: 'Bundle Set ID ist ungültig' });
        return;
      }
      try {
        const lifecycleAudit = buildUserLifecycleAuditContext(req, user);
        const result = await observeFabricProfileOperation('drift_check', async telemetry => {
          const checked = await checkFabricProfileDriftAudited(
            dependencies.pool,
            profileId,
            { ...lifecycleAudit, ...resolveFabricProfileCorrelation(req.headers.traceparent, telemetry) },
          );
          recordFabricProfileDriftFindings(checked.drift.status, checked.drift.counts.total);
          telemetry.setAttributes({
            'argus.fabric_profile.id': profileId,
            'argus.audit.event_id': checked.auditEvent.eventId,
          });
          return checked;
        });
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Bundle Set Drift konnte nicht geprüft werden';
        const status = /not found/i.test(message) ? 404 : 500;
        if (status === 500) logger.error({ err: error, profileId }, 'Failed to check MCP Fabric profile drift');
        res.status(status).json({ error: message });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/bundles',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => saveManagedBundle(req, res),
  );

  app.put(
    '/api/ui/mcp-fabric/bundles/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => saveManagedBundle(req, res, Number(req.params.id)),
  );

  app.post(
    '/api/ui/mcp-fabric/tool-assignments',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      let input: ReturnType<typeof normalizeFabricToolAssignment>;
      try {
        input = normalizeFabricToolAssignment(req.body as FabricToolAssignmentInput);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Tool-Zuordnung' });
        return;
      }

      const client = await dependencies.pool.connect();
      try {
        await client.query('BEGIN');
        const bundle = (await client.query<{ label: string }>(
          'SELECT label FROM mcp_service_bundles WHERE id = $1 FOR UPDATE',
          [input.bundleId],
        )).rows[0];
        if (!bundle) throw new Error('Bundle nicht gefunden');

        const requestedBackendIds = [...new Set(input.tools
          .map(tool => tool.backendId)
          .filter((backendId): backendId is number => backendId != null))];
        const requestedDirectNames = input.tools
          .filter(tool => tool.backendId == null)
          .map(tool => tool.name);
        const availableTools = await client.query<{ backend_id: number | null; name: string; tool_id: number | null }>(
          `SELECT b.id AS backend_id, tool.name, tool.id AS tool_id
             FROM mcp_tools tool
             LEFT JOIN mcp_backends b
               ON tool.backend = b.name OR tool.backend = 'custom:' || b.name
            WHERE tool.enabled = true
              AND (
                b.id = ANY($1::int[])
                OR (b.id IS NULL AND tool.name = ANY($2::text[]))
              )
           UNION
           SELECT remote.backend_id, remote.prefixed_name AS name, NULL::int AS tool_id
             FROM mcp_remote_tools remote
            WHERE remote.backend_id = ANY($1::int[])`,
          [requestedBackendIds, requestedDirectNames],
        );
        const availableKeys = new Set(availableTools.rows.map(tool =>
          `${tool.backend_id ?? 'direct'}:${tool.name}`,
        ));
        if (input.tools.some(tool =>
          !availableKeys.has(`${tool.backendId ?? 'direct'}:${tool.name}`),
        )) {
          throw new Error('Mindestens ein ausgewähltes Tool existiert nicht mehr oder ist deaktiviert');
        }

        const before = await client.query<{
          backend_id: number;
          mode: BundleToolPolicyMode | null;
          allowed_tool_names: string[] | null;
        }>(
          `SELECT backend.id AS backend_id, policy.mode, policy.allowed_tool_names
             FROM unnest($1::int[]) AS backend(id)
             LEFT JOIN mcp_bundle_backend_tool_policies policy
               ON policy.backend_id = backend.id AND policy.bundle_id = $2
            ORDER BY backend.id`,
          [requestedBackendIds, input.bundleId],
        );

        const directTools = availableTools.rows.filter(tool => tool.backend_id == null && tool.tool_id != null);
        for (const tool of directTools) {
          await client.query(
            `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [tool.tool_id, input.bundleId],
          );
        }

        for (const backendId of requestedBackendIds) {
          const requestedNames = input.tools
            .filter(tool => tool.backendId === backendId)
            .map(tool => tool.name);
          const allBackendNames = availableTools.rows
            .filter(tool => tool.backend_id === backendId)
            .map(tool => tool.name);
          const wasAssigned = (await client.query<{ assigned: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM mcp_backend_bundles
                WHERE backend_id = $1 AND bundle_id = $2
             ) AS assigned`,
            [backendId, input.bundleId],
          )).rows[0]?.assigned === true;
          const existingPolicy = (await client.query<{
            mode: BundleToolPolicyMode;
            allowed_tool_names: string[];
          }>(
            `SELECT mode, allowed_tool_names
               FROM mcp_bundle_backend_tool_policies
              WHERE backend_id = $1 AND bundle_id = $2
              FOR UPDATE`,
            [backendId, input.bundleId],
          )).rows[0];

          await client.query(
            `INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [backendId, input.bundleId],
          );

          if (wasAssigned && (!existingPolicy || existingPolicy.mode === 'all')) continue;
          const nextNames = [...new Set([
            ...(existingPolicy?.allowed_tool_names ?? []),
            ...requestedNames,
          ])].sort();
          if (nextNames.length >= allBackendNames.length) {
            await client.query(
              `DELETE FROM mcp_bundle_backend_tool_policies
                WHERE backend_id = $1 AND bundle_id = $2`,
              [backendId, input.bundleId],
            );
          } else {
            await client.query(
              `INSERT INTO mcp_bundle_backend_tool_policies (
                 backend_id, bundle_id, mode, allowed_tool_names
               ) VALUES ($1, $2, 'selected', $3)
               ON CONFLICT (backend_id, bundle_id) DO UPDATE
                 SET mode = 'selected', allowed_tool_names = EXCLUDED.allowed_tool_names`,
              [backendId, input.bundleId, nextNames],
            );
          }
        }

        await client.query('COMMIT');
        await dependencies.refreshBackends();
        writeAdminAudit(
          dependencies.pool,
          req,
          'updated',
          'mcp_bundle_tool_assignments',
          String(input.bundleId),
          bundle.label,
          before.rows,
          { bundle_id: input.bundleId, tools: input.tools },
        );
        res.json({
          ok: true,
          bundleId: input.bundleId,
          assigned: input.tools.length,
        });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message : 'Tools konnten nicht zugeordnet werden';
        const status = message.includes('nicht gefunden') || message.includes('existiert nicht mehr') ? 404 : 500;
        logger.error({ err: error, bundleId: input.bundleId }, 'Failed to bulk-assign Fabric tools');
        res.status(status).json({ error: message });
      } finally {
        client.release();
      }
    },
  );

  app.patch(
    '/api/ui/mcp-fabric/bundles/:id/tools',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requirePolicyAdmin(req, res)) return;
      const sourceBundleId = Number(req.params.id);
      let input: ReturnType<typeof normalizeFabricToolTransfer>;
      try {
        input = normalizeFabricToolTransfer(req.body as FabricToolTransferInput, sourceBundleId);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Tool-Änderung' });
        return;
      }

      const client = await dependencies.pool.connect();
      try {
        await client.query('BEGIN');
        const lockedBundleIds = [sourceBundleId, ...(input.targetBundleId == null ? [] : [input.targetBundleId])]
          .sort((a, b) => a - b);
        const bundles = await client.query<{ id: number; label: string }>(
          `SELECT id, label FROM mcp_service_bundles
            WHERE id = ANY($1::int[])
            ORDER BY id
            FOR UPDATE`,
          [lockedBundleIds],
        );
        if (!bundles.rows.some(bundle => bundle.id === sourceBundleId)) throw new Error('Quell-Bundle nicht gefunden');
        if (input.targetBundleId != null && !bundles.rows.some(bundle => bundle.id === input.targetBundleId)) {
          throw new Error('Ziel-Bundle nicht gefunden');
        }

        const backendIds = [...new Set(input.tools
          .map(tool => tool.backendId)
          .filter((backendId): backendId is number => backendId != null))];
        const directNames = input.tools.filter(tool => tool.backendId == null).map(tool => tool.name);
        const catalogResult = await client.query<{
          backend_id: number;
          name: string;
          tool_id: number | null;
        }>(
          `SELECT b.id AS backend_id, tool.name, tool.id AS tool_id
             FROM mcp_tools tool
             JOIN mcp_backends b
               ON tool.backend = b.name OR tool.backend = 'custom:' || b.name
            WHERE b.id = ANY($1::int[])
           UNION
           SELECT remote.backend_id, remote.prefixed_name AS name, NULL::int AS tool_id
             FROM mcp_remote_tools remote
            WHERE remote.backend_id = ANY($1::int[])`,
          [backendIds],
        );
        const catalogByBackend = new Map<number, string[]>();
        for (const tool of catalogResult.rows) {
          const names = catalogByBackend.get(tool.backend_id) ?? [];
          if (!names.includes(tool.name)) names.push(tool.name);
          catalogByBackend.set(tool.backend_id, names);
        }

        const sourcePolicies = backendIds.length === 0 ? { rows: [] } : await client.query<{
          backend_id: number;
          mode: BundleToolPolicyMode;
          allowed_tool_names: string[];
        }>(
          `SELECT bb.backend_id,
                  COALESCE(policy.mode, 'all')::text AS mode,
                  COALESCE(policy.allowed_tool_names, '{}')::text[] AS allowed_tool_names
             FROM mcp_backend_bundles bb
             LEFT JOIN mcp_bundle_backend_tool_policies policy
               ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
            WHERE bb.bundle_id = $1 AND bb.backend_id = ANY($2::int[])`,
          [sourceBundleId, backendIds],
        );
        const sourcePolicyByBackend = new Map(sourcePolicies.rows.map(policy => [policy.backend_id, policy]));

        const directTools = directNames.length === 0 ? { rows: [] } : await client.query<{
          id: number;
          name: string;
          bundle_count: number;
        }>(
          `SELECT tool.id, tool.name,
                  (SELECT count(*)::int FROM mcp_tool_bundles all_assignments
                    WHERE all_assignments.tool_id = tool.id) AS bundle_count
             FROM mcp_tools tool
             JOIN mcp_tool_bundles assignment ON assignment.tool_id = tool.id
            WHERE assignment.bundle_id = $1 AND tool.name = ANY($2::text[])
            FOR UPDATE OF assignment`,
          [sourceBundleId, directNames],
        );
        const directByName = new Map(directTools.rows.map(tool => [tool.name, tool.id]));

        if (input.action === 'remove') {
          const unsafeRemoval = directTools.rows.find(tool => tool.bundle_count <= 1);
          if (unsafeRemoval) {
            throw new Error(
              `Die letzte direkte Zuweisung von ${unsafeRemoval.name} kann nicht entfernt werden, weil das Tool sonst global unscoped wäre. Verschiebe es stattdessen.`,
            );
          }
        }

        for (const tool of input.tools) {
          if (tool.backendId == null) {
            if (!directByName.has(tool.name)) throw new Error(`Tool ${tool.name} ist nicht mehr direkt im Quell-Bundle`);
            continue;
          }
          const catalog = catalogByBackend.get(tool.backendId) ?? [];
          const policy = sourcePolicyByBackend.get(tool.backendId);
          if (!policy || !catalog.includes(tool.name)) throw new Error(`Tool ${tool.name} ist nicht mehr im Quell-Bundle`);
          if (policy.mode === 'selected' && !policy.allowed_tool_names.includes(tool.name)) {
            throw new Error(`Tool ${tool.name} ist durch die Quell-Policy nicht freigegeben`);
          }
        }

        const persistPolicy = async (
          bundleId: number,
          backendId: number,
          policy: ReturnType<typeof mutateBundleToolPolicy>,
        ) => {
          if (policy.mode === 'all') {
            await client.query(
              'DELETE FROM mcp_bundle_backend_tool_policies WHERE backend_id = $1 AND bundle_id = $2',
              [backendId, bundleId],
            );
            return;
          }
          await client.query(
            `INSERT INTO mcp_bundle_backend_tool_policies (backend_id, bundle_id, mode, allowed_tool_names)
             VALUES ($1, $2, 'selected', $3)
             ON CONFLICT (backend_id, bundle_id) DO UPDATE
               SET mode = 'selected', allowed_tool_names = EXCLUDED.allowed_tool_names, updated_at = now()`,
            [backendId, bundleId, policy.allowedToolNames],
          );
        };

        if (directTools.rows.length > 0) {
          await client.query(
            'DELETE FROM mcp_tool_bundles WHERE bundle_id = $1 AND tool_id = ANY($2::int[])',
            [sourceBundleId, directTools.rows.map(tool => tool.id)],
          );
        }
        for (const backendId of backendIds) {
          const sourcePolicy = sourcePolicyByBackend.get(backendId)!;
          const changedNames = input.tools.filter(tool => tool.backendId === backendId).map(tool => tool.name);
          await persistPolicy(sourceBundleId, backendId, mutateBundleToolPolicy(
            catalogByBackend.get(backendId) ?? [],
            sourcePolicy.mode,
            sourcePolicy.allowed_tool_names,
            changedNames,
            'remove',
          ));
          await client.query(
            `DELETE FROM mcp_tool_bundles assignment
              USING mcp_tools tool
              WHERE assignment.tool_id = tool.id
                AND assignment.bundle_id = $1
                AND tool.name = ANY($2::text[])`,
            [sourceBundleId, changedNames],
          );
        }

        if (input.action === 'move' && input.targetBundleId != null) {
          if (directTools.rows.length > 0) {
            await client.query(
              `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
               SELECT unnest($1::int[]), $2::int
               ON CONFLICT DO NOTHING`,
              [directTools.rows.map(tool => tool.id), input.targetBundleId],
            );
          }
          const targetPolicies = backendIds.length === 0 ? { rows: [] } : await client.query<{
            backend_id: number;
            mode: BundleToolPolicyMode;
            allowed_tool_names: string[];
          }>(
            `SELECT bb.backend_id,
                    COALESCE(policy.mode, 'all')::text AS mode,
                    COALESCE(policy.allowed_tool_names, '{}')::text[] AS allowed_tool_names
               FROM mcp_backend_bundles bb
               LEFT JOIN mcp_bundle_backend_tool_policies policy
                 ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
              WHERE bb.bundle_id = $1 AND bb.backend_id = ANY($2::int[])`,
            [input.targetBundleId, backendIds],
          );
          const targetPolicyByBackend = new Map(targetPolicies.rows.map(policy => [policy.backend_id, policy]));
          for (const backendId of backendIds) {
            const existingTargetPolicy = targetPolicyByBackend.get(backendId);
            const changedNames = input.tools.filter(tool => tool.backendId === backendId).map(tool => tool.name);
            await client.query(
              `INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
               VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [backendId, input.targetBundleId],
            );
            await persistPolicy(input.targetBundleId, backendId, mutateBundleToolPolicy(
              catalogByBackend.get(backendId) ?? [],
              existingTargetPolicy?.mode ?? 'selected',
              existingTargetPolicy?.allowed_tool_names ?? [],
              changedNames,
              'add',
            ));
            await client.query(
              `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
               SELECT tool.id, $1::int FROM mcp_tools tool
                WHERE tool.name = ANY($2::text[])
               ON CONFLICT DO NOTHING`,
              [input.targetBundleId, changedNames],
            );
          }
        }

        await client.query('COMMIT');
        await dependencies.refreshBackends();
        const source = bundles.rows.find(bundle => bundle.id === sourceBundleId)!;
        const target = bundles.rows.find(bundle => bundle.id === input.targetBundleId);
        writeAdminAudit(
          dependencies.pool,
          req,
          input.action === 'move' ? 'moved' : 'removed',
          'mcp_bundle_tool_assignments',
          String(sourceBundleId),
          source.label,
          { bundle_id: sourceBundleId, tools: input.tools },
          input.action === 'move'
            ? { bundle_id: input.targetBundleId, bundle_label: target?.label, tools: input.tools }
            : { bundle_id: sourceBundleId, tools: [] },
        );
        res.json({
          ok: true,
          action: input.action,
          sourceBundleId,
          targetBundleId: input.targetBundleId,
          changed: input.tools.length,
        });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message : 'Bundle-Tools konnten nicht verändert werden';
        const status = message.includes('nicht gefunden') ? 404
          : message.includes('nicht mehr') || message.includes('nicht freigegeben') || message.includes('unscoped') ? 409
            : 500;
        logger.error({ err: error, sourceBundleId, action: input.action }, 'Failed to change bundle tool assignments');
        res.status(status).json({ error: message });
      } finally {
        client.release();
      }
    },
  );

  app.patch(
    '/api/ui/mcp-fabric/bundles/:id/access',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Nur Platform-Administratoren können Bundle-Zugriffe verändern' });
        return;
      }
      const bundleId = Number(req.params.id);
      if (!Number.isSafeInteger(bundleId) || bundleId < 1) {
        res.status(400).json({ error: 'Ungültige Bundle-ID' });
        return;
      }
      let input: ReturnType<typeof normalizeFabricAccessMutation>;
      try {
        input = normalizeFabricAccessMutation(req.body as FabricAccessMutationInput);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Access-Daten' });
        return;
      }

      const client = await dependencies.pool.connect();
      let principalLabel = `${input.kind} #${input.id}`;
      let beforeGranted = false;
      try {
        await client.query('BEGIN');
        const bundleResult = await client.query<{ label: string }>(
          'SELECT label FROM mcp_service_bundles WHERE id = $1 FOR SHARE',
          [bundleId],
        );
        if (!bundleResult.rows[0]) throw new Error('Bundle nicht gefunden');

        if (input.kind === 'user') {
          const result = await client.query<{
            display_name: string;
            allowed_bundles: number[] | null;
          }>(
            'SELECT display_name, allowed_bundles FROM mcp_users WHERE id = $1 FOR UPDATE',
            [input.id],
          );
          const principal = result.rows[0];
          if (!principal) throw new Error('Principal nicht gefunden');
          principalLabel = principal.display_name;
          if (principal.allowed_bundles == null) {
            throw new Error('Globaler User-Zugriff muss in der User-Verwaltung eingeschränkt werden');
          }
          beforeGranted = principal.allowed_bundles.includes(bundleId);
          const next = input.granted
            ? [...new Set([...principal.allowed_bundles, bundleId])]
            : principal.allowed_bundles.filter(id => id !== bundleId);
          await client.query('UPDATE mcp_users SET allowed_bundles = $1 WHERE id = $2', [next, input.id]);
        } else if (input.kind === 'api_key') {
          const result = await client.query<{
            label: string;
            scope: string;
            allowed_bundles: number[] | null;
          }>(
            `SELECT label, scope, allowed_bundles
               FROM mcp_api_keys
              WHERE id = $1 AND deleted_at IS NULL
              FOR UPDATE`,
            [input.id],
          );
          const principal = result.rows[0];
          if (!principal) throw new Error('Principal nicht gefunden');
          principalLabel = principal.label;
          if (!['mcp', 'both'].includes(principal.scope)) {
            throw new Error('Der API-Key-Scope erlaubt keinen MCP-Zugriff');
          }
          if (principal.allowed_bundles == null) {
            throw new Error('Globaler API-Key-Zugriff muss in der API-Key-Verwaltung eingeschränkt werden');
          }
          beforeGranted = principal.allowed_bundles.includes(bundleId);
          const next = input.granted
            ? [...new Set([...principal.allowed_bundles, bundleId])]
            : principal.allowed_bundles.filter(id => id !== bundleId);
          await client.query('UPDATE mcp_api_keys SET allowed_bundles = $1 WHERE id = $2', [next, input.id]);
        } else if (input.kind === 'agent') {
          const result = await client.query<{
            label: string;
            composite_id: number | null;
            bundle_ids: number[] | null;
          }>(
            'SELECT label, composite_id, bundle_ids FROM mcp_agents WHERE id = $1 FOR UPDATE',
            [input.id],
          );
          const principal = result.rows[0];
          if (!principal) throw new Error('Principal nicht gefunden');
          principalLabel = principal.label;
          if (principal.composite_id != null) {
            throw new Error('Dieser Agent wird durch eine Composite-Policy verwaltet');
          }
          if (principal.bundle_ids == null || principal.bundle_ids.length === 0) {
            throw new Error('Globaler Agent-Zugriff muss in der Agent-Verwaltung eingeschränkt werden');
          }
          beforeGranted = principal.bundle_ids.includes(bundleId);
          const next = input.granted
            ? [...new Set([...principal.bundle_ids, bundleId])]
            : principal.bundle_ids.filter(id => id !== bundleId);
          if (next.length === 0) {
            throw new Error('Die letzte Agent-Zuweisung kann hier nicht entfernt werden, da eine leere Liste globalen Zugriff bedeutet');
          }
          await client.query('UPDATE mcp_agents SET bundle_ids = $1 WHERE id = $2', [next, input.id]);
        } else {
          const result = await client.query<{ name: string; granted: boolean }>(
            `SELECT w.name, EXISTS (
               SELECT 1 FROM mcp_workflow_bundles wb
                WHERE wb.workflow_id = w.id AND wb.bundle_id = $2
             ) AS granted
               FROM mcp_workflows w
              WHERE w.id = $1
              FOR UPDATE`,
            [input.id, bundleId],
          );
          const principal = result.rows[0];
          if (!principal) throw new Error('Principal nicht gefunden');
          principalLabel = principal.name;
          beforeGranted = principal.granted;
          if (input.granted) {
            await client.query(
              `INSERT INTO mcp_workflow_bundles (workflow_id, bundle_id)
               VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [input.id, bundleId],
            );
          } else {
            await client.query(
              'DELETE FROM mcp_workflow_bundles WHERE workflow_id = $1 AND bundle_id = $2',
              [input.id, bundleId],
            );
          }
        }

        await client.query('COMMIT');
        writeAdminAudit(
          dependencies.pool,
          req,
          input.granted ? 'granted' : 'revoked',
          'mcp_bundle_access',
          `${bundleId}:${input.kind}:${input.id}`,
          principalLabel,
          { bundle_id: bundleId, kind: input.kind, principal_id: input.id, granted: beforeGranted },
          { bundle_id: bundleId, kind: input.kind, principal_id: input.id, granted: input.granted },
        );
        res.json({
          ok: true,
          bundleId,
          principal: { kind: input.kind, id: String(input.id), label: principalLabel },
          granted: input.granted,
        });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message : 'Bundle-Zugriff konnte nicht verändert werden';
        const status = message.includes('nicht gefunden') ? 404
          : message.includes('Globaler') || message.includes('Composite') || message.includes('letzte') || message.includes('Scope')
            ? 409
            : 500;
        logger.error({ err: error, bundleId, principalKind: input.kind, principalId: input.id }, 'Failed to update bundle access');
        res.status(status).json({ error: message });
      } finally {
        client.release();
      }
    },
  );

  app.delete(
    '/api/ui/mcp-fabric/bundles/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      if (!hasRole(user.role, 'platform_admin')) {
        res.status(403).json({ error: 'Nur Platform-Administratoren können Bundles löschen' });
        return;
      }
      const bundleId = Number(req.params.id);
      if (!Number.isSafeInteger(bundleId) || bundleId < 1) {
        res.status(400).json({ error: 'Ungültige Bundle-ID' });
        return;
      }
      try {
        const before = await getBundle(dependencies.pool, bundleId);
        if (!before) {
          res.status(404).json({ error: 'Bundle nicht gefunden' });
          return;
        }
        await deleteBundle(dependencies.pool, bundleId, false);
        await dependencies.refreshBackends();
        writeAdminAudit(
          dependencies.pool,
          req,
          'deleted',
          'mcp_service_bundles',
          String(bundleId),
          before.label,
          before,
          null,
        );
        res.json({ ok: true, preservedConnections: true });
      } catch (error) {
        if (error instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(error));
          return;
        }
        logger.error({ err: error, bundleId }, 'Failed to delete managed MCP bundle');
        res.status(500).json({ error: 'Bundle konnte nicht gelöscht werden' });
      }
    },
  );

  const connectionAuditSnapshot = (backend: CustomBackendRow | Record<string, unknown> | null) => {
    if (!backend) return null;
    return {
      id: backend.id,
      name: backend.name,
      description: backend.description,
      base_url: safeEndpoint({ url: String(backend.base_url ?? '') }),
      backend_type: backend.backend_type,
      auth_type: backend.auth_type,
      health_path: backend.health_path,
      timeout_ms: backend.timeout_ms,
      tls_skip_verify: backend.tls_skip_verify,
      enabled: backend.enabled,
      mcp_endpoint: backend.mcp_endpoint,
      auth_mode: backend.auth_mode,
      oauth_authorize_url: backend.oauth_authorize_url,
      oauth_token_url: backend.oauth_token_url,
      oauth_client_id: backend.oauth_client_id,
      oauth_scopes: backend.oauth_scopes,
      oauth_revoke_url: backend.oauth_revoke_url,
    };
  };

  const loadManagedConnection = async (id: number): Promise<CustomBackendRow | null> => {
    const result = await dependencies.pool.query<CustomBackendRow>(
      `SELECT b.*,
              COALESCE((
                SELECT array_agg(bb.bundle_id ORDER BY bb.bundle_id)
                  FROM mcp_backend_bundles bb
                 WHERE bb.backend_id = b.id
              ), '{}')::int[] AS bundle_ids
         FROM mcp_backends b
        WHERE b.id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  };

  const saveManagedConnection = async (req: Request, res: Response, connectionId?: number) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Nicht authentifiziert' });
      return;
    }
    if (!hasRole(user.role, 'platform_admin')) {
      res.status(403).json({ error: 'Nur Platform-Administratoren können Connections verändern' });
      return;
    }
    if (connectionId != null && (!Number.isSafeInteger(connectionId) || connectionId < 1)) {
      res.status(400).json({ error: 'Ungültige Connection-ID' });
      return;
    }
    let input: NormalizedFabricConnectionMutation;
    try {
      input = normalizeFabricConnectionMutation(
        req.body as FabricConnectionMutationInput,
        connectionId == null,
      );
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Connection-Daten' });
      return;
    }

    const client = await dependencies.pool.connect();
    let before: CustomBackendRow | null = null;
    let saved: CustomBackendRow;
    try {
      await client.query('BEGIN');
      if (connectionId != null) {
        const locked = await lockBackendOpenApiOwnership(client, connectionId);
        if (!locked) throw new Error('Connection nicht gefunden');
        const bundleIds = (await client.query<{ bundle_id: number }>(
          `SELECT bundle_id
             FROM mcp_backend_bundles
            WHERE backend_id = $1
            ORDER BY bundle_id
            FOR UPDATE`,
          [connectionId],
        )).rows.map(row => row.bundle_id);
        before = { ...locked.backend, bundle_ids: bundleIds };
        if (before.backend_type === 'builtin') {
          throw new Error('Integrierte Platform-Connections können hier nicht verändert werden');
        }
        if (before.backend_type !== input.type) {
          throw new Error('Der Connection-Typ kann nach dem Anlegen nicht verändert werden');
        }
        if (locked.sourceControlled && (
          before.base_url !== input.baseUrl
          || before.auth_type !== input.authType
          || Object.hasOwn(input, 'authValue')
          || Object.hasOwn(input, 'executionTarget')
        )) {
          throw new OpenApiOwnershipError(
            'Base URL und Authentifizierung einer OpenAPI-verwalteten Connection können nur durch einen erneuten Import verändert werden',
          );
        }
        const requestedBundleIds = [...input.bundleIds].sort((left, right) => left - right);
        if (locked.sourceControlled && (
          bundleIds.length !== requestedBundleIds.length
          || bundleIds.some((id, index) => id !== requestedBundleIds[index])
        )) {
          throw new OpenApiOwnershipError(
            'Bundle-Grenzen einer OpenAPI-verwalteten Connection können nur im Capability Studio verändert werden',
          );
        }
      }

      if (input.bundleIds.length > 0) {
        const existingBundles = await client.query<{ id: number }>(
          'SELECT id FROM mcp_service_bundles WHERE id = ANY($1::int[]) FOR SHARE',
          [input.bundleIds],
        );
        if (existingBundles.rows.length !== input.bundleIds.length) {
          throw new Error('Mindestens ein ausgewähltes Bundle existiert nicht mehr');
        }
      }

      const hasExecutionTargetMutation = Object.hasOwn(input, 'executionTarget');
      const nextConfig = hasExecutionTargetMutation
        ? mergeExecutionTargetConfig(before?.config, input.executionTarget ?? null)
        : before?.config ?? {};
      if (nextConfig['scope_kind'] === 'kubernetes' && input.type !== 'mcp') {
        throw new Error('Kubernetes execution targets require an MCP connection');
      }
      if (nextConfig['scope_kind'] === 'kubernetes' && input.bundleIds.length === 0) {
        throw new Error('Kubernetes execution targets require at least one access bundle');
      }

      if (connectionId == null) {
        const created = await client.query<CustomBackendRow>(
          `INSERT INTO mcp_backends (
             name, description, base_url, auth_type, auth_value, health_path,
             default_headers, timeout_ms, tls_skip_verify, enabled, backend_type,
             mcp_endpoint, auth_mode, oauth_authorize_url, oauth_token_url,
             oauth_client_id, oauth_client_secret, oauth_scopes, oauth_revoke_url,
             config
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20::jsonb
           )
           RETURNING *`,
          [
            input.name,
            input.description,
            input.baseUrl,
            input.authType,
            encrypt(input.authValue ?? null),
            input.healthPath,
            JSON.stringify(protectHeadersForStorage(input.defaultHeaders)),
            input.timeoutMs,
            input.tlsSkipVerify,
            input.enabled,
            input.type,
            input.mcpEndpoint,
            input.authMode,
            input.oauthAuthorizeUrl,
            input.oauthTokenUrl,
            input.oauthClientId,
            encrypt(input.oauthClientSecret ?? null),
            input.oauthScopes,
            input.oauthRevokeUrl,
            JSON.stringify(nextConfig),
          ],
        );
        saved = created.rows[0];
        connectionId = saved.id;
      } else {
        const updated = await client.query<CustomBackendRow>(
          `UPDATE mcp_backends
              SET description = $1,
                  base_url = $2,
                  auth_type = $3,
                  auth_value = CASE WHEN $4::boolean THEN $5 ELSE auth_value END,
                  health_path = $6,
                  default_headers = $7::jsonb,
                  timeout_ms = $8,
                  tls_skip_verify = $9,
                  enabled = $10,
                  mcp_endpoint = $11,
                  auth_mode = $12,
                  oauth_authorize_url = $13,
                  oauth_token_url = $14,
                  oauth_client_id = $15,
                  oauth_client_secret = CASE WHEN $16::boolean THEN $17 ELSE oauth_client_secret END,
                  oauth_scopes = $18,
                  oauth_revoke_url = $19,
                  config = CASE WHEN $20::boolean THEN $21::jsonb ELSE config END
            WHERE id = $22
            RETURNING *`,
          [
            input.description,
            input.baseUrl,
            input.authType,
            Object.hasOwn(input, 'authValue'),
            encrypt(input.authValue),
            input.healthPath,
            JSON.stringify(protectHeadersForStorage(input.defaultHeaders, before?.default_headers)),
            input.timeoutMs,
            input.tlsSkipVerify,
            input.enabled,
            input.mcpEndpoint,
            input.authMode,
            input.oauthAuthorizeUrl,
            input.oauthTokenUrl,
            input.oauthClientId,
            Object.hasOwn(input, 'oauthClientSecret'),
            encrypt(input.oauthClientSecret),
            input.oauthScopes,
            input.oauthRevokeUrl,
            hasExecutionTargetMutation,
            JSON.stringify(nextConfig),
            connectionId,
          ],
        );
        saved = updated.rows[0];
      }

      await client.query(
        `DELETE FROM mcp_tool_bundles tb
          USING mcp_tools tool
         WHERE tb.tool_id = tool.id
           AND tb.bundle_id IN (
             SELECT bundle_id FROM mcp_backend_bundles WHERE backend_id = $1
           )
           AND (tool.backend = $2 OR tool.backend = 'custom:' || $2)`,
        [connectionId, saved.name],
      );
      await client.query(
        `DELETE FROM mcp_backend_bundles
          WHERE backend_id = $1
            AND NOT (bundle_id = ANY($2::int[]))`,
        [connectionId, input.bundleIds],
      );
      if (input.bundleIds.length > 0) {
        await client.query(
          `INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
           SELECT $1::int, unnest($2::int[])
           ON CONFLICT DO NOTHING`,
          [connectionId, input.bundleIds],
        );
        await client.query(
          `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
           SELECT tool.id, bundles.bundle_id
             FROM mcp_tools tool
             CROSS JOIN unnest($2::int[]) AS bundles(bundle_id)
             LEFT JOIN mcp_bundle_backend_tool_policies policy
               ON policy.backend_id = $3::int AND policy.bundle_id = bundles.bundle_id
            WHERE (tool.backend = $1 OR tool.backend = 'custom:' || $1)
              AND (
                policy.mode IS NULL
                OR policy.mode = 'all'
                OR tool.name = ANY(policy.allowed_tool_names)
              )
           ON CONFLICT DO NOTHING`,
          [saved.name, input.bundleIds, connectionId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof OpenApiOwnershipError) {
        res.status(409).json(openApiConflictBody(error));
        return;
      }
      const postgresCode = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : 'Connection konnte nicht gespeichert werden';
      const status = postgresCode === '23505'
        ? 409
        : message.includes('nicht gefunden') ? 404
          : message.includes('Bundle') || message.includes('bundle') || message.includes('Kubernetes')
              || message.includes('Integrierte') || message.includes('Connection-Typ') ? 400
              : 500;
      logger.error({ err: error, connectionId }, 'Failed to save managed MCP connection');
      res.status(status).json({
        error: postgresCode === '23505'
          ? 'Eine Connection mit diesem internen Namen existiert bereits'
          : message,
      });
      return;
    } finally {
      client.release();
    }

    let connectionWarning: string | null = null;
    try {
      if (before?.backend_type === 'mcp') await disconnectRemoteMcp(before.id);
      await dependencies.refreshBackends();
      if (saved.backend_type === 'mcp' && saved.enabled) {
        const connection = await connectRemoteMcp({ ...saved, bundle_ids: input.bundleIds });
        if (connection.connected) {
          await persistDiscoveredTools(dependencies.pool, saved.id, connection.tools);
        } else {
          connectionWarning = connection.lastError ?? 'Connection gespeichert, MCP Server aber nicht erreichbar';
        }
      }
    } catch (error) {
      connectionWarning = error instanceof Error ? error.message : 'Runtime konnte nicht aktualisiert werden';
      logger.warn({ err: error, connectionId: saved.id }, 'Connection saved but runtime refresh failed');
    }

    writeAdminAudit(
      dependencies.pool,
      req,
      before ? 'updated' : 'created',
      'mcp_backends',
      String(saved.id),
      saved.name,
      connectionAuditSnapshot(before),
      { ...connectionAuditSnapshot(saved), bundle_ids: input.bundleIds },
    );
    res.status(before ? 200 : 201).json({
      connection: {
        id: saved.id,
        name: saved.name,
        type: saved.backend_type,
        enabled: saved.enabled,
      },
      warning: connectionWarning,
    });
  };

  app.post(
    '/api/ui/mcp-fabric/connections',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => saveManagedConnection(req, res),
  );

  app.put(
    '/api/ui/mcp-fabric/connections/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => saveManagedConnection(req, res, Number(req.params.id)),
  );

  app.delete(
    '/api/ui/mcp-fabric/connections/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !hasRole(user.role, 'platform_admin')) {
        res.status(user ? 403 : 401).json({ error: user ? 'Platform-Admin erforderlich' : 'Nicht authentifiziert' });
        return;
      }
      const connectionId = Number(req.params.id);
      if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
        res.status(400).json({ error: 'Ungültige Connection-ID' });
        return;
      }
      const client = await dependencies.pool.connect();
      let before: CustomBackendRow | null = null;
      let toolsDeleted = 0;
      try {
        await client.query('BEGIN');
        const locked = await lockBackendOpenApiOwnership(client, connectionId);
        if (!locked) throw new Error('Connection nicht gefunden');
        before = locked.backend;
        if (before.backend_type === 'builtin') {
          throw new Error('Integrierte Platform-Connections können nicht gelöscht werden');
        }
        if (locked.sourceControlled) {
          throw new OpenApiOwnershipError(
            'OpenAPI-verwaltete Connections können nur über ihre Quelle im Capability Studio stillgelegt werden',
          );
        }
        const tools = await client.query(
          `DELETE FROM mcp_tools
            WHERE tool_type = 'dynamic'
              AND (backend = $1 OR backend = 'custom:' || $1)`,
          [before.name],
        );
        toolsDeleted = tools.rowCount ?? 0;
        await client.query('DELETE FROM mcp_backends WHERE id = $1', [connectionId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (error instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(error));
          return;
        }
        const message = error instanceof Error ? error.message : 'Connection konnte nicht gelöscht werden';
        const status = message.includes('nicht gefunden') ? 404
          : message.includes('Integrierte') ? 400
              : 500;
        logger.error({ err: error, connectionId }, 'Failed to delete managed MCP connection');
        res.status(status).json({ error: status === 500 ? 'Connection konnte nicht gelöscht werden' : message });
        return;
      } finally {
        client.release();
      }

      try {
        await disconnectRemoteMcp(connectionId);
        await Promise.all([dependencies.refreshBackends(), dependencies.refreshDynamicTools()]);
        writeAdminAudit(
          dependencies.pool,
          req,
          'deleted',
          'mcp_backends',
          String(connectionId),
          before!.name,
          connectionAuditSnapshot(before!),
          null,
        );
        res.json({ ok: true, toolsDeleted });
      } catch (error) {
        logger.error({ err: error, connectionId }, 'Failed to delete managed MCP connection');
        res.status(500).json({ error: 'Connection konnte nicht gelöscht werden' });
      }
    },
  );

  app.get(
    '/api/ui/mcp-fabric/connections/:id/sso-launch',
    dependencies.requireAuth,
    async (req, res) => {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert', code: 'AUTH_REQUIRED' });
        return;
      }
      if (!dependencies.config.backendSsoEnabled) {
        res.status(403).json({
          error: 'Backend-SSO ist in dieser Edition nicht aktiviert',
          code: 'BACKEND_SSO_NOT_ENTITLED',
        });
        return;
      }
      if (user.auth_method !== 'oidc'
        || (!dependencies.config.oidcSsoEnabled && !dependencies.config.entraSsoEnabled)) {
        res.status(403).json({
          error: 'Für diesen Backend-Zugriff ist eine Workforce-SSO-Sitzung erforderlich',
          code: 'SSO_SESSION_REQUIRED',
          loginUrl: '/auth/oidc/login',
        });
        return;
      }
      const connectionId = Number(req.params.id);
      if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
        res.status(400).json({ error: 'Ungültige Connection-ID', code: 'INVALID_CONNECTION_ID' });
        return;
      }
      try {
        const visible = visibleStatus(await dependencies.loadStatus(), user).backends
          .some(backend => backend.customId === connectionId);
        if (!visible) {
          res.status(404).json({ error: 'Connection nicht gefunden', code: 'CONNECTION_NOT_FOUND' });
          return;
        }
        const result = await dependencies.pool.query<{
          name: string;
          config: Record<string, unknown>;
        }>('SELECT name, config FROM mcp_backends WHERE id = $1 AND enabled = true', [connectionId]);
        const backend = result.rows[0];
        const portal = parseBackendSsoPortal(backend?.config?.['sso_portal']);
        if (!backend || !portal) {
          res.status(404).json({ error: 'Für diese Connection ist kein SSO-Portal konfiguriert', code: 'SSO_PORTAL_NOT_FOUND' });
          return;
        }
        const launchUrl = validatedBackendSsoLaunchUrl(portal, dependencies.config.backendSsoAllowedOrigins);
        const auditId = await writeAdminAudit(
          dependencies.pool,
          req,
          'backend_sso_launched',
          'mcp_backends',
          String(connectionId),
          backend.name,
          null,
          {
            application: portal.application,
            mode: portal.mode,
            provider: portal.providerName,
            destinationOrigin: new URL(launchUrl).origin,
            authMethod: user.auth_method,
          },
        );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Argus-Audit-Id', auditId == null ? 'unavailable' : String(auditId));
        res.redirect(302, launchUrl);
      } catch (error) {
        logger.warn({ err: error, connectionId }, 'Backend SSO launch denied');
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Backend-SSO konnte nicht gestartet werden',
          code: 'BACKEND_SSO_LAUNCH_DENIED',
        });
      }
    },
  );

  const loadTestableConnection = async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || !hasRole(user.role, 'platform_admin')) {
      res.status(user ? 403 : 401).json({ error: user ? 'Platform-Admin erforderlich' : 'Nicht authentifiziert' });
      return null;
    }
    const connectionId = Number(req.params.id);
    if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
      res.status(400).json({ error: 'Ungültige Connection-ID' });
      return null;
    }
    const backend = await loadManagedConnection(connectionId);
    if (!backend || backend.backend_type === 'builtin') {
      res.status(404).json({ error: 'Connection nicht gefunden' });
      return null;
    }
    return backend;
  };

  app.post(
    '/api/ui/mcp-fabric/connections/:id/test',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const backend = await loadTestableConnection(req, res);
      if (!backend) return;
      try {
        assertSsrfSafe(
          backend.backend_type === 'mcp'
            ? `${backend.base_url.replace(/\/$/, '')}${backend.mcp_endpoint || '/mcp'}`
            : `${backend.base_url.replace(/\/$/, '')}${backend.health_path || ''}`,
        );
        if (backend.backend_type === 'http') {
          const result = await checkCustomBackend(backend);
          const auditId = await writeAdminAudit(
            dependencies.pool,
            req,
            'connection_tested',
            'mcp_backends',
            String(backend.id),
            backend.name,
            null,
            { reachable: result.reachable, latencyMs: result.latencyMs, type: 'http' },
          );
          res.json({ type: 'http', ...result, auditId });
          return;
        }
        let connection = getRemoteConnection(backend.id);
        if (!connection?.connected) {
          await disconnectRemoteMcp(backend.id);
          connection = await connectRemoteMcp(backend);
          if (connection.connected) await persistDiscoveredTools(dependencies.pool, backend.id, connection.tools);
        }
        const result = await checkRemoteMcp(backend.id);
        const auditId = await writeAdminAudit(
          dependencies.pool,
          req,
          'connection_tested',
          'mcp_backends',
          String(backend.id),
          backend.name,
          null,
          { reachable: result.reachable, latencyMs: result.latencyMs, toolCount: result.toolCount, type: 'mcp' },
        );
        res.json({ type: 'mcp', ...result, auditId });
      } catch (error) {
        logger.warn({ err: error, connectionId: backend.id }, 'Managed connection test failed');
        const auditId = await writeAdminAudit(
          dependencies.pool,
          req,
          'connection_test_failed',
          'mcp_backends',
          String(backend.id),
          backend.name,
          null,
          { reachable: false, type: backend.backend_type, error: 'redacted; inspect server logs with the request id' },
        );
        res.json({
          type: backend.backend_type,
          reachable: false,
          latencyMs: null,
          error: error instanceof Error ? error.message : 'Verbindungstest fehlgeschlagen',
          ...(backend.backend_type === 'mcp' ? { toolCount: 0 } : {}),
          auditId,
        });
      }
    },
  );

  app.post(
    '/api/ui/mcp-fabric/connections/:id/discover',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const backend = await loadTestableConnection(req, res);
      if (!backend) return;
      if (backend.backend_type !== 'mcp') {
        res.status(400).json({ error: 'Tool Discovery ist nur für MCP Connections verfügbar' });
        return;
      }
      try {
        let connection = getRemoteConnection(backend.id);
        let tools;
        if (!connection?.connected) {
          await disconnectRemoteMcp(backend.id);
          connection = await connectRemoteMcp(backend);
          if (!connection.connected) {
            res.status(502).json({ error: connection.lastError ?? 'MCP Server nicht erreichbar' });
            return;
          }
          tools = connection.tools;
        } else {
          tools = await refreshRemoteMcpTools(backend.id);
        }
        const registry = await persistDiscoveredTools(dependencies.pool, backend.id, tools);
        res.json({
          connected: true,
          toolCount: tools.length,
          trustStatus: registry.trust_status,
          changeSummary: registry.change_summary,
          tools: tools.map(tool => ({
            name: tool.prefixedName,
            description: tool.description,
          })),
        });
      } catch (error) {
        logger.error({ err: error, connectionId: backend.id }, 'Managed MCP discovery failed');
        res.status(502).json({ error: error instanceof Error ? error.message : 'Tool Discovery fehlgeschlagen' });
      }
    },
  );

  app.get('/api/ui/mcp-fabric/bundles/:id', dependencies.requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ error: 'Nicht authentifiziert' });
        return;
      }
      const bundleId = Number(req.params.id);
      if (!Number.isInteger(bundleId) || bundleId < 1) {
        res.status(400).json({ error: 'Ungültige Bundle-ID' });
        return;
      }
      if (!canOpenBundle(bundleId, user.allowed_bundles)) {
        res.status(404).json({ error: 'Bundle nicht gefunden' });
        return;
      }
      const payload = await bundleDetailPayload(dependencies, bundleId, user);
      if (!payload) {
        res.status(404).json({ error: 'Bundle nicht gefunden' });
        return;
      }
      res.json(payload);
    } catch (error) {
      logger.error({ err: error }, 'Failed to build MCP Fabric bundle detail');
      res.status(500).json({ error: 'Bundle-Details konnten nicht geladen werden' });
    }
  });

  // Native Skill Adoption view. Raw API-key prefixes never leave the server;
  // the response uses stable pseudonymous runtime identifiers instead.
  app.get('/api/ui/skills/adoption', dependencies.requireAuth, async (req, res) => {
    if (!requireSkillAdmin(req, res)) return;
    let days: number;
    try {
      days = normalizeSkillAdoptionDays(req.query['days']);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültiges Adoption-Zeitfenster' });
      return;
    }
    try {
      const payload = await loadSkillAdoption(dependencies.pool, days);
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (error) {
      logger.error({ err: error, days }, 'Failed to build Skill Adoption Analytics');
      res.status(500).json({ error: 'Skill Analytics konnten nicht geladen werden' });
    }
  });

  // Native Compliance Workspace. The framework catalogue is checklist-backed;
  // all responses describe automated assessments, never certifications.
  app.get('/api/ui/compliance', dependencies.requireAuth, async (req, res) => {
    if (!requireComplianceAdmin(req, res)) return;
    try {
      const [frameworks, runs, auditorAgentId] = await Promise.all([
        listComplianceFrameworks(dependencies.pool),
        listComplianceRuns(dependencies.pool, 100),
        resolveComplianceAuditorAgentId(dependencies.pool),
      ]);
      res.setHeader('Cache-Control', 'no-store');
      res.json(buildComplianceWorkspace(frameworks, runs, auditorAgentId));
    } catch (error) {
      logger.error({ err: error }, 'Failed to build Compliance Workspace');
      res.status(500).json({ error: 'Compliance Workspace konnte nicht geladen werden' });
    }
  });

  app.get('/api/ui/compliance/runs/:id', dependencies.requireAuth, async (req, res) => {
    if (!requireComplianceAdmin(req, res)) return;
    const runId = parseComplianceRunId(req.params.id);
    if (!runId) {
      res.status(400).json({ error: 'Ungültige Compliance-Run-ID' });
      return;
    }
    try {
      const run = await getComplianceRun(dependencies.pool, runId);
      if (!run) {
        res.status(404).json({ error: 'Compliance-Run nicht gefunden' });
        return;
      }
      const [framework, findings, auditorAgentId] = await Promise.all([
        getComplianceFrameworkById(dependencies.pool, run.framework_id),
        listComplianceFindings(dependencies.pool, runId),
        resolveComplianceAuditorAgentId(dependencies.pool),
      ]);
      if (!framework) {
        res.status(500).json({ error: 'Framework des Compliance-Runs fehlt' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        generatedAt: new Date().toISOString(),
        assessmentNotice: 'Automated evidence assessment. Results support human review and do not constitute certification or legal advice.',
        framework: mapComplianceFramework(framework, auditorAgentId > 0),
        run: mapComplianceRun(run),
        findings: findings.map(mapComplianceFinding),
        exports: run.status === 'completed' ? {
          pdf: `/api/ui/compliance/runs/${run.id}/export.pdf`,
          csv: `/api/ui/compliance/runs/${run.id}/export.csv`,
        } : null,
      });
    } catch (error) {
      logger.error({ err: error, runId }, 'Failed to load Compliance Run');
      res.status(500).json({ error: 'Compliance-Run konnte nicht geladen werden' });
    }
  });

  app.post(
    '/api/ui/compliance/runs',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      const user = requireComplianceAdmin(req, res);
      if (!user) return;
      let input;
      try { input = normalizeComplianceRunInput(req.body); }
      catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Run-Daten' });
        return;
      }
      try {
        const framework = await getComplianceFrameworkById(dependencies.pool, input.frameworkId);
        if (!framework) {
          res.status(404).json({ error: 'Compliance-Framework nicht gefunden' });
          return;
        }
        if (!framework.enabled || !framework.skill_id) {
          res.status(409).json({ error: 'Das Framework ist noch nicht assessment-bereit' });
          return;
        }
        const auditorAgentId = await resolveComplianceAuditorAgentId(dependencies.pool);
        if (!auditorAgentId) {
          res.status(503).json({ error: 'Der Compliance Auditor Agent ist nicht verfügbar' });
          return;
        }
        const recent = await listComplianceRuns(dependencies.pool, 100);
        const duplicate = recent.find(run =>
          run.framework_id === framework.id
          && run.target === input.target
          && (run.status === 'queued' || run.status === 'running'));
        if (duplicate) {
          res.status(409).json({
            error: `Für diesen Scope läuft bereits Compliance-Run #${duplicate.id}`,
            runId: duplicate.id,
          });
          return;
        }
        const run = await startComplianceRun(
          dependencies.pool,
          framework.id,
          input.target,
          user.username,
          auditorAgentId,
        );
        writeAdminAudit(
          dependencies.pool,
          req,
          'started',
          'mcp_compliance_runs',
          String(run.id),
          framework.label,
          null,
          { frameworkId: framework.id, frameworkSlug: framework.slug, target: input.target, status: run.status },
        );
        setImmediate(() => {
          executeAuditRun(dependencies.pool, run, dependencies.config).catch(error => {
            logger.error({ err: error, runId: run.id }, 'Native compliance run failed unexpectedly');
          });
        });
        res.status(202).json({ run: mapComplianceRun({
          ...run,
          framework_slug: framework.slug,
          framework_label: framework.label,
        }) });
      } catch (error) {
        logger.error({ err: error }, 'Failed to start Compliance Run');
        res.status(500).json({ error: 'Compliance-Run konnte nicht gestartet werden' });
      }
    },
  );

  app.delete(
    '/api/ui/compliance/runs/:id',
    dependencies.requireAuth,
    dependencies.requireSameOrigin,
    fabricMutationRateLimit,
    async (req, res) => {
      if (!requireComplianceAdmin(req, res)) return;
      const runId = parseComplianceRunId(req.params.id);
      if (!runId) {
        res.status(400).json({ error: 'Ungültige Compliance-Run-ID' });
        return;
      }
      if (!req.body || typeof req.body !== 'object'
        || (req.body as { confirmation?: unknown }).confirmation !== `run-${runId}`) {
        res.status(400).json({ error: `Bestätigung run-${runId} ist erforderlich` });
        return;
      }
      try {
        const run = await getComplianceRun(dependencies.pool, runId);
        if (!run) {
          res.status(404).json({ error: 'Compliance-Run nicht gefunden' });
          return;
        }
        if (run.status === 'queued' || run.status === 'running') {
          res.status(409).json({ error: 'Aktive Compliance-Runs können nicht gelöscht werden' });
          return;
        }
        const deleted = await deleteComplianceRun(dependencies.pool, runId);
        if (!deleted) {
          res.status(404).json({ error: 'Compliance-Run nicht gefunden' });
          return;
        }
        writeAdminAudit(
          dependencies.pool,
          req,
          'deleted',
          'mcp_compliance_runs',
          String(run.id),
          run.framework_label ?? null,
          {
            frameworkId: run.framework_id,
            target: run.target,
            status: run.status,
            score: run.score,
            findingCounts: {
              passed: run.passed_count,
              warning: run.warning_count,
              failed: run.failed_count,
              notApplicable: run.na_count,
            },
          },
          null,
        );
        res.json({ deleted: true });
      } catch (error) {
        logger.error({ err: error, runId }, 'Failed to delete Compliance Run');
        res.status(500).json({ error: 'Compliance-Run konnte nicht gelöscht werden' });
      }
    },
  );

  const exportComplianceRun = async (req: Request, res: Response, format: 'pdf' | 'csv') => {
    if (!requireComplianceAdmin(req, res)) return;
    const runId = parseComplianceRunId(req.params.id);
    if (!runId) {
      res.status(400).json({ error: 'Ungültige Compliance-Run-ID' });
      return;
    }
    try {
      const run = await getComplianceRun(dependencies.pool, runId);
      if (!run) {
        res.status(404).json({ error: 'Compliance-Run nicht gefunden' });
        return;
      }
      if (run.status !== 'completed') {
        res.status(409).json({ error: 'Nur abgeschlossene Assessments können exportiert werden' });
        return;
      }
      const [framework, findings] = await Promise.all([
        getComplianceFrameworkById(dependencies.pool, run.framework_id),
        listComplianceFindings(dependencies.pool, runId),
      ]);
      if (!framework) {
        res.status(500).json({ error: 'Framework des Compliance-Runs fehlt' });
        return;
      }
      const safeSlug = framework.slug.replace(/[^a-z0-9_-]/gi, '-');
      res.setHeader('Cache-Control', 'no-store');
      if (format === 'pdf') {
        const pdf = await exportCompliancePdf(framework, run, findings);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="argus-assessment-${runId}-${safeSlug}.pdf"`);
        res.send(pdf);
      } else {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="argus-assessment-${runId}-${safeSlug}.csv"`);
        res.send(exportComplianceCsv(framework, run, findings));
      }
      writeAdminAudit(
        dependencies.pool,
        req,
        `exported_${format}`,
        'mcp_compliance_runs',
        String(run.id),
        framework.label,
        null,
        { frameworkId: framework.id, findingCount: findings.length },
      );
    } catch (error) {
      logger.error({ err: error, runId, format }, 'Failed to export Compliance Run');
      if (!res.headersSent) res.status(500).json({ error: 'Compliance-Export konnte nicht erstellt werden' });
    }
  };

  // Exports are plain browser download links, so a stale MFA assertion
  // redirects through OIDC step-up back to the run page instead of rendering
  // a 428 JSON body. Local sessions fail closed like canonical audit exports.
  const requireFreshMfaForComplianceExport: RequestHandler = (req, res, next) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (hasFreshMfaSession(user, dependencies.config.oidcMfaMaxAgeSeconds ?? 600)) {
      next();
      return;
    }
    const runId = parseComplianceRunId(req.params['id']);
    const returnTo = runId ? `/governance/compliance/runs/${runId}` : '/governance/compliance';
    res.redirect(`/auth/oidc/step-up?returnTo=${encodeURIComponent(returnTo)}`);
  };
  app.get('/api/ui/compliance/runs/:id/export.pdf', dependencies.requireAuth, requireFreshMfaForComplianceExport, (req, res) => {
    void exportComplianceRun(req, res, 'pdf');
  });
  app.get('/api/ui/compliance/runs/:id/export.csv', dependencies.requireAuth, requireFreshMfaForComplianceExport, (req, res) => {
    void exportComplianceRun(req, res, 'csv');
  });
}
