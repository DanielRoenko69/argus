import type { AccessPolicyCompositeMutation, AccessPolicyGroupMutation, AccessPolicyResponse, AccessPolicySimulation, AccessPolicySimulationInput, AccessPolicyTechnicalIdentityMutation, AccessPolicyUserMutation, AdminApiKey, AdminApiKeyMutation, AdminApiKeySecret, AdminUser, AdminUserCreateMutation, AdminUserUpdateMutation, AgentSummary, AiopsOutcomeResponse, AuditEntriesResponse, AuditStatsResponse, CapabilityMutation, CapabilityPlaygroundMutation, CapabilityPlaygroundResult, CapabilityStudioResponse, ConsoleUser, DashboardMetricsResponse, FabricBundleDetailResponse, FabricBundleMutation, FabricBundleToolChangeInput, FabricConnectionDiscoveryResult, FabricConnectionMutation, FabricConnectionSaveResult, FabricConnectionTestResult, FabricManagementResponse, FabricProfileManifest, FabricProfilePlan, FabricProfileRecord, FabricResponse, FabricToolAssignmentInput, GovernanceResponse, HydeConfig, IncidentAiopsFeedbackMutation, IncidentAiopsFeedbackMutationResponse, IncidentAiopsFeedbackResponse, IncidentAiopsInvestigationsResponse, IncidentChangeCorrelationResponse, IncidentImpactResponse, IncidentRemediation, IncidentRemediationDryRun, IncidentRemediationExecutorCandidatesResponse, IncidentRemediationWriteAdaptersResponse, K8sImpersonationConfig, LiveActivityResponse, LogIndex, LogSearchResponse, NativeAlertRule, NativeAlertRuleMutation, NativeAlertsResponse, NativeDependencyMapResponse, NativeServiceCatalogRefreshInput, NativeServiceCatalogRefreshResponse, NativeServiceCatalogResponse, NativeServiceHealthResponse, NativeServiceTopologyResponse, NativeSlo, NativeSloMutation, NativeSlosResponse, ObservabilityAnalyticsResponse, OpenApiCapabilitySourcesResponse, OpenApiImportMutation, OpenApiImportResult, OpenApiImportSource, OpenApiPreview, OpenApiSourceCheckResult, OpenApiSourceRetirementConfirmation, OpenApiSourceRetirementPreview, OpenApiSourceRetirementResult, OtelConfig, OverviewResponse, PlatformBackendHealthResponse, PlatformConfigResponse, RunDetailResponse, RunPageV2, RunsResponse, TraceEvidenceResponse, UpstreamTokenExchangeConfig, UserConnectionsResponse, VaultConfigMutation, VaultConnectionTest, WorkflowSummary } from './types';
import type { WorkflowAgentPreflight } from './types';
import type { AgentCapabilityReadiness, AgentCompositeOption, AgentHookConfig, AgentModelOption, AgentRuntimeCodeContextPolicyMutation, AgentRuntimeProfile, AgentRuntimeProfileMutation, AgentSessionSummary, AgentStudioCatalog, AgentStudioSaveInput, AgentTemplate, AgentTemplateDraft, AgentTemplateDraftInput, AgentTemplatePreflight, AgentTemplateUpgradePreview, ManagedAgent, AgentBundleOption, RagIndexOption, SkillAdoptionResponse, SkillMutation, SkillOption, SpanEvidenceResponse } from './types';
import type { KnowledgeCatalog, KnowledgeDocument, KnowledgeEvalResult, KnowledgeProviderDefinition, KnowledgeSource, KnowledgeSourceMutation, KnowledgeTestResult, KnowledgeUploadResult, NativeCodeIndexSnapshot } from './types';
import type { LlmCatalog, LlmCredentialProfileMutation, LlmCredentialProfileRecord, LlmModelMutation, LlmModelRecord, LlmProviderMutation, LlmProviderRecord, LlmProviderTestResult } from './types';
import type { TraceFeedbackMutation, TraceFeedbackResponse } from './types';
import type { OnboardingCatalog, OnboardingAgent, OnboardingProvider, OnboardingModel } from './types';
import type { PublicWidgetCatalog, PublicWidgetDemoResponse, PublicWidgetMutation, PublicWidgetRecord } from './types';
import type { ComplianceRun, ComplianceRunDetailResponse, ComplianceWorkspaceResponse, RuntimeControlCatalog, RuntimePolicyMutation, RuntimePolicyRecord, RuntimePolicyTestResult } from './types';
import type { CiProviderCanaryOperationsResponse, CiProviderCanaryRunResponse, SyntheticCanaryConfig, SyntheticCanaryConfigMutation, SyntheticCanaryOperationsResponse, SyntheticCanaryRunResponse } from './types';
import type { AttachedHermesRunResponse, CodingRetryResponse, CodingThreadSummary, CodingThreadsResponse, CodexRuntimeStatus, ServiceTemplateCatalogResponse, ServiceTemplateInstallInput, ServiceTemplateInstallResult, SolutionPackAgentCardResponse, SolutionPackDiffResponse, SolutionPackMessageResponse, SolutionPackPreflightResponse, SolutionPackRollbackRequest, SolutionPackRollbackRequestsResponse, SolutionPackRuntimeAdapterCapabilitiesResponse, SolutionPackRuntimeAdapterStatusResponse, SolutionPacksResponse, SolutionPackTaskListResponse, SolutionPackTaskResponse } from './types';
import type { EvaluationDataset, EvaluationDatasetDetail, EvaluationExperiment, EvaluationExperimentDetail, EvaluationRegressionResponse, EvaluationComparison, EvaluationComparisonDetail, EvaluationComparisonInput, EvaluationPreflight, EvaluationTargets } from './types';
import type { FabricKubernetesCertification, FabricKubernetesCertificationHistoryResponse } from './types';
import type { HermesDevConnection, HermesDevConnectionCatalog, HermesDevConnectionSecret, HermesDevConnectionTest, HermesManagedMemoryProposal, HermesManagedRunEvents, HermesManagedRunResponse, HermesManagedRuntimeCatalog, HermesManagedRuntimePreflight } from './types';
import type { AiOpsEvidenceQueryPreflightInput, AiOpsEvidenceQueryPreflightResult, AiOpsGlobalReadiness, AiOpsServiceProfile, AiOpsServiceProfileConfig, AiOpsServiceProfileInvestigationSignal, AiOpsServiceProfileInvestigationStarted, AiOpsServiceProfileListResponse, AiOpsServiceProfileReadiness } from './types';
import type { AuditReportCatalog, AuditReportCadence, AuditReportDefinition, AuditReportRun, AuditReportType, AuditRetentionPlan, AuditRetentionPlanCatalog, CanonicalAuditEvidencePage, CanonicalAuditOutcome, CanonicalAuditRisk, ExternalEvidenceAnchor, ExternalEvidenceAnchorKind } from './types';
import type { AiActControlCatalog, AiComplianceDossier, AiComplianceDossierArtifactFormat, AiComplianceDossierCatalog, AiSystemClassificationInput, AiSystemControlAssessment, AiSystemControlAssessmentInput, AiSystemControlLedger, AiSystemCreateInput, AiSystemRegistryCatalog, AiSystemRegistryDetail, AiSystemRegistryItem, AiSystemReleaseInput, ConsoleNavigationCapabilityResponse, GlobalSearchResponse, IdentitySecurityStatus } from './types';
import type { WorkforceIdentityAccessResponse } from './types';
import type { PlatformExecutionCertificateCatalog } from './types';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export async function downloadEvaluationComparison(id:number,format:'json'|'csv'|'pdf',requestId:string) {
  const response=await fetch(`/api/admin/evaluations/comparisons/${id}/export/content?format=${format}`,{
    credentials:'same-origin',cache:'no-store',headers:{ 'Idempotency-Key':requestId,Accept:'application/vnd.argus.evaluation-artifact' },
  });
  if (!response.ok) {
    const body=await response.json().catch(() => null);
    throw new ApiRequestError(body?.error || `Export failed (${response.status})`,response.status,body?.code ?? null,body);
  }
  const bytes=await response.arrayBuffer(),expected=response.headers.get('X-Argus-Artifact-Sha256');
  if (!bytes.byteLength || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Empty or unverified export. Please retry.');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b => b.toString(16).padStart(2,'0')).join('');
  if (digest!==expected) throw new Error('Export integrity check failed. No file was saved.');
  const filename=response.headers.get('X-Argus-Artifact-Filename');
  if (!filename || !new RegExp(`^argus-evaluation-${id}-[a-f0-9]{12}\\.${format}$`).test(filename)) throw new Error('Unexpected export filename. No file was saved.');
  return { blob:new Blob([bytes],{ type:format==='pdf' ? 'application/pdf' : format==='json' ? 'application/json' : 'text/csv;charset=utf-8' }),filename };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body && !(typeof FormData !== 'undefined' && init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Authentication required');
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string | { code?: string; message?: string }; code?: string; details?: unknown } | null;
    const nested = body?.error && typeof body.error === 'object' ? body.error : null;
    throw new ApiRequestError(
      typeof body?.error === 'string' ? body.error : nested?.message || `Request failed with HTTP ${response.status}`,
      response.status,
      nested?.code || (typeof body?.code === 'string' ? body.code : null),
      body?.details,
    );
  }

  return response.json() as Promise<T>;
}

interface ConsoleProfileResponse {
  user: {
    id: number;
    username: string;
    display_name: string;
    role: string;
  };
}

/**
 * The shell only needs the authenticated identity. Keep it off the command
 * center endpoint, whose live health and trace aggregation can take longer.
 */
export const getConsoleUser = async (): Promise<ConsoleUser> => {
  const profile = await request<ConsoleProfileResponse>('/api/me');
  return {
    id: profile.user.id,
    username: profile.user.username,
    displayName: profile.user.display_name,
    role: profile.user.role,
  };
};

export const getOverview = (): Promise<OverviewResponse> => request('/api/ui/overview');
export const getPlatformBackendHealth = (): Promise<PlatformBackendHealthResponse> =>
  request('/api/admin/health/backends');
export const getPlatformExecutionCertificates = (): Promise<PlatformExecutionCertificateCatalog> =>
  request('/api/ui/platform-readiness/certificates/v1');
export const getIdentitySecurityStatus = (): Promise<IdentitySecurityStatus> =>
  request('/api/me/identity-security');
export const beginIdentitySecurityLink = (): Promise<{ authorizationUrl: string }> =>
  request('/api/me/identity-security/link', { method: 'POST' });
export const getConsoleNavigationCapabilities = (): Promise<ConsoleNavigationCapabilityResponse> =>
  request('/api/ui/navigation-capabilities');
export const searchWorkspace = (query: string, limit = 5): Promise<GlobalSearchResponse> => {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return request(`/api/ui/search/v1?${params}`);
};
export const getCanonicalAuditEvidence = (filters: {
  limit?: number; actorId?: string; action?: string; resourceType?: string; resourceId?: string;
  outcome?: CanonicalAuditOutcome | ''; risk?: CanonicalAuditRisk | ''; environment?: string; from?: string; to?: string;
} = {}): Promise<CanonicalAuditEvidencePage> => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value != null && value !== '') query.set(key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), String(value));
  return request(`/api/ui/audit/evidence/v1?${query}`);
};
export const getAuditReportCatalog = (): Promise<AuditReportCatalog> => request('/api/ui/audit/reports/v1');
export const createAuditReportDefinition = (input: { name: string; environment: string; reportType: AuditReportType; cadence: AuditReportCadence; timezone: string; scheduleHour: number; scheduleWeekday?: number; scheduleMonthday?: number; windowDays: number }): Promise<{ definition: AuditReportDefinition }> =>
  request('/api/ui/audit/report-definitions/v1', { method: 'POST', body: JSON.stringify(input) });
