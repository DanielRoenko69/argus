import { randomUUID } from 'node:crypto';
import type { Express, RequestHandler } from 'express';
import {
  A2aClientError,
  type A2aExecutionContext,
  type A2aGateway,
  type A2aSendInput,
} from '../a2a/client.js';
import { requirePermission, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import {
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
  type AuthorizedWorkspaceScope,
} from '../auth/workspaceScope.js';
import {
  INCIDENT_AIOPS_FEEDBACK_REASONS,
  INCIDENT_AIOPS_FEEDBACK_VERDICTS,
  IncidentAiopsFeedbackError,
  type IncidentAiopsFeedbackAuditContext,
  type IncidentAiopsFeedbackReason,
  type IncidentAiopsFeedbackStore,
  type IncidentAiopsFeedbackVerdict,
} from '../observability/incidentAiopsFeedback.js';
import type {
  IncidentAiopsExecutionContextInput,
  IncidentAiopsTaskStore,
} from '../observability/incidentAiopsTasks.js';
import { incidentAiopsSnapshotFromTask } from '../observability/incidentAiopsTasks.js';
import type { NativeAlertAiopsAutomationReader } from '../observability/nativeAlertAiopsAutomation.js';
import {
  IncidentRemediationError,
  type IncidentRemediationStore,
} from '../observability/incidentRemediations.js';
import type { IncidentRemediationExecutor } from '../observability/incidentRemediationExecutor.js';
import type { IncidentRemediationOperator } from '../observability/incidentRemediationAudit.js';
import {
  mergeIncidentImpactLabels,
  type IncidentImpactReader,
} from '../observability/incidentImpact.js';
import { SolutionPackRollbackError, type SolutionPackRegistry } from './discovery.js';
import { diffSolutionPackManifests } from './diff.js';
import type { ExecutionResourceScopeRequest } from './executionTargets.js';
import {
  RuntimeAdapterClientError,
  type RuntimeAdapterGateway,
} from './runtimeAdapterClient.js';
import {
  ManagedRuntimeCoordinatorError,
  type ManagedRuntimeLifecycleGateway,
  type ManagedRuntimeLaunchInput,
} from './managedRuntimeCoordinator.js';
import type { ManagedRuntimeMemoryProposalRecord } from '../agents/managedRuntimeMemory.js';
import { logger } from '../lib/logger.js';

export interface HermesManagedRuntimeAgentOption {
  id: number;
  name: string;
  label: string;
}

export interface HermesManagedRuntimeUiCatalog {
  approvedBundleIds: readonly number[];
  listCoreAgents(user: NonNullable<AuthenticatedRequest['user']>): Promise<HermesManagedRuntimeAgentOption[]>;
  listMemoryProposals(
    user: NonNullable<AuthenticatedRequest['user']>,
    limit: number,
  ): Promise<ManagedRuntimeMemoryProposalRecord[]>;
  decideMemoryProposal(
    user: NonNullable<AuthenticatedRequest['user']>,
    proposalId: string,
    decision: 'accepted' | 'rejected',
  ): Promise<boolean>;
}

function a2aError(res: Parameters<RequestHandler>[1], cause: unknown): void {
  if (cause instanceof WorkspaceScopeAccessError) {
    res.status(cause.status).json({ error: 'Workspace scope was not found.', code: cause.code });
    return;
  }
  if (cause instanceof IncidentAiopsFeedbackError) {
    res.status(cause.status).json({ error: cause.message, code: cause.code });
    return;
  }
  if (cause instanceof IncidentRemediationError) {
    res.status(cause.status).json({ error: cause.message, code: cause.code });
    return;
  }
  if (cause instanceof A2aClientError) {
    res.status(cause.status).json({
      error: cause.message,
      code: cause.code,
      ...(cause.details ? { details: cause.details } : {}),
    });
    return;
  }
  res.status(502).json({ error: cause instanceof Error ? cause.message : 'A2A request failed', code: 'a2a_failed' });
}

const RCA_FEEDBACK_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function remediationOperator(
  req: Parameters<RequestHandler>[0],
  user: NonNullable<AuthenticatedRequest['user']>,
): IncidentRemediationOperator & { id: number } {
  const normalizedHeader = (name: 'idempotency-key' | 'x-request-id'): string | null => {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || !value.trim()) return null;
    const normalized = value.trim();
    if (!RCA_FEEDBACK_IDEMPOTENCY_KEY.test(normalized)) {
      throw new IncidentRemediationError(400, 'invalid_audit_request_id', `${name} header is invalid`);
    }
    return normalized;
  };
  const idempotencyKey = normalizedHeader('idempotency-key');
  const requestId = normalizedHeader('x-request-id');
  const usesSso = /^(?:entra|oidc):/.test(user.username);
  return {
    id: user.id,
    username: user.username,
    audit: {
      producerEventId: idempotencyKey ?? requestId ?? randomUUID(),
      environment: process.env['NODE_ENV'] ?? 'development',
      actor: {
        type: 'human',
        id: String(user.id),
        ssoSubject: usesSso ? user.username : null,
        authMethod: usesSso ? 'oidc' : 'session',
        effectiveRoles: [user.role],
      },
      requestId,
    },
  };
}

function rcaFeedbackAuditContext(
  req: Parameters<RequestHandler>[0],
  user: NonNullable<AuthenticatedRequest['user']>,
): IncidentAiopsFeedbackAuditContext {
  const normalizedHeader = (name: 'idempotency-key' | 'x-request-id'): string | null => {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || !value.trim()) return null;
    const normalized = value.trim();
    if (!RCA_FEEDBACK_IDEMPOTENCY_KEY.test(normalized)) {
      throw new IncidentAiopsFeedbackError(400, 'invalid_audit_request_id', `${name} header is invalid`);
    }
    return normalized;
  };
  const idempotencyKey = normalizedHeader('idempotency-key');
  const requestId = normalizedHeader('x-request-id');
  const usesSso = /^(?:entra|oidc):/.test(user.username);
  return {
    producerEventId: idempotencyKey ?? requestId ?? randomUUID(),
    environment: process.env['NODE_ENV'] ?? 'development',
    actor: {
      type: 'human',
      id: String(user.id),
      ssoSubject: usesSso ? user.username : null,
      authMethod: usesSso ? 'oidc' : 'session',
      effectiveRoles: [user.role],
    },
    requestId,
  };
}

function runtimeAdapterError(res: Parameters<RequestHandler>[1], cause: unknown): void {
  if (cause instanceof RuntimeAdapterClientError) {
    res.status(cause.status).json({ error: cause.message, code: cause.code });
    return;
  }
  res.status(502).json({
    // Runtime adapter diagnostics can include upstream service details. The
    // Pack client maps expected failures to typed, safe errors above; all
    // unexpected errors deliberately remain opaque to the browser.
    error: 'runtime adapter request failed',
    code: 'runtime_adapter_failed',
  });
}

function managedRuntimeError(res: Parameters<RequestHandler>[1], cause: unknown): void {
  if (cause instanceof WorkspaceScopeAccessError) {
    res.status(cause.status).json({ error: 'Workspace scope was not found.', code: cause.code });
    return;
  }
  if (cause instanceof ManagedRuntimeCoordinatorError) {
    res.status(cause.status).json({ error: cause.message, code: cause.code });
    return;
  }
  if (cause instanceof RuntimeAdapterClientError) {
    res.status(cause.status).json({ error: cause.message, code: cause.code });
    return;
  }
  // Do not surface an upstream exception here: a Pack or runner may include
  // internal endpoint details in it. The coordinator's typed failures above
  // are the only diagnostics suitable for a browser-facing admin route.
  res.status(502).json({ error: 'managed runtime launch failed', code: 'managed_runtime_start_failed' });
}

