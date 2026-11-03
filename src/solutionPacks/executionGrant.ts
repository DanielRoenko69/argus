import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { codegenScope } from './codeGenerationContract.js';
import type pg from 'pg';
import { repositoryCheckoutBlocker } from './repositoryCheckout.js';
import { z } from 'zod';
import {
  checkBundleCapabilities,
  type BundleCapabilityCheck,
} from './bundleCapabilities.js';
import {
  resolveExecutionResourceScope,
  type ExecutionResourceScopeRequest,
} from './executionTargets.js';
import {
  getLatestKubernetesCertification,
  loadKubernetesCertificationPolicy,
  type KubernetesCertificationPolicy,
  type KubernetesCertificationRecord,
} from './kubernetesCertificationStore.js';
import type {
  EffectiveSolutionPackRuntimeMode,
  SolutionPackRuntimeSelection,
} from './runtimeSelection.js';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
export type { SolutionPackRuntimeMode } from './runtimeSelection.js';

const TOKEN_PREFIX = 'eg_v1';
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const WORKSPACE_ROOT_PATTERN = /^\/workspace\/[A-Za-z0-9-]+$/;
const WORKSPACE_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
// Complex governed coding runs include planning, repository hydration, tests,
// retries and review. Keep one narrowly scoped, revocable grant valid for that
// complete pipeline; per-turn managed-runtime leases remain shorter-lived.
const DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_TTL_SECONDS = 60 * 60;

const executionSurfaceSchema = z.enum(['agent', 'runtime_mcp']);
export type ExecutionGrantSurface = z.infer<typeof executionSurfaceSchema>;

const coreAgentBindingSchema = z.object({
  name: z.string().regex(ID_PATTERN),
  id: z.number().int().positive(),
}).strict();

const runtimeProfileOverrideSchema = z.object({
  agentId: z.number().int().positive(),
  runtimeProfileId: z.number().int().positive(),
  runtimeType: z.enum(['argus', 'codex', 'claude-code', 'hermes']),
  runtimeProfileName: z.string().regex(ID_PATTERN),
}).strict();

const resourceScopeSchema = z.object({
  kind: z.literal('kubernetes'),
  backendId: z.number().int().positive(),
  targetId: z.string().regex(ID_PATTERN),
  cluster: z.string().min(1).max(200),
  namespace: z.string().regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).max(63),
  environment: z.string().min(1).max(120),
}).strict();

const runtimeSelectionSchema = z.object({
  source: z.literal('argus.core'),
  kind: z.literal('runtime-selection'),
  requestedMode: z.enum(['auto', 'default', 'managed-hermes']),
  effectiveMode: z.enum(['default', 'managed-hermes']),
  reason: z.enum([
    'explicit_default',
    'explicit_managed_hermes',
    'workflow_requires_coder_workspace_write',
    'workflow_uses_agent_default',
    'managed_hermes_unavailable_use_agent_default',
  ]),
  workflowId: z.string().regex(ID_PATTERN),
}).strict();