export const disableAuditReportDefinition = (id: string): Promise<{ definition: AuditReportDefinition }> =>
  request(`/api/ui/audit/report-definitions/v1/${encodeURIComponent(id)}/disable`, { method: 'POST' });
export const runAuditReport = (input: { name?: string; environment?: string; reportType?: AuditReportType; windowDays?: number }, definitionId?: string): Promise<{ run: AuditReportRun }> =>
  request(definitionId ? `/api/ui/audit/report-definitions/v1/${encodeURIComponent(definitionId)}/run` : '/api/ui/audit/report-runs/v1', { method: 'POST', body: JSON.stringify(input) });
export const reviewAuditReport = (id: string, input: { decision: 'approved' | 'rejected'; comment: string }): Promise<{ review: AuditReportRun['reviews'][number] }> =>
  request(`/api/ui/audit/report-runs/v1/${encodeURIComponent(id)}/reviews`, { method: 'POST', body: JSON.stringify(input) });
export const anchorAuditEvidencePack = (id: string, anchorKind: ExternalEvidenceAnchorKind): Promise<{ anchor: ExternalEvidenceAnchor; auditEventId: string; replayed: boolean }> =>
  request(`/api/ui/audit/report-runs/v1/${encodeURIComponent(id)}/external-anchors`, {
    method: 'POST',
    headers: { 'Idempotency-Key': globalThis.crypto.randomUUID() },
    body: JSON.stringify({ anchorKind }),
  });
export const getAuditRetentionPlans = (environment: string): Promise<AuditRetentionPlanCatalog> =>
  request(`/api/ui/audit/retention-plans/v1?environment=${encodeURIComponent(environment)}`);
export const createAuditRetentionPlan = (environment: string, batchLimit: number): Promise<{ plan: AuditRetentionPlan; replayed: boolean }> =>
  request('/api/ui/audit/retention-plans/v1', {
    method: 'POST', headers: { 'Idempotency-Key': globalThis.crypto.randomUUID() },
    body: JSON.stringify({ environment, batch_limit: batchLimit }),
  });
export const decideAuditRetentionPlan = (id: string, environment: string, decision: 'approved' | 'rejected', justification: string): Promise<{ plan: AuditRetentionPlan; replayed: boolean }> =>
  request(`/api/ui/audit/retention-plans/v1/${encodeURIComponent(id)}/decisions`, {
    method: 'POST', headers: { 'Idempotency-Key': globalThis.crypto.randomUUID() },
    body: JSON.stringify({ environment, decision, justification }),
  });
export const archiveAuditRetentionPlan = (id: string, environment: string, justification: string): Promise<{ archive: NonNullable<AuditRetentionPlan['archive']>; replayed: boolean }> =>
  request(`/api/ui/audit/retention-plans/v1/${encodeURIComponent(id)}/archive`, {
    method: 'POST', headers: { 'Idempotency-Key': globalThis.crypto.randomUUID() },
    body: JSON.stringify({ environment, justification }),
  });
export const runAuditRetentionRestoreDrill = (archiveId: string, environment: string, justification: string): Promise<{ drill: NonNullable<AuditRetentionPlan['archive']>['restoreDrills'][number]; replayed: boolean }> =>
  request(`/api/ui/audit/retention-archives/v1/${encodeURIComponent(archiveId)}/restore-drills`, {
    method: 'POST', headers: { 'Idempotency-Key': globalThis.crypto.randomUUID() },
    body: JSON.stringify({ environment, justification }),
  });
export const sealAuditRetentionChainSegment = (archiveId: string, environment: string, justification: string): Promise<{ segment: NonNullable<AuditRetentionPlan['archive']>['segment']; replayed: boolean }> =>
  request(`/api/ui/audit/retention-archives/v1/${encodeURIComponent(archiveId)}/seal-segment`, {
    method: 'POST', headers: { 'Idempotency-Key': globalThis.crypto.randomUUID() },
    body: JSON.stringify({ environment, justification }),
  });
export const auditRetentionVerifierUrl = '/api/ui/audit/retention-verifier/v1';
export const auditReportArtifactUrl = (id: string, format: 'pdf' | 'json' | 'jsonl' | 'csv', clientDelivery = false): string =>
  `/api/ui/audit/report-runs/v1/${encodeURIComponent(id)}/artifacts/${format}${clientDelivery ? '/content' : ''}`;
export async function downloadAuditReportArtifact(id: string, format: 'pdf' | 'json' | 'jsonl' | 'csv'): Promise<{ blob: Blob; filename: string; contentDigest: string | null }> {
  const response = await fetch(auditReportArtifactUrl(id, format, true), {
    credentials: 'same-origin',
    headers: { Accept: format === 'pdf' ? 'application/pdf' : format === 'csv' ? 'text/csv' : format === 'jsonl' ? 'application/x-ndjson' : 'application/json' },
  });
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Authentication required');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string; details?: unknown } | null;
    throw new ApiRequestError(body?.error || `Download failed with HTTP ${response.status}`, response.status, typeof body?.code === 'string' ? body.code : null, body?.details);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw new ApiRequestError('The report artifact is empty. A browser download extension may have intercepted the request.', 502, 'EMPTY_REPORT_ARTIFACT', null);
  const disposition = response.headers.get('content-disposition') ?? '';
  const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const quotedName = /filename="([^"]+)"/i.exec(disposition)?.[1];
  let filename = response.headers.get('x-argus-artifact-filename') || `argus-audit-report-${id}.${format}`;
  try { filename = encodedName ? decodeURIComponent(encodedName) : quotedName || filename; } catch { filename = quotedName || filename; }
  const contentType = response.headers.get('x-argus-artifact-content-type') || (format === 'pdf' ? 'application/pdf' : format === 'csv' ? 'text/csv;charset=utf-8' : format === 'jsonl' ? 'application/x-ndjson;charset=utf-8' : 'application/json;charset=utf-8');
  const blob = new Blob([bytes], { type: contentType });
  return { blob, filename, contentDigest: response.headers.get('content-digest') };
}
export const getAiSystemRegistry = (): Promise<AiSystemRegistryCatalog> =>
  request('/api/ui/compliance/ai-systems');
export const getAiActControlCatalog = (): Promise<{ schemaVersion: 1; kind: 'ai-act-control-catalog-response'; catalog: AiActControlCatalog }> =>
  request('/api/ui/compliance/ai-control-catalog');
export const getAiSystemRegistryDetail = (aiSystemId: string): Promise<AiSystemRegistryDetail> =>
  request(`/api/ui/compliance/ai-systems/${encodeURIComponent(aiSystemId)}`);
export const getAiSystemControlLedger = (aiSystemId: string): Promise<AiSystemControlLedger> =>
  request(`/api/ui/compliance/ai-systems/${encodeURIComponent(aiSystemId)}/controls`);
export const recordAiSystemControlAssessment = (aiSystemId: string, controlId: string, input: AiSystemControlAssessmentInput): Promise<{ schemaVersion: 1; kind: 'ai-system-control-assessment-result'; ledger: AiSystemControlLedger; assessment: AiSystemControlAssessment; auditEventId: string; replayed: boolean }> =>
  request(`/api/ui/compliance/ai-systems/${encodeURIComponent(aiSystemId)}/controls/${encodeURIComponent(controlId)}/assessments`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `console-ai-control-${crypto.randomUUID()}` },
    body: JSON.stringify(input),
  });
export const createAiSystem = (input: AiSystemCreateInput): Promise<AiSystemRegistryDetail> =>
  request('/api/ui/compliance/ai-systems', {
    method: 'POST',
    headers: { 'Idempotency-Key': `console-ai-system-create-${crypto.randomUUID()}` },
    body: JSON.stringify(input),
  });
export const classifyAiSystem = (aiSystemId: string, input: AiSystemClassificationInput): Promise<AiSystemRegistryDetail> =>
  request(`/api/ui/compliance/ai-systems/${encodeURIComponent(aiSystemId)}/classifications`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `console-ai-system-classify-${crypto.randomUUID()}` },
    body: JSON.stringify(input),
  });
export const releaseAiSystem = (aiSystemId: string, input: AiSystemReleaseInput): Promise<AiSystemRegistryDetail> =>
  request(`/api/ui/compliance/ai-systems/${encodeURIComponent(aiSystemId)}/release`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `console-ai-system-release-${crypto.randomUUID()}` },
    body: JSON.stringify(input),
  });
export const getAiComplianceDossiers = (aiSystemId: string): Promise<AiComplianceDossierCatalog> =>
  request(`/api/ui/compliance/ai-systems/${encodeURIComponent(aiSystemId)}/dossiers`);
export const generateAiComplianceDossier = (
  aiSystem: Pick<AiSystemRegistryItem, 'aiSystemId' | 'revision' | 'revisionSha256'>,
  sourceReportRunId: string,
): Promise<{ dossier: AiComplianceDossier; auditEventId: string }> =>
  request(`/api/ui/compliance/ai-systems/${encodeURIComponent(aiSystem.aiSystemId)}/dossiers`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `console-dossier-${crypto.randomUUID()}` },
    body: JSON.stringify({ expectedRevision: aiSystem.revision, expectedRevisionSha256: aiSystem.revisionSha256, sourceReportRunId }),
  });
export const aiComplianceDossierArtifactUrl = (dossierId: string, format: AiComplianceDossierArtifactFormat, clientDelivery = false): string =>
  `/api/ui/compliance/dossiers/${encodeURIComponent(dossierId)}/artifacts/${format}${clientDelivery ? '/content' : ''}`;
export async function downloadAiComplianceDossierArtifact(dossierId: string, format: AiComplianceDossierArtifactFormat): Promise<{ blob: Blob; filename: string; contentDigest: string | null }> {
  const response = await fetch(aiComplianceDossierArtifactUrl(dossierId, format, true), {
    credentials: 'same-origin',
    headers: { Accept: format === 'pdf' ? 'application/pdf' : format === 'signature' ? 'application/octet-stream' : 'application/json' },
  });
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Authentication required');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string | { code?: string; message?: string }; code?: string; details?: unknown } | null;
    const nested = body?.error && typeof body.error === 'object' ? body.error : null;
    throw new ApiRequestError(
      typeof body?.error === 'string' ? body.error : nested?.message || `Download failed with HTTP ${response.status}`,
      response.status,
      nested?.code || body?.code || null,
      body?.details,
    );
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw new ApiRequestError('The dossier artifact is empty. A browser download extension may have intercepted the request.', 502, 'EMPTY_DOSSIER_ARTIFACT', null);
  const filename = response.headers.get('x-argus-artifact-filename') || `argus-ai-compliance-dossier-${dossierId}.${format === 'signature' ? 'sig' : format}`;
  const contentType = response.headers.get('x-argus-artifact-content-type') || (format === 'pdf' ? 'application/pdf' : format === 'signature' ? 'application/octet-stream' : 'application/json;charset=utf-8');
  return { blob: new Blob([bytes], { type: contentType }), filename, contentDigest: response.headers.get('content-digest') };
}
export const getOnboardingCatalog = (): Promise<OnboardingCatalog> => request('/api/ui/onboarding/catalog');
export const createOnboardingProvider = (input: LlmProviderMutation): Promise<OnboardingProvider> =>
  request('/api/ui/onboarding/providers', { method: 'POST', body: JSON.stringify(input) });
