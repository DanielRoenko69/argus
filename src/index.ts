// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

// OpenTelemetry must be initialized before other imports
import { initTracing, shutdownTracing } from './lib/tracing.js';
import {
  flushTelemetryWrites,
  startTelemetrySpan,
  finishTelemetrySpan,
  listTelemetryTraces,
  withNativeTelemetryContext,
} from './observability/telemetryStore.js';
import { readTrustedNativeTraceEnvelope } from './observability/internalTraceContext.js';
initTracing();

import express from 'express';
import type { Server } from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt, isCurrentlyEncrypted } from './lib/encryption.js';
import { protectHeadersForStorage, redactHeaders } from './backends/headerSecrets.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { loadConfig, PASSWORD_MAX_AGE_DAYS, AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from './config/env.js';
import { createApiKeyMiddleware } from './auth/apiKeyMiddleware.js';
import { initOAuth2, createOAuth2Middleware, type OAuth2BoundUser } from './auth/oauth2Middleware.js';
import { createMcpServer } from './server/mcpServer.js';
import type { SessionContext, McpServerOptions, McpServerResult } from './server/mcpServer.js';
import { McpSessionRegistry, mcpCallerId, mcpSessionDenial } from './server/mcpSessionGuard.js';
import { loadApiKeyRbac, type ToolPatternPolicy } from './auth/apiKeyRbac.js';
import {
  ApiKeyLifecycleError,
  createManagedApiKeyAudited,
  deleteManagedApiKeyAudited,
  rotateManagedApiKeyAudited,
  updateManagedApiKeyAudited,
} from './auth/apiKeyLifecycle.js';
import { getStatus } from './status/statusData.js';
import { createStatusSnapshotLoader } from './status/statusSnapshot.js';
import { buildOpenApiSpec, buildSwaggerHtml } from './docs/openApiSpec.js';
import { listWidgets, createWidget, updateWidget, deleteWidget as deletePublicWidget } from './public/widgetStore.js';
import { writeImmutableAudit } from './audit/immutableAudit.js';
import { renderPageShell } from './shared/navHtml.js';
import { listActive, summaryCounts } from './agents/activeSessions.js';
import { ROLE_WEIGHTS, hasRole, normalizeRole, parseArgusRole } from './auth/roles.js';
import { assertCanBindKeyToUser, listApiKeyBindingTargets, parseApiKeyBinding } from './auth/apiKeyBinding.js';
import { registerUpstreamConnectionRoutes } from './auth/upstreamConnectionRoutes.js';
import {
  getOtelConfig, setOtelConfig,
  getHydeConfig, setHydeConfig,
  getK8sImpersonationConfig, setK8sImpersonationConfig,
  getUpstreamTokenExchangeConfig, setUpstreamTokenExchangeConfig,
  loadAllPlatformConfigs, persistPlatformConfig,
} from './lib/platformConfig.js';
import { getVaultConfig, setVaultConfig, testVaultConnection, loadVaultConfigFromSettings } from './lib/secrets.js';
import {
  safeVaultConfig,
  validateHydeConfig,
  validateK8sImpersonationConfig,
  validateOtelConfig,
  validateUpstreamTokenExchangeConfig,
  validateVaultConfig,
} from './settings/platformConfigValidation.js';
import { logger } from './lib/logger.js';
import { writeAdminAudit, redactSensitive } from './lib/adminAudit.js';
import {
  isOpenApiCategory,
  lockBackendOpenApiOwnership,
  lockCapabilityOpenApiOwnership,
  OpenApiOwnershipError,
  openApiConflictBody,
} from './lib/openApiOwnership.js';
import { registry, activeSessionsGauge } from './lib/metrics.js';
import { initAuditLog, closeAuditLog, cleanupAuditLog, queryAuditLog, getAuditStats, getDistinctTools, getDistinctApiKeys, getDistinctBackends } from './lib/audit.js';
import { initMetricsStore, closeMetricsStore, snapshotMetrics, aggregateHourlyMetrics, recordServerEvent, getDashboardMetrics } from './lib/metricsStore.js';
import { initNotifications, sendNotification } from './lib/notifications.js';
import { logUsageSummary } from './lib/costTracker.js';
import { loadDynamicTools } from './tools/dynamic/index.js';
import type { DynamicToolRow } from './tools/dynamic/index.js';
import { loadCustomBackends, setCustomBackends, getCustomBackends, loadAllCustomBackends, setAllCustomBackends, getAllCustomBackends, assertSsrfSafe } from './backends/customBackends.js';
import {
  loadToolFilters, loadAllToolFilters, setToolFilters,
  createToolFilterAudited, updateToolFilterAudited, deleteToolFilterAudited,
  getToolFilter, testToolFilter, ToolFilterMutationError,
} from './filters/toolFilters.js';
import type { CustomBackendRow } from './backends/customBackends.js';
import { parseSpec } from './actions/openapi/parse.js';
import { resolveLocalRefs } from './actions/openapi/refs.js';
import { mapSecurity, mapOperations } from './actions/openapi/map.js';
import { normalizeOpenApiPrefix, resolveOpenApiSpecText } from './actions/openapi/studio.js';
import { connectRemoteMcp, persistDiscoveredTools, disconnectAllRemoteMcp, disconnectRemoteMcp, getRemoteConnection, refreshRemoteMcpTools, checkRemoteMcp, setRemoteMcpTrustStatus } from './backends/remoteMcpClients.js';
import { setMcpRegistryTrust } from './backends/mcpRegistry.js';
import { getAllTemplates, getTemplatesByCategory, searchTemplates } from './templates/serviceTemplates.js';
import { TEMPLATE_CATEGORIES } from './templates/categories.js';
import { applyTemplate } from './templates/applyTemplate.js';
import { listBundles, getBundle, createBundle, updateBundle, deleteBundle, getBundleTools, getBundleBackends, getBundleByName } from './bundles/serviceBundles.js';
import { isFirstUser, authenticateUser, listUsers, createSession, deleteSession, cleanupExpiredSessions, validatePasswordStrength, hasFreshMfaSession } from './auth/userAuth.js';
import type { SessionUser } from './auth/userAuth.js';
import {
  changeManagedUserPasswordAudited,
  createFirstUserAudited,
  createManagedUserAudited,
  deleteManagedUserAudited,
  parseAllowedBundleIds,
  parseWorkspaceMemberships,
  updateManagedUserAudited,
  UserLifecycleError,
} from './auth/userLifecycle.js';
import { withUserWorkspaceMemberships } from './auth/workspaceMemberships.js';
import {
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from './auth/workspaceScope.js';
import { buildFirstUserBootstrapAuditContext, buildUserLifecycleAuditContext } from './auth/userLifecycleAuditContext.js';
import {
  buildSsoIdentityAuditContext,
  linkSsoIdentityAudited,
  SsoIdentityLifecycleError,
  syncSsoIdentityAudited,
} from './auth/ssoIdentityLifecycle.js';
import { AccessPolicyError } from './auth/userPolicyStore.js';
import { createSessionMiddleware, requireAuth, requireAdmin, requireRole, requireSameOrigin, requireFreshMfa, setSessionCookie, clearSessionCookie, parseArgusSessionCookie, parseCookieValue } from './auth/sessionMiddleware.js';
import { withRequestContext } from './lib/requestContext.js';
import { SolutionPackRegistry } from './solutionPacks/discovery.js';
import { registerSolutionPackRoutes } from './solutionPacks/routes.js';
import { SolutionPackRuntimeAdapterClient } from './solutionPacks/runtimeAdapterClient.js';
import { HermesRuntimeExecutor, selectManagedHermesBundleIds } from './agents/hermesRuntimeExecutor.js';
import {
  decideManagedRuntimeMemoryProposal,
  listManagedRuntimeMemoryProposals,
} from './agents/managedRuntimeMemory.js';
import { configureAgentRuntimeExecutor } from './agents/runtimeExecutor.js';
import { RuntimeMcpLeaseStore } from './solutionPacks/runtimeMcpLeases.js';
import {
  ExplicitManagedRuntimeReadOnlyPolicy,
  ManagedRuntimeCoordinator,
} from './solutionPacks/managedRuntimeCoordinator.js';
import { PostgresIncidentAiopsTaskStore } from './observability/incidentAiopsTasks.js';
import { PostgresIncidentAiopsFeedbackStore } from './observability/incidentAiopsFeedback.js';
import { PostgresIncidentRemediationStore } from './observability/incidentRemediations.js';
import { PostgresIncidentRemediationExecutor } from './observability/incidentRemediationExecutor.js';
import { appendIncidentRemediationAudit } from './observability/incidentRemediationAudit.js';
import { NativeAlertAiopsDispatcher } from './observability/nativeAlertAiopsAutomation.js';
import { PostgresIncidentImpactReader } from './observability/incidentImpact.js';
import { A2aHttpJsonClient } from './a2a/client.js';
import {
  HermesDevBridge,
  PostgresHermesDevBridgeTaskStore,
} from './solutionPacks/hermesDevBridge.js';
import {
  HermesDevConnectionError,
  HermesDevConnectionManager,
} from './solutionPacks/hermesDevConnections.js';
import {
  ExecutionGrantIssuer,
  executionGrantWorkspaceScope,
  type ExecutionGrantClaims,
} from './solutionPacks/executionGrant.js';
import { createExecutionGrantMiddleware, narrowExecutionGrantTools, type ExecutionGrantRequestState } from './auth/executionGrantMiddleware.js';
import { registerTechnicalExperimentRoute } from './solutionPacks/technicalExperimentRoutes.js';
import { registerQaTestsRoutes } from './solutionPacks/qaTestsRoutes.js';
import { registerStackTestsRoutes } from './solutionPacks/stackTestsRoutes.js';
import { registerCodeGenerationRoutes } from './solutionPacks/codeGenerationRoutes.js';
import { createRuntimeMcpTransportHandlers } from './server/runtimeMcpTransport.js';
import {
  buildNativeWorkspaceCodeContext,
  ensureNativeWorkspaceCodeIndex,
  NativeCodeIndexUnavailableError,
  resolveNativeCodeBundleAccess,
} from './codeIntelligence/workspaceIndexer.js';
import { CodeIndexValidationError } from './codeIntelligence/store.js';
import { listCodeIndexSnapshots } from './codeIntelligence/store.js';
import type { AuthenticatedRequest } from './auth/sessionMiddleware.js';
import { renderLoginHtml } from './auth/loginPage.js';
import { buildAuthorizationUrl, handleCallback, resolveEntraRoleMapping, oidcUsername } from './auth/entraAuth.js';
import {
  OIDC_BROWSER_BINDING_COOKIE,
  clearOidcBrowserBindingCookie,
  oidcBrowserBindingCookie,
  safeRedirectPath,
} from './auth/oidcAuth.js';
import { createShare, listSharesByUser, revokeShare, cleanupExpiredShares, ShareForbiddenError } from './sharing/shareStore.js';
import { getShareByToken, verifySharePassword } from './sharing/shareStore.js';
import { renderSharePage, renderPasswordGate } from './sharing/sharePage.js';
import pg from 'pg';
import { loadWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow, createExecution, updateExecution, getExecutionHistory, getExecution } from './workflows/workflowStore.js';
import {
  applyWorkflowAgentAssignments,
  preflightWorkflowAgents,
  workflowExecutionSnapshot,
  WorkflowAgentContractError,
} from './workflows/agentContracts.js';
import { isValidWorkflowName } from './workflows/workflowName.js';
import { executeWorkflow } from './workflows/executor.js';
import { executeTool, listAllTools } from './tools/toolRunner.js';
import { makeHookedToolRunner } from './workflows/hookedToolRunner.js';
import {
  buildRealRunners as buildWorkflowRunners,
  startWorkflowExecution,
} from './workflows/executeRoutes.js';
import { initLogStore, flushLogBuffer } from './lib/logStore.js';
import { RateLimiter } from './lib/rateLimiter.js';
import helmet from 'helmet';
import multer from 'multer';
import { ingestDocument } from './agents/kb/ingest.js';
import { listKbDocuments, deleteKbDocument } from './agents/kb/store.js';
import {
  listAgents, getAgent, createAgent, updateAgent, deleteAgent, setAgentRagIndexes, setAgentCodeIndexes,
  listRagIndexes, getRagIndex, createRagIndex, updateRagIndex, deleteRagIndex,
  createSession as createAgentSession, getSession, listSessions, appendMessages, deleteSession as deleteAgentSession,
  updateSessionPrContext,
  listChatVisibleAgents, agentVisibleToBundleScope, agentAccessGate, setActiveLeaf,
  AgentCredentialProfileAssignmentError,
} from './agents/agentStore.js';
import {
    AgentTemplateInstallError,
    applyAgentTemplateUpgrade,
    installAgentTemplate,
    listAgentTemplates,
    previewAgentTemplate,
    previewAgentTemplateUpgrade,
  } from './agents/agentTemplates.js';
  import {
    deleteAgentTemplateDraft,
    listAgentTemplateDrafts,
    previewAgentTemplateDraft,
    publishAgentTemplateDraft,
    saveAgentTemplateDraft,
  } from './agents/agentTemplateDrafts.js';
import { listRagProviderDefinitions, validateRagProviderInput } from './agents/ragProviderRegistry.js';
import { resolveActivePath, leafOf } from './agents/messageTree.js';
import { intersectAgentBundleScope } from './auth/bundleScope.js';
import {
  listSkills, getSkill, createSkill, updateSkill, deleteSkill, setAgentSkills, upsertSkillByName,
} from './agents/skillStore.js';
import { renderAgentsHtml } from './agents/agentPage.js';
import { renderChatShell, renderEmbedChat } from './agents/chat/chatShell.js';
import { landingFor } from './auth/landing.js';
import {
  AgentRuntimeCodeContextPolicyError,
  AgentRuntimeProfileAssignmentError,
  AgentRuntimeProfileMutationError,
  createAgentRuntimeProfile,
  deleteAgentRuntimeProfile,
  getAgentRuntimeAssignment,
  listAgentRuntimeAssignments,
  listAgentRuntimeProfiles,
  updateAgentRuntimeProfile,
  updateAgentRuntimeCodeContextPolicy,
} from './agents/runtimeProfiles.js';
import { assessAgentReadiness } from './agents/agentReadiness.js';
import { bootstrapBuiltinHooks, listHooks } from './agents/hooks/index.js';
import { startMemoryConsolidator, consolidateMemoriesOnce } from './agents/memoryConsolidator.js';
import { collectValidImages, assertVisionAllowed } from './agents/imageAttachments.js';
import { clampParams } from './agents/modelParams.js';
import { startLangfuseAlerts } from './observability/langfuseAlerts.js';
import { startNativeAlertWorker } from './observability/nativeAlerts.js';
import { startCanaries, getSummaries as getCanarySummaries, getAllResults as getCanaryResults } from './observability/canaries.js';
import { startCiProviderCanaryScheduler } from './observability/ciProviderCanaries.js';
import { createCodingRouter } from './api/coding.js';
import { createCodingCheckpointRetryRouter, createCodingQaResponseRecheckRouter } from './api/codingCheckpointRetry.js';
import { registerRepositoryIssueRoutes } from './solutionPacks/repositoryIssueRoutes.js';
import { registerConsoleApi } from './console/consoleApi.js';
import { registerGlobalSearchRoutes } from './console/globalSearchRoutes.js';
import { registerLogRoutes } from './observability/logRoutes.js';
import { registerEvaluationRoutes } from './evaluation/routes.js';
import { startEvaluationRecoveryWorker } from './evaluation/lifecycle.js';
import { registerTagRoutes } from './tags/routes.js';
import { registerRunReadModelRoutes } from './runs/routes.js';
import { registerRepositoryGraphRoutes } from './codeIntelligence/repositoryGraphRoutes.js';
import { registerAuditEvidenceRoutes } from './audit/evidenceRoutes.js';
import { registerAuditReportRoutes } from './audit/reportRoutes.js';
import { registerAiOpsServiceProfileRoutes } from './observability/aiopsServiceProfileRoutes.js';
import { registerAiOpsProviderSignalRoutes } from './observability/aiopsProviderSignalRoutes.js';
import { registerAiSystemRoutes } from './compliance/aiSystemRoutes.js';
import { registerAiSystemControlRoutes } from './compliance/aiSystemControlRoutes.js';
import { registerAiComplianceDossierRoutes } from './compliance/aiComplianceDossierRoutes.js';
import { registerGoldenPathRoutes } from './goldenPath/routes.js';
import { registerPlatformReadinessRoutes } from './readiness/routes.js';
import { runAiOpsEvidenceQueryPreflight } from './observability/aiopsEvidenceQueryPreflight.js';
import { startAiOpsServiceProfileInvestigation } from './observability/aiopsServiceProfileInvestigations.js';
import { getAiOpsServiceProfile, getAiOpsServiceProfileRevision } from './observability/aiopsServiceProfiles.js';
import { evaluateAiOpsServiceProfileReadiness } from './observability/aiopsServiceProfileReadiness.js';
import { loadAuditCheckpointSignerFromEnv } from './audit/checkpoints.js';
import { loadExternalEvidenceAnchorProviderFromEnv } from './audit/externalAnchorProvider.js';
import { startCanonicalAuditIntegrityMonitor } from './audit/integrityMonitor.js';
import { startAuditReportWorker } from './audit/reportService.js';
import { startGoldenPathEvidenceWorker } from './goldenPath/evidenceWorker.js';
import { startFabricProfileDriftWorker } from './console/fabricProfileDriftWorker.js';

// ── Security helpers ─────────────────────────────────────────

/** Extract full RBAC SessionContext from an API-key-authenticated request. */
function sessionCtxFromReq(req: express.Request): SessionContext {
  const r = req as unknown as Record<string, unknown>;
  const user = (req as AuthenticatedRequest).user;
  const technicalCallingUser = r.callingUser as {
    id?: number;
    entra_groups?: string[];
  } | undefined;
  // H4: merge API-key bundle restrictions with session-user bundle restrictions.
  // If API key has no bundle scope but user does, apply user's restrictions (and vice versa).
  const apiKeyBundles = r.allowedBundles as number[] | null ?? null;
  const userBundles   = user?.allowed_bundles ?? null;
  let allowedBundles: number[] | null = null;
  if (apiKeyBundles !== null && userBundles !== null) {
    // Intersection: only bundles permitted by BOTH the key and the user
    const set = new Set(userBundles);
    allowedBundles = apiKeyBundles.filter(id => set.has(id));
  } else {
    allowedBundles = apiKeyBundles ?? userBundles;
  }
  return {
    apiKeyPrefix:   r.apiKeyPrefix as string | null ?? null,
    tenantKey:      r.tenantKey as string | undefined ?? 'default',
    workspaceKey:   r.workspaceKey as string | undefined ?? 'default',
    allowedBundles,
    allowedTools:   r.allowedTools  as string[] | null ?? null,
    deniedTools:    r.deniedTools   as string[] | null ?? null,
    compositeId:    r.compositeId   as number | null ?? null,
    callingUser: user
      ? { id: user.id, entra_groups: user.entra_groups ?? [] }
      : technicalCallingUser?.id != null
        ? { id: technicalCallingUser.id, entra_groups: technicalCallingUser.entra_groups ?? [] }
        : null,
  };
}

function runtimeCallingUserFromReq(
  req: express.Request,
): {
  id: number;
  role?: string | null;
  entra_groups: string[];
  allowed_bundles?: number[] | null;
  tenantKey?: string;
  workspaceKey?: string;
  service?: boolean;
} | undefined {
  const sessionUser = (req as AuthenticatedRequest).user;
  if (sessionUser) {
    const scope = resolveAuthorizedWorkspaceScope(req, sessionUser);
    return {
      id: sessionUser.id,
      role: sessionUser.role,
      entra_groups: sessionUser.entra_groups ?? [],
      allowed_bundles: sessionUser.allowed_bundles,
      tenantKey: scope.tenantKey,
      workspaceKey: scope.workspaceKey,
    };
  }
  const technicalUser = (req as unknown as Record<string, unknown>).callingUser as {
    id?: number;
    role?: string | null;
    entra_groups?: string[];
    allowed_bundles?: number[] | null;
  } | undefined;
  const requestState = req as unknown as Record<string, unknown>;
  const keyBundles = requestState.allowedBundles as number[] | null | undefined;
  const serviceIdentity = typeof requestState.apiKeyPrefix === 'string'
    && String(requestState.apiKeyPrefix).startsWith('eg_');
  return technicalUser?.id != null
    ? {
      id: technicalUser.id,
      role: technicalUser.role,
      entra_groups: technicalUser.entra_groups ?? [],
      allowed_bundles: keyBundles ?? technicalUser.allowed_bundles,
      tenantKey: String(requestState.tenantKey ?? 'default'),
      workspaceKey: String(requestState.workspaceKey ?? 'default'),
      ...(serviceIdentity || !technicalUser.role ? { service: true } : {}),
    }
    : typeof requestState.apiKeyPrefix === 'string'
      ? {
        id: 0,
        role: 'platform_admin',
        entra_groups: [],
        allowed_bundles: keyBundles,
        tenantKey: String(requestState.tenantKey ?? 'default'),
        workspaceKey: String(requestState.workspaceKey ?? 'default'),
        service: true,
      }
      : undefined;
}

function technicalIdentityToolPolicyFromReq(req: express.Request): ToolPatternPolicy | undefined {
  const requestState = req as unknown as Record<string, unknown>;
  if (!requestState.apiKeyPrefix) return undefined;
  return {
    allowedTools: requestState.allowedTools as string[] | null ?? null,
    deniedTools: requestState.deniedTools as string[] | null ?? null,
    apiKeyPrefix: String(requestState.apiKeyPrefix),
  };
}

/** Strip auth_value from backend objects before sending to clients. */
function redactBackend(b: { auth_value?: string | null; oauth_client_secret?: string | null }): Record<string, unknown> {
  const { auth_value, oauth_client_secret, default_headers, ...rest } = b as {
    auth_value?: string | null; oauth_client_secret?: string | null; default_headers?: unknown;
  } & Record<string, unknown>;
  return {
    ...rest,
    auth_value: auth_value ? '••••••••' : null,
    oauth_client_secret: oauth_client_secret ? '••••••••' : null,
    default_headers: redactHeaders(default_headers),
  };
}

// ── User Bundle RBAC helpers ─────────────────────────────────

/** Filter tools by user's allowed_bundles. Admins and unrestricted users see everything. */
function filterToolsForUser<T extends { bundle_ids?: number[] }>(items: T[], user?: SessionUser): T[] {
  if (!user || user.role === 'admin' || user.allowed_bundles == null) return items;
  const set = new Set(user.allowed_bundles);
  return items.filter(t =>
    !t.bundle_ids || t.bundle_ids.length === 0 || t.bundle_ids.some(bid => set.has(bid)),
  );
}

const { Pool } = pg;

/** Refresh both the enabled-only and all-backends caches. */
async function refreshBackendCaches(pool: pg.Pool): Promise<void> {
  const [enabled, all] = await Promise.all([
    loadCustomBackends(pool),
    loadAllCustomBackends(pool),
  ]);
  setCustomBackends(enabled);
  setAllCustomBackends(all);
}

async function ensureJunctionTables(pool: pg.Pool): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mcp_backend_bundles (
        backend_id  INTEGER NOT NULL REFERENCES mcp_backends(id) ON DELETE CASCADE,
        bundle_id   INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
        PRIMARY KEY (backend_id, bundle_id)
      );
      CREATE TABLE IF NOT EXISTS mcp_tool_bundles (
        tool_id     INTEGER NOT NULL REFERENCES mcp_tools(id) ON DELETE CASCADE,
        bundle_id   INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
        PRIMARY KEY (tool_id, bundle_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_backend_bundles_bundle ON mcp_backend_bundles (bundle_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_bundles_bundle ON mcp_tool_bundles (bundle_id);
      -- Migrate legacy bundle_id data into junction tables (idempotent)
      INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
      SELECT id, bundle_id FROM mcp_backends WHERE bundle_id IS NOT NULL
      ON CONFLICT DO NOTHING;
      INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
      SELECT id, bundle_id FROM mcp_tools WHERE bundle_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    `);
    logger.info('Junction tables for n:m bundle associations ensured');
  } catch (err) {
    logger.warn({ err }, 'Failed to ensure junction tables (non-fatal)');
  }
}

async function main() {
  const config = loadConfig();
  const auditCheckpointSigner = config.auditEvidenceV1Enabled
    ? loadAuditCheckpointSignerFromEnv()
    : null;
  const externalEvidenceAnchorProvider = config.auditEvidenceV1Enabled
    ? loadExternalEvidenceAnchorProviderFromEnv()
    : null;
  let nativeAlertTimer: NodeJS.Timeout | null = null;
  const solutionPackRegistry = new SolutionPackRegistry(config.solutionPackEndpoints, {
    coreVersion: config.solutionPackCoreVersion,
    timeoutMs: config.solutionPackDiscoveryTimeoutMs,
  });

  logger.info({ port: config.port }, 'Starting Argus');

  // Initialize notifications (Slack / Teams)
  initNotifications();

  // Initialize audit log + metrics store (if PostgreSQL enabled)
  if (config.postgresEnabled) {
    await initAuditLog(config.postgresConnectionUrl);
    await initMetricsStore(config.postgresConnectionUrl);
    await recordServerEvent('start', { port: config.port, nodeVersion: process.version });
  }

  // Shared connection pool — reused across all routes (created once, never recreated)
  let sharedPool: pg.Pool | null = null;
  if (config.postgresEnabled) {
    sharedPool = new Pool({ connectionString: config.postgresConnectionUrl });
  }
  const { setSharedPool } = await import('./lib/sharedPool.js');
  setSharedPool(sharedPool);
  const executionGrantIssuer = sharedPool && config.solutionPackExecutionGrantSecret
    ? new ExecutionGrantIssuer(
      sharedPool,
      config.solutionPackExecutionGrantSecret,
      undefined,
      undefined,
      config.managedRuntimeReadOnlyBundleIds,
    )
    : undefined;
  // Core uses the same allow-listed Pack registry and Core-held service token
  // as A2A discovery; browser clients never receive either one.
  const solutionPackRuntimeAdapters = new SolutionPackRuntimeAdapterClient(solutionPackRegistry, {
    timeoutMs: config.solutionPackDiscoveryTimeoutMs,
  });
  const solutionPackA2a = new A2aHttpJsonClient(solutionPackRegistry, {
    timeoutMs: config.solutionPackDiscoveryTimeoutMs,
    ...(executionGrantIssuer ? { executionGrantIssuer } : {}),
    managedHermesAvailable: async () => {
      const status = await solutionPackRuntimeAdapters.getStatus('argus.hermes', 'hermes-http');
      return status.status.state === 'ready'
        && status.status.modes.some(mode => mode.mode === 'managed' && mode.state === 'ready');
    },
  });
  // Managed runtimes are a deliberate two-key opt-in. A deployment must name
  // the Core origin reachable by the per-run auth proxy *and* explicitly
  // approve the read-only Bundle IDs. The runtime Pack still has its own
  // capability/readiness gate, so this does not make Hermes runnable by itself.
  const managedRuntimeCoordinator = sharedPool
    && executionGrantIssuer
    && config.runtimeMcpOrigin
    && config.managedRuntimeReadOnlyBundleIds.length > 0
    ? new ManagedRuntimeCoordinator(
      executionGrantIssuer,
      new RuntimeMcpLeaseStore(sharedPool),
      solutionPackRuntimeAdapters,
      new ExplicitManagedRuntimeReadOnlyPolicy(config.managedRuntimeReadOnlyBundleIds),
      { runtimeMcpOrigin: config.runtimeMcpOrigin },
    )
    : undefined;
  if (config.runtimeMcpOrigin && config.managedRuntimeReadOnlyBundleIds.length === 0) {
    logger.warn('Managed runtime MCP origin is configured but no read-only Bundle IDs are approved; managed runtimes remain disabled');
  }
  configureAgentRuntimeExecutor(
    'hermes',
    new HermesRuntimeExecutor(solutionPackRuntimeAdapters, {}, managedRuntimeCoordinator),
  );
  const incidentAiopsTasks = sharedPool ? new PostgresIncidentAiopsTaskStore(sharedPool) : undefined;
  const incidentAiopsFeedback = sharedPool ? new PostgresIncidentAiopsFeedbackStore(sharedPool) : undefined;
  const incidentRemediations = sharedPool ? new PostgresIncidentRemediationStore(sharedPool) : undefined;
  const incidentRemediationExecutor = sharedPool && incidentRemediations
    ? new PostgresIncidentRemediationExecutor(
      sharedPool,
      config,
      incidentRemediations,
      undefined,
      appendIncidentRemediationAudit,
    )
    : undefined;
  const incidentImpactReader = sharedPool ? new PostgresIncidentImpactReader(sharedPool) : undefined;
  const nativeAlertAiopsDispatcher = sharedPool && incidentAiopsTasks
    ? new NativeAlertAiopsDispatcher(
      sharedPool,
      solutionPackA2a,
      incidentAiopsTasks,
      undefined,
      incidentImpactReader,
      (profileId, signal, principal, expectedActiveProfile) => startAiOpsServiceProfileInvestigation(
        sharedPool,
        profileId,
        signal,
        principal,
        {
          getProfile: getAiOpsServiceProfile,
          getRevision: getAiOpsServiceProfileRevision,
          evaluateReadiness: evaluateAiOpsServiceProfileReadiness,
          a2a: solutionPackA2a,
          now: () => new Date(),
        },
        expectedActiveProfile,
      ),
    )
    : undefined;
  const hermesDevBridge = sharedPool
    ? new HermesDevBridge(solutionPackA2a, new PostgresHermesDevBridgeTaskStore(sharedPool))
    : undefined;
  const hermesDevConnections = sharedPool
    ? new HermesDevConnectionManager(sharedPool, hermesDevBridge)
    : undefined;

  // L5 — Audit-Outbox Worker. Drained file-backed Retry-Queue alle 30s in
  // die DB. Wird hier nach Pool-Init gestartet damit Boot-Drain sofort läuft.
  if (sharedPool) {
    const { startAuditOutboxWorker } = await import('./audit/auditOutbox.js');
    startAuditOutboxWorker(sharedPool);
  }

  // Load custom backends (if PostgreSQL enabled)
  const startupPool = sharedPool;
  let canonicalAuditIntegrityMonitor: { stop(): void } | null = null;
  let auditReportWorker: { stop(): void } | null = null;
  let goldenPathEvidenceWorker: { stop(): void } | null = null;
  let fabricProfileDriftWorker: { stop(): void } | null = null;
  let evaluationRecoveryWorker: { stop(): void } | null = null;
  if (config.postgresEnabled && startupPool) {
    await ensureJunctionTables(startupPool);

    // Apply pending DB migrations from db/migrations/. Legacy databases
    // baseline historical migrations, then still apply current migrations.
    try {
      const { runPendingMigrations } = await import('./db/migrate.js');
      const r = await runPendingMigrations(startupPool, './db/migrations');
      if (r.failed.length > 0) {
        for (const failure of r.failed) {
          logger.error({ migration: failure.name, err: failure.error }, 'MIGRATION FAILED');
        }
        throw new Error(`${r.failed.length} database migration${r.failed.length === 1 ? '' : 's'} failed`);
      }
      if (r.baseline) {
        logger.info({ count: r.skipped.length }, 'Migrations baselined (existing DB)');
      } else if (r.applied.length) {
        logger.info({ applied: r.applied.length, failed: 0, skipped: r.skipped.length }, 'Migration check complete');
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Migration runner failed — aborting startup');
      throw err;
    }

    if (config.auditEvidenceV1Enabled) {
      canonicalAuditIntegrityMonitor = startCanonicalAuditIntegrityMonitor(startupPool, {
        signer: auditCheckpointSigner,
        intervalSec: config.auditCheckpointIntervalSec,
        outboxLagAlertSec: config.auditOutboxLagAlertSec,
      });
      if (auditCheckpointSigner) {
        auditReportWorker = startAuditReportWorker(startupPool, {
          signer: auditCheckpointSigner,
          intervalSec: config.auditReportWorkerIntervalSec,
        });
        goldenPathEvidenceWorker = startGoldenPathEvidenceWorker(startupPool, {
          signer: auditCheckpointSigner,
          intervalSec: 5,
        });
      }
    }

    evaluationRecoveryWorker = startEvaluationRecoveryWorker(startupPool, process.env['ARGUS_ENVIRONMENT'] || process.env['NODE_ENV'] || 'development');
    fabricProfileDriftWorker = startFabricProfileDriftWorker(startupPool, {
      intervalSec: config.mcpFabricProfileDriftIntervalSec,
      environment: process.env['NODE_ENV'] ?? 'development',
    });

    // Restore the last operator-visible Pack installation state before the
    // first health refresh. Endpoint and token configuration still comes from
    // the current environment; PostgreSQL only supplies durable evidence.
    try {
      const { SolutionPackPostgresStore } = await import('./solutionPacks/persistence.js');
      await solutionPackRegistry.attachPersistence(new SolutionPackPostgresStore(startupPool));
    } catch (err) {
      logger.warn({ err }, 'Solution Pack persistence unavailable; starting with live discovery only');
    }

    await refreshBackendCaches(startupPool);
    const backends = getCustomBackends();
    logger.info({ count: backends.length }, 'Custom backends loaded');

    // Load API key RBAC cache + auto-reload every 60s so deactivated keys take effect promptly
    await loadApiKeyRbac(startupPool);
    setInterval(() => loadApiKeyRbac(startupPool!).catch(() => {}), 60_000).unref();

    // Load Message Filter cache + auto-reload every 60s
    const initialFilters = await loadToolFilters(startupPool);
    setToolFilters(initialFilters);
    setInterval(async () => {
      try { setToolFilters(await loadToolFilters(startupPool!)); } catch { /* non-fatal */ }
    }, 60_000).unref();

    // Connect to all enabled remote MCP backends.
    // audit (gateway resilience): connect in PARALLEL and do NOT block startup
    // on it. Previously this was a sequential `await` loop — a single slow/dead
    // marketplace backend (now bounded by REMOTE_MCP_CONNECT_TIMEOUT_MS) would
    // delay startup by timeout × N, during which the /mcp gateway served 0
    // tools (including builtins). Now the server comes up immediately and remote
    // tools populate asynchronously; the auto-discovery poll keeps retrying.
    const mcpBackends = backends.filter(b => b.backend_type === 'mcp' && b.enabled);
    void Promise.allSettled(mcpBackends.map(async (backend) => {
      try {
        const conn = await connectRemoteMcp(backend);
        if (conn.connected) {
          await persistDiscoveredTools(startupPool!, backend.id, conn.tools);
        }
      } catch (err) {
        logger.warn({ err, backend: backend.name }, 'Failed to connect to MCP backend at startup');
      }
    }));
  }


  // Create MCP Server with all tools
  const { dynamicTools } = await createMcpServer(config);
  let currentDynamicTools = dynamicTools;

  const app = express();

  // Trust proxy: honour X-Forwarded-For from the configured number of upstream hops.
  // Must be set BEFORE any rate limiter reads req.ip.
  app.set('trust proxy', config.trustProxyHops);
  logger.info({ publicWidget: config.publicWidgetEnabled }, 'public widget master switch');

  // ── Security headers ────────────────────────────────────────
  // M4: tightened CSP
  // NOTE: 'unsafe-inline' for scriptSrc/scriptSrcAttr remains necessary because the admin UI
  // has 150+ inline event handlers (onclick/onchange) in server-rendered HTML templates.
  // TODO: migrate templates to external JS files + nonce-based CSP in a future refactor.
  // What IS improved here:
  //   - cdn.jsdelivr.net removed from scriptSrc (supply-chain risk) — Chart.js served locally
  //     or via /assets/. If Chart.js CDN is still needed, pin with a SHA-256 integrity hash.
  //   - frame-ancestors added (defense-in-depth against clickjacking, complements X-Frame-Options)
  //   - object-src 'none' and base-uri 'self' added (standard hardening)
  const isProduction = process.env.NODE_ENV === 'production';
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // unpkg.com whitelisted for cytoscape/dagre/cytoscape-dagre used by the
        // legacy /workflows DAG-preview. SHA-256 integrity hashes are pinned on
        // each <script> tag so a CDN compromise is detectable.
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        scriptSrcAttr: ["'unsafe-inline'"],              // inline onclick="..." — TODO: refactor to external JS
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameSrc: ["'self'", 'localhost:*'],             // Grafana iFrames (any local port)
        frameAncestors: ["'self'"],                      // clickjacking defense (complements frameguard)
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],                           // block Flash/plugins
        baseUri: ["'self'"],                             // block base-tag hijacking
        upgradeInsecureRequests: null,                   // disabled: HTTP still used in dev
      },
    },
    // HSTS: only enable in production (would break HTTP dev). 1 year, includeSubDomains.
    hsts: isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,
    noSniff: true,                                       // X-Content-Type-Options: nosniff
    frameguard: { action: 'sameorigin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  // IP-based rate limiter for login + register: max 10 attempts per minute per IP
  const loginRateLimiter = new RateLimiter(10);
  // Cleanup stale buckets every 5 minutes to prevent memory leak
  setInterval(() => loginRateLimiter.cleanup(), 300_000).unref();

  // ── MCP Accept Header Fix (MUST BE FIRST!) ─────────────────
  // Dify and other clients may not send the required Accept headers.
  // StreamableHTTPServerTransport requires both application/json AND text/event-stream.
  // Always force the correct Accept header for all /mcp requests.
  app.use('/mcp', (req, _res, next) => {
    const originalAccept = req.headers['accept'];
    // Always override — StreamableHTTPServerTransport is strict about this
    req.headers['accept'] = 'application/json, text/event-stream';
    if (originalAccept && originalAccept !== 'application/json, text/event-stream') {
      logger.debug({ originalAccept }, 'Overrode Accept header for MCP endpoint');
    }
    next();
  });
  
  // Body-parser with raw-body capture — required for webhook signature verification
  // (HMAC must be computed over the exact bytes the sender signed, not the
  // re-stringified JSON which can differ in key order / whitespace).
  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; },
  }));
  app.use(express.urlencoded({ extended: false, limit: '10mb' }));

  // Session middleware (cookie-based, requires PostgreSQL)
  let sessionPool: pg.Pool | null = null;
  if (config.postgresEnabled) {
    sessionPool = new Pool({ connectionString: config.postgresConnectionUrl });

    // Ensure user/session tables exist
    await sessionPool.query(`
      CREATE TABLE IF NOT EXISTS mcp_users (
        id              SERIAL PRIMARY KEY,
        username        VARCHAR(64) NOT NULL UNIQUE,
        password_hash   VARCHAR(256) NOT NULL,
        display_name    VARCHAR(128) NOT NULL DEFAULT '',
        role            VARCHAR(16) NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'editor', 'viewer')),
        allowed_bundles INTEGER[] DEFAULT NULL,
        enabled         BOOLEAN NOT NULL DEFAULT true,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login      TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS mcp_sessions (
        id            VARCHAR(64) PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES mcp_users(id) ON DELETE CASCADE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
        ip_address    VARCHAR(45),
        user_agent    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user ON mcp_sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires ON mcp_sessions (expires_at);
      -- Ensure allowed_bundles column exists (migration 009)
      ALTER TABLE mcp_users ADD COLUMN IF NOT EXISTS allowed_bundles INTEGER[] DEFAULT NULL;
      -- M2: account lockout columns (migration 012)
      ALTER TABLE mcp_users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE mcp_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ DEFAULT NULL;
    `);

    app.use(createSessionMiddleware(sessionPool));

    // Cleanup expired sessions every 30 minutes
    setInterval(() => cleanupExpiredSessions(sessionPool!), 1_800_000).unref();
    setInterval(() => cleanupExpiredShares(sessionPool!).catch(() => {}), 1_800_000).unref();
  }

  // Public docs — all registered BEFORE auth middleware (no login required)
  app.get('/openapi.json', (req, res) => {
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
    const baseUrl = `${proto}://${req.headers.host}`;
    res.json(buildOpenApiSpec(baseUrl));
  });
  const swaggerHtml = buildSwaggerHtml();
  app.get('/', (_req, res) => { res.redirect('/home'); });
  app.get('/api-docs', (_req, res) => { res.type('html').send(swaggerHtml); });
  // Swagger UI static assets (CSS + JS bundles) — must be public
  const swaggerDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'swagger-ui-dist');
  app.use('/swagger-ui-dist', express.static(swaggerDistDir, { maxAge: '1d' }));

  // OAuth2 JWT validation runs first — if valid JWT found, API key check is skipped
  initOAuth2(config);
  const oauth2Pool = sharedPool;
  app.use(createOAuth2Middleware(config, oauth2Pool
    ? async (username) => {
      const result = await oauth2Pool.query<OAuth2BoundUser>(
        `SELECT id, username, role, allowed_bundles, enabled, entra_groups
           FROM mcp_users WHERE username=$1`,
        [username],
      );
      return result.rows[0] ?? null;
    }
    : undefined));
  app.use(createExecutionGrantMiddleware(sharedPool, config.solutionPackExecutionGrantSecret));
  app.use(createApiKeyMiddleware(config));

  // ── Public endpoints (no auth) ──────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/ready', (_req, res) => {
    res.json({ status: 'ready' });
  });

  // Prometheus metrics endpoint — H4: restrict to localhost + authenticated requests only
  // Grafana/Prometheus scrapers should run on the same host or use an API key.
  app.get('/metrics', (req, res, next) => {
    const ip = req.ip ?? '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    // Allow if: local IP or valid API key (for Prometheus scraping)
    const hasApiKey = !!(req as unknown as Record<string, unknown>).apiKeyPrefix;
    if (isLocal || hasApiKey) return next();
    // Session auth: restrict to admins only (metrics expose system internals)
    const user = (req as unknown as { user?: { role?: string } }).user;
    if (user?.role === 'admin') return next();
    res.status(403).json({ error: 'Forbidden — admin role required for metrics access' });
  }, async (_req, res) => {
    try {
      const metrics = await registry.metrics();
      res.set('Content-Type', registry.contentType);
      res.send(metrics);
    } catch (err) {
      logger.error({ err }, 'Failed to collect metrics');
      res.status(500).json({ error: 'Failed to collect metrics' });
    }
  });

  // Serve static assets (logo, etc.) - public, no auth needed
  const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
  // The widget loader is intentionally consumed as a classic script by an
  // allowlisted external website. Helmet's default same-origin CORP header
  // would prevent the browser from executing it before the widget's stricter
  // frame-ancestors policy can evaluate the configured website origin.
  app.use('/assets/argus-widget.js', (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });
  app.use('/assets', express.static(assetsDir, { maxAge: '7d' }));

  // Chat SPA assets — served when CHAT_SPA_ENABLED=true. Mount the whole dist
  // (NOT dist/assets): Vite base '/chat-assets/' emits URLs like
  // /chat-assets/assets/index-*.js, so /chat-assets must map to dist/ (which
  // contains assets/). Filenames are content-hashed → immutable cache.
  app.use('/chat-assets', express.static(path.resolve(process.cwd(), 'argus-chat-ui/dist'), { maxAge: '1y', immutable: true }));

  // New Argus Console SPA. Vite emits content-hashed assets below this mount.
  app.use('/console-assets', express.static(path.resolve(process.cwd(), 'argus-console/dist'), { maxAge: '1y', immutable: true }));

  // ── Authentication routes ──────────────────────────────────

  if (sessionPool) {
    const authPool = sessionPool;
    const interactiveSsoView = {
      entraSsoEnabled: config.oidcSsoEnabled,
      ssoProviderName: config.oidcProviderName,
      ssoProvider: config.oidcProvider,
    } as const;

    app.get('/login', async (req, res) => {
      // Already logged in? Redirect to role-appropriate landing
      const existingUser = (req as AuthenticatedRequest).user;
      if (existingUser) {
        res.redirect(landingFor(existingUser.role));
        return;
      }
      const firstUser = await isFirstUser(authPool);
      res.type('html').send(renderLoginHtml({
        registrationMode: firstUser,
        ...interactiveSsoView,
        localAuthEnabled: config.localAuthEnabled,
      }));
    });

    app.post('/auth/register', async (req, res) => {
      try {
        const clientIp = req.ip ?? 'unknown';
        if (!await loginRateLimiter.isAllowed(clientIp)) {
          res.status(429).type('html').send(renderLoginHtml({ error: 'Zu viele Versuche. Bitte warte eine Minute.' }));
          return;
        }
        const firstUser = await isFirstUser(authPool);
        if (!firstUser) {
          res.type('html').send(renderLoginHtml({ error: 'Registrierung ist nicht mehr moeglich. Bitte beim Administrator melden.' }));
          return;
        }
        const { username, password, password_confirm, display_name } = req.body;
        if (!username || !password || !display_name) {
          res.type('html').send(renderLoginHtml({ registrationMode: true, error: 'Alle Felder muessen ausgefuellt werden.' }));
          return;
        }
        if (password !== password_confirm) {
          res.type('html').send(renderLoginHtml({ registrationMode: true, error: 'Passwörter stimmen nicht überein.' }));
          return;
        }
        const pwError = validatePasswordStrength(password, username);
        if (pwError) {
          res.type('html').send(renderLoginHtml({ registrationMode: true, error: pwError }));
          return;
        }
        // First-user-Registration kriegt platform_admin (höchste Rolle seit migration 060).
        // Vorher war 'admin' aber Migration 060 hat die Rolle in 'platform_admin' umbenannt.
        const result = await createFirstUserAudited(authPool, {
          username,
          password,
          displayName: display_name,
        }, buildFirstUserBootstrapAuditContext(req));
        const user = result.value;
        logger.info({ username: user.username, replayed: result.replayed }, 'First platform_admin registration processed');
        const sessionId = await createSession(authPool, user.id, config.sessionMaxAgeHours, req.ip, req.headers['user-agent']);
        setSessionCookie(res, sessionId, config.sessionMaxAgeHours, isProduction);
        res.redirect(landingFor(user.role));
      } catch (err) {
        if (err instanceof UserLifecycleError && err.code === 'FIRST_USER_EXISTS') {
          res.status(err.status).type('html').send(renderLoginHtml({
            registrationMode: false,
            error: 'Registrierung ist nicht mehr möglich. Bitte beim Administrator melden.',
            ...interactiveSsoView,
            localAuthEnabled: config.localAuthEnabled,
          }));
          return;
        }
        logger.error({ err }, 'Registration failed');
        res.type('html').send(renderLoginHtml({ registrationMode: true, error: 'Registrierung fehlgeschlagen. Benutzername evtl. bereits vergeben.' }));
      }
    });

    app.post('/auth/login', async (req, res) => {
      try {
        // Block local login if SSO-only mode — except emergency local admins
        const ssoOnlyMode = config.oidcSsoEnabled && config.entraDisableLocalLogin;
        let emergencyLocalLoginAttempt = false;
        if (!config.localAuthEnabled || ssoOnlyMode) {
          // Emergency override: platform_admin local users can still log in
          const { username } = req.body as { username?: string };
          emergencyLocalLoginAttempt = Boolean(ssoOnlyMode && config.entraEmergencyLocalAdmin && username);
          if (!emergencyLocalLoginAttempt) {
            res.status(403).type('html').send(renderLoginHtml({
              error: `Lokale Anmeldung ist deaktiviert. Bitte ${config.oidcProviderName} SSO verwenden.`,
              ...interactiveSsoView,
              localAuthEnabled: false,
            }));
            return;
          }
          // Fall through — emergency admin login proceeds normally below
        }
        // IP-based brute-force protection: 10 attempts/minute per IP
        const clientIp = req.ip ?? 'unknown';
        if (!await loginRateLimiter.isAllowed(clientIp)) {
          logger.warn({ ip: clientIp }, 'Login rate limit exceeded');
          res.status(429).type('html').send(renderLoginHtml({
            error: 'Zu viele Anmeldeversuche. Bitte warte eine Minute.',
            ...interactiveSsoView,
            localAuthEnabled: config.localAuthEnabled,
          }));
          return;
        }
        const { username, password } = req.body;
        if (!username || !password) {
          res.type('html').send(renderLoginHtml({
            error: 'Benutzername und Passwort erforderlich.',
            ...interactiveSsoView,
            localAuthEnabled: config.localAuthEnabled,
          }));
          return;
        }

        // H3: Session Fixation — invalidate any pre-existing session before creating a new one
        const existingSessionId = req.headers.cookie?.split(';')
          .find(c => c.trim().startsWith('argus_session='))?.split('=')[1]?.trim();
        if (existingSessionId) {
          await deleteSession(authPool, existingSessionId).catch(() => {});
        }

        const user = await authenticateUser(authPool, username, password);
        if (!user) {
          // Do NOT log username here — prevents enumeration of valid usernames
          // from compromised log files. Account lockout is tracked DB-side per user_id.
          logger.warn({ ip: clientIp }, 'Failed login attempt');
          res.type('html').send(renderLoginHtml({
            error: 'Ungültige Anmeldedaten.',
            ...interactiveSsoView,
            localAuthEnabled: config.localAuthEnabled,
          }));
          return;
        }

        // Only an already-existing platform administrator may use the local
        // emergency path. Check after password verification to avoid leaking
        // usernames or roles through distinct authentication responses.
        if (emergencyLocalLoginAttempt && normalizeRole(user.role) !== 'platform_admin') {
          logger.warn({ userId: user.id, ip: clientIp }, 'Rejected non-admin emergency local login');
          res.status(403).type('html').send(renderLoginHtml({
            error: 'Lokale Notfall-Anmeldung ist ausschließlich für Platform-Administratoren erlaubt.',
            ...interactiveSsoView,
            localAuthEnabled: false,
          }));
          return;
        }

        // Password rotation enforcement: block login if password is expired.
        // Only applies to local users who have set a password (password_changed_at not null).
        if (sessionPool && PASSWORD_MAX_AGE_DAYS > 0) {
          const { getPasswordAge } = await import('./auth/userAuth.js');
          const pwAge = await getPasswordAge(sessionPool, user.id, PASSWORD_MAX_AGE_DAYS).catch(() => null);
          if (pwAge?.expired) {
            logger.warn({ userId: user.id }, 'Login blocked — password expired');
            res.type('html').send(renderLoginHtml({
              error: `Dein Passwort ist abgelaufen (>${PASSWORD_MAX_AGE_DAYS} Tage). Bitte einen Administrator bitten, es zurückzusetzen.`,
              ...interactiveSsoView,
              localAuthEnabled: config.localAuthEnabled,
            }));
            return;
          }
        }

        const sessionId = await createSession(authPool, user.id, config.sessionMaxAgeHours, req.ip, req.headers['user-agent']);
        setSessionCookie(res, sessionId, config.sessionMaxAgeHours, isProduction);
        res.redirect(landingFor(user.role));
      } catch (err) {
        logger.error({ err }, 'Login failed');
        res.type('html').send(renderLoginHtml({
          error: 'Anmeldung fehlgeschlagen.',
          ...interactiveSsoView,
          localAuthEnabled: config.localAuthEnabled,
        }));
      }
    });

    // ── Interactive OIDC SSO routes ──────────────────────────────
    // /auth/entra/* remains as a compatibility alias for existing Entra app
    // registrations. Generic providers use /auth/oidc/*.

    app.get(['/auth/oidc/login', '/auth/entra/login'], (req, res) => {
      if (!config.oidcSsoEnabled) {
        res.redirect('/login');
        return;
      }
      const returnTo = safeRedirectPath(req.query['returnTo']);
      const { url, browserBinding } = buildAuthorizationUrl(config, returnTo);
      res.append('Set-Cookie', oidcBrowserBindingCookie(browserBinding, isProduction));
      res.redirect(url);
    });

    app.get(['/auth/oidc/step-up', '/auth/entra/step-up'], requireAuth, (req, res) => {
      if (!config.oidcSsoEnabled) {
        res.status(503).json({ error: 'OIDC SSO ist nicht aktiviert', code: 'OIDC_DISABLED' });
        return;
      }
      const user = (req as AuthenticatedRequest).user!;
      if (user.auth_method !== 'oidc' || !/^(?:entra|oidc):/.test(user.username)) {
        res.status(403).json({
          error: 'MFA-Step-up erfordert eine bestehende SSO-Sitzung',
          code: 'SSO_SESSION_REQUIRED',
        });
        return;
      }
      const returnTo = safeRedirectPath(req.query['returnTo'], '/governance/compliance');
      const { url, browserBinding } = buildAuthorizationUrl(config, returnTo, {
        stepUp: true,
        expectedUsername: user.username,
      });
      res.append('Set-Cookie', oidcBrowserBindingCookie(browserBinding, isProduction));
      res.redirect(url);
    });

    // Convert the currently authenticated local account into a verified SSO
    // identity. The signed state binds the callback to this stable Argus user
    // id; the callback additionally requires fresh provider MFA.
    app.post('/api/me/identity-security/link', requireAuth, requireSameOrigin, (req, res) => {
      if (!config.oidcSsoEnabled) {
        res.status(503).json({ error: 'OIDC SSO ist nicht aktiviert', code: 'OIDC_DISABLED' });
        return;
      }
      const user = (req as AuthenticatedRequest).user!;
      if (user.auth_method === 'oidc' || /^(?:entra|oidc):/.test(user.username)) {
        res.status(409).json({ error: 'Das Konto ist bereits mit SSO verknüpft', code: 'SSO_ALREADY_LINKED' });
        return;
      }
      const { url, browserBinding } = buildAuthorizationUrl(config, '/settings/identity', { linkUserId: user.id });
      res.append('Set-Cookie', oidcBrowserBindingCookie(browserBinding, isProduction));
      res.json({ authorizationUrl: url });
    });

    app.get(['/auth/oidc/callback', '/auth/entra/callback'], async (req, res) => {
      if (!config.oidcSsoEnabled) {
        res.redirect('/login');
        return;
      }

      const { code, state, error: authError, error_description } = req.query as Record<string, string>;
      // The binding cookie is single-use: clear it on every callback outcome.
      const browserBinding = parseCookieValue(req.headers.cookie, OIDC_BROWSER_BINDING_COOKIE);
      res.append('Set-Cookie', clearOidcBrowserBindingCookie());
      if (authError) {
        logger.warn({ error: authError, error_description }, 'OIDC authorization error');
        res.type('html').send(renderLoginHtml({
          error: `${config.oidcProviderName}-Anmeldung fehlgeschlagen: ${error_description || authError}`,
          ...interactiveSsoView,
          localAuthEnabled: config.localAuthEnabled,
        }));
        return;
      }
      if (!code || !state) {
        res.redirect('/login');
        return;
      }

      try {
        const {
          user: oidcUser,
          redirectAfter,
          assurance,
          purpose,
          linkTargetUserId,
        } = await handleCallback(config, code, state, browserBinding);
        const mapping = resolveEntraRoleMapping(config, oidcUser.groups);
        // The Entra preset retains the historical `entra:<oid>` format. Other
        // issuers are namespaced by an issuer hash plus their stable subject.
        const ssoUsername = oidcUsername(config, oidcUser);
        const identity = {
          username: ssoUsername,
          displayName: oidcUser.displayName,
          groups: oidcUser.groups,
          provider: config.oidcProvider,
          mapping,
        };
        if (purpose === 'mfa_step_up') {
          // Step-up refreshes assurance for the still-active session; it is
          // never a way to start a session for that identity from scratch.
          const activeUser = (req as AuthenticatedRequest).user;
          if (!activeUser || activeUser.username !== ssoUsername) {
            throw new Error('OIDC MFA step-up requires the matching active session');
          }
        }
        const auditContext = buildSsoIdentityAuditContext(state, {
          environment: process.env['NODE_ENV'] ?? 'development',
        });
        const synchronized = purpose === 'link_identity'
          ? await (async () => {
            const activeUser = (req as AuthenticatedRequest).user;
            if (
              !activeUser
              || activeUser.auth_method === 'oidc'
              || !linkTargetUserId
              || activeUser.id !== linkTargetUserId
            ) {
              throw new SsoIdentityLifecycleError(
                'The account-linking session does not match the active local user.',
                403,
                'SSO_LINK_SESSION_MISMATCH',
              );
            }
            return linkSsoIdentityAudited(authPool, activeUser.id, identity, auditContext);
          })()
          : await syncSsoIdentityAudited(authPool, identity, auditContext);
        const userId = synchronized.value.id;
        const role = synchronized.value.role;
        logger.info({ userId, role, replayed: synchronized.replayed },
          synchronized.before ? 'OIDC user synchronized' : 'OIDC user auto-provisioned');

        const existingSessionId = parseArgusSessionCookie(req.headers.cookie);
        if (existingSessionId) await deleteSession(authPool, existingSessionId).catch(() => {});
        const sessionId = await createSession(
          authPool,
          userId,
          config.sessionMaxAgeHours,
          req.ip,
          req.headers['user-agent'],
          assurance,
        );
        setSessionCookie(res, sessionId, config.sessionMaxAgeHours, isProduction);
        // setSessionCookie replaces Set-Cookie; keep clearing the binding cookie.
        res.append('Set-Cookie', clearOidcBrowserBindingCookie());
        res.redirect(redirectAfter === '/status' ? landingFor(role) : safeRedirectPath(redirectAfter));
      } catch (err) {
        logger.error({ err }, 'OIDC callback failed');
        res.type('html').send(renderLoginHtml({
          error: err instanceof SsoIdentityLifecycleError && err.code === 'SSO_ACCOUNT_DISABLED'
            ? 'Dein Konto ist deaktiviert. Bitte den Administrator kontaktieren.'
            : `${config.oidcProviderName}-Anmeldung fehlgeschlagen. Bitte erneut versuchen.`,
          ...interactiveSsoView,
          localAuthEnabled: config.localAuthEnabled,
        }));
      }
    });

    app.post('/auth/logout', requireSameOrigin, async (req, res) => {
      const sessionId = parseArgusSessionCookie(req.headers.cookie);
      if (sessionId) {
        try {
          await deleteSession(authPool, sessionId);
        } catch (err) {
          logger.warn({ err, sessionId }, 'Failed to delete session during logout');
        }
      }
      clearSessionCookie(res);
      res.redirect('/login');
    });
  } else {
    // No PostgreSQL = no auth, redirect /login to /status
    app.get('/login', (_req, res) => res.redirect('/status'));
  }

  // ── Protected pages (require login) ─────────────────────────

  const consoleIndex = path.resolve(process.cwd(), 'argus-console/dist/index.html');
  const sendConsoleIndex = (_req: express.Request, res: express.Response): void => {
    if (!existsSync(consoleIndex)) {
      res.status(503).type('html').send(
        '<h1>Argus Console is not built</h1><p>Run <code>cd argus-console &amp;&amp; npm install &amp;&amp; npm run build</code>.</p>',
      );
      return;
    }
    res.sendFile(consoleIndex);
  };
  app.get(['/home', '/build/agents', '/build/workflows', '/build/workflows/studio', '/build/workflows/studio/:id', '/runs', '/runs/:kind/:id', '/mcp-fabric', '/mcp-fabric/bundles/:id', '/governance', '/observe', '/observe/logs', '/settings', '/settings/identity', '/connections'], requireAuth, sendConsoleIndex);
  app.get(['/observe/activity', '/observe/audit', '/observe/alerts', '/observe/health', '/observe/slos', '/observe/dependencies', '/observe/quality'], requireAuth, requireAdmin, sendConsoleIndex);
  app.get('/build/agents/manage', requireAuth, requireAdmin, sendConsoleIndex);
  app.get([
    '/build/knowledge',
    '/build/skills',
    '/build/evaluations',
    '/build/agents/channels',
    '/build/public-widgets',
    '/settings/public-channels',
  ], requireAuth, requireAdmin, sendConsoleIndex);
  // Solution workflows are day-to-day developer/operator surfaces. Their
  // mutation endpoints retain their own stricter guards; serving the SPA must
  // match the developer-level read API instead of requiring platform admin.
  app.get('/solutions/:packId', requireAuth, requireRole('developer'), sendConsoleIndex);
  app.get(['/mcp-fabric/capabilities', '/governance/policies', '/governance/runtime-controls', '/governance/compliance', '/governance/compliance/runs/:id', '/settings/api-keys', '/settings/users', '/settings/platform', '/settings/readiness', '/settings/models', '/settings/models/runtime-controls'], requireAuth, requireAdmin, sendConsoleIndex);

  if (sharedPool) {
    // Console views share a short-lived health snapshot. A complete status
    // check may probe several remote systems, so avoid duplicating that work
    // for concurrent page loads and begin warming it before the first view.
    const consoleStatusSnapshot = createStatusSnapshotLoader(
      () => getStatus(config, currentDynamicTools, getAllCustomBackends()),
      15_000,
    );
    consoleStatusSnapshot.warm();

    const loadClaudeRuntimeStatus = async (): Promise<Record<string, unknown>> => {
      const response = await fetch(`${AGENT_WORKSPACE_URL.replace(/\/+$/, '')}/claude/status`, {
        headers: { 'x-workspace-secret': WORKSPACE_SECRET },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Claude Code runtime status HTTP ${response.status}`);
      const status = await response.json() as Record<string, unknown>;
      const workspaceRuns = Array.isArray(status['runs'])
        ? status['runs'].filter((run): run is Record<string, unknown> => Boolean(run && typeof run === 'object' && !Array.isArray(run)))
        : [];
      const seenRunIds = new Set(workspaceRuns.map(run => typeof run['id'] === 'string' ? run['id'] : ''));
      let persistedRuns: Record<string, unknown>[] = [];
      try {
        const traces = await listTelemetryTraces(sharedPool, { userId: 0, observeAll: true, hours: 24 * 90, limit: 200, kind: 'agent' });
        persistedRuns = traces.filter(trace => trace.metadata?.['runtime'] === 'claude-code' && typeof trace.metadata?.['runtime_run_id'] === 'string').map(trace => {
          const metadata = trace.metadata ?? {};
          return {
            id: String(metadata['runtime_run_id']), telemetryTraceId: trace.id, telemetryRootTraceId: trace.root_trace_id,
            state: trace.status === 'cancelled' ? 'canceled' : trace.status, startedAt: trace.started_at,
            updatedAt: trace.ended_at ?? trace.started_at, ...(trace.ended_at ? { finishedAt: trace.ended_at } : {}),
            cwd: typeof metadata['runtime_cwd'] === 'string' ? metadata['runtime_cwd'] : '', model: trace.model,
            reasoningEffort: null, timeoutSec: Number(metadata['timeout_sec'] ?? 0) || 0,
            threadId: typeof metadata['claude_session_id'] === 'string' ? metadata['claude_session_id'] : null,
            rootTraceId: trace.root_trace_id, agentId: trace.agent_id,
            taskType: typeof metadata['task_type'] === 'string' ? metadata['task_type'] : null,
            ...(typeof metadata['error_code'] === 'string' ? { errorCode: metadata['error_code'] } : {}),
            ...(trace.error_message ? { error: trace.error_message } : {}),
            ...(typeof metadata['cancel_reason'] === 'string' ? { cancelReason: metadata['cancel_reason'] } : {}),
          };
        }).filter(run => !seenRunIds.has(String(run['id'])));
      } catch (error) {
        logger.warn({ err: error }, 'Claude Code runtime history unavailable');
      }
      return { ...status, recentRuns: Number(status['recentRuns'] ?? 0) + persistedRuns.length, runs: [...workspaceRuns, ...persistedRuns] };
    };

    const callWorkspaceRuntimeAuth = async (
      provider: 'codex' | 'claude-code',
      suffix: string,
      init: RequestInit = {},
    ): Promise<Record<string, unknown>> => {
      const headers = new Headers(init.headers);
      headers.set('x-workspace-secret', WORKSPACE_SECRET);
      if (init.body) headers.set('content-type', 'application/json');
      const response = await fetch(
        `${AGENT_WORKSPACE_URL.replace(/\/+$/, '')}/runtime-auth/${provider}${suffix}`,
        {
          ...init,
          headers,
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        throw Object.assign(
          new Error(String(body['error'] ?? `Runtime authentication HTTP ${response.status}`)),
          { statusCode: response.status },
        );
      }
      return body;
    };

    registerConsoleApi(app, {
      pool: sharedPool,
      config,
      requireAuth,
      requireSameOrigin,
      loadStatus: () => consoleStatusSnapshot.load(),
      listActiveSessions: listActive,
      refreshBackends: async () => {
        await refreshBackendCaches(sharedPool);
        consoleStatusSnapshot.invalidate();
        consoleStatusSnapshot.warm();
      },
      refreshDynamicTools: async () => {
        currentDynamicTools = await loadDynamicTools(sharedPool);
        consoleStatusSnapshot.invalidate();
        consoleStatusSnapshot.warm();
      },
      publicWidgetEnabled: config.publicWidgetEnabled,
      loadCodexRuntimeStatus: async () => {
        const response = await fetch(`${AGENT_WORKSPACE_URL.replace(/\/+$/, '')}/codex/status`, {
          headers: { 'x-workspace-secret': WORKSPACE_SECRET },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Codex runtime status HTTP ${response.status}`);
        const status = await response.json() as Record<string, unknown>;
        const workspaceRuns = Array.isArray(status['runs'])
          ? status['runs'].filter((run): run is Record<string, unknown> => Boolean(run && typeof run === 'object' && !Array.isArray(run)))
          : [];
        const seenRunIds = new Set(workspaceRuns.map(run => typeof run['id'] === 'string' ? run['id'] : ''));
        let persistedRuns: Record<string, unknown>[] = [];
        try {
          const traces = await listTelemetryTraces(sharedPool, {
            userId: 0,
            observeAll: true,
            hours: 24 * 90,
            limit: 200,
            kind: 'agent',
          });
          persistedRuns = traces
            .filter(trace => trace.metadata?.['runtime'] === 'codex-sdk' && typeof trace.metadata?.['runtime_run_id'] === 'string')
            .map(trace => {
              const metadata = trace.metadata ?? {};
              const runtimeRunId = String(metadata['runtime_run_id']);
              const runtimeState = trace.status === 'cancelled' ? 'canceled' : trace.status;
              return {
                id: runtimeRunId,
                telemetryTraceId: trace.id,
                telemetryRootTraceId: trace.root_trace_id,
                state: runtimeState,
                startedAt: trace.started_at,
                updatedAt: trace.ended_at ?? trace.started_at,
                ...(trace.ended_at ? { finishedAt: trace.ended_at } : {}),
                cwd: typeof metadata['runtime_cwd'] === 'string' ? metadata['runtime_cwd'] : '',
                model: trace.model,
                reasoningEffort: typeof metadata['reasoning_effort'] === 'string' ? metadata['reasoning_effort'] : null,
                timeoutSec: Number(metadata['timeout_sec'] ?? 0) || 0,
                threadId: typeof metadata['codex_thread_id'] === 'string' ? metadata['codex_thread_id'] : null,
                rootTraceId: trace.root_trace_id,
                agentId: trace.agent_id,
                taskType: typeof metadata['task_type'] === 'string' ? metadata['task_type'] : null,
                ...(typeof metadata['error_code'] === 'string' ? { errorCode: metadata['error_code'] } : {}),
                ...(trace.error_message ? { error: trace.error_message } : {}),
                ...(typeof metadata['cancel_reason'] === 'string' ? { cancelReason: metadata['cancel_reason'] } : {}),
              };
            })
            .filter(run => !seenRunIds.has(String(run['id'])));
        } catch (error) {
          logger.warn({ err: error }, 'Codex runtime history unavailable');
        }
        return {
          ...status,
          recentRuns: Number(status['recentRuns'] ?? 0) + persistedRuns.length,
          runs: [...workspaceRuns, ...persistedRuns],
        };
      },
      loadClaudeRuntimeStatus,
      cancelCodexRuntimeRun: async (runId: string) => {
        const response = await fetch(`${AGENT_WORKSPACE_URL.replace(/\/+$/, '')}/codex/runs/${encodeURIComponent(runId)}/cancel`, {
          method: 'POST',
          headers: { 'x-workspace-secret': WORKSPACE_SECRET },
          signal: AbortSignal.timeout(5_000),
        });
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) throw new Error(String(body['error'] ?? `Codex runtime cancellation HTTP ${response.status}`));
        return body;
      },
      cancelClaudeRuntimeRun: async (runId: string) => {
        const response = await fetch(`${AGENT_WORKSPACE_URL.replace(/\/+$/, '')}/claude/runs/${encodeURIComponent(runId)}/cancel`, {
          method: 'POST',
          headers: { 'x-workspace-secret': WORKSPACE_SECRET },
          signal: AbortSignal.timeout(5_000),
        });
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) throw new Error(String(body['error'] ?? `Claude Code runtime cancellation HTTP ${response.status}`));
        return body;
      },
      startRuntimeAuthSession: (provider, input) => callWorkspaceRuntimeAuth(provider, '/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      loadRuntimeAuthSession: (provider, sessionId) =>
        callWorkspaceRuntimeAuth(provider, `/sessions/${encodeURIComponent(sessionId)}`),
      submitRuntimeAuthCode: (provider, sessionId, code) =>
        callWorkspaceRuntimeAuth(provider, `/sessions/${encodeURIComponent(sessionId)}/code`, {
          method: 'POST',
          body: JSON.stringify({ code }),
        }),
      cancelRuntimeAuthSession: (provider, sessionId) =>
        callWorkspaceRuntimeAuth(provider, `/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
    });
    registerGlobalSearchRoutes(app, sharedPool, requireAuth);
    registerEvaluationRoutes(app, sharedPool, { config, requireAuth, requireAdmin, requireSameOrigin });
    registerTagRoutes(app, sharedPool, requireAuth, requireSameOrigin);
    registerRunReadModelRoutes(app, sharedPool, requireAuth, listActive);
    registerGoldenPathRoutes(app, sharedPool, requireAuth, {
      auditEvidenceEnabled: config.auditEvidenceV1Enabled,
      requireSameOrigin,
      loadPackState: async packId => {
        const current = solutionPackRegistry.get(packId);
        const observed = current?.state === 'not_checked'
          ? await solutionPackRegistry.refreshPack(packId)
          : current;
        return observed ? {
          state: observed.state,
          version: observed.manifest?.metadata.version ?? null,
        } : null;
      },
      startWorkflow: input => startWorkflowExecution(
        sharedPool,
        config,
        async (name, args) => executeTool(name, args, { config, pool: sharedPool }),
        input,
      ),
    });
    registerPlatformReadinessRoutes(app, sharedPool, requireAuth, {
      requireSameOrigin,
      requireFreshMfa: requireFreshMfa(config.oidcMfaMaxAgeSeconds),
      environment: process.env.ARGUS_ENVIRONMENT ?? 'local',
    });
    registerRepositoryGraphRoutes(app, sharedPool, requireAuth, { enabled: config.repositoryGraphEnabled });
    registerAuditEvidenceRoutes(app, sharedPool, requireAuth, {
      enabled: config.auditEvidenceV1Enabled,
      requireSameOrigin,
      requireFreshMfa: requireFreshMfa(config.oidcMfaMaxAgeSeconds),
      mfaMaxAgeSeconds: config.oidcMfaMaxAgeSeconds,
      signer: auditCheckpointSigner,
      externalArchiveProvider: externalEvidenceAnchorProvider,
    });
    registerAuditReportRoutes(app, sharedPool, requireAuth, {
      enabled: config.auditEvidenceV1Enabled,
      signer: auditCheckpointSigner,
      requireSameOrigin,
      requireFreshMfa: requireFreshMfa(config.oidcMfaMaxAgeSeconds),
      mfaMaxAgeSeconds: config.oidcMfaMaxAgeSeconds,
      externalAnchorProvider: externalEvidenceAnchorProvider,
    });
    registerAiSystemRoutes(app, sharedPool, requireAuth, requireSameOrigin, {}, {
      requireFreshMfa: requireFreshMfa(config.oidcMfaMaxAgeSeconds),
      mfaMaxAgeSeconds: config.oidcMfaMaxAgeSeconds,
    });
    registerAiSystemControlRoutes(
      app,
      sharedPool,
      requireAuth,
      requireSameOrigin,
      requireFreshMfa(config.oidcMfaMaxAgeSeconds),
      config.oidcMfaMaxAgeSeconds,
    );
    registerAiComplianceDossierRoutes(
      app,
      sharedPool,
      requireAuth,
      requireSameOrigin,
      requireFreshMfa(config.oidcMfaMaxAgeSeconds),
    );
    registerAiOpsServiceProfileRoutes(app, sharedPool, requireAuth, requireSameOrigin, {
      preflightQuery: (pool, input) => runAiOpsEvidenceQueryPreflight(pool, config, input),
      startInvestigation: (pool, profileId, signal, principal) => startAiOpsServiceProfileInvestigation(
        pool,
        profileId,
        signal,
        principal,
        {
          getProfile: getAiOpsServiceProfile,
          getRevision: getAiOpsServiceProfileRevision,
          evaluateReadiness: evaluateAiOpsServiceProfileReadiness,
          a2a: solutionPackA2a,
          now: () => new Date(),
        },
      ),
      loadPackReadiness: () => {
        const aiops = solutionPackRegistry.get('argus.aiops');
        return {
          state: aiops?.state === 'ready' ? 'ready' : aiops?.state === 'degraded' ? 'degraded' : 'offline',
          version: aiops?.manifest?.metadata.version ?? null,
        };
      },
    });
    registerAiOpsProviderSignalRoutes(app, sharedPool, {
      dispatch: async () => nativeAlertAiopsDispatcher?.dispatchOnce(),
    });
  }

  registerSolutionPackRoutes(
    app,
    solutionPackRegistry,
    requireAuth,
    requireAdmin,
    requireSameOrigin,
    solutionPackA2a,
    incidentAiopsTasks,
    nativeAlertAiopsDispatcher,
    incidentImpactReader,
    incidentRemediations,
    incidentRemediationExecutor,
    solutionPackRuntimeAdapters,
    managedRuntimeCoordinator,
    requireRole('developer'),
    sharedPool ? {
      approvedBundleIds: config.managedRuntimeReadOnlyBundleIds,
      listCoreAgents: async user => (await listChatVisibleAgents(sharedPool, user))
        .map(agent => ({ id: agent.id, name: agent.name, label: agent.label }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      listMemoryProposals: async (user, limit) => listManagedRuntimeMemoryProposals(
        sharedPool,
        { kind: 'user', id: String(user.id) },
        limit,
      ),
      decideMemoryProposal: async (user, proposalId, decision) => decideManagedRuntimeMemoryProposal(
        sharedPool,
        proposalId,
        decision,
        { kind: 'user', id: String(user.id) },
      ),
    } : undefined,
    incidentAiopsFeedback,
  );
  if (sharedPool) {
    // The external deployment controller receives only the durable rollback
    // hand-off. It is responsible for applying the target image in its own
    // orchestrator and reports accepted/applied/failed back to Core.
    const { SolutionPackPostgresStore } = await import('./solutionPacks/persistence.js');
    const { createSolutionPackReconcilerRouter } = await import('./solutionPacks/reconcilerRoutes.js');
    app.use(createSolutionPackReconcilerRouter(new SolutionPackPostgresStore(sharedPool)));
  }
  if (config.solutionPackEndpoints.length > 0) {
    const refreshSolutionPacks = async (): Promise<void> => {
      const packs = await solutionPackRegistry.refresh();
      logger.info({
        total: packs.length,
        ready: packs.filter(pack => pack.state === 'ready').length,
        degraded: packs.filter(pack => pack.state === 'degraded').length,
        unavailable: packs.filter(pack => ['unreachable', 'invalid', 'incompatible'].includes(pack.state)).length,
      }, 'Solution Pack discovery refreshed');
    };
    void refreshSolutionPacks().catch(error => logger.warn({ err: error }, 'Solution Pack discovery failed'));
    if (Number.isFinite(config.solutionPackRefreshSec) && config.solutionPackRefreshSec > 0) {
      setInterval(() => {
        void refreshSolutionPacks().catch(error => logger.warn({ err: error }, 'Solution Pack refresh failed'));
      }, Math.max(10, config.solutionPackRefreshSec) * 1_000).unref();
    }
  }

  // Status page
  app.get('/status', requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const status = await getStatus(config, currentDynamicTools, getAllCustomBackends());
      // Filter tools and backends by user's allowed_bundles
      status.dynamicTools = filterToolsForUser(status.dynamicTools, user);
      status.customBackends = filterToolsForUser(status.customBackends, user);
      const accept = req.headers['accept'] ?? '';
      if (accept.includes('application/json')) {
        res.json({ ...status, customBackends: status.customBackends.map(b => redactBackend(b)) });
      } else {
        res.redirect(308, '/home');
      }
    } catch (error) {
      logger.error({ err: error }, 'Status page error');
      res.status(500).json({ error: 'Failed to get status' });
    }
  });

  // The former server-rendered reference manual was a stale, parallel product
  // surface. Keep the established URL but point it at the maintained contract.
  app.get('/docs', (_req, res) => res.redirect(308, '/api-docs'));

  // Admin page - API Keys, Users, OTel Settings (admin only)
  app.get('/admin', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/home'));

  // Bundle Detail page (admin only)
  app.get('/admin/bundles/:id', requireAuth, requireAdmin, (req, res) => {
    res.redirect(308, `/mcp-fabric/bundles/${encodeURIComponent(String(req.params.id))}`);
  });

  // User Policies page (admin only)
  app.get('/admin/user-policies', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/governance/policies'));

  // Group Policies page (admin only) — per-Entra-group tool RBAC
  app.get('/admin/group-policies', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/governance/policies'));

  // Public Widgets management page (admin only)
  app.get('/admin/public-widgets', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/build/public-widgets'));

  // Live Activity Dashboard (admin only)
  app.get('/admin/activity-live', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/observe/activity'));

  app.get('/design-showcase', requireAuth, (_req, res) => res.redirect(308, '/home'));

  // Platform Config (Vault, OTel, HyDE, K8s-Impersonation)
  app.get('/admin/platform-config', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/settings/platform'));

  // Read all current configs. Vault credential values never leave the server;
  // the UI receives only explicit "configured" flags for secret fields.
  app.get('/api/admin/platform-config/all', requireAuth, requireAdmin, (_req, res) => {
    res.json({
      vault: safeVaultConfig(getVaultConfig()),
      otel: getOtelConfig(),
      hyde: getHydeConfig(),
      k8s_impersonation: getK8sImpersonationConfig(),
      upstream_token_exchange: getUpstreamTokenExchangeConfig(),
    });
  });

  // Vault
  app.put('/api/admin/platform-config/vault', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
    if (!sharedPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
    try {
      const config = validateVaultConfig(req.body, getVaultConfig());
      setVaultConfig(config);
      await persistPlatformConfig(sharedPool, 'vault', config);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/admin/platform-config/vault/test', requireAuth, requireAdmin, requireSameOrigin, async (_req, res) => {
    const result = await testVaultConnection(getVaultConfig());
    res.json(result);
  });

  // OTel
  app.put('/api/admin/platform-config/otel', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
    if (!sharedPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
    try {
      const config = validateOtelConfig(req.body);
      setOtelConfig(config);
      await persistPlatformConfig(sharedPool, 'otel', config);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // HyDE
  app.put('/api/admin/platform-config/hyde', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
    if (!sharedPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
    try {
      const config = validateHydeConfig(req.body);
      setHydeConfig(config);
      await persistPlatformConfig(sharedPool, 'rag_hyde', config);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // K8s-Impersonation
  app.put('/api/admin/platform-config/k8s', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
    if (!sharedPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
    try {
      const config = validateK8sImpersonationConfig(req.body);
      setK8sImpersonationConfig(config);
      await persistPlatformConfig(sharedPool, 'k8s_impersonation', config);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Upstream-Token-Exchange (Master-Switch)
  app.put('/api/admin/platform-config/upstream-token-exchange', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
    if (!sharedPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
    try {
      const config = validateUpstreamTokenExchangeConfig(req.body);
      setUpstreamTokenExchangeConfig(config);
      await persistPlatformConfig(sharedPool, 'upstream_token_exchange', config);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  registerUpstreamConnectionRoutes(app, sharedPool, requireAuth, requireSameOrigin);

  // Live-activity polling endpoint — returns current process-local registry snapshot.
  // Polled every 2s by the dashboard. Cheap (in-memory).
  app.get('/api/admin/activity/live', requireAuth, requireAdmin, (_req, res) => {
    res.json({
      sessions: listActive(),
      counts: summaryCounts(),
      ts: Date.now(),
    });
  });

  // Manual memory-consolidation trigger. Body: { threshold?: number, dryRun?: boolean }.
  // Use dryRun=true to preview without deleting.
  app.post('/api/admin/memory/consolidate', requireAuth, requireAdmin, async (req, res) => {
    if (!sharedPool) {
      res.status(503).json({ error: 'PostgreSQL not enabled' });
      return;
    }
    try {
      const threshold = typeof req.body?.threshold === 'number' ? req.body.threshold : undefined;
      const dryRun    = req.body?.dryRun === true;
      const result = await consolidateMemoriesOnce(sharedPool, { threshold, dryRun });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  registerLogRoutes(app, sharedPool, requireAuth);

  // Metrics page (Prometheus + Grafana)
  app.get('/grafana-view', requireAuth, (_req, res) => res.redirect(308, '/observe'));

  // OpenTelemetry Settings page
  app.get('/settings/otel', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/settings/platform'));

  // Audit / Activity page
  app.get('/audit', requireAuth, (_req, res) => res.redirect(308, '/observe/audit'));

  // ── Audit API (admin only) ────────────────────────────────────
  // SECURITY (audit): the audit log exposes every user's tool arguments and
  // api-key prefixes cross-tenant — requireAdmin, not just requireAuth, so a
  // plain viewer cannot read other users' activity.
  app.use('/api/audit', requireAdmin);

  app.get('/api/audit/entries', async (req, res) => {
    try {
      const filters = {
        from: (req.query.from as string) || undefined,
        to: (req.query.to as string) || undefined,
        apiKeyPrefix: (req.query.api_key as string) || undefined,
        tool: (req.query.tool as string) || undefined,
        backend: (req.query.backend as string) || undefined,
        isError: req.query.is_error === 'true' ? true : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
      };
      const result = await queryAuditLog(filters);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Failed to query audit log');
      res.status(500).json({ error: 'Failed to query audit log' });
    }
  });

  app.get('/api/audit/stats', async (req, res) => {
    try {
      const hours = req.query.hours ? parseInt(req.query.hours as string, 10) : 24;
      const stats = await getAuditStats(hours);
      res.json(stats);
    } catch (err) {
      logger.error({ err }, 'Failed to get audit stats');
      res.status(500).json({ error: 'Failed to get audit stats' });
    }
  });

  app.get('/api/audit/filters', async (_req, res) => {
    try {
      const [tools, apiKeys, backends] = await Promise.all([getDistinctTools(), getDistinctApiKeys(), getDistinctBackends()]);
      res.json({ tools, apiKeys, backends });
    } catch (err) {
      logger.error({ err }, 'Failed to get audit filters');
      res.status(500).json({ error: 'Failed to get audit filters' });
    }
  });

  // ── Admin API (require login + admin role for write operations) ──

  // Rate limiter for admin mutations (prevents brute-force on user/backend CRUD)
  const adminMutationLimiter = new RateLimiter(30); // 30 req/min per user
  setInterval(() => adminMutationLimiter.cleanup(), 300_000).unref();

  // Protect all admin API write operations.
  // requireSameOrigin runs first to block CSRF (defense-in-depth on top of SameSite=Lax).
  app.use('/api/admin', requireAuth);

  const adminRateLimit = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const key = (req as unknown as { user?: { id: number } }).user?.id?.toString() ?? (req.ip ?? 'anon');
    adminMutationLimiter.isAllowed(`admin:${key}`).then(allowed => {
      if (!allowed) { res.status(429).json({ error: 'Too many requests — slow down' }); return; }
      next();
    }).catch(next);
  };

  app.put('/api/admin/*',    requireSameOrigin, requireAdmin, adminRateLimit);
  app.post('/api/admin/*',   requireSameOrigin, requireAdmin, adminRateLimit);
  app.delete('/api/admin/*', requireSameOrigin, requireAdmin, adminRateLimit);

  // ── User Management API (admin only) ─────────────────────────

  if (sessionPool) {
    const userPool = sessionPool;

    app.get('/api/admin/users', requireAdmin, async (_req, res) => {
      try {
        const users = await listUsers(userPool);
        res.json(users);
      } catch (err) {
        logger.error({ err }, 'Failed to list users');
        res.status(500).json({ error: 'Failed to list users' });
      }
    });

    app.post('/api/admin/users', async (req, res) => {
      try {
        const { username, password, display_name, role, allowed_bundles, enabled, workspace_scopes } = req.body;
        const cleanUsername = typeof username === 'string' ? username.trim() : '';
        const cleanDisplayName = display_name === undefined
          ? cleanUsername
          : typeof display_name === 'string' ? display_name.trim() : '';
        if (!cleanUsername || !password) {
          res.status(400).json({ error: 'username and password required' });
          return;
        }

        if (!cleanDisplayName || cleanUsername.length > 128 || cleanDisplayName.length > 160) {
          res.status(400).json({ error: 'username or display_name is invalid' });
          return;
        }
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          res.status(400).json({ error: 'enabled must be a boolean' });
          return;
        }
        const pwErr = validatePasswordStrength(password, cleanUsername);
        if (pwErr) { res.status(400).json({ error: pwErr }); return; }
        const userRole = role === undefined ? 'viewer' : parseArgusRole(role);
        if (!userRole) { res.status(400).json({ error: 'Unknown Argus role' }); return; }
        const bundles = allowed_bundles === undefined ? undefined : parseAllowedBundleIds(allowed_bundles);
        const workspaceScopes = workspace_scopes === undefined
          ? undefined
          : parseWorkspaceMemberships(workspace_scopes);
        const result = await createManagedUserAudited(userPool, {
          username: cleanUsername,
          password,
          displayName: cleanDisplayName,
          role: userRole,
          allowedBundles: bundles,
          enabled: enabled ?? true,
          workspaceScopes,
        }, buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!));
        const user = await withUserWorkspaceMemberships(userPool, result.value);
        logger.info({
          username: user.username,
          role: userRole,
          allowed_bundles: bundles,
          replayed: result.replayed,
        }, 'User create request processed via admin API');
        if (!result.replayed) {
          writeAdminAudit(userPool, req, 'created', 'mcp_users', String(user.id), user.username,
            null, redactSensitive({ id: user.id, username: user.username, role: userRole, enabled: user.enabled, allowed_bundles: bundles, workspace_scopes: user.workspace_scopes }));
        }
        res.status(201).json(user);
      } catch (err) {
        if (err instanceof UserLifecycleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
        if ((err as { code?: string }).code === '23505') { res.status(409).json({ error: 'Username already exists' }); return; }
        logger.error({ err }, 'Failed to create user');
        res.status(500).json({ error: 'Failed to create user' });
      }
    });

    app.put('/api/admin/users/:id', async (req, res) => {
      try {
        const { display_name, role, enabled, allowed_bundles, workspace_scopes } = req.body;
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid user ID' }); return; }
        const updates: Parameters<typeof updateManagedUserAudited>[3] = {};
        if (display_name !== undefined) {
          if (typeof display_name !== 'string' || !display_name.trim() || display_name.trim().length > 160) {
            res.status(400).json({ error: 'display_name is invalid' }); return;
          }
          updates.display_name = display_name.trim();
        }
        if (role !== undefined) {
          const parsedRole = parseArgusRole(role);
          if (!parsedRole) { res.status(400).json({ error: 'Unknown Argus role' }); return; }
          updates.role = parsedRole;
        }
        if (enabled !== undefined) {
          if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be a boolean' }); return; }
          updates.enabled = enabled;
        }
        if ('allowed_bundles' in req.body) updates.allowed_bundles = parseAllowedBundleIds(allowed_bundles);
        if ('workspace_scopes' in req.body) updates.workspace_scopes = parseWorkspaceMemberships(workspace_scopes);
        const currentUser = (req as AuthenticatedRequest).user!;
        const result = await updateManagedUserAudited(
          userPool, currentUser.id, id, updates, buildUserLifecycleAuditContext(req, currentUser),
        );
        const user = await withUserWorkspaceMemberships(userPool, result.value);
        // N2: bei enabled/role-Änderung sofort den apiKeyRbac-Cache reloaden,
        // damit acting_as_user_id-Bindings disabled/role-changed User sofort verlieren.
        // Sonst dauert es bis zu 60s (background refresh in src/index.ts:275).
        if ('enabled' in updates || 'role' in updates) {
          loadApiKeyRbac(userPool).catch(err =>
            logger.warn({ err: String(err) }, 'apiKeyRbac reload after user update failed'),
          );
        }
        if (!result.replayed) {
          writeAdminAudit(userPool, req, 'updated', 'mcp_users', String(user.id), user.username,
            result.before, redactSensitive(updates as Record<string, unknown>));
        }
        res.json(user);
      } catch (err) {
        if (err instanceof UserLifecycleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
        logger.error({ err }, 'Failed to update user');
        res.status(500).json({ error: 'Failed to update user' });
      }
    });

    app.put('/api/admin/users/:id/password', async (req, res) => {
      try {
        const { password } = req.body;
        if (!password) { res.status(400).json({ error: 'password required' }); return; }
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid user ID' }); return; }
        const { rows } = await userPool.query<{ username: string }>('SELECT username FROM mcp_users WHERE id = $1', [id]);
        if (!rows[0]) { res.status(404).json({ error: 'User not found' }); return; }
        const pwErrChg = validatePasswordStrength(password, rows[0].username);
        if (pwErrChg) { res.status(400).json({ error: pwErrChg }); return; }
        const result = await changeManagedUserPasswordAudited(
          userPool, id, password,
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        if (!result.replayed) {
          writeAdminAudit(userPool, req, 'password_changed', 'mcp_users', req.params.id, null, null, null);
        }
        res.json({ updated: true });
      } catch (err) {
        if (err instanceof UserLifecycleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
        logger.error({ err }, 'Failed to change password');
        res.status(500).json({ error: 'Failed to change password' });
      }
    });

    app.delete('/api/admin/users/:id', async (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid user ID' }); return; }
        const currentUser = (req as AuthenticatedRequest).user!;
        const result = await deleteManagedUserAudited(
          userPool, currentUser.id, id, buildUserLifecycleAuditContext(req, currentUser),
        );
        loadApiKeyRbac(userPool).catch(err =>
          logger.warn({ err: String(err) }, 'apiKeyRbac reload after user deletion failed'),
        );
        if (!result.replayed) {
          writeAdminAudit(userPool, req, 'deleted', 'mcp_users', String(id), null, result.before, null);
        }
        res.json({ deleted: true });
      } catch (err) {
        if (err instanceof UserLifecycleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
        logger.error({ err }, 'Failed to delete user');
        res.status(500).json({ error: 'Failed to delete user' });
      }
    });
  }

  // Runtime config API
  app.get('/api/admin/config', requireAuth, (_req, res) => {
    res.json({
      backends: {
        postgresql: config.postgresEnabled,
      },
      rateLimitPerMinute: config.rateLimitPerMinute,
      maxResultRows: config.maxResultRows,
      dynamicToolsPollIntervalSec: config.dynamicToolsPollIntervalSec,
      activeSessions: transports.size,
    });
  });

  app.put('/api/admin/config', (req, res) => {
    try {
      const { rateLimitPerMinute, maxResultRows } = req.body;
      const changes: string[] = [];

      if (typeof rateLimitPerMinute === 'number' && rateLimitPerMinute > 0) {
        config.rateLimitPerMinute = rateLimitPerMinute;
        changes.push(`Rate limit: ${rateLimitPerMinute}/min`);
      }
      if (typeof maxResultRows === 'number' && maxResultRows > 0) {
        config.maxResultRows = maxResultRows;
        changes.push(`Max result rows: ${maxResultRows}`);
      }

      if (changes.length > 0) {
        logger.info({ changes }, 'Runtime config updated via admin API');
        sendNotification('Config Updated', changes.join(', '), 'info');
      }

      res.json({ updated: changes, note: 'Changes apply to new MCP sessions. Existing sessions keep their config.' });
    } catch (err) {
      logger.error({ err }, 'Failed to update config');
      res.status(500).json({ error: 'Failed to update config' });
    }
  });

  // Nav badges: lightweight counts for sidebar (no auth required — just counts)
  // ── /api/me — own profile, password age, sessions ────────────────
  app.get('/api/me', requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) { res.status(401).json({ error: 'no session' }); return; }
      const { PASSWORD_MAX_AGE_DAYS } = await import('./config/env.js');
      const { getPasswordAge } = await import('./auth/userAuth.js');
      const passwordAge = sessionPool ? await getPasswordAge(sessionPool, user.id, PASSWORD_MAX_AGE_DAYS) : null;
      res.json({
        user: {
          id: user.id,
          username: user.username,
          display_name: user.display_name,
          role: user.role,
          entra_groups: user.entra_groups ?? [],
        },
        password: passwordAge,
        password_max_age_days: PASSWORD_MAX_AGE_DAYS,
        shareLinksEnabled: config.shareLinksEnabled,
        aiTransparency: {
          enabled: config.aiTransparencyNoticeEnabled,
          notice: config.aiTransparencyNoticeText,
        },
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/me failed');
      res.status(500).json({ error: 'failed' });
    }
  });

  app.get('/api/me/sessions', requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !sessionPool) { res.status(401).json({ error: 'no session' }); return; }
      const currentSid = parseArgusSessionCookie(req.headers.cookie);
      interface SessionRow { id: string; created_at: string; expires_at: string; ip_address: string | null; user_agent: string | null }
      const { rows } = await sessionPool.query<SessionRow>(
        `SELECT id, created_at, expires_at, ip_address, user_agent
         FROM mcp_sessions WHERE user_id = $1 AND expires_at > now()
         ORDER BY created_at DESC LIMIT 50`,
        [user.id],
      );
      res.json({
        sessions: rows.map((r: SessionRow) => ({
          ...r,
          is_current: r.id === currentSid,
        })),
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/me/sessions failed');
      res.status(500).json({ error: 'failed' });
    }
  });

  app.delete('/api/me/sessions/:sid', requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !sessionPool) { res.status(401).json({ error: 'no session' }); return; }
      const sid = String(req.params['sid'] ?? '');
      // Caller can only delete THEIR OWN sessions — enforced by user_id filter
      const { rowCount } = await sessionPool.query(
        'DELETE FROM mcp_sessions WHERE id = $1 AND user_id = $2',
        [sid, user.id],
      );
      if ((rowCount ?? 0) === 0) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      writeAdminAudit(sessionPool, req, 'session_revoked', 'mcp_sessions', sid, null, null, null);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'DELETE /api/me/sessions/:sid failed');
      res.status(500).json({ error: 'failed' });
    }
  });

  app.get('/api/nav/badges', async (_req, res) => {
    const backends = getAllCustomBackends();
    const result: Record<string, number> = {
      servers: backends.filter(b => b.enabled).length,
      tools: currentDynamicTools.length,
      bundles: 0,
      agents: 0, rags: 0, skills: 0,
    };
    if (config.postgresEnabled && sharedPool) {
      try {
        const r = await sharedPool.query(`
          SELECT
            (SELECT COUNT(*) FROM mcp_remote_tools)                    AS remote_tools,
            (SELECT COUNT(*) FROM mcp_service_bundles)                 AS bundles,
            (SELECT COUNT(*) FROM mcp_agents)                          AS agents,
            (SELECT COUNT(*) FROM mcp_rag_indexes)                     AS rags,
            (SELECT COUNT(*) FROM mcp_skills)                          AS skills
        `);
        const d = r.rows[0];
        const n = (v: string) => parseInt(d[v] ?? '0', 10);
        result.tools      = currentDynamicTools.length + n('remote_tools');
        result.bundles    = n('bundles');
        result.agents     = n('agents');
        result.rags       = n('rags');
        result.skills     = n('skills');
      } catch { /* fallback to defaults above */ }
    }
    res.json(result);
  });

  // Status API (JSON only, for dashboard polling)
  app.get('/api/admin/status', requireAuth, async (_req, res) => {
    try {
      const status = await getStatus(config, currentDynamicTools, getAllCustomBackends());
      res.json({
        ...status,
        customBackends: status.customBackends.map(b => redactBackend(b)),
        activeSessions: transports.size,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get status');
      res.status(500).json({ error: 'Failed to get status' });
    }
  });

  // CRUD for dynamic tools (requires PostgreSQL)
  if (config.postgresEnabled && sharedPool) {
    const adminPool = sharedPool;
    initLogStore(adminPool);
    // Expose adminPool on app.locals so router-based handlers
    // (e.g. /api/coding/threads/:id/resume) can write approval audit rows.
    app.locals['adminPool'] = adminPool;

    app.post('/api/admin/encryption/rotate', async (req, res) => {
      if (!process.env['DB_ENCRYPTION_KEY'] || !process.env['OLD_DB_ENCRYPTION_KEY']) {
        res.status(400).json({
          error: 'DB_ENCRYPTION_KEY and OLD_DB_ENCRYPTION_KEY must both be configured',
        });
        return;
      }
      const targets: Array<{ table: string; idColumn: string; columns: string[] }> = [
        { table: 'mcp_models', idColumn: 'id', columns: ['api_key'] },
        { table: 'mcp_llm_providers', idColumn: 'id', columns: ['api_key'] },
        { table: 'mcp_llm_credential_profiles', idColumn: 'id', columns: ['api_key'] },
        { table: 'mcp_rag_indexes', idColumn: 'id', columns: ['api_key'] },
        { table: 'mcp_tool_filters', idColumn: 'id', columns: ['hmac_secret'] },
        { table: 'mcp_backends', idColumn: 'id', columns: ['auth_value', 'oauth_client_secret'] },
        { table: 'mcp_agents', idColumn: 'id', columns: ['llm_api_key'] },
      ];
      try {
        let updated = 0;
        const details: Record<string, number> = {};
        for (const target of targets) {
          let targetUpdates = 0;
          for (const column of target.columns) {
            const result = await adminPool.query<Record<string, string>>(
              `SELECT ${target.idColumn}, ${column}
               FROM ${target.table}
               WHERE ${column} IS NOT NULL AND ${column} LIKE 'enc:v1:%'`,
            );
            for (const row of result.rows) {
              if (isCurrentlyEncrypted(row[column])) continue;
              const plaintext = decrypt(row[column]);
              if (plaintext === row[column]) continue;
              await adminPool.query(
                `UPDATE ${target.table} SET ${column} = $1 WHERE ${target.idColumn} = $2`,
                [encrypt(plaintext), row[target.idColumn]],
              );
              targetUpdates++;
            }
          }
          if (targetUpdates > 0) details[target.table] = targetUpdates;
          updated += targetUpdates;
        }
        writeAdminAudit(adminPool, req, 'rotated', 'encrypted_fields', 'all', 'DB encryption key', null, {
          updated,
          details,
        });
        logger.info({ updated, details }, 'DB field encryption rotation completed');
        res.json({ success: true, updated, details });
      } catch (err) {
        logger.error({ err }, 'DB field encryption rotation failed');
        res.status(500).json({ error: 'DB field encryption rotation failed' });
      }
    });

    app.get('/api/admin/tools', requireAdmin, async (_req, res) => {
      try {
        const { rows } = await adminPool.query(
          `SELECT t.*,
            COALESCE((SELECT array_agg(tb.bundle_id) FROM mcp_tool_bundles tb WHERE tb.tool_id = t.id), '{}') AS bundle_ids
           FROM mcp_tools t ORDER BY t.category, t.name`
        );
        res.json(rows);
      } catch (err) {
        logger.error({ err }, 'Failed to list tools');
        res.status(500).json({ error: 'Failed to list tools' });
      }
    });

    // List all registered tool hooks (Phase 1 — Tool-Level Hooks).
    // Used by the agent detail page to show "Active Tool Hooks" card.
    app.get('/api/admin/hooks', requireAdmin, (_req, res) => {
      try {
        res.json({ hooks: listHooks() });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post('/api/admin/tools', async (req, res) => {
      try {
        const { name, description, backend, query_template, parameters, category, enabled, bundle_ids } = req.body;
        if (!name || typeof name !== 'string' || name.length > 256) { res.status(400).json({ error: 'name required, max 256 chars' }); return; }
        if (description && description.length > 5000) { res.status(400).json({ error: 'description max 5000 chars' }); return; }
        if (query_template && query_template.length > 50000) { res.status(400).json({ error: 'query_template max 50000 chars' }); return; }
        if (isOpenApiCategory(category)) {
          const error = new OpenApiOwnershipError(
            'Die Kategorie openapi:* ist für kontrollierte Imports im Capability Studio reserviert.',
          );
          res.status(409).json(openApiConflictBody(error));
          return;
        }
        const { rows } = await adminPool.query(
          `INSERT INTO mcp_tools (name, description, backend, query_template, parameters, category, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [name, description, backend, query_template, JSON.stringify(parameters), category, enabled ?? true]
        );
        const toolId = rows[0].id;
        if (Array.isArray(bundle_ids) && bundle_ids.length > 0) {
          for (const bid of bundle_ids) {
            await adminPool.query(
              'INSERT INTO mcp_tool_bundles (tool_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [toolId, bid]
            );
          }
        }
        logger.info({ tool: name }, 'Dynamic tool created via admin API');
        res.status(201).json(rows[0]);
      } catch (err) {
        logger.error({ err }, 'Failed to create tool');
        res.status(500).json({ error: 'Failed to create tool' });
      }
    });

    app.put('/api/admin/tools/:id', async (req, res) => {
      const client = await adminPool.connect();
      try {
        const { name, description, backend, query_template, parameters, category, enabled } = req.body;
        await client.query('BEGIN');
        const ownership = await lockCapabilityOpenApiOwnership(client, req.params.id);
        if (!ownership) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Tool not found' });
          return;
        }
        if (ownership.sourceControlled) {
          throw new OpenApiOwnershipError(
            'Diese OpenAPI-importierte Capability wird im Capability Studio verwaltet und kann hier nicht bearbeitet werden.',
          );
        }
        if (isOpenApiCategory(category)) {
          throw new OpenApiOwnershipError(
            'Die Kategorie openapi:* ist für kontrollierte Imports im Capability Studio reserviert.',
          );
        }

        const { rows } = await client.query(
          `UPDATE mcp_tools SET name=$1, description=$2, backend=$3, query_template=$4, parameters=$5, category=$6, enabled=$7
           WHERE id=$8 RETURNING *`,
          [name, description, backend, query_template, JSON.stringify(parameters), category, enabled, req.params.id]
        );
        await client.query('COMMIT');

        logger.info({ tool: rows[0].name, id: req.params.id }, 'Tool updated via admin API');
        res.json(rows[0]);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(err));
          return;
        }
        logger.error({ err }, 'Failed to update tool');
        res.status(500).json({ error: 'Failed to update tool' });
      } finally {
        client.release();
      }
    });

    app.delete('/api/admin/tools/:id', async (req, res) => {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        const ownership = await lockCapabilityOpenApiOwnership(client, req.params.id);
        if (!ownership) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Tool not found' });
          return;
        }
        if (ownership.sourceControlled) {
          throw new OpenApiOwnershipError(
            'Diese OpenAPI-importierte Capability wird im Capability Studio verwaltet und kann hier nicht gelöscht werden.',
          );
        }
        await client.query('DELETE FROM mcp_tools WHERE id = $1', [req.params.id]);
        await client.query('COMMIT');
        logger.info({ id: req.params.id }, 'Dynamic tool deleted via admin API');
        res.json({ deleted: true });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(err));
          return;
        }
        logger.error({ err }, 'Failed to delete tool');
        res.status(500).json({ error: 'Failed to delete tool' });
      } finally {
        client.release();
      }
    });

    // Tool version history
    app.get('/api/admin/tools/:id/history', requireAdmin, async (req, res) => {
      try {
        const { rows } = await adminPool.query(
          'SELECT * FROM mcp_tools_history WHERE tool_id = $1 ORDER BY version DESC',
          [req.params.id]
        );
        res.json(rows);
      } catch (err) {
        logger.error({ err }, 'Failed to get tool history');
        res.status(500).json({ error: 'Failed to get tool history' });
      }
    });

    // ── Legacy OpenAPI preview compatibility ───────────────────
    // Mutating imports live exclusively in Capability Studio, where preview digests,
    // collisions, removals, write operations and bundle boundaries are confirmed.
    // Keep the old preview response shape for API compatibility, but delegate source
    // validation/fetching to the same bounded SSRF + egress-safe resolver.
    function legacyOpenApiInput(body: unknown) {
      const value = body && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown>
        : {};
      return {
        specText: value.spec_text,
        specUrl: value.spec_url,
        namePrefix: value.name_prefix,
      };
    }

    app.post('/api/admin/actions/openapi/preview', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
      try {
        const input = legacyOpenApiInput(req.body);
        const source = await resolveOpenApiSpecText(input);
        const doc = resolveLocalRefs(parseSpec(source.text));
        const prefix = normalizeOpenApiPrefix(input.namePrefix, doc.info?.title);
        const security = mapSecurity(doc);
        const ops = mapOperations(doc, prefix);
        res.json({
          title: doc.info?.title ?? '', base_url: doc.servers?.[0]?.url ?? '', prefix, security,
          operations: ops.map((o) => ({ name: o.name, isWrite: o.isWrite, params: o.parameters.length })),
          counts: { total: ops.length, write: ops.filter((o) => o.isWrite).length },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'preview failed';
        res.status(message.includes('MB limit') ? 413 : 400).json({ error: message });
      }
    });

    app.post('/api/admin/actions/openapi/import', requireAuth, requireAdmin, requireSameOrigin, (_req, res) => {
      res.status(410).json({
        error: 'Der Legacy-OpenAPI-Import wurde deaktiviert. Bitte den abgesicherten Wizard im Capability Studio verwenden.',
        href: '/mcp-fabric/capabilities',
      });
    });

    // ── Custom Backends CRUD ──────────────────────────────────

    app.get('/api/admin/backends', requireAdmin, async (_req, res) => {
      try {
        const backends = await loadAllCustomBackends(adminPool);
        res.json(backends.map(b => redactBackend(b)));
      } catch (err) {
        logger.error({ err }, 'Failed to list custom backends');
        res.status(500).json({ error: 'Failed to list custom backends' });
      }
    });

    app.post('/api/admin/backends', async (req, res) => {
      try {
        const { name, description, base_url, auth_type, auth_value, health_path, default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, mcp_endpoint,
          auth_mode, oauth_authorize_url, oauth_token_url, oauth_client_id, oauth_client_secret, oauth_scopes, oauth_revoke_url } = req.body;
        if (!name || typeof name !== 'string' || name.length > 256) { res.status(400).json({ error: 'name required, max 256 chars' }); return; }
        if (description && description.length > 5000) { res.status(400).json({ error: 'description max 5000 chars' }); return; }
        if (!base_url || typeof base_url !== 'string' || base_url.length > 2048) { res.status(400).json({ error: 'base_url required, max 2048 chars' }); return; }
        if (default_headers && JSON.stringify(default_headers).length > 10000) { res.status(400).json({ error: 'default_headers too large' }); return; }
        const authMode: string = (auth_mode === 'permissive' || auth_mode === 'strict') ? auth_mode : 'service-account';
        const scopesArr = Array.isArray(oauth_scopes) ? oauth_scopes : (typeof oauth_scopes === 'string' && oauth_scopes.trim() ? oauth_scopes.trim().split(/\s+/) : null);
        const type = backend_type || 'http';
        const { rows } = await adminPool.query(
          `INSERT INTO mcp_backends (name, description, base_url, auth_type, auth_value, health_path, default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, mcp_endpoint,
             auth_mode, oauth_authorize_url, oauth_token_url, oauth_client_id, oauth_client_secret, oauth_scopes, oauth_revoke_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
          [name, description || '', base_url, auth_type || 'none', encrypt(auth_value || null),
           health_path ?? (type === 'mcp' ? null : '/health'),
           JSON.stringify(protectHeadersForStorage(default_headers || {})), timeout_ms || 10000, tls_skip_verify || false, enabled ?? true,
           type, mcp_endpoint || (type === 'mcp' ? '/mcp' : null),
           authMode, oauth_authorize_url || null, oauth_token_url || null,
           oauth_client_id || null, encrypt(oauth_client_secret || null), scopesArr, oauth_revoke_url || null]
        );
        // Refresh in-memory cache
        await refreshBackendCaches(adminPool);

        const created = { ...rows[0], bundle_ids: [] as number[] };

        // If MCP type and enabled, connect and discover tools
        if (type === 'mcp' && (enabled ?? true)) {
          try {
            const conn = await connectRemoteMcp(created as CustomBackendRow);
            if (conn.connected) {
              await persistDiscoveredTools(adminPool, created.id, conn.tools);
            }
          } catch (err) {
            logger.warn({ err, backend: name }, 'MCP backend created but connection failed');
          }
        }

        logger.info({ backend: name, type }, 'Backend created via admin API');
        writeAdminAudit(adminPool, req, 'created', 'mcp_backends', String(created.id), name, null,
          redactSensitive({ id: created.id, name, base_url, auth_type, type, enabled }));
        res.status(201).json(redactBackend(created));
      } catch (err) {
        logger.error({ err }, 'Failed to create backend');
        res.status(500).json({ error: 'Failed to create backend' });
      }
    });

    app.put('/api/admin/backends/:id', async (req, res) => {
      const client = await adminPool.connect();
      try {
        const { name, description, base_url, auth_type, auth_value, health_path, default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, mcp_endpoint,
          auth_mode, oauth_authorize_url, oauth_token_url, oauth_client_id, oauth_client_secret, oauth_scopes, oauth_revoke_url } = req.body;
        await client.query('BEGIN');
        const ownership = await lockBackendOpenApiOwnership(client, req.params.id);
        if (!ownership) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Backend not found' });
          return;
        }
        if (ownership.sourceControlled) {
          throw new OpenApiOwnershipError(
            'Diese OpenAPI-verwaltete Connection kann hier nicht bearbeitet werden. '
            + 'Nutze das Capability Studio für einen kontrollierten Re-Import.',
          );
        }
        const type = backend_type || 'http';
        const authMode: string = (auth_mode === 'permissive' || auth_mode === 'strict') ? auth_mode : 'service-account';
        const scopesArr = Array.isArray(oauth_scopes) ? oauth_scopes : (typeof oauth_scopes === 'string' && oauth_scopes.trim() ? oauth_scopes.trim().split(/\s+/) : null);
        // oauth_client_secret: undefined → leave unchanged; '' / null → clear; non-empty → encrypt
        const updateSecret = oauth_client_secret !== undefined;
        const params: unknown[] = [
          name, description || '', base_url, auth_type || 'none', encrypt(auth_value || null),
          health_path ?? (type === 'mcp' ? null : '/health'),
          JSON.stringify(protectHeadersForStorage(default_headers || {}, ownership.backend.default_headers)),
          timeout_ms || 10000, tls_skip_verify || false, enabled,
          type, mcp_endpoint || (type === 'mcp' ? '/mcp' : null),
          authMode, oauth_authorize_url || null, oauth_token_url || null, oauth_client_id || null, scopesArr,
          oauth_revoke_url || null,
          req.params.id,
        ];
        let secretClause = '';
        if (updateSecret) {
          params.push(encrypt(oauth_client_secret || null));
          secretClause = `, oauth_client_secret=$${params.length}`;
        }
        const { rows } = await client.query(
          `UPDATE mcp_backends SET name=$1, description=$2, base_url=$3, auth_type=$4, auth_value=$5,
           health_path=$6, default_headers=$7, timeout_ms=$8, tls_skip_verify=$9, enabled=$10,
           backend_type=$11, mcp_endpoint=$12,
           auth_mode=$13, oauth_authorize_url=$14, oauth_token_url=$15, oauth_client_id=$16, oauth_scopes=$17,
           oauth_revoke_url=$18
           ${secretClause}
           WHERE id=$19 RETURNING *`,
          params,
        );
        await client.query('COMMIT');
        await refreshBackendCaches(adminPool);

        // For MCP backends: reconnect if enabled, disconnect if disabled
        if (type === 'mcp') {
          await disconnectRemoteMcp(Number(req.params.id));
          if (enabled) {
            try {
              const conn = await connectRemoteMcp(rows[0] as CustomBackendRow);
              if (conn.connected) {
                await persistDiscoveredTools(adminPool, rows[0].id, conn.tools);
              }
            } catch (err) {
              logger.warn({ err, backend: name }, 'MCP backend updated but reconnection failed');
            }
          }
        }

        logger.info({ backend: name, id: req.params.id, type }, 'Backend updated via admin API');
        writeAdminAudit(adminPool, req, 'updated', 'mcp_backends', String(req.params.id), name, null,
          redactSensitive({ name, base_url, auth_type, enabled, type }));
        res.json(redactBackend(rows[0]));
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(err));
          return;
        }
        logger.error({ err }, 'Failed to update backend');
        res.status(500).json({ error: 'Failed to update backend' });
      } finally {
        client.release();
      }
    });

    app.delete('/api/admin/backends/:id', async (req, res) => {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        const ownership = await lockBackendOpenApiOwnership(client, req.params.id);
        if (!ownership) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Backend not found' });
          return;
        }
        if (ownership.sourceControlled) {
          throw new OpenApiOwnershipError(
            'Diese OpenAPI-verwaltete Connection kann hier nicht gelöscht werden. '
            + 'Entferne sie kontrolliert über das Capability Studio.',
          );
        }
        const backendName = ownership.backend.name;

        // Delete associated dynamic tools (custom:<backendName>) before deleting backend
        const { rowCount: toolsDeleted } = await client.query(
          "DELETE FROM mcp_tools WHERE backend = $1 AND tool_type = 'dynamic'",
          ['custom:' + backendName],
        );

        // Delete backend (also cascades mcp_remote_tools via FK)
        await client.query('DELETE FROM mcp_backends WHERE id = $1', [req.params.id]);
        await client.query('COMMIT');

        await disconnectRemoteMcp(Number(req.params.id));
        await refreshBackendCaches(adminPool);
        // Refresh tools cache since associated tools were deleted
        currentDynamicTools = await loadDynamicTools(adminPool);

        logger.info({ id: req.params.id, backendName, toolsDeleted }, 'Backend + associated tools deleted via admin API');
        writeAdminAudit(adminPool, req, 'deleted', 'mcp_backends', String(req.params.id), backendName,
          { name: backendName, tools_cascaded: toolsDeleted }, null);
        res.json({ deleted: true, toolsDeleted });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(err));
          return;
        }
        logger.error({ err }, 'Failed to delete backend');
        res.status(500).json({ error: 'Failed to delete backend' });
      } finally {
        client.release();
      }
    });

    // Health check / test for a specific backend
    app.post('/api/admin/backends/:id/test', async (req, res) => {
      try {
        const { rows } = await adminPool.query('SELECT * FROM mcp_backends WHERE id = $1', [req.params.id]);
        if (rows.length === 0) {
          res.status(404).json({ error: 'Backend not found' });
          return;
        }
        const backend = rows[0] as CustomBackendRow;

        if (backend.backend_type === 'mcp') {
          const result = await checkRemoteMcp(backend.id);
          res.json(result);
        } else {
          const { checkCustomBackend } = await import('./backends/customBackends.js');
          const result = await checkCustomBackend(backend);
          res.json(result);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to test backend');
        res.status(500).json({ error: 'Failed to test backend' });
      }
    });

    // Discover / refresh tools from a remote MCP backend
    app.post('/api/admin/backends/:id/discover', async (req, res) => {
      try {
        const { rows } = await adminPool.query('SELECT * FROM mcp_backends WHERE id = $1', [req.params.id]);
        if (rows.length === 0) {
          res.status(404).json({ error: 'Backend not found' });
          return;
        }
        const backend = rows[0] as CustomBackendRow;
        if (backend.backend_type !== 'mcp') {
          res.status(400).json({ error: 'Tool discovery is only available for MCP backends' });
          return;
        }

        // Reconnect if not connected
        let conn = getRemoteConnection(backend.id);
        if (!conn || !conn.connected) {
          await disconnectRemoteMcp(backend.id);
          conn = await connectRemoteMcp(backend);
        } else {
          // Refresh tools on existing connection
          const tools = await refreshRemoteMcpTools(backend.id);
          conn.tools = tools;
        }

        if (conn.connected) {
          await persistDiscoveredTools(adminPool, backend.id, conn.tools);
        }

        res.json({
          connected: conn.connected,
          error: conn.lastError,
          tools: conn.tools,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to discover remote MCP tools');
        res.status(500).json({ error: 'Failed to discover tools' });
      }
    });

    app.post('/api/admin/backends/:id/trust', async (req, res) => {
      try {
        const backendId = Number(req.params.id);
        const action = req.body?.action;
        const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 2000) : null;
        const user = (req as AuthenticatedRequest).user;
        if (!Number.isInteger(backendId) || backendId < 1 || !user) {
          res.status(400).json({ error: 'Invalid backend or user' });
          return;
        }
        if (action !== 'trust' && action !== 'quarantine') {
          res.status(400).json({ error: "action must be 'trust' or 'quarantine'" });
          return;
        }

        const registry = await setMcpRegistryTrust(
          adminPool,
          backendId,
          action === 'trust' ? 'trusted' : 'quarantined',
          user.id,
          comment,
        );
        if (!registry) {
          res.status(404).json({ error: 'Remote MCP registry entry not found; discover tools first' });
          return;
        }

        setRemoteMcpTrustStatus(backendId, registry.trust_status);
        writeAdminAudit(
          adminPool,
          req,
          action === 'trust' ? 'trusted' : 'quarantined',
          'mcp_registry_entries',
          String(backendId),
          null,
          null,
          {
            trust_status: registry.trust_status,
            catalog_fingerprint: registry.catalog_fingerprint,
            comment,
          },
        );
        logger.info({ backendId, action, user: user.username }, 'Remote MCP trust state changed');
        res.json({ ok: true, registry });
      } catch (err) {
        logger.error({ err }, 'Failed to change remote MCP trust state');
        res.status(500).json({ error: 'Failed to change remote MCP trust state' });
      }
    });

    // List discovered tools for a backend
    app.get('/api/admin/backends/:id/tools', requireAdmin, async (req, res) => {
      try {
        const { rows } = await adminPool.query(
          'SELECT * FROM mcp_remote_tools WHERE backend_id = $1 ORDER BY prefixed_name',
          [req.params.id]
        );
        res.json(rows);
      } catch (err) {
        logger.error({ err }, 'Failed to list remote tools');
        res.status(500).json({ error: 'Failed to list remote tools' });
      }
    });

    // ── Workflows ──────────────────────────────────────────────

    // Workflow page
    app.get('/workflows', requireAuth, (_req, res) => res.redirect(308, '/build/workflows'));

    // ── Visual Workflow Builder (React app from workflow-builder/) ──
    // Serves the Vite-built SPA. dist/builder/ is produced by:
    //   cd workflow-builder && npm install && npm run build
    {
      const path = await import('node:path');
      const fs   = await import('node:fs');
      const builderDist = path.resolve(process.cwd(), 'dist', 'builder');
      const builderIndex = path.join(builderDist, 'index.html');
      const builderAssets = path.join(builderDist, 'assets');

      // Static assets — long-cache (Vite emits hashed filenames)
      if (fs.existsSync(builderAssets)) {
        app.use('/workflows/builder/assets', express.static(builderAssets, { maxAge: '1y', immutable: true }));
      }

      // SPA entry — same HTML for /workflows/builder and /workflows/builder/:id
      app.get(['/workflows/builder', '/workflows/builder/:id'], requireAuth, (_req, res) => {
        if (!fs.existsSync(builderIndex)) {
          res.status(503).type('html').send(
            '<h1>Workflow Builder not built</h1>' +
            '<p>Run <code>cd workflow-builder &amp;&amp; npm install &amp;&amp; npm run build</code> to enable.</p>'
          );
          return;
        }
        res.type('html').sendFile(builderIndex);
      });

      // Integrated view: the builder INSIDE the Argus shell (collapsible left nav).
      // Full-bleed same-origin iframe of the untouched raw builder above — zero risk
      // to the builder itself. CSP frame-src/frame-ancestors already allow 'self'.
      app.get(['/workflows/studio', '/workflows/studio/:id'], requireAuth, (req, res) => {
        const u = (req as unknown as { user?: SessionUser }).user;
        const wid = typeof req.params['id'] === 'string' ? req.params['id'] : '';
        const frameSrc = '/workflows/builder' + (wid ? '/' + encodeURIComponent(wid) : '');
        res.type('html').send(renderPageShell({
          activePage: 'workflow-builder',
          title: 'Argus — Workflow Builder',
          user: u,
          styles: '.main-content{padding:0!important;overflow:hidden!important}.wb-frame{border:0;width:100%;height:100%;display:block}',
          content: `<iframe class="wb-frame" src="${frameSrc}" title="Workflow Builder"></iframe>`,
        }));
      });

      // Register builder API routes (GET/PUT flow, palette)
      const { registerFlowRoutes } = await import('./workflows/flowRoutes.js');
      registerFlowRoutes(app, adminPool, requireAuth);

      // Register execute + SSE routes (POST /execute, GET stream)
      const { registerExecuteRoutes } = await import('./workflows/executeRoutes.js');
      registerExecuteRoutes(app, adminPool, config, requireAuth, async (name, args) => {
        const result = await executeTool(name, args, { config, pool: adminPool });
        return result;
      });

      // Register Phase-5 routes (templates, runs, validate)
      const { registerBuilderRoutes } = await import('./workflows/builderRoutes.js');
      registerBuilderRoutes(app, adminPool, requireAuth, {
        async publish(spec) {
          const endpoint = solutionPackRegistry.getEndpoint('argus.dev');
          if (!endpoint) throw new Error('Argus Dev is not configured in ARGUS_SOLUTION_PACK_ENDPOINTS');
          if (!WORKSPACE_SECRET) throw new Error('WORKSPACE_SECRET is required for visual workflow publishing');
          const response = await fetch(`${endpoint.endpoint}/visual-workflows/publish`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-workspace-secret': WORKSPACE_SECRET,
            },
            body: JSON.stringify({ spec }),
            signal: AbortSignal.timeout(Math.max(5_000, config.solutionPackDiscoveryTimeoutMs)),
          });
          const body = await response.json().catch(() => ({})) as Record<string, unknown>;
          if (!response.ok) {
            const detail = typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`;
            throw new Error(`Argus Dev rejected the workflow publication: ${detail}`);
          }
          await solutionPackRegistry.refresh();
          return body;
        },
        async start(spec, input, execution) {
          return solutionPackA2a.sendMessage('argus.dev', 'coding-orchestrator', {
            text: `Start visual workflow ${spec.label}`,
            data: {
              operation: 'workflow.start',
              workflowId: spec.id,
              input,
            },
          }, execution);
        },
        async loadReplay(spec, traceId) {
          const endpoint = solutionPackRegistry.getEndpoint('argus.dev');
          if (!endpoint) throw new Error('Argus Dev is not configured in ARGUS_SOLUTION_PACK_ENDPOINTS');
          if (!WORKSPACE_SECRET) throw new Error('WORKSPACE_SECRET is required for visual workflow replay');
          const response = await fetch(`${endpoint.endpoint}/threads/${encodeURIComponent(traceId)}/state`, {
            headers: { 'x-workspace-secret': WORKSPACE_SECRET },
            signal: AbortSignal.timeout(Math.max(5_000, config.solutionPackDiscoveryTimeoutMs)),
          });
          const body = await response.json().catch(() => ({})) as Record<string, unknown>;
          if (!response.ok) {
            const detail = typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`;
            throw new Error(`Argus Dev replay lookup failed for ${spec.id}: ${detail}`);
          }
          return body;
        },
        async listReplays(spec, limit) {
          const endpoint = solutionPackRegistry.getEndpoint('argus.dev');
          if (!endpoint) throw new Error('Argus Dev is not configured in ARGUS_SOLUTION_PACK_ENDPOINTS');
          if (!WORKSPACE_SECRET) throw new Error('WORKSPACE_SECRET is required for visual workflow history');
          const response = await fetch(`${endpoint.endpoint}/threads/search`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-workspace-secret': WORKSPACE_SECRET,
            },
            body: JSON.stringify({ limit, metadata: { workflow_id: spec.id } }),
            signal: AbortSignal.timeout(Math.max(5_000, config.solutionPackDiscoveryTimeoutMs)),
          });
          const body = await response.json().catch(() => []) as unknown;
          if (!response.ok) {
            const detail = body && typeof body === 'object' && !Array.isArray(body)
              && typeof (body as Record<string, unknown>)['error'] === 'string'
              ? String((body as Record<string, unknown>)['error'])
              : `HTTP ${response.status}`;
            throw new Error(`Argus Dev replay history lookup failed for ${spec.id}: ${detail}`);
          }
          if (!Array.isArray(body)) throw new Error('Argus Dev returned an invalid replay history payload');
          return body.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[];
        },
        async cancelReplay(_spec, _traceId, taskId) {
          return await solutionPackA2a.cancelTask(
            'argus.dev',
            'coding-orchestrator',
            taskId,
          ) as unknown as Record<string, unknown>;
        },
        async resumeReplay(spec, traceId, decision) {
          const endpoint = solutionPackRegistry.getEndpoint('argus.dev');
          if (!endpoint) throw new Error('Argus Dev is not configured in ARGUS_SOLUTION_PACK_ENDPOINTS');
          if (!WORKSPACE_SECRET) throw new Error('WORKSPACE_SECRET is required for visual workflow resume');
          const response = await fetch(`${endpoint.endpoint}/threads/${encodeURIComponent(traceId)}/runs`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-workspace-secret': WORKSPACE_SECRET,
            },
            body: JSON.stringify({
              assistant_id: spec.graphId,
              command: { resume: decision },
            }),
            signal: AbortSignal.timeout(Math.max(5_000, config.solutionPackDiscoveryTimeoutMs)),
          });
          const body = await response.json().catch(() => ({})) as Record<string, unknown>;
          if (!response.ok) {
            const detail = typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`;
            throw new Error(`Argus Dev replay resume failed for ${spec.id}: ${detail}`);
          }
          return body;
        },
      });

      // Register Phase-6 routes (copilot — uses workflow_copilot agent from mig 090)
      const { registerCopilotRoutes } = await import('./workflows/copilotRoutes.js');
      registerCopilotRoutes(app, adminPool, config, requireAuth);

      // Round 1.5: versioning routes + snapshot-on-save hook
      const { registerVersionRoutes } = await import('./workflows/versionRoutes.js');
      registerVersionRoutes(app, adminPool, requireAuth);

      // Round 3/4: stats, tags, cost-predict, audit
      const { registerStatsRoutes } = await import('./workflows/statsRoutes.js');
      registerStatsRoutes(app, adminPool, requireAuth);

      // Round 5: approval-flow + smart linter
      const { registerApprovalRoutes } = await import('./workflows/approvalRoutes.js');
      registerApprovalRoutes(app, adminPool, requireAuth);
      const { registerLinterRoutes } = await import('./workflows/linterRoutes.js');
      registerLinterRoutes(app, adminPool, config, requireAuth);

      // Round 6 Phase 1: K8s pickers + inspector routes
      const { registerK8sPickerRoutes } = await import('./workflows/k8sPickerRoutes.js');
      registerK8sPickerRoutes(app, adminPool, config, requireAuth);
      const { registerInspectorRoutes } = await import('./workflows/inspectorRoutes.js');
      registerInspectorRoutes(app, adminPool, requireAuth);

      // Round 6 Phase 2: subscribers + runbook export + PagerDuty
      const { registerSubscriberRoutes } = await import('./workflows/subscriberRoutes.js');
      registerSubscriberRoutes(app, adminPool, requireAuth);

      // R2 (per-workflow Bitbucket creds): internal resolver endpoint for LangGraph
      // Auth: X-Workspace-Secret header. NEVER expose via Ingress.
      const { createInternalCredsRouter } = await import('./workflows/internalCredsRoutes.js');
      app.use(createInternalCredsRouter(adminPool, config.solutionPackExecutionGrantSecret));
      const { createDevGitRouter } = await import('./workflows/devGitRoutes.js');
      app.use(createDevGitRouter(adminPool, config.solutionPackExecutionGrantSecret));
      const { createDevGrantRenewalRouter } = await import('./api/devGrantRenewal.js');
      app.use(createDevGrantRenewalRouter(adminPool, config.solutionPackExecutionGrantSecret));

      // Internal LangGraph lifecycle bridge. Authenticated with the same
      // workspace secret as the runtime and never intended for ingress.
      const { createInternalTelemetryRouter } = await import('./observability/internalTelemetryRoutes.js');
      app.use(createInternalTelemetryRouter());

      // Round 2.1: spend anomaly worker + admin routes
      const { registerAnomalyRoutes, startAnomalyWorker } = await import('./workflows/anomalyRoutes.js');
      registerAnomalyRoutes(app, adminPool, requireAuth);
      startAnomalyWorker(adminPool);

      // Round 2.2: health-check matrix
      const { registerHealthRoutes } = await import('./workflows/healthRoutes.js');
      registerHealthRoutes(app, adminPool, requireAuth);

      // Round 2.3: cron + webhook trigger workers
      const { startTriggerWorker, registerWebhookTriggerRoute } = await import('./workflows/triggerWorker.js');
      const { buildRealRunners } = await import('./workflows/executeRoutes.js');
      // SECURITY (audit #1): triggered runs have no end-user identity (service
      // identity). Route their tool steps through the hook pipeline so a
      // cron/webhook-fired workflow still hits destructive-cmd / PII / cost
      // guards instead of calling executeTool bare. A per-execution sessionId
      // (passed by fireWorkflow) keeps the cost-budget counter scoped to one
      // run rather than shared across every trigger for the process lifetime.
      const wfToolRunnerFactory = (sessionId: string, workflowId?: number) => {
        const executionMatch = /^trigger:(\d+)/.exec(sessionId);
        return makeHookedToolRunner(adminPool, config, {
          source: 'workflow-trigger',
          sessionId,
          workflowId,
          workflowExecutionId: executionMatch ? Number(executionMatch[1]) : undefined,
        });
      };
      // P1-1: use the SAME real step-runners the interactive execute path uses
      // (executeRoutes.ts:181), so cron/webhook-triggered workflows can run
      // argus.agent / .skill / .knowledge / .memory steps instead of throwing
      // 'no agentRunner provided' (executor.ts:261). Agent steps manage their
      // own per-run session internally, so a representative hooked runner is
      // fine for building them.
      const wfRunners = buildRealRunners(
        adminPool, config, wfToolRunnerFactory('trigger-runners'), new Set(), 0, undefined,
        // audit M4: sub-workflows get a runner bound to their own id for the
        // human-approval-gate.
        (wfid: number, executionId?: number) => wfToolRunnerFactory(`trigger:${executionId ?? 'sub'}:wf${wfid}`, wfid),
      );
      startTriggerWorker(adminPool, wfToolRunnerFactory, wfRunners);
      registerWebhookTriggerRoute(app, adminPool, wfToolRunnerFactory, wfRunners, requireAuth);
    }

    // List all available tools (for step builder dropdown)
    app.get('/api/tools/list', requireAuth, async (_req, res) => {
      try {
        const tools = await listAllTools({ config, pool: adminPool });
        res.json(tools);
      } catch (err) {
        logger.error({ err }, 'Failed to list tools');
        res.status(500).json({ error: 'Failed to list tools' });
      }
    });

    app.get('/api/admin/workflows', requireAuth, async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const bundles = user.role === 'admin' ? null : user.allowed_bundles ?? null;
        const workflows = await loadWorkflows(adminPool, bundles, scope);
        res.json(workflows);
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        logger.error({ err }, 'Failed to list workflows');
        res.status(500).json({ error: 'Failed to list workflows' });
      }
    });

    app.get('/api/admin/workflows/:id', requireAuth, async (req, res) => {
      try {
        const u = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, u);
        const workflow = await getWorkflow(adminPool, Number(req.params.id), scope);
        if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return; }
        // SECURITY (audit): enforce the same bundle-overlap RBAC the list
        // endpoint uses, so a non-admin can't read a workflow (steps, cred_ref,
        // wiring) outside their bundles by guessing its id. A workflow with NO
        // bundles is visible to all (matches loadWorkflows semantics).
        const isAdminUser = u?.role === 'admin' || u?.role === 'platform_admin' || u?.role === 'operations_admin';
        if (!isAdminUser) {
          const allowed = Array.isArray(u?.allowed_bundles) ? u!.allowed_bundles : [];
          const wfBundles = workflow.bundle_ids ?? [];
          const visible = wfBundles.length === 0 || wfBundles.some((b) => allowed.includes(b));
          if (!visible) { res.status(404).json({ error: 'Workflow not found' }); return; }
        }
        res.json(workflow);
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        logger.error({ err }, 'Failed to get workflow');
        res.status(500).json({ error: 'Failed to get workflow' });
      }
    });

    app.get('/api/admin/workflows/:id/agent-preflight', requireAuth, async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const workflow = await getWorkflow(adminPool, Number(req.params.id), scope);
        if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return; }
        const admin = user?.role === 'admin' || user?.role === 'platform_admin' || user?.role === 'operations_admin';
        if (!admin) {
          const allowed = Array.isArray(user?.allowed_bundles) ? user.allowed_bundles : [];
          const workflowBundles = workflow.bundle_ids ?? [];
          if (workflowBundles.length > 0 && !workflowBundles.some(bundleId => allowed.includes(bundleId))) {
            res.status(404).json({ error: 'Workflow not found' });
            return;
          }
        }
        res.json(await preflightWorkflowAgents(adminPool, workflow));
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        logger.error({ err }, 'Failed to preflight workflow Agents');
        res.status(500).json({ error: 'Failed to preflight workflow Agents' });
      }
    });

    app.post('/api/admin/workflows', requireAdmin, async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        // Validate name against the wf_name_format DB constraint (^[a-z0-9_]+$)
        // BEFORE the INSERT, so an invalid name returns a clear 400 instead of a
        // confusing 500 from the Postgres CHECK violation. The UIs slugify, so
        // this is primarily a safety net for direct API callers.
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!isValidWorkflowName(name)) {
          res.status(400).json({
            error: 'Invalid workflow name: use only lowercase letters, digits and underscores (pattern ^[a-z0-9_]+$), e.g. "my_workflow".',
          });
          return;
        }
        const workflow = await createWorkflow(adminPool, {
          ...req.body,
          name,
          created_by: user?.id ?? null,
        }, scope);
        logger.info({ id: workflow.id, name: workflow.name }, 'Workflow created');
        res.status(201).json(workflow);
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof WorkflowAgentContractError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to create workflow');
        res.status(500).json({ error: 'Failed to create workflow' });
      }
    });

    app.put('/api/admin/workflows/:id', requireAdmin, async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const workflow = await updateWorkflow(adminPool, Number(req.params.id), req.body, scope);
        if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return; }
        logger.info({ id: workflow.id, name: workflow.name }, 'Workflow updated');
        res.json(workflow);
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof WorkflowAgentContractError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to update workflow');
        res.status(500).json({ error: 'Failed to update workflow' });
      }
    });

    app.delete('/api/admin/workflows/:id', requireAdmin, async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const deleted = await deleteWorkflow(adminPool, Number(req.params.id), scope);
        if (!deleted) { res.status(404).json({ error: 'Workflow not found' }); return; }
        logger.info({ id: req.params.id }, 'Workflow deleted');
        res.json({ deleted: true });
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        logger.error({ err }, 'Failed to delete workflow');
        res.status(500).json({ error: 'Failed to delete workflow' });
      }
    });

    app.post('/api/admin/workflows/:id/run', requireAuth, requireAdmin, async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const workflow = await getWorkflow(adminPool, Number(req.params.id), scope);
        if (!workflow) { res.status(404).json({ error: 'Workflow not found' }); return; }
        if (!workflow.enabled) { res.status(400).json({ error: 'Workflow is disabled' }); return; }

        const agentPreflight = await preflightWorkflowAgents(adminPool, workflow);
        if (!agentPreflight.ready) {
          res.status(409).json({ error: 'Workflow Agent contract is not ready', preflight: agentPreflight });
          return;
        }
        const resolvedWorkflow = applyWorkflowAgentAssignments(workflow, agentPreflight);

        const inputs = req.body.inputs ?? {};
        const triggeredBy = user?.username ?? 'anonymous';
        const executionId = await createExecution(
          adminPool,
          workflow.id,
          triggeredBy,
          inputs,
          workflowExecutionSnapshot(agentPreflight),
          scope,
        );

        // Execute asynchronously — return immediately with executionId.
        // Audit #1: route tool steps through the hook pipeline (admin identity).
        const hookedRunner = makeHookedToolRunner(adminPool, config, {
          source: 'admin-run',
          sessionId: `admin-run:${executionId}`,
          userId: user?.id,
          userGroups: user?.entra_groups,
          workflowId: workflow.id,
          workflowExecutionId: executionId,
        });
        const callingUser = user?.id != null
          ? { id: user.id, entra_groups: user.entra_groups ?? [], role: user.role }
          : undefined;
        const makeWorkflowRunner = (workflowId: number, nestedExecutionId?: number) => makeHookedToolRunner(adminPool, config, {
          source: 'admin-run',
          sessionId: `admin-run:${nestedExecutionId ?? executionId}:wf${workflowId}`,
          userId: callingUser?.id,
          userGroups: callingUser?.entra_groups,
          workflowId,
          workflowExecutionId: nestedExecutionId ?? executionId,
        });
        const runners = buildWorkflowRunners(
          adminPool,
          config,
          hookedRunner,
          new Set([workflow.id]),
          0,
          callingUser,
          makeWorkflowRunner,
          scope,
        );
        (async () => {
          try {
            const result = await executeWorkflow({
              workflow: resolvedWorkflow,
              inputs,
              toolRunner: hookedRunner,
              runners,
              executionId,
              triggeredBy,
            });
            await updateExecution(adminPool, executionId, result.status, result.stepResults, result.error, scope);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await updateExecution(adminPool, executionId, 'failed', {}, msg, scope);
          }
        })();

        res.json({ executionId, status: 'running' });
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        logger.error({ err }, 'Failed to start workflow');
        res.status(500).json({ error: 'Failed to start workflow' });
      }
    });

    app.get('/api/admin/workflows/:id/executions', requireAdmin, async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const limit = Number(req.query.limit) || 50;
        const offset = Number(req.query.offset) || 0;
        const history = await getExecutionHistory(adminPool, Number(req.params.id), limit, offset, scope);
        res.json(history);
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        logger.error({ err }, 'Failed to get execution history');
        res.status(500).json({ error: 'Failed to get execution history' });
      }
    });

    app.get('/api/admin/executions/:id', requireAdmin, async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const execution = await getExecution(adminPool, Number(req.params.id), scope);
        if (!execution) { res.status(404).json({ error: 'Execution not found' }); return; }
        res.json(execution);
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        logger.error({ err }, 'Failed to get execution');
        res.status(500).json({ error: 'Failed to get execution' });
      }
    });


    // ── Service Bundles ─────────────────────────────────────────

    app.get('/api/admin/bundles', requireAdmin, async (_req, res) => {
      try {
        const bundles = await listBundles(adminPool);
        res.json(bundles);
      } catch (err) {
        logger.error({ err }, 'Failed to list bundles');
        res.status(500).json({ error: 'Failed to list bundles' });
      }
    });

    app.get('/api/admin/bundles/:id', requireAdmin, async (req, res) => {
      try {
        const bundle = await getBundle(adminPool, Number(req.params.id));
        if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
        const tools = await getBundleTools(adminPool, bundle.id);
        const backends = await getBundleBackends(adminPool, bundle.id);
        const skillsRes = await adminPool.query<{ id: number; name: string; label: string; category: string | null; icon: string; position: number }>(
          `SELECT s.id, s.name, s.label, s.category, s.icon, bs.position
             FROM mcp_skills s
             JOIN mcp_bundle_skills bs ON bs.skill_id = s.id
            WHERE bs.bundle_id = $1
            ORDER BY bs.position, s.label`,
          [bundle.id],
        );
        res.json({ ...bundle, tools, backends, skills: skillsRes.rows });
      } catch (err) {
        logger.error({ err }, 'Failed to get bundle');
        res.status(500).json({ error: 'Failed to get bundle' });
      }
    });

    // Set the full list of skills bound to a bundle (replace semantics).
    app.put('/api/admin/bundles/:id/skills', requireAdmin, async (req, res) => {
      try {
        const bundleId = Number(req.params.id);
        const body = req.body as { skill_ids?: number[] };
        const skillIds = Array.isArray(body.skill_ids) ? body.skill_ids : [];
        const client = await adminPool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM mcp_bundle_skills WHERE bundle_id = $1', [bundleId]);
          for (let i = 0; i < skillIds.length; i++) {
            await client.query(
              `INSERT INTO mcp_bundle_skills (bundle_id, skill_id, position)
               VALUES ($1, $2, $3)
               ON CONFLICT (bundle_id, skill_id) DO UPDATE SET position = EXCLUDED.position`,
              [bundleId, skillIds[i], i],
            );
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
        writeAdminAudit(adminPool, req, 'updated', 'mcp_bundle_skills', String(bundleId), `bundle-${bundleId}-skills`, null, { skill_ids: skillIds });
        res.json({ ok: true, count: skillIds.length });
      } catch (err) {
        logger.error({ err }, 'Failed to set bundle skills');
        res.status(500).json({ error: 'Failed to set bundle skills' });
      }
    });

    // Skills Adoption Dashboard data
    app.get('/api/admin/skills/adoption', requireAdmin, async (req, res) => {
      try {
        const days = Math.min(Math.max(parseInt(((req.query as Record<string, string | undefined>)['days']) ?? '7', 10) || 7, 1), 90);
        const [byName, byUser, timeSeries] = await Promise.all([
          adminPool.query<{ skill: string; uses: number; unique_users: number; avg_ctx_len: number }>(
            `SELECT replace(tool, 'prompt.skill.', '')           AS skill,
                    count(*)::int                                AS uses,
                    count(DISTINCT api_key_prefix)::int          AS unique_users,
                    COALESCE(avg(NULLIF((parameters->>'context_len')::int, 0)), 0)::int AS avg_ctx_len
               FROM mcp_audit_log
              WHERE tool LIKE 'prompt.skill.%'
                AND timestamp > NOW() - ($1 || ' days')::interval
              GROUP BY tool
              ORDER BY uses DESC
              LIMIT 50`,
            [String(days)],
          ),
          adminPool.query<{ api_key_prefix: string; skill_fetches: number; distinct_skills: number }>(
            `SELECT api_key_prefix,
                    count(*)::int                  AS skill_fetches,
                    count(DISTINCT tool)::int      AS distinct_skills
               FROM mcp_audit_log
              WHERE tool LIKE 'prompt.skill.%'
                AND timestamp > NOW() - ($1 || ' days')::interval
              GROUP BY api_key_prefix
              ORDER BY skill_fetches DESC
              LIMIT 20`,
            [String(days)],
          ),
          adminPool.query<{ day: string; uses: number }>(
            `SELECT to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') AS day,
                    count(*)::int AS uses
               FROM mcp_audit_log
              WHERE tool LIKE 'prompt.skill.%'
                AND timestamp > NOW() - ($1 || ' days')::interval
              GROUP BY date_trunc('day', timestamp)
              ORDER BY day`,
            [String(days)],
          ),
        ]);

        // ── Extended metrics: engagement KPIs, stale, trending, perf ───
        // KPIs
        const kpis = await adminPool.query<{
          dau: number; wau: number; mau: number;
          total_skills: number; active_skills: number;
          avg_fetches_per_user: number;
          p50_ms: number; p95_ms: number;
          error_count: number;
        }>(
          `WITH win AS (
             SELECT * FROM mcp_audit_log
              WHERE tool LIKE 'prompt.skill.%'
                AND timestamp > NOW() - ($1 || ' days')::interval
           ),
           tot AS (SELECT count(*) AS n FROM mcp_skills),
           act AS (SELECT count(DISTINCT tool) AS n FROM win)
           SELECT
             (SELECT count(DISTINCT api_key_prefix)::int FROM mcp_audit_log WHERE tool LIKE 'prompt.skill.%' AND timestamp > NOW() - INTERVAL '1 day')   AS dau,
             (SELECT count(DISTINCT api_key_prefix)::int FROM mcp_audit_log WHERE tool LIKE 'prompt.skill.%' AND timestamp > NOW() - INTERVAL '7 days')  AS wau,
             (SELECT count(DISTINCT api_key_prefix)::int FROM mcp_audit_log WHERE tool LIKE 'prompt.skill.%' AND timestamp > NOW() - INTERVAL '30 days') AS mau,
             (SELECT n::int FROM tot)  AS total_skills,
             (SELECT n::int FROM act)  AS active_skills,
             CASE WHEN (SELECT count(DISTINCT api_key_prefix) FROM win) = 0 THEN 0
                  ELSE ROUND((SELECT count(*) FROM win)::numeric / (SELECT count(DISTINCT api_key_prefix) FROM win), 1)
             END::float8 AS avg_fetches_per_user,
             COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p50_ms,
             COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms,
             (SELECT count(*)::int FROM win WHERE is_error)         AS error_count
             FROM win`,
          [String(days)],
        );

        // Stale skills — exist in mcp_skills but 0 fetches in window
        const stale = await adminPool.query<{ id: number; name: string; label: string; icon: string; days_since_last_use: number | null }>(
          `SELECT s.id, s.name, s.label, s.icon,
                  EXTRACT(EPOCH FROM (NOW() - max(a.timestamp))) / 86400.0 AS days_since_last_use
             FROM mcp_skills s
             LEFT JOIN mcp_audit_log a ON a.tool = 'prompt.skill.' || s.name
                                      AND a.timestamp > NOW() - INTERVAL '90 days'
            GROUP BY s.id, s.name, s.label, s.icon
            HAVING max(a.timestamp) IS NULL OR max(a.timestamp) < NOW() - ($1 || ' days')::interval
            ORDER BY days_since_last_use NULLS FIRST, s.label
            LIMIT 30`,
          [String(days)],
        );

        // Trending: compare last (days/2) period vs prior (days/2) period
        const half = Math.max(1, Math.floor(days / 2));
        const trending = await adminPool.query<{ skill: string; recent: number; prior: number; delta: number }>(
          `WITH recent AS (
              SELECT tool, count(*) AS n FROM mcp_audit_log
              WHERE tool LIKE 'prompt.skill.%'
                AND timestamp > NOW() - ($1 || ' days')::interval
              GROUP BY tool
           ),
           prior AS (
              SELECT tool, count(*) AS n FROM mcp_audit_log
              WHERE tool LIKE 'prompt.skill.%'
                AND timestamp BETWEEN NOW() - (($1::int * 2) || ' days')::interval
                                  AND NOW() - ($1 || ' days')::interval
              GROUP BY tool
           )
           SELECT replace(COALESCE(r.tool, p.tool), 'prompt.skill.', '') AS skill,
                  COALESCE(r.n, 0)::int AS recent,
                  COALESCE(p.n, 0)::int AS prior,
                  (COALESCE(r.n, 0) - COALESCE(p.n, 0))::int AS delta
             FROM recent r FULL OUTER JOIN prior p ON r.tool = p.tool
            ORDER BY abs(COALESCE(r.n, 0) - COALESCE(p.n, 0)) DESC, recent DESC
            LIMIT 20`,
          [String(half)],
        );

        // Hourly heatmap: usage by day-of-week × hour-of-day
        const heatmap = await adminPool.query<{ dow: number; hour: number; n: number }>(
          `SELECT EXTRACT(DOW  FROM timestamp)::int AS dow,
                  EXTRACT(HOUR FROM timestamp)::int AS hour,
                  count(*)::int                     AS n
             FROM mcp_audit_log
            WHERE tool LIKE 'prompt.skill.%'
              AND timestamp > NOW() - ($1 || ' days')::interval
            GROUP BY 1, 2`,
          [String(days)],
        );

        res.json({
          window_days: days,
          by_skill:    byName.rows,
          by_user:     byUser.rows,
          time_series: timeSeries.rows,
          kpis:        kpis.rows[0] ?? null,
          stale:       stale.rows,
          trending:    trending.rows,
          heatmap:     heatmap.rows,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to compute skills adoption');
        res.status(500).json({ error: 'Failed to compute skills adoption' });
      }
    });

    app.post('/api/admin/bundles', async (req, res) => {
      try {
        const bundle = await createBundle(adminPool, req.body);
        writeAdminAudit(adminPool, req, 'created', 'mcp_service_bundles', String(bundle.id), bundle.name, null, bundle);
        res.status(201).json(bundle);
      } catch (err) {
        logger.error({ err }, 'Failed to create bundle');
        res.status(500).json({ error: 'Failed to create bundle' });
      }
    });

    app.put('/api/admin/bundles/:id', async (req, res) => {
      try {
        const before = await getBundle(adminPool, Number(req.params.id));
        const bundle = await updateBundle(adminPool, Number(req.params.id), req.body);
        writeAdminAudit(adminPool, req, 'updated', 'mcp_service_bundles', String(bundle.id), bundle.name, before, bundle);
        res.json(bundle);
      } catch (err) {
        logger.error({ err }, 'Failed to update bundle');
        res.status(500).json({ error: 'Failed to update bundle' });
      }
    });

    app.delete('/api/admin/bundles/:id', async (req, res) => {
      try {
        const before = await getBundle(adminPool, Number(req.params.id));
        const deleteContents = req.query.contents === 'true';
        await deleteBundle(adminPool, Number(req.params.id), deleteContents);
        writeAdminAudit(adminPool, req, 'deleted', 'mcp_service_bundles', String(req.params.id), before?.name ?? null, before, null);
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(err));
          return;
        }
        logger.error({ err }, 'Failed to delete bundle');
        res.status(500).json({ error: 'Failed to delete bundle' });
      }
    });

    app.post('/api/admin/bundles/:id/apply-template', async (req, res) => {
      try {
        const bundleId = Number(req.params.id);
        const bundle = await getBundle(adminPool, bundleId);
        if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

        const result = await applyTemplate(adminPool, { ...req.body, bundleId });
        await refreshBackendCaches(adminPool);
        logger.info({ bundle: bundle.name, template: req.body.templateId, prefix: req.body.prefix }, 'Template applied to bundle');
        res.status(201).json(result);
      } catch (err) {
        logger.error({ err }, 'Failed to apply template to bundle');
        res.status(500).json({ error: 'Failed to apply template' });
      }
    });

    // ── Backend ↔ Bundle assignments (n:m) ──────────────────────

    app.put('/api/admin/backends/:id/bundles', async (req, res) => {
      const client = await adminPool.connect();
      try {
        const backendId = Number(req.params.id);
        const bundleIds: number[] = req.body.bundle_ids ?? [];
        await client.query('BEGIN');
        const ownership = await lockBackendOpenApiOwnership(client, backendId);
        if (!ownership) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Backend not found' });
          return;
        }
        if (ownership.sourceControlled) {
          throw new OpenApiOwnershipError(
            'Die Bundle-Zuordnung dieser OpenAPI-verwalteten Connection ist Teil des Import-Manifests. '
            + 'Ändere sie über das Capability Studio.',
          );
        }
        // Replace all associations for this backend
        await client.query('DELETE FROM mcp_backend_bundles WHERE backend_id = $1', [backendId]);
        for (const bid of bundleIds) {
          await client.query(
            'INSERT INTO mcp_backend_bundles (backend_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [backendId, bid],
          );
        }
        // Also update associated tools: tools that belong to this backend
        // should also be linked to the same bundles
        const { rows: backendTools } = await client.query(
          `SELECT id FROM mcp_tools WHERE backend LIKE 'custom:' || (SELECT name FROM mcp_backends WHERE id = $1) || '%'`,
          [backendId],
        );
        for (const tool of backendTools) {
          await client.query('DELETE FROM mcp_tool_bundles WHERE tool_id = $1', [tool.id]);
          for (const bid of bundleIds) {
            await client.query(
              'INSERT INTO mcp_tool_bundles (tool_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [tool.id, bid],
            );
          }
        }
        await client.query('COMMIT');
        await refreshBackendCaches(adminPool);
        logger.info({ backendId, bundleIds }, 'Backend bundle associations updated');
        res.json({ ok: true, bundle_ids: bundleIds });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(err));
          return;
        }
        logger.error({ err }, 'Failed to update backend bundles');
        res.status(500).json({ error: 'Failed to update backend bundles' });
      } finally {
        client.release();
      }
    });

    app.put('/api/admin/tools/:id/bundles', async (req, res) => {
      const client = await adminPool.connect();
      try {
        const toolId = Number(req.params.id);
        const bundleIds: number[] = req.body.bundle_ids ?? [];
        await client.query('BEGIN');
        const ownership = await lockCapabilityOpenApiOwnership(client, toolId);
        if (!ownership) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Tool not found' });
          return;
        }
        if (ownership.sourceControlled) {
          throw new OpenApiOwnershipError(
            'Die Bundle-Zuordnung dieser OpenAPI-importierten Capability ist Teil des Import-Manifests. '
            + 'Ändere sie über das Capability Studio.',
          );
        }
        await client.query('DELETE FROM mcp_tool_bundles WHERE tool_id = $1', [toolId]);
        for (const bid of bundleIds) {
          await client.query(
            'INSERT INTO mcp_tool_bundles (tool_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [toolId, bid],
          );
        }
        await client.query('COMMIT');
        logger.info({ toolId, bundleIds }, 'Tool bundle associations updated');
        res.json({ ok: true, bundle_ids: bundleIds });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(err));
          return;
        }
        logger.error({ err }, 'Failed to update tool bundles');
        res.status(500).json({ error: 'Failed to update tool bundles' });
      } finally {
        client.release();
      }
    });

    // ── Batch Operations ────────────────────────────────────────

    app.post('/api/admin/backends/batch', async (req, res) => {
      try {
        const { action, ids } = req.body as { action: string; ids: number[] };
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No IDs provided' });
        let affected = 0;
        if (action === 'delete') {
          const client = await adminPool.connect();
          try {
            await client.query('BEGIN');
            for (const id of [...new Set(ids)].sort((left, right) => left - right)) {
              const ownership = await lockBackendOpenApiOwnership(client, id);
              if (ownership?.sourceControlled) {
                throw new OpenApiOwnershipError(
                  'Die Auswahl enthält eine OpenAPI-verwaltete Connection. '
                  + 'Entferne sie kontrolliert über das Capability Studio.',
                );
              }
            }
            const deleted = await client.query(
              'DELETE FROM mcp_backends WHERE id = ANY($1::int[]) AND backend_type != $2',
              [ids, 'builtin'],
            );
            affected = deleted.rowCount ?? 0;
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }
        } else for (const id of ids) {
          if (action === 'enable') {
            const r = await adminPool.query('UPDATE mcp_backends SET enabled = true WHERE id = $1 AND backend_type != $2', [id, 'builtin']);
            affected += r.rowCount ?? 0;
          } else if (action === 'disable') {
            const r = await adminPool.query('UPDATE mcp_backends SET enabled = false WHERE id = $1 AND backend_type != $2', [id, 'builtin']);
            affected += r.rowCount ?? 0;
          } else {
            return res.status(400).json({ error: 'Unknown action: ' + action });
          }
        }
        await refreshBackendCaches(adminPool);
        logger.info({ action, ids, affected }, 'Batch backend operation');
        res.json({ ok: true, affected, message: affected + ' Backend(s) ' + (action === 'delete' ? 'gelöscht' : action === 'enable' ? 'aktiviert' : 'deaktiviert') });
      } catch (err) {
        if (err instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(err));
          return;
        }
        logger.error({ err }, 'Batch backend operation failed');
        res.status(500).json({ error: 'Batch operation failed' });
      }
    });

    app.post('/api/admin/tools/batch', async (req, res) => {
      try {
        const { action, ids } = req.body as { action: string; ids: number[] };
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No IDs provided' });
        let affected = 0;
        if (action === 'delete') {
          const client = await adminPool.connect();
          try {
            await client.query('BEGIN');
            for (const id of [...new Set(ids)].sort((left, right) => left - right)) {
              const ownership = await lockCapabilityOpenApiOwnership(client, id);
              if (ownership?.sourceControlled) {
                throw new OpenApiOwnershipError(
                  'Die Auswahl enthält eine OpenAPI-importierte Capability. '
                  + 'Entferne sie kontrolliert über das Capability Studio.',
                );
              }
            }
            const deleted = await client.query(
              'DELETE FROM mcp_tools WHERE id = ANY($1::int[])',
              [ids],
            );
            affected = deleted.rowCount ?? 0;
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }
        } else for (const id of ids) {
          if (action === 'enable') {
            const r = await adminPool.query('UPDATE mcp_tools SET enabled = true WHERE id = $1', [id]);
            affected += r.rowCount ?? 0;
          } else if (action === 'disable') {
            const r = await adminPool.query('UPDATE mcp_tools SET enabled = false WHERE id = $1', [id]);
            affected += r.rowCount ?? 0;
          } else {
            return res.status(400).json({ error: 'Unknown action: ' + action });
          }
        }
        logger.info({ action, ids, affected }, 'Batch tool operation');
        res.json({ ok: true, affected, message: affected + ' Tool(s) ' + (action === 'delete' ? 'gelöscht' : action === 'enable' ? 'aktiviert' : 'deaktiviert') });
      } catch (err) {
        if (err instanceof OpenApiOwnershipError) {
          res.status(409).json(openApiConflictBody(err));
          return;
        }
        logger.error({ err }, 'Batch tool operation failed');
        res.status(500).json({ error: 'Batch operation failed' });
      }
    });

    // ── Service Templates ──────────────────────────────────────

    app.get('/api/admin/template-categories', requireAdmin, (_req, res) => {
      res.json(TEMPLATE_CATEGORIES);
    });

    app.get('/api/admin/templates', requireAdmin, (req, res) => {
      const { category, q } = req.query;
      let templates = q
        ? searchTemplates(String(q))
        : category
          ? getTemplatesByCategory(String(category))
          : getAllTemplates();

      res.json(templates.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        icon: t.icon,
        category: t.category,
        subcategory: t.subcategory ?? null,
        tags: t.tags ?? [],
        backendType: t.backendType ?? 'http',
        docsUrl: t.docsUrl ?? null,
        fields: t.fields,
        toolCount: t.tools.length,
        tools: t.tools.map(tool => ({ nameSuffix: tool.nameSuffix, description: tool.description })),
      })));
    });

    app.post('/api/admin/templates/apply', async (req, res) => {
      try {
        const result = await applyTemplate(adminPool, req.body);
        // Refresh backend cache
        await refreshBackendCaches(adminPool);
        logger.info({ template: req.body.templateId, prefix: req.body.prefix }, 'Template applied');
        res.status(201).json(result);
      } catch (err) {
        logger.error({ err }, 'Failed to apply template');
        res.status(500).json({ error: 'Failed to apply template' });
      }
    });

    // ── API Key RBAC Management ─────────────────────────────────

    const scopedApiKeyAuditContext = (req: express.Request) => {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      return {
        scope,
        context: { ...buildUserLifecycleAuditContext(req, user), ...scope },
      };
    };

    app.get('/api/admin/api-keys', requireAdmin, async (req, res) => {
      try {
        const { scope } = scopedApiKeyAuditContext(req);
        // The unified admin panel manages MCP-, agent- and dual-scope keys.
        const { rows } = await adminPool.query(
          `SELECT id, key_prefix, label, allowed_bundles, allowed_tools, denied_tools,
                  max_requests_per_minute, scope, key_suffix, enabled, acting_as_user_id,
                  composite_id, expires_at, last_used_at, rotation_schedule, next_rotation_at, created_at,
                  tenant_key, workspace_key
           FROM mcp_api_keys
           WHERE tenant_key=$1 AND workspace_key=$2 AND deleted_at IS NULL
           ORDER BY created_at DESC`,
          [scope.tenantKey, scope.workspaceKey],
        );
        res.json(rows);
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: 'Workspace scope was not found.', code: err.code });
          return;
        }
        logger.error({ err }, 'Failed to list API keys');
        res.status(500).json({ error: 'Failed to list API keys' });
      }
    });

    app.get('/api/admin/api-keys/binding-targets', requireAdmin, async (req, res) => {
      try {
        scopedApiKeyAuditContext(req);
        res.json(await listApiKeyBindingTargets(adminPool, (req as AuthenticatedRequest).user));
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) { res.status(err.status).json({ error: 'Workspace scope was not found.', code: err.code }); return; }
        logger.error({ err }, 'Failed to list API key binding targets');
        res.status(500).json({ error: 'Failed to load eligible user identities' });
      }
    });

    app.post('/api/admin/api-keys', async (req, res) => {
      try {
        const { context } = scopedApiKeyAuditContext(req);
        const { label, allowed_bundles, allowed_tools, denied_tools, max_requests_per_minute, scope, enabled, acting_as_user_id, expires_at } = req.body;
        if (!label || label.trim().length === 0) {
          res.status(400).json({ error: 'Label ist erforderlich' });
          return;
        }
        const validScopes = ['mcp', 'agents', 'both'];
        // This endpoint is the MCP admin panel — default scope to 'mcp' so
        // newly created keys land here. Gateway keys are created via the
        // operations admin endpoint with scope='both' or 'agents'.
        const keyScope = validScopes.includes(scope) ? scope : 'mcp';
        let actingUserId: number | null;
        try {
          actingUserId = parseApiKeyBinding(acting_as_user_id);
        } catch {
          res.status(400).json({ error: 'acting_as_user_id must be a positive integer or null' });
          return;
        }

        // H5: Privilege-escalation prevention
        try {
          const creator = (req as unknown as { user?: SessionUser }).user;
          await assertCanBindKeyToUser(adminPool, creator, actingUserId);
        } catch (err) {
          res.status(403).json({ error: err instanceof Error ? err.message : 'binding rejected' });
          return;
        }

        const result = await createManagedApiKeyAudited(adminPool, {
          label: label.trim(),
          allowedBundles: allowed_bundles ?? null,
          allowedTools: allowed_tools ?? null,
          deniedTools: denied_tools ?? null,
          maxRequestsPerMinute: max_requests_per_minute ?? null,
          scope: keyScope,
          enabled: enabled ?? true,
          actingAsUserId: actingUserId,
          expiresAt: expires_at ?? null,
        }, context);
        if (result.replayed || !result.value || !result.apiKey) {
          res.status(409).json({
            error: 'API key creation already committed; the one-time secret cannot be replayed. Rotate the key to issue a new secret.',
            code: 'API_KEY_SECRET_NOT_REPLAYABLE',
            api_key_id: Number(result.auditEvent.resource.id),
            audit_event_id: result.auditEvent.eventId,
          });
          return;
        }
        const key = result.value;
        await loadApiKeyRbac(adminPool);
        logger.info({ keyPrefix: key.key_prefix, scope: keyScope, acting_as_user_id: actingUserId }, 'API key created via admin API');
        // N3 — Admin-Audit. Wichtig: acting_as_user_id wird prominent geloggt damit
        // post-incident-forensics nachvollziehen kann, wer Impersonation-Bindings angelegt hat.
        writeAdminAudit(adminPool, req, 'created', 'mcp_api_keys', String(key.id), label.trim(), null, {
          key_prefix: key.key_prefix, scope: keyScope, enabled: enabled ?? true,
          acting_as_user_id: actingUserId,
          allowed_bundles: allowed_bundles ?? null,
        });
        // Return the full key ONCE – it will never be retrievable again
        res.status(201).json({ ...key, api_key: result.apiKey });
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) { res.status(err.status).json({ error: 'Workspace scope was not found.', code: err.code }); return; }
        if (err instanceof ApiKeyLifecycleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
        logger.error({ err }, 'Failed to create API key');
        res.status(500).json({ error: 'Failed to create API key' });
      }
    });

    app.put('/api/admin/api-keys/:id', async (req, res) => {
      try {
        const { context } = scopedApiKeyAuditContext(req);
        const { label, allowed_bundles, allowed_tools, denied_tools, max_requests_per_minute, scope, enabled, expires_at } = req.body;
        const validScopes = ['mcp', 'agents', 'both'];
        const keyScope = validScopes.includes(scope) ? scope : 'both';

        const result = await updateManagedApiKeyAudited(adminPool, req.params.id, {
          label,
          allowedBundles: allowed_bundles ?? null,
          allowedTools: allowed_tools ?? null,
          deniedTools: denied_tools ?? null,
          maxRequestsPerMinute: max_requests_per_minute ?? null,
          scope: keyScope,
          enabled: enabled ?? true,
          expiresAt: expires_at ?? null,
        }, context);
        const key = result.value!;
        await loadApiKeyRbac(adminPool);
        const actingUserId = key.acting_as_user_id;
        logger.info({ id: req.params.id, acting_as_user_id: actingUserId, replayed: result.replayed }, 'API key update request processed via admin API');
        // N3 — Admin-Audit für Updates (acting_as-Änderungen sind Impersonation-Power)
        if (!result.replayed) {
          writeAdminAudit(adminPool, req, 'updated', 'mcp_api_keys', String(req.params.id), label,
            result.before, {
              scope: keyScope, enabled: enabled ?? true,
              acting_as_user_id: actingUserId,
              allowed_bundles: allowed_bundles ?? null,
            });
        }
        res.json(key);
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) { res.status(err.status).json({ error: 'Workspace scope was not found.', code: err.code }); return; }
        if (err instanceof ApiKeyLifecycleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
        logger.error({ err }, 'Failed to update API key');
        res.status(500).json({ error: 'Failed to update API key' });
      }
    });

    app.post('/api/admin/api-keys/:id/rotate', async (req, res) => {
      try {
        const { context } = scopedApiKeyAuditContext(req);
        const result = await rotateManagedApiKeyAudited(
          adminPool,
          req.params.id,
          context,
        );
        if (result.replayed || !result.value || !result.apiKey) {
          res.status(409).json({
            error: 'API key rotation already committed; the one-time secret cannot be replayed. Start a new rotation with a new Idempotency-Key.',
            code: 'API_KEY_SECRET_NOT_REPLAYABLE',
            api_key_id: Number(result.auditEvent.resource.id),
            audit_event_id: result.auditEvent.eventId,
          });
          return;
        }
        const rotated = result.value;
        await loadApiKeyRbac(adminPool);
        writeAdminAudit(adminPool, req, 'rotated', 'mcp_api_keys', String(rotated.id), rotated.label,
          { key_prefix: result.before?.key_prefix }, { key_prefix: rotated.key_prefix });
        logger.info({ id: rotated.id, keyPrefix: rotated.key_prefix }, 'API key rotated via admin API');
        res.json({ ...rotated, api_key: result.apiKey });
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) { res.status(err.status).json({ error: 'Workspace scope was not found.', code: err.code }); return; }
        if (err instanceof ApiKeyLifecycleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
        logger.error({ err }, 'Failed to rotate API key');
        res.status(500).json({ error: 'Failed to rotate API key' });
      }
    });

    app.delete('/api/admin/api-keys/:id', async (req, res) => {
      try {
        const { context } = scopedApiKeyAuditContext(req);
        const result = await deleteManagedApiKeyAudited(
          adminPool,
          req.params.id,
          context,
        );
        await loadApiKeyRbac(adminPool);
        logger.info({ id: req.params.id, replayed: result.replayed }, 'API key delete request processed via admin API');
        // N3 — Admin-Audit für Delete
        const k = result.before;
        if (!result.replayed) {
          writeAdminAudit(adminPool, req, 'deleted', 'mcp_api_keys', String(req.params.id),
            k?.label ?? null, { key_prefix: k?.key_prefix, acting_as_user_id: k?.acting_as_user_id }, null);
        }
        res.json({ deleted: true });
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) { res.status(err.status).json({ error: 'Workspace scope was not found.', code: err.code }); return; }
        if (err instanceof ApiKeyLifecycleError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
        logger.error({ err }, 'Failed to delete API key');
        res.status(500).json({ error: 'Failed to delete API key' });
      }
    });

    // ── Message Filters CRUD ────────────────────────────────────

    const hermesConnectionId = (value: unknown): number => {
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new HermesDevConnectionError(400, 'invalid_hermes_connection_id', 'Hermes connection ID is invalid');
      }
      return id;
    };
    const hermesEndpointUrl = (req: express.Request): string =>
      `${req.protocol}://${req.get('host') ?? '127.0.0.1:3000'}/mcp/hermes-dev`;
    const sendHermesConnectionError = (res: express.Response, cause: unknown, operation: string): void => {
      if (cause instanceof WorkspaceScopeAccessError) {
        res.status(cause.status).json({ error: 'Workspace scope was not found.', code: cause.code });
        return;
      }
      if (cause instanceof HermesDevConnectionError) {
        res.status(cause.status).json({ error: cause.message, code: cause.code });
        return;
      }
      logger.error({ err: cause }, `Failed to ${operation} Hermes Dev connection`);
      res.status(500).json({ error: `Failed to ${operation} Hermes Dev connection` });
    };

    app.get('/api/hermes-dev/connections', requireAuth, requireRole('developer'), async (req, res) => {
      try {
        const owner = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, owner);
        res.json(await hermesDevConnections!.catalog(owner.id, scope));
      } catch (cause) {
        sendHermesConnectionError(res, cause, 'list');
      }
    });

    app.post('/api/hermes-dev/connections', requireAuth, requireRole('developer'), requireSameOrigin, async (req, res) => {
      try {
        const owner = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, owner);
        const created = await hermesDevConnections!.create(
          { label: req.body?.label, bundleIds: req.body?.bundleIds },
          owner.id,
          hermesEndpointUrl(req),
          scope,
        );
        await loadApiKeyRbac(adminPool);
        writeAdminAudit(adminPool, req, 'created', 'mcp_hermes_dev_connections', String(created.connection.id), created.connection.label, null, {
          user_id: created.connection.userId,
          bundle_ids: created.connection.bundleIds,
          key_prefix: created.connection.keyPrefix,
          tool_pattern: 'argus_dev_*',
        });
        res.status(201).json(created);
      } catch (cause) {
        sendHermesConnectionError(res, cause, 'create');
      }
    });

    app.post('/api/hermes-dev/connections/:id/test', requireAuth, requireRole('developer'), requireSameOrigin, async (req, res) => {
      try {
        const owner = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, owner);
        const result = await hermesDevConnections!.test(hermesConnectionId(req.params.id), owner.id, scope);
        writeAdminAudit(adminPool, req, 'tested', 'mcp_hermes_dev_connections', String(result.connection.id), result.connection.label, null, {
          core_ready: result.coreReady,
          client_seen: result.clientSeen,
        });
        res.json(result);
      } catch (cause) {
        sendHermesConnectionError(res, cause, 'test');
      }
    });

    app.post('/api/hermes-dev/connections/:id/rotate', requireAuth, requireRole('developer'), requireSameOrigin, async (req, res) => {
      try {
        const owner = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, owner);
        const result = await hermesDevConnections!.rotate(
          hermesConnectionId(req.params.id), owner.id, hermesEndpointUrl(req), scope,
        );
        await loadApiKeyRbac(adminPool);
        writeAdminAudit(adminPool, req, 'rotated', 'mcp_hermes_dev_connections', String(result.connection.id), result.connection.label, null, {
          key_prefix: result.connection.keyPrefix,
        });
        res.json(result);
      } catch (cause) {
        sendHermesConnectionError(res, cause, 'rotate');
      }
    });

    app.delete('/api/hermes-dev/connections/:id', requireAuth, requireRole('developer'), requireSameOrigin, async (req, res) => {
      try {
        const owner = (req as AuthenticatedRequest).user!;
        const scope = resolveAuthorizedWorkspaceScope(req, owner);
        const result = await hermesDevConnections!.revoke(hermesConnectionId(req.params.id), owner.id, scope);
        await loadApiKeyRbac(adminPool);
        writeAdminAudit(adminPool, req, 'revoked', 'mcp_hermes_dev_connections', String(result.id), result.label, {
          key_prefix: result.keyPrefix,
        }, { revoked_at: result.revokedAt });
        res.json({ connection: result });
      } catch (cause) {
        sendHermesConnectionError(res, cause, 'revoke');
      }
    });

    app.get('/api/admin/filters', requireAuth, requireAdmin, async (_req, res) => {
      try {
        const filters = await loadAllToolFilters(adminPool);
        res.json(filters.map(({ hmac_secret, ...filter }) => ({
          ...filter,
          hmac_secret: null,
          has_hmac_secret: Boolean(hmac_secret),
        })));
      } catch (err) {
        logger.error({ err }, 'Failed to list filters');
        res.status(500).json({ error: 'Failed to list filters' });
      }
    });

    app.post('/api/admin/filters', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { name, description, webhook_url, hmac_secret, timeout_ms, tool_patterns, enabled, on_timeout } = req.body;

        if (!name || !/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'Name darf nur Kleinbuchstaben, Zahlen, _ und - enthalten' });
          return;
        }
        if (!webhook_url) {
          res.status(400).json({ error: 'webhook_url ist erforderlich' });
          return;
        }
        assertSsrfSafe(webhook_url);

        const result = await createToolFilterAudited(adminPool, {
          name,
          description: description ?? '',
          webhook_url,
          hmac_secret: hmac_secret ?? null,
          timeout_ms: timeout_ms ?? 3000,
          tool_patterns: tool_patterns ?? [],
          enabled: enabled ?? true,
          on_timeout: on_timeout ?? 'allow',
        }, buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!));
        const filter = result.value;
        setToolFilters(await loadToolFilters(adminPool));
        logger.info({ name }, 'Message filter created');
        if (!result.replayed) {
          writeAdminAudit(adminPool, req, 'created', 'mcp_tool_filters', String(filter.id), filter.name, null, {
            ...filter, hmac_secret: undefined, has_hmac_secret: Boolean(filter.hmac_secret),
          });
        }
        res.status(result.replayed ? 200 : 201).json({
          ...filter, hmac_secret: null, has_hmac_secret: Boolean(filter.hmac_secret),
          replayed: result.replayed, auditEventId: result.auditEvent.eventId,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to create filter');
        res.status(err instanceof ToolFilterMutationError ? err.status : 500)
          .json({ error: err instanceof ToolFilterMutationError ? err.message : 'Failed to create filter' });
      }
    });

    app.put('/api/admin/filters/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const before = await getToolFilter(adminPool, Number(req.params.id));
        const { webhook_url, hmac_secret, ...rest } = req.body;
        if (webhook_url) assertSsrfSafe(webhook_url);

        const patch = {
          ...(webhook_url ? { webhook_url } : {}),
          ...rest,
          ...(typeof hmac_secret === 'string' && hmac_secret.trim() ? { hmac_secret: hmac_secret.trim() } : {}),
        };
        const result = await updateToolFilterAudited(
          adminPool, Number(req.params.id), patch,
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        const updated = result.value;
        setToolFilters(await loadToolFilters(adminPool));
        logger.info({ id: req.params.id }, 'Message filter updated');
        if (!result.replayed) {
          writeAdminAudit(adminPool, req, 'updated', 'mcp_tool_filters', String(updated.id), updated.name,
            before ? { ...before, hmac_secret: undefined, has_hmac_secret: Boolean(before.hmac_secret) } : null,
            { ...updated, hmac_secret: undefined, has_hmac_secret: Boolean(updated.hmac_secret) });
        }
        res.json({
          ...updated, hmac_secret: null, has_hmac_secret: Boolean(updated.hmac_secret),
          replayed: result.replayed, auditEventId: result.auditEvent.eventId,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to update filter');
        res.status(err instanceof ToolFilterMutationError ? err.status : 500)
          .json({ error: err instanceof ToolFilterMutationError ? err.message : 'Failed to update filter' });
      }
    });

    app.delete('/api/admin/filters/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const before = await getToolFilter(adminPool, Number(req.params.id));
        const result = await deleteToolFilterAudited(
          adminPool, Number(req.params.id),
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        setToolFilters(await loadToolFilters(adminPool));
        logger.info({ id: req.params.id }, 'Message filter deleted');
        if (!result.replayed) {
          writeAdminAudit(adminPool, req, 'deleted', 'mcp_tool_filters', String(req.params.id), before?.name ?? null,
            before ? { ...before, hmac_secret: undefined, has_hmac_secret: Boolean(before.hmac_secret) } : null, null);
        }
        res.json({ deleted: true, replayed: result.replayed, auditEventId: result.auditEvent.eventId });
      } catch (err) {
        logger.error({ err }, 'Failed to delete filter');
        res.status(err instanceof ToolFilterMutationError ? err.status : 500)
          .json({ error: err instanceof ToolFilterMutationError ? err.message : 'Failed to delete filter' });
      }
    });

    app.post('/api/admin/filters/:id/test', requireAuth, requireAdmin, async (req, res) => {
      try {
        const filter = await getToolFilter(adminPool, Number(req.params.id));
        if (!filter) {
          res.status(404).json({ error: 'Filter not found' });
          return;
        }
        const result = await testToolFilter(
          filter,
          typeof req.body.tool_name === 'string' ? req.body.tool_name : 'test_tool',
          req.body.args && typeof req.body.args === 'object' && !Array.isArray(req.body.args) ? req.body.args : {},
        );
        writeAdminAudit(adminPool, req, 'tested', 'mcp_tool_filters', String(filter.id), filter.name, null, {
          reachable: result.reachable, status: result.status, decision: result.decision,
          latency_ms: result.latencyMs, signed: result.signed,
        });
        res.json({ ...result, body: result.responsePreview });
      } catch (err) {
        logger.error({ err }, 'Filter test failed');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Test failed' });
      }
    });

    // ── Topology graph ────────────────────────────────────────────
    // Cytoscape-shaped {nodes, edges, stats} for the Topology tab.
    // /api/admin/topology         → full graph
    // /api/admin/topology/agent/:id → subgraph around one agent
    {
      const { handleTopologyGet, handleAgentTopologyGet } = await import('./admin/topology.js');
      app.get('/api/admin/topology', requireAuth, handleTopologyGet(adminPool));
      app.get('/api/admin/topology/agent/:id', requireAuth, handleAgentTopologyGet(adminPool));
    }

    // ── Compliance audit routes ──────────────────────────────────
    // /api/admin/compliance/frameworks       catalogue (eu_ai_act, nis2, …)
    // /api/admin/compliance/runs             list + start audit
    // /api/admin/compliance/runs/:id         status + drill-down endpoints
    {
      const { handleCompliance } = await import('./admin/compliance/routes.js');
      const cm = handleCompliance(adminPool, config);
      // Global app.{post,delete}('/api/admin/*', …) already enforces
      // requireSameOrigin + requireAdmin + adminRateLimit — handlers only
      // need to add requireAdmin on GETs (reads), which doesn't have global
      // protection.
      app.get   ('/api/admin/compliance/frameworks',        requireAdmin, cm.listFrameworks);
      app.get   ('/api/admin/compliance/runs',              requireAdmin, cm.listRuns);
      app.post  ('/api/admin/compliance/runs',              cm.startRun);
      app.get   ('/api/admin/compliance/runs/:id',          requireAdmin, cm.getRun);
      app.delete('/api/admin/compliance/runs/:id',          cm.deleteRun);
      app.get   ('/api/admin/compliance/runs/:id/findings', requireAdmin, cm.listFindings);
      // Exports leave the platform: same fresh-MFA bar as canonical audit reports.
      app.get   ('/api/admin/compliance/runs/:id/export.pdf', requireAdmin, requireFreshMfa(config.oidcMfaMaxAgeSeconds), cm.exportPdf);
      app.get   ('/api/admin/compliance/runs/:id/export.csv', requireAdmin, requireFreshMfa(config.oidcMfaMaxAgeSeconds), cm.exportCsv);
    }

    // ── Synthetic canaries (read-only status) ──
    app.get('/api/admin/canaries', requireAdmin, (_req, res) => {
      res.json({
        summaries: getCanarySummaries(),
        history:   getCanaryResults(),
      });
    });

    // ── Immutable Audit Log Query (read-only) ──
    // Searchable view over mcp_immutable_audit_log — EU AI Act / SOC2 /
    // GDPR compliance evidence. Filters: time range, api_key, event_type,
    // model, is_error, user_id. Paginated.
    app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
      try {
        const q = req.query as Record<string, string | undefined>;
        const limit  = Math.min(parseInt(q['limit']  ?? '100', 10) || 100, 500);
        const offset = Math.max(parseInt(q['offset'] ?? '0',   10) || 0, 0);

        const conds: string[] = [];
        const params: unknown[] = [];
        const push = (sql: string, val: unknown): void => {
          params.push(val);
          conds.push(sql.replace('?', `$${params.length}`));
        };
        if (q['from'])           push('created_at >= ?',           q['from']);
        if (q['to'])             push('created_at <= ?',           q['to']);
        if (q['event_type'])     push('event_type = ?',            q['event_type']);
        if (q['api_key_prefix']) push('api_key_prefix ILIKE ?',    `%${q['api_key_prefix']}%`);
        if (q['model'])          push('model ILIKE ?',             `%${q['model']}%`);
        if (q['user_id'])        push('user_id = ?',               parseInt(q['user_id']!, 10));
        if (q['session_id'])     push('session_id = ?',            q['session_id']);
        if (q['is_error'] === 'true')  push('is_error = ?', true);
        if (q['is_error'] === 'false') push('is_error = ?', false);
        if (q['risk_level'])     push('risk_level = ?',            q['risk_level']);

        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const [list, count] = await Promise.all([
          adminPool.query(
            `SELECT id, created_at, event_type, request_id, api_key_prefix, user_id, end_user,
                    model, provider, deployment_id, input_tokens, output_tokens, cost,
                    duration_ms, is_error, error_type, requester_ip, session_id, team_id, org_id,
                    risk_level, row_hash
               FROM mcp_immutable_audit_log
               ${where}
               ORDER BY id DESC
               LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset],
          ),
          adminPool.query(`SELECT count(*)::int AS n FROM mcp_immutable_audit_log ${where}`, params),
        ]);

        // Aggregate stats for sidebar/header
        const stats = await adminPool.query(
          `SELECT
              count(*)::int AS total,
              count(*) FILTER (WHERE is_error)::int AS errors,
              count(DISTINCT api_key_prefix)::int AS unique_keys,
              count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS unique_users,
              sum(input_tokens + output_tokens)::bigint AS total_tokens,
              sum(cost)::numeric(14, 6) AS total_cost
            FROM mcp_immutable_audit_log
            ${where}`,
          params,
        );

        res.json({
          entries: list.rows,
          total:   count.rows[0]?.n ?? 0,
          stats:   stats.rows[0] ?? {},
          limit,
          offset,
        });
      } catch (err) {
        logger.error({ err }, 'GET /api/admin/audit-log failed');
        res.status(500).json({ error: 'Failed to query audit log' });
      }
    });

    // ── Coding Workflow Approval Audit Trail (read-only) ──
    // Persisted by the /api/coding/threads/:id/resume handler. Each row
    // is who-approved-what-when-and-why for one human-in-the-loop gate
    // (code_approval = Stage 1, functional_approval = Stage 2).
    app.get('/api/admin/agent-approvals', requireAdmin, async (req, res) => {
      try {
        const q = req.query as Record<string, string | undefined>;
        const limit  = Math.min(parseInt(q['limit']  ?? '100', 10) || 100, 500);
        const offset = Math.max(parseInt(q['offset'] ?? '0',   10) || 0, 0);

        const conds: string[] = [];
        const params: unknown[] = [];
        const push = (sql: string, val: unknown): void => {
          params.push(val);
          conds.push(sql.replace('?', `$${params.length}`));
        };
        if (q['ticket_id'])         push('ticket_id = ?',          q['ticket_id']);
        if (q['gate_type'])         push('gate_type = ?',          q['gate_type']);
        if (q['approver_user_id'])  push('approver_user_id = ?',   parseInt(q['approver_user_id']!, 10));
        if (q['approved'] === 'true')  push('approved = ?', true);
        if (q['approved'] === 'false') push('approved = ?', false);
        if (q['no_rationale'] === 'true') conds.push("rationale = ''");
        if (q['from']) push('created_at >= ?', q['from']);
        if (q['to'])   push('created_at <= ?', q['to']);

        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const list = await adminPool.query(
          `SELECT id, created_at, thread_id, ticket_id, workflow_type, gate_type, approved,
                  approver_user_id, approver_username, approver_ip, rationale,
                  branch_name, commit_sha, retry_count, row_hash
             FROM mcp_agent_approvals
             ${where}
             ORDER BY id DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        );
        const count = await adminPool.query(
          `SELECT count(*)::int AS n FROM mcp_agent_approvals ${where}`,
          params,
        );
        const stats = await adminPool.query(
          `SELECT
              count(*)::int AS total,
              count(*) FILTER (WHERE approved)::int AS approved_count,
              count(*) FILTER (WHERE NOT approved)::int AS rejected_count,
              count(*) FILTER (WHERE rationale = '')::int AS missing_rationale,
              count(DISTINCT approver_user_id) FILTER (WHERE approver_user_id IS NOT NULL)::int AS unique_approvers,
              count(DISTINCT ticket_id)        FILTER (WHERE ticket_id IS NOT NULL)::int AS unique_tickets
            FROM mcp_agent_approvals ${where}`,
          params,
        );
        res.json({
          entries: list.rows,
          total:   count.rows[0]?.n ?? 0,
          stats:   stats.rows[0] ?? {},
          limit,
          offset,
        });
      } catch (err) {
        logger.error({ err }, 'GET /api/admin/agent-approvals failed');
        res.status(500).json({ error: 'Failed to query approvals' });
      }
    });

    // Verify the tamper-evident audit hash-chain (P1.1)
    app.get('/api/admin/audit-log/verify', requireAdmin, async (req, res) => {
      try {
        const q = req.query as Record<string, string | undefined>;
        const limit = q['limit'] ? parseInt(q['limit'], 10) : undefined;
        const { verifyAuditChain } = await import('./audit/immutableAudit.js');
        const result = await verifyAuditChain(adminPool, limit);
        res.json(result);
      } catch (err) {
        logger.error({ err }, 'GET /api/admin/audit-log/verify failed');
        res.status(500).json({ error: 'Failed to verify audit chain' });
      }
    });

    // Distinct values for filter dropdowns
    app.get('/api/admin/audit-log/facets', requireAdmin, async (_req, res) => {
      try {
        const { rows } = await adminPool.query(
          `SELECT
              array_agg(DISTINCT event_type)              FILTER (WHERE event_type IS NOT NULL)     AS event_types,
              array_agg(DISTINCT model)                   FILTER (WHERE model IS NOT NULL)          AS models,
              array_agg(DISTINCT risk_level)              FILTER (WHERE risk_level IS NOT NULL)     AS risk_levels,
              array_agg(DISTINCT api_key_prefix)          FILTER (WHERE api_key_prefix IS NOT NULL) AS api_keys
            FROM mcp_immutable_audit_log`,
        );
        res.json(rows[0] ?? {});
      } catch (err) {
        logger.error({ err }, 'GET /api/admin/audit-log/facets failed');
        res.status(500).json({ error: 'Failed to query facets' });
      }
    });

    // ── PII Redaction settings (read + write) ──
    // GET returns current effective settings + detector catalogue.
    // POST updates one or more settings and invalidates the cache so the
    // next trace uses the new values without restart.
    app.get('/api/admin/settings/pii-redaction', requireAdmin, async (_req, res) => {
      try {
        const { ensureSettingsLoaded, listDetectors } = await import('./lib/redaction.js');
        const s = await ensureSettingsLoaded();
        res.json({
          enabled:    s.enabled,
          detectors:  [...s.detectors],
          log_level:  s.logLevel,
          available:  listDetectors(),
        });
      } catch (err) {
        logger.error({ err }, 'GET pii-redaction settings failed');
        res.status(500).json({ error: 'Failed to load settings' });
      }
    });

    app.post('/api/admin/settings/pii-redaction', requireAdmin, async (req, res) => {
      try {
        const body = req.body as { enabled?: boolean; detectors?: string[]; log_level?: string };
        const { listDetectors, invalidateRedactionCache } = await import('./lib/redaction.js');
        const available = new Set(listDetectors());

        // Validate
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
          res.status(400).json({ error: '"enabled" must be a boolean' }); return;
        }
        if (body.detectors !== undefined) {
          if (!Array.isArray(body.detectors)) {
            res.status(400).json({ error: '"detectors" must be an array of strings' }); return;
          }
          const unknown = body.detectors.filter(d => !available.has(d as ReturnType<typeof listDetectors>[number]));
          if (unknown.length) {
            res.status(400).json({ error: `Unknown detector(s): ${unknown.join(', ')}`, available: [...available] });
            return;
          }
        }
        if (body.log_level !== undefined && !['silent', 'count', 'verbose'].includes(body.log_level)) {
          res.status(400).json({ error: '"log_level" must be one of: silent, count, verbose' }); return;
        }

        // Capture user for audit log + updated_by
        const user = (req as unknown as { user?: { id?: number; username?: string } }).user;
        const userId = user?.id ?? null;
        const username = user?.username ?? 'system';

        // Load previous values for audit-log diff
        const { rows: oldRows } = await adminPool.query<{ key: string; value: unknown }>(
          `SELECT key, value FROM mcp_platform_settings WHERE category = 'pii_redaction'`,
        );
        const oldMap = Object.fromEntries(oldRows.map(r => [r.key, r.value]));

        // Apply each field
        const updates: Array<{ key: string; value: unknown }> = [];
        if (body.enabled !== undefined)   updates.push({ key: 'enabled',   value: body.enabled });
        if (body.detectors !== undefined) updates.push({ key: 'detectors', value: body.detectors });
        if (body.log_level !== undefined) updates.push({ key: 'log_level', value: body.log_level });

        for (const u of updates) {
          await adminPool.query(
            `INSERT INTO mcp_platform_settings (category, key, value, updated_by, updated_at)
             VALUES ('pii_redaction', $1, $2::jsonb, $3, now())
             ON CONFLICT (category, key) DO UPDATE
                SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [u.key, JSON.stringify(u.value), userId],
          );
        }

        // Force cache reload so next trace uses new values
        invalidateRedactionCache();

        // Audit log: every toggle is recorded with old/new value and admin user
        const { writeAuditEntry } = await import('./lib/audit.js');
        writeAuditEntry({
          apiKeyPrefix: `admin__${username}`,
          tool:         'admin.pii_redaction.update',
          parameters:   {
            updates: updates.map(u => ({
              key: u.key,
              old: oldMap[u.key] ?? null,
              new: u.value,
            })),
          },
          durationMs:   0,
          resultSize:   0,
          isError:      false,
        }).catch(() => { /* best effort */ });

        res.json({ ok: true, applied: updates.length });
      } catch (err) {
        logger.error({ err }, 'POST pii-redaction settings failed');
        res.status(500).json({ error: 'Failed to update settings' });
      }
    });

    // ── Composite MCP Server CRUD ────────────────────────────────

    app.get('/api/admin/composites', requireAuth, requireAdmin, async (_req, res) => {
      try {
        const tableCheck = await adminPool.query(
          `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'mcp_composites') AS exists`
        );
        if (!tableCheck.rows[0]?.exists) { res.json([]); return; }
        const { rows } = await adminPool.query(`
          SELECT c.*,
            COALESCE(
              (SELECT json_agg(json_build_object('id', a.id, 'name', a.name, 'agent_mode', a.agent_mode))
               FROM mcp_agents a WHERE a.composite_id = c.id),
              '[]'::json
            ) AS using_agents
          FROM mcp_composites c
          ORDER BY c.name
        `);
        res.json(rows);
      } catch (err) {
        logger.error({ err }, 'Failed to list composites');
        res.status(500).json({ error: 'Failed to list composites' });
      }
    });

    app.post('/api/admin/composites', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { name, description, included_bundle_ids, tool_allow_patterns, tool_deny_patterns, system_prompt, agent_role, enabled } = req.body;
        if (!name || !/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'Name darf nur Kleinbuchstaben, Zahlen, _ und - enthalten' });
          return;
        }
        const { rows } = await adminPool.query(
          `INSERT INTO mcp_composites (name, description, included_bundle_ids, tool_allow_patterns, tool_deny_patterns, system_prompt, agent_role, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [name, description ?? '', included_bundle_ids ?? [], tool_allow_patterns ?? [], tool_deny_patterns ?? [],
           system_prompt ?? null, agent_role ?? null, enabled ?? true],
        );
        logger.info({ name }, 'Composite MCP endpoint created');
        writeAdminAudit(adminPool, req, 'created', 'mcp_composites', String(rows[0].id), name, null, rows[0]);
        res.status(201).json(rows[0]);
      } catch (err) {
        logger.error({ err }, 'Failed to create composite');
        res.status(500).json({ error: 'Failed to create composite' });
      }
    });

    app.put('/api/admin/composites/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { name, description, included_bundle_ids, tool_allow_patterns, tool_deny_patterns, system_prompt, agent_role, enabled } = req.body;
        const { rows: beforeRows } = await adminPool.query('SELECT * FROM mcp_composites WHERE id=$1', [req.params.id]);
        const { rows } = await adminPool.query(
          `UPDATE mcp_composites SET name=$1, description=$2, included_bundle_ids=$3, tool_allow_patterns=$4,
           tool_deny_patterns=$5, system_prompt=$6, agent_role=$7, enabled=$8 WHERE id=$9 RETURNING *`,
          [name, description ?? '', included_bundle_ids ?? [], tool_allow_patterns ?? [], tool_deny_patterns ?? [],
           system_prompt ?? null, agent_role ?? null, enabled ?? true, req.params.id],
        );
        if (rows.length === 0) { res.status(404).json({ error: 'Composite not found' }); return; }
        logger.info({ id: req.params.id }, 'Composite MCP endpoint updated');
        writeAdminAudit(adminPool, req, 'updated', 'mcp_composites', String(rows[0].id), rows[0].name, beforeRows[0] ?? null, rows[0]);
        res.json(rows[0]);
      } catch (err) {
        logger.error({ err }, 'Failed to update composite');
        res.status(500).json({ error: 'Failed to update composite' });
      }
    });

    app.delete('/api/admin/composites/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { rows: beforeRows } = await adminPool.query('SELECT * FROM mcp_composites WHERE id=$1', [req.params.id]);
        const { rowCount } = await adminPool.query('DELETE FROM mcp_composites WHERE id = $1', [req.params.id]);
        if (rowCount === 0) { res.status(404).json({ error: 'Composite not found' }); return; }
        logger.info({ id: req.params.id }, 'Composite MCP endpoint deleted');
        writeAdminAudit(adminPool, req, 'deleted', 'mcp_composites', String(req.params.id), beforeRows[0]?.name ?? null, beforeRows[0] ?? null, null);
        res.json({ deleted: true });
      } catch (err) {
        logger.error({ err }, 'Failed to delete composite');
        res.status(500).json({ error: 'Failed to delete composite' });
      }
    });

    // P2.3: record RBAC policy changes in the tamper-evident audit log.
    // Written at the route boundary where the acting admin (req.user) is known —
    // avoids threading the actor through every store mutation. model/api_key_prefix
    // are NOT NULL placeholders (this is a non-LLM governance event).
    const auditPolicyChange = (req: unknown, detail: string): void => {
      const u = (req as { user?: { id?: number; username?: string } }).user;
      writeImmutableAudit(adminPool, {
        eventType: 'policy_updated',
        apiKeyPrefix: u?.username ? 'admin:' + u.username : 'admin',
        model: 'rbac-policy',
        userId: u?.id ?? null,
        errorType: detail.slice(0, 200),
        riskLevel: 'medium',
      });
    };

    // ── Per-user policy management ──────────────────────────────────
    app.get('/api/admin/users/:id/policies', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { listUserPolicies } = await import('./auth/userPolicyStore.js');
        res.json(await listUserPolicies(adminPool, Number(req.params['id'])));
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list policies' });
      }
    });

    app.put('/api/admin/users/:id/composites', requireAuth, requireAdmin, async (req, res) => {
      try {
        const compositeIds: number[] = Array.isArray(req.body?.composite_ids) ? req.body.composite_ids.map(Number) : [];
        const { setUserCompositesAudited } = await import('./auth/userPolicyStore.js');
        const grantedBy = (req as unknown as { user?: { id?: number } }).user?.id;
        const result = await setUserCompositesAudited(
          adminPool, Number(req.params['id']), compositeIds, grantedBy,
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        if (!result.replayed) auditPolicyChange(req, 'user:' + req.params['id'] + ':composites=[' + compositeIds.join(',') + ']');
        res.json({ updated: true });
      } catch (err) {
        if (err instanceof AccessPolicyError || err instanceof UserLifecycleError) {
          res.status(err.status).json({ error: err.message, code: err.code }); return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update composites' });
      }
    });

    app.post('/api/admin/users/:id/rules', requireAuth, requireAdmin, async (req, res) => {
      try {
        const rule = req.body as { tool_pattern: string; effect: 'allow' | 'deny'; reason?: string; expires_at?: string | null };
        if (!rule?.tool_pattern || !['allow', 'deny'].includes(rule.effect)) {
          res.status(400).json({ error: 'tool_pattern and effect (allow|deny) required' });
          return;
        }
        const { addUserToolRuleAudited } = await import('./auth/userPolicyStore.js');
        const createdBy = (req as unknown as { user?: { id?: number } }).user?.id;
        const result = await addUserToolRuleAudited(
          adminPool, Number(req.params['id']), rule, createdBy,
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        if (!result.replayed) auditPolicyChange(req, 'user:' + req.params['id'] + ':rule-add:' + rule.effect + ':' + rule.tool_pattern);
        res.status(201).json({ id: result.value });
      } catch (err) {
        if (err instanceof AccessPolicyError || err instanceof UserLifecycleError) {
          res.status(err.status).json({ error: err.message, code: err.code }); return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to add rule' });
      }
    });

    app.delete('/api/admin/user-rules/:ruleId', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { deleteUserToolRuleAudited } = await import('./auth/userPolicyStore.js');
        const result = await deleteUserToolRuleAudited(
          adminPool, Number(req.params['ruleId']),
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        if (!result.replayed) auditPolicyChange(req, 'user-rule:delete:' + req.params['ruleId']);
        res.json({ deleted: true });
      } catch (err) {
        if (err instanceof AccessPolicyError || err instanceof UserLifecycleError) {
          res.status(err.status).json({ error: err.message, code: err.code }); return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete rule' });
      }
    });

    // ── Per-group policy management ─────────────────────────────────
    app.get('/api/admin/groups/:groupName/policies', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { listGroupPolicies } = await import('./auth/userPolicyStore.js');
        res.json(await listGroupPolicies(adminPool, String(req.params['groupName'])));
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list group policies' });
      }
    });

    app.put('/api/admin/groups/:groupName/composites', requireAuth, requireAdmin, async (req, res) => {
      try {
        const compositeIds: number[] = Array.isArray(req.body?.composite_ids) ? req.body.composite_ids.map(Number) : [];
        const { setGroupCompositesAudited } = await import('./auth/userPolicyStore.js');
        const result = await setGroupCompositesAudited(
          adminPool, String(req.params['groupName']), compositeIds,
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        if (!result.replayed) auditPolicyChange(req, 'group:' + req.params['groupName'] + ':composites=[' + compositeIds.join(',') + ']');
        res.json({ updated: true });
      } catch (err) {
        if (err instanceof AccessPolicyError || err instanceof UserLifecycleError) {
          res.status(err.status).json({ error: err.message, code: err.code }); return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update group composites' });
      }
    });

    app.post('/api/admin/groups/:groupName/rules', requireAuth, requireAdmin, async (req, res) => {
      try {
        const rule = req.body as { tool_pattern: string; effect: 'allow' | 'deny'; reason?: string };
        if (!rule?.tool_pattern || !['allow', 'deny'].includes(rule.effect)) {
          res.status(400).json({ error: 'tool_pattern and effect (allow|deny) required' });
          return;
        }
        const { addGroupToolRuleAudited } = await import('./auth/userPolicyStore.js');
        const result = await addGroupToolRuleAudited(
          adminPool, String(req.params['groupName']), rule,
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        if (!result.replayed) auditPolicyChange(req, 'group:' + req.params['groupName'] + ':rule-add:' + rule.effect + ':' + rule.tool_pattern);
        res.status(201).json({ id: result.value });
      } catch (err) {
        if (err instanceof AccessPolicyError || err instanceof UserLifecycleError) {
          res.status(err.status).json({ error: err.message, code: err.code }); return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to add group rule' });
      }
    });

    app.delete('/api/admin/group-rules/:ruleId', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { deleteGroupToolRuleAudited } = await import('./auth/userPolicyStore.js');
        const result = await deleteGroupToolRuleAudited(
          adminPool, Number(req.params['ruleId']),
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        if (!result.replayed) auditPolicyChange(req, 'group-rule:delete:' + req.params['ruleId']);
        res.json({ deleted: true });
      } catch (err) {
        if (err instanceof AccessPolicyError || err instanceof UserLifecycleError) {
          res.status(err.status).json({ error: err.message, code: err.code }); return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete group rule' });
      }
    });

    // ── Per-user agent-access management ────────────────────────────
    app.get('/api/admin/users/:id/agents', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { getUserAgentRules } = await import('./auth/userPolicyStore.js');
        const rows = await getUserAgentRules(adminPool, Number(req.params['id']));
        res.json({ agentIds: rows.filter(r => r.effect === 'allow').map(r => r.agent_id) });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get user agent rules' });
      }
    });

    app.put('/api/admin/users/:id/agents', requireAuth, requireAdmin, async (req, res) => {
      try {
        const agentIds: number[] = Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(Number) : [];
        const { setUserAgentAllowAudited } = await import('./auth/userPolicyStore.js');
        const adminUsername = (req as unknown as { user?: { username?: string } }).user?.username;
        const result = await setUserAgentAllowAudited(
          adminPool, Number(req.params['id']), agentIds, 'admin:' + (adminUsername ?? 'unknown'),
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        if (!result.replayed) auditPolicyChange(req, 'user:' + req.params['id'] + ':agents=[' + agentIds.join(',') + ']');
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof AccessPolicyError || err instanceof UserLifecycleError) {
          res.status(err.status).json({ error: err.message, code: err.code }); return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update user agent rules' });
      }
    });

    // ── Per-group agent-access management ───────────────────────────
    app.get('/api/admin/groups/:groupName/agents', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { getGroupAgentRules } = await import('./auth/userPolicyStore.js');
        const rows = await getGroupAgentRules(adminPool, String(req.params['groupName']));
        res.json({ agentIds: rows.filter(r => r.effect === 'allow').map(r => r.agent_id) });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get group agent rules' });
      }
    });

    app.put('/api/admin/groups/:groupName/agents', requireAuth, requireAdmin, async (req, res) => {
      try {
        const agentIds: number[] = Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(Number) : [];
        const { setGroupAgentAllowAudited } = await import('./auth/userPolicyStore.js');
        const result = await setGroupAgentAllowAudited(
          adminPool, String(req.params['groupName']), agentIds,
          buildUserLifecycleAuditContext(req, (req as AuthenticatedRequest).user!),
        );
        if (!result.replayed) auditPolicyChange(req, 'group:' + req.params['groupName'] + ':agents=[' + agentIds.join(',') + ']');
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof AccessPolicyError || err instanceof UserLifecycleError) {
          res.status(err.status).json({ error: err.message, code: err.code }); return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update group agent rules' });
      }
    });

    // ── Public Widgets Admin CRUD ───────────────────────────────────
    //
    // Slug validation: ^[a-z0-9_-]+$
    // Agent validation: agent must exist and have visibility='public'
    // Every mutation is recorded in the immutable audit log as 'policy_updated'.

    app.get('/api/admin/public-widgets', requireAuth, requireAdmin, async (_req, res) => {
      if (!adminPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
      try {
        const widgets = await listWidgets(adminPool);
        res.json({ widgets });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list widgets' });
      }
    });

    app.post('/api/admin/public-widgets', requireAuth, requireAdmin, async (req, res) => {
      if (!adminPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
      try {
        const body = req.body as {
          slug?: string; agent_id?: number; allowed_origins?: string[];
          enabled?: boolean; greeting?: string | null; accent?: string | null;
          rate_limit_per_ip?: number; daily_token_cap?: number;
        };
        if (!body?.slug || !/^[a-z0-9_-]+$/.test(body.slug)) {
          res.status(400).json({ error: 'slug muss ^[a-z0-9_-]+$ matchen' });
          return;
        }
        if (!body.agent_id) {
          res.status(400).json({ error: 'agent_id ist erforderlich' });
          return;
        }
        // Validate agent visibility='public'
        const { rows: agRows } = await adminPool.query<{ visibility: string }>(
          `SELECT visibility FROM mcp_agents WHERE id=$1 AND enabled=true`, [body.agent_id],
        );
        if (!agRows[0]) {
          res.status(400).json({ error: 'Agent nicht gefunden oder deaktiviert' });
          return;
        }
        if (agRows[0].visibility !== 'public') {
          res.status(400).json({ error: 'Agent muss visibility=public haben' });
          return;
        }
        const u = (req as unknown as { user?: { id?: number; username?: string } }).user;
        const widget = await createWidget(adminPool, {
          agent_id: body.agent_id,
          slug: body.slug,
          allowed_origins: Array.isArray(body.allowed_origins) ? body.allowed_origins : [],
          enabled: body.enabled ?? true,
          greeting: body.greeting ?? null,
          accent: body.accent ?? null,
          rate_limit_per_ip: body.rate_limit_per_ip ?? 20,
          daily_token_cap: body.daily_token_cap ?? 50000,
          created_by: u?.id ?? null,
        });
        writeImmutableAudit(adminPool, {
          eventType: 'policy_updated',
          apiKeyPrefix: u?.username ? 'admin:' + u.username : 'admin',
          model: 'public-widget',
          userId: u?.id ?? null,
          errorType: ('widget-create:' + widget.slug).slice(0, 200),
          riskLevel: 'medium',
        });
        res.status(201).json({ widget });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('unique') || msg.includes('duplicate') || msg.toLowerCase().includes('slug')) {
          res.status(409).json({ error: 'Slug bereits vergeben' });
        } else {
          res.status(500).json({ error: msg });
        }
      }
    });

    app.put('/api/admin/public-widgets/:id', requireAuth, requireAdmin, async (req, res) => {
      if (!adminPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
      try {
        const id = Number(req.params['id']);
        const body = req.body as {
          slug?: string; agent_id?: number; allowed_origins?: string[];
          enabled?: boolean; greeting?: string | null; accent?: string | null;
          rate_limit_per_ip?: number; daily_token_cap?: number;
        };
        if (body.slug !== undefined && !/^[a-z0-9_-]+$/.test(body.slug)) {
          res.status(400).json({ error: 'slug muss ^[a-z0-9_-]+$ matchen' });
          return;
        }
        if (body.agent_id !== undefined) {
          const { rows: agRows } = await adminPool.query<{ visibility: string }>(
            `SELECT visibility FROM mcp_agents WHERE id=$1 AND enabled=true`, [body.agent_id],
          );
          if (!agRows[0]) {
            res.status(400).json({ error: 'Agent nicht gefunden oder deaktiviert' });
            return;
          }
          if (agRows[0].visibility !== 'public') {
            res.status(400).json({ error: 'Agent muss visibility=public haben' });
            return;
          }
        }
        const patch: Parameters<typeof updateWidget>[2] = {};
        if (body.slug             !== undefined) patch.slug             = body.slug;
        if (body.allowed_origins  !== undefined) patch.allowed_origins  = body.allowed_origins;
        if (body.enabled          !== undefined) patch.enabled          = body.enabled;
        if (body.greeting         !== undefined) patch.greeting         = body.greeting;
        if (body.accent           !== undefined) patch.accent           = body.accent;
        if (body.rate_limit_per_ip !== undefined) patch.rate_limit_per_ip = body.rate_limit_per_ip;
        if (body.daily_token_cap  !== undefined) patch.daily_token_cap  = body.daily_token_cap;
        const widget = await updateWidget(adminPool, id, patch);
        const u = (req as unknown as { user?: { id?: number; username?: string } }).user;
        writeImmutableAudit(adminPool, {
          eventType: 'policy_updated',
          apiKeyPrefix: u?.username ? 'admin:' + u.username : 'admin',
          model: 'public-widget',
          userId: u?.id ?? null,
          errorType: ('widget-update:' + id).slice(0, 200),
          riskLevel: 'medium',
        });
        res.json({ widget });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          res.status(404).json({ error: 'Widget nicht gefunden' });
        } else if (msg.includes('unique') || msg.includes('duplicate')) {
          res.status(409).json({ error: 'Slug bereits vergeben' });
        } else {
          res.status(500).json({ error: msg });
        }
      }
    });

    app.delete('/api/admin/public-widgets/:id', requireAuth, requireAdmin, async (req, res) => {
      if (!adminPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
      try {
        const id = Number(req.params['id']);
        await deletePublicWidget(adminPool, id);
        const u = (req as unknown as { user?: { id?: number; username?: string } }).user;
        writeImmutableAudit(adminPool, {
          eventType: 'policy_updated',
          apiKeyPrefix: u?.username ? 'admin:' + u.username : 'admin',
          model: 'public-widget',
          userId: u?.id ?? null,
          errorType: ('widget-delete:' + id).slice(0, 200),
          riskLevel: 'medium',
        });
        res.json({ deleted: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          res.status(404).json({ error: 'Widget nicht gefunden' });
        } else {
          res.status(500).json({ error: msg });
        }
      }
    });

    // ── Effective permissions per user ──────────────────────────────
    app.get('/api/admin/users/:id/effective-permissions', requireAuth, requireAdmin, async (req, res) => {
      try {
        const userId = Number(req.params['id']);
        const { rows: u } = await adminPool.query<{ entra_groups: string[] }>(
          'SELECT entra_groups FROM mcp_users WHERE id = $1', [userId],
        );
        if (u.length === 0) { res.status(404).json({ error: 'User not found' }); return; }

        const { fetchUserPolicyData } = await import('./auth/userPolicyStore.js');
        const data = await fetchUserPolicyData(adminPool, userId, u[0]!.entra_groups ?? []);

        res.json({
          user_id: userId,
          groups: u[0]!.entra_groups,
          has_user_composites: data.hasUserComposites,
          has_group_composites: data.hasGroupComposites,
          user_composite_allow_patterns: data.userCompositeAllowPatterns,
          user_composite_deny_patterns: data.userCompositeDenyPatterns,
          group_composite_allow_patterns: data.groupCompositeAllowPatterns,
          group_composite_deny_patterns: data.groupCompositeDenyPatterns,
          user_allow_rules: data.userAllowRules,
          user_deny_rules: data.userDenyRules,
          group_allow_rules: data.groupAllowRules,
          group_deny_rules: data.groupDenyRules,
          legacy_fallback_active:
            data.legacyAllowedBundleTools !== null &&
            !data.hasUserComposites && !data.hasGroupComposites &&
            data.userAllowRules.length === 0 && data.userDenyRules.length === 0 &&
            data.groupAllowRules.length === 0 && data.groupDenyRules.length === 0,
          legacy_allowed_tools: data.legacyAllowedBundleTools,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to resolve' });
      }
    });

    // ── Agent Gateway — Admin CRUD ──────────────────────────────

    // Agent CRUD
    app.get('/api/admin/agent-templates', requireAuth, requireAdmin, async (_req, res) => {
      try {
        res.json(await listAgentTemplates(adminPool));
      } catch (err) {
        logger.error({ err }, 'Failed to list agent templates');
        res.status(500).json({ error: 'Failed to list agent templates' });
      }
    });

    app.get('/api/admin/agent-template-drafts', requireAuth, requireAdmin, async (_req, res) => {
      try {
        res.json(await listAgentTemplateDrafts(adminPool));
      } catch (err) {
        logger.error({ err }, 'Failed to list agent template drafts');
        res.status(500).json({ error: 'Failed to list agent template drafts' });
      }
    });

    app.put('/api/admin/agent-template-drafts/:name', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
      try {
        const name = String(req.params['name'] ?? '');
        if (!/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'Invalid agent template draft name' });
          return;
        }
        const user = (req as unknown as { user?: { id?: number } }).user;
        const draft = await saveAgentTemplateDraft(adminPool, { ...req.body, name }, user?.id);
        writeAdminAudit(adminPool, req, 'saved', 'mcp_agent_template_drafts', name, draft.definition.label, null, {
          baseVersion: draft.baseVersion,
          targetVersion: draft.targetVersion,
        });
        res.json(draft);
      } catch (err) {
        if (err instanceof AgentTemplateInstallError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to save agent template draft');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save agent template draft' });
      }
    });

    app.delete('/api/admin/agent-template-drafts/:name', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
      try {
        const name = String(req.params['name'] ?? '');
        await deleteAgentTemplateDraft(adminPool, name);
        writeAdminAudit(adminPool, req, 'deleted', 'mcp_agent_template_drafts', name, name, null, null);
        res.json({ deleted: true });
      } catch (err) {
        if (err instanceof AgentTemplateInstallError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to delete agent template draft');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete agent template draft' });
      }
    });

    app.post('/api/admin/agent-template-drafts/:name/preview', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
      try {
        const name = String(req.params['name'] ?? '');
        res.json(await previewAgentTemplateDraft(adminPool, name, {
          model: typeof req.body?.model === 'string' ? req.body.model : '',
          runtimeProfileId: req.body?.runtimeProfileId ?? null,
          bundleIds: Array.isArray(req.body?.bundleIds) ? req.body.bundleIds : [],
        }));
      } catch (err) {
        if (err instanceof AgentTemplateInstallError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to preview agent template draft');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to preview agent template draft' });
      }
    });

    app.post('/api/admin/agent-template-drafts/:name/publish', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
      try {
        const name = String(req.params['name'] ?? '');
        const template = await publishAgentTemplateDraft(adminPool, name);
        writeAdminAudit(adminPool, req, 'published', 'mcp_agent_templates', name, template.label, null, { version: template.version });
        res.json(template);
      } catch (err) {
        if (err instanceof AgentTemplateInstallError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to publish agent template draft');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to publish agent template draft' });
      }
    });

    app.post('/api/admin/agent-templates/:name/preview', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
      try {
        const name = String(req.params['name'] ?? '');
        if (!/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'Invalid agent template name' });
          return;
        }
        const previewInput = {
          model: typeof req.body?.model === 'string' ? req.body.model : '',
          runtimeProfileId: req.body?.runtimeProfileId ?? null,
          bundleIds: Array.isArray(req.body?.bundleIds) ? req.body.bundleIds : [],
        };
        res.json(await previewAgentTemplate(adminPool, name, previewInput));
      } catch (err) {
        logger.error({ err }, 'Failed to preview agent template');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to preview agent template' });
      }
    });

    app.get('/api/admin/agent-templates/:name/upgrade-preview', requireAuth, requireAdmin, async (req, res) => {
      try {
        const name = String(req.params['name'] ?? '');
        if (!/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'Invalid agent template name' });
          return;
        }
        const rawAgentId = req.query['agentId'];
        const agentId = rawAgentId == null || rawAgentId === '' ? undefined : Number(rawAgentId);
        if (agentId !== undefined && (!Number.isSafeInteger(agentId) || agentId <= 0)) {
          res.status(400).json({ error: 'Invalid installed agent ID' });
          return;
        }
        res.json(await previewAgentTemplateUpgrade(adminPool, name, agentId));
      } catch (err) {
        if (err instanceof AgentTemplateInstallError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to preview agent template upgrade');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to preview agent template upgrade' });
      }
    });

    app.post('/api/admin/agent-templates/:name/upgrade', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
      try {
        const name = String(req.params['name'] ?? '');
        if (!/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'Invalid agent template name' });
          return;
        }
        const rawAgentId = req.body?.agentId;
        const agentId = rawAgentId == null || rawAgentId === '' ? undefined : Number(rawAgentId);
        if (agentId !== undefined && (!Number.isSafeInteger(agentId) || agentId <= 0)) {
          res.status(400).json({ error: 'Invalid installed agent ID' });
          return;
        }
        const result = await applyAgentTemplateUpgrade(adminPool, name, agentId);
        writeAdminAudit(
          adminPool,
          req,
          'upgraded',
          'mcp_agent_templates',
          name,
          result.agent.label,
          { version: result.preview.installedVersion },
          { version: result.preview.targetVersion, changedFields: result.preview.proposedChanges.map(change => change.field) },
        );
        res.json(result);
      } catch (err) {
        if (err instanceof AgentTemplateInstallError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to apply agent template upgrade');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to apply agent template upgrade' });
      }
    });

    app.post('/api/admin/agent-templates/:name/install', requireAuth, requireAdmin, requireSameOrigin, async (req, res) => {
      try {
        const name = String(req.params['name'] ?? '');
        if (!/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'Invalid agent template name' });
          return;
        }
        const installInput = {
          model: typeof req.body?.model === 'string' ? req.body.model : '',
          runtimeProfileId: req.body?.runtimeProfileId ?? null,
          bundleIds: Array.isArray(req.body?.bundleIds) ? req.body.bundleIds : [],
        };
        const user = (req as unknown as { user?: { id?: number } }).user;
        const agent = await installAgentTemplate(adminPool, name, installInput, user?.id);
        writeAdminAudit(
          adminPool,
          req,
          'installed',
          'mcp_agent_templates',
          name,
          agent.label,
          null,
          {
            agentId: agent.id,
            agentName: agent.name,
            model: agent.model,
            runtimeProfileId: agent.runtime_profile_id,
            bundleIds: agent.bundle_ids ?? [],
          },
        );
        res.status(201).json(agent);
      } catch (err) {
        if (err instanceof AgentTemplateInstallError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        logger.error({ err }, 'Failed to install agent template');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to install agent template' });
      }
    });

    app.get('/api/admin/agents', requireAuth, requireAdmin, async (_req, res) => {
      try {
        const tableCheck = await adminPool.query(
          `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='mcp_agents') AS exists`
        );
        if (!tableCheck.rows[0]?.exists) { res.json([]); return; }
        const agents = await listAgents(adminPool);
        res.json(agents);
      } catch (err) {
        logger.error({ err }, 'Failed to list agents');
        res.status(500).json({ error: 'Failed to list agents' });
      }
    });

    app.get('/api/admin/agents/readiness', requireAuth, requireAdmin, async (_req, res) => {
      try {
        const agents = await listAgents(adminPool);
        const readiness = [];
        // Runtime probes are cached for a few seconds, while sequential
        // evaluation avoids a large Agent catalog creating a DB query burst.
        for (const agent of agents) readiness.push(await assessAgentReadiness(adminPool, agent));
        res.json(readiness);
      } catch (err) {
        logger.error({ err }, 'Failed to evaluate agent readiness');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to evaluate agent readiness' });
      }
    });

    // Runtime profiles choose the execution engine for an Agent. They are
    // intentionally separate from LLM credential profiles and contain no raw
    // Codex/ChatGPT credentials.
    app.get('/api/admin/runtime-profiles', requireAuth, requireAdmin, async (_req, res) => {
      try {
        res.json(await listAgentRuntimeProfiles(adminPool));
      } catch (err) {
        logger.error({ err }, 'Failed to list agent runtime profiles');
        res.status(500).json({ error: 'Failed to list agent runtime profiles' });
      }
    });

    app.post('/api/admin/runtime-profiles', requireAuth, requireAdmin, async (req, res) => {
      try {
        const userId = (req as unknown as { user?: { id?: number } }).user?.id;
        if (!Number.isSafeInteger(userId)) {
          res.status(403).json({ error: 'Authenticated admin identity is required' });
          return;
        }
        const profile = await createAgentRuntimeProfile(adminPool, req.body, userId!);
        writeAdminAudit(adminPool, req, 'created', 'mcp_agent_runtime_profiles', String(profile.id), profile.label, null, profile);
        res.status(201).json(profile);
      } catch (err) {
        const expected = err instanceof AgentRuntimeProfileMutationError;
        if (!expected) logger.error({ err }, 'Failed to create runtime profile');
        res.status(expected ? err.status : 500).json({ error: err instanceof Error ? err.message : 'Failed to create runtime profile' });
      }
    });

    app.put('/api/admin/runtime-profiles/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const result = await updateAgentRuntimeProfile(adminPool, Number(req.params.id), req.body);
        writeAdminAudit(adminPool, req, 'updated', 'mcp_agent_runtime_profiles', String(result.profile.id), result.profile.label, result.before, result.profile);
        res.json(result.profile);
      } catch (err) {
        const expected = err instanceof AgentRuntimeProfileMutationError;
        if (!expected) logger.error({ err }, 'Failed to update runtime profile');
        res.status(expected ? err.status : 500).json({ error: err instanceof Error ? err.message : 'Failed to update runtime profile' });
      }
    });

    app.delete('/api/admin/runtime-profiles/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const profile = await deleteAgentRuntimeProfile(adminPool, Number(req.params.id));
        writeAdminAudit(adminPool, req, 'deleted', 'mcp_agent_runtime_profiles', String(profile.id), profile.label, profile, null);
        res.json({ deleted: true });
      } catch (err) {
        const expected = err instanceof AgentRuntimeProfileMutationError;
        if (!expected) logger.error({ err }, 'Failed to delete runtime profile');
        res.status(expected ? err.status : 500).json({ error: err instanceof Error ? err.message : 'Failed to delete runtime profile' });
      }
    });

    app.patch('/api/admin/runtime-profiles/:id/code-context', requireAuth, requireAdmin, async (req, res) => {
      try {
        const id = Number(req.params.id);
        const result = await updateAgentRuntimeCodeContextPolicy(adminPool, id, req.body);
        const auditState = (profile: typeof result.profile) => ({
          code_context_mode: profile.code_context_mode,
          code_context_max_results: profile.code_context_max_results,
          code_context_max_bytes: profile.code_context_max_bytes,
        });
        writeAdminAudit(
          adminPool,
          req,
          'code_context_policy_updated',
          'mcp_agent_runtime_profiles',
          String(result.profile.id),
          result.profile.label,
          auditState(result.before),
          auditState(result.profile),
        );
        res.json(result.profile);
      } catch (err) {
        const expected = err instanceof AgentRuntimeCodeContextPolicyError;
        if (!expected) logger.error({ err }, 'Failed to update runtime code context policy');
        res.status(expected ? err.status : 500).json({
          error: err instanceof Error ? err.message : 'Failed to update runtime code context policy',
        });
      }
    });

    app.post('/api/admin/agents', requireAuth, requireAdmin, async (req, res) => {
      try {
        const user = (req as unknown as { user?: { id?: number } }).user;
        const { name } = req.body;
        if (!name || !/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'Name darf nur Kleinbuchstaben, Zahlen, _ und - enthalten' });
          return;
        }
        const mr = req.body?.min_role;
        if (mr != null && mr !== '' && (typeof mr !== 'string' || !(mr in ROLE_WEIGHTS))) {
          res.status(400).json({ error: 'Ungültige min_role' });
          return;
        }
        const riskLevel = req.body?.risk_level;
        if (riskLevel != null && !['low', 'medium', 'high'].includes(riskLevel)) {
          res.status(400).json({ error: 'Ungültige risk_level' });
          return;
        }
        if (req.body?.human_oversight_required != null && typeof req.body.human_oversight_required !== 'boolean') {
          res.status(400).json({ error: 'human_oversight_required muss boolean sein' });
          return;
        }
        const agent = await createAgent(adminPool, req.body, user?.id);
        res.status(201).json({ ...agent, llm_api_key: agent.llm_api_key ? '********' : null });
      } catch (err) {
        logger.error({ err }, 'Failed to create agent');
        res.status(err instanceof AgentCredentialProfileAssignmentError || err instanceof AgentRuntimeProfileAssignmentError ? err.status : 500)
          .json({ error: err instanceof Error ? err.message : 'Failed to create agent' });
      }
    });

    app.put('/api/admin/agents/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const mr = req.body?.min_role;
        if (mr != null && mr !== '' && (typeof mr !== 'string' || !(mr in ROLE_WEIGHTS))) {
          res.status(400).json({ error: 'Ungültige min_role' });
          return;
        }
        const riskLevel = req.body?.risk_level;
        if (riskLevel != null && !['low', 'medium', 'high'].includes(riskLevel)) {
          res.status(400).json({ error: 'Ungültige risk_level' });
          return;
        }
        if (req.body?.human_oversight_required != null && typeof req.body.human_oversight_required !== 'boolean') {
          res.status(400).json({ error: 'human_oversight_required muss boolean sein' });
          return;
        }
        const agent = await updateAgent(adminPool, Number(req.params.id), req.body);
        res.json(agent);
      } catch (err) {
        logger.error({ err }, 'Failed to update agent');
        res.status(err instanceof AgentCredentialProfileAssignmentError || err instanceof AgentRuntimeProfileAssignmentError
          ? err.status
          : err instanceof Error && err.message.includes('not found') ? 404 : 500)
          .json({ error: err instanceof Error ? err.message : 'Failed to update agent' });
      }
    });

    app.delete('/api/admin/agents/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        await deleteAgent(adminPool, Number(req.params.id));
        res.json({ deleted: true });
      } catch (err) {
        logger.error({ err }, 'Failed to delete agent');
        res.status(err instanceof Error && err.message.includes('not found') ? 404 : 500)
          .json({ error: err instanceof Error ? err.message : 'Failed to delete agent' });
      }
    });

    // ── Entra Agent Identity admin endpoints ──────────────────────────
    app.get('/api/admin/entra/health', requireAuth, requireAdmin, async (_req, res) => {
      const cfg = loadConfig();
      if (!cfg.entraAgentRegistration) { res.json({ enabled: false }); return; }
      const { EntraSidecarClient } = await import('./identity/entra.js');
      const client = new EntraSidecarClient({ sidecarUrl: cfg.entraSidecarUrl, envSlug: cfg.entraEnvSlug });
      const healthy = await client.getHealth();
      res.json({ enabled: true, sidecarUrl: cfg.entraSidecarUrl, healthy });
    });

    app.get('/api/admin/agents/:id/entra-status', requireAuth, requireAdmin, async (req, res) => {
      const { rows } = await adminPool.query<{
        entra_object_id: string | null;
        entra_app_id: string | null;
        entra_blueprint_id: string | null;
        entra_synced_at: string | null;
        entra_sync_error: string | null;
      }>(
        `SELECT entra_object_id, entra_app_id, entra_blueprint_id, entra_synced_at, entra_sync_error
         FROM mcp_agents WHERE id=$1`,
        [Number(req.params['id'])],
      );
      if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
      res.json(rows[0]);
    });

    app.post('/api/admin/agents/:id/entra-resync', requireAuth, requireAdmin, async (req, res) => {
      const cfg = loadConfig();
      if (!cfg.entraAgentRegistration) { res.status(400).json({ error: 'Entra registration disabled' }); return; }

      const agent = await getAgent(adminPool, Number(req.params['id']));
      if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

      if (agent.entra_object_id) {
        res.status(409).json({ error: 'Already synced. Delete agent + recreate to re-provision.' });
        return;
      }

      const { resolveBlueprintId } = await import('./identity/blueprint.js');
      const { EntraSidecarClient } = await import('./identity/entra.js');
      const blueprintId = resolveBlueprintId(agent, cfg.entraBlueprintMap);
      if (!blueprintId) { res.status(400).json({ error: 'No blueprint mapped for this agent_role' }); return; }

      try {
        const client = new EntraSidecarClient({ sidecarUrl: cfg.entraSidecarUrl, envSlug: cfg.entraEnvSlug });
        const sp = await client.createAgentSP({ agentName: agent.name, blueprintId });
        await adminPool.query(
          `UPDATE mcp_agents SET entra_object_id=$1, entra_app_id=$2, entra_blueprint_id=$3,
                                  entra_synced_at=now(), entra_sync_error=NULL
           WHERE id=$4`,
          [sp.objectId, sp.appId, sp.blueprintId, agent.id],
        );
        res.json({ resynced: true, objectId: sp.objectId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await adminPool.query('UPDATE mcp_agents SET entra_sync_error=$1 WHERE id=$2', [msg.slice(0, 500), agent.id]);
        res.status(502).json({ error: msg });
      }
    });

    app.get('/api/admin/agents/:id/sessions', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { rows } = await adminPool.query(
          `SELECT id, agent_id, user_id, created_at, last_active,
                  jsonb_array_length(messages) AS message_count,
                  messages
           FROM mcp_agent_sessions WHERE agent_id=$1 ORDER BY last_active DESC LIMIT 100`,
          [Number(req.params.id)],
        );
        res.json(rows);
      } catch (err) {
        logger.error({ err }, 'Failed to list agent sessions');
        res.status(500).json({ error: 'Failed to list sessions' });
      }
    });

    app.put('/api/admin/agents/:id/rag-indexes', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { rag_index_ids } = req.body;
        if (!Array.isArray(rag_index_ids)) {
          res.status(400).json({ error: 'rag_index_ids must be an array' });
          return;
        }
        await setAgentRagIndexes(adminPool, Number(req.params.id), rag_index_ids);
        const agent = await getAgent(adminPool, Number(req.params.id));
        res.json(agent);
      } catch (err) {
        logger.error({ err }, 'Failed to update agent RAG indexes');
        res.status(500).json({ error: 'Failed to update RAG indexes' });
      }
    });

    // Per-agent tool-hook config (P1.3) — additive/tighten-only. Config can only
    // ADD destructive patterns + LOWER the cost-budget cap; never disables a guard.
    app.get('/api/admin/agents/:id/hook-config', requireAuth, requireAdmin, async (req, res) => {
      try {
        const agentId = Number(req.params.id);
        const { rows } = await adminPool.query(
          'SELECT agent_id, extra_destructive_patterns, max_tool_calls, updated_at FROM mcp_agent_hook_config WHERE agent_id = $1',
          [agentId],
        );
        res.json(rows[0] ?? { agent_id: agentId, extra_destructive_patterns: [], max_tool_calls: null });
      } catch (err) {
        logger.error({ err }, 'Failed to get agent hook config');
        res.status(500).json({ error: 'Failed to get hook config' });
      }
    });

    app.put('/api/admin/agents/:id/hook-config', requireAuth, requireAdmin, async (req, res) => {
      try {
        const agentId = Number(req.params.id);
        const patterns: unknown = req.body?.extra_destructive_patterns ?? [];
        const maxCalls: unknown = req.body?.max_tool_calls ?? null;
        if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) {
          res.status(400).json({ error: 'extra_destructive_patterns must be an array of strings' });
          return;
        }
        for (const p of patterns as string[]) {
          try { new RegExp(p); } catch { res.status(400).json({ error: `Invalid regex pattern: ${String(p).slice(0, 80)}` }); return; }
        }
        if (maxCalls !== null && (!Number.isInteger(maxCalls) || (maxCalls as number) <= 0)) {
          res.status(400).json({ error: 'max_tool_calls must be a positive integer or null' });
          return;
        }
        const { rows } = await adminPool.query(
          `INSERT INTO mcp_agent_hook_config (agent_id, extra_destructive_patterns, max_tool_calls, updated_at)
             VALUES ($1, $2, $3, now())
           ON CONFLICT (agent_id) DO UPDATE SET
             extra_destructive_patterns = EXCLUDED.extra_destructive_patterns,
             max_tool_calls = EXCLUDED.max_tool_calls, updated_at = now()
           RETURNING agent_id, extra_destructive_patterns, max_tool_calls, updated_at`,
          [agentId, patterns, maxCalls],
        );
        res.json(rows[0]);
      } catch (err) {
        logger.error({ err }, 'Failed to update agent hook config');
        res.status(500).json({ error: 'Failed to update hook config' });
      }
    });

    // Provider registry + Knowledge source CRUD
    app.get('/api/admin/rag-providers', requireAuth, requireAdmin, (_req, res) => {
      res.json(listRagProviderDefinitions());
    });

    app.put('/api/admin/agents/:id/code-indexes', requireAuth, requireAdmin, async (req, res) => {
      try {
        const snapshotIds: unknown = req.body?.snapshot_ids;
        if (!Array.isArray(snapshotIds)
          || !snapshotIds.every(id => Number.isSafeInteger(id) && Number(id) > 0)
          || new Set(snapshotIds).size !== snapshotIds.length) {
          res.status(400).json({ error: 'snapshot_ids must be an array of unique positive integers' });
          return;
        }
        await setAgentCodeIndexes(adminPool, Number(req.params.id), snapshotIds as number[]);
        const agent = await getAgent(adminPool, Number(req.params.id));
        res.json(agent);
      } catch (err) {
        logger.error({ err }, 'Failed to update Agent repository knowledge');
        const message = err instanceof Error ? err.message : 'Failed to update repository knowledge';
        res.status(message.includes('not found') ? 422 : 500).json({ error: message });
      }
    });

    app.get('/api/admin/code-indexes', requireAuth, requireAdmin, async (req, res) => {
      try {
        const rawLimit = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : 25;
        const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 25;
        res.json(await listCodeIndexSnapshots(adminPool, limit));
      } catch (err) {
        logger.error({ err }, 'Failed to list native code indexes');
        res.status(500).json({ error: 'Failed to list native code indexes' });
      }
    });

    app.get('/api/admin/rag-indexes', requireAuth, requireAdmin, async (_req, res) => {
      try {
        const tableCheck = await adminPool.query(
          `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='mcp_rag_indexes') AS exists`
        );
        if (!tableCheck.rows[0]?.exists) { res.json([]); return; }
        const indexes = await listRagIndexes(adminPool);
        // Redact api_key before sending to client
        res.json(indexes.map(r => ({ ...r, api_key: r.api_key ? '••••••••' : null })));
      } catch (err) {
        logger.error({ err }, 'Failed to list RAG indexes');
        res.status(500).json({ error: 'Failed to list RAG indexes' });
      }
    });

    app.post('/api/admin/rag-indexes', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { name } = req.body;
        if (!name || !/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'Name darf nur Kleinbuchstaben, Zahlen, _ und - enthalten' });
          return;
        }
        const provider = req.body.provider ?? 'pgvector';
        const input = { ...req.body, provider } as Record<string, unknown>;
        const validationError = validateRagProviderInput(provider, input);
        if (validationError) {
          res.status(400).json({ error: validationError });
          return;
        }
        const ragIndex = await createRagIndex(adminPool, input as unknown as import('./agents/types.js').CreateRagIndexInput);
        res.status(201).json({ ...ragIndex, api_key: ragIndex.api_key ? '••••••••' : null });
      } catch (err) {
        logger.error({ err }, 'Failed to create RAG index');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create RAG index' });
      }
    });

    app.put('/api/admin/rag-indexes/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const id = Number(req.params.id);
        const existing = await getRagIndex(adminPool, id);
        if (!existing) { res.status(404).json({ error: 'RAG index not found' }); return; }
        const provider = req.body.provider ?? existing.provider;
        const merged = {
          ...existing,
          ...req.body,
          provider,
          adapter_config: req.body.adapter_config ?? existing.adapter_config ?? {},
          api_key: req.body.api_key === undefined ? existing.api_key : req.body.api_key,
        } as Record<string, unknown>;
        const validationError = validateRagProviderInput(provider, merged);
        if (validationError) {
          res.status(400).json({ error: validationError });
          return;
        }
        const ragIndex = await updateRagIndex(adminPool, id, req.body);
        res.json({ ...ragIndex, api_key: ragIndex.api_key ? '••••••••' : null });
      } catch (err) {
        logger.error({ err }, 'Failed to update RAG index');
        res.status(err instanceof Error && err.message.includes('not found') ? 404 : 500)
          .json({ error: err instanceof Error ? err.message : 'Failed to update RAG index' });
      }
    });

    app.delete('/api/admin/rag-indexes/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        await deleteRagIndex(adminPool, Number(req.params.id));
        res.json({ deleted: true });
      } catch (err) {
        logger.error({ err }, 'Failed to delete RAG index');
        res.status(err instanceof Error && err.message.includes('not found') ? 404 : 500)
          .json({ error: err instanceof Error ? err.message : 'Failed to delete RAG index' });
      }
    });

    const kbUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
    // Wrap multer so its errors (e.g. file too large) return JSON instead of falling through to
    // Express's default HTML error handler (the route's try/catch can't see middleware errors).
    const kbUploadMw: import('express').RequestHandler = (req, res, next) => {
      kbUpload.array('files', 10)(req, res, (err: unknown) => {
        if (err) {
          const code = (err as { code?: string }).code;
          res.status(code === 'LIMIT_FILE_SIZE' ? 413 : 400)
            .json({ error: err instanceof Error ? err.message : 'upload error' });
          return;
        }
        next();
      });
    };

    app.post('/api/admin/rag-indexes/:id/upload', requireAuth, requireAdmin, kbUploadMw, async (req, res) => {
      try {
        const id = Number(req.params['id']);
        const idx = await getRagIndex(adminPool, id);
        if (!idx) { res.status(404).json({ error: 'RAG index not found' }); return; }
        if (idx.provider !== 'pgvector') { res.status(400).json({ error: 'upload only supported for pgvector knowledge bases' }); return; }
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        if (files.length === 0) { res.status(400).json({ error: 'no files' }); return; }
        // Validate ALL extensions up front so one bad file can't leave earlier files partially committed.
        const allowed = ['txt', 'md', 'pdf'];
        const bad = files.find((f) => !allowed.includes((f.originalname.split('.').pop() ?? '').toLowerCase()));
        if (bad) { res.status(400).json({ error: `unsupported type: ${bad.originalname} (txt, md, pdf only)` }); return; }
        // Ingest per-file, accumulating successes and failures so a bad file doesn't abort the rest
        // (and the client knows exactly which files to retry — no blind whole-batch re-upload).
        const documents: { id: number; name: string; chunkCount: number }[] = [];
        const failed: { name: string; error: string }[] = [];
        for (const f of files) {
          try {
            const r = await ingestDocument(adminPool, id, f.originalname, f.buffer);
            documents.push({ id: r.id, name: f.originalname, chunkCount: r.chunkCount });
          } catch (e) {
            logger.error({ err: e, file: f.originalname }, 'KB ingest failed for file');
            failed.push({ name: f.originalname, error: e instanceof Error ? e.message : 'ingest failed' });
          }
        }
        if (documents.length === 0) { res.status(400).json({ error: failed[0]?.error ?? 'upload failed', failed }); return; }
        res.json({ documents, failed });
      } catch (err) {
        logger.error({ err }, 'KB upload failed');
        res.status(500).json({ error: err instanceof Error ? err.message : 'upload failed' });
      }
    });

    app.get('/api/admin/rag-indexes/:id/documents', requireAuth, requireAdmin, async (req, res) => {
      try {
        res.json(await listKbDocuments(adminPool, Number(req.params['id'])));
      } catch (err) {
        res.status(500).json({ error: 'Failed to list documents' });
      }
    });

    app.delete('/api/admin/rag-indexes/:id/documents/:docId', requireAuth, requireAdmin, async (req, res) => {
      try {
        const deleted = await deleteKbDocument(adminPool, Number(req.params['id']), Number(req.params['docId']));
        if (!deleted) { res.status(404).json({ error: 'Document not found in this knowledge base' }); return; }
        res.json({ deleted: true });
      } catch (err) {
        res.status(500).json({ error: 'Failed to delete document' });
      }
    });

    app.post('/api/admin/rag-indexes/:id/test', requireAuth, requireAdmin, async (req, res) => {
      try {
        const ragIndex = await getRagIndex(adminPool, Number(req.params.id));
        if (!ragIndex) { res.status(404).json({ error: 'RAG index not found' }); return; }
        const query = typeof req.body?.query === 'string' && req.body.query.trim()
          ? req.body.query.trim().slice(0, 2_000)
          : 'test';
        const { searchRagIndex } = await import('./agents/ragSearch.js');
        const results = await searchRagIndex(ragIndex, query, adminPool);
        res.json({ ok: true, query, results_count: results.length, results });
      } catch (err) {
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Connection test failed' });
      }
    });

    // POST /api/admin/rag-indexes/:id/eval — run RAG evaluation (Hit@5) and upload to Langfuse
    app.post('/api/admin/rag-indexes/:id/eval', requireAuth, requireAdmin, async (req, res) => {
      try {
        const ragIndex = await getRagIndex(adminPool, Number(req.params['id']));
        if (!ragIndex) { res.status(404).json({ error: 'RAG index not found' }); return; }
        const sampleSize = Math.min(50, Math.max(5, parseInt(String((req.body as Record<string,unknown>)?.sample_size ?? '10'), 10)));
        const { runRagEval } = await import('./agents/ragEval.js');
        const result = await runRagEval(ragIndex, sampleSize, adminPool);
        res.json(result);
      } catch (err) {
        logger.error({ err }, 'RAG eval endpoint error');
        res.status(500).json({ error: err instanceof Error ? err.message : 'RAG eval failed' });
      }
    });

    // ── Skills CRUD ───────────────────────────────────────────────

    app.get('/api/admin/skills', requireAuth, requireAdmin, async (_req, res) => {
      try {
        const tableCheck = await adminPool.query(
          `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='mcp_skills') AS exists`,
        );
        if (!tableCheck.rows[0]?.exists) { res.json([]); return; }
        const [skills, assignments] = await Promise.all([
          listSkills(adminPool),
          adminPool.query<{
            skill_id: number;
            assigned_agents: Array<{ id: number; name: string; label: string; enabled: boolean }>;
          }>(
            `SELECT assignment.skill_id,
                    jsonb_agg(jsonb_build_object(
                      'id', agent.id,
                      'name', agent.name,
                      'label', agent.label,
                      'enabled', agent.enabled
                    ) ORDER BY agent.label) AS assigned_agents
               FROM mcp_agent_skills assignment
               JOIN mcp_agents agent ON agent.id = assignment.agent_id
              GROUP BY assignment.skill_id`,
          ),
        ]);
        const agentsBySkill = new Map(assignments.rows.map(row => [row.skill_id, row.assigned_agents]));
        res.json(skills.map(skill => ({ ...skill, assigned_agents: agentsBySkill.get(skill.id) ?? [] })));
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list skills' });
      }
    });

    app.post('/api/admin/skills', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { name } = req.body;
        if (!name || !/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'name must match ^[a-z0-9_-]+$' }); return;
        }
        if (!req.body.content) {
          res.status(400).json({ error: 'content is required' }); return;
        }
        const skill = await createSkill(adminPool, req.body);
        writeAdminAudit(adminPool, req, 'created', 'mcp_skills', String(skill.id), skill.label, null, skill);
        res.status(201).json(skill);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to create skill';
        res.status(msg.includes('unique') || msg.includes('duplicate') ? 409 : 500).json({ error: msg });
      }
    });

    // Upsert by name — used by the argus-skills CLI for idempotent sync.
    // Returns { skill, created: boolean }. On `created=false` the existing
    // skill is overwritten with the marketplace version (use --dry-run client-side
    // to preview). Source columns (source_url/source_ref/imported_at) record
    // provenance for DORA audit.
    app.post('/api/admin/skills/upsert', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { name, content } = req.body;
        if (!name || !/^[a-z0-9_-]+$/.test(name)) {
          res.status(400).json({ error: 'name must match ^[a-z0-9_-]+$' }); return;
        }
        if (!content) { res.status(400).json({ error: 'content is required' }); return; }
        const result = await upsertSkillByName(adminPool, req.body);
        res.status(result.created ? 201 : 200).json(result);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Upsert failed' });
      }
    });

    app.put('/api/admin/skills/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const id = Number(req.params.id);
        const before = await getSkill(adminPool, id);
        const skill = await updateSkill(adminPool, id, req.body);
        writeAdminAudit(adminPool, req, 'updated', 'mcp_skills', String(skill.id), skill.label, before, skill);
        res.json(skill);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to update skill';
        res.status(msg.includes('not found') ? 404 : 500).json({ error: msg });
      }
    });

    app.delete('/api/admin/skills/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const id = Number(req.params.id);
        const before = await getSkill(adminPool, id);
        await deleteSkill(adminPool, id);
        writeAdminAudit(adminPool, req, 'deleted', 'mcp_skills', String(id), before?.label ?? null, before, null);
        res.json({ deleted: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to delete skill';
        const status = msg.includes('not found') ? 404 : msg.includes('cannot be deleted') ? 409 : 500;
        res.status(status).json({ error: msg });
      }
    });

    app.put('/api/admin/agents/:id/skills', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { skill_ids } = req.body;
        if (!Array.isArray(skill_ids)) {
          res.status(400).json({ error: 'skill_ids must be an array' }); return;
        }
        await setAgentSkills(adminPool, Number(req.params.id), skill_ids);
        const agent = await getAgent(adminPool, Number(req.params.id));
        res.json(agent);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to set agent skills' });
      }
    });

    // Chat page
    app.get('/agents', requireAuth, async (req, res) => {
      try {
        const user = (req as unknown as { user?: import('./auth/userAuth.js').SessionUser }).user;
        const tableCheck = await adminPool.query(
          `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='mcp_agents') AS exists`
        );
        const agents = tableCheck.rows[0]?.exists ? await listAgents(adminPool) : [];
        const html = renderAgentsHtml(agents.filter(a => a.enabled), user);
        res.send(html);
      } catch (err) {
        logger.error({ err }, 'Failed to render agents page');
        res.status(500).send('Internal server error');
      }
    });

    // Chat surface — slim shell for staff/chat_user role (visibility-filtered)
    app.get(['/chat', '/chat/:agentId'], requireAuth, async (req, res) => {
      try {
        // SPA branch — serve argus-chat-ui when CHAT_SPA_ENABLED=true (classic=1 forces fallback)
        const { shouldServeChatSpa } = await import('./agents/chat/chatSpaServe.js');
        if (shouldServeChatSpa(config.chatSpaEnabled, req.query as Record<string, unknown>)) {
          res.sendFile(path.resolve(process.cwd(), 'argus-chat-ui/dist/index.html'));
          return;
        }

        const u = (req as unknown as { user?: SessionUser }).user;
        const agents = await listChatVisibleAgents(adminPool, u);
        const wanted = typeof req.params['agentId'] === 'string' ? Number(req.params['agentId']) : undefined;
        const activeAgentId = (wanted && agents.some(a => a.id === wanted)) ? wanted : agents[0]?.id;
        res.type('html').send(renderChatShell({ user: u, agents, activeAgentId }));
      } catch (err) {
        logger.error({ err }, 'Failed to render chat page');
        res.status(500).send('Internal server error');
      }
    });

    // Embed surface — bare iframe chat for a single agent (same-origin only)
    app.get('/embed/chat/:agentId', requireAuth, async (req, res) => {
      try {
        const u = (req as unknown as { user?: SessionUser }).user;
        const agentId = typeof req.params['agentId'] === 'string' ? Number(req.params['agentId']) : NaN;
        const agents = await listChatVisibleAgents(adminPool, u);
        const agent = agents.find(a => a.id === agentId);
        if (!agent) {
          res.status(404).type('html').send('<!DOCTYPE html><meta charset="utf-8"><body style="font:14px sans-serif;color:#777;padding:1rem">Agent nicht verfügbar.</body>');
          return;
        }
        res.type('html').send(renderEmbedChat({ agentId, agent: { id: agent.id, label: agent.label } }));
      } catch (err) {
        logger.error({ err }, 'Failed to render embed chat');
        res.status(500).send('Internal server error');
      }
    });

    // AI Agents overview (metrics dashboard)
    // Legacy Agent administration entrypoints are retired; the Console owns
    // these routes. The old renderer remains below only as a bounded rollback
    // implementation and is unreachable in normal routing.
    app.get('/agents/overview', requireAuth, (_req, res) => res.redirect(308, '/build/agents'));
    app.get('/agents/list', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/build/agents/manage'));
    app.get('/agents/rag', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/build/knowledge'));
    app.get('/agents/skills', requireAuth, requireAdmin, (_req, res) => res.redirect(308, '/build/skills'));

    // Provider-neutral model catalog used by the agent-management and chat UIs.
    // Provider credentials stay server-side and are never returned here.
    app.get('/api/models', requireAuth, async (_req, res) => {
      try {
        const { rows } = await adminPool.query<{
          model_name: string;
          provider: string;
          enabled: boolean;
          supports_vision: boolean;
        }>(
          `SELECT model.model_name,
                  COALESCE(provider.provider_type, model.provider) AS provider,
                  (model.enabled AND COALESCE(provider.enabled, true)) AS enabled,
                  model.supports_vision
             FROM mcp_models model
             LEFT JOIN mcp_llm_providers provider ON provider.id=model.provider_id
            ORDER BY model."order", model.model_name`,
        );
        res.json({ data: rows });
      } catch (err) {
        logger.error({ err }, 'Failed to list model catalog');
        res.status(500).json({ error: 'Failed to list models' });
      }
    });

    // Chat session API
    app.get('/api/agents', requireAuth, async (req, res) => {
      try {
        const tableCheck = await adminPool.query(
          `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='mcp_agents') AS exists`
        );
        if (!tableCheck.rows[0]?.exists) { res.json([]); return; }
        // Role/visibility/policy-filtered: a user only enumerates agents they may use.
        const user = (req as unknown as { user?: SessionUser }).user;
        const agents = await listChatVisibleAgents(adminPool, user);
        const runtimeAssignments = await listAgentRuntimeAssignments(adminPool);
        const runtimeByAgent = new Map(runtimeAssignments.map(runtime => [runtime.agent_id, runtime]));
        const { rows: visRows } = await adminPool.query<{ model_name: string; supports_vision: boolean }>(
          'SELECT model_name, supports_vision FROM mcp_models',
        );
        const visMap = new Map(visRows.map((r) => [r.model_name, r.supports_vision]));
        res.json(agents.map(a => {
          const runtime = runtimeByAgent.get(a.id);
          const effectiveModel = runtime?.profile_enabled !== false && runtime?.model ? runtime.model : a.model;
          return {
          id: a.id, name: a.name, label: a.label, description: a.description, model: a.model,
          effective_model: effectiveModel,
          runtime_profile_id: runtime?.profile_id ?? null,
          runtime_label: runtime?.profile_label ?? null,
          runtime_type: runtime?.runtime_type ?? 'argus',
          reasoning_effort: runtime?.reasoning_effort ?? null,
          supports_vision: visMap.get(effectiveModel) ?? visMap.get(a.model) ?? false,
          agent_mode: a.agent_mode,
          risk_level: a.risk_level,
          human_oversight_required: a.human_oversight_required,
          ticket_id: a.ticket_id,
          pr_branch: a.pr_branch,
          pr_number: a.pr_number,
          repository: a.bitbucket_repo ?? a.gitea_project ?? null,
          skills: a.skills?.map(skill => skill.label || skill.name) ?? [],
        };
        }));
      } catch (err) {
        res.status(500).json({ error: 'Failed to list agents' });
      }
    });

    // Enabled platform models for the chat dropdown. Direct provider keys are
    // resolved server-side and do not carry Argus virtual-key model policies.
    app.get('/api/agents/:id/allowed-models', requireAuth, async (req, res) => {
      try {
        const agentId = Number(req.params['id']);
        const amUser = (req as unknown as { user?: SessionUser }).user;
        const access = await agentAccessGate(adminPool, agentId, amUser);
        if (access.verdict === 'not_found') {
          res.status(404).json({ error: 'Agent not found' }); return;
        }
        if (access.verdict === 'forbidden') {
          res.status(404).json({ error: 'Agent not found' }); return;
        }

        // Get all enabled models
        const { rows: allModels } = await adminPool.query<{ model_name: string; provider: string }>(
          `SELECT model.model_name, COALESCE(provider.provider_type, model.provider) AS provider
             FROM mcp_models model
             LEFT JOIN mcp_llm_providers provider ON provider.id=model.provider_id
            WHERE model.enabled = true
              AND COALESCE(provider.enabled, true) = true
            ORDER BY model."order", model.model_name`,
        );

        res.json({ models: allModels, restricted: false });
      } catch (err) {
        logger.error({ err }, 'Failed to get agent allowed models');
        res.status(500).json({ error: 'Failed to get allowed models' });
      }
    });

    app.post('/api/agents/:id/sessions', requireSameOrigin, requireAuth, async (req, res) => {
      try {
        const user = (req as unknown as { user?: SessionUser }).user;
        const agentId = Number(req.params.id);
        const access = await agentAccessGate(adminPool, agentId, user);
        if (access.verdict === 'not_found') { res.status(404).json({ error: 'Agent not found' }); return; }
        if (access.verdict === 'forbidden') { res.status(403).json({ error: 'agent not permitted' }); return; }
        const { randomUUID } = await import('node:crypto');
        const sessionId = randomUUID();
        const session = await createAgentSession(adminPool, agentId, sessionId, user?.id);
        res.status(201).json(session);
      } catch (err) {
        res.status(500).json({ error: 'Failed to create session' });
      }
    });

    app.get('/api/agents/:id/sessions', requireAuth, async (req, res) => {
      try {
        const user = (req as unknown as { user?: SessionUser }).user;
        const access = await agentAccessGate(adminPool, Number(req.params.id), user);
        if (access.verdict !== 'ok') {
          res.status(404).json({ error: 'Agent not found' });
          return;
        }
        const sessions = await listSessions(adminPool, Number(req.params.id), user?.id);
        res.json(sessions);
      } catch (err) {
        res.status(500).json({ error: 'Failed to list sessions' });
      }
    });

    // Owner check: a session must belong to the requesting user OR the user
    // must be admin OR the session is anonymous (user_id=NULL — created by
    // service-account API key, currently world-readable to any session user).
    const sessionOwnedBy = (session: { user_id: number | null }, user: { id: number; role: string } | undefined): boolean => {
      if (!user) return false;
      if (user.role === 'admin') return true;
      if (session.user_id === null) return true;  // service-account session — TODO restrict by API key composite
      return session.user_id === user.id;
    };

    app.get('/api/agents/:id/sessions/:sid', requireAuth, async (req, res) => {
      try {
        const sid = String(req.params.sid);
        const user = (req as unknown as { user?: SessionUser }).user;
        // Pass userId for DB-level IDOR prevention (admins see all sessions)
        const userId = user?.role === 'admin' ? undefined : user?.id;
        const session = await getSession(adminPool, sid, userId);
        if (!session || session.agent_id !== Number(req.params.id)) {
          res.status(404).json({ error: 'Session not found' }); return;
        }
        const access = await agentAccessGate(adminPool, session.agent_id, user);
        if (access.verdict !== 'ok') { res.status(404).json({ error: 'Session not found' }); return; }
        res.json(session);
      } catch (err) {
        res.status(500).json({ error: 'Failed to get session' });
      }
    });

    app.delete('/api/agents/:id/sessions/:sid', requireSameOrigin, requireAuth, async (req, res) => {
      try {
        const sid = String(req.params.sid);
        const user = (req as unknown as { user?: SessionUser }).user;
        const userId = user?.role === 'admin' ? undefined : user?.id;
        const session = await getSession(adminPool, sid, userId);
        if (!session || session.agent_id !== Number(req.params.id)) {
          res.status(404).json({ error: 'Session not found' }); return;
        }
        const access = await agentAccessGate(adminPool, session.agent_id, user);
        if (access.verdict !== 'ok') { res.status(404).json({ error: 'Session not found' }); return; }
        await deleteAgentSession(adminPool, sid, userId);
        res.json({ deleted: true });
      } catch (err) {
        res.status(500).json({ error: 'Failed to delete session' });
      }
    });

    app.post('/api/sessions/:sid/share', requireAuth, requireSameOrigin, async (req, res) => {
      if (!config.shareLinksEnabled) { res.status(404).json({ error: 'sharing disabled' }); return; }
      try {
        const userId = (req as { user?: { id: number } }).user?.id;
        if (!userId) { res.status(401).json({ error: 'auth required' }); return; }
        const { id, token } = await createShare(adminPool, {
          sessionId: String(req.params['sid']), userId,
          expiryDays: Number(req.body?.expiryDays) || 7,
          password: typeof req.body?.password === 'string' && req.body.password ? req.body.password : undefined,
        });
        writeAdminAudit(adminPool, req, 'share_created', 'mcp_shared_conversations', String(id), null);
        const base = `${req.protocol}://${req.get('host')}`;
        res.status(201).json({ id, url: `${base}/share/${token}` });
      } catch (err) {
        if (err instanceof ShareForbiddenError) { res.status(403).json({ error: err.message }); return; }
        logger.error({ err }, 'create share failed');
        res.status(500).json({ error: 'create share failed' });
      }
    });

    app.get('/api/me/shares', requireAuth, async (req, res) => {
      try {
        const userId = (req as { user?: { id: number } }).user?.id;
        if (!userId) { res.status(401).json({ error: 'auth required' }); return; }
        res.json(await listSharesByUser(adminPool, userId));
      } catch (err) { res.status(500).json({ error: 'failed to list shares' }); }
    });

    app.delete('/api/shares/:id', requireAuth, requireSameOrigin, async (req, res) => {
      try {
        const userId = (req as { user?: { id: number } }).user?.id;
        if (!userId) { res.status(401).json({ error: 'auth required' }); return; }
        const ok = await revokeShare(adminPool, Number(req.params['id']), userId);
        if (!ok) { res.status(404).json({ error: 'not found' }); return; }
        writeAdminAudit(adminPool, req, 'share_revoked', 'mcp_shared_conversations', String(req.params['id']), null);
        res.json({ revoked: true });
      } catch (err) { res.status(500).json({ error: 'revoke failed' }); }
    });

    // Agent chat — SSE streaming
    app.post('/api/agents/:id/sessions/:sid/chat', requireSameOrigin, requireAuth, async (req, res) => {
      try {
        const sid = String(req.params.sid);
        const agentId = Number(req.params.id);
        const { message, model_override, attachments, params } = req.body as {
          message: string;
          model_override?: string;
          attachments?: Array<{ name: string; type: string; content?: string; dataUrl?: string; chipType?: string }>;
          params?: { temperature?: number; max_tokens?: number; top_p?: number };
        };
        if (!message || typeof message !== 'string' || !message.trim()) {
          res.status(400).json({ error: 'message ist erforderlich' });
          return;
        }

        const session = await getSession(adminPool, sid);
        if (!session || session.agent_id !== agentId) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        const reqUser = (req as unknown as { user?: SessionUser }).user;
        if (!sessionOwnedBy(session, reqUser)) {
          res.status(403).json({ error: 'Forbidden: session belongs to another user' });
          return;
        }

        // Per-role gate (defence in depth — a session could outlive a role change).
        const chatAccess = await agentAccessGate(adminPool, agentId, reqUser);
        if (chatAccess.verdict === 'not_found') { res.status(404).json({ error: 'Agent not found' }); return; }
        if (chatAccess.verdict === 'forbidden') { res.status(403).json({ error: 'agent not permitted' }); return; }

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const { runAgentChat } = await import('./agents/agentRunner.js');
        // Heartbeat every 25s — prevents proxy/load-balancer 30s idle timeout (OAP 305s disconnect)
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
        // Thread SSO user identity into the runner for per-user policy gate.
        // undefined when the request is API-key authenticated (no session cookie user).
        const callingUser = reqUser ? {
          id: reqUser.id,
          role: reqUser.role,
          entra_groups: reqUser.entra_groups,
          allowed_bundles: reqUser.allowed_bundles,
        } : undefined;
        try {
          // Build enriched message from text attachments only (images routed separately via userImages)
          let enrichedMessage = message.trim();
          if (attachments && attachments.length > 0) {
            const textParts: string[] = [];
            for (const att of attachments) {
              if (att.content) {
                const lang = att.name.split('.').pop() ?? 'text';
                textParts.push(`\n\n---\n📄 **${att.name}**\n\`\`\`${lang}\n${att.content.slice(0, 40_000)}\n\`\`\``);
              }
            }
            if (textParts.length > 0) enrichedMessage += textParts.join('');
          }

          // Validate + collect image attachments, then gate on model vision capability
          // (defence in depth: the SPA disables upload for non-vision agents, but a direct
          // API client could bypass that — the server is the real gate). Error early via SSE.
          let visionImages: { dataUrl: string; name?: string }[] = [];
          try {
            visionImages = collectValidImages(attachments);
            if (visionImages.length > 0) {
              const { getAgent } = await import('./agents/agentStore.js');
              const agentRow = await getAgent(adminPool, agentId);
              const effectiveModel = model_override || agentRow?.model;
              const { rows: visRows } = await adminPool.query<{ supports_vision: boolean }>(
                'SELECT supports_vision FROM mcp_models WHERE model_name = $1',
                [effectiveModel ?? ''],
              );
              assertVisionAllowed(visionImages.length, visRows[0]?.supports_vision ?? false);
            }
          } catch (e) {
            res.write(`data: ${JSON.stringify({ error: String((e as Error).message) })}\n\n`);
            res.write('data: [DONE]\n\n'); res.end(); clearInterval(heartbeat); return;
          }

          // K8s-Impersonation + deep-stack access to callingUser via AsyncLocalStorage
          const { withRequestContext } = await import('./lib/requestContext.js');
          await withRequestContext(
            {
              callingUser: callingUser ? {
                id: callingUser.id,
                username: (callingUser as { username?: string }).username,
                email: (callingUser as { email?: string }).email,
                role: (callingUser as { role?: string }).role,
                entra_groups: callingUser.entra_groups,
              } : undefined,
            },
            async () => {
              const paramOverrides = clampParams(params);
              for await (const chunk of runAgentChat(agentId, sid, enrichedMessage || message.trim(), adminPool, config, model_override, callingUser, undefined, undefined, undefined, true, visionImages, paramOverrides)) {
                res.write(chunk);
              }
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Runner error';
          logger.error({ err }, 'Agent runner error');
          res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
          res.write('data: [DONE]\n\n');
        } finally {
          clearInterval(heartbeat);
        }
        res.end();
      } catch (err) {
        logger.error({ err }, 'Failed to start agent chat');
        if (!res.headersSent) res.status(500).json({ error: 'Failed to start chat' });
      }
    });

    // Regenerate the last assistant turn → a new variant (SSE, same contract as chat)
    app.post('/api/agents/:id/sessions/:sid/regenerate', requireSameOrigin, requireAuth, async (req, res) => {
      const heartbeatRef: { t?: NodeJS.Timeout } = {};
      try {
        const sid = String(req.params['sid']);
        const agentId = Number(req.params['id']);
        const { model_override, params } = req.body as {
          model_override?: string;
          params?: { temperature?: number; max_tokens?: number; top_p?: number };
        };
        const reqUser = (req as unknown as { user?: SessionUser }).user;
        const ownerId = reqUser?.role === 'admin' ? undefined : reqUser?.id;
        const session = await getSession(adminPool, sid, ownerId);
        if (!session || session.agent_id !== agentId) { res.status(404).json({ error: 'Session not found' }); return; }
        if (!sessionOwnedBy(session, reqUser)) { res.status(403).json({ error: 'Forbidden: session belongs to another user' }); return; }
        const gate = await agentAccessGate(adminPool, agentId, reqUser);
        if (gate.verdict === 'not_found') { res.status(404).json({ error: 'Agent not found' }); return; }
        if (gate.verdict === 'forbidden') { res.status(403).json({ error: 'agent not permitted' }); return; }

        // Last user turn on the active branch → the text to re-answer.
        const activePath = resolveActivePath(session.messages ?? [], session.active_leaf_id ?? null);
        const lastUser = [...activePath].reverse().find((m) => m.role === 'user');
        if (!lastUser) { res.status(400).json({ error: 'no user turn to regenerate' }); return; }
        const lastUserText = typeof lastUser.content === 'string' ? lastUser.content : '';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const { runAgentChat } = await import('./agents/agentRunner.js');
        heartbeatRef.t = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
        const callingUser = reqUser ? {
          id: reqUser.id,
          role: reqUser.role,
          entra_groups: reqUser.entra_groups,
          allowed_bundles: reqUser.allowed_bundles,
        } : undefined;
        const paramOverrides = clampParams(params);
        try {
          const { withRequestContext } = await import('./lib/requestContext.js');
          await withRequestContext(
            { callingUser: callingUser ? {
              id: callingUser.id,
              username: (callingUser as { username?: string }).username,
              email: (callingUser as { email?: string }).email,
              role: (callingUser as { role?: string }).role,
              entra_groups: callingUser.entra_groups,
            } : undefined },
            async () => {
              for await (const chunk of runAgentChat(agentId, sid, lastUserText, adminPool, config, model_override, callingUser, undefined, undefined, undefined, true, undefined, paramOverrides, true)) {
                res.write(chunk);
              }
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Runner error';
          logger.error({ err }, 'Regenerate runner error');
          res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
          res.write('data: [DONE]\n\n');
        } finally {
          if (heartbeatRef.t) clearInterval(heartbeatRef.t);
        }
        res.end();
      } catch (err) {
        if (heartbeatRef.t) clearInterval(heartbeatRef.t);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to regenerate' });
      }
    });

    // Switch the visible branch (variant navigation)
    app.patch('/api/agents/:id/sessions/:sid/active-leaf', requireSameOrigin, requireAuth, async (req, res) => {
      try {
        const sid = String(req.params['sid']);
        const agentId = Number(req.params['id']);
        const { leafId } = req.body as { leafId?: string };
        const reqUser = (req as unknown as { user?: SessionUser }).user;
        const ownerId = reqUser?.role === 'admin' ? undefined : reqUser?.id;
        const session = await getSession(adminPool, sid, ownerId);
        if (!session || session.agent_id !== agentId) { res.status(404).json({ error: 'Session not found' }); return; }
        const access = await agentAccessGate(adminPool, agentId, reqUser);
        if (access.verdict !== 'ok') { res.status(404).json({ error: 'Session not found' }); return; }
        if (!leafId || !(session.messages ?? []).some((m) => m.id === leafId)) {
          res.status(400).json({ error: 'unknown leafId' }); return;
        }
        const resolved = leafOf(session.messages ?? [], leafId);
        await setActiveLeaf(adminPool, sid, resolved, ownerId);
        res.json({ active_leaf_id: resolved });
      } catch (err) {
        res.status(500).json({ error: 'Failed to set active leaf' });
      }
    });

    // Edit a past USER message → branch a new user sibling + answer (SSE, same contract as chat)
    app.post('/api/agents/:id/sessions/:sid/messages/:msgId/edit', requireSameOrigin, requireAuth, async (req, res) => {
      const heartbeatRef: { t?: NodeJS.Timeout } = {};
      try {
        const sid = String(req.params['sid']);
        const agentId = Number(req.params['id']);
        const msgId = String(req.params['msgId']);
        const { message, model_override, params } = req.body as {
          message?: string;
          model_override?: string;
          params?: { temperature?: number; max_tokens?: number; top_p?: number };
        };
        if (!message || typeof message !== 'string' || !message.trim()) {
          res.status(400).json({ error: 'message ist erforderlich' }); return;
        }
        const reqUser = (req as unknown as { user?: SessionUser }).user;
        const ownerId = reqUser?.role === 'admin' ? undefined : reqUser?.id;
        const session = await getSession(adminPool, sid, ownerId);
        if (!session || session.agent_id !== agentId) { res.status(404).json({ error: 'Session not found' }); return; }
        if (!sessionOwnedBy(session, reqUser)) { res.status(403).json({ error: 'Forbidden: session belongs to another user' }); return; }
        const gate = await agentAccessGate(adminPool, agentId, reqUser);
        if (gate.verdict === 'not_found') { res.status(404).json({ error: 'Agent not found' }); return; }
        if (gate.verdict === 'forbidden') { res.status(403).json({ error: 'agent not permitted' }); return; }

        // Target must be a USER message in this session; branch at its parent.
        const target = (session.messages ?? []).find((m) => m.id === msgId);
        if (!target || target.role !== 'user') { res.status(400).json({ error: 'editable user message not found' }); return; }
        const branchParent = target.parentId ?? null;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const { runAgentChat } = await import('./agents/agentRunner.js');
        heartbeatRef.t = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
        const callingUser = reqUser ? {
          id: reqUser.id,
          role: reqUser.role,
          entra_groups: reqUser.entra_groups,
          allowed_bundles: reqUser.allowed_bundles,
        } : undefined;
        const paramOverrides = clampParams(params);
        try {
          const { withRequestContext } = await import('./lib/requestContext.js');
          await withRequestContext(
            { callingUser: callingUser ? {
              id: callingUser.id,
              username: (callingUser as { username?: string }).username,
              email: (callingUser as { email?: string }).email,
              role: (callingUser as { role?: string }).role,
              entra_groups: callingUser.entra_groups,
            } : undefined },
            async () => {
              for await (const chunk of runAgentChat(agentId, sid, message.trim(), adminPool, config, model_override, callingUser, undefined, undefined, undefined, true, undefined, paramOverrides, false, { fromId: branchParent })) {
                res.write(chunk);
              }
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Runner error';
          logger.error({ err }, 'Edit runner error');
          res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
          res.write('data: [DONE]\n\n');
        } finally {
          if (heartbeatRef.t) clearInterval(heartbeatRef.t);
        }
        res.end();
      } catch (err) {
        if (heartbeatRef.t) clearInterval(heartbeatRef.t);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to edit message' });
      }
    });

    // Helper: auto-generate start message for /runs endpoint
    function buildRunMessage(ctx: { task_type?: string; ticket_id?: string; branch?: string; build_log?: string }): string {
      if (ctx.task_type === 'fix_build_failure') return `Analysiere den Build-Fehler im Log und schlage Korrekturen vor.`;
      if (ctx.task_type === 'review_pr') return `Führe ein Code-Review des PRs durch und gib strukturiertes Feedback.`;
      if (ctx.task_type === 'implement_ticket') return `Implementiere das Ticket ${ctx.ticket_id ?? ''} auf Branch ${ctx.branch ?? ''}.`;
      if (ctx.task_type === 'refactor') return `Refactore den Code auf Branch ${ctx.branch ?? ''} gemäß Best Practices.`;
      if (ctx.task_type === 'explain_diff') return `Erkläre die Änderungen auf Branch ${ctx.branch ?? ''}.`;
      return ctx.ticket_id ? `Bearbeite Ticket ${ctx.ticket_id}.` : 'Starte die Aufgabe.';
    }

    // Non-streaming chat — for Jenkins, n8n, webhooks
    // POST /api/agents/:id/chat
    // Body:  { "message": "...", "session_id": "optional-existing-sid" }
    // Returns: { response, session_id, tool_calls, iterations, agent }
    // Auth: session OR API key (for Jenkins/n8n webhooks)
    // Bundle RBAC: if API key has allowed_bundles AND agent has bundle_ids → must overlap
    const requireAuthOrApiKey = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
      const hasSession = !!(req as AuthenticatedRequest).user;
      const hasApiKey  = !!(req as unknown as Record<string, unknown>).apiKeyPrefix;
      // Signed provider webhooks authenticate with their provider-specific
      // HMAC middleware inside createCodingRouter, not with a user session.
      const signedWebhook = req.method === 'POST' && req.path.startsWith('/webhook/');
      if (!hasSession && !hasApiKey && !signedWebhook) { res.status(401).json({ error: 'Nicht authentifiziert' }); return; }
      if (signedWebhook && !hasSession && !hasApiKey) { next(); return; }

      // If API key auth: check scope — reject keys scoped to "mcp" only
      if (hasApiKey && !hasSession) {
        const executionGrant = (req as unknown as Record<string, unknown>).executionGrant as {
          coreAgentIds?: number[];
          workspaceRoot?: string;
        } | undefined;
        const keyScope = (req as unknown as Record<string, unknown>).apiKeyScope as string | undefined;
        if (keyScope === 'mcp') {
          res.status(403).json({ error: 'Dieser API Key ist nur für MCP-Gateway berechtigt (scope: mcp)' });
          return;
        }

        // Execution grants name the exact Core Agents independently from their
        // tool bundles. Their bundleIds constrain the tools used inside those
        // Agents and must never be widened by an Agent's own assignment.
        const agentId = Number(req.params.id);
        if (executionGrant && (!agentId || !executionGrant.coreAgentIds?.includes(agentId))) {
          res.status(403).json({ error: 'Execution Grant ist nicht für diesen Core Agent gültig' });
          return;
        }

        // Long-lived API keys retain the established Agent × Bundle overlap
        // gate. For execution grants the exact Agent-ID gate above applies.
        const allowedBundles = (req as unknown as Record<string, unknown>).allowedBundles as number[] | null;
        if (!executionGrant && allowedBundles !== null) {
          if (agentId) {
            try {
              const agent = await getAgent(adminPool, agentId);
              if (agent && !agentVisibleToBundleScope(agent.bundle_ids, allowedBundles)) {
                res.status(403).json({ error: 'API Key hat keinen Zugriff auf diesen Agent (Bundle-Einschränkung)' });
                return;
              }
            } catch { /* agent lookup failed → let the handler deal with 404 */ }
          }
        }
      }
      next();
    };

    // Safe handshake for out-of-process subscription runtimes: create or
    // reuse the exact commit index, but return metadata only. Repository
    // source remains inside Core unless a separately authorized retrieval
    // request is made.
    registerRepositoryIssueRoutes(app, adminPool, config, requireAuth, requireAuthOrApiKey);
    registerTechnicalExperimentRoute(app, adminPool, requireAuthOrApiKey);
    registerQaTestsRoutes(app, adminPool, requireAuthOrApiKey);
    registerStackTestsRoutes(app, adminPool, requireAuthOrApiKey);
    registerCodeGenerationRoutes(app, adminPool, requireAuthOrApiKey);
    app.post('/api/agents/:id/code-index', requireAuthOrApiKey, async (req, res) => {
      const executionGrant = (req as unknown as Record<string, unknown>).executionGrant as ExecutionGrantClaims | undefined;
      if (!executionGrant?.workspaceRoot) {
        res.status(403).json({ error: 'A workspace-bound execution grant is required', code: 'code_index_grant_required' });
        return;
      }
      try {
        const agentId = Number(req.params.id);
        const agent = await getAgent(adminPool, agentId);
        if (!agent?.enabled) {
          res.status(404).json({ error: 'Agent not found or disabled' });
          return;
        }
        const access = await resolveNativeCodeBundleAccess(adminPool, executionGrant.bundleIds);
        if (!access.canIndex) {
          // A Read-only run deliberately has no authority to create or widen
          // an index. This is a normal capability decision, not a failed span.
          res.json({
            snapshot: null,
            skipped: true,
            reason: 'index_bundle_not_authorized',
          });
          return;
        }
        const span = startTelemetrySpan({
          traceId: executionGrant.rootTraceId,
          name: 'code_intelligence.index',
          kind: 'rag',
          input: { workspaceRoot: executionGrant.workspaceRoot },
          metadata: { agent_id: agentId, provider: 'graphify', execution_grant_id: executionGrant.jti },
        });
        let snapshot;
        try {
          snapshot = await ensureNativeWorkspaceCodeIndex(adminPool, {
            workspaceRoot: executionGrant.workspaceRoot,
            executionBundleIds: executionGrant.bundleIds,
          }, access);
          finishTelemetrySpan(span, {
            status: 'completed',
            output: { snapshotId: snapshot.id, commitSha: snapshot.commitSha },
            metadata: {
              snapshot_id: snapshot.id,
              repository_key: snapshot.repositoryKey,
              branch_name: snapshot.branchName,
              commit_sha: snapshot.commitSha,
              provider: snapshot.provider,
              files: snapshot.fileCount,
              symbols: snapshot.symbolCount,
              edges: snapshot.edgeCount,
              documents: snapshot.documentCount,
            },
          });
        } catch (error) {
          finishTelemetrySpan(span, { status: 'failed', error });
          throw error;
        }
        res.json({
          snapshot: {
            id: snapshot.id,
            repositoryKey: snapshot.repositoryKey,
            branchName: snapshot.branchName,
            commitSha: snapshot.commitSha,
            provider: snapshot.provider,
            fileCount: snapshot.fileCount,
            symbolCount: snapshot.symbolCount,
            edgeCount: snapshot.edgeCount,
            documentCount: snapshot.documentCount,
          },
        });
      } catch (error) {
        const expected = error instanceof CodeIndexValidationError;
        if (!expected) logger.error({ err: error }, 'Native code index handshake failed');
        res.status(expected ? 422 : 500).json({
          error: error instanceof Error ? error.message : 'Native code index handshake failed',
          code: expected ? 'code_index_unavailable' : 'code_index_failed',
        });
      }
    });

    // Commit-bound native code context for out-of-process subscription
    // runtimes. The caller supplies only a retrieval query. Workspace,
    // repository and Bundle scope come exclusively from the signed grant.
    app.post('/api/agents/:id/code-context', requireAuthOrApiKey, async (req, res) => {
      const executionGrant = (req as unknown as Record<string, unknown>).executionGrant as ExecutionGrantClaims | undefined;
      if (!executionGrant?.workspaceRoot) {
        res.status(403).json({ error: 'A workspace-bound execution grant is required', code: 'code_context_grant_required' });
        return;
      }
      const query = req.body?.query;
      const limit = req.body?.limit;
      if (typeof query !== 'string' || !query.trim() || query.length > 2_000
        || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 8))) {
        res.status(400).json({ error: 'query must contain 1-2000 characters and limit must be an integer from 1 to 8' });
        return;
      }
      try {
        const agentId = Number(req.params.id);
        const agent = await getAgent(adminPool, agentId);
        if (!agent?.enabled) {
          res.status(404).json({ error: 'Agent not found or disabled' });
          return;
        }
        const runtime = await getAgentRuntimeAssignment(adminPool, agentId);
        if (!runtime?.profile_enabled || runtime.code_context_mode !== 'bounded_source'
          || runtime.runtime_type === 'argus') {
          logger.info({
            rootTraceId: executionGrant.rootTraceId,
            agentId,
            runtimeProfileId: runtime?.profile_id ?? null,
            codeContextMode: runtime?.code_context_mode ?? 'metadata_only',
          }, 'External native code context denied by runtime profile policy');
          res.status(403).json({
            error: 'The assigned runtime profile does not allow bounded source context',
            code: 'code_context_sharing_denied',
            policy: { mode: runtime?.code_context_mode ?? 'metadata_only' },
          });
          return;
        }
        const access = await resolveNativeCodeBundleAccess(adminPool, executionGrant.bundleIds);
        if (!access.canRead || access.repositoryBundleIds.length === 0) {
          // Missing optional capability is a preflight decision. Do not start
          // a retrieval span that would turn an intentionally narrow run red.
          const reason = !access.canRead
            ? 'read_bundle_not_authorized'
            : 'repository_bundle_not_authorized';
          res.status(422).json({
            error: reason === 'read_bundle_not_authorized'
              ? 'native code context requires the argus-code-intelligence-read MCP Bundle'
              : 'no repository-capable MCP Bundle is authorized for native code context',
            code: 'code_context_unavailable',
            skipped: true,
            reason,
          });
          return;
        }
        const policyLimit = runtime.code_context_max_results ?? 4;
        const policyBytes = runtime.code_context_max_bytes ?? 12_000;
        const retrievalVariant = executionGrant.codeContextVariant ?? 'candidate';
        const root = await adminPool.query<{ user_id: number | null }>(
          `SELECT user_id FROM mcp_observability_traces
            WHERE id=$1::uuid AND root_trace_id=id LIMIT 1`,
          [executionGrant.rootTraceId],
        );
        const run = async () => {
          const span = startTelemetrySpan({
            traceId: executionGrant.rootTraceId,
            name: 'code_intelligence.context',
            kind: 'rag',
            input: { queryLength: query.trim().length, workspaceRoot: executionGrant.workspaceRoot },
            metadata: { agent_id: agentId, provider: 'graphify', execution_grant_id: executionGrant.jti },
          });
          try {
            const context = await buildNativeWorkspaceCodeContext(adminPool, {
              workspaceRoot: executionGrant.workspaceRoot!,
              executionBundleIds: executionGrant.bundleIds,
              query: query.trim(),
              limit: Math.min(policyLimit, limit ?? policyLimit),
              maxBytes: policyBytes,
              retrievalVariant,
            });
            finishTelemetrySpan(span, {
              status: 'completed',
              output: { snapshotId: context.snapshot.id, evidenceCount: context.evidence.length },
              metadata: {
                snapshot_id: context.snapshot.id,
                repository_key: context.snapshot.repositoryKey,
                commit_sha: context.snapshot.commitSha,
                evidence_count: context.evidence.length,
                channels: context.channelsUsed,
                context_mode: runtime.code_context_mode,
                retrieval_variant: retrievalVariant,
                max_results: policyLimit,
                max_bytes: policyBytes,
                citations: context.evidence.map(item => ({
                  file_path: item.filePath,
                  symbol_name: item.symbol,
                  start_line: item.startLine,
                  end_line: item.endLine,
                  chunk_kind: item.kind,
                  channels: item.channels,
                })),
              },
            });
            return context;
          } catch (error) {
            if (error instanceof NativeCodeIndexUnavailableError) {
              finishTelemetrySpan(span, {
                status: 'completed',
                output: { skipped: true, reason: 'exact_commit_snapshot_unavailable' },
                metadata: { skipped: true, skip_reason: 'exact_commit_snapshot_unavailable' },
              });
            } else {
              finishTelemetrySpan(span, { status: 'failed', error });
            }
            throw error;
          }
        };
        const context = root.rows[0]
          ? await withNativeTelemetryContext({
            rootTraceId: executionGrant.rootTraceId,
            traceId: executionGrant.rootTraceId,
            spanId: null,
            userId: root.rows[0].user_id,
          }, run)
          : await run();
        res.json({
          ...context,
          variant: retrievalVariant,
          policy: {
            mode: runtime.code_context_mode,
            runtimeProfileId: runtime.profile_id,
            maxResults: policyLimit,
            maxBytes: policyBytes,
          },
        });
      } catch (error) {
        const expected = error instanceof CodeIndexValidationError;
        if (!expected) logger.error({ err: error }, 'Native code context request failed');
        res.status(expected ? 422 : 500).json({
          error: error instanceof Error ? error.message : 'Native code context request failed',
          code: expected ? 'code_context_unavailable' : 'code_context_failed',
        });
      }
    });

    app.post('/api/agents/:id/chat', requireAuthOrApiKey, async (req, res) => {
      try {
        const agentId = Number(req.params.id);
        const { message, session_id, worker_task_type, include_tool_results } = req.body as {
          message?: string;
          session_id?: string;
          worker_task_type?: 'plan' | 'knowledge' | 'implement_ticket' | 'run_tests' | 'review' | 'fix_pr' | 'fix_ci' | 'fix_security';
          execution_tool_allow_patterns?: string[];
          include_tool_results?: boolean;
        };
        const executionGrant = (req as unknown as Record<string, unknown>).executionGrant as ExecutionGrantClaims | undefined;

        const requestedToolPatterns = req.body?.execution_tool_allow_patterns;
        if (requestedToolPatterns !== undefined) {
          if (!executionGrant) {
            res.status(400).json({ error: 'execution_tool_allow_patterns requires a signed execution grant' });
            return;
          }
          if (!Array.isArray(requestedToolPatterns) || requestedToolPatterns.length > 64
            || requestedToolPatterns.some(pattern => typeof pattern !== 'string' || !pattern || pattern.length > 256)) {
            res.status(400).json({ error: 'execution_tool_allow_patterns must contain at most 64 bounded patterns' });
            return;
          }
        }

        if (!message || typeof message !== 'string' || !message.trim()) {
          res.status(400).json({ error: 'message ist erforderlich' });
          return;
        }

        // Cross-process Langfuse linking: when an upstream workflow (e.g.
        // LangGraph coding_workflow) passes its threadId, the agent.chat
        // trace adopts that as sessionId so the workflow trace and the
        // agent traces it spawns appear together in Langfuse session view.
        const lfSid = req.headers['x-langfuse-session-id'];
        if (typeof lfSid === 'string' && lfSid.trim()) {
          const { setSessionIdOverride } = await import('./lib/langfuseTracing.js');
          setSessionIdOverride(lfSid.trim());
        }

        // Native cross-process correlation is accepted only from callers that
        // know WORKSPACE_SECRET, and only when both referenced traces already
        // belong to the same persisted root family. Public API keys cannot
        // forge parentage by adding Argus trace headers.
        const nativeEnvelope = readTrustedNativeTraceEnvelope(
          req.headers,
          process.env['WORKSPACE_SECRET'] ?? '',
        );
        let nativeContext: {
          rootTraceId: string;
          traceId: string;
          spanId: string | null;
          userId: number | null;
          tenantKey: string;
          workspaceKey: string;
        } | null = null;
        if (nativeEnvelope) {
          const owner = await adminPool.query<{
            user_id: number | null;
            tenant_key: string | null;
            workspace_key: string | null;
          }>(
            `SELECT root.user_id,
                    root.metadata->>'tenant_key' AS tenant_key,
                    root.metadata->>'workspace_key' AS workspace_key
               FROM mcp_observability_traces root
               JOIN mcp_observability_traces parent
                 ON parent.id=$2::uuid AND parent.root_trace_id=root.id
              WHERE root.id=$1::uuid AND root.root_trace_id=root.id
              LIMIT 1`,
            [nativeEnvelope.rootTraceId, nativeEnvelope.parentTraceId],
          );
          if (owner.rows[0]) {
            nativeContext = {
              rootTraceId: nativeEnvelope.rootTraceId,
              traceId: nativeEnvelope.parentTraceId,
              spanId: nativeEnvelope.parentSpanId,
              userId: owner.rows[0].user_id,
              tenantKey: owner.rows[0].tenant_key ?? 'default',
              workspaceKey: owner.rows[0].workspace_key ?? 'default',
            };
          }
        }
        if (!nativeContext && executionGrant?.rootTraceId) {
          const root = await adminPool.query<{ user_id: number | null }>(
            `SELECT user_id
               FROM mcp_observability_traces
              WHERE id=$1::uuid AND root_trace_id=id
              LIMIT 1`,
            [executionGrant.rootTraceId],
          );
          if (root.rows[0]) {
            const scope = executionGrantWorkspaceScope(executionGrant);
            nativeContext = {
              rootTraceId: executionGrant.rootTraceId,
              traceId: executionGrant.rootTraceId,
              spanId: null,
              userId: root.rows[0].user_id,
              tenantKey: scope.tenantKey,
              workspaceKey: scope.workspaceKey,
            };
          }
        }

        const roleUser = (req as unknown as { user?: SessionUser }).user;
        const runtimeUser = runtimeCallingUserFromReq(req);
        const access = await agentAccessGate(adminPool, agentId, runtimeUser, {
          allowServiceBundleOverride: executionGrant != null,
        });
        if (access.verdict === 'not_found' || !access.agent) {
          res.status(404).json({ error: 'Agent not found or disabled' });
          return;
        }
        if (access.verdict === 'forbidden') {
          res.status(403).json({ error: 'agent not permitted' });
          return;
        }
        const agent = access.agent;
        const keyBundles = (req as unknown as { allowedBundles?: number[] | null }).allowedBundles;
        if (!roleUser && !executionGrant && keyBundles != null && !agentVisibleToBundleScope(agent.bundle_ids, keyBundles)) {
          res.status(403).json({ error: 'agent not permitted for your bundle scope' });
          return;
        }

        // Reuse existing session or create a new one
        let sid = session_id?.trim();
        if (sid) {
          const existing = await getSession(adminPool, sid);
          if (!existing || existing.agent_id !== agentId) {
            res.status(404).json({ error: 'session_id not found for this agent' });
            return;
          }
        } else {
          sid = `jenkins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await createAgentSession(adminPool, agentId, sid);
        }

        // A coding Solution Pack receives one ticket workspace in its signed
        // execution grant. Persist that immutable scope on every worker
        // session so model-produced paths are checked by Core, not just by a
        // prompt in the external orchestrator.
        if (executionGrant?.workspaceRoot) {
          await updateSessionPrContext(adminPool, sid, {
            allowed_paths: [executionGrant.workspaceRoot, `${executionGrant.workspaceRoot}/*`],
            workspace_dir: executionGrant.workspaceRoot,
            ...(worker_task_type ? { task_type: worker_task_type } : {}),
          });
        }

        const { runAgentChatSync } = await import('./agents/agentRunner.js');
        const callingUser = runtimeUser;
        const technicalToolPolicy = technicalIdentityToolPolicyFromReq(req);
        const keyExecutionBundles = !roleUser && keyBundles != null
          ? intersectAgentBundleScope(agent.bundle_ids, keyBundles)
          : undefined;
        // Solution Pack turns are short-lived orchestration steps. Cross-turn
        // memory is optional enrichment and must not enqueue a second local
        // LLM request behind the next critical graph node (especially with a
        // single-slot Ollama runtime).
        const disableOrchestrationMemory = Boolean(
          (req as unknown as Record<string, unknown>).executionGrant,
        );
        const grantCatalog = (req as unknown as Record<string, unknown>).allowedTools;
        const executionAllowedTools = executionGrant && requestedToolPatterns !== undefined
          ? narrowExecutionGrantTools(Array.isArray(grantCatalog) ? grantCatalog as string[] : [], requestedToolPatterns)
          : undefined;
        const runtimeProfileOverride = executionGrant?.runtimeProfileOverrides
          ?.find(item => item.agentId === agentId);
        const managedRuntimeBundleIds = executionGrant
          ? selectManagedHermesBundleIds(executionGrant.bundleIds, config.managedRuntimeReadOnlyBundleIds)
          : [];
        const managedRuntimeContext = executionGrant?.workspaceRoot ? {
          requestId: randomUUID(),
          rootTraceId: executionGrant.rootTraceId,
          coreAgentName: agent.name,
          principal: {
            kind: executionGrant.principalKind,
            id: executionGrant.principalId,
            allowedBundleIds: executionGrant.bundleIds,
            ...executionGrantWorkspaceScope(executionGrant),
          },
          bundleIds: managedRuntimeBundleIds,
          workspaceRoot: executionGrant.workspaceRoot,
          workspaceAccess: (
            agent.agent_mode === 'worker'
            && ['implement_ticket', 'fix_pr', 'fix_ci', 'fix_security'].includes(worker_task_type ?? '')
          ) ? 'write' as const : 'read' as const,
        } : undefined;
        const run = () => runAgentChatSync(
          agentId,
          sid,
          message.trim(),
          adminPool,
          config,
          undefined,
          callingUser,
          technicalToolPolicy,
          disableOrchestrationMemory,
          executionGrant?.bundleIds ? {
            executionBundleIds: executionGrant.bundleIds,
            ...(executionGrant.resourceScope ? { executionResourceScope: executionGrant.resourceScope } : {}),
            ...(executionAllowedTools ? { allowedTools: executionAllowedTools } : {}),
            ...(include_tool_results === true ? { captureToolResults: true } : {}),
            ...(managedRuntimeContext ? { managedRuntimeContext } : {}),
            ...(runtimeProfileOverride ? { runtimeProfileId: runtimeProfileOverride.runtimeProfileId } : {}),
          } : keyExecutionBundles == null ? undefined : { executionBundleIds: keyExecutionBundles },
        );
        const result = nativeContext
          ? await withNativeTelemetryContext(nativeContext, run)
          : await run();

        const effectiveRuntime = await getAgentRuntimeAssignment(
          adminPool,
          agentId,
          runtimeProfileOverride?.runtimeProfileId,
        );
        res.json({
          ...result,
          agent: {
            id: agent.id,
            name: agent.name,
            label: agent.label,
            model: effectiveRuntime?.model ?? agent.model,
            runtime: {
              type: effectiveRuntime?.runtime_type ?? 'argus',
              profileId: effectiveRuntime?.profile_id ?? null,
              profileName: effectiveRuntime?.profile_name ?? null,
              taskOverride: runtimeProfileOverride != null,
            },
          },
        });
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: 'Workspace scope was not found.', code: err.code });
          return;
        }
        logger.error({ err }, 'Agent sync chat error');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Runner error' });
      }
    });

    // Jenkins / n8n contract endpoint
    // POST /api/agents/:id/runs
    // Body: { ticket_id?, branch?, pr_number?, task_type?, build_log?, repo?, allowed_paths?, message?, callback_url? }
    // Returns: { session_id, result, status, agent }
    app.post('/api/agents/:id/runs', requireAuthOrApiKey, async (req, res) => {
      try {
        const agentId = Number(req.params.id);
        const {
          ticket_id, branch, pr_number, task_type, build_log, repo,
          allowed_paths, message, callback_url,
        } = req.body as {
          ticket_id?: string; branch?: string; pr_number?: number;
          task_type?: string; build_log?: string; repo?: string;
          allowed_paths?: string[]; message?: string; callback_url?: string;
        };

        const roleUser = (req as unknown as { user?: SessionUser }).user;
        const runtimeUser = runtimeCallingUserFromReq(req);
        const access = await agentAccessGate(adminPool, agentId, runtimeUser);
        if (access.verdict === 'not_found' || !access.agent) {
          res.status(404).json({ error: 'Agent not found or disabled' });
          return;
        }
        if (access.verdict === 'forbidden') {
          res.status(403).json({ error: 'agent not permitted' });
          return;
        }
        const agent = access.agent;
        const keyBundles = (req as unknown as { allowedBundles?: number[] | null }).allowedBundles;
        if (!roleUser && keyBundles != null && !agentVisibleToBundleScope(agent.bundle_ids, keyBundles)) {
          res.status(403).json({ error: 'agent not permitted for your bundle scope' });
          return;
        }
        const keyExecutionBundles = !roleUser && keyBundles != null
          ? intersectAgentBundleScope(agent.bundle_ids, keyBundles)
          : undefined;

        // Worker-mode runs on a specific ticket must serialize: a second concurrent
        // run on the same ticket would collide on /workspace/<ticket_id>/.
        const needsTicketLock = agent.agent_mode === 'worker' && typeof ticket_id === 'string' && ticket_id.trim() !== '';
        let lockHandle: { release: () => Promise<void> } | null = null;
        if (needsTicketLock) {
          const { tryAcquireTicketLock } = await import('./lib/ticketLock.js');
          lockHandle = await tryAcquireTicketLock(adminPool, ticket_id!.trim());
          if (!lockHandle) {
            res.status(409).json({
              error: 'ticket_busy',
              message: `Ein Worker-Run für Ticket ${ticket_id} läuft bereits. Bitte warten bis dieser fertig ist.`,
              ticket_id,
            });
            return;
          }
        }

        try {
          const sid = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await createAgentSession(adminPool, agentId, sid);

          // Preload PR context into session
          const prContext = { ticket_id, branch, pr_number, task_type, build_log, repo, allowed_paths };
          await updateSessionPrContext(adminPool, sid, prContext);

          // Auto-generate message if not provided
          const startMessage = message?.trim() || buildRunMessage(prContext);

          const { runAgentChatSync } = await import('./agents/agentRunner.js');
          const result = await runAgentChatSync(
            agentId,
            sid,
            startMessage,
            adminPool,
            config,
            undefined,
            runtimeUser,
            technicalIdentityToolPolicyFromReq(req),
            false,
            keyExecutionBundles == null ? undefined : { executionBundleIds: keyExecutionBundles },
          );

          // Fire callback if requested (fire-and-forget). SECURITY (audit): the
          // callback URL is caller-supplied — run it through the same SSRF guard
          // the HTTP tools use so the pod can't be coerced into POSTing to cloud
          // metadata / internal cluster addresses.
          if (callback_url && typeof callback_url === 'string') {
            const { assertSsrfSafe } = await import('./backends/customBackends.js');
            let callbackSafe = true;
            try { assertSsrfSafe(callback_url); }
            catch (e) { callbackSafe = false; logger.warn({ err: e instanceof Error ? e.message : String(e), callback_url }, 'callback_url rejected by SSRF guard — not calling back'); }
            if (callbackSafe) {
              fetch(callback_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sid, status: 'done', result: result.response }),
              }).catch(err => logger.warn({ err, callback_url }, 'Callback POST failed'));
            }
          }

          res.json({
            session_id: sid,
            status: 'done',
            result: result.response,
            tool_calls: result.tool_calls,
            agent: { id: agent.id, name: agent.name, label: agent.label, model: agent.model },
          });
        } finally {
          if (lockHandle) {
            await lockHandle.release().catch(err =>
              logger.warn({ err, ticket_id }, 'Failed to release ticket advisory lock'),
            );
          }
        }
      } catch (err) {
        if (err instanceof WorkspaceScopeAccessError) {
          res.status(err.status).json({ error: 'Workspace scope was not found.', code: err.code });
          return;
        }
        logger.error({ err }, 'Agent run error');
        res.status(500).json({ error: err instanceof Error ? err.message : 'Runner error' });
      }
    });

    // Coding workflow proxy (LangGraph wrapper) — UI + n8n/webhooks
    if (sharedPool && executionGrantIssuer) app.use('/api/coding', createCodingCheckpointRetryRouter(sharedPool, executionGrantIssuer, config.solutionPackExecutionGrantSecret));
    if (sharedPool && executionGrantIssuer) app.use('/api/coding', createCodingQaResponseRecheckRouter(sharedPool, executionGrantIssuer, config.solutionPackExecutionGrantSecret));
    if (sharedPool && executionGrantIssuer) app.use('/api/coding', createCodingCheckpointRetryRouter(sharedPool, executionGrantIssuer, config.solutionPackExecutionGrantSecret, fetch, 'qa-retry'));
    if (sharedPool && executionGrantIssuer) {
      const { createDevGitApprovalRouter } = await import('./api/devGitApproval.js');
      app.use('/api/coding', createDevGitApprovalRouter(sharedPool, executionGrantIssuer, config.solutionPackExecutionGrantSecret));
    }
    app.use('/api/coding', requireAuthOrApiKey, createCodingRouter());
  }

  // ── OpenTelemetry Settings API ────────────────────────────────

  app.post('/api/settings/otel', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { enabled, endpoint, serviceName } = req.body;

      // Validate input
      if (enabled && !endpoint) {
        res.status(400).json({ error: 'OTLP endpoint is required when OpenTelemetry is enabled' });
        return;
      }

      // Sanitize: reject newlines (env injection prevention)
      if (endpoint && /[\r\n]/.test(endpoint)) {
        res.status(400).json({ error: 'Invalid endpoint: newlines not allowed' });
        return;
      }
      if (serviceName && /[\r\n]/.test(serviceName)) {
        res.status(400).json({ error: 'Invalid serviceName: newlines not allowed' });
        return;
      }
      // Allowlist: only alphanumerics, hyphens, underscores for service name
      if (serviceName && !/^[\w-]+$/.test(serviceName)) {
        res.status(400).json({ error: 'Invalid serviceName: only alphanumerics, hyphens and underscores allowed' });
        return;
      }

      // Read current .env file
      const fs = await import('fs/promises');
      const envPath = '.env';
      let envContent = '';
      try {
        envContent = await fs.readFile(envPath, 'utf-8');
      } catch (err) {
        // .env doesn't exist, create from template
        envContent = await fs.readFile('.env.example', 'utf-8');
      }

      // Update or add OTEL settings — only these two keys are allowed
      const lines = envContent.split('\n');
      const updates = new Map([
        ['OTEL_EXPORTER_OTLP_ENDPOINT', enabled ? endpoint : ''],
        ['OTEL_SERVICE_NAME', serviceName || 'argus-core'],
      ]);

      for (const [key, value] of updates) {
        // Guard: skip any key not in the explicit allowlist (prevents future injection)
        if (!['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SERVICE_NAME'].includes(key)) continue;
        const lineIdx = lines.findIndex(l => l.startsWith(`${key}=`));
        if (lineIdx >= 0) {
          lines[lineIdx] = value ? `${key}=${value}` : `# ${key}=`;
        } else {
          // Add after OTel section comment
          const sectionIdx = lines.findIndex(l => l.includes('OpenTelemetry'));
          if (sectionIdx >= 0) {
            lines.splice(sectionIdx + 1, 0, value ? `${key}=${value}` : `# ${key}=`);
          } else {
            lines.push(value ? `${key}=${value}` : `# ${key}=`);
          }
        }
      }

      // Write updated .env
      await fs.writeFile(envPath, lines.join('\n'), 'utf-8');

      logger.info({ enabled, endpoint, serviceName }, 'OpenTelemetry settings updated via API');

      // Restart server after 1 second
      setTimeout(() => {
        logger.info('Restarting server to apply OpenTelemetry settings...');
        gracefulShutdown('otel-config-change');
      }, 1000);

      res.json({ success: true, message: 'Settings saved, server restarting...' });
    } catch (err) {
      logger.error({ err }, 'Failed to update OpenTelemetry settings');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update settings' });
    }
  });

  app.post('/api/settings/otel/test', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { endpoint } = req.body;
      if (!endpoint) {
        res.status(400).json({ error: 'Endpoint is required' });
        return;
      }

      // Try to connect to the OTLP endpoint (simple TCP check)
      const url = new URL(endpoint);
      const host = url.hostname;
      const port = parseInt(url.port) || 4317;

      // Simple reachability test using fetch with timeout
      const testUrl = `http://${host}:${port}`;

      // SSRF protection: block internal/private addresses
      assertSsrfSafe(testUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      try {
        await fetch(testUrl, { signal: controller.signal });
        clearTimeout(timeout);
        res.json({ reachable: true });
      } catch (err) {
        clearTimeout(timeout);
        // Even if fetch fails, the endpoint might be reachable (gRPC doesn't respond to HTTP GET)
        // So we consider it reachable if we get any network error (not timeout)
        const isTimeout = (err as Error).name === 'AbortError';
        res.json({
          reachable: !isTimeout,
          error: isTimeout ? 'Connection timeout' : 'Endpoint might be reachable (gRPC port)',
        });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to test OTLP endpoint');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to test endpoint' });
    }
  });

  // ── Metrics API ────────────────────────────────────────────

  app.get('/api/metrics/dashboard', requireAuth, async (req, res) => {
    try {
      const hours = parseInt(String(req.query.hours) || '24', 10);
      const backend = req.query.backend ? String(req.query.backend) : undefined;
      const toolsLimit = parseInt(String(req.query.tools_limit) || '10', 10);
      const keysLimit = parseInt(String(req.query.keys_limit) || '5', 10);
      const data = await getDashboardMetrics(hours, { backend, toolsLimit, keysLimit });
      res.json(data);
    } catch (err) {
      logger.error({ err }, 'Failed to get dashboard metrics');
      res.status(500).json({ error: 'Failed to get dashboard metrics' });
    }
  });

  // ── MCP Transport ───────────────────────────────────────────
  // Each session gets its own McpServer instance (SDK requirement: one transport per server)

  const transports = new Map<string, StreamableHTTPServerTransport>();
  // audit M1 + 2026-11 review: every MCP session is bound to the credential
  // that created it AND to a fingerprint of that credential's policy. Each
  // POST/GET/DELETE re-checks both, so a different key cannot attach to or
  // close a foreign session, and a narrowed key/user scope invalidates the
  // session instead of keeping its baked-in broader tool filter.
  const rootMcpSessions = new McpSessionRegistry();

  /** Returns the transport when the caller may use it; otherwise responds and returns null. */
  const authorizeMcpSession = (
    req: express.Request,
    res: express.Response,
    sessionId: string,
    transportMap: Map<string, StreamableHTTPServerTransport>,
    registry: McpSessionRegistry,
  ): StreamableHTTPServerTransport | null => {
    const transport = transportMap.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return null;
    }
    const decision = registry.check(sessionId, req, sessionCtxFromReq(req));
    if (decision === 'ok') return transport;
    logger.warn({ sessionId, decision, path: req.path }, 'MCP session access rejected');
    if (decision === 'policy_changed') {
      // The old filter must never serve another request.
      void transport.close().catch(() => {});
    }
    const denial = mcpSessionDenial(decision);
    res.status(denial.status).json(denial.body);
    return null;
  };

  app.post('/mcp', async (req, res) => {
    // Scope check: reject keys scoped to "agents" only
    const keyScope = (req as unknown as Record<string, unknown>).apiKeyScope as string | undefined;
    if (keyScope === 'agents') {
      res.status(403).json({ error: 'Dieser API Key ist nur für Agent-Zugriff berechtigt (scope: agents)' });
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        const authorized = authorizeMcpSession(req, res, sessionId, transports, rootMcpSessions);
        if (!authorized) return;
        transport = authorized;
      } else {
        if (!mcpCallerId(req)) {
          res.status(401).json({ error: 'MCP sessions require an identifiable credential' });
          return;
        }
        // Extract RBAC context from middleware
        const sessionCtx = sessionCtxFromReq(req);

        const sessionServer = await createMcpServer(config, sessionCtx);

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
            rootMcpSessions.bind(id, req, sessionCtx);
            activeSessionsGauge.set(transports.size);
            logger.info({ sessionId: id }, 'MCP session initialized');
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
            rootMcpSessions.delete(transport.sessionId);
            activeSessionsGauge.set(transports.size);
            logger.info({ sessionId: transport.sessionId }, 'MCP session closed');
          }
        };

        await sessionServer.server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ err: error }, 'MCP POST error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    const transport = authorizeMcpSession(req, res, sessionId, transports, rootMcpSessions);
    if (!transport) return;

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error({ err: error }, 'MCP GET error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    const transport = authorizeMcpSession(req, res, sessionId, transports, rootMcpSessions);
    if (!transport) return;

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error({ err: error }, 'MCP DELETE error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // ── Filtered MCP Routes ─────────────────────────────────────
  // Helper: POST/GET/DELETE handler set for a filtered MCP endpoint.
  // serverFactory is called once per new session to build the right McpServer.
  function makeMcpHandlers(
    transportMap: Map<string, StreamableHTTPServerTransport>,
    serverFactory: (req: express.Request) => Promise<McpServerResult>,
  ) {
    const sessions = new McpSessionRegistry();
    return {
      post: async (req: express.Request, res: express.Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        try {
          let transport: StreamableHTTPServerTransport;
          if (sessionId && transportMap.has(sessionId)) {
            const authorized = authorizeMcpSession(req, res, sessionId, transportMap, sessions);
            if (!authorized) return;
            transport = authorized;
          } else {
            if (!mcpCallerId(req)) {
              res.status(401).json({ error: 'MCP sessions require an identifiable credential' });
              return;
            }
            const bindingCtx = sessionCtxFromReq(req);
            const sessionServer = await serverFactory(req);
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => {
                transportMap.set(id, transport);
                sessions.bind(id, req, bindingCtx);
                logger.info({ sessionId: id, path: req.path }, 'MCP session initialized');
              },
            });
            transport.onclose = () => {
              if (transport.sessionId) {
                transportMap.delete(transport.sessionId);
                sessions.delete(transport.sessionId);
                logger.info({ sessionId: transport.sessionId, path: req.path }, 'MCP session closed');
              }
            };
            await sessionServer.server.connect(transport);
          }
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          logger.error({ err: error }, 'MCP POST error');
          if (!res.headersSent) {
            const status = (error as { statusCode?: number }).statusCode ?? 500;
            const message = error instanceof Error ? error.message : 'Internal server error';
            res.status(status).json({ error: message });
          }
        }
      },
      get: async (req: express.Request, res: express.Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !transportMap.has(sessionId)) {
          res.status(400).json({ error: 'Invalid or missing session ID' });
          return;
        }
        const transport = authorizeMcpSession(req, res, sessionId, transportMap, sessions);
        if (!transport) return;
        try {
          await transport.handleRequest(req, res);
        } catch (error) {
          logger.error({ err: error }, 'MCP GET error');
          if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
        }
      },
      delete: async (req: express.Request, res: express.Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !transportMap.has(sessionId)) {
          res.status(400).json({ error: 'Invalid or missing session ID' });
          return;
        }
        const transport = authorizeMcpSession(req, res, sessionId, transportMap, sessions);
        if (!transport) return;
        try {
          await transport.handleRequest(req, res);
        } catch (error) {
          logger.error({ err: error }, 'MCP DELETE error');
          if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
        }
      },
    };
  }

  // /mcp/group/:bundleName — All tools filtered to a specific service bundle.
  // Must be registered BEFORE /mcp/:backendName to prevent 'group' matching as backendName.
  const bundleTransports = new Map<string, StreamableHTTPServerTransport>();
  const bundleHandlers = makeMcpHandlers(bundleTransports, async (req) => {
    const bundleName = (req.params as Record<string, string>).bundleName;
    const baseCtx = sessionCtxFromReq(req);

    if (config.postgresEnabled && sharedPool) {
      const bundle = await getBundleByName(sharedPool, bundleName);
      if (!bundle) {
        throw Object.assign(new Error(`Bundle '${bundleName}' not found`), { statusCode: 404 });
      }
      // Intersect with RBAC allowedBundles if the session is bundle-restricted
      const bundleFilter = baseCtx.allowedBundles == null || baseCtx.allowedBundles.includes(bundle.id)
        ? [bundle.id]
        : [];
      const sessionCtx: SessionContext = {
        ...baseCtx,
        allowedBundles: bundleFilter,
        systemPrompt: bundle.system_prompt ?? undefined,
        agentRole: bundle.agent_role ?? undefined,
      };
      return createMcpServer(config, sessionCtx);
    }
    return createMcpServer(config, baseCtx);
  });

  app.post('/mcp/group/:bundleName', bundleHandlers.post);
  app.get('/mcp/group/:bundleName', bundleHandlers.get);
  app.delete('/mcp/group/:bundleName', bundleHandlers.delete);

  // Personal-Hermes ingress into the canonical Argus Dev LangGraph workflow.
  // This is a separate MCP catalog from /mcp/runtime/:leaseId: a child Hermes
  // worker therefore never sees argus_dev_start_workflow and cannot recurse.
  const hermesDevBridgeTransports = new Map<string, StreamableHTTPServerTransport>();
  const requireHermesDevBridgeCredential: express.RequestHandler = (req, res, next) => {
    void (async () => {
      if (!hermesDevBridge || !hermesDevConnections) {
        res.status(503).json({ error: 'Hermes Argus Dev bridge requires PostgreSQL', code: 'hermes_dev_bridge_unavailable' });
        return;
      }
      const sessionCtx = sessionCtxFromReq(req);
      const keyScope = (req as unknown as Record<string, unknown>).apiKeyScope as string | undefined;
      if (!sessionCtx.apiKeyPrefix) {
        res.status(401).json({ error: 'A dedicated API key is required', code: 'hermes_dev_bridge_key_required' });
        return;
      }
      if (keyScope === 'agents') {
        res.status(403).json({ error: 'API key scope does not allow MCP access', code: 'hermes_dev_bridge_scope_denied' });
        return;
      }
      try {
        const resolved = await hermesDevConnections.resolveCredential(sessionCtx.apiKeyPrefix);
        const requestState = req as unknown as Record<string, unknown>;
        requestState.callingUser = {
          id: resolved.owner.id,
          username: resolved.owner.username,
          role: resolved.owner.role,
          entra_groups: resolved.owner.entraGroups,
        };
        requestState.allowedBundles = resolved.caller.allowedBundleIds;
        requestState.hermesDevCaller = resolved.caller;
        withRequestContext({
          callingUser: {
            id: resolved.owner.id,
            username: resolved.owner.username,
            role: resolved.owner.role,
            entra_groups: resolved.owner.entraGroups,
          },
        }, () => next());
      } catch (cause) {
        if (cause instanceof HermesDevConnectionError) {
          res.status(cause.status).json({ error: cause.message, code: cause.code });
          return;
        }
        logger.error({ err: cause }, 'Failed to authorize Hermes Dev delegation');
        res.status(503).json({ error: 'Hermes Dev delegation could not be verified', code: 'hermes_dev_delegation_unavailable' });
      }
    })().catch(next);
  };
  const hermesDevBridgeHandlers = makeMcpHandlers(hermesDevBridgeTransports, async req => {
    const sessionCtx = sessionCtxFromReq(req);
    const caller = (req as unknown as Record<string, unknown>).hermesDevCaller as {
      userId: number;
      apiKeyPrefix: string;
      allowedBundleIds: number[];
      tenantKey: string;
      workspaceKey: string;
    };
    return createMcpServer(config, {
      ...sessionCtx,
      sessionId: `personal-hermes:${sessionCtx.apiKeyPrefix}`,
      agentName: 'personal-hermes',
    }, {
      hermesDevBridge: {
        bridge: hermesDevBridge!,
        caller,
      },
    });
  });

  app.get('/api/me/identity-security', requireAuth, (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) { res.status(401).json({ error: 'no session' }); return; }
    const authMethod = user.auth_method ?? 'local';
    const ssoLinked = authMethod === 'oidc' && /^(?:entra|oidc):/.test(user.username);
    const mfaFresh = hasFreshMfaSession(user, config.oidcMfaMaxAgeSeconds);
    const roleAuthorizedForComplianceReports = normalizeRole(user.role) === 'platform_admin';
    const safeProviderUrl = (value: string): string | null => {
      if (!value) return null;
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
      } catch {
        return null;
      }
    };
    const accountManagementUrl = safeProviderUrl(config.oidcAccountManagementUrl);
    const adminConsoleUrl = safeProviderUrl(config.oidcAdminConsoleUrl);
    res.json({
      provider: {
        enabled: config.oidcSsoEnabled,
        name: config.oidcProviderName,
        type: config.oidcProvider,
        ssoOnly: config.entraDisableLocalLogin,
        localLoginEnabled: config.localAuthEnabled,
        emergencyLocalAdmin: config.entraEmergencyLocalAdmin,
        mfaMaxAgeSeconds: config.oidcMfaMaxAgeSeconds,
        accountManagementUrl,
        adminConsoleUrl,
      },
      session: {
        authMethod,
        ssoLinked,
        mfaVerifiedAt: user.mfa_verified_at ?? null,
        mfaMethod: user.mfa_method ?? null,
        mfaFresh,
      },
      actions: {
        canLink: config.oidcSsoEnabled && !ssoLinked,
        canStepUp: config.oidcSsoEnabled && ssoLinked,
        canManageMfa: ssoLinked && accountManagementUrl !== null,
        canManageOrganizationPolicy: normalizeRole(user.role) === 'platform_admin' && adminConsoleUrl !== null,
      },
      complianceReports: {
        roleAuthorized: roleAuthorizedForComplianceReports,
        freshMfaRequired: true,
        ready: roleAuthorizedForComplianceReports && mfaFresh,
      },
    });
  });
  app.post('/mcp/hermes-dev', requireHermesDevBridgeCredential, hermesDevBridgeHandlers.post);
  app.get('/mcp/hermes-dev', requireHermesDevBridgeCredential, hermesDevBridgeHandlers.get);
  app.delete('/mcp/hermes-dev', requireHermesDevBridgeCredential, hermesDevBridgeHandlers.delete);

  // Strict one-run MCP Fabric catalog for a managed external runtime. This is
  // deliberately separate from /mcp: ordinary API keys and ordinary Pack
  // execution grants cannot reach this endpoint.
  const runtimeMcpHandlers = createRuntimeMcpTransportHandlers({
    createServer: async req => {
      const state = req as express.Request & ExecutionGrantRequestState;
      const lease = state.runtimeMcpLease;
      const grant = state.executionGrant;
      const requestedLeaseId = (req.params as Record<string, string>).leaseId;
      if (!lease || !grant || requestedLeaseId !== lease.lease.leaseId) {
        throw Object.assign(new Error('runtime MCP lease is not bound to this request'), { statusCode: 403 });
      }
      const baseContext = sessionCtxFromReq(req);
      const sessionContext: SessionContext = {
        ...baseContext,
        // The grant middleware resolves this to the selected Bundle tools and
        // the signed, per-run workspace subset. Hermes never receives a host
        // mount or workspace_exec; Core remains the filesystem authority.
        allowedBundles: grant.bundleIds,
        allowedTools: baseContext.allowedTools ?? [],
        deniedTools: null,
        sessionId: `hermes:${lease.lease.leaseId}`,
        agentId: lease.lease.coreAgentId,
        agentName: lease.agentName,
        runtimeLeaseId: lease.lease.leaseId,
        runtimeWorkspaceRoot: grant.workspaceRoot ?? null,
        runtimeWorkspaceAccess: grant.workspaceAccess ?? null,
      };
      return createMcpServer(config, sessionContext, { runtimeLease: true });
    },
  });
  app.post('/mcp/runtime/:leaseId', runtimeMcpHandlers.post);
  app.get('/mcp/runtime/:leaseId', runtimeMcpHandlers.get);
  app.delete('/mcp/runtime/:leaseId', runtimeMcpHandlers.delete);

  // /mcp/:backendName — Only tools from a single remote MCP backend.
  const backendTransports = new Map<string, StreamableHTTPServerTransport>();
  const backendHandlers = makeMcpHandlers(backendTransports, async (req) => {
    const backendName = (req.params as Record<string, string>).backendName;
    const sessionCtx = sessionCtxFromReq(req);
    const mcpOptions: McpServerOptions = { filterBackend: backendName };
    return createMcpServer(config, sessionCtx, mcpOptions);
  });

  app.post('/mcp/:backendName', backendHandlers.post);
  app.get('/mcp/:backendName', backendHandlers.get);
  app.delete('/mcp/:backendName', backendHandlers.delete);

  // ── Agent runtime services ──────────────────────────────────
  if (config.postgresEnabled && startupPool) {
    const { initCache } = await import('./lib/redis.js');
    await initCache({
      enabled: config.redisEnabled,
      url: config.redisUrl,
      ttlSec: config.redisCacheTtlSec,
      namespace: config.redisCacheNamespace,
    });

    bootstrapBuiltinHooks(startupPool);

    // Platform-Config (Vault, OTel, HyDE, K8s-Impersonation) aus DB laden.
    // Settings sind in mcp_platform_settings als JSON per Category+Key,
    // runtime-overridable via /admin/platform-config.
    await loadAllPlatformConfigs(startupPool);
    await loadVaultConfigFromSettings(startupPool);

    // Weekly memory-consolidation cleanup — dedupes near-identical entries
    // that slipped past storeMemory's 0.88 contradiction guard. Threshold
    // 0.94 = conservative (real duplicates only). Skipped via env var
    // MEMORY_CONSOLIDATOR_DISABLED=true for debugging.
    if (process.env['MEMORY_CONSOLIDATOR_DISABLED'] !== 'true') {
      startMemoryConsolidator(startupPool, 24 * 60 * 60 * 1000);
    }

    logger.info('Direct LLM provider clients enabled');

    // Langfuse alert dispatcher — polls Langfuse for ERROR traces and
    // sub-threshold scores (compliance, quality), posts to Slack/Teams/
    // generic webhook. No-op until ALERTS_WEBHOOK_URL is set.
    startLangfuseAlerts();

    // Native provider-neutral rules evaluate the PostgreSQL trace/span store.
    // Persistent incidents provide restart-safe de-duplication and recovery.
    nativeAlertTimer = startNativeAlertWorker(startupPool, nativeAlertAiopsDispatcher);

    // Synthetic canaries — fire every 5 min against each enabled chat-mode
    // agent (or CANARIES_AGENT_IDS subset). De-flaked: alerts on 1st fail
    // and every 3rd consecutive fail thereafter; recovery alert on flip
    // back to OK. Opt-in: set CANARIES_ENABLED=1.
    startCanaries(startupPool);
    // Opt-in nightly read-only CI provider probes. LangGraph owns the target
    // credentials; Core only stores bounded status evidence.
    startCiProviderCanaryScheduler(startupPool);

    // PII redaction module — attach pool so it can read runtime settings
    // from mcp_platform_settings (toggleable from Platform Settings UI).
    // Cache TTL 30s; invalidated on POST /api/admin/settings/pii-redaction.
    {
      const { setRedactionPool, ensureSettingsLoaded } = await import('./lib/redaction.js');
      setRedactionPool(startupPool);
      ensureSettingsLoaded().then(s => logger.info({
        enabled: s.enabled, detectors: [...s.detectors], log_level: s.logLevel,
      }, 'PII redaction loaded')).catch(() => {});
    }
  }

  // ── Public Widget Routes (Phase 3) ─────────────────────────
  // Gated by config.publicWidgetEnabled (default off).
  // CSP middleware MUST be mounted BEFORE the route handlers so allowed-origin
  // CORS + frame-ancestors headers are set before any route response fires.
  if (config.postgresEnabled && sharedPool) {
    const { publicCspMiddleware } = await import('./public/publicCsp.js');
    const { registerPublicRoutes } = await import('./public/publicRoutes.js');
    const { getRedisClient: getWidgetRedis } = await import('./lib/redis.js');
    const publicRedis = getWidgetRedis();
    app.use('/public', publicCspMiddleware(sharedPool));
    if (publicRedis) {
      registerPublicRoutes(app, sharedPool, publicRedis, config);
    } else {
      logger.warn('Redis unavailable — public widget routes require Redis for single-use tokens; skipping registration');
    }
  }

  // ── Shared Conversation Links (anon read-only) ─────────────
  // Gated by config.shareLinksEnabled (default off). Independent of the
  // public widget flag. Per-IP rate-limited + a dedicated STRICT per-response CSP.
  if (config.shareLinksEnabled && config.postgresEnabled && sharedPool) {
    const shareLimiter = new RateLimiter(30); // 30 share views/min per IP
    setInterval(() => shareLimiter.cleanup(), 300_000).unref();
    // The app-wide helmet CSP is intentionally script-permissive for the admin/workflow
    // UI (scriptSrc allows 'unsafe-inline' + unpkg). The anon share surface must NOT inherit
    // that — escaping in sharePage.ts is the active XSS defense, but we add a strict CSP as
    // defense-in-depth (default-src 'none'; only inline <style> + same-origin form POST allowed).
    // publicCspMiddleware would be a no-op here (it only matches /widget/:slug), so set it inline.
    const SHARE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'";
    const shareHeaders = (res: express.Response): void => {
      // Set BEFORE the rate-limit early-return so even the 429/410 responses carry them.
      res.setHeader('X-Robots-Tag', 'noindex');
      res.setHeader('Content-Security-Policy', SHARE_CSP);
    };

    app.get('/share/:token', async (req, res) => {
      shareHeaders(res);
      if (!await shareLimiter.isAllowed(req.ip ?? 'unknown')) { res.status(429).type('html').send('<h2>Zu viele Anfragen</h2>'); return; }
      const rec = await getShareByToken(sharedPool!, String(req.params['token']));
      if (!rec) { res.status(410).type('html').send('<h2>Dieser Link ist abgelaufen oder wurde widerrufen.</h2>'); return; }
      if (rec.hasPassword) { res.type('html').send(renderPasswordGate(String(req.params['token']))); return; }
      res.type('html').send(renderSharePage({ title: rec.title, expires_at: rec.expires_at, messages: rec.redacted_messages }));
    });

    app.post('/share/:token/unlock', async (req, res) => {
      shareHeaders(res);
      if (!await shareLimiter.isAllowed(req.ip ?? 'unknown')) { res.status(429).type('html').send('<h2>Zu viele Anfragen</h2>'); return; }
      const token = String(req.params['token']);
      const rec = await getShareByToken(sharedPool!, token);
      if (!rec) { res.status(410).type('html').send('<h2>Dieser Link ist abgelaufen oder wurde widerrufen.</h2>'); return; }
      const ok = await verifySharePassword(rec, String(req.body?.password ?? ''));
      if (!ok) { res.status(401).type('html').send(renderPasswordGate(token, 'Falsches Passwort.')); return; }
      res.type('html').send(renderSharePage({ title: rec.title, expires_at: rec.expires_at, messages: rec.redacted_messages }));
    });
  }

  // ── SSE Transport ──────────────────────────────────────────
  // Legacy SSE transport for clients that don't support StreamableHTTP

  const sseTransports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req, res) => {
    try {
      const sessionCtx = sessionCtxFromReq(req);
      const sessionServer = await createMcpServer(config, sessionCtx);

      const transport = new SSEServerTransport('/sse/message', res);
      const sessionId = transport.sessionId;

      sseTransports.set(sessionId, transport);
      activeSessionsGauge.set(transports.size + sseTransports.size);

      logger.info({ sessionId }, 'SSE session initialized');

      transport.onclose = () => {
        sseTransports.delete(sessionId);
        activeSessionsGauge.set(transports.size + sseTransports.size);
        logger.info({ sessionId }, 'SSE session closed');
      };

      await sessionServer.server.connect(transport);
    } catch (error) {
      logger.error({ err: error }, 'SSE connection error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.post('/sse/message', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId || !sseTransports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    try {
      await sseTransports.get(sessionId)!.handlePostMessage(req, res);
    } catch (error) {
      logger.error({ err: error }, 'SSE message error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // ── Start server ────────────────────────────────────────────

  const httpServer: Server = app.listen(config.port, '0.0.0.0', () => {
    const backends = [
      config.postgresEnabled && 'PostgreSQL',
    ].filter(Boolean).join(', ') || 'none';

    logger.info({
      port: config.port,
      backends,
      dynamicTools: currentDynamicTools.length,
      rateLimitPerMinute: config.rateLimitPerMinute,
    }, 'Argus started');

    sendNotification(
      'Argus started',
      `Server running on port ${config.port} with backends: ${backends}. Dynamic tools: ${currentDynamicTools.length}`,
      'info',
    );
  });

  // ── Hot-Reload: poll for dynamic tool changes ───────────────

  // Delayed post-change verification for governed AIOps remediations. This
  // worker only observes; drift still requires a hash-bound human rollback
  // decision before any provider mutation is dispatched.
  if (incidentRemediationExecutor && config.aiopsPostChangeMonitorPollSec > 0) {
    const runPostChangeMonitors = async () => {
      try {
        const reconciliation = await incidentRemediationExecutor.reconcileInterruptedOperations(10);
        if (reconciliation.examined > 0) {
          logger.info(reconciliation, 'AIOps interrupted remediation operations reconciled');
        }
        const completed = await incidentRemediationExecutor.monitorDuePostChanges(10);
        if (completed > 0) logger.info({ completed }, 'AIOps post-change monitors completed');
      } catch (err) {
        logger.warn({ err }, 'AIOps post-change monitor worker failed');
      }
    };
    const postChangeMonitorTimer = setInterval(
      runPostChangeMonitors,
      config.aiopsPostChangeMonitorPollSec * 1_000,
    );
    postChangeMonitorTimer.unref();
    runPostChangeMonitors().catch(() => undefined);
    logger.info({
      intervalSec: config.aiopsPostChangeMonitorPollSec,
      delaySec: config.aiopsPostChangeMonitorDelaySec,
      reconcileStaleSec: config.aiopsRemediationReconcileStaleSec,
    }, 'AIOps post-change monitor worker started');
  }

  let hotReloadTimer: ReturnType<typeof setInterval> | null = null;
  if (config.postgresEnabled && sharedPool && config.dynamicToolsPollIntervalSec > 0) {
    const pollPool = sharedPool;

    hotReloadTimer = setInterval(async () => {
      try {
        const tableCheck = await pollPool.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables WHERE table_name = 'mcp_tools'
          ) AS exists
        `);
        if (!tableCheck.rows[0].exists) return;

        const freshTools = await loadDynamicTools(pollPool);
        const currentNames = new Set(currentDynamicTools.map(t => t.name));
        const freshNames = new Set(freshTools.map(t => t.name));

        // Detect changes - new sessions will pick up changes automatically
        if (freshTools.length !== currentDynamicTools.length ||
            freshTools.some(t => !currentNames.has(t.name))) {
          const newTools = freshTools.filter(t => !currentNames.has(t.name));
          const removedNames = [...currentNames].filter(n => !freshNames.has(n));
          currentDynamicTools = freshTools;
          logger.info({
            total: freshTools.length,
            new: newTools.map(t => t.name),
            removed: removedNames,
          }, 'Dynamic tools updated (new sessions will use updated tools)');
        }
      } catch (err) {
        logger.error({ err }, 'Dynamic tools hot-reload poll failed');
      }
    }, config.dynamicToolsPollIntervalSec * 1000);
    hotReloadTimer.unref();

    logger.info({ intervalSec: config.dynamicToolsPollIntervalSec }, 'Dynamic tools hot-reload polling enabled');
  }

  // ── Remote MCP Auto-Discovery: re-discover tools + reconnect on failure ──
  if (config.postgresEnabled && sharedPool) {
    const discoveryPool = sharedPool;
    const discoveryIntervalSec = config.dynamicToolsPollIntervalSec > 0
      ? Math.max(config.dynamicToolsPollIntervalSec * 5, 300)  // 5× tool poll, min 5 min
      : 300;

    const remoteMcpDiscoveryTimer = setInterval(async () => {
      const backends = getCustomBackends().filter(b => b.backend_type === 'mcp' && b.enabled);
      // audit (gateway resilience): reconnect/refresh backends in PARALLEL so one
      // slow/dead backend can't block re-discovery of all the others each tick.
      await Promise.allSettled(backends.map(async (backend) => {
        const conn = getRemoteConnection(backend.id);
        if (!conn || !conn.connected) {
          // Attempt reconnect for disconnected backends
          try {
            logger.info({ backend: backend.name }, 'Remote MCP auto-reconnect attempt');
            const newConn = await connectRemoteMcp(backend);
            if (newConn.connected) {
              await persistDiscoveredTools(discoveryPool, backend.id, newConn.tools);
              logger.info({ backend: backend.name, tools: newConn.tools.length }, 'Remote MCP reconnected');
            }
          } catch (err) {
            logger.warn({ err, backend: backend.name }, 'Remote MCP auto-reconnect failed');
          }
        } else {
          // Refresh tools for already-connected backends
          try {
            const fresh = await refreshRemoteMcpTools(backend.id);
            await persistDiscoveredTools(discoveryPool, backend.id, fresh);
          } catch (err) {
            logger.warn({ err, backend: backend.name }, 'Remote MCP tool refresh failed');
          }
        }
      }));
    }, discoveryIntervalSec * 1000);
    remoteMcpDiscoveryTimer.unref();

    logger.info({ intervalSec: discoveryIntervalSec }, 'Remote MCP auto-discovery polling enabled');
  }

  // ── Audit log cleanup: delete entries older than 90 days (daily) ──
  if (config.postgresEnabled) {
    const auditCleanupTimer = setInterval(() => cleanupAuditLog(config.auditLogRetentionDays), 86_400_000);
    auditCleanupTimer.unref();
    // Run once at startup to clean up immediately
    cleanupAuditLog(config.auditLogRetentionDays).catch(() => {});
  }

  // ── Cost tracking: log hourly summary ───────────────────────

  const costTrackingTimer = setInterval(() => logUsageSummary(), 3_600_000);
  costTrackingTimer.unref();

  // ── Self-monitoring: periodic health check ──────────────────

  const selfMonitorTimer = setInterval(async () => {
    try {
      const status = await getStatus(config, currentDynamicTools, getAllCustomBackends());
      const unreachable = status.backends.filter(b => b.enabled && b.reachable === false);
      if (unreachable.length > 0) {
        const names = unreachable.map(b => b.name).join(', ');
        logger.warn({ unreachable: names }, 'Self-monitoring: backends unreachable');
        sendNotification(
          'Backend Unreachable',
          `The following backends are unreachable: ${names}`,
          'warning',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Self-monitoring check failed');
    }
  }, 300_000);
  selfMonitorTimer.unref();

  // ── Metrics persistence: periodic snapshots + aggregation ───

  let metricsSnapshotTimer: ReturnType<typeof setInterval> | null = null;
  let metricsAggregateTimer: ReturnType<typeof setInterval> | null = null;
  if (config.postgresEnabled) {
    // Snapshot every 5 minutes
    metricsSnapshotTimer = setInterval(() => snapshotMetrics(), 300_000);
    metricsSnapshotTimer.unref();

    // Aggregate hourly data every hour
    metricsAggregateTimer = setInterval(() => aggregateHourlyMetrics(), 3_600_000);
    metricsAggregateTimer.unref();

    logger.info('Metrics persistence enabled (snapshot every 5min, aggregate hourly)');
  }

  // ── Graceful Shutdown ───────────────────────────────────────

  async function gracefulShutdown(signal: string, exitCode = 0) {
    logger.info({ signal, exitCode }, 'Graceful shutdown initiated');
    sendNotification('Argus shutting down', `Received ${signal}`, 'warning');

    httpServer.close();

    if (hotReloadTimer) clearInterval(hotReloadTimer);
    if (metricsSnapshotTimer) clearInterval(metricsSnapshotTimer);
    if (metricsAggregateTimer) clearInterval(metricsAggregateTimer);
    if (nativeAlertTimer) clearInterval(nativeAlertTimer);
    canonicalAuditIntegrityMonitor?.stop();
    auditReportWorker?.stop();
    goldenPathEvidenceWorker?.stop();
    fabricProfileDriftWorker?.stop();
    evaluationRecoveryWorker?.stop();
    clearInterval(costTrackingTimer);
    clearInterval(selfMonitorTimer);

    for (const [id, transport] of transports) {
      try {
        await transport.close();
      } catch { /* ignore */ }
      transports.delete(id);
    }

    for (const [id, transport] of sseTransports) {
      try {
        await transport.close();
      } catch { /* ignore */ }
      sseTransports.delete(id);
    }

    await flushLogBuffer();
    await recordServerEvent('stop', { uptime: `${Math.floor(process.uptime())}s` });
    await disconnectAllRemoteMcp();
    await closeAuditLog();
    await closeMetricsStore();
    await flushTelemetryWrites();
    await shutdownTracing();

    logger.info('Graceful shutdown complete');
    process.exit(exitCode);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

  // audit H1: an unhandled REJECTION (e.g. a detached `void asyncCall()` that
  // forgot a .catch) must NOT take the whole pod down — that turns an isolated
  // background-task bug into a service outage / crash-loop across all in-flight
  // requests. Log + metric and keep serving. uncaughtException is genuinely
  // unrecoverable (unknown sync state) → shut down, but with a NON-ZERO exit so
  // the orchestrator sees it as a crash, not a clean stop.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection — logged, NOT shutting down (see audit H1)');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — initiating shutdown');
    gracefulShutdown('uncaughtException', 1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