function sendInput(value: unknown): {
  input: A2aSendInput;
  requestedBundleIds: number[];
  requestedResourceScope?: ExecutionResourceScopeRequest;
  runtimeMode?: 'auto' | 'default' | 'managed-hermes';
  nativeAlertIncidentId?: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new A2aClientError(400, 'invalid_message', 'JSON object required');
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set(['text', 'data', 'contextId', 'execution', 'correlation']);
  const unknown = Object.keys(body).find(key => !allowed.has(key));
  if (unknown) throw new A2aClientError(400, 'invalid_message', `unknown field '${unknown}'`);
  if (body['text'] !== undefined && typeof body['text'] !== 'string') {
    throw new A2aClientError(400, 'invalid_message', 'text must be a string');
  }
  if (body['data'] !== undefined && (!body['data'] || typeof body['data'] !== 'object' || Array.isArray(body['data']))) {
    throw new A2aClientError(400, 'invalid_message', 'data must be an object');
  }
  if (body['contextId'] !== undefined && typeof body['contextId'] !== 'string') {
    throw new A2aClientError(400, 'invalid_message', 'contextId must be a string');
  }
  const execution = body['execution'];
  if (execution !== undefined && (!execution || typeof execution !== 'object' || Array.isArray(execution))) {
    throw new A2aClientError(400, 'invalid_execution_scope', 'execution must be an object');
  }
  const executionObject = execution as Record<string, unknown> | undefined;
  if (executionObject && Object.keys(executionObject).some(key => !['bundleIds', 'resourceScope', 'runtimeMode'].includes(key))) {
    throw new A2aClientError(400, 'invalid_execution_scope', 'execution accepts only bundleIds, resourceScope and runtimeMode');
  }
  const bundleIds = executionObject?.['bundleIds'] ?? [];
  if (!Array.isArray(bundleIds) || bundleIds.length > 64
    || bundleIds.some(value => !Number.isInteger(value) || Number(value) <= 0)) {
    throw new A2aClientError(400, 'invalid_execution_scope', 'execution.bundleIds must contain positive integer IDs');
  }
  const rawScope = executionObject?.['resourceScope'];
  const runtimeMode = executionObject?.['runtimeMode'];
  if (runtimeMode !== undefined && runtimeMode !== 'auto' && runtimeMode !== 'default' && runtimeMode !== 'managed-hermes') {
    throw new A2aClientError(400, 'invalid_runtime_mode', 'execution.runtimeMode must be auto, default or managed-hermes');
  }
  let requestedResourceScope: ExecutionResourceScopeRequest | undefined;
  if (rawScope !== undefined) {
    if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
      throw new A2aClientError(400, 'invalid_execution_scope', 'execution.resourceScope must be an object');
    }
    const scope = rawScope as Record<string, unknown>;
    if (Object.keys(scope).some(key => !['kind', 'backendId', 'targetId', 'namespace'].includes(key))
      || scope['kind'] !== 'kubernetes'
      || !Number.isInteger(scope['backendId']) || Number(scope['backendId']) <= 0
      || typeof scope['targetId'] !== 'string' || scope['targetId'].length > 128
      || typeof scope['namespace'] !== 'string' || scope['namespace'].length > 63) {
      throw new A2aClientError(400, 'invalid_execution_scope', 'execution.resourceScope is malformed');
    }
    requestedResourceScope = {
      kind: 'kubernetes',
      backendId: Number(scope['backendId']),
      targetId: scope['targetId'],
      namespace: scope['namespace'],
    };
  }
  const correlation = body['correlation'];
  let nativeAlertIncidentId: number | undefined;
  if (correlation !== undefined) {
    if (!correlation || typeof correlation !== 'object' || Array.isArray(correlation)) {
      throw new A2aClientError(400, 'invalid_correlation', 'correlation must be an object');
    }
    const correlationObject = correlation as Record<string, unknown>;
    if (Object.keys(correlationObject).some(key => key !== 'nativeAlertIncidentId')) {
      throw new A2aClientError(400, 'invalid_correlation', 'correlation accepts only nativeAlertIncidentId');
    }
    const candidate = correlationObject['nativeAlertIncidentId'];
    if (!Number.isSafeInteger(candidate) || Number(candidate) <= 0) {
      throw new A2aClientError(400, 'invalid_correlation', 'correlation.nativeAlertIncidentId must be a positive integer');
    }
    nativeAlertIncidentId = Number(candidate);
  }
  return {
    input: {
      ...(body['text'] === undefined ? {} : { text: body['text'] as string }),
      ...(body['data'] === undefined ? {} : { data: body['data'] as Record<string, unknown> }),
      ...(body['contextId'] === undefined ? {} : { contextId: body['contextId'] as string }),
    },
    requestedBundleIds: [...new Set(bundleIds as number[])],
    ...(requestedResourceScope ? { requestedResourceScope } : {}),
    ...(runtimeMode ? { runtimeMode } : {}),
    ...(nativeAlertIncidentId ? { nativeAlertIncidentId } : {}),
  };
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function managedRuntimeLaunchInput(
  raw: unknown,
  packId: string,
  adapterId: string,
  user: NonNullable<AuthenticatedRequest['user']>,
  scope: AuthorizedWorkspaceScope,
): ManagedRuntimeLaunchInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_launch', 'JSON object required');
  }
  const body = raw as Record<string, unknown>;
  const allowed = new Set(['requestId', 'coreAgentName', 'bundleIds', 'input', 'instructions', 'limits']);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_launch', 'managed runtime launch request contains an unsupported field');
  }
  // The caller cannot set a principal, Pack ID, adapter ID, Core MCP origin,
  // or lease metadata. All of those values are Core-owned and derived here.
  return {
    packId,
    adapterId,
    requestId: body['requestId'] as string,
    coreAgentName: body['coreAgentName'] as string,
    principal: {
      kind: 'user',
      id: String(user.id),
      allowedBundleIds: user.allowed_bundles,
      tenantKey: scope.tenantKey,
      workspaceKey: scope.workspaceKey,
    },
    bundleIds: body['bundleIds'] as number[],
    input: body['input'] as { text: string },
    ...(body['instructions'] === undefined ? {} : { instructions: body['instructions'] as string }),
    ...(body['limits'] === undefined ? {} : { limits: body['limits'] as ManagedRuntimeLaunchInput['limits'] }),
  };
}

function attachedRuntimeLaunchInput(
  raw: unknown,
  packId: string,
  adapterId: string,
): { packId: string; adapterId: string; input: { text: string } } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeAdapterClientError(400, 'invalid_attached_runtime_request', 'JSON object required');
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== 'input')
    || !body['input'] || typeof body['input'] !== 'object' || Array.isArray(body['input'])) {
    throw new RuntimeAdapterClientError(400, 'invalid_attached_runtime_request', 'attached runtime request is invalid');
  }
  const input = body['input'] as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'text') || typeof input['text'] !== 'string') {
    throw new RuntimeAdapterClientError(400, 'invalid_attached_runtime_request', 'attached runtime input is invalid');
  }
  return { packId, adapterId, input: { text: input['text'] } };
}

function managedRuntimeCancelInput(
  raw: unknown,
  packId: string,
  adapterId: string,
  runId: string,
): { packId: string; adapterId: string; runId: string; requestId: string; reason?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_lifecycle_request', 'JSON object required');
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== 'requestId' && key !== 'reason')) {
    throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_lifecycle_request', 'managed runtime cancellation contains an unsupported field');
  }
  return {
    packId,
    adapterId,
    runId,
    requestId: body['requestId'] as string,
    ...(body['reason'] === undefined ? {} : { reason: body['reason'] as string }),
  };
}

function incidentExecutionContext(
  input: A2aSendInput,
  bundleIds: number[],
  resourceScope?: ExecutionResourceScopeRequest,
  nativeAlertIncidentId?: number,
): IncidentAiopsExecutionContextInput {
  const data = input.data ?? {};
  const workflowInput = data['input'] && typeof data['input'] === 'object' && !Array.isArray(data['input'])
    ? data['input'] as Record<string, unknown>
    : {};
  const bounded = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return normalized ? normalized.slice(0, max) : null;
  };
  return {
    bundleIds,
    resourceScope: resourceScope ?? null,
    service: bounded(workflowInput['service'], 200),
    environment: bounded(workflowInput['environment'], 120),
    trigger: nativeAlertIncidentId
      ? { kind: 'native-alert', ref: String(nativeAlertIncidentId) }
      : { kind: 'manual', ref: null },
  };
}