export const testOnboardingProvider = (id: number): Promise<LlmProviderTestResult> =>
  request(`/api/ui/onboarding/providers/${id}/test`, { method: 'POST' });
export const createOnboardingModel = (input: LlmModelMutation): Promise<OnboardingModel> =>
  request('/api/ui/onboarding/models', { method: 'POST', body: JSON.stringify(input) });
export const createOnboardingAgent = (input: {
  name: string;
  label: string;
  description: string;
  model: string;
  system_prompt: string;
}): Promise<OnboardingAgent> => request('/api/ui/onboarding/agents', {
  method: 'POST',
  body: JSON.stringify(input),
});
export const installOnboardingStarterAgent = (name: string, input: { model: string; bundleIds: number[] }): Promise<OnboardingAgent> =>
  request(`/api/ui/onboarding/starter-agents/${encodeURIComponent(name)}/install`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const getSolutionPacks = (): Promise<SolutionPacksResponse> => request('/api/ui/solution-packs');
export const getAiOpsReadiness = (): Promise<AiOpsGlobalReadiness> =>
  request('/api/ui/observability/aiops/readiness');
export const getAiOpsServiceProfiles = (): Promise<AiOpsServiceProfileListResponse> =>
  request('/api/ui/observability/aiops/service-profiles');
export const getAiOpsServiceProfileReadiness = (profileId: number): Promise<AiOpsServiceProfileReadiness> =>
  request(`/api/ui/observability/aiops/service-profiles/${profileId}/readiness`);
export const preflightAiOpsEvidenceQuery = (input: AiOpsEvidenceQueryPreflightInput): Promise<AiOpsEvidenceQueryPreflightResult> =>
  request('/api/ui/observability/aiops/evidence-query-preflight', { method: 'POST', body: JSON.stringify(input) });
export const createAiOpsServiceProfile = (config: AiOpsServiceProfileConfig): Promise<{ schemaVersion: 1; profile: AiOpsServiceProfile }> =>
  request('/api/ui/observability/aiops/service-profiles', { method: 'POST', body: JSON.stringify({ config }) });
export const validateAiOpsServiceProfile = (profileId: number, expectedLatestRevision: number): Promise<{ schemaVersion: 1; readiness: AiOpsServiceProfileReadiness }> =>
  request(`/api/ui/observability/aiops/service-profiles/${profileId}/validate`, {
    method: 'POST',
    body: JSON.stringify({ expectedLatestRevision }),
  });
export const activateAiOpsServiceProfile = (profileId: number, revision: number): Promise<{ schemaVersion: 1; profile: AiOpsServiceProfile }> =>
  request(`/api/ui/observability/aiops/service-profiles/${profileId}/activate`, {
    method: 'POST',
    body: JSON.stringify({ revision, expectedLatestRevision: revision }),
  });
export const pauseAiOpsServiceProfile = (profileId: number, expectedLatestRevision: number): Promise<{ schemaVersion: 1; profile: AiOpsServiceProfile }> =>
  request(`/api/ui/observability/aiops/service-profiles/${profileId}/pause`, {
    method: 'POST',
    body: JSON.stringify({ expectedLatestRevision }),
  });
export const startAiOpsServiceProfileInvestigation = (
  profileId: number,
  signal: AiOpsServiceProfileInvestigationSignal,
): Promise<AiOpsServiceProfileInvestigationStarted> =>
  request(`/api/ui/observability/aiops/service-profiles/${profileId}/investigations`, {
    method: 'POST',
    body: JSON.stringify({ signal }),
  });
export const refreshSolutionPacks = (): Promise<SolutionPacksResponse> =>
  request('/api/admin/solution-packs/refresh', { method: 'POST' });
export const getSolutionPackDiff = (packId: string): Promise<SolutionPackDiffResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/diff`);
export const requestSolutionPackRollback = (
  packId: string,
  reason: string,
): Promise<{ rollback: SolutionPackRollbackRequest; message: string }> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ confirm: true, reason }),
  });
export const getSolutionPackRollbackRequests = (packId: string, limit = 20): Promise<SolutionPackRollbackRequestsResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/rollback-requests?limit=${limit}`);
export const getSolutionPackRuntimeAdapterCapabilities = (
  packId: string,
  adapterId: string,
): Promise<SolutionPackRuntimeAdapterCapabilitiesResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/runtime-adapters/${encodeURIComponent(adapterId)}/capabilities`);
export const getSolutionPackRuntimeAdapterStatus = (
  packId: string,
  adapterId: string,
): Promise<SolutionPackRuntimeAdapterStatusResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/runtime-adapters/${encodeURIComponent(adapterId)}/status`);
export const startAttachedHermesRun = (packId: string, adapterId: string, text: string): Promise<AttachedHermesRunResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/runtime-adapters/${encodeURIComponent(adapterId)}/attached-runs`, {
    method: 'POST', body: JSON.stringify({ input: { text } }),
  });
export const getAttachedHermesRun = (packId: string, adapterId: string, runId: string): Promise<AttachedHermesRunResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/runtime-adapters/${encodeURIComponent(adapterId)}/attached-runs/${encodeURIComponent(runId)}`);
export const stopAttachedHermesRun = (packId: string, adapterId: string, runId: string): Promise<AttachedHermesRunResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/runtime-adapters/${encodeURIComponent(adapterId)}/attached-runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
export const runSolutionPackPreflight = (
  packId: string,
  agentId: string,
  input: {
    workflowId?: string;
    repository?: string;
    bundleIds?: number[];
    runtimeMode?: 'auto' | 'default' | 'managed-hermes';
    resourceScope?: { kind: 'kubernetes'; backendId: number; targetId: string; namespace: string };
  } = {},
): Promise<SolutionPackPreflightResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/agents/${encodeURIComponent(agentId)}/a2a/message`, {
    method: 'POST',
    body: JSON.stringify({
      text: `Verify the ${packId} solution pack runtime boundary.`,
      data: {
        operation: input.workflowId ? 'workflow.preflight' : 'coding.preflight',
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.repository ? { input: { repository: input.repository } } : {}),
      },
      execution: {
        bundleIds: input.bundleIds ?? [],
        ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
        ...(input.resourceScope ? { resourceScope: input.resourceScope } : {}),
      },
    }),
  });
export const getSolutionPackAgentCard = (packId: string, agentId: string): Promise<SolutionPackAgentCardResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/agents/${encodeURIComponent(agentId)}/a2a/card`);
export const startSolutionPackWorkflow = (
  packId: string,
  agentId: string,
  requestInput: {
    workflowId: string;
    retry?: { sourceThreadId: string; sourceTaskId?: string; feedback: string };
    input: Record<string, unknown>;
    bundleIds: number[];
    runtimeMode?: 'auto' | 'default' | 'managed-hermes';
    resourceScope?: { kind: 'kubernetes'; backendId: number; targetId: string; namespace: string };
    sourceIncidentId?: number;
  },
): Promise<SolutionPackMessageResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/agents/${encodeURIComponent(agentId)}/a2a/message`, {
    method: 'POST',
    body: JSON.stringify({
      text: `Start ${requestInput.workflowId} through the governed ${packId} runtime.`,
      data: {
        operation: 'workflow.start',
        workflowId: requestInput.workflowId,
        input: requestInput.input,
        ...(requestInput.retry ? { retry: requestInput.retry } : {}),
      },
      execution: {
        bundleIds: requestInput.bundleIds,
        ...(requestInput.runtimeMode ? { runtimeMode: requestInput.runtimeMode } : {}),
        ...(requestInput.resourceScope ? { resourceScope: requestInput.resourceScope } : {}),
      },
      ...(requestInput.sourceIncidentId ? {
        correlation: { nativeAlertIncidentId: requestInput.sourceIncidentId },
      } : {}),
    }),
  });
export const startSolutionPackCoding = (
  packId: string,
  agentId: string,
  input: { ticketId: string; description: string; bundleIds: number[] },
): Promise<SolutionPackMessageResponse> =>
  startSolutionPackWorkflow(packId, agentId, {
    workflowId: 'ticket-to-pull-request',
    input: { ticket_id: input.ticketId, description: input.description },
    bundleIds: input.bundleIds,
  });
export const getSolutionPackTask = (packId: string, agentId: string, taskId: string): Promise<SolutionPackTaskResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/agents/${encodeURIComponent(agentId)}/a2a/tasks/${encodeURIComponent(taskId)}`);
export const getSolutionPackTasks = (
  packId: string,
  agentId: string,
  input: { limit?: number; cursor?: string } = {},
): Promise<SolutionPackTaskListResponse> => {
  const params = new URLSearchParams({ limit: String(input.limit ?? 6) });
  if (input.cursor) params.set('cursor', input.cursor);
  return request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/agents/${encodeURIComponent(agentId)}/a2a/tasks?${params.toString()}`);
};
export const getArgusDevRuns = (): Promise<CodingThreadsResponse> => request('/api/coding/threads');
export const getCodingThread = (threadId: string): Promise<CodingThreadSummary> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}`);
export interface CodingCheckpointHistory {
  threadId: string;
  parentThreadId: string | null;
  checkpoints: Array<{ checkpointId: string | null; parentCheckpointId: string | null;
    createdAt: string | null; step: number | null; nodes: string[]; next: string[]; interrupted: boolean }>;
}
export const getCodingCheckpoints = (threadId: string): Promise<CodingCheckpointHistory> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/checkpoints?limit=40`);

export interface CodingCheckpointRetryPreview {
  available: boolean; reason?: string; node?: string; checkpointId?: string; workspaceDigest?: string;
}
export const getCodingCheckpointRetry = (threadId: string): Promise<CodingCheckpointRetryPreview> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/checkpoint-retry`);
export interface CodingQaResponsePreview extends CodingCheckpointRetryPreview {
  reviewDigest?: string; sourceTraceId?: string; testPlan?: string; repairCount?: number;
  retryKind?: 'format' | 'missing_reviews'; missingDecisionIds?: string[];
}
export const recheckCodingQaResponse = (threadId: string): Promise<CodingQaResponsePreview> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/qa-response-recheck`);
export const continueCodingQaResponse = (threadId: string, reviewed: { checkpointId: string; workspaceDigest: string; reviewDigest: string }): Promise<unknown> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/qa-response-recheck`, { method: 'POST', body: JSON.stringify(reviewed) });
export const previewCodingQaRetry = (threadId: string): Promise<CodingQaResponsePreview> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/qa-retry`);
export const retryCodingQa = (threadId: string, reviewed: { checkpointId: string; workspaceDigest: string; reviewDigest: string }): Promise<unknown> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/qa-retry`, { method: 'POST', body: JSON.stringify(reviewed) });
export const continueCodingCheckpoint = (threadId: string, preview: { checkpointId: string; workspaceDigest: string }): Promise<{ thread_id: string; run_id: string; node: string; status: string }> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/checkpoint-retry`, { method: 'POST', body: JSON.stringify(preview) });
export const getCodexRuntimeStatus = (): Promise<CodexRuntimeStatus> => request('/api/ui/runtime/codex');
export const cancelCodexRuntimeRun = (runId: string): Promise<{ ok: boolean }> =>
  request(`/api/ui/runtime/codex/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