const aiopsServiceContextSchema = z.object({
  profileId: z.number().int().positive(),
  revision: z.number().int().positive(),
  profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  resolvedContextSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const claimsSchema = z.object({
  v: z.literal(1),
  jti: z.string().uuid(),
  iss: z.literal('argus.core'),
  aud: z.string().regex(ID_PATTERN),
  agent: z.string().regex(ID_PATTERN),
  sub: z.string().min(1).max(160),
  principalKind: z.enum(['user', 'api_key', 'service']),
  principalId: z.string().min(1).max(128),
  // Optional only for verification of pre-migration, short-lived v1 grants.
  // Every new grant issued below contains both values; absence is interpreted
  // exclusively as the legacy default/default boundary.
  tenantKey: z.string().regex(WORKSPACE_SCOPE_PATTERN).optional(),
  workspaceKey: z.string().regex(WORKSPACE_SCOPE_PATTERN).optional(),
  bundleIds: z.array(z.number().int().positive()).max(64),
  toolNames: z.array(z.string().trim().min(1).max(200)).max(256).refine(values => new Set(values).size === values.length).optional(),
  coreAgentIds: z.array(z.number().int().positive()).min(1).max(128),
  // Stable names let an out-of-process Pack address the exact Core Agent IDs
  // already covered by this signed grant. Optional keeps v1 grants issued by
  // older Core versions verifiable during rolling upgrades.
  coreAgents: z.array(coreAgentBindingSchema).min(1).max(128).optional(),
  // Optional task-specific runtime choice. Core resolves and signs exact IDs;
  // the Pack may only forward this evidence and cannot change the assignment.
  runtimeProfileOverrides: z.array(runtimeProfileOverrideSchema).max(16).optional(),
  // Core's immutable explanation for the task-specific runtime choice.
  runtimeSelection: runtimeSelectionSchema.optional(),
  messageId: z.string().regex(MESSAGE_ID_PATTERN),
  rootTraceId: z.string().uuid(),
  workspaceRoot: z.string().regex(WORKSPACE_ROOT_PATTERN).optional(),
  workspaceAccess: z.enum(['read', 'write']).optional(),
  testEnvironmentPolicy: z.enum(['general-stack-v1', 'workspace-session-v1']).optional(),
  codeGeneration: z.object({ version: z.literal(1), allowedPaths: z.array(z.string()).max(64)
    .refine(paths => { try { codegenScope(paths); return true; } catch { return false; } }) }).strict().optional(),
  // Optional experiment control. Only Core can sign it; Packs may forward
  // the opaque token but cannot switch retrieval variants themselves.
  codeContextVariant: z.enum(['baseline', 'candidate']).optional(),
  // v1 grants issued before Managed Runtime MCP existed have no surface. They
  // deliberately retain the historical Agent-only behaviour during rolling
  // upgrades; callers must use executionGrantSurface() rather than treating
  // an absent field as an unconstrained grant.
  executionSurface: executionSurfaceSchema.optional(),
  resourceScope: resourceScopeSchema.optional(),
  aiopsServiceContext: aiopsServiceContextSchema.optional(),
  policy: z.literal('mcp-bundle-v1'),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict().superRefine((claims, ctx) => {
  if (claims.codeGeneration && !claims.testEnvironmentPolicy) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['codeGeneration'], message: 'requires a signed test environment policy' });
  }
  if (claims.testEnvironmentPolicy && (claims.aud !== 'argus.dev' || claims.agent !== 'coding-orchestrator'
    || !claims.workspaceRoot || claims.executionSurface === 'runtime_mcp')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['testEnvironmentPolicy'], message: 'requires a workspace-bound Argus.Dev Agent grant' });
  }
  if (claims.workspaceAccess && !claims.workspaceRoot) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workspaceAccess'],
      message: 'requires workspaceRoot',
    });
  }
  if (claims.aiopsServiceContext && (claims.aud !== 'argus.aiops' || !claims.toolNames)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['aiopsServiceContext'],
      message: 'requires an Argus AIOps audience and an exact tool allowlist',
    });
  }
  const overrideAgentIds = claims.runtimeProfileOverrides?.map(item => item.agentId) ?? [];
  if (new Set(overrideAgentIds).size !== overrideAgentIds.length
    || overrideAgentIds.some(agentId => !claims.coreAgentIds.includes(agentId))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtimeProfileOverrides'],
      message: 'must uniquely target agents already bound to this grant',
    });
  }
});

export type ExecutionGrantClaims = z.infer<typeof claimsSchema>;

export function executionGrantWorkspaceScope(
  claims: Pick<ExecutionGrantClaims, 'tenantKey' | 'workspaceKey'>,
): { tenantKey: string; workspaceKey: string } {
  return {
    tenantKey: claims.tenantKey ?? 'default',
    workspaceKey: claims.workspaceKey ?? 'default',
  };
}

/**
 * Internal-only issuance result. The signed bearer must stay inside a Core
 * control-plane call, while the verified claims let a coordinator create a
 * lease without decoding or re-parsing its own token.
 */
export interface IssuedExecutionGrant {
  token: string;
  claims: ExecutionGrantClaims;
}

/**
 * Resolve the protected surface of a verified grant.  Missing is legacy v1
 * compatibility, not an implicit wildcard: it is exactly equivalent to an
 * Agent surface grant.
 */