export function registerSolutionPackRoutes(
  app: Express,
  registry: SolutionPackRegistry,
  requireAuth: RequestHandler,
  requireAdmin: RequestHandler,
  requireSameOrigin: RequestHandler,
  a2a?: A2aGateway,
  incidentAiopsTasks?: IncidentAiopsTaskStore,
  incidentAiopsAutomation?: NativeAlertAiopsAutomationReader,
  incidentImpactReader?: IncidentImpactReader,
  incidentRemediations?: IncidentRemediationStore,
  incidentRemediationExecutor?: IncidentRemediationExecutor,
  runtimeAdapters?: RuntimeAdapterGateway,
  managedRuntimes?: ManagedRuntimeLifecycleGateway,
  requireDeveloper: RequestHandler = requireAdmin,
  managedRuntimeUi?: HermesManagedRuntimeUiCatalog,
  incidentAiopsFeedback?: IncidentAiopsFeedbackStore,
): void {
  app.get('/api/admin/solution-packs', requireAuth, requireAdmin, (_req, res) => {
    const packs = registry.list();
    res.json({ total: packs.length, packs });
  });

  app.post('/api/admin/solution-packs/refresh', requireAuth, requireAdmin, requireSameOrigin, async (_req, res) => {
    const packs = await registry.refresh();
    res.json({ total: packs.length, packs });
  });

  // The developer console needs Pack declarations and readiness, but not the
  // administrative refresh/rollback controls. Discovery results contain no
  // Pack service credential; those remain private inside the registry client.
  app.get('/api/ui/solution-packs', requireAuth, requireDeveloper, (_req, res) => {
    const packs = registry.list();
    res.json({ total: packs.length, packs });
  });

  const hermesPackId = 'argus.hermes';
  const hermesAdapterId = 'hermes-http';
  const authenticatedPrincipal = (req: Parameters<RequestHandler>[0]) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      throw new ManagedRuntimeCoordinatorError(403, 'managed_runtime_operator_required', 'an authenticated developer is required');
    }
    const scope = resolveAuthorizedWorkspaceScope(req, user);
    return {
      user,
      scope,
      principal: {
        kind: 'user' as const,
        id: String(user.id),
        tenantKey: scope.tenantKey,
        workspaceKey: scope.workspaceKey,
      },
    };
  };
  const hermesManagedSnapshot = async (user: NonNullable<AuthenticatedRequest['user']>) => {
    const pack = registry.get(hermesPackId);
    const adapter = pack?.manifest?.spec.components.runtimeAdapters
      ?.find(candidate => candidate.id === hermesAdapterId && candidate.runtime === 'hermes');
    const approvedBundleIds = (managedRuntimeUi?.approvedBundleIds ?? [])
      .filter(id => user.allowed_bundles == null || user.allowed_bundles.includes(id));
    const agents = managedRuntimeUi ? await managedRuntimeUi.listCoreAgents(user) : [];
    if (!pack || pack.state !== 'ready' || !adapter || !runtimeAdapters || !managedRuntimes) {
      return {
        identity: {
          id: user.id, displayName: user.display_name, role: user.role,
          authentication: /^(entra|oidc):/.test(user.username) ? 'sso' as const : 'argus-session' as const,
        },
        pack: { connected: false, version: pack?.manifest?.metadata.version ?? null },
        adapter: { id: hermesAdapterId, state: 'unavailable' as const, modes: [] },
        managed: {
          ready: false,
          detail: 'Argus Hermes Managed Runtime is not connected or not configured.',
          approvedBundleIds,
          agents,
        },
        limits: { deadlineSeconds: { default: 600, min: 30, max: 900 }, maxToolCalls: { default: 64, min: 1, max: 1_000 } },
      };
    }
    try {
      const [capabilities, status] = await Promise.all([
        runtimeAdapters.getCapabilities(hermesPackId, hermesAdapterId),
        runtimeAdapters.getStatus(hermesPackId, hermesAdapterId),
      ]);
      const managedMode = status.status.modes.find(mode => mode.mode === 'managed');
      const ready = status.status.state === 'ready'
        && managedMode?.state === 'ready'
        && capabilities.capabilities.modes.includes('managed')
        && capabilities.capabilities.capabilities.includes('runs')
        && capabilities.capabilities.capabilities.includes('mcp-fabric')
        && approvedBundleIds.length > 0
        && agents.length > 0;
      return {
        identity: {
          id: user.id, displayName: user.display_name, role: user.role,
          authentication: /^(entra|oidc):/.test(user.username) ? 'sso' as const : 'argus-session' as const,
        },
        pack: { connected: true, version: pack.manifest?.metadata.version ?? null },
        adapter: {
          id: hermesAdapterId,
          state: status.status.state,
          modes: status.status.modes,
          capabilities: capabilities.capabilities.capabilities,
        },
        managed: {
          ready,
          detail: ready
            ? managedMode?.detail ?? 'Managed Hermes is ready for a governed run.'
            : managedMode?.detail ?? (approvedBundleIds.length === 0
              ? 'No operator-approved read-only Bundle is available to your identity.'
              : agents.length === 0
                ? 'No eligible Core Agent is available to your identity.'
                : 'Managed Hermes did not pass runtime readiness.'),
          approvedBundleIds,
          agents,
        },
        limits: { deadlineSeconds: { default: 600, min: 30, max: 900 }, maxToolCalls: { default: 64, min: 1, max: 1_000 } },
      };
    } catch {
      return {
        identity: {
          id: user.id, displayName: user.display_name, role: user.role,
          authentication: /^(entra|oidc):/.test(user.username) ? 'sso' as const : 'argus-session' as const,
        },
        pack: { connected: true, version: pack.manifest?.metadata.version ?? null },
        adapter: { id: hermesAdapterId, state: 'unavailable' as const, modes: [] },
        managed: {
          ready: false,
          detail: 'Managed Hermes readiness could not be verified.',
          approvedBundleIds,
          agents,
        },
        limits: { deadlineSeconds: { default: 600, min: 30, max: 900 }, maxToolCalls: { default: 64, min: 1, max: 1_000 } },
      };
    }
  };

  app.get('/api/hermes-dev/runtime', requireAuth, requireDeveloper, async (req, res) => {
    try {
      const { user } = authenticatedPrincipal(req);
      res.json(await hermesManagedSnapshot(user));
    } catch (cause) {
      managedRuntimeError(res, cause);
    }
  });

  app.post('/api/hermes-dev/runtime/preflight', requireAuth, requireDeveloper, requireSameOrigin, async (req, res) => {
    try {
      const { user, scope } = authenticatedPrincipal(req);
      const snapshot = await hermesManagedSnapshot(user);
      const body = req.body as Record<string, unknown> | undefined;
      const coreAgentName = body?.['coreAgentName'];
      const bundleIds = body?.['bundleIds'];
      if (!body || Object.keys(body).some(key => !['coreAgentName', 'bundleIds'].includes(key))
        || typeof coreAgentName !== 'string' || !Array.isArray(bundleIds)
        || bundleIds.length < 1 || bundleIds.some(id => !Number.isInteger(id) || Number(id) <= 0)) {
        throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_preflight', 'managed runtime preflight selection is invalid');
      }
      const errors: string[] = [];
      if (!snapshot.managed.ready) errors.push(snapshot.managed.detail);
      if (!snapshot.managed.agents.some(agent => agent.name === coreAgentName)) {
        errors.push('The selected Core Agent is not available to your current identity.');
      }
      if ((bundleIds as number[]).some(id => !snapshot.managed.approvedBundleIds.includes(id))) {
        errors.push('A selected Bundle is not approved for Managed Hermes or your current identity.');
      }
      res.json({ ready: errors.length === 0, errors, snapshot });
    } catch (cause) {
      managedRuntimeError(res, cause);
    }
  });

  app.get('/api/hermes-dev/runtime/memory-proposals', requireAuth, requireDeveloper, async (req, res) => {
    if (!managedRuntimeUi) {
      res.status(503).json({ error: 'managed runtime memory governance is not configured', code: 'managed_runtime_memory_unavailable' });
      return;
    }
    try {
      const { user } = authenticatedPrincipal(req);
      const candidate = Number(req.query['limit'] ?? 30);
      const limit = Number.isSafeInteger(candidate) ? Math.min(100, Math.max(1, candidate)) : 30;
      res.json({ proposals: await managedRuntimeUi.listMemoryProposals(user, limit) });
    } catch {
      res.status(502).json({ error: 'managed runtime memory proposals are unavailable', code: 'managed_runtime_memory_unavailable' });
    }
  });

  app.post('/api/hermes-dev/runtime/memory-proposals/:proposalId/decision', requireAuth, requireDeveloper, requireSameOrigin, async (req, res) => {
    if (!managedRuntimeUi) {
      res.status(503).json({ error: 'managed runtime memory governance is not configured', code: 'managed_runtime_memory_unavailable' });
      return;
    }
    try {
      const { user } = authenticatedPrincipal(req);
      const body = req.body as Record<string, unknown> | undefined;
      const decision = body?.['decision'];
      if (!body || Object.keys(body).some(key => key !== 'decision')
        || (decision !== 'accepted' && decision !== 'rejected')) {
        res.status(400).json({ error: 'decision must be accepted or rejected', code: 'invalid_memory_decision' });
        return;
      }
      const proposalId = routeParam(req.params.proposalId);
      if (!/^\d+$/.test(proposalId)) {
        res.status(400).json({ error: 'memory proposal ID is invalid', code: 'invalid_memory_proposal_id' });
        return;
      }
      const decided = await managedRuntimeUi.decideMemoryProposal(user, proposalId, decision);
      if (!decided) {
        res.status(404).json({ error: 'pending memory proposal not found', code: 'memory_proposal_not_found' });
        return;
      }
      res.json({ id: proposalId, status: decision });
    } catch (cause) {
      logger.error({
        err: cause,
        proposalId: routeParam(req.params.proposalId),
        userId: (req as AuthenticatedRequest).user?.id,
      }, 'managed runtime memory decision failed');
      res.status(502).json({ error: 'managed runtime memory decision failed', code: 'managed_runtime_memory_decision_failed' });
    }
  });

  app.get('/api/hermes-dev/runtime/runs', requireAuth, requireDeveloper, async (req, res) => {
    if (!managedRuntimes) {
      res.status(503).json({ error: 'managed runtime orchestration is not configured', code: 'managed_runtime_orchestration_unavailable' });
      return;
    }
    try {
      const { principal } = authenticatedPrincipal(req);
      const runs = await managedRuntimes.list({ packId: hermesPackId, adapterId: hermesAdapterId, principal, limit: 20 });
      res.json({ runs });
    } catch (cause) {
      managedRuntimeError(res, cause);
    }
  });

  app.post('/api/hermes-dev/runtime/runs', requireAuth, requireDeveloper, requireSameOrigin, async (req, res) => {
    if (!managedRuntimes) {
      res.status(503).json({ error: 'managed runtime orchestration is not configured', code: 'managed_runtime_orchestration_unavailable' });
      return;
    }
    try {
      const { user, scope } = authenticatedPrincipal(req);
      const snapshot = await hermesManagedSnapshot(user);
      if (!snapshot.managed.ready) {
        throw new ManagedRuntimeCoordinatorError(409, 'managed_runtime_not_ready', snapshot.managed.detail);
      }
      const body = req.body as Record<string, unknown> | undefined;
      const selectedAgent = typeof body?.['coreAgentName'] === 'string' ? body['coreAgentName'] : '';
      const selectedBundles = Array.isArray(body?.['bundleIds']) ? body!['bundleIds'] as number[] : [];
      if (!snapshot.managed.agents.some(agent => agent.name === selectedAgent)) {
        throw new ManagedRuntimeCoordinatorError(403, 'managed_runtime_agent_denied', 'selected Core Agent is not available to your current identity');
      }
      if (selectedBundles.some(id => !snapshot.managed.approvedBundleIds.includes(id))) {
        throw new ManagedRuntimeCoordinatorError(403, 'managed_runtime_bundle_denied', 'selected Bundle is not approved for your current identity');
      }
      const result = await managedRuntimes.launch(managedRuntimeLaunchInput(
        req.body,
        hermesPackId,
        hermesAdapterId,
        user,
        scope,
      ));
      res.status(result.idempotent ? 200 : 202).json(result);
    } catch (cause) {
      managedRuntimeError(res, cause);
    }
  });

  app.get('/api/hermes-dev/runtime/runs/:runId', requireAuth, requireDeveloper, async (req, res) => {
    if (!managedRuntimes) {
      res.status(503).json({ error: 'managed runtime orchestration is not configured', code: 'managed_runtime_orchestration_unavailable' });
      return;
    }
    try {
      const { principal } = authenticatedPrincipal(req);
      res.json(await managedRuntimes.getStatus({
        packId: hermesPackId, adapterId: hermesAdapterId,
        runId: routeParam(req.params.runId), principal,
      }));
    } catch (cause) {
      managedRuntimeError(res, cause);
    }
  });

  app.get('/api/hermes-dev/runtime/runs/:runId/events', requireAuth, requireDeveloper, async (req, res) => {
    if (!managedRuntimes) {
      res.status(503).json({ error: 'managed runtime orchestration is not configured', code: 'managed_runtime_orchestration_unavailable' });
      return;
    }
    try {
      const { principal } = authenticatedPrincipal(req);
      const header = req.headers['last-event-id'];
      if (Array.isArray(header)) {
        throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_lifecycle_request', 'Last-Event-ID must be a single cursor');
      }
      res.json(await managedRuntimes.getEvents({
        packId: hermesPackId, adapterId: hermesAdapterId,
        runId: routeParam(req.params.runId), principal,
        ...(header === undefined ? {} : { after: header }),
      }));
    } catch (cause) {
      managedRuntimeError(res, cause);
    }
  });

  app.post('/api/hermes-dev/runtime/runs/:runId/cancel', requireAuth, requireDeveloper, requireSameOrigin, async (req, res) => {
    if (!managedRuntimes) {
      res.status(503).json({ error: 'managed runtime orchestration is not configured', code: 'managed_runtime_orchestration_unavailable' });
      return;
    }
    try {
      const { principal } = authenticatedPrincipal(req);
      const input = managedRuntimeCancelInput(
        req.body,
        hermesPackId,
        hermesAdapterId,
        routeParam(req.params.runId),
      );
      res.json(await managedRuntimes.cancel({ ...input, principal }));
    } catch (cause) {
      managedRuntimeError(res, cause);
    }
  });

  app.get('/api/admin/solution-packs/:packId/diff', requireAuth, requireAdmin, (req, res) => {
    const packId = routeParam(req.params.packId);
    const pack = registry.get(packId);
    if (!pack) {
      res.status(404).json({ error: `solution pack '${packId}' is not configured`, code: 'pack_not_found' });
      return;
    }
    const changes = diffSolutionPackManifests(pack.previousManifest, pack.manifest);
    res.json({
      packId,
      state: pack.state,
      revision: pack.revision ?? 0,
      previousVersion: pack.previousVersion ?? null,
      currentVersion: pack.manifest?.metadata.version ?? null,
      rollbackAvailable: Boolean(pack.previousManifest),
      changes,
    });
  });

  app.get('/api/admin/solution-packs/:packId/rollback-requests', requireAuth, requireAdmin, async (req, res) => {
    const packId = routeParam(req.params.packId);
    const rawLimit = String(req.query['limit'] ?? '20');
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({ error: 'limit must be an integer from 1 to 100', code: 'invalid_rollback_limit' });
      return;
    }
    try {
      const requests = await registry.listRollbackRequests(packId, limit);
      res.json({ packId, total: requests.length, requests });
    } catch (cause) {
      if (cause instanceof SolutionPackRollbackError) {
        res.status(cause.status).json({ error: cause.message, code: cause.code });
        return;
      }
      res.status(503).json({ error: cause instanceof Error ? cause.message : 'rollback history unavailable', code: 'rollback_history_failed' });
    }
  });

  app.post(
    '/api/admin/solution-packs/:packId/rollback',
    requireAuth,
    requireAdmin,
    requireSameOrigin,
    async (req, res) => {
      const body = req.body as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ error: 'JSON object required', code: 'invalid_rollback_request' });
        return;
      }
      const input = body as Record<string, unknown>;
      if (input.confirm !== true) {
        res.status(400).json({
          error: 'rollback requires explicit confirmation',
          code: 'rollback_confirmation_required',
        });
        return;
      }
      if (typeof input.reason !== 'string' || input.reason.trim().length < 8 || input.reason.trim().length > 2000) {
        res.status(400).json({
          error: 'reason must be between 8 and 2000 characters',
          code: 'invalid_rollback_reason',
        });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user;
        const requestedBy = user?.username ?? (user ? String(user.id) : 'admin');
        const request = await registry.requestRollback(
          routeParam(req.params.packId),
          requestedBy,
          input.reason.trim(),
        );
        res.status(202).json({
          rollback: request,
          message: 'Rollback-Anforderung angelegt; ein externer Solution-Pack-Reconciler muss das Ziel-Image anwenden.',
        });
      } catch (cause) {
        if (cause instanceof SolutionPackRollbackError) {
          res.status(cause.status).json({ error: cause.message, code: cause.code });
          return;
        }
        res.status(503).json({
          error: cause instanceof Error ? cause.message : 'rollback request failed',
          code: 'rollback_request_failed',
        });
      }
    },
  );

  app.get(
    '/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/capabilities',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      if (!runtimeAdapters) {
        res.status(503).json({
          error: 'runtime adapter gateway is unavailable',
          code: 'runtime_adapter_gateway_unavailable',
        });
        return;
      }
      try {
        res.json(await runtimeAdapters.getCapabilities(
          routeParam(req.params.packId),
          routeParam(req.params.adapterId),
        ));
      } catch (cause) {
        runtimeAdapterError(res, cause);
      }
    },
  );

  app.get(
    '/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/status',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      if (!runtimeAdapters) {
        res.status(503).json({
          error: 'runtime adapter gateway is unavailable',
          code: 'runtime_adapter_gateway_unavailable',
        });
        return;
      }
      try {
        res.json(await runtimeAdapters.getStatus(
          routeParam(req.params.packId),
          routeParam(req.params.adapterId),
        ));
      } catch (cause) {
        runtimeAdapterError(res, cause);
      }
    },
  );

  app.get(
    '/api/ui/observability/alerts/:incidentId/aiops-investigations/:taskLinkId/feedback',
    requireAuth,
    requirePermission('aiops.investigation.review'),
    async (req, res) => {
      try {
        if (!incidentAiopsFeedback) {
          throw new IncidentAiopsFeedbackError(503, 'feedback_unavailable', 'AIOps RCA feedback persistence is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        const taskLinkId = Number(routeParam(req.params.taskLinkId));
        if (![incidentId, taskLinkId].every(value => Number.isSafeInteger(value) && value > 0)) {
          throw new IncidentAiopsFeedbackError(400, 'invalid_investigation_id', 'incident and investigation IDs must be positive integers');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentAiopsFeedbackError(401, 'reviewer_required', 'authenticated reviewer identity is required');
        res.set('Cache-Control', 'no-store');
        res.json(await incidentAiopsFeedback.list(incidentId, taskLinkId, {
          userId: user.id,
          allowedBundleIds: user.allowed_bundles,
        }));
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/ui/observability/alerts/:incidentId/aiops-investigations/:taskLinkId/feedback',
    requireAuth,
    requirePermission('aiops.investigation.review'),
    requireSameOrigin,
    async (req, res) => {
      try {
        if (!incidentAiopsFeedback) {
          throw new IncidentAiopsFeedbackError(503, 'feedback_unavailable', 'AIOps RCA feedback persistence is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        const taskLinkId = Number(routeParam(req.params.taskLinkId));
        const body = req.body as Record<string, unknown> | null;
        if (![incidentId, taskLinkId].every(value => Number.isSafeInteger(value) && value > 0)
          || !body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['verdict', 'reason', 'comment'].includes(key))
          || !INCIDENT_AIOPS_FEEDBACK_VERDICTS.includes(body['verdict'] as IncidentAiopsFeedbackVerdict)
          || !INCIDENT_AIOPS_FEEDBACK_REASONS.includes(body['reason'] as IncidentAiopsFeedbackReason)
          || (body['comment'] !== undefined && body['comment'] !== null && typeof body['comment'] !== 'string')) {
          throw new IncidentAiopsFeedbackError(400, 'invalid_rca_feedback', 'valid verdict, reason and an optional comment are required');
        }
        const comment = typeof body['comment'] === 'string' ? body['comment'].trim() : null;
        if (comment && comment.length > 2_000) {
          throw new IncidentAiopsFeedbackError(400, 'invalid_rca_feedback', 'feedback comment must not exceed 2000 characters');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentAiopsFeedbackError(401, 'reviewer_required', 'authenticated reviewer identity is required');
        const result = await incidentAiopsFeedback.submit({
          incidentId,
          taskLinkId,
          userId: user.id,
          allowedBundleIds: user.allowed_bundles,
          verdict: body['verdict'] as IncidentAiopsFeedbackVerdict,
          reason: body['reason'] as IncidentAiopsFeedbackReason,
          comment,
          audit: rcaFeedbackAuditContext(req, user),
        });
        res.status(result.replayed ? 200 : 201).json(result);
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/attached-runs',
    requireAuth,
    requireAdmin,
    requireSameOrigin,
    async (req, res) => {
      if (!runtimeAdapters?.startAttachedRun) {
        res.status(503).json({ error: 'attached runtime gateway is unavailable', code: 'runtime_adapter_gateway_unavailable' });
        return;
      }
      try {
        const result = await runtimeAdapters.startAttachedRun(attachedRuntimeLaunchInput(
          req.body,
          routeParam(req.params.packId),
          routeParam(req.params.adapterId),
        ));
        res.status(202).json(result);
      } catch (cause) {
        runtimeAdapterError(res, cause);
      }
    },
  );

  app.get(
    '/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/attached-runs/:runId',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      if (!runtimeAdapters?.getAttachedRunStatus) {
        res.status(503).json({ error: 'attached runtime gateway is unavailable', code: 'runtime_adapter_gateway_unavailable' });
        return;
      }
      try {
        res.json(await runtimeAdapters.getAttachedRunStatus({
          packId: routeParam(req.params.packId),
          adapterId: routeParam(req.params.adapterId),
          runId: routeParam(req.params.runId),
        }));
      } catch (cause) {
        runtimeAdapterError(res, cause);
      }
    },
  );

  app.post(
    '/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/attached-runs/:runId/stop',
    requireAuth,
    requireAdmin,
    requireSameOrigin,
    async (req, res) => {
      if (!runtimeAdapters?.stopAttachedRun) {
        res.status(503).json({ error: 'attached runtime gateway is unavailable', code: 'runtime_adapter_gateway_unavailable' });
        return;
      }
      try {
        res.json(await runtimeAdapters.stopAttachedRun({
          packId: routeParam(req.params.packId),
          adapterId: routeParam(req.params.adapterId),
          runId: routeParam(req.params.runId),
        }));
      } catch (cause) {
        runtimeAdapterError(res, cause);
      }
    },
  );

  app.post(
    '/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/runs',
    requireAuth,
    requireAdmin,
    requireSameOrigin,
    async (req, res) => {
      if (!managedRuntimes) {
        res.status(503).json({
          error: 'managed runtime orchestration is not configured',
          code: 'managed_runtime_orchestration_unavailable',
        });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user;
        if (!user) {
          throw new ManagedRuntimeCoordinatorError(403, 'managed_runtime_operator_required', 'an authenticated platform administrator is required');
        }
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const result = await managedRuntimes.launch(managedRuntimeLaunchInput(
          req.body,
          routeParam(req.params.packId),
          routeParam(req.params.adapterId),
          user,
          scope,
        ));
        res.status(result.idempotent ? 200 : 202).json(result);
      } catch (cause) {
        managedRuntimeError(res, cause);
      }
    },
  );

  app.get(
    '/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/runs/:runId',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      if (!managedRuntimes) {
        res.status(503).json({
          error: 'managed runtime orchestration is not configured',
          code: 'managed_runtime_orchestration_unavailable',
        });
        return;
      }
      try {
        res.json(await managedRuntimes.getStatus({
          packId: routeParam(req.params.packId),
          adapterId: routeParam(req.params.adapterId),
          runId: routeParam(req.params.runId),
        }));
      } catch (cause) {
        managedRuntimeError(res, cause);
      }
    },
  );

  app.post(
    '/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/runs/:runId/cancel',
    requireAuth,
    requireAdmin,
    requireSameOrigin,
    async (req, res) => {
      if (!managedRuntimes) {
        res.status(503).json({
          error: 'managed runtime orchestration is not configured',
          code: 'managed_runtime_orchestration_unavailable',
        });
        return;
      }
      try {
        res.json(await managedRuntimes.cancel(managedRuntimeCancelInput(
          req.body,
          routeParam(req.params.packId),
          routeParam(req.params.adapterId),
          routeParam(req.params.runId),
        )));
      } catch (cause) {
        managedRuntimeError(res, cause);
      }
    },
  );

  app.get(
    '/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/runs/:runId/events',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      if (!managedRuntimes) {
        res.status(503).json({
          error: 'managed runtime orchestration is not configured',
          code: 'managed_runtime_orchestration_unavailable',
        });
        return;
      }
      try {
        const header = req.headers['last-event-id'];
        if (Array.isArray(header)) {
          throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_lifecycle_request', 'Last-Event-ID must be a single cursor');
        }
        res.json(await managedRuntimes.getEvents({
          packId: routeParam(req.params.packId),
          adapterId: routeParam(req.params.adapterId),
          runId: routeParam(req.params.runId),
          ...(header === undefined ? {} : { after: header }),
        }));
      } catch (cause) {
        managedRuntimeError(res, cause);
      }
    },
  );

  if (!a2a) return;

  app.get(
    '/api/admin/solution-packs/:packId/agents/:agentId/a2a/card',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        res.json({
          agentCard: await a2a.getAgentCard(
            routeParam(req.params.packId),
            routeParam(req.params.agentId),
          ),
        });
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/admin/solution-packs/:packId/agents/:agentId/a2a/message',
    requireAuth,
    requireAdmin,
    requireSameOrigin,
    async (req, res) => {
      try {
        const parsed = sendInput(req.body);
        const user = (req as AuthenticatedRequest).user;
        const packId = routeParam(req.params.packId);
        const agentId = routeParam(req.params.agentId);
        if (parsed.nativeAlertIncidentId) {
          if (packId !== 'argus.aiops'
            || parsed.input.data?.['operation'] !== 'workflow.start') {
            throw new A2aClientError(400, 'invalid_correlation', 'native alert correlation is supported only for Argus AIOps workflow starts');
          }
          if (!incidentAiopsTasks) {
            throw new A2aClientError(503, 'incident_correlation_unavailable', 'native alert correlation persistence is unavailable');
          }
          if (!await incidentAiopsTasks.incidentExists(parsed.nativeAlertIncidentId)) {
            throw new A2aClientError(404, 'incident_not_found', `native alert incident '${parsed.nativeAlertIncidentId}' was not found`);
          }
        }
        let enrichedInput = parsed.input;
        if (parsed.nativeAlertIncidentId) {
          let impact = null;
          try {
            impact = await incidentImpactReader?.getForIncident(parsed.nativeAlertIncidentId) ?? null;
          } catch {
            // Manual investigations remain available when optional aggregate
            // impact evidence cannot be loaded. A trusted unavailable marker
            // replaces any browser-supplied Core namespace.
          }
          const data = parsed.input.data ?? {};
          const workflowInput = data['input'] && typeof data['input'] === 'object' && !Array.isArray(data['input'])
            ? data['input'] as Record<string, unknown>
            : {};
          enrichedInput = {
            ...parsed.input,
            data: {
              ...data,
              input: {
                ...workflowInput,
                labels: impact
                  ? mergeIncidentImpactLabels(workflowInput['labels'], impact)
                  : mergeIncidentImpactLabels(workflowInput['labels'], null),
              },
            },
          };
        }
        const execution: A2aExecutionContext | undefined = user
          ? {
              ...resolveAuthorizedWorkspaceScope(req, user),
              principalKind: 'user',
              principalId: String(user.id),
              principalAllowedBundleIds: user.allowed_bundles,
              requestedBundleIds: parsed.requestedBundleIds,
              requestedResourceScope: parsed.requestedResourceScope,
              runtimeMode: parsed.runtimeMode,
            }
          : undefined;
        const result = await a2a.sendMessage(
          packId,
          agentId,
          enrichedInput,
          execution,
        );
        if (parsed.nativeAlertIncidentId && incidentAiopsTasks) {
          await incidentAiopsTasks.create({
            incidentId: parsed.nativeAlertIncidentId,
            packId,
            agentId,
            taskId: result.task.id,
            createdBy: user?.id ?? null,
            snapshot: incidentAiopsSnapshotFromTask(result.task, result.rootTraceId),
            executionContext: incidentExecutionContext(
              enrichedInput,
              parsed.requestedBundleIds,
              parsed.requestedResourceScope,
              parsed.nativeAlertIncidentId,
            ),
          });
        }
        res.json(result);
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.get(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/executor-candidates',
    requireAuth,
    requirePermission('aiops.remediation.propose'),
    async (req, res) => {
      try {
        if (!incidentRemediationExecutor) {
          throw new IncidentRemediationError(503, 'remediation_executor_unavailable', 'incident remediation executor is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        if (!Number.isSafeInteger(incidentId) || incidentId <= 0
          || !Number.isSafeInteger(remediationId) || remediationId <= 0) {
          throw new IncidentRemediationError(400, 'invalid_remediation_id', 'incident and remediation IDs must be positive integers');
        }
        const candidates = await incidentRemediationExecutor.listCandidates(incidentId, remediationId);
        res.json({ incidentId, remediationId, total: candidates.length, candidates });
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/dry-runs',
    requireAuth,
    requirePermission('aiops.remediation.propose'),
    requireSameOrigin,
    async (req, res) => {
      try {
        if (!incidentRemediationExecutor) {
          throw new IncidentRemediationError(503, 'remediation_executor_unavailable', 'incident remediation executor is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        if (!Number.isSafeInteger(incidentId) || incidentId <= 0
          || !Number.isSafeInteger(remediationId) || remediationId <= 0) {
          throw new IncidentRemediationError(400, 'invalid_remediation_id', 'incident and remediation IDs must be positive integers');
        }
        const body = req.body as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new IncidentRemediationError(400, 'invalid_dry_run_request', 'JSON object required');
        }
        const input = body as Record<string, unknown>;
        const args = input['arguments'];
        if (Object.keys(input).some(key => !['version', 'bundleId', 'toolName', 'arguments'].includes(key))
          || !Number.isSafeInteger(input['version']) || Number(input['version']) <= 0
          || !Number.isSafeInteger(input['bundleId']) || Number(input['bundleId']) <= 0
          || typeof input['toolName'] !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input['toolName'])
          || !args || typeof args !== 'object' || Array.isArray(args)) {
          throw new IncidentRemediationError(400, 'invalid_dry_run_request', 'version, bundleId, toolName and an arguments object are required');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentRemediationError(401, 'operator_required', 'authenticated operator identity is required');
        const result = await incidentRemediationExecutor.runDryRun({
          incidentId,
          remediationId,
          expectedVersion: Number(input['version']),
          bundleId: Number(input['bundleId']),
          toolName: input['toolName'],
          arguments: args as Record<string, unknown>,
          operator: remediationOperator(req, user),
        });
        res.json(result);
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.get(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/write-adapters',
    requireAuth,
    requirePermission('aiops.remediation.propose'),
    async (req, res) => {
      try {
        if (!incidentRemediationExecutor) {
          throw new IncidentRemediationError(503, 'remediation_executor_unavailable', 'incident remediation executor is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        if (!Number.isSafeInteger(incidentId) || incidentId <= 0
          || !Number.isSafeInteger(remediationId) || remediationId <= 0) {
          throw new IncidentRemediationError(400, 'invalid_remediation_id', 'incident and remediation IDs must be positive integers');
        }
        const adapters = await incidentRemediationExecutor.listWriteAdapters(incidentId, remediationId);
        res.json({ incidentId, remediationId, total: adapters.length, adapters });
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/change-plans',
    requireAuth,
    requirePermission('aiops.remediation.propose'),
    requireSameOrigin,
    async (req, res) => {
      try {
        if (!incidentRemediationExecutor) {
          throw new IncidentRemediationError(503, 'remediation_executor_unavailable', 'incident remediation executor is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        const body = req.body as Record<string, unknown> | null;
        const adapterKey = body?.['adapterKey'];
        const scaleRequest = adapterKey === 'kubernetes.scale.v1'
          && ['Deployment', 'StatefulSet'].includes(String(body?.['workloadKind']))
          && Number.isSafeInteger(body?.['desiredReplicas']);
        const revisionRequest = adapterKey === 'kubernetes.deployment-revision-rollback.v1'
          && body?.['workloadKind'] === 'Deployment'
          && Number.isSafeInteger(body?.['targetRevision']);
        if (!Number.isSafeInteger(incidentId) || incidentId <= 0
          || !Number.isSafeInteger(remediationId) || remediationId <= 0
          || !body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['version', 'adapterKey', 'bundleId', 'writeToolName', 'workloadKind', 'workloadName', 'desiredReplicas', 'targetRevision'].includes(key))
          || !Number.isSafeInteger(body['version']) || Number(body['version']) <= 0
          || (!scaleRequest && !revisionRequest)
          || !Number.isSafeInteger(body['bundleId']) || Number(body['bundleId']) <= 0
          || typeof body['writeToolName'] !== 'string'
          || typeof body['workloadName'] !== 'string') {
          throw new IncidentRemediationError(400, 'invalid_change_plan_request', 'valid version, registered adapter, tool and bounded workload intent are required');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentRemediationError(401, 'operator_required', 'authenticated operator identity is required');
        const result = await incidentRemediationExecutor.createChangePlan({
          adapterKey: adapterKey as 'kubernetes.scale.v1' | 'kubernetes.deployment-revision-rollback.v1',
          incidentId,
          remediationId,
          expectedRemediationVersion: Number(body['version']),
          bundleId: Number(body['bundleId']),
          writeToolName: body['writeToolName'],
          workloadKind: body['workloadKind'] as 'Deployment' | 'StatefulSet',
          workloadName: body['workloadName'],
          ...(scaleRequest ? { desiredReplicas: Number(body['desiredReplicas']) } : {}),
          ...(revisionRequest ? { targetRevision: Number(body['targetRevision']) } : {}),
          operator: remediationOperator(req, user),
        });
        res.json(result);
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/change-plans/:planId/decision',
    requireAuth,
    requirePermission('aiops.remediation.approve'),
    requireSameOrigin,
    async (req, res) => {
      try {
        if (!incidentRemediationExecutor) {
          throw new IncidentRemediationError(503, 'remediation_executor_unavailable', 'incident remediation executor is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        const planId = Number(routeParam(req.params.planId));
        const body = req.body as Record<string, unknown> | null;
        if (![incidentId, remediationId, planId].every(value => Number.isSafeInteger(value) && value > 0)
          || !body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['version', 'planHash', 'decision', 'comment'].includes(key))
          || !Number.isSafeInteger(body['version']) || Number(body['version']) <= 0
          || typeof body['planHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(body['planHash'])
          || !['approve', 'reject'].includes(String(body['decision']))
          || (body['comment'] != null && typeof body['comment'] !== 'string')) {
          throw new IncidentRemediationError(400, 'invalid_change_plan_decision', 'valid plan version, hash and decision are required');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentRemediationError(401, 'operator_required', 'authenticated operator identity is required');
        const result = await incidentRemediationExecutor.decideChangePlan({
          incidentId, remediationId, planId,
          expectedPlanVersion: Number(body['version']),
          planHash: body['planHash'],
          decision: body['decision'] as 'approve' | 'reject',
          comment: typeof body['comment'] === 'string' ? body['comment'] : null,
          operator: remediationOperator(req, user),
        });
        res.json(result);
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/change-plans/:planId/execute',
    requireAuth,
    requirePermission('aiops.remediation.execute'),
    requireSameOrigin,
    async (req, res) => {
      try {
        if (!incidentRemediationExecutor) {
          throw new IncidentRemediationError(503, 'remediation_executor_unavailable', 'incident remediation executor is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        const planId = Number(routeParam(req.params.planId));
        const body = req.body as Record<string, unknown> | null;
        if (![incidentId, remediationId, planId].every(value => Number.isSafeInteger(value) && value > 0)
          || !body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['version', 'planHash'].includes(key))
          || !Number.isSafeInteger(body['version']) || Number(body['version']) <= 0
          || typeof body['planHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(body['planHash'])) {
          throw new IncidentRemediationError(400, 'invalid_change_plan_execution', 'valid plan version and hash are required');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentRemediationError(401, 'operator_required', 'authenticated operator identity is required');
        const result = await incidentRemediationExecutor.executeChangePlan({
          incidentId, remediationId, planId,
          expectedPlanVersion: Number(body['version']),
          planHash: body['planHash'],
          operator: remediationOperator(req, user),
        });
        res.json(result);
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/change-plans/:planId/post-change-monitor/check',
    requireAuth,
    requirePermission('aiops.remediation.execute'),
    requireSameOrigin,
    async (req, res) => {
      try {
        if (!incidentRemediationExecutor) throw new IncidentRemediationError(503, 'remediation_executor_unavailable', 'incident remediation executor is unavailable');
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        const planId = Number(routeParam(req.params.planId));
        const body = req.body as Record<string, unknown> | null;
        if (![incidentId, remediationId, planId].every(value => Number.isSafeInteger(value) && value > 0)
          || !body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['monitorId', 'version', 'rollbackHash'].includes(key))
          || !Number.isSafeInteger(body['monitorId']) || Number(body['monitorId']) <= 0
          || !Number.isSafeInteger(body['version']) || Number(body['version']) <= 0
          || typeof body['rollbackHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(body['rollbackHash'])) {
          throw new IncidentRemediationError(400, 'invalid_post_change_monitor_request', 'valid monitor id, version and rollback hash are required');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentRemediationError(401, 'operator_required', 'authenticated operator identity is required');
        res.json(await incidentRemediationExecutor.monitorPostChange({
          incidentId, remediationId, planId, monitorId: Number(body['monitorId']),
          expectedMonitorVersion: Number(body['version']), rollbackHash: body['rollbackHash'],
          operator: remediationOperator(req, user),
        }));
      } catch (cause) { a2aError(res, cause); }
    },
  );

  app.post(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/change-plans/:planId/post-change-monitor/decision',
    requireAuth,
    requirePermission('aiops.remediation.approve'),
    requireSameOrigin,
    async (req, res) => {
      try {
        if (!incidentRemediationExecutor) throw new IncidentRemediationError(503, 'remediation_executor_unavailable', 'incident remediation executor is unavailable');
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        const planId = Number(routeParam(req.params.planId));
        const body = req.body as Record<string, unknown> | null;
        if (![incidentId, remediationId, planId].every(value => Number.isSafeInteger(value) && value > 0)
          || !body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['monitorId', 'version', 'rollbackHash', 'decision', 'comment'].includes(key))
          || !Number.isSafeInteger(body['monitorId']) || Number(body['monitorId']) <= 0
          || !Number.isSafeInteger(body['version']) || Number(body['version']) <= 0
          || typeof body['rollbackHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(body['rollbackHash'])
          || !['approve', 'reject'].includes(String(body['decision']))
          || (body['comment'] != null && typeof body['comment'] !== 'string')) {
          throw new IncidentRemediationError(400, 'invalid_post_change_rollback_decision', 'valid monitor id, version, rollback hash and decision are required');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentRemediationError(401, 'operator_required', 'authenticated operator identity is required');
        res.json(await incidentRemediationExecutor.decidePostChangeRollback({
          incidentId, remediationId, planId, monitorId: Number(body['monitorId']),
          expectedMonitorVersion: Number(body['version']), rollbackHash: body['rollbackHash'],
          decision: body['decision'] as 'approve' | 'reject',
          comment: typeof body['comment'] === 'string' ? body['comment'] : null,
          operator: remediationOperator(req, user),
        }));
      } catch (cause) { a2aError(res, cause); }
    },
  );

  app.post(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/change-plans/:planId/post-change-monitor/execute-rollback',
    requireAuth,
    requirePermission('aiops.remediation.execute'),
    requireSameOrigin,
    async (req, res) => {
      try {
        if (!incidentRemediationExecutor) throw new IncidentRemediationError(503, 'remediation_executor_unavailable', 'incident remediation executor is unavailable');
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        const planId = Number(routeParam(req.params.planId));
        const body = req.body as Record<string, unknown> | null;
        if (![incidentId, remediationId, planId].every(value => Number.isSafeInteger(value) && value > 0)
          || !body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['monitorId', 'version', 'rollbackHash'].includes(key))
          || !Number.isSafeInteger(body['monitorId']) || Number(body['monitorId']) <= 0
          || !Number.isSafeInteger(body['version']) || Number(body['version']) <= 0
          || typeof body['rollbackHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(body['rollbackHash'])) {
          throw new IncidentRemediationError(400, 'invalid_post_change_rollback_execution', 'valid monitor id, version and rollback hash are required');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentRemediationError(401, 'operator_required', 'authenticated operator identity is required');
        res.json(await incidentRemediationExecutor.executePostChangeRollback({
          incidentId, remediationId, planId, monitorId: Number(body['monitorId']),
          expectedMonitorVersion: Number(body['version']), rollbackHash: body['rollbackHash'],
          operator: remediationOperator(req, user),
        }));
      } catch (cause) { a2aError(res, cause); }
    },
  );

  app.get(
    '/api/ui/observability/alerts/:incidentId/aiops-investigations',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        if (!incidentAiopsTasks) {
          throw new A2aClientError(503, 'incident_correlation_unavailable', 'native alert correlation persistence is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        if (!Number.isSafeInteger(incidentId) || incidentId <= 0) {
          throw new A2aClientError(400, 'invalid_incident_id', 'incident ID must be a positive integer');
        }
        if (!await incidentAiopsTasks.incidentExists(incidentId)) {
          throw new A2aClientError(404, 'incident_not_found', `native alert incident '${incidentId}' was not found`);
        }
        const records = await incidentAiopsTasks.list(incidentId, 10);
        const investigations = await Promise.all(records.map(async record => {
          try {
            const task = await a2a.getTask(record.packId, record.agentId, record.taskId);
            const current = await incidentAiopsTasks.update(
              record.id,
              incidentAiopsSnapshotFromTask(task, record.rootTraceId),
            );
            return { ...current, statusAvailable: true };
          } catch {
            return { ...record, statusAvailable: false };
          }
        }));
        if (incidentRemediations) {
          for (const investigation of investigations) {
            await incidentRemediations.syncFromInvestigation(investigation);
          }
        }
        const remediations = incidentRemediations
          ? await incidentRemediations.listForIncident(incidentId)
          : [];
        const automation = incidentAiopsAutomation
          ? await incidentAiopsAutomation.getForIncident(incidentId)
          : null;
        res.json({ incidentId, total: investigations.length, investigations, automation, remediations });
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/ui/observability/alerts/:incidentId/remediations/:remediationId/decision',
    requireAuth,
    requirePermission('aiops.remediation.approve'),
    requireSameOrigin,
    async (req, res) => {
      try {
        if (!incidentRemediations || !incidentAiopsTasks) {
          throw new IncidentRemediationError(503, 'remediation_unavailable', 'incident remediation persistence is unavailable');
        }
        const incidentId = Number(routeParam(req.params.incidentId));
        const remediationId = Number(routeParam(req.params.remediationId));
        if (!Number.isSafeInteger(incidentId) || incidentId <= 0
          || !Number.isSafeInteger(remediationId) || remediationId <= 0) {
          throw new IncidentRemediationError(400, 'invalid_remediation_id', 'incident and remediation IDs must be positive integers');
        }
        if (!await incidentAiopsTasks.incidentExists(incidentId)) {
          throw new IncidentRemediationError(404, 'incident_not_found', `native alert incident '${incidentId}' was not found`);
        }
        const body = req.body as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new IncidentRemediationError(400, 'invalid_remediation_decision', 'JSON object required');
        }
        const input = body as Record<string, unknown>;
        if (Object.keys(input).some(key => !['decision', 'comment', 'version'].includes(key))
          || !['approve', 'reject'].includes(String(input['decision']))
          || !Number.isSafeInteger(input['version']) || Number(input['version']) <= 0
          || (input['comment'] !== undefined && input['comment'] !== null && typeof input['comment'] !== 'string')) {
          throw new IncidentRemediationError(400, 'invalid_remediation_decision', 'decision, version and an optional comment are required');
        }
        const comment = typeof input['comment'] === 'string' ? input['comment'].trim() : null;
        if (comment && comment.length > 2_000) {
          throw new IncidentRemediationError(400, 'invalid_remediation_comment', 'comment must not exceed 2000 characters');
        }
        const user = (req as AuthenticatedRequest).user;
        if (!user) throw new IncidentRemediationError(401, 'reviewer_required', 'authenticated reviewer identity is required');
        const remediation = await incidentRemediations.decide({
          incidentId,
          remediationId,
          expectedVersion: Number(input['version']),
          decision: input['decision'] as 'approve' | 'reject',
          reviewer: { id: user.id, username: user.username },
          comment,
        });
        res.json({ remediation });
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.get(
    '/api/admin/solution-packs/:packId/agents/:agentId/a2a/tasks',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const limit = req.query['limit'] === undefined ? 20 : Number(req.query['limit']);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          throw new A2aClientError(400, 'invalid_task_limit', 'task limit must be an integer from 1 to 50');
        }
        const rawCursor = req.query['cursor'];
        if (rawCursor !== undefined && typeof rawCursor !== 'string') {
          throw new A2aClientError(400, 'invalid_task_cursor', 'task cursor must be a string');
        }
        res.json(await a2a.listTasks(
          routeParam(req.params.packId),
          routeParam(req.params.agentId),
          { limit, ...(rawCursor ? { cursor: rawCursor } : {}) },
        ));
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.get(
    '/api/admin/solution-packs/:packId/agents/:agentId/a2a/tasks/:taskId',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        res.json({
          task: await a2a.getTask(
            routeParam(req.params.packId),
            routeParam(req.params.agentId),
            routeParam(req.params.taskId),
          ),
        });
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );

  app.post(
    '/api/admin/solution-packs/:packId/agents/:agentId/a2a/tasks/:taskId/cancel',
    requireAuth,
    requireAdmin,
    requireSameOrigin,
    async (req, res) => {
      try {
        res.json({
          task: await a2a.cancelTask(
            routeParam(req.params.packId),
            routeParam(req.params.agentId),
            routeParam(req.params.taskId),
          ),
        });
      } catch (cause) {
        a2aError(res, cause);
      }
    },
  );
}
