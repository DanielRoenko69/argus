import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncidentRemediation, NativeAlertsResponse, OverviewResponse } from '../types';
import { AlertsPage } from './AlertsPage';

const api = vi.hoisted(() => ({
  createNativeAlert: vi.fn(),
  createIncidentRemediationChangePlan: vi.fn(),
  checkIncidentRemediationPostChange: vi.fn(),
  decideIncidentRemediation: vi.fn(),
  decideIncidentRemediationChangePlan: vi.fn(),
  decideIncidentRemediationPostChangeRollback: vi.fn(),
  deleteNativeAlert: vi.fn(),
  evaluateNativeAlerts: vi.fn(),
  getFabricManagement: vi.fn(),
  getIncidentAiopsInvestigations: vi.fn(),
  getIncidentAiopsFeedback: vi.fn(),
  getIncidentChangeCorrelations: vi.fn(),
  getIncidentImpact: vi.fn(),
  getIncidentRemediationExecutorCandidates: vi.fn(),
  getIncidentRemediationWriteAdapters: vi.fn(),
  getAiopsOutcomes: vi.fn(),
  getNativeAlerts: vi.fn(),
  getNativeServiceCatalog: vi.fn(),
  getOverview: vi.fn(),
  getSolutionPacks: vi.fn(),
  installNativeAlertTemplate: vi.fn(),
  refreshNativeServiceCatalog: vi.fn(),
  runIncidentRemediationDryRun: vi.fn(),
  submitIncidentAiopsFeedback: vi.fn(),
  executeIncidentRemediationChangePlan: vi.fn(),
  executeIncidentRemediationPostChangeRollback: vi.fn(),
  updateNativeAlert: vi.fn(),
}));
vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: new Date().toISOString(),
  user: { id: 1, username: 'alex', displayName: 'Alex', role: 'platform_admin' },
  attention: [],
  stats: { activeRuns: 0, successRate24h: 100, completed24h: 1, failed24h: 0, workflowsInReview: 0, connectedTools: 2, agents: 2 },
  health: { state: 'healthy', healthy: 2, total: 2, degraded: 0 },
  runs: [],
};

const alerts: NativeAlertsResponse = {
  generatedAt: new Date().toISOString(),
  summary: { enabledRules: 1, firingRules: 1, incidents24h: 1, recovered24h: 1 },
  templates: [{
    id: 'latency-slo', name: 'Latency SLO', description: 'Protect interactive latency.', category: 'latency',
    rules: [{ name: 'SLO · P95 latency regression', description: '', metric: 'p95_latency_ms', operator: 'gt', threshold: 30000, windowMinutes: 30, minSamples: 10, severity: 'warning', scopeKind: 'all', scopeValue: null, cooldownMinutes: 60, notify: true, enabled: true, aiopsAutoInvestigate: false, aiopsBundleIds: [], aiopsResourceScope: null, aiopsService: null, aiopsEnvironment: null }],
    installedRules: 0, installed: false,
  }],
  rules: [{
    id: 7, name: 'Latency regression', description: 'Pages the platform team.', metric: 'latency_regression_percent', operator: 'gt',
    threshold: 10, windowMinutes: 15, minSamples: 5, severity: 'critical', scopeKind: 'all', scopeValue: null,
    cooldownMinutes: 60, notify: true, enabled: true, aiopsAutoInvestigate: false, aiopsBundleIds: [], aiopsResourceScope: null, aiopsService: null, aiopsEnvironment: null, lastState: 'firing', lastValue: 20, lastSampleCount: 10,
    lastEvaluatedAt: new Date().toISOString(), lastTriggeredAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), openIncidentId: 81,
  }],
  incidents: [{
    id: 81, ruleId: 7, ruleName: 'Latency regression', state: 'firing', severity: 'critical', metricValue: 20,
    threshold: 10, sampleCount: 10, message: 'Latency regression is 20.0% across all executions.', context: {
      metric: 'latency_regression_percent', operator: 'gt', windowMinutes: 30, scopeKind: 'all', scopeValue: null,
      baseline: { value: 1000, currentValue: 1200, sampleCount: 200, windowDays: 7 },
      exemplars: [{
        rootTraceId: '11111111-1111-4111-8111-111111111111', traceId: '11111111-1111-4111-8111-111111111111',
        spanId: '33333333-3333-4333-8333-333333333333', runKind: 'workflow', title: 'Release workflow',
        startedAt: new Date().toISOString(), durationMs: 7000, costUsd: 0.03,
        dominantSpanLabel: 'llm.plan', href: '/runs/workflow/42?span=33333333-3333-4333-8333-333333333333',
      }],
    },
    triggeredAt: new Date().toISOString(), recoveredAt: null, notifiedAt: new Date().toISOString(),
    correlation: {
      groupId: 31, correlationKey: 'a'.repeat(64), role: 'primary',
      groupingReasons: [{ code: 'primary_signal', summary: 'Signal opened the correlated incident group.', evidence: { service: 'checkout-api', environment: 'production' } }],
      service: 'checkout-api', environment: 'production', state: 'firing', severity: 'critical',
      correlationWindowMinutes: 30, primaryIncidentId: 81, signalCount: 1,
      firstTriggeredAt: new Date().toISOString(), lastSignalAt: new Date().toISOString(), recoveredAt: null,
      groupedAt: new Date().toISOString(),
    },
  }, {
    id: 80, ruleId: 7, ruleName: 'Latency regression', state: 'recovered', severity: 'critical', metricValue: 3,
    threshold: 10, sampleCount: 12, message: 'Latency regression recovered.', context: {
      metric: 'latency_regression_percent', operator: 'gt', windowMinutes: 30, scopeKind: 'all', scopeValue: null,
      baseline: { value: 1000, currentValue: 1030, sampleCount: 180, windowDays: 7 }, exemplars: [],
    },
    triggeredAt: '2026-07-29T08:00:00.000Z', recoveredAt: '2026-07-29T09:00:00.000Z', notifiedAt: '2026-07-29T08:00:05.000Z', correlation: null,
  }],
};