export function executionGrantSurface(
  claims: Pick<ExecutionGrantClaims, 'executionSurface'>,
): ExecutionGrantSurface {
  return claims.executionSurface ?? 'agent';
}

export interface ExecutionGrantIssueInput {
  packId: string;
  agentId: string;
  principalKind: ExecutionGrantClaims['principalKind'];
  principalId: string;
  tenantKey?: string;
  workspaceKey?: string;
  principalAllowedBundleIds: number[] | null;
  requestedBundleIds: number[];
  requestedToolNames?: string[];
  coreAgentNames: string[];
  messageId: string;
  rootTraceId: string;
  workspaceRoot?: string;
  workspaceAccess?: 'read' | 'write';
  testEnvironmentPolicy?: 'general-stack-v1' | 'workspace-session-v1';
  codeGeneration?: { version: 1; allowedPaths: string[] };
  codeContextVariant?: 'baseline' | 'candidate';
  /** Defaults to Agent-only execution. Managed runtimes must opt in explicitly. */
  executionSurface?: ExecutionGrantSurface;
  requestedResourceScope?: ExecutionResourceScopeRequest;
  /** Product-level choice; Core maps it to an exact enabled profile. */
  runtimeMode?: EffectiveSolutionPackRuntimeMode;
  runtimeSelection?: SolutionPackRuntimeSelection;
  aiopsServiceContext?: z.infer<typeof aiopsServiceContextSchema>;
}

export interface ExecutionGrantExpectations {
  packId?: string;
  agentId?: string;
  messageId?: string;
  rootTraceId?: string;
  coreAgentId?: number;
  bundleId?: number;
  executionSurface?: ExecutionGrantSurface;
  tenantKey?: string;
  workspaceKey?: string;
}

export interface ExecutionTargetReadiness {
  source: 'argus.core';
  kind: 'execution-target-preflight';
  ok: boolean;
  reason: 'ready' | 'not_enforced' | 'missing' | 'failed' | 'stale';
  resourceScope: NonNullable<ExecutionGrantClaims['resourceScope']>;
  certification: KubernetesCertificationRecord | null;
  policy: KubernetesCertificationPolicy;
}

export class ExecutionGrantError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionGrantError';
  }
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new ExecutionGrantError(503, 'execution_grants_unavailable', 'execution grant signing is not configured');
  }
}