export const getClaudeRuntimeStatus = (): Promise<CodexRuntimeStatus> => request('/api/ui/runtime/claude');
export const cancelClaudeRuntimeRun = (runId: string): Promise<{ ok: boolean }> =>
  request(`/api/ui/runtime/claude/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
export const startRuntimeAuthSession = (
  provider: import('./types').RuntimeAuthProvider,
  input: { sso?: boolean } = {},
): Promise<import('./types').RuntimeAuthSession> => request(`/api/ui/runtime/${encodeURIComponent(provider)}/auth/sessions`, {
  method: 'POST',
  body: JSON.stringify(input),
});
export const getRuntimeAuthSession = (
  provider: import('./types').RuntimeAuthProvider,
  sessionId: string,
): Promise<import('./types').RuntimeAuthSession> =>
  request(`/api/ui/runtime/${encodeURIComponent(provider)}/auth/sessions/${encodeURIComponent(sessionId)}`);
export const submitRuntimeAuthCode = (
  provider: import('./types').RuntimeAuthProvider,
  sessionId: string,
  code: string,
): Promise<import('./types').RuntimeAuthSession> => request(`/api/ui/runtime/${encodeURIComponent(provider)}/auth/sessions/${encodeURIComponent(sessionId)}/code`, {
  method: 'POST',
  body: JSON.stringify({ code }),
});
export const cancelRuntimeAuthSession = (
  provider: import('./types').RuntimeAuthProvider,
  sessionId: string,
): Promise<import('./types').RuntimeAuthSession> => request(`/api/ui/runtime/${encodeURIComponent(provider)}/auth/sessions/${encodeURIComponent(sessionId)}`, {
  method: 'DELETE',
});
export const cancelSolutionPackTask = (packId: string, agentId: string, taskId: string): Promise<SolutionPackTaskResponse> =>
  request(`/api/admin/solution-packs/${encodeURIComponent(packId)}/agents/${encodeURIComponent(agentId)}/a2a/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
export const resumeCodingWorkflow = (
  threadId: string,
  input: { approved: boolean; feedback: string; rationale: string },
): Promise<{ ok: true }> => request(`/api/coding/threads/${encodeURIComponent(threadId)}/resume`, {
  method: 'POST',
  body: JSON.stringify(input),
});
export const getCodingApprovalRecovery = (threadId: string): Promise<{ available: boolean; checkpointId?: string;
  stage?: 'human_approval' | 'human_approval_pr'; approved?: boolean }> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/approval-recovery`);
export const recoverCodingApproval = (threadId: string, checkpointId: string): Promise<{ ok: true; recovered: true }> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/approval-recovery`, {
    method: 'POST', body: JSON.stringify({ checkpointId }),
  });
export const retryCodingWorkflow = (
  threadId: string,
  input: { error_context?: string },
): Promise<CodingRetryResponse> => request(`/api/coding/threads/${encodeURIComponent(threadId)}/retry`, {
  method: 'POST',
  body: JSON.stringify(input),
});
export const loadCodingIssue = (reference: string, bundleIds: number[]): Promise<{ snapshot: import('./types').RepositoryIssueSnapshot }> =>
  request('/api/coding/repository-issue', { method: 'POST', body: JSON.stringify({ reference, bundleIds }) });

export const submitCodingRequirements = (threadId: string, requirements: string, decision?: { decisionId: string; answers: Record<string, string> }): Promise<{ ok: true }> =>
  request(`/api/coding/threads/${encodeURIComponent(threadId)}/requirements`, {
    method: 'POST', body: JSON.stringify({ requirements, ...decision }),
  });
export const getPublicWidgets = (): Promise<PublicWidgetCatalog> => request('/api/ui/public-widgets');
export const savePublicWidget = (input: PublicWidgetMutation, id?: number): Promise<PublicWidgetRecord> =>
  request(id == null ? '/api/ui/public-widgets' : `/api/ui/public-widgets/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deletePublicWidget = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/ui/public-widgets/${id}`, { method: 'DELETE' });
export const provisionPublicWidgetDemo = (origin: string, websiteOrigins?: string[]): Promise<PublicWidgetDemoResponse> =>
  request('/api/ui/public-widgets/demo', { method: 'POST', body: JSON.stringify({ origin, websiteOrigins }) });
export const disablePublicWidgetDemo = (): Promise<PublicWidgetDemoResponse> =>
  request('/api/ui/public-widgets/demo/disable', { method: 'POST' });
export const getRuntimeControls = (): Promise<RuntimeControlCatalog> => request('/api/ui/runtime-controls');
export const saveRuntimePolicy = (input: RuntimePolicyMutation, id?: number): Promise<RuntimePolicyRecord> =>
  request(id == null ? '/api/ui/runtime-controls/policies' : `/api/ui/runtime-controls/policies/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deleteRuntimePolicy = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/ui/runtime-controls/policies/${id}`, { method: 'DELETE' });
export const testRuntimePolicy = (id: number, toolName: string, args: Record<string, unknown>): Promise<RuntimePolicyTestResult> =>
  request(`/api/ui/runtime-controls/policies/${id}/test`, {
    method: 'POST',
    body: JSON.stringify({ toolName, args }),
  });
export const getComplianceWorkspace = (): Promise<ComplianceWorkspaceResponse> =>
  request('/api/ui/compliance');
export const getComplianceRun = (id: number): Promise<ComplianceRunDetailResponse> =>
  request(`/api/ui/compliance/runs/${id}`);
export const startComplianceRun = (frameworkId: number, target: string): Promise<{ run: ComplianceRun }> =>
  request('/api/ui/compliance/runs', {
    method: 'POST',
    body: JSON.stringify({ frameworkId, target }),
  });
export const deleteComplianceRun = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/ui/compliance/runs/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation: `run-${id}` }),
  });
export const getLlmCatalog = (): Promise<LlmCatalog> => request('/api/ui/llm/catalog');
export const getAgentRuntimeProfiles = (): Promise<AgentRuntimeProfile[]> => request('/api/admin/runtime-profiles');
export const saveAgentRuntimeProfile = (input: AgentRuntimeProfileMutation, id?: number): Promise<AgentRuntimeProfile> =>
  request(id == null ? '/api/admin/runtime-profiles' : `/api/admin/runtime-profiles/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deleteAgentRuntimeProfile = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/admin/runtime-profiles/${id}`, { method: 'DELETE' });
export const updateAgentRuntimeCodeContextPolicy = (
  id: number,
  input: AgentRuntimeCodeContextPolicyMutation,
): Promise<AgentRuntimeProfile> => request(`/api/admin/runtime-profiles/${id}/code-context`, {
  method: 'PATCH',
  body: JSON.stringify(input),
});
export const saveLlmCredentialProfile = (input: LlmCredentialProfileMutation, id?: number): Promise<LlmCredentialProfileRecord> =>
  request(id == null ? '/api/ui/llm/credential-profiles' : `/api/ui/llm/credential-profiles/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deleteLlmCredentialProfile = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/ui/llm/credential-profiles/${id}`, { method: 'DELETE' });
export const saveLlmProvider = (input: LlmProviderMutation, id?: number): Promise<LlmProviderRecord> =>
  request(id == null ? '/api/ui/llm/providers' : `/api/ui/llm/providers/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deleteLlmProvider = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/ui/llm/providers/${id}`, { method: 'DELETE' });
export const testLlmProvider = (id: number): Promise<LlmProviderTestResult> =>
  request(`/api/ui/llm/providers/${id}/test`, { method: 'POST' });
export const saveLlmModel = (input: LlmModelMutation, id?: number): Promise<LlmModelRecord> =>
  request(id == null ? '/api/ui/llm/models' : `/api/ui/llm/models/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deleteLlmModel = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/ui/llm/models/${id}`, { method: 'DELETE' });
export const getAgents = (): Promise<AgentSummary[]> => request('/api/agents');
export const getSkills = (): Promise<SkillOption[]> => request('/api/admin/skills');
export const getSkillAdoption = (days: number): Promise<SkillAdoptionResponse> =>
  request(`/api/ui/skills/adoption?days=${encodeURIComponent(days)}`);
export const saveSkill = (input: SkillMutation, id?: number): Promise<SkillOption> =>
  request(id == null ? '/api/admin/skills' : `/api/admin/skills/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deleteSkill = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/admin/skills/${id}`, { method: 'DELETE' });
export async function getKnowledgeCatalog(): Promise<KnowledgeCatalog> {
  const [sources, providers] = await Promise.all([
    request<KnowledgeSource[]>('/api/admin/rag-indexes'),
    request<KnowledgeProviderDefinition[]>('/api/admin/rag-providers'),
  ]);
  const withDocuments = await Promise.all(sources.map(async source => ({
    ...source,
    documents: source.provider === 'pgvector'
      ? await request<KnowledgeDocument[]>(`/api/admin/rag-indexes/${source.id}/documents`)
      : [],
  })));
  return { sources: withDocuments, providers };
}

export const saveKnowledgeSource = (input: KnowledgeSourceMutation, id?: number): Promise<KnowledgeSource> =>
  request(id == null ? '/api/admin/rag-indexes' : `/api/admin/rag-indexes/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deleteKnowledgeSource = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/admin/rag-indexes/${id}`, { method: 'DELETE' });
export const uploadKnowledgeDocuments = (id: number, files: File[]): Promise<KnowledgeUploadResult> => {
  const body = new FormData();
  files.forEach(file => body.append('files', file));
  return request(`/api/admin/rag-indexes/${id}/upload`, { method: 'POST', body });
};
export const deleteKnowledgeDocument = (sourceId: number, documentId: number): Promise<{ deleted: boolean }> =>
  request(`/api/admin/rag-indexes/${sourceId}/documents/${documentId}`, { method: 'DELETE' });
export const testKnowledgeSource = (id: number, query: string): Promise<KnowledgeTestResult> =>
  request(`/api/admin/rag-indexes/${id}/test`, { method: 'POST', body: JSON.stringify({ query }) });
export const evaluateKnowledgeSource = (id: number, sampleSize: number): Promise<KnowledgeEvalResult> =>
  request(`/api/admin/rag-indexes/${id}/eval`, { method: 'POST', body: JSON.stringify({ sample_size: sampleSize }) });
export async function getAgentStudio(): Promise<AgentStudioCatalog> {
  const [agents, readiness, templates, drafts, models, credentialProfiles, composites, bundles, ragIndexes, codeIndexes, skills, runtimeProfiles] = await Promise.all([
    request<ManagedAgent[]>('/api/admin/agents'),
    request<AgentCapabilityReadiness[]>('/api/admin/agents/readiness'),
    request<AgentTemplate[]>('/api/admin/agent-templates'),
    request<AgentTemplateDraft[]>('/api/admin/agent-template-drafts'),
    request<{ data: AgentModelOption[] }>('/api/models').then(result => result.data.filter(model => model.enabled)),
    request<LlmCredentialProfileRecord[]>('/api/ui/llm/credential-profiles'),
    request<AgentCompositeOption[]>('/api/admin/composites'),
    request<AgentBundleOption[]>('/api/admin/bundles'),
    request<RagIndexOption[]>('/api/admin/rag-indexes'),
    getNativeCodeIndexes(100),
    request<SkillOption[]>('/api/admin/skills'),
    getAgentRuntimeProfiles(),
  ]);
  const visionByModel = new Map(models.map(model => [model.model_name, model.supports_vision]));
  const readinessByAgent = new Map(readiness.map(item => [item.agentId, item]));
  return {
    agents: agents.map(agent => ({
      ...agent,
      supports_vision: visionByModel.get(agent.model) ?? false,
      readiness: readinessByAgent.get(agent.id),
    })),
    templates,
    drafts,
    credentialProfiles,
    models,
    composites,
    bundles,
    ragIndexes,
    codeIndexes: codeIndexes.filter(snapshot => snapshot.status === 'ready'),
    skills,
    runtimeProfiles,
  };
}