const remediation: IncidentRemediation = {
  id: 91,
  incidentId: 81,
  taskLinkId: 15,
  taskId: 'task-aiops-81',
  rootTraceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceActionIndex: 0,
  priority: 'now',
  action: 'Inspect PostgreSQL availability.',
  rationale: 'It is on the failing request path.',
  requiresApproval: true,
  riskLevel: 'high',
  executionMode: 'proposal_only',
  executorBundleId: null,
  executorToolName: null,
  targetScope: { kind: 'kubernetes', namespace: 'argus-demo', environment: 'demo' },
  executionIntent: null,
  status: 'proposed',
  version: 1,
  createdBy: 1,
  decidedBy: null,
  decidedByUsername: null,
  decisionComment: null,
  decidedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  events: [{ id: 1, type: 'proposed', actorUserId: 1, actorUsername: 'argus.aiops', comment: null, metadata: {}, createdAt: new Date().toISOString() }],
      dryRuns: [],
      changePlans: [],
};

function renderPage(
  role = 'platform_admin',
  certificationFreshness: 'fresh' | 'expiring' | 'stale' = 'fresh',
  remediationFixture: IncidentRemediation = remediation,
  aiopsConnected = true,
) {
  if (!api.getIncidentRemediationWriteAdapters.getMockImplementation()) {
    api.getIncidentRemediationWriteAdapters.mockResolvedValue({
      incidentId: 81,
      remediationId: 91,
      total: 1,
      adapters: [{
        adapterKey: 'kubernetes.scale.v1', label: 'Kubernetes workload scale',
        description: 'Scale one bounded workload.',
        controls: {
          riskLevel: 'high', planApproval: 'hash_bound', verification: 'read_after_write',
          rollback: 'verified_restore', postChangeMonitoring: true, productionSeparationOfDuties: true,
        },
        status: 'unavailable', reason: 'No governed write connector.', bundleId: null,
        bundleLabel: null, writeBackendId: null, writeBackendName: null, writeToolName: null,
        target: null, workloadKinds: ['Deployment', 'StatefulSet'], replicas: { minimum: 1, maximum: 50 }, intent: null,
      }],
    });
  }
  api.getOverview.mockResolvedValue({ ...overview, user: { ...overview.user, role } });
  api.getNativeAlerts.mockResolvedValue(alerts);
  api.getSolutionPacks.mockResolvedValue({
    total: aiopsConnected ? 1 : 0,
    packs: aiopsConnected ? [{
      configuredId: 'argus.aiops', endpoint: 'http://argus-aiops:8090', state: 'ready', checkedAt: new Date().toISOString(),
      manifest: {
        apiVersion: 'argus.eu/v1alpha1', kind: 'SolutionPack',
        metadata: { id: 'argus.aiops', version: '0.1.0', displayName: 'Argus AIOps' },
        spec: {
          delivery: { type: 'container', protocol: 'argus-pack-v1alpha1', healthPath: '/health', readinessPath: '/ready' },
          requires: { core: '>=1.0.0', capabilities: [], credentials: [] },
          components: { agents: [], skills: [], bundles: [], workflows: [], knowledgeSources: [], dashboards: [], policies: [] },
          readiness: { smokeTests: [] },
        },
      },
    }] : [],
  });
  api.getAiopsOutcomes.mockResolvedValue({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    window: { days: 30, from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
    signals: { total: 4, native: 3, provider: 1, providerDeliveries: 4 },
    incidents: { actionable: 2, firing: 1, recovered: 1, correlated: 1, standalone: 1, suppressedSignals: 2, compressionRatio: 2, medianRecoveryMs: 600_000, p95RecoveryMs: 900_000 },
    investigations: { started: 1, completed: 1, partial: 0, failed: 0, blocked: 1, active: 0, coveragePercent: 50, completionRatePercent: 100, medianTimeToStartMs: 60_000, medianTimeToCompleteMs: 240_000 },
    rootCause: { confirmed: 1, suspected: 0, refuted: 0, inconclusive: 0 },
    remediations: { proposed: 1, approved: 1, awaitingApproval: 0, executed: 1, verified: 1, failed: 0, rolledBack: 0, successRatePercent: 100, postChangeHealthy: 1, postChangeRegressed: 0 },
    recurrence: { servicesWithRepeatIncidents: 1, repeatIncidents: 1 },
    topServices: [{ service: 'checkout-api', environment: 'production', incidents: 2, signals: 4, firing: 1, recovered: 1, medianRecoveryMs: 600_000 }],
    profileAttribution: {
      profileBoundInvestigations: 1,
      telemetryLinkedInvestigations: 1,
      totalTokens: 1500,
      recordedCostUsd: 0.042,
      reviewedInvestigations: 1,
      reviews: 2,
      helpful: 1,
      partial: 1,
      incorrect: 0,
      helpfulPercent: 50,
      truncated: false,
      profiles: [{
        profile: { id: 12, revision: 3, sha256: 'd'.repeat(64), displayName: 'Checkout production', service: 'checkout-api', environment: 'production' },
        investigations: 1,
        completedInvestigations: 1,
        evidence: {
          assessedInvestigations: 1,
          investigationsMeetingPolicy: 1,
          policyCoveragePercent: 100,
          minimumCollectedLanes: 3,
          configuredLanes: 4,
          requiredLanes: 3,
          optionalLanes: 1,
          lanes: [
            { lane: 'incident', requirement: 'required', investigationsWithEvidence: 1, coveragePercent: 100, claims: 1 },
            { lane: 'metrics', requirement: 'required', investigationsWithEvidence: 1, coveragePercent: 100, claims: 2 },
            { lane: 'logs', requirement: 'required', investigationsWithEvidence: 1, coveragePercent: 100, claims: 2 },
            { lane: 'changes', requirement: 'optional', investigationsWithEvidence: 0, coveragePercent: 0, claims: 0 },
          ],
        },
        usage: {
          telemetryLinkedInvestigations: 1,
          tokenAttributedInvestigations: 1,
          costAttributedInvestigations: 1,
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          recordedCostUsd: 0.042,
          averageTokensPerInvestigation: 1500,
          averageRecordedCostUsdPerInvestigation: 0.042,
        },
        feedback: {
          reviewedInvestigations: 1, reviews: 2, helpful: 1, partial: 1, incorrect: 0, helpfulPercent: 50,
        },
      }],
    },
    graph: {
      nodes: [{
        id: 'service:production:checkout-api', kind: 'service', label: 'checkout-api', environment: 'production',
        incidents: 2, signals: 4, firing: 1, incidentIds: [81, 80],
        providerLinks: [{
          provider: 'grafana', monitorRef: 'CheckoutLatencyHigh', incidentId: 81,
          observedAt: new Date().toISOString(), incidentHref: '/observe/alerts?incident=81',
          externalHref: 'https://grafana.example.test/alerting/list?search=checkout',
        }],
      }, {
        id: 'database:production:postgresql', kind: 'database', label: 'postgresql', environment: 'production',
        incidents: 0, signals: 0, firing: 0, incidentIds: [], providerLinks: [],
      }],
      edges: [{
        id: 'checkout-postgres', source: 'service:production:checkout-api', target: 'database:production:postgresql',
        relation: 'queries', calls: 4, failures: 4, failureRate: 1, p95DurationMs: 1200,
        lastSeenAt: new Date().toISOString(), evidence: 'causal_candidate', confidence: 'high',
      }],
      truncated: { nodes: false, edges: false },
    },
  });
  const serviceCatalog = {
    generatedAt: new Date().toISOString(),
    entries: [{
      id: 'checkout-demo', serviceName: 'checkout-api', environment: 'demo', current: true,
      sources: ['kubernetes', 'opentelemetry'], evidenceCount: 3, lastSeenAt: new Date().toISOString(),
      targets: [{ backendId: 42, targetId: 'demo-kind', cluster: 'argus-kind', namespace: 'argus-demo', current: true, lastSeenAt: new Date().toISOString(), workloads: [{ kind: 'Deployment', name: 'checkout-api' }] }],
    }],
    summary: { services: 1, current: 1, kubernetes: 1, opentelemetry: 1, logs: 0, configured: 0 },
  };
  api.getNativeServiceCatalog.mockResolvedValue(serviceCatalog);
  api.refreshNativeServiceCatalog.mockResolvedValue({ ...serviceCatalog, refresh: { discovered: 3, dependencies: 1, sources: ['kubernetes', 'opentelemetry'], warnings: [] } });
  api.getFabricManagement.mockResolvedValue({
    generatedAt: new Date().toISOString(),
    bundles: [{
      id: 28, name: 'aiops-read', label: 'AIOps Read', description: '', icon: 'kubernetes', agentRole: null,
      systemPrompt: null, backendIds: [42], skillIds: [], workflowIds: [], workflowCount: 0, toolPolicies: [],
      backendCount: 1, toolCount: 4, compositeCount: 0, capabilityCategories: ['metrics', 'runtime'],
      capabilitySignals: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }],
    backends: [{
      id: 42, name: 'Kubernetes MCP', description: '', type: 'mcp', managed: false, managedBy: null, sourceId: null,
      enabled: true, state: 'healthy', endpoint: 'http://kubernetes-mcp:8080', baseUrl: 'http://kubernetes-mcp:8080',
      mcpEndpoint: 'http://kubernetes-mcp:8080/mcp', authType: 'none', hasAuthValue: false, healthPath: null,
      defaultHeaders: {}, timeoutMs: 30_000, tlsSkipVerify: false, authMode: 'service-account', oauthAuthorizeUrl: null,
      oauthTokenUrl: null, oauthClientId: null, hasOauthClientSecret: false, oauthScopes: [], oauthRevokeUrl: null,
      toolCount: 4, bundleIds: [28], workflowCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      executionTargets: [{ kind: 'kubernetes', platform: 'kubernetes', backendId: 42, backendName: 'Kubernetes MCP', targetId: 'demo-kind', label: 'Demo', targetLabel: 'Demo cluster', cluster: 'argus-kind', namespace: 'argus-demo', environment: 'demo', bundleIds: [28] }],
    }],
    skills: [], tools: [],
    kubernetesCertifications: [{ id: 5, backendId: 42, targetId: 'demo-kind', platform: 'kubernetes', profile: 'in-cluster-read-only', status: 'passed', contractSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), checkCount: 4, passedCount: 4, failedCount: 0, failedChecks: [], generatedAt: new Date().toISOString(), importedAt: new Date().toISOString(), importedBy: 'automation:test', freshness: certificationFreshness, ageHours: 0, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }],
    kubernetesCertificationPolicy: { warningAgeHours: 120, maxAgeHours: 168, enforceAIOps: true },
  });
  api.getIncidentAiopsInvestigations.mockImplementation(async (incidentId: number) => ({
    incidentId,
    total: incidentId === 81 ? 1 : 0,
    investigations: incidentId === 81 ? [{
      id: 15,
      incidentId,
      packId: 'argus.aiops',
      agentId: 'incident-orchestrator',
      taskId: 'task-aiops-81',
      rootTraceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      state: 'TASK_STATE_COMPLETED',
      quality: 'reviewed',
      summary: 'The reviewer confirmed a latency regression in the checkout dependency.',
      result: {
        schemaVersion: 1,
        sourceSchemaVersion: 2,
        generatedAt: new Date().toISOString(),
        quality: 'reviewed',
        conclusion: 'confirmed',
        executiveAssessment: 'PostgreSQL query failures explain the checkout latency regression.',
        rootCause: {
          candidateRef: 'argus.core.impact.candidate.1',
          targetKind: 'database',
          targetName: 'postgresql',
          statement: 'The checkout service is failing on its PostgreSQL query path.',
          confidence: 94,
          rationale: 'Metrics, traces and dependency evidence agree inside the incident window.',
        },
        hypotheses: [{
          id: 'dependency-degradation', statement: 'The database dependency degraded.', verdict: 'supported', confidence: 94,
          evidenceFor: ['4 of 4 observed calls failed'], evidenceAgainst: [],
        }],
        evidence: [{ lane: 'traces', claim: 'Failures begin at the PostgreSQL span.', sourceRefs: ['trace:checkout-81'] }],
        recommendedActions: [{ priority: 'now', action: 'Inspect PostgreSQL availability.', rationale: 'It is on the failing request path.', requiresApproval: false }],
      },
      executionContext: {
        bundleIds: [28],
        resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
        service: 'checkout-api', environment: 'demo',
        serviceProfile: { id: 12, revision: 3, sha256: 'd'.repeat(64) },
        capturedAt: new Date().toISOString(),
      },
      createdBy: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      statusAvailable: true,
    }] : [],
    automation: null,
    remediations: incidentId === 81 ? [remediationFixture] : [],
  }));
  api.getIncidentAiopsFeedback.mockImplementation(async (incidentId: number, taskLinkId: number) => ({
    generatedAt: new Date().toISOString(),
    incidentId,
    taskLinkId,
    taskId: 'task-aiops-81',
    rootTraceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    serviceProfile: { id: 12, revision: 3, sha256: 'd'.repeat(64) },
    currentUserFeedback: null,
    feedback: [],
    summary: { reviews: 0, helpful: 0, partial: 0, incorrect: 0, helpfulPercent: null, reviewedAt: null },
  }));
  api.submitIncidentAiopsFeedback.mockImplementation(async (incidentId: number, taskLinkId: number, input: { verdict: string; reason: string; comment?: string | null }) => {
    const review = {
      id: 51, incidentId, taskLinkId, taskId: 'task-aiops-81',
      rootTraceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      verdict: input.verdict, reason: input.reason, comment: input.comment ?? null,
      reviewer: { id: 1, name: 'Alex' },
      serviceProfile: { id: 12, revision: 3, sha256: 'd'.repeat(64) },
      supersedesId: null, createdAt: new Date().toISOString(),
    };
    return {
      generatedAt: new Date().toISOString(), incidentId, taskLinkId, taskId: 'task-aiops-81',
      rootTraceId: review.rootTraceId, serviceProfile: review.serviceProfile,
      currentUserFeedback: review, feedback: [review],
      summary: { reviews: 1, helpful: input.verdict === 'helpful' ? 1 : 0, partial: input.verdict === 'partial' ? 1 : 0, incorrect: input.verdict === 'incorrect' ? 1 : 0, helpfulPercent: input.verdict === 'helpful' ? 100 : 0, reviewedAt: review.createdAt },
      submitted: review, auditEvent: { eventId: 'audit-51', sequence: 51 }, replayed: false,
    };
  });
  api.decideIncidentRemediation.mockResolvedValue({
    remediation: {
      ...remediation,
      status: 'approved',
      version: 2,
      decidedBy: 1,
      decidedByUsername: 'alex',
      decisionComment: 'Proceed with governed validation.',
      decidedAt: new Date().toISOString(),
    },
  });
  api.getIncidentRemediationExecutorCandidates.mockResolvedValue({
    incidentId: 81,
    remediationId: 91,
    total: 1,
    candidates: [{
      bundleId: 28,
      bundleName: 'argus-aiops-observe',
      bundleLabel: 'Argus.AIOps Observe',
      toolName: 'argus_observe_get_trace',
      description: 'Inspect a native Argus trace family and its spans.',
      backend: 'argus-observability',
      category: 'Observability',
      executorKind: 'native_read',
      parameters: [{
        name: 'trace_id', type: 'string', description: 'Native trace UUID', required: true,
        suggestedValue: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', valueSource: 'incident', locked: true,
      }],
      suggestedArguments: { trace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      missingRequiredArguments: [],
    }],
  });
  api.runIncidentRemediationDryRun.mockResolvedValue({
    remediation: {
      ...remediation,
      status: 'approved',
      version: 3,
      executionMode: 'dry_run',
      executorBundleId: 28,
      executorToolName: 'argus_observe_get_trace',
      decidedBy: 1,
      decidedByUsername: 'alex',
      decisionComment: 'Proceed with governed validation.',
      decidedAt: new Date().toISOString(),
      dryRuns: [{
        id: 6, remediationId: 91, bundleId: 28, toolName: 'argus_observe_get_trace',
        arguments: { trace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, status: 'passed',
        executionTraceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resultPreview: 'Trace evidence loaded.',
        errorMessage: null, redactionSummary: {}, startedBy: 1, startedByUsername: 'alex',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      }],
    },
    dryRun: {
      id: 6, remediationId: 91, bundleId: 28, toolName: 'argus_observe_get_trace',
      arguments: { trace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, status: 'passed',
      executionTraceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resultPreview: 'Trace evidence loaded.',
      errorMessage: null, redactionSummary: {}, startedBy: 1, startedByUsername: 'alex',
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    },
  });
  api.getIncidentChangeCorrelations.mockImplementation(async (incidentId: number) => ({
    incidentId,
    generatedAt: new Date().toISOString(),
    window: { hoursBefore: 6, minutesAfter: 30 },
    changes: incidentId === 81 ? [{
      id: 9,
      kind: 'connection',
      relevance: 'contextual',
      action: 'updated',
      objectType: 'mcp_backends',
      objectId: '12',
      objectLabel: 'Production cluster',
      actor: 'alex',
      occurredAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      minutesFromTrigger: -12,
      phase: 'before',
      changedFields: ['timeout_ms'],
      reason: 'A connection change can influence this latency regression percent signal.',
    }] : [],
    summary: incidentId === 81
      ? { total: 1, direct: 0, contextual: 1, temporal: 0 }
      : { total: 0, direct: 0, contextual: 0, temporal: 0 },
  }));
  api.getIncidentImpact.mockImplementation(async (incidentId: number) => ({
    incidentId,
    generatedAt: new Date().toISOString(),
    available: incidentId === 81,
    reason: incidentId === 81 ? null : 'The alert rule has no explicit AIOps service and environment boundary.',
    service: incidentId === 81 ? 'checkout-api' : null,
    environment: incidentId === 81 ? 'demo' : null,
    window: { minutesBefore: 60, minutesAfter: 30 },
    summary: incidentId === 81
      ? { upstreamServices: 1, downstreamServices: 1, externalDependencies: 1, failingDependencies: 1, observedCalls: 4, observedFailures: 4 }
      : { upstreamServices: 0, downstreamServices: 0, externalDependencies: 0, failingDependencies: 0, observedCalls: 0, observedFailures: 0 },
    impactedServices: incidentId === 81 ? [{ service: 'frontend', direction: 'upstream', depth: 1, path: ['frontend', 'checkout-api'] }] : [],
    dependencies: [],
    rootCauseCandidates: incidentId === 81 ? [{
      sourceService: 'checkout-api', targetKind: 'database', targetName: 'postgresql', relation: 'queries',
      direction: 'downstream', depth: 1, path: ['checkout-api', 'postgresql'], calls: 4, failures: 4,
      failureRate: 1, p95DurationMs: 1200, lastSeenAt: new Date().toISOString(), confidence: 'high',
      reason: '4 of 4 observed queries failed. Direct downstream dependency; evidence is correlated, not causal proof.',
    }] : [],
  }));
  api.evaluateNativeAlerts.mockResolvedValue({ evaluated: 1, fired: 0, recovered: 0, skipped: false });
  api.installNativeAlertTemplate.mockResolvedValue({ created: 1, skipped: 0 });
  api.createNativeAlert.mockResolvedValue({ rule: alerts.rules[0] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><AlertsPage /></QueryClientProvider></MemoryRouter>);
}

describe('AlertsPage', () => {
  afterEach(() => vi.resetAllMocks());

  it('shows firing rules, incidents, and runs a manual evaluation', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Native alerting' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'From signal noise to verified action' })).toBeInTheDocument();
    expect(screen.getByText('2.00×')).toBeInTheDocument();
    expect(screen.getByText('50.0%')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What each service investigation used' })).toBeInTheDocument();
    expect(screen.getByText('1,500 reported tokens · $0.0420 recorded cost · 2 human reviews')).toBeInTheDocument();
    expect(screen.getByText('50.0% helpful')).toBeInTheDocument();
    expect(screen.getByText('Checkout production')).toBeInTheDocument();
    expect(screen.getAllByText('100.0%').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Metrics')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Incident-bound runtime evidence' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in Grafana/ })).toHaveAttribute('href', 'https://grafana.example.test/alerting/list?search=checkout');
    expect(screen.getByRole('link', { name: /CheckoutLatencyHigh · Incident #81/ })).toHaveAttribute('href', '/observe/alerts?incident=81');
    expect(screen.getByText(/INCIDENT COCKPIT · INCIDENT #81/)).toBeInTheDocument();
    expect(screen.getAllByText('Latency regression').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('20.0%').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('link', { name: /Release workflow/ })).toHaveLength(2);
    for (const link of screen.getAllByRole('link', { name: /Release workflow/ })) {
      expect(link).toHaveAttribute('href', '/runs/workflow/42?span=33333333-3333-4333-8333-333333333333');
    }
    expect(screen.getByRole('heading', { level: 2, name: 'Latency regression' })).toBeInTheDocument();
    expect(screen.getByText('Historical deviation')).toBeInTheDocument();
    expect(screen.getByText('20.0% above expected')).toBeInTheDocument();
    expect(screen.getByText('7-day adaptive baseline')).toBeInTheDocument();
    expect(screen.getByText(/CORRELATED INCIDENT #31/)).toBeInTheDocument();
    expect(screen.getByText('Signal opened the correlated incident group.')).toBeInTheDocument();
    expect(screen.getByText('Correlation group opened')).toBeInTheDocument();
    expect(await screen.findByText('Production cluster')).toBeInTheDocument();
    expect(screen.getByText(/12m 0s before incident/)).toBeInTheDocument();
    expect(screen.getByText(/Changed: timeout_ms/)).toBeInTheDocument();
    expect((await screen.findAllByText('postgresql')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/4 of 4 observed queries failed/)).toBeInTheDocument();
    expect(screen.getByText('upstream · frontend → checkout-api')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open service topology/ })).toHaveAttribute('href', '/observe/dependencies?view=services');
    expect(screen.getByRole('link', { name: /Run Argus AIOps/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/solutions/argus.aiops?launch=incident&source_incident_id=81'),
    );
    expect(await screen.findByText('Task task-aiops-81')).toBeInTheDocument();
    expect(screen.getByText('reviewed')).toBeInTheDocument();
    expect(screen.getByText('AIOPS REVIEWER VERDICT')).toBeInTheDocument();
    expect(screen.getByText('94%')).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL query failures explain the checkout latency regression.')).toBeInTheDocument();
    expect(screen.getByText('Failures begin at the PostgreSQL span.')).toBeInTheDocument();
    expect(screen.getAllByText('Inspect PostgreSQL availability.')).toHaveLength(2);
    expect(screen.getByText('argus.core.impact.candidate.1')).toBeInTheDocument();
    expect(await screen.findByText('Was this RCA useful?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Helpful' }));
    expect(screen.getByRole('combobox', { name: 'RCA review reason' })).toHaveValue('accurate_root_cause');
    fireEvent.change(screen.getByRole('textbox', { name: 'RCA reviewer note' }), { target: { value: 'Evidence matched the incident timeline.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(api.submitIncidentAiopsFeedback).toHaveBeenCalledWith(81, 15, {
      verdict: 'helpful', reason: 'accurate_root_cause', comment: 'Evidence matched the incident timeline.',
    }));
    expect(await screen.findByText('Review retained in the canonical audit trail.')).toBeInTheDocument();
    expect(screen.getByText('GOVERNED REMEDIATION')).toBeInTheDocument();
    expect(screen.getByText('proposal only')).toBeInTheDocument();
    expect(screen.getByText('Not assigned')).toBeInTheDocument();
    expect(screen.getByText(/Approval records intent only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve proposal' }));
    await waitFor(() => expect(api.decideIncidentRemediation).toHaveBeenCalledWith(81, 91, {
      decision: 'approve', version: 1, comment: null,
    }));
    expect(await screen.findByText('Read-only evidence run')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /argus_observe_get_trace/ })).toBeInTheDocument();
    expect(screen.getByLabelText('trace_id argument')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Run read-only validation' }));
    await waitFor(() => expect(api.runIncidentRemediationDryRun).toHaveBeenCalledWith(81, 91, {
      version: 2,
      bundleId: 28,
      toolName: 'argus_observe_get_trace',
      arguments: { trace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    }));
    expect(await screen.findByText('Trace evidence loaded.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open investigation/ })).toHaveAttribute('href', '/solutions/argus.aiops?task=task-aiops-81');
    expect(screen.getByRole('link', { name: /Open trace/ })).toHaveAttribute('href', '/runs/workflow/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    fireEvent.click(screen.getByRole('button', { name: /Incident #80/ }));
    expect(screen.getByText('Automatically recovered')).toBeInTheDocument();
    await waitFor(() => expect(api.getIncidentChangeCorrelations).toHaveBeenCalledWith(80));
    await waitFor(() => expect(api.getIncidentImpact).toHaveBeenCalledWith(80));
    fireEvent.click(screen.getByRole('button', { name: /Evaluate now/ }));
    await waitFor(() => expect(api.evaluateNativeAlerts).toHaveBeenCalledOnce());
    expect(await screen.findByText(/1 rules evaluated/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(api.installNativeAlertTemplate.mock.calls[0]?.[0]).toBe('latency-slo'));
    expect(await screen.findByText(/1 rules created/)).toBeInTheDocument();
  }, 15_000);

  it('blocks non-admin users from cross-platform alert management', async () => {
    renderPage('viewer');
    expect(await screen.findByRole('alert')).toHaveTextContent('Platform administrator access required');
  });

  it('hides AIOps outcomes and does not fetch them when the AIOps Pack is not connected', async () => {
    renderPage('platform_admin', 'fresh', remediation, false);
    expect(await screen.findByRole('heading', { name: 'Native alerting' })).toBeInTheDocument();
    await waitFor(() => expect(api.getSolutionPacks).toHaveBeenCalledOnce());
    expect(api.getAiopsOutcomes).not.toHaveBeenCalled();
    expect(screen.queryByText(/AIOPS OUTCOMES/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What each service investigation used' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Incident-bound runtime evidence' })).not.toBeInTheDocument();
  });

  it('submits the registry-selected adapter and shows its effective controls', async () => {
    const passedDryRun = {
      id: 6, remediationId: 91, bundleId: 28, toolName: 'argus_observe_get_trace',
      arguments: { trace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, status: 'passed' as const,
      executionTraceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resultPreview: 'Trace evidence loaded.',
      errorMessage: null, redactionSummary: {}, startedBy: 1, startedByUsername: 'alex',
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    };
    const approved = {
      ...remediation,
      status: 'approved' as const,
      version: 3,
      executionMode: 'dry_run' as const,
      executionIntent: {
        adapterKey: 'kubernetes.scale.v1' as const,
        workloadKind: 'Deployment' as const,
        workloadName: 'checkout-api',
        desiredReplicas: 3,
      },
      dryRuns: [passedDryRun],
    };
    api.getIncidentRemediationWriteAdapters.mockResolvedValue({
      incidentId: 81,
      remediationId: 91,
      total: 1,
      adapters: [{
        adapterKey: 'kubernetes.scale.v1',
        label: 'Kubernetes workload scale',
        description: 'Scale one bounded workload.',
        controls: {
          riskLevel: 'high', planApproval: 'hash_bound', verification: 'read_after_write',
          rollback: 'verified_restore', postChangeMonitoring: true, productionSeparationOfDuties: true,
        },
        status: 'ready', reason: null, bundleId: 29, bundleLabel: 'Argus.AIOps Remediate',
        writeBackendId: 52, writeBackendName: 'aiops-kubernetes-remediation',
        writeToolName: 'aiops_kubernetes_remediation_resources_scale',
        target: { backendId: 42, targetId: 'demo-kind', cluster: 'argus-kind', namespace: 'argus-demo', environment: 'demo' },
        workloadKinds: ['Deployment', 'StatefulSet'], replicas: { minimum: 1, maximum: 50 },
        intent: { adapterKey: 'kubernetes.scale.v1', workloadKind: 'Deployment', workloadName: 'checkout-api', desiredReplicas: 3 },
      }],
    });
    api.createIncidentRemediationChangePlan.mockResolvedValue({ remediation: approved });

    renderPage('platform_admin', 'fresh', approved);

    expect(await screen.findByText(/hash-bound approval/)).toHaveTextContent('verified rollback');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare immutable preview' }));
    await waitFor(() => expect(api.createIncidentRemediationChangePlan).toHaveBeenCalledWith(81, 91, {
      version: 3,
      adapterKey: 'kubernetes.scale.v1',
      bundleId: 29,
      writeToolName: 'aiops_kubernetes_remediation_resources_scale',
      workloadKind: 'Deployment',
      workloadName: 'checkout-api',
      desiredReplicas: 3,
    }));
  });

  it('prepares a retained Deployment revision from registry intent without replica fields', async () => {
    const approved = {
      ...remediation,
      status: 'approved' as const,
      version: 3,
      executionMode: 'dry_run' as const,
      executionIntent: {
        adapterKey: 'kubernetes.deployment-revision-rollback.v1' as const,
        workloadKind: 'Deployment' as const,
        workloadName: 'checkout-api',
        targetRevision: 4,
      },
      dryRuns: [{
        id: 6, remediationId: 91, bundleId: 28, toolName: 'argus_observe_get_trace',
        arguments: {}, status: 'passed' as const, executionTraceId: 'b'.repeat(36),
        resultPreview: 'Evidence loaded.', errorMessage: null, redactionSummary: {}, startedBy: 1,
        startedByUsername: 'alex', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      }],
    };
    api.getIncidentRemediationWriteAdapters.mockResolvedValue({
      incidentId: 81,
      remediationId: 91,
      total: 1,
      adapters: [{
        adapterKey: 'kubernetes.deployment-revision-rollback.v1',
        label: 'Kubernetes deployment revision rollback',
        description: 'Restore one retained revision.',
        controls: {
          riskLevel: 'high', planApproval: 'hash_bound', verification: 'read_after_write',
          rollback: 'verified_restore', postChangeMonitoring: true, productionSeparationOfDuties: true,
        },
        status: 'ready', reason: null, bundleId: 29, bundleLabel: 'Argus.AIOps Remediate',
        writeBackendId: 52, writeBackendName: 'aiops-kubernetes-remediation',
        writeToolName: 'aiops_kubernetes_remediation_deployment_revision_rollback',
        target: { backendId: 42, targetId: 'demo-kind', cluster: 'argus-kind', namespace: 'argus-demo', environment: 'demo' },
        workloadKinds: ['Deployment'], replicas: null,
        intent: approved.executionIntent,
      }],
    });
    api.createIncidentRemediationChangePlan.mockResolvedValue({ remediation: approved });

    renderPage('platform_admin', 'fresh', approved);

    expect(await screen.findByDisplayValue('4')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare immutable preview' }));
    await waitFor(() => expect(api.createIncidentRemediationChangePlan).toHaveBeenCalledWith(81, 91, {
      version: 3,
      adapterKey: 'kubernetes.deployment-revision-rollback.v1',
      bundleId: 29,
      writeToolName: 'aiops_kubernetes_remediation_deployment_revision_rollback',
      workloadKind: 'Deployment',
      workloadName: 'checkout-api',
      targetRevision: 4,
    }));
  });

  it('requires a separate hash-bound approval before executing a drift rollback', async () => {
    const rollbackHash = 'e'.repeat(64);
    const monitor = {
      id: 81, remediationId: 91, planId: 71, status: 'regression_detected' as const, version: 3,
      rollbackHash, scheduledFor: new Date().toISOString(), observationTraceId: 'monitor-trace',
      observedReplicas: 1, observationResult: '{"scale":1}',
      observedState: { schemaVersion: 1, observed: { replicas: 1 } },
      observationError: 'Expected 3 replicas but observed 1.', observedAt: new Date().toISOString(),
      decidedBy: null, decidedByUsername: null, decisionComment: null, decidedAt: null,
      rollbackTraceId: null, rollbackResult: null, rollbackError: null, rolledBackAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const plan = {
      id: 71, remediationId: 91, adapterKey: 'kubernetes.scale.v1' as const, bundleId: 29,
      writeBackendId: 52, writeToolName: 'aiops_kubernetes_write_resources_scale',
      status: 'verified' as const, version: 4, planHash: 'c'.repeat(64),
      targetScope: { environment: 'demo', namespace: 'argus-demo' },
      preview: { format: 'replica_diff' as const, summary: 'Scale from 1 to 3.', lines: ['- replicas: 1', '+ replicas: 3'], rollbackSummary: 'Restore 1 replica.' },
      writeArguments: { scale: 3 }, verifyArguments: {}, rollbackArguments: { scale: 1 },
      adapterState: { schemaVersion: 1, before: { replicas: 1 }, desired: { replicas: 3 } },
      previousReplicas: 1, desiredReplicas: 3, createdBy: 1, createdByUsername: 'alex',
      approvedBy: 2, approvedByUsername: 'reviewer', approvalComment: null, approvedAt: new Date().toISOString(),
      executionTraceId: 'execution-trace', executionResult: '{"scale":3}', executionError: null,
      executedAt: new Date().toISOString(), verificationTraceId: 'verification-trace',
      verificationResult: '{"scale":3}', verificationError: null, verifiedAt: new Date().toISOString(),
      rollbackTraceId: null, rollbackResult: null, rollbackError: null, rolledBackAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), postChangeMonitor: monitor,
    };
    const regression = {
      ...remediation, status: 'verified' as const, executionMode: 'governed_write' as const,
      version: 5, changePlans: [plan],
    };
    const approved = {
      ...regression,
      changePlans: [{
        ...plan,
        postChangeMonitor: {
          ...monitor, status: 'rollback_approved' as const, version: 4,
          decidedBy: 2, decidedByUsername: 'reviewer', decisionComment: 'Reviewed drift evidence.',
          decidedAt: new Date().toISOString(),
        },
      }],
    };
    api.decideIncidentRemediationPostChangeRollback.mockResolvedValue({ remediation: approved });
    api.executeIncidentRemediationPostChangeRollback.mockResolvedValue({
      remediation: {
        ...approved, status: 'failed',
        changePlans: [{
          ...approved.changePlans[0], status: 'rolled_back',
          postChangeMonitor: { ...approved.changePlans[0].postChangeMonitor, status: 'rolled_back', version: 6 },
        }],
      },
    });
    renderPage('platform_admin', 'fresh', regression);

    expect(await screen.findByText('Post-change monitor')).toBeInTheDocument();
    expect(screen.getByText(/Drift detected/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Rollback decision note'), { target: { value: 'Reviewed drift evidence.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve rollback hash' }));
    await waitFor(() => expect(api.decideIncidentRemediationPostChangeRollback).toHaveBeenCalledWith(81, 91, 71, {
      monitorId: 81, version: 3, rollbackHash, decision: 'approve', comment: 'Reviewed drift evidence.',
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Execute approved rollback' }));
    await waitFor(() => expect(api.executeIncidentRemediationPostChangeRollback).toHaveBeenCalledWith(81, 91, 71, {
      monitorId: 81, version: 4, rollbackHash,
    }));
    expect(await screen.findByText('Post-change drift was rolled back to the previous replica count.')).toBeInTheDocument();
  });

  it('stores a certified least-privilege policy for automatic AIOps investigation', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /New rule/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Auto RCA' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Automatically investigate firing incidents/ }));
    await screen.findByRole('option', { name: 'AIOps Read' });
    fireEvent.change(screen.getByLabelText('AIOps MCP bundle'), { target: { value: '28' } });
    fireEvent.change(screen.getByLabelText('AIOps Kubernetes target'), { target: { value: '42:demo-kind:argus-demo' } });
    fireEvent.change(screen.getByLabelText('AIOps service'), { target: { value: 'checkout-api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));

    await waitFor(() => expect(api.createNativeAlert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Auto RCA',
      aiopsAutoInvestigate: true,
      aiopsBundleIds: [28],
      aiopsResourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
      aiopsService: 'checkout-api',
      aiopsEnvironment: 'demo',
    })));
  });

  it('applies a service preset using the best currently certified Fabric boundary', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /New rule/ }));
    const serviceInput = await screen.findByLabelText('Preset service or workload');
    expect(serviceInput).toHaveAttribute('list', 'alert-service-catalog');
    expect(document.querySelector('#alert-service-catalog option[value="checkout-api"]')).toHaveTextContent('kubernetes + opentelemetry · demo');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh services' }));
    await waitFor(() => expect(api.refreshNativeServiceCatalog.mock.calls[0]?.[0]).toEqual({
      bundleId: 28,
      resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
    }));
    expect(await screen.findByText('3 service evidence records refreshed · 1 runtime dependency.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Preset service or workload'), { target: { value: 'payments-api' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Latency RCA' }));

    expect(screen.getByLabelText('Name')).toHaveValue('payments-api · Latency RCA');
    expect(screen.getByLabelText('AIOps MCP bundle')).toHaveValue('28');
    expect(screen.getByLabelText('AIOps Kubernetes target')).toHaveValue('42:demo-kind:argus-demo');
    expect(screen.getByLabelText('AIOps environment')).toHaveValue('demo');
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));

    await waitFor(() => expect(api.createNativeAlert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'payments-api · Latency RCA',
      metric: 'latency_regression_percent',
      threshold: 25,
      windowMinutes: 30,
      minSamples: 10,
      aiopsAutoInvestigate: true,
      aiopsService: 'payments-api',
      aiopsBundleIds: [28],
      aiopsEnvironment: 'demo',
    })));
  });

  it('keeps guided presets disabled when no current certified target is available', async () => {
    renderPage('platform_admin', 'stale');
    fireEvent.click(await screen.findByRole('button', { name: /New rule/ }));
    expect(await screen.findByRole('button', { name: 'Apply Reliability RCA' })).toBeDisabled();
    expect(screen.getByText(/No bundle with metrics\/runtime capabilities/)).toBeInTheDocument();
  });
});