function signature(secret: string, encodedPayload: string): Buffer {
  return createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${encodedPayload}`).digest();
}

function uniquePositiveIds(values: number[], field: string): number[] {
  if (!Array.isArray(values) || values.length > 128 || values.some(value => !Number.isInteger(value) || value <= 0)) {
    throw new ExecutionGrantError(400, 'invalid_execution_scope', `${field} must contain positive integer IDs`);
  }
  return [...new Set(values)];
}

export function signExecutionGrant(secret: string, claims: ExecutionGrantClaims): string {
  assertSecret(secret);
  const parsed = claimsSchema.parse(claims);
  const payload = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
  const token = `${TOKEN_PREFIX}.${payload}.${signature(secret, payload).toString('base64url')}`;
  if (token.length > 16_384) throw new ExecutionGrantError(400, 'execution_grant_too_large', 'Execution scope exceeds the grant size limit');
  return token;
}

export function verifyExecutionGrant(
  secret: string,
  token: string,
  expectations: ExecutionGrantExpectations = {},
  nowMs = Date.now(),
): ExecutionGrantClaims {
  assertSecret(secret);
  if (token.length > 16_384) throw new ExecutionGrantError(401, 'invalid_execution_grant', 'execution grant is too large');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
    throw new ExecutionGrantError(401, 'invalid_execution_grant', 'execution grant format is invalid');
  }
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[2], 'base64url');
  } catch {
    throw new ExecutionGrantError(401, 'invalid_execution_grant', 'execution grant signature is invalid');
  }
  if (provided.toString('base64url') !== parts[2]) {
    throw new ExecutionGrantError(401, 'invalid_execution_grant', 'execution grant signature is invalid');
  }
  const expected = signature(secret, parts[1]);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ExecutionGrantError(401, 'invalid_execution_grant', 'execution grant signature is invalid');
  }
  let decoded: unknown;
  try {
    const payloadBytes = Buffer.from(parts[1], 'base64url');
    if (payloadBytes.toString('base64url') !== parts[1]) throw new Error('non-canonical payload');
    decoded = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    throw new ExecutionGrantError(401, 'invalid_execution_grant', 'execution grant payload is invalid');
  }
  const result = claimsSchema.safeParse(decoded);
  if (!result.success) throw new ExecutionGrantError(401, 'invalid_execution_grant', 'execution grant claims are invalid');
  const claims = result.data;
  const now = Math.floor(nowMs / 1000);
  if (claims.iat > now + 30 || claims.exp <= now || claims.exp - claims.iat > MAX_TTL_SECONDS) {
    throw new ExecutionGrantError(401, 'execution_grant_expired', 'execution grant is expired or has an invalid lifetime');
  }
  if (expectations.packId !== undefined && claims.aud !== expectations.packId
    || expectations.agentId !== undefined && claims.agent !== expectations.agentId
    || expectations.messageId !== undefined && claims.messageId !== expectations.messageId
    || expectations.rootTraceId !== undefined && claims.rootTraceId !== expectations.rootTraceId
    || expectations.coreAgentId !== undefined && !claims.coreAgentIds.includes(expectations.coreAgentId)
    || expectations.bundleId !== undefined && !claims.bundleIds.includes(expectations.bundleId)
    || expectations.executionSurface !== undefined && executionGrantSurface(claims) !== expectations.executionSurface
    || expectations.tenantKey !== undefined && executionGrantWorkspaceScope(claims).tenantKey !== expectations.tenantKey
    || expectations.workspaceKey !== undefined && executionGrantWorkspaceScope(claims).workspaceKey !== expectations.workspaceKey) {
    throw new ExecutionGrantError(403, 'execution_grant_scope_mismatch', 'execution grant does not cover this operation');
  }
  return claims;
}

export class ExecutionGrantIssuer {
  constructor(
    private readonly pool: pg.Pool,
    private readonly secret: string,
    private readonly ttlSeconds = DEFAULT_TTL_SECONDS,
    private readonly kubernetesCertificationPolicy: KubernetesCertificationPolicy = loadKubernetesCertificationPolicy(),
    private readonly managedRuntimeReadOnlyBundleIds: readonly number[] = [],
  ) {
    assertSecret(secret);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > MAX_TTL_SECONDS) {
      throw new Error(`execution grant TTL must be between 30 and ${MAX_TTL_SECONDS} seconds`);
    }
  }

  /**
   * Validate the selected MCP Fabric scope before issuing a workflow grant.
   * This keeps the capability gate next to the grant boundary, so callers
   * cannot bypass it by skipping the console UI.
   */
  async checkBundleCapabilities(
    bundleIds: number[],
    requiredCategories: string[],
    requiredToolNames?: string[],
  ): Promise<BundleCapabilityCheck> {
    return checkBundleCapabilities(this.pool, bundleIds, requiredCategories, { requiredToolNames });
  }

  async assertRepositoryCheckout(bundleIds: number[], repository?: string): Promise<void> {
    const blocker = await repositoryCheckoutBlocker(this.pool, bundleIds, repository);
    if (blocker) throw new ExecutionGrantError(409, 'repository_checkout_conflict', blocker);
  }

  async checkExecutionTargetReadiness(
    packId: string,
    bundleIds: number[],
    requestedResourceScope: ExecutionResourceScopeRequest,
  ): Promise<ExecutionTargetReadiness> {
    let resourceScope: NonNullable<ExecutionGrantClaims['resourceScope']>;
    try {
      resourceScope = await resolveExecutionResourceScope(this.pool, bundleIds, requestedResourceScope);
    } catch (cause) {
      throw new ExecutionGrantError(
        403,
        'execution_target_scope_denied',
        cause instanceof Error ? cause.message : 'requested execution target is not allowed',
      );
    }
    const enforced = packId === 'argus.aiops' && this.kubernetesCertificationPolicy.enforceAIOps;
    const certification = enforced ? await getLatestKubernetesCertification(this.pool, {
      backendId: resourceScope.backendId,
      targetId: resourceScope.targetId,
    }, this.kubernetesCertificationPolicy) : null;
    const reason: ExecutionTargetReadiness['reason'] = !enforced
      ? 'not_enforced'
      : !certification ? 'missing'
        : certification.status === 'failed' ? 'failed'
          : certification.freshness === 'stale' ? 'stale' : 'ready';
    return {
      source: 'argus.core',
      kind: 'execution-target-preflight',
      ok: reason === 'ready' || reason === 'not_enforced',
      reason,
      resourceScope,
      certification,
      policy: this.kubernetesCertificationPolicy,
    };
  }

  /**
   * Validate task-specific runtime selection before a Pack preflight or start.
   * Managed Hermes receives only the intersection with Core's explicit
   * read-only allow-list; an empty intersection would otherwise fail after
   * planner/knowledge agents had already consumed runtime capacity.
   */
  async assertRuntimeSelection(
    packId: string,
    bundleIds: number[],
    runtimeMode: EffectiveSolutionPackRuntimeMode | undefined,
  ): Promise<void> {
    if (runtimeMode === undefined || runtimeMode === 'default') return;
    if (runtimeMode !== 'managed-hermes') {
      throw new ExecutionGrantError(400, 'invalid_runtime_mode', 'requested runtime mode is not supported');
    }
    if (packId !== 'argus.dev') {
      throw new ExecutionGrantError(400, 'invalid_runtime_mode', 'Managed Hermes task overrides are available only to Argus Dev');
    }
    const approved = new Set(this.managedRuntimeReadOnlyBundleIds);
    if (!bundleIds.some(id => approved.has(id))) {
      throw new ExecutionGrantError(
        409,
        'managed_hermes_read_bundle_required',
        'Managed Hermes requires at least one operator-approved read-only Bundle in the execution scope',
      );
    }
  }

  async issue(input: ExecutionGrantIssueInput): Promise<string> {
    return (await this.issueWithClaims(input)).token;
  }

  /**
   * Issues the same persisted grant as issue(), but returns its verified
   * in-memory claims to a Core-owned runtime coordinator. This is never a
   * browser or Pack transport API: only the caller chooses whether the token
   * is forwarded to the single managed runtime launch request.
   */
  async issueWithClaims(input: ExecutionGrantIssueInput): Promise<IssuedExecutionGrant> {
    if (input.codeGeneration && (process.env['ARGUS_CODE_GENERATION_ENABLED'] !== 'true'
      || !['general-stack-v1', 'workspace-session-v1'].includes(input.testEnvironmentPolicy ?? ''))) {
      throw new ExecutionGrantError(403, 'codegen_policy_unavailable', 'Code-generation authority is not enabled for this execution');
    }
    if (input.codeGeneration) codegenScope(input.codeGeneration.allowedPaths);
    if (input.testEnvironmentPolicy && (process.env['ARGUS_GENERAL_STACKS_ENABLED'] !== 'true'
      || input.testEnvironmentPolicy === 'workspace-session-v1' && process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] !== 'true'
      || input.packId !== 'argus.dev' || input.agentId !== 'coding-orchestrator' || !input.workspaceRoot
      || input.executionSurface === 'runtime_mcp')) {
      throw new ExecutionGrantError(403, 'stack_policy_unavailable', 'General test-stack authority is not available for this execution');
    }
    if (input.workspaceAccess && !input.workspaceRoot) {
      throw new ExecutionGrantError(400, 'invalid_workspace_scope', 'workspace access requires an exact workspace root');
    }
    const bundleIds = uniquePositiveIds(input.requestedBundleIds, 'requestedBundleIds');
    const tenantKey = input.tenantKey ?? 'default';
    const workspaceKey = input.workspaceKey ?? 'default';
    if (!WORKSPACE_SCOPE_PATTERN.test(tenantKey) || !WORKSPACE_SCOPE_PATTERN.test(workspaceKey)) {
      throw new ExecutionGrantError(400, 'invalid_workspace_scope', 'tenant and workspace scope are invalid');
    }
    // Non-default human scopes must be proven again at the credential-issuance
    // boundary. Browser routes already resolve membership, but this prevents an
    // internal caller from minting a user grant for a guessed workspace.
    if (input.principalKind === 'user'
      && /^\d+$/.test(input.principalId)
      && (tenantKey !== 'default' || workspaceKey !== 'default')) {
      const membership = await this.pool.query(
        `SELECT 1 FROM mcp_workspace_memberships
          WHERE user_id=$1 AND tenant_key=$2 AND workspace_key=$3`,
        [Number(input.principalId), tenantKey, workspaceKey],
      );
      if (!membership.rows[0]) {
        throw new ExecutionGrantError(403, 'workspace_scope_denied', 'workspace is outside the principal scope');
      }
    }
    const toolNames = input.requestedToolNames === undefined
      ? undefined
      : [...new Set(input.requestedToolNames.map(name => name.trim()))].sort();
    if (toolNames && (toolNames.length > 256 || toolNames.some(name => !name || name.length > 200))) {
      throw new ExecutionGrantError(400, 'invalid_execution_scope', 'requestedToolNames contains an invalid tool name');
    }
    const principalScope = input.principalAllowedBundleIds === null
      ? null
      : new Set(uniquePositiveIds(input.principalAllowedBundleIds, 'principalAllowedBundleIds'));
    if (principalScope && bundleIds.some(id => !principalScope.has(id))) {
      throw new ExecutionGrantError(403, 'bundle_scope_denied', 'requested bundle is outside the principal scope');
    }
    if (bundleIds.length > 0) {
      const bundles = await this.pool.query<{ id: number }>(
        'SELECT id FROM mcp_service_bundles WHERE id = ANY($1::int[])',
        [bundleIds],
      );
      if (new Set(bundles.rows.map(row => row.id)).size !== bundleIds.length) {
        throw new ExecutionGrantError(400, 'unknown_bundle', 'requested execution bundle does not exist');
      }
    }
    const names = [...new Set(input.coreAgentNames)];
    if (names.length < 1 || names.length > 128 || names.some(name => !ID_PATTERN.test(name))) {
      throw new ExecutionGrantError(409, 'invalid_pack_agent_scope', 'pack must declare stable Core agent names');
    }
    const agents = await this.pool.query<{ id: number; name: string }>(
      'SELECT id, name FROM mcp_agents WHERE enabled = true AND name = ANY($1::text[])',
      [names],
    );
    if (new Set(agents.rows.map(row => row.name)).size !== names.length) {
      throw new ExecutionGrantError(409, 'core_agent_not_ready', 'one or more required Core agents are unavailable');
    }
    let runtimeProfileOverrides: ExecutionGrantClaims['runtimeProfileOverrides'];
    const runtimeMode = input.runtimeMode ?? 'default';
    if (input.runtimeSelection && input.runtimeSelection.effectiveMode !== runtimeMode) {
      throw new ExecutionGrantError(400, 'invalid_runtime_selection', 'runtime selection does not match the effective runtime mode');
    }
    await this.assertRuntimeSelection(input.packId, bundleIds, runtimeMode);
    if (runtimeMode === 'managed-hermes') {
      const coder = agents.rows.find(row => row.name === 'coder');
      if (!coder) {
        throw new ExecutionGrantError(409, 'runtime_agent_not_ready', "Argus Dev does not declare the required 'coder' Core Agent");
      }
      const profileResult = await this.pool.query<{
        id: number;
        name: string;
        runtime_type: 'argus' | 'codex' | 'claude-code' | 'hermes';
        enabled: boolean;
        allowed_task_types: string[];
        pack_id: string | null;
        adapter_id: string | null;
        execution_strategy: string | null;
      }>(
        `SELECT p.id, p.name, p.runtime_type, p.enabled, p.allowed_task_types,
                b.pack_id, b.adapter_id, b.execution_strategy
           FROM mcp_agent_runtime_profiles p
           LEFT JOIN mcp_runtime_adapter_profiles b ON b.runtime_profile_id=p.id
          WHERE p.name='hermes-managed-dev'
          LIMIT 1`,
      );
      const profile = profileResult.rows[0];
      if (!profile || !profile.enabled
        || profile.runtime_type !== 'hermes'
        || profile.pack_id !== 'argus.hermes'
        || profile.adapter_id !== 'hermes-http'
        || profile.execution_strategy !== 'managed'
        || !profile.allowed_task_types.includes('implement_ticket')) {
        throw new ExecutionGrantError(409, 'managed_hermes_not_ready', 'Managed Hermes Dev runtime profile is unavailable or incomplete');
      }
      runtimeProfileOverrides = [{
        agentId: coder.id,
        runtimeProfileId: profile.id,
        runtimeType: profile.runtime_type,
        runtimeProfileName: profile.name,
      }];
    }
    const now = Math.floor(Date.now() / 1000);
    let resourceScope: ExecutionGrantClaims['resourceScope'];
    if (input.requestedResourceScope) {
      try {
        resourceScope = await resolveExecutionResourceScope(this.pool, bundleIds, input.requestedResourceScope);
      } catch (cause) {
        throw new ExecutionGrantError(
          403,
          'execution_target_scope_denied',
          cause instanceof Error ? cause.message : 'requested execution target is not allowed',
        );
      }
    }
    if (toolNames) {
      const bundleTools = await loadAllowedToolNames(this.pool, bundleIds, { includeUnscoped: false });
      const denied = toolNames.filter(name => !bundleTools.has(name));
      if (denied.length > 0) {
        throw new ExecutionGrantError(403, 'tool_scope_denied', 'requested tool is outside the selected MCP bundle scope');
      }
    }
    if (resourceScope) {
      await assertAIOpsKubernetesCertification(
        this.pool,
        input.packId,
        resourceScope,
        this.kubernetesCertificationPolicy,
      );
    }
    const claims: ExecutionGrantClaims = {
      v: 1,
      jti: randomUUID(),
      iss: 'argus.core',
      aud: input.packId,
      agent: input.agentId,
      sub: `${input.principalKind}:${input.principalId}`,
      principalKind: input.principalKind,
      principalId: input.principalId,
      tenantKey,
      workspaceKey,
      bundleIds,
      ...(toolNames ? { toolNames } : {}),
      coreAgentIds: agents.rows.map(row => row.id).sort((a, b) => a - b),
      coreAgents: agents.rows
        .map(row => ({ name: row.name, id: row.id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      ...(runtimeProfileOverrides ? { runtimeProfileOverrides } : {}),
      ...(input.runtimeSelection ? { runtimeSelection: input.runtimeSelection } : {}),
      messageId: input.messageId,
      rootTraceId: input.rootTraceId,
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {}),
      ...(input.testEnvironmentPolicy ? { testEnvironmentPolicy: input.testEnvironmentPolicy } : {}),
      ...(input.codeGeneration ? { codeGeneration: input.codeGeneration } : {}),
      ...(input.codeContextVariant ? { codeContextVariant: input.codeContextVariant } : {}),
      executionSurface: input.executionSurface ?? 'agent',
      ...(resourceScope ? { resourceScope } : {}),
      ...(input.aiopsServiceContext ? { aiopsServiceContext: input.aiopsServiceContext } : {}),
      policy: 'mcp-bundle-v1',
      iat: now,
      exp: now + this.ttlSeconds,
    };
    const token = signExecutionGrant(this.secret, claims);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO mcp_observability_traces (
           id, root_trace_id, parent_trace_id, parent_span_id, name, kind,
           status, session_id, user_id, started_at, input_preview, metadata
         ) VALUES ($1::uuid, $1::uuid, NULL, NULL, $2, 'workflow', 'running', $1::text, $3,
                   to_timestamp($4), $5::jsonb, $6::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           -- The first grant owns the root execution identity. A nested
           -- Managed Runtime grant deliberately reuses the root trace ID but
           -- must not replace Argus.Dev routing, bundle or principal evidence
           -- with the adapter's narrower internal grant metadata.
           metadata=EXCLUDED.metadata || mcp_observability_traces.metadata,
           updated_at=now()`,
        [
          claims.rootTraceId,
          `${claims.aud}.${claims.agent}`,
          claims.principalKind === 'user' && /^\d+$/.test(claims.principalId) ? Number(claims.principalId) : null,
          claims.iat,
          JSON.stringify({ packId: claims.aud, agentId: claims.agent, messageId: claims.messageId }),
          JSON.stringify({
            runtime: 'solution-pack',
            pack_id: claims.aud,
            pack_agent_id: claims.agent,
            execution_grant_id: claims.jti,
            bundle_ids: claims.bundleIds,
            tool_names: claims.toolNames ?? null,
            code_context_variant: claims.codeContextVariant ?? 'candidate',
            runtime_profile_overrides: claims.runtimeProfileOverrides ?? [],
            runtime_selection: claims.runtimeSelection ?? null,
            resource_scope: claims.resourceScope ?? null,
            aiops_service_context: claims.aiopsServiceContext ?? null,
            tenant_key: claims.tenantKey,
            workspace_key: claims.workspaceKey,
          }),
        ],
      );
      await client.query(
        `INSERT INTO argus_execution_grants (
         grant_id, pack_id, pack_agent_id, principal_kind, principal_id,
         bundle_ids, core_agent_ids, message_id, root_trace_id, policy_version,
         resource_scope, tool_names, aiops_service_profile_id,
         aiops_service_profile_revision, aiops_service_profile_sha256,
         aiops_resolved_context_sha256, tenant_key, workspace_key,
         issued_at, expires_at, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                 $12::text[], $13, $14, $15, $16, $17, $18,
                 to_timestamp($19), to_timestamp($20), 'active')`,
        [
          claims.jti, claims.aud, claims.agent, claims.principalKind, claims.principalId,
          claims.bundleIds, claims.coreAgentIds, claims.messageId, claims.rootTraceId,
          claims.policy, claims.resourceScope ? JSON.stringify(claims.resourceScope) : null,
          claims.toolNames ?? null,
          claims.aiopsServiceContext?.profileId ?? null,
          claims.aiopsServiceContext?.revision ?? null,
          claims.aiopsServiceContext?.profileSha256 ?? null,
          claims.aiopsServiceContext?.resolvedContextSha256 ?? null,
          claims.tenantKey, claims.workspaceKey, claims.iat, claims.exp,
        ],
      );
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
    return { token, claims };
  }

  async finalizeRootTrace(
    rootTraceId: string,
    status: 'completed' | 'failed' | 'cancelled',
    output: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE mcp_observability_traces
          SET status=$2, ended_at=COALESCE(ended_at, now()),
              duration_ms=COALESCE(duration_ms, (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint),
              output_preview=$3::jsonb,
              updated_at=now()
        WHERE id=$1::uuid AND root_trace_id=id AND metadata->>'runtime'='solution-pack'`,
      [rootTraceId, status, JSON.stringify(output)],
    );
  }
}

export async function assertAIOpsKubernetesCertification(
  pool: Pick<pg.Pool, 'query'>,
  packId: string,
  resourceScope: NonNullable<ExecutionGrantClaims['resourceScope']>,
  policy: KubernetesCertificationPolicy = loadKubernetesCertificationPolicy(),
): Promise<KubernetesCertificationRecord | null> {
  if (packId !== 'argus.aiops' || !policy.enforceAIOps) return null;
  const certification = await getLatestKubernetesCertification(pool, {
    backendId: resourceScope.backendId,
    targetId: resourceScope.targetId,
  }, policy);
  if (!certification) {
    throw new ExecutionGrantError(
      409,
      'kubernetes_certification_required',
      'AIOps execution requires connector certification evidence for the selected MCP Fabric target',
    );
  }
  if (certification.status !== 'passed') {
    throw new ExecutionGrantError(
      409,
      'kubernetes_certification_failed',
      'The latest connector certification for the selected MCP Fabric target failed',
    );
  }
  if (certification.freshness === 'stale') {
    throw new ExecutionGrantError(
      409,
      'kubernetes_certification_stale',
      `Connector certification expired at ${certification.expiresAt}; re-certify the selected MCP Fabric target`,
    );
  }
  return certification;
}

export async function assertExecutionGrantActive(pool: pg.Pool, grantId: string): Promise<void> {
  const result = await pool.query<{ status: string }>(
    `SELECT status FROM argus_execution_grants
      WHERE grant_id = $1 AND expires_at > NOW()`,
    [grantId],
  );
  if (result.rows[0]?.status !== 'active') {
    throw new ExecutionGrantError(401, 'execution_grant_inactive', 'execution grant is expired or revoked');
  }
}