export const getNativeCodeIndexes = (limit = 25): Promise<NativeCodeIndexSnapshot[]> =>
  request(`/api/admin/code-indexes?limit=${encodeURIComponent(limit)}`);

export const installAgentTemplate = (
  name: string,
  input: { model: string; runtimeProfileId: number | null; bundleIds: number[] },
): Promise<ManagedAgent> =>
  request(`/api/admin/agent-templates/${encodeURIComponent(name)}/install`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const previewAgentTemplate = (
  name: string,
  input: { model: string; runtimeProfileId: number | null; bundleIds: number[] },
): Promise<AgentTemplatePreflight> =>
  request(`/api/admin/agent-templates/${encodeURIComponent(name)}/preview`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const getAgentTemplateUpgradePreview = (name: string, agentId?: number): Promise<AgentTemplateUpgradePreview> =>
  request(`/api/admin/agent-templates/${encodeURIComponent(name)}/upgrade-preview${agentId == null ? '' : `?agentId=${agentId}`}`);

export const applyAgentTemplateUpgrade = (name: string, agentId?: number): Promise<{ agent: ManagedAgent; preview: AgentTemplateUpgradePreview }> =>
  request(`/api/admin/agent-templates/${encodeURIComponent(name)}/upgrade`, {
    method: 'POST',
    ...(agentId == null ? {} : { body: JSON.stringify({ agentId }) }),
  });

export const saveAgentTemplateDraft = (input: AgentTemplateDraftInput): Promise<AgentTemplateDraft> =>
  request(`/api/admin/agent-template-drafts/${encodeURIComponent(input.name)}`, {
    method: 'PUT', body: JSON.stringify(input),
  });

export const deleteAgentTemplateDraft = (name: string): Promise<{ deleted: boolean }> =>
  request(`/api/admin/agent-template-drafts/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const previewAgentTemplateDraft = (
  name: string,
  input: { model: string; runtimeProfileId: number | null; bundleIds: number[] },
): Promise<AgentTemplatePreflight> =>
  request(`/api/admin/agent-template-drafts/${encodeURIComponent(name)}/preview`, {
    method: 'POST', body: JSON.stringify(input),
  });

export const publishAgentTemplateDraft = (name: string): Promise<AgentTemplate> =>
  request(`/api/admin/agent-template-drafts/${encodeURIComponent(name)}/publish`, { method: 'POST' });

export const getAgentHookConfig = (id: number): Promise<AgentHookConfig> =>
  request(`/api/admin/agents/${id}/hook-config`);

export async function saveAgentStudioAgent(input: AgentStudioSaveInput, id?: number): Promise<ManagedAgent> {
  const saved = await request<ManagedAgent>(id == null ? '/api/admin/agents' : `/api/admin/agents/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input.agent),
  });
  const assignmentResults = await Promise.allSettled([
    request<ManagedAgent>(`/api/admin/agents/${saved.id}/rag-indexes`, {
      method: 'PUT', body: JSON.stringify({ rag_index_ids: input.ragIndexIds }),
    }),
    request<ManagedAgent>(`/api/admin/agents/${saved.id}/code-indexes`, {
      method: 'PUT', body: JSON.stringify({ snapshot_ids: input.codeIndexIds }),
    }),
    request<ManagedAgent>(`/api/admin/agents/${saved.id}/skills`, {
      method: 'PUT', body: JSON.stringify({ skill_ids: input.skillIds }),
    }),
    request<AgentHookConfig>(`/api/admin/agents/${saved.id}/hook-config`, {
      method: 'PUT', body: JSON.stringify(input.hookConfig),
    }),
  ]);
  const failed = assignmentResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) {
    throw new Error(`Agent core saved, but a dependent assignment failed: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`);
  }
  return saved;
}

export const deleteAgentStudioAgent = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/admin/agents/${id}`, { method: 'DELETE' });
export const getAgentSessions = (id: number): Promise<AgentSessionSummary[]> =>
  request(`/api/admin/agents/${id}/sessions`);
export const resyncAgentIdentity = (id: number): Promise<{ resynced: boolean; objectId: string }> =>
  request(`/api/admin/agents/${id}/entra-resync`, { method: 'POST' });
export const getWorkflows = (): Promise<WorkflowSummary[]> => request('/api/admin/workflows');
export const getWorkflowAgentPreflight = (workflowId: number): Promise<WorkflowAgentPreflight> =>
  request(`/api/admin/workflows/${workflowId}/agent-preflight`);
export const getEvaluationDatasets = (): Promise<{ datasets: EvaluationDataset[] }> => request('/api/admin/evaluations/datasets');
export const getEvaluationStarterSets = ():Promise<{ starter_sets:import('./types').EvaluationStarterSet[] }> => request('/api/admin/evaluations/starter-sets');
export const getQualityQueue = ():Promise<import('./types').QualityQueue> => request('/api/admin/evaluations/review-queue');
export const getQualityReview = (traceId:string):Promise<{ item:import('./types').QualityItem; history:import('./types').QualityReview[]; history_truncated:boolean }> =>
  request(`/api/admin/evaluations/review-queue/${encodeURIComponent(traceId)}`);
export const saveQualityReview = ({ traceId,input,requestId }:{ traceId:string; input:Record<string,unknown>; requestId:string }):Promise<{ review:import('./types').QualityReview }> =>
  request(`/api/admin/evaluations/review-queue/${encodeURIComponent(traceId)}`,{ method:'POST',headers:{ 'Idempotency-Key':requestId },body:JSON.stringify(input) });
export const importEvaluationStarterSet = ({ key,digest,requestId }:{ key:string; digest:string; requestId:string }):Promise<{ dataset:EvaluationDataset }> =>
  request(`/api/admin/evaluations/starter-sets/${encodeURIComponent(key)}/import`,{ method:'POST',headers:{ 'Idempotency-Key':requestId },body:JSON.stringify({ reviewed:true,reviewed_content_sha256:digest }) });
export const previewEvaluationTrace = (source:{ trace_id:string; span_id:string|null }):Promise<import('./types').EvaluationTracePreview> =>
  request('/api/admin/evaluations/trace-preview',{ method:'POST',body:JSON.stringify(source) });
export const addEvaluationCaseFromTrace = ({ datasetId,input,requestId }:{ datasetId:number; input:Record<string,unknown>; requestId:string }):Promise<{ case:{ id:number } }> =>
  request(`/api/admin/evaluations/datasets/${datasetId}/from-trace`,{ method:'POST',headers:{ 'Idempotency-Key':requestId },body:JSON.stringify(input) });
export const getEvaluationTargets = (agentId:number):Promise<EvaluationTargets> => request(`/api/admin/evaluations/targets?agent_id=${agentId}`);
export const preflightEvaluationComparison = (input:EvaluationComparisonInput):Promise<EvaluationPreflight> => request('/api/admin/evaluations/comparisons/preflight',{ method:'POST',body:JSON.stringify(input) });
export const getEvaluationComparisons = ():Promise<{ comparisons:EvaluationComparison[] }> => request('/api/admin/evaluations/comparisons');
export const getEvaluationComparison = (id:number):Promise<EvaluationComparisonDetail> => request(`/api/admin/evaluations/comparisons/${id}`);
export type ExecutionSettings={ model:string;runtime_profile_id:number|null };
export type ExecutionRelease={ id:number;agent_id:number;action:'applied'|'rolled_back';source_release_id:number|null;before_settings:ExecutionSettings;after_settings:ExecutionSettings;reason:string;created_at:string;actor_user_id:number };
export type ExecutionReleasePreview={ agent_id:number;before_settings:ExecutionSettings;after_settings:ExecutionSettings;preview_sha256:string;limitation:string;before_target?:string;after_target?:string;before_reasoning?:string|null;after_reasoning?:string|null };
export type PromptRevision={ id:number;agent_id:number;title:string;system_prompt:string;content_sha256:string;source_head_sha256:string;source_prompt:string|null;created_at:string;created_by_user_id:number };
export type SkillRevision={ id:number;skill_id:number;title:string;content:string;content_sha256:string;origin:'migration'|'catalog'|'draft';source_head_sha256:string|null;created_at:string;created_by_user_id:number|null;editable:boolean };
export type AgentSkillState={ agent_id:number;label:string;source_head_sha256:string;model_ref:string|null;skills:Array<{ id:number;name:string;active:SkillRevision;revisions:SkillRevision[] }> };
export type SkillRelease={ id:number;agent_id:number;skill_id:number;revision_id:number;previous_revision_id:number;action:'applied'|'rolled_back';source_release_id:number|null;reason:string;created_at:string;actor_user_id:number };
export type SkillReleasePreview={ agent_id:number;skill_id:number;revision_id:number;previous_revision_id:number;before_content:string;after_content:string;preview_sha256:string;limitation:string };
export const getAgentSkillState=(id:number):Promise<AgentSkillState>=>request(`/api/admin/evaluations/agents/${id}/skill-revisions`);
export const createAgentSkillRevision=({ id,input,requestId }:{ id:number;input:{ skill_id:number;title:string;content:string;source_head_sha256:string };requestId:string }):Promise<{ revision:{ id:number } }>=>request(`/api/admin/evaluations/agents/${id}/skill-revisions`,{ method:'POST',headers:{ 'Idempotency-Key':requestId },body:JSON.stringify(input) });
export const getSkillReleases=(id:number):Promise<{ releases:SkillRelease[] }>=>request(`/api/admin/evaluations/comparisons/${id}/skill-releases`);
export const previewSkillChange=(id:number,rollback=false):Promise<SkillReleasePreview>=>request(rollback ? `/api/admin/evaluations/skill-releases/${id}/rollback-preview` : `/api/admin/evaluations/comparisons/${id}/skill-release-preview`,{ method:'POST',body:'{}' });
export const confirmSkillChange=({ id,rollback,input,requestId }:{ id:number;rollback:boolean;input:{ preview_sha256:string;reason:string;confirm:true };requestId:string }):Promise<{ release:SkillRelease }>=>request(rollback ? `/api/admin/evaluations/skill-releases/${id}/rollback` : `/api/admin/evaluations/comparisons/${id}/skill-release`,{ method:'POST',headers:{ 'Idempotency-Key':requestId },body:JSON.stringify(input) });
export type AgentPromptState={ agent_id:number;label:string;source_head_sha256:string;system_prompt:string|null;active_revision_id:number|null;editable:boolean;model_ref:string|null;revisions:PromptRevision[] };
export type PromptRelease={ id:number;agent_id:number;revision_id:number;action:'applied'|'rolled_back';source_release_id:number|null;reason:string;created_at:string;actor_user_id:number };
export type PromptReleasePreview={ agent_id:number;revision_id:number;before_prompt:string|null;after_prompt:string|null;preview_sha256:string;limitation:string };
export const getAgentPromptState=(id:number):Promise<AgentPromptState>=>request(`/api/admin/evaluations/agents/${id}/prompt-revisions`);
export const createAgentPromptRevision=({ id,input,requestId }:{ id:number;input:{ title:string;system_prompt:string;source_head_sha256:string };requestId:string }):Promise<{ revision:PromptRevision }>=>request(`/api/admin/evaluations/agents/${id}/prompt-revisions`,{ method:'POST',headers:{ 'Idempotency-Key':requestId },body:JSON.stringify(input) });
export const getPromptReleases=(id:number):Promise<{ releases:PromptRelease[] }>=>request(`/api/admin/evaluations/comparisons/${id}/prompt-releases`);
export const previewPromptChange=(id:number,rollback=false):Promise<PromptReleasePreview>=>request(rollback ? `/api/admin/evaluations/prompt-releases/${id}/rollback-preview` : `/api/admin/evaluations/comparisons/${id}/prompt-release-preview`,{ method:'POST',body:'{}' });
export const confirmPromptChange=({ id,rollback,input,requestId }:{ id:number;rollback:boolean;input:{ preview_sha256:string;reason:string;confirm:true };requestId:string }):Promise<{ release:PromptRelease }>=>request(rollback ? `/api/admin/evaluations/prompt-releases/${id}/rollback` : `/api/admin/evaluations/comparisons/${id}/prompt-release`,{ method:'POST',headers:{ 'Idempotency-Key':requestId },body:JSON.stringify(input) });
export const getExecutionReleases=(id:number):Promise<{ releases:ExecutionRelease[] }> => request(`/api/admin/evaluations/comparisons/${id}/releases`);
export const previewExecutionChange=(id:number,rollback=false):Promise<ExecutionReleasePreview> => request(rollback ? `/api/admin/evaluations/releases/${id}/rollback-preview` : `/api/admin/evaluations/comparisons/${id}/release-preview`,{ method:'POST',body:'{}' });
export const confirmExecutionChange=({ id,rollback,input,requestId }:{ id:number;rollback:boolean;input:{ preview_sha256:string;reason:string;confirm:true };requestId:string }):Promise<{ release:ExecutionRelease }> =>
  request(rollback ? `/api/admin/evaluations/releases/${id}/rollback` : `/api/admin/evaluations/comparisons/${id}/release`,{ method:'POST',body:JSON.stringify(input),headers:{ 'Idempotency-Key':requestId } });
export const createEvaluationComparison = ({ input,requestId }:{ input:Record<string,unknown>; requestId:string }):Promise<{ comparison:EvaluationComparison }> =>
  request('/api/admin/evaluations/comparisons',{ method:'POST',body:JSON.stringify(input),headers:{ 'Idempotency-Key':requestId } });
export const runEvaluationComparison = ({ id,requestId }:{ id:number; requestId:string }):Promise<{ comparison_id:number; status:string }> =>
  request(`/api/admin/evaluations/comparisons/${id}/run`,{ method:'POST',body:JSON.stringify({ acknowledge_cost:true }),headers:{ 'Idempotency-Key':requestId } });
export const cancelEvaluationComparison = ({ id,requestId }:{ id:number; requestId:string }):Promise<{ comparison_id:number; status:string }> =>
  request(`/api/admin/evaluations/comparisons/${id}/cancel`,{ method:'POST',body:'{}',headers:{ 'Idempotency-Key':requestId } });
export const getEvaluationDataset = (id: number): Promise<EvaluationDatasetDetail> => request(`/api/admin/evaluations/datasets/${id}`);
export const createEvaluationDataset = (input: Record<string, unknown>): Promise<{ dataset: EvaluationDataset }> => request('/api/admin/evaluations/datasets', { method: 'POST', body: JSON.stringify(input) });
export const addEvaluationCase = (id: number, input: Record<string, unknown>): Promise<{ case: unknown }> => request(`/api/admin/evaluations/datasets/${id}/cases`, { method: 'POST', body: JSON.stringify(input) });
export const activateEvaluationDataset = (id: number): Promise<{ dataset: EvaluationDataset }> => request(`/api/admin/evaluations/datasets/${id}/activate`, { method: 'POST' });
export const getEvaluationExperiments = (): Promise<{ experiments: EvaluationExperiment[] }> => request('/api/admin/evaluations/experiments');
export const getEvaluationExperiment = (id: number): Promise<EvaluationExperimentDetail> => request(`/api/admin/evaluations/experiments/${id}`);
export const getEvaluationRegression = (id: number): Promise<EvaluationRegressionResponse> => request(`/api/admin/evaluations/experiments/${id}/regression`);
export const createEvaluationExperiment = (input: Record<string, unknown>): Promise<{ experiment: EvaluationExperiment }> => request('/api/admin/evaluations/experiments', { method: 'POST', body: JSON.stringify(input) });
export const runEvaluationExperiment = (id: number): Promise<{ experiment_id: number; status: string }> => request(`/api/admin/evaluations/experiments/${id}/run`, { method: 'POST' });
export const cancelEvaluationExperiment = (id: number): Promise<{ experiment_id: number; status: string }> => request(`/api/admin/evaluations/experiments/${id}/cancel`, { method:'POST',body:'{}',headers:{ 'Idempotency-Key':crypto.randomUUID() } });
export const retryEvaluationExperiment = (input: { id:number; caseIds:number[]; requestId:string }): Promise<{ experiment_id:number; status:string }> => request(`/api/admin/evaluations/experiments/${input.id}/retry`, {
  method:'POST',headers:{ 'Idempotency-Key':input.requestId },body:JSON.stringify({ case_ids:input.caseIds,acknowledge_possible_duplicate_cost:true }),
});
export const getUserConnections = (): Promise<UserConnectionsResponse> => request('/api/connections');
export const getWorkforceIdentityAccess = (): Promise<WorkforceIdentityAccessResponse> =>
  request('/api/ui/identity-access/workforce');
export const disconnectUserConnection = (backendId: number): Promise<{ ok: boolean }> =>
  request(`/api/connections/${backendId}`, { method: 'DELETE' });
export const getAdminApiKeys = (): Promise<AdminApiKey[]> => request('/api/admin/api-keys');
export const getApiKeyBindingTargets = (): Promise<import('./types').ApiKeyBindingTarget[]> => request('/api/admin/api-keys/binding-targets');
export const saveAdminApiKey = (input: AdminApiKeyMutation, id?: number): Promise<AdminApiKeySecret | AdminApiKey> =>
  request(id == null ? '/api/admin/api-keys' : `/api/admin/api-keys/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const rotateAdminApiKey = (id: number): Promise<AdminApiKeySecret> =>
  request(`/api/admin/api-keys/${id}/rotate`, { method: 'POST' });
export const deleteAdminApiKey = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
export const getAdminUsers = (): Promise<AdminUser[]> => request('/api/admin/users');
export const getHermesDevConnections = (): Promise<HermesDevConnectionCatalog> =>
  request('/api/hermes-dev/connections');
export const createHermesDevConnection = (input: { label: string; bundleIds: number[] }): Promise<HermesDevConnectionSecret> =>
  request('/api/hermes-dev/connections', { method: 'POST', body: JSON.stringify(input) });
export const testHermesDevConnection = (id: number): Promise<HermesDevConnectionTest> =>
  request(`/api/hermes-dev/connections/${id}/test`, { method: 'POST' });
export const rotateHermesDevConnection = (id: number): Promise<HermesDevConnectionSecret> =>
  request(`/api/hermes-dev/connections/${id}/rotate`, { method: 'POST' });
export const revokeHermesDevConnection = (id: number): Promise<{ connection: HermesDevConnection }> =>
  request(`/api/hermes-dev/connections/${id}`, { method: 'DELETE' });
export const getHermesManagedRuntime = (): Promise<HermesManagedRuntimeCatalog> =>
  request('/api/hermes-dev/runtime');
export const preflightHermesManagedRuntime = (input: { coreAgentName: string; bundleIds: number[] }): Promise<HermesManagedRuntimePreflight> =>
  request('/api/hermes-dev/runtime/preflight', { method: 'POST', body: JSON.stringify(input) });
export const getHermesManagedRuns = (): Promise<{ runs: HermesManagedRunResponse[] }> =>
  request('/api/hermes-dev/runtime/runs');
export const startHermesManagedRun = (input: {
  requestId: string;
  coreAgentName: string;
  bundleIds: number[];
  input: { text: string };
  instructions?: string;
  limits: { deadlineSeconds: number; maxToolCalls: number; maxOutputBytes: number };
}): Promise<HermesManagedRunResponse> => request('/api/hermes-dev/runtime/runs', {
  method: 'POST', body: JSON.stringify(input),
});
export const getHermesManagedRun = (runId: string): Promise<HermesManagedRunResponse> =>
  request(`/api/hermes-dev/runtime/runs/${encodeURIComponent(runId)}`);
export const getHermesManagedRunEvents = (runId: string): Promise<HermesManagedRunEvents> =>
  request(`/api/hermes-dev/runtime/runs/${encodeURIComponent(runId)}/events`);
export const cancelHermesManagedRun = (runId: string, reason = 'Stopped by developer in Argus Dev'): Promise<HermesManagedRunResponse> =>
  request(`/api/hermes-dev/runtime/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), reason }),
  });
export const getHermesManagedMemoryProposals = (): Promise<{ proposals: HermesManagedMemoryProposal[] }> =>
  request('/api/hermes-dev/runtime/memory-proposals');
export const decideHermesManagedMemoryProposal = (
  proposalId: string,
  decision: 'accepted' | 'rejected',
): Promise<{ id: string; status: 'accepted' | 'rejected' }> =>
  request(`/api/hermes-dev/runtime/memory-proposals/${encodeURIComponent(proposalId)}/decision`, {
    method: 'POST', body: JSON.stringify({ decision }),
  });
export const createAdminUser = (input: AdminUserCreateMutation): Promise<AdminUser> =>
  request('/api/admin/users', { method: 'POST', body: JSON.stringify(input) });
export const updateAdminUser = (id: number, input: AdminUserUpdateMutation): Promise<AdminUser> =>
  request(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(input) });
export const changeAdminUserPassword = (id: number, password: string): Promise<{ updated: boolean }> =>
  request(`/api/admin/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) });
export const deleteAdminUser = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/admin/users/${id}`, { method: 'DELETE' });
export const getPlatformConfig = (): Promise<PlatformConfigResponse> =>
  request('/api/admin/platform-config/all');
export const saveVaultConfig = (input: VaultConfigMutation): Promise<{ ok: boolean }> =>
  request('/api/admin/platform-config/vault', { method: 'PUT', body: JSON.stringify(input) });
export const testVaultConfig = (): Promise<VaultConnectionTest> =>
  request('/api/admin/platform-config/vault/test', { method: 'POST' });
export const saveOtelConfig = (input: OtelConfig): Promise<{ ok: boolean }> =>
  request('/api/admin/platform-config/otel', { method: 'PUT', body: JSON.stringify(input) });
export const saveHydeConfig = (input: HydeConfig): Promise<{ ok: boolean }> =>
  request('/api/admin/platform-config/hyde', { method: 'PUT', body: JSON.stringify(input) });
export const saveK8sImpersonationConfig = (input: K8sImpersonationConfig): Promise<{ ok: boolean }> =>
  request('/api/admin/platform-config/k8s', { method: 'PUT', body: JSON.stringify(input) });
export const saveUpstreamTokenExchangeConfig = (input: UpstreamTokenExchangeConfig): Promise<{ ok: boolean }> =>
  request('/api/admin/platform-config/upstream-token-exchange', { method: 'PUT', body: JSON.stringify(input) });
export const getRuns = (): Promise<RunsResponse> => request('/api/ui/runs');
export const getRunFamilies = (): Promise<RunPageV2> =>
  request('/api/ui/runs/v2?view=root&include_children=full&limit=100');
export const getRunDetail = (kind: 'workflow' | 'agent', id: string): Promise<RunDetailResponse> =>
  request(`/api/ui/runs/${kind}/${encodeURIComponent(id)}`);
export const getTraceEvidence = (id: string): Promise<TraceEvidenceResponse> =>
  request(`/api/ui/observability/traces/${encodeURIComponent(id)}`);
export const getSpanEvidence = (spanId: string): Promise<SpanEvidenceResponse> =>
  request(`/api/ui/observability/spans/${encodeURIComponent(spanId)}`);
export const getTraceFeedback = (traceId: string): Promise<TraceFeedbackResponse> =>
  request(`/api/ui/observability/traces/${encodeURIComponent(traceId)}/feedback`);
export const submitTraceFeedback = (traceId: string, input: TraceFeedbackMutation): Promise<TraceFeedbackResponse> =>
  request(`/api/ui/observability/traces/${encodeURIComponent(traceId)}/feedback`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const getDashboardMetrics = (hours = 24): Promise<DashboardMetricsResponse> =>
  request(`/api/metrics/dashboard?hours=${hours}`);
export const getObservabilityAnalytics = (hours = 24): Promise<ObservabilityAnalyticsResponse> =>
  request(`/api/ui/observability/analytics?hours=${hours}`);
export const getNativeAlerts = (): Promise<NativeAlertsResponse> =>
  request('/api/ui/observability/alerts');
export const getAiopsOutcomes = (days = 30): Promise<AiopsOutcomeResponse> =>
  request(`/api/ui/observability/aiops/outcomes?days=${Math.max(1, Math.min(90, Math.trunc(days)))}`);
export const getNativeServiceCatalog = (): Promise<NativeServiceCatalogResponse> =>
  request('/api/ui/observability/service-catalog');
export const refreshNativeServiceCatalog = (input: NativeServiceCatalogRefreshInput): Promise<NativeServiceCatalogRefreshResponse> =>
  request('/api/ui/observability/service-catalog/refresh', { method: 'POST', body: JSON.stringify(input) });
export const getIncidentChangeCorrelations = (incidentId: number): Promise<IncidentChangeCorrelationResponse> =>
  request(`/api/ui/observability/alerts/${incidentId}/correlations`);
export const getIncidentImpact = (incidentId: number): Promise<IncidentImpactResponse> =>
  request(`/api/ui/observability/alerts/${incidentId}/impact`);
export const getIncidentAiopsInvestigations = (incidentId: number): Promise<IncidentAiopsInvestigationsResponse> =>
  request(`/api/ui/observability/alerts/${incidentId}/aiops-investigations`);
export const getIncidentAiopsFeedback = (incidentId: number, taskLinkId: number): Promise<IncidentAiopsFeedbackResponse> =>
  request(`/api/ui/observability/alerts/${incidentId}/aiops-investigations/${taskLinkId}/feedback`);
export const submitIncidentAiopsFeedback = (
  incidentId: number,
  taskLinkId: number,
  input: IncidentAiopsFeedbackMutation,
): Promise<IncidentAiopsFeedbackMutationResponse> =>
  request(`/api/ui/observability/alerts/${incidentId}/aiops-investigations/${taskLinkId}/feedback`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(input),
  });
export const decideIncidentRemediation = (
  incidentId: number,
  remediationId: number,
  input: { decision: 'approve' | 'reject'; version: number; comment?: string | null },
): Promise<{ remediation: IncidentRemediation }> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const getIncidentRemediationExecutorCandidates = (
  incidentId: number,
  remediationId: number,
): Promise<IncidentRemediationExecutorCandidatesResponse> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/executor-candidates`);
export const runIncidentRemediationDryRun = (
  incidentId: number,
  remediationId: number,
  input: { version: number; bundleId: number; toolName: string; arguments: Record<string, string | number | boolean> },
): Promise<{ remediation: IncidentRemediation; dryRun: IncidentRemediationDryRun }> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/dry-runs`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const getIncidentRemediationWriteAdapters = (
  incidentId: number,
  remediationId: number,
): Promise<IncidentRemediationWriteAdaptersResponse> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/write-adapters`);
export const createIncidentRemediationChangePlan = (
  incidentId: number,
  remediationId: number,
  input: {
    version: number;
    adapterKey: 'kubernetes.scale.v1' | 'kubernetes.deployment-revision-rollback.v1';
    bundleId: number;
    writeToolName: string;
    workloadKind: 'Deployment' | 'StatefulSet';
    workloadName: string;
    desiredReplicas?: number;
    targetRevision?: number;
  },
): Promise<{ remediation: IncidentRemediation }> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/change-plans`, {
    method: 'POST', body: JSON.stringify(input),
  });
export const decideIncidentRemediationChangePlan = (
  incidentId: number,
  remediationId: number,
  planId: number,
  input: { version: number; planHash: string; decision: 'approve' | 'reject'; comment?: string | null },
): Promise<{ remediation: IncidentRemediation }> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/change-plans/${planId}/decision`, {
    method: 'POST', body: JSON.stringify(input),
  });
export const executeIncidentRemediationChangePlan = (
  incidentId: number,
  remediationId: number,
  planId: number,
  input: { version: number; planHash: string },
): Promise<{ remediation: IncidentRemediation }> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/change-plans/${planId}/execute`, {
    method: 'POST', body: JSON.stringify(input),
  });
export const checkIncidentRemediationPostChange = (
  incidentId: number,
  remediationId: number,
  planId: number,
  input: { monitorId: number; version: number; rollbackHash: string },
): Promise<{ remediation: IncidentRemediation }> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/change-plans/${planId}/post-change-monitor/check`, {
    method: 'POST', body: JSON.stringify(input),
  });
export const decideIncidentRemediationPostChangeRollback = (
  incidentId: number,
  remediationId: number,
  planId: number,
  input: { monitorId: number; version: number; rollbackHash: string; decision: 'approve' | 'reject'; comment?: string | null },
): Promise<{ remediation: IncidentRemediation }> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/change-plans/${planId}/post-change-monitor/decision`, {
    method: 'POST', body: JSON.stringify(input),
  });
export const executeIncidentRemediationPostChangeRollback = (
  incidentId: number,
  remediationId: number,
  planId: number,
  input: { monitorId: number; version: number; rollbackHash: string },
): Promise<{ remediation: IncidentRemediation }> =>
  request(`/api/ui/observability/alerts/${incidentId}/remediations/${remediationId}/change-plans/${planId}/post-change-monitor/execute-rollback`, {
    method: 'POST', body: JSON.stringify(input),
  });
export const createNativeAlert = (input: NativeAlertRuleMutation): Promise<NativeAlertRule> =>
  request('/api/ui/observability/alerts', { method: 'POST', body: JSON.stringify(input) });
export const updateNativeAlert = (id: number, input: NativeAlertRuleMutation): Promise<NativeAlertRule> =>
  request(`/api/ui/observability/alerts/${id}`, { method: 'PUT', body: JSON.stringify(input) });
export const deleteNativeAlert = (id: number): Promise<{ deleted: boolean; archived: boolean }> =>
  request(`/api/ui/observability/alerts/${id}`, { method: 'DELETE' });
export const evaluateNativeAlerts = (): Promise<{ evaluated: number; fired: number; recovered: number; skipped: boolean }> =>
  request('/api/ui/observability/alerts/evaluate', { method: 'POST' });
export const installNativeAlertTemplate = (templateId: string): Promise<{ created: number; skipped: number }> =>
  request(`/api/ui/observability/alerts/templates/${encodeURIComponent(templateId)}/install`, { method: 'POST' });
export const getNativeServiceHealth = (hours = 24): Promise<NativeServiceHealthResponse> =>
  request(`/api/ui/observability/health?hours=${hours}`);
export const getSyntheticCanaries = (): Promise<SyntheticCanaryOperationsResponse> =>
  request('/api/ui/observability/canaries');
export const saveSyntheticCanaryConfig = (input: SyntheticCanaryConfigMutation): Promise<SyntheticCanaryConfig> =>
  request('/api/ui/observability/canaries/config', { method: 'PUT', body: JSON.stringify(input) });
export const runSyntheticCanaries = (agentIds?: number[]): Promise<SyntheticCanaryRunResponse> =>
  request('/api/ui/observability/canaries/run', {
    method: 'POST',
    body: JSON.stringify(agentIds === undefined ? {} : { agentIds }),
  });
export const getCiProviderCanaries = (): Promise<CiProviderCanaryOperationsResponse> =>
  request('/api/ui/observability/ci-canaries');
export const runCiProviderCanaries = (): Promise<CiProviderCanaryRunResponse> =>
  request('/api/ui/observability/ci-canaries/run', { method: 'POST', body: JSON.stringify({}) });
export const getNativeSlos = (): Promise<NativeSlosResponse> =>
  request('/api/ui/observability/slos');
export const createNativeSlo = (input: NativeSloMutation): Promise<NativeSlo> =>
  request('/api/ui/observability/slos', { method: 'POST', body: JSON.stringify(input) });
export const updateNativeSlo = (id: number, input: NativeSloMutation): Promise<NativeSlo> =>
  request(`/api/ui/observability/slos/${id}`, { method: 'PUT', body: JSON.stringify(input) });
export const deleteNativeSlo = (id: number): Promise<{ deleted: boolean }> =>
  request(`/api/ui/observability/slos/${id}`, { method: 'DELETE' });
export const getNativeDependencyMap = (hours = 24): Promise<NativeDependencyMapResponse> =>
  request(`/api/ui/observability/dependencies?hours=${hours}`);
export const getNativeServiceTopology = (): Promise<NativeServiceTopologyResponse> =>
  request('/api/ui/observability/service-topology');
export const getLiveActivity = (): Promise<LiveActivityResponse> => request('/api/admin/activity/live');
export const getAuditStats = (hours = 24): Promise<AuditStatsResponse> =>
  request(`/api/audit/stats?hours=${hours}`);
export const getAuditEntries = (filters: {
  tool?: string;
  isError?: boolean;
  from?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<AuditEntriesResponse> => {
  const params = new URLSearchParams();
  if (filters.tool) params.set('tool', filters.tool);
  if (filters.isError) params.set('is_error', 'true');
  if (filters.from) params.set('from', filters.from);
  params.set('limit', String(filters.limit ?? 100));
  params.set('offset', String(filters.offset ?? 0));
  return request(`/api/audit/entries?${params}`);
};
export const getLogIndices = (): Promise<{ indices: LogIndex[] }> => request('/api/logs/indices');
export const searchLogs = (filters: {
  q?: string;
  level?: string;
  index?: string;
  source?: string;
  traceId?: string;
  rootTraceId?: string;
  spanId?: string;
  agentId?: number;
  workflowExecutionId?: number;
  size?: number;
} = {}): Promise<LogSearchResponse> => {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.level) params.set('level', filters.level);
  if (filters.index) params.set('index', filters.index);
  if (filters.source) params.set('source', filters.source);
  if (filters.traceId) params.set('trace', filters.traceId);
  if (filters.rootTraceId) params.set('root_trace', filters.rootTraceId);
  if (filters.spanId) params.set('span', filters.spanId);
  if (filters.agentId) params.set('agent', String(filters.agentId));
  if (filters.workflowExecutionId) params.set('workflow_execution', String(filters.workflowExecutionId));
  params.set('size', String(filters.size ?? 200));
  return request(`/api/logs/search?${params}`);
};
export const getFabric = (): Promise<FabricResponse> => request('/api/ui/mcp-fabric');
export const getFabricManagement = (): Promise<FabricManagementResponse> =>
  request('/api/ui/mcp-fabric/manage');
export const getFabricProfiles = (): Promise<{ profiles: FabricProfileRecord[]; groups: import('./types').FabricProfileSsoGroup[] }> =>
  request('/api/ui/mcp-fabric/profiles');
export const getFabricProfileVersions = (profileId: number): Promise<{
  versions: import('./types').FabricProfileVersionRecord[];
}> => request(`/api/ui/mcp-fabric/profiles/${profileId}/versions`);
export const getFabricProfileVersionDiff = (
  profileId: number,
  fromRevision: number,
  toRevision: number,
): Promise<{ diff: import('./types').FabricProfileVersionDiff }> =>
  request(`/api/ui/mcp-fabric/profiles/${profileId}/versions/diff?from=${fromRevision}&to=${toRevision}`);
export const getFabricProfileRestoreRequests = (profileId?: number): Promise<{
  requests: import('./types').FabricProfileRestoreRequest[];
}> => request(`/api/ui/mcp-fabric/profiles/restores${profileId == null ? '' : `?profileId=${profileId}`}`);
export const requestFabricProfileRestore = (profileId: number, input: {
  targetRevision: number;
  mappings: import('./types').FabricProfileMappings;
  planToken: string;
  comment?: string;
}): Promise<{ request: import('./types').FabricProfileRestoreRequest }> =>
  request(`/api/ui/mcp-fabric/profiles/${profileId}/restores`, { method: 'POST', body: JSON.stringify(input) });
export const decideFabricProfileRestore = (requestId: string, input: {
  decision: 'approved' | 'rejected'; comment: string;
}): Promise<{ request: import('./types').FabricProfileRestoreRequest }> =>
  request(`/api/ui/mcp-fabric/profiles/restores/${encodeURIComponent(requestId)}/decision`, { method: 'POST', body: JSON.stringify(input) });
export const applyFabricProfileRestore = (requestId: string): Promise<{
  profile: FabricProfileRecord;
  bundleIds: number[];
  compositeId: number | null;
  groupBindings: Array<{ logicalName: string; groupName: string; compositeId: number }>;
  restoreRequest: import('./types').FabricProfileRestoreRequest;
}> => request(`/api/ui/mcp-fabric/profiles/restores/${encodeURIComponent(requestId)}/apply`, { method: 'POST' });
export const checkFabricProfileDrift = (profileId: number): Promise<{
  drift: import('./types').FabricProfileDrift;
  replayed: boolean;
}> => request(`/api/ui/mcp-fabric/profiles/${profileId}/drift/check`, { method: 'POST' });
export const exportFabricProfile = (input: {
  name: string;
  label: string;
  description: string;
  version: string;
  bundleIds: number[];
  createComposite: boolean;
  groupBindings: Array<{ logicalName: string; required: boolean }>;
}): Promise<{ profile: FabricProfileRecord }> =>
  request('/api/ui/mcp-fabric/profiles/export', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const previewFabricProfileImport = (input: {
  manifest: unknown;
  mappings: import('./types').FabricProfileMappings;
}): Promise<{ plan: FabricProfilePlan }> =>
  request('/api/ui/mcp-fabric/profiles/import/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const applyFabricProfileImport = (input: {
  manifest: FabricProfileManifest;
  mappings: import('./types').FabricProfileMappings;
  planToken: string;
}): Promise<{
  profile: FabricProfileRecord;
  bundleIds: number[];
  compositeId: number | null;
  groupBindings: Array<{ logicalName: string; groupName: string; compositeId: number }>;
}> =>
  request('/api/ui/mcp-fabric/profiles/import/apply', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const importKubernetesCertification = (
  backendId: number,
  report: unknown,
): Promise<{ certification: FabricKubernetesCertification }> =>
  request('/api/ui/mcp-fabric/kubernetes-certifications', {
    method: 'POST',
    body: JSON.stringify({ backendId, report }),
  });
export const getKubernetesCertificationHistory = (
  backendId: number,
  targetId: string,
  limit = 10,
): Promise<FabricKubernetesCertificationHistoryResponse> =>
  request(`/api/ui/mcp-fabric/kubernetes-certifications/${backendId}/${encodeURIComponent(targetId)}/history?limit=${limit}`);
export const getCapabilityStudio = (): Promise<CapabilityStudioResponse> =>
  request('/api/ui/mcp-fabric/capabilities');
export const saveCapability = (
  input: CapabilityMutation,
  id?: number,
): Promise<{ capability: { id: number; name: string; updatedAt: string }; warning: string | null }> =>
  request(id == null ? '/api/ui/mcp-fabric/capabilities' : `/api/ui/mcp-fabric/capabilities/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const setCapabilityState = (
  id: number,
  enabled: boolean,
): Promise<{ ok: boolean; enabled: boolean; updatedAt: string }> =>
  request(`/api/ui/mcp-fabric/capabilities/${id}/state`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
export const runCapabilityPlayground = (
  id: number,
  input: CapabilityPlaygroundMutation,
): Promise<CapabilityPlaygroundResult> =>
  request(`/api/ui/mcp-fabric/capabilities/${id}/playground`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const deleteCapability = (id: number, confirmName: string): Promise<{ ok: boolean }> =>
  request(`/api/ui/mcp-fabric/capabilities/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
  });
export const previewOpenApiImport = (input: OpenApiImportSource): Promise<OpenApiPreview> =>
  request('/api/ui/mcp-fabric/capabilities/openapi/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const importOpenApiCapabilities = (input: OpenApiImportMutation): Promise<OpenApiImportResult> =>
  request('/api/ui/mcp-fabric/capabilities/openapi/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const getOpenApiCapabilitySources = (): Promise<OpenApiCapabilitySourcesResponse> =>
  request('/api/ui/mcp-fabric/capability-sources');
export const checkOpenApiCapabilitySource = (
  id: number,
  specText?: string,
): Promise<OpenApiSourceCheckResult> =>
  request(`/api/ui/mcp-fabric/capability-sources/${id}/check`, {
    method: 'POST',
    body: JSON.stringify(specText == null ? {} : { specText }),
  });
export const getOpenApiSourceRetirement = (id: number): Promise<OpenApiSourceRetirementPreview> =>
  request(`/api/ui/mcp-fabric/capability-sources/${id}/retirement`);
export const retireOpenApiSource = (
  id: number,
  confirmation: OpenApiSourceRetirementConfirmation,
): Promise<OpenApiSourceRetirementResult> =>
  request(`/api/ui/mcp-fabric/capability-sources/${id}/retire`, {
    method: 'POST',
    body: JSON.stringify(confirmation),
  });
export const getAccessPolicies = (): Promise<AccessPolicyResponse> =>
  request('/api/ui/access-policies');
export const simulateAccessPolicy = (input: AccessPolicySimulationInput): Promise<AccessPolicySimulation> =>
  request('/api/ui/access-policies/simulate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const saveAccessPolicyComposite = (
  input: AccessPolicyCompositeMutation,
  id?: number,
): Promise<{ composite: { id: number; name: string } }> =>
  request(id == null ? '/api/ui/access-policies/composites' : `/api/ui/access-policies/composites/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deleteAccessPolicyComposite = (id: number): Promise<{ ok: boolean }> =>
  request(`/api/ui/access-policies/composites/${id}`, { method: 'DELETE' });
export const saveAccessPolicyGroup = (input: AccessPolicyGroupMutation): Promise<{ ok: boolean; groupName: string }> =>
  request('/api/ui/access-policies/groups', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
export const saveAccessPolicyUser = (input: AccessPolicyUserMutation): Promise<{ ok: boolean; userId: number }> =>
  request('/api/ui/access-policies/users', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
export const saveAccessPolicyTechnicalIdentity = (
  input: AccessPolicyTechnicalIdentityMutation,
): Promise<{ ok: boolean; kind: 'agent' | 'api_key'; id: number }> =>
  request('/api/ui/access-policies/technical-identities', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
export const saveFabricBundle = (
  input: FabricBundleMutation,
  id?: number,
): Promise<{ bundle: { id: number; name: string; label: string }; backendIds: number[] }> =>
  request(id == null ? '/api/ui/mcp-fabric/bundles' : `/api/ui/mcp-fabric/bundles/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const assignFabricTools = (
  input: FabricToolAssignmentInput,
): Promise<{ ok: boolean; bundleId: number; assigned: number }> =>
  request('/api/ui/mcp-fabric/tool-assignments', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const deleteFabricBundle = (id: number): Promise<{ ok: boolean; preservedConnections: boolean }> =>
  request(`/api/ui/mcp-fabric/bundles/${id}`, { method: 'DELETE' });
export const saveFabricConnection = (
  input: FabricConnectionMutation,
  id?: number,
): Promise<FabricConnectionSaveResult> =>
  request(id == null ? '/api/ui/mcp-fabric/connections' : `/api/ui/mcp-fabric/connections/${id}`, {
    method: id == null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  });
export const deleteFabricConnection = (id: number): Promise<{ ok: boolean; toolsDeleted: number }> =>
  request(`/api/ui/mcp-fabric/connections/${id}`, { method: 'DELETE' });
export const getServiceTemplateCatalog = (): Promise<ServiceTemplateCatalogResponse> =>
  request('/api/ui/mcp-fabric/templates');
export const installServiceTemplate = (
  templateId: string,
  input: ServiceTemplateInstallInput,
): Promise<ServiceTemplateInstallResult> =>
  request(`/api/ui/mcp-fabric/templates/${encodeURIComponent(templateId)}/install`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const testFabricConnection = (id: number): Promise<FabricConnectionTestResult> =>
  request(`/api/ui/mcp-fabric/connections/${id}/test`, { method: 'POST' });
export const discoverFabricConnection = (
  id: number,
): Promise<FabricConnectionDiscoveryResult> =>
  request(`/api/ui/mcp-fabric/connections/${id}/discover`, { method: 'POST' });
export const changeMcpTrust = (
  backendId: string,
  action: 'trust' | 'quarantine',
  comment?: string,
): Promise<{ ok: boolean }> =>
  request(`/api/admin/backends/${encodeURIComponent(backendId)}/trust`, {
    method: 'POST',
    body: JSON.stringify({ action, comment: comment || null }),
  });
export const getFabricBundle = (id: number): Promise<FabricBundleDetailResponse> =>
  request(`/api/ui/mcp-fabric/bundles/${id}`);
export const updateFabricBundleAccess = (
  bundleId: number,
  input: { kind: 'user' | 'api_key' | 'agent' | 'workflow'; id: number; granted: boolean },
): Promise<{ ok: boolean; granted: boolean }> =>
  request(`/api/ui/mcp-fabric/bundles/${bundleId}/access`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
export const changeFabricBundleTools = (
  bundleId: number,
  input: FabricBundleToolChangeInput,
): Promise<{
  ok: boolean;
  action: 'remove' | 'move';
  sourceBundleId: number;
  targetBundleId: number | null;
  changed: number;
}> => request(`/api/ui/mcp-fabric/bundles/${bundleId}/tools`, {
  method: 'PATCH',
  body: JSON.stringify(input),
});
export const getGovernance = (): Promise<GovernanceResponse> => request('/api/ui/governance');
export const decideWorkflowReview = (
  workflowId: number,
  action: 'approve' | 'reject',
  comment: string,
): Promise<{ ok: boolean; status: string }> =>
  request(`/api/workflows/${workflowId}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ comment }),
  });
export const decideRuntimeApproval = (
  approvalId: number,
  action: 'approve' | 'reject',
  comment: string,
): Promise<{ ok: boolean; status: string; expiresAt?: string | null; resumeScheduled?: boolean }> =>
  request(`/api/ui/governance/runtime-approvals/${approvalId}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ comment }),
  });
