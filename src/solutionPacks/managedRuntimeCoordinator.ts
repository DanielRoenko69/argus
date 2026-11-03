import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ExecutionGrantClaims,
  ExecutionGrantIssueInput,
  IssuedExecutionGrant,
} from './executionGrant.js';
import type {
  ManagedRuntimeRunCancelResult,
  ManagedRuntimeRunEventsResult,
  ManagedRuntimeRunSummary,
  ManagedRuntimeRunStatusResult,
  ManagedRuntimeStartResult,
  RuntimeAdapterGateway,
} from './runtimeAdapterClient.js';
import type { SolutionPackRuntimeAdapterClient } from './runtimeAdapterClient.js';
import type { RuntimeMcpLease, RuntimeMcpLeasePrincipal } from './runtimeMcpLeases.js';

const identifier = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, 'must be a stable lowercase identifier');
const uuid = z.string().uuid();
const workspaceRoot = z.string().regex(/^\/workspace\/[^/]+$/);
const workspaceScopeKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/);
const positiveIds = z.array(z.number().int().positive()).min(1).max(64)
  .refine(values => new Set(values).size === values.length, 'must not contain duplicate IDs');

const launchInputSchema = z.object({
  packId: identifier,
  adapterId: identifier,
  requestId: uuid,
  coreAgentName: identifier,
  principal: z.object({
    kind: z.enum(['user', 'api_key', 'service']),
    id: z.string().trim().min(1).max(128),
    allowedBundleIds: z.union([positiveIds, z.null()]),
    tenantKey: workspaceScopeKey.default('default'),
    workspaceKey: workspaceScopeKey.default('default'),
  }).strict(),
  bundleIds: positiveIds,
  rootTraceId: uuid.optional(),
  workspace: z.object({
    root: workspaceRoot,
    access: z.enum(['read', 'write']),
  }).strict().optional(),
  input: z.object({ text: z.string().trim().min(1).max(64 * 1024) }).strict(),
  instructions: z.string().trim().min(1).max(8 * 1024).optional(),
  limits: z.object({
    // Managed V1 deliberately has a short, Core-owned maximum. The grant may
    // be even shorter, in which case it wins below.
    deadlineSeconds: z.number().int().min(30).max(900).default(600),
    maxToolCalls: z.number().int().min(1).max(1_000).default(64),
    maxOutputBytes: z.number().int().min(1).max(4 * 1024 * 1024).default(256 * 1024),
  }).strict().default({}),
}).strict();

const lifecycleInputSchema = z.object({
  packId: identifier,
  adapterId: identifier,
  runId: uuid,
  // Execution consumers need the Pack's bounded, in-memory final output even
  // when another status/event observer already terminalized the durable Core
  // lease. Ordinary UI/history reads keep the durable terminal fast path.
  includeOutput: z.boolean().optional(),
  principal: z.object({
    kind: z.enum(['user', 'api_key', 'service']),
    id: z.string().trim().min(1).max(128),
    tenantKey: workspaceScopeKey.default('default'),
    workspaceKey: workspaceScopeKey.default('default'),
  }).strict().optional(),
}).strict();

const listInputSchema = z.object({
  packId: identifier,
  adapterId: identifier,
  principal: z.object({
    kind: z.enum(['user', 'api_key', 'service']),
    id: z.string().trim().min(1).max(128),
    tenantKey: workspaceScopeKey.default('default'),
    workspaceKey: workspaceScopeKey.default('default'),
  }).strict(),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

const cancelInputSchema = lifecycleInputSchema.extend({
  requestId: uuid,
  reason: z.string().trim().min(1).max(1_024).optional(),
}).strict();

const eventInputSchema = lifecycleInputSchema.extend({
  after: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(),
}).strict();

export type ManagedRuntimeLaunchInput = z.input<typeof launchInputSchema>;
export type ManagedRuntimeLifecycleInput = z.input<typeof lifecycleInputSchema>;
export type ManagedRuntimeCancelInput = z.input<typeof cancelInputSchema>;
export type ManagedRuntimeEventInput = z.input<typeof eventInputSchema>;
export type ManagedRuntimeListInput = z.input<typeof listInputSchema>;

export interface ManagedRuntimeLaunchResult {
  idempotent: boolean;
  run: ManagedRuntimeRunSummary;
  lease: Omit<RuntimeMcpLease, 'executionGrantId'>;
}

/** Narrow route-facing surface; the bearer-bearing implementation stays internal. */
export interface ManagedRuntimeLaunchGateway {
  launch(input: ManagedRuntimeLaunchInput): Promise<ManagedRuntimeLaunchResult>;
}

export interface ManagedRuntimeLifecycleResult {
  run: ManagedRuntimeRunSummary;
  lease: Omit<RuntimeMcpLease, 'executionGrantId'>;
}

export interface ManagedRuntimeLifecycleGateway extends ManagedRuntimeLaunchGateway {
  list(input: ManagedRuntimeListInput): Promise<ManagedRuntimeLifecycleResult[]>;
  getStatus(input: ManagedRuntimeLifecycleInput): Promise<ManagedRuntimeLifecycleResult>;
  cancel(input: ManagedRuntimeCancelInput): Promise<ManagedRuntimeLifecycleResult>;
  getEvents(input: ManagedRuntimeEventInput): Promise<{
    run: ManagedRuntimeRunSummary;
    events: ManagedRuntimeRunEventsResult['events'];
    lastEventId?: string;
  }>;
}

export interface ManagedRuntimeCoordinatorErrorShape {
  status: 400 | 403 | 404 | 409 | 502 | 503;
  code: string;
}

export class ManagedRuntimeCoordinatorError extends Error {
  constructor(
    readonly status: ManagedRuntimeCoordinatorErrorShape['status'],
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedRuntimeCoordinatorError';
  }
}

/**
 * Core must make an explicit read-only decision before it delegates a Bundle
 * into an external runtime. There is intentionally no permissive default:
 * discovery metadata alone cannot prove that remote MCP tool descriptions are
 * mutation-free.
 */
export interface ManagedRuntimeReadOnlyPolicy {
  assertAllowed(bundleIds: readonly number[]): Promise<void>;
}

/** A small explicit policy useful until the Bundle catalog has first-class remote tool write metadata. */
export class ExplicitManagedRuntimeReadOnlyPolicy implements ManagedRuntimeReadOnlyPolicy {
  private readonly allowed = new Set<number>();

  constructor(allowedBundleIds: readonly number[]) {
    for (const id of allowedBundleIds) {
      if (!Number.isInteger(id) || id <= 0) throw new Error('managed runtime read-only bundle IDs must be positive integers');
      this.allowed.add(id);
    }
  }

  async assertAllowed(bundleIds: readonly number[]): Promise<void> {
    if (bundleIds.length === 0 || bundleIds.some(id => !this.allowed.has(id))) {
      throw new ManagedRuntimeCoordinatorError(
        409,
        'managed_runtime_read_scope_denied',
        'managed runtime V1 accepts only explicitly approved read-only bundles',
      );
    }
  }
}

export interface ManagedRuntimeGrantIssuer {
  issueWithClaims(input: ExecutionGrantIssueInput): Promise<IssuedExecutionGrant>;
}

export interface ManagedRuntimeLeaseGateway {
  getByRequest(packId: string, adapterId: string, requestId: string): Promise<RuntimeMcpLease | null>;
  getByRun(runId: string, principal?: RuntimeMcpLeasePrincipal): Promise<RuntimeMcpLease | null>;
  listByPrincipal(
    principal: RuntimeMcpLeasePrincipal,
    packId: string,
    adapterId: string,
    limit?: number,
  ): Promise<RuntimeMcpLease[]>;
  createPending(input: {
    claims: ExecutionGrantClaims;
    packId: string;
    adapterId: string;
    coreAgentId: number;
    runId: string;
    requestId: string;
  }): Promise<RuntimeMcpLease>;
  activate(leaseId: string): Promise<RuntimeMcpLease>;
  complete(leaseId: string): Promise<RuntimeMcpLease>;
  fail(leaseId: string): Promise<RuntimeMcpLease>;
  beginRevocation(leaseId: string): Promise<RuntimeMcpLease>;
  revoke(leaseId: string): Promise<RuntimeMcpLease>;
}

export interface ManagedRuntimeAdapterGateway extends RuntimeAdapterGateway {
  startManagedRun(input: Parameters<SolutionPackRuntimeAdapterClient['startManagedRun']>[0]): Promise<ManagedRuntimeStartResult>;
  getManagedRunStatus(input: Parameters<SolutionPackRuntimeAdapterClient['getManagedRunStatus']>[0]): Promise<ManagedRuntimeRunStatusResult>;
  cancelManagedRun(input: Parameters<SolutionPackRuntimeAdapterClient['cancelManagedRun']>[0]): Promise<ManagedRuntimeRunCancelResult>;
  getManagedRunEvents(input: Parameters<SolutionPackRuntimeAdapterClient['getManagedRunEvents']>[0]): Promise<ManagedRuntimeRunEventsResult>;
}

export interface ManagedRuntimeCoordinatorOptions {
  runtimeMcpOrigin: string;
  now?: () => Date;
  randomId?: () => string;
}

function sanitizeLease(lease: RuntimeMcpLease): Omit<RuntimeMcpLease, 'executionGrantId'> {
  const { executionGrantId: _executionGrantId, ...safe } = lease;
  return safe;
}

function normalizeCoreOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('runtime MCP origin must be a valid HTTP(S) URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('runtime MCP origin must be a credential-free HTTP(S) origin');
  }
  return url.origin;
}

function safeCoordinatorError(cause: unknown): ManagedRuntimeCoordinatorError {
  if (cause instanceof ManagedRuntimeCoordinatorError) return cause;
  // Adapter and grant clients own their typed public error mapping. The
  // coordinator must not relay an upstream/network message, which could carry
  // a Pack URL, native Hermes diagnostic, or other internal detail.
  const candidate = cause as { status?: unknown; code?: unknown };
  const status = candidate && [400, 403, 404, 409, 502, 503].includes(Number(candidate.status))
    ? Number(candidate.status) as ManagedRuntimeCoordinatorErrorShape['status']
    : 502;
  const code = candidate && typeof candidate.code === 'string' && /^[a-z0-9_]{1,128}$/.test(candidate.code)
    ? candidate.code
    : 'managed_runtime_start_failed';
  return new ManagedRuntimeCoordinatorError(status, code, 'managed runtime launch could not be completed');
}

/**
 * Core-owned managed-runtime launch transaction.
 *
 * It deliberately does not have an HTTP route yet. The caller is expected to
 * be an internal, admin-gated control-plane service. The only recipient of
 * the signed bearer is the single Pack start request; persistent Core state
 * receives just the JTI through RuntimeMcpLeaseStore.
 */
export class ManagedRuntimeCoordinator implements ManagedRuntimeLifecycleGateway {
  private readonly runtimeMcpOrigin: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(
    private readonly grants: ManagedRuntimeGrantIssuer,
    private readonly leases: ManagedRuntimeLeaseGateway,
    private readonly adapters: ManagedRuntimeAdapterGateway,
    private readonly readOnlyPolicy: ManagedRuntimeReadOnlyPolicy,
    options: ManagedRuntimeCoordinatorOptions,
  ) {
    this.runtimeMcpOrigin = normalizeCoreOrigin(options.runtimeMcpOrigin);
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
  }

  async launch(rawInput: ManagedRuntimeLaunchInput): Promise<ManagedRuntimeLaunchResult> {
    const parsed = launchInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_launch', 'managed runtime launch request is invalid');
    }
    const input = parsed.data;

    // Do this before any new grant issuance. A network retry has no right to
    // mint a second bearer or create another external runner.
    const existing = await this.leases.getByRequest(input.packId, input.adapterId, input.requestId);
    if (existing) {
      return {
        idempotent: true,
        run: {
          id: existing.runId,
          mode: 'managed',
          rootTraceId: existing.rootTraceId,
          // A lease has no Pack-owned native state, but its terminal boundary
          // is still authoritative. Do not turn a known cancellation/failure
          // back into a fresh-looking queued run on an HTTP retry.
          state: this.leaseState(existing),
          acceptedAt: existing.issuedAt,
          updatedAt: existing.terminalAt ?? existing.activatedAt ?? existing.issuedAt,
        },
        lease: sanitizeLease(existing),
      };
    }

    await this.readOnlyPolicy.assertAllowed(input.bundleIds);
    await this.assertAdapterReady(input.packId, input.adapterId);

    const runId = this.randomId();
    const rootTraceId = input.rootTraceId ?? this.randomId();
    const messageId = this.randomId();
    let lease: RuntimeMcpLease | undefined;
    let issued: IssuedExecutionGrant | undefined;
    try {
      issued = await this.grants.issueWithClaims({
        packId: input.packId,
        // The existing grant schema calls this a Pack agent. For a managed
        // adapter we use the immutable adapter ID; it is never used as a
        // normal /api/agents/:id capability.
        agentId: input.adapterId,
        principalKind: input.principal.kind,
        principalId: input.principal.id,
        tenantKey: input.principal.tenantKey,
        workspaceKey: input.principal.workspaceKey,
        principalAllowedBundleIds: input.principal.allowedBundleIds,
        requestedBundleIds: input.bundleIds,
        coreAgentNames: [input.coreAgentName],
        messageId,
        rootTraceId,
        ...(input.workspace ? {
          workspaceRoot: input.workspace.root,
          workspaceAccess: input.workspace.access,
        } : {}),
        executionSurface: 'runtime_mcp',
      });
      const coreAgent = issued.claims.coreAgents?.find(agent => agent.name === input.coreAgentName);
      if (!coreAgent || !issued.claims.coreAgentIds.includes(coreAgent.id)) {
        throw new ManagedRuntimeCoordinatorError(409, 'core_agent_not_ready', 'selected Core agent is not available for this managed runtime');
      }

      lease = await this.leases.createPending({
        claims: issued.claims,
        packId: input.packId,
        adapterId: input.adapterId,
        coreAgentId: coreAgent.id,
        runId,
        requestId: input.requestId,
      });
      // The Pack starts the isolated runtime while handling the start call,
      // and that runtime may perform its MCP handshake before the HTTP
      // response returns. Activate the exact lease immediately before the
      // only grant-bearing handoff so the first tools/list request cannot
      // race a pending lease. The catch path still cancels the known run and
      // terminalizes this lease if Pack acceptance cannot be confirmed.
      const active = await this.leases.activate(lease.leaseId);
      const deadline = this.deadline(issued.claims, input.limits.deadlineSeconds);
      const accepted = await this.adapters.startManagedRun({
        packId: input.packId,
        adapterId: input.adapterId,
        requestId: input.requestId,
        run: {
          id: runId,
          rootTraceId,
          messageId,
          sessionId: `managed:${runId}`,
          coreAgent: { id: coreAgent.id, name: coreAgent.name },
          input: { text: input.input.text },
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        },
        runtimeMcpLease: {
          kind: 'argus.runtime-mcp-lease/v1alpha1',
          leaseId: lease.leaseId,
          endpoint: `${this.runtimeMcpOrigin}/mcp/runtime/${lease.leaseId}`,
          executionGrant: issued.token,
          expiresAt: lease.expiresAt,
          rootTraceId,
          bundleIds: input.bundleIds,
          serverName: 'argus_core',
        },
        limits: {
          deadlineAt: deadline.toISOString(),
          maxToolCalls: input.limits.maxToolCalls,
          maxOutputBytes: input.limits.maxOutputBytes,
        },
      });
      return { idempotent: false, run: accepted.run, lease: sanitizeLease(active) };
    } catch (cause) {
      if (lease) {
        // A response may have been lost after the Pack accepted the run. Stop
        // the known run best-effort before making its MCP lease unusable. No
        // secret is needed for a cancel request.
        await this.cancelAfterFailedLaunch(input, lease).catch(() => undefined);
        await this.leases.fail(lease.leaseId).catch(() => undefined);
      }
      // Never include `cause.message`: it may contain the Pack's diagnostics
      // or, in a malformed implementation, a reflected execution grant.
      throw safeCoordinatorError(cause);
    } finally {
      // Keep token lifetime explicit in code review: it is never stored in an
      // object returned from this method. Clearing the local reference does
      // not provide cryptographic erasure, but avoids accidental reuse below.
      issued = undefined;
    }
  }

  /**
   * Read a Pack-normalized status using only the run's durable Core binding.
   * The browser never chooses the trace ID or receives the execution grant.
   */
  async getStatus(rawInput: ManagedRuntimeLifecycleInput): Promise<ManagedRuntimeLifecycleResult> {
    const input = this.parseLifecycle(rawInput);
    const lease = await this.boundLease(input);
    if (this.isTerminalLease(lease) && !(lease.status === 'completed' && input.includeOutput)) {
      return { run: this.leaseSummary(lease), lease: sanitizeLease(lease) };
    }
    try {
      const result = await this.adapters.getManagedRunStatus({
        packId: input.packId,
        adapterId: input.adapterId,
        runId: lease.runId,
        rootTraceId: lease.rootTraceId,
      });
      const settledLease = await this.syncTerminalLease(lease, result.run.state);
      return { run: result.run, lease: sanitizeLease(settledLease) };
    } catch (cause) {
      if (this.isMissingManagedRun(cause)) {
        if (this.isTerminalLease(lease)) {
          return { run: this.leaseSummary(lease), lease: sanitizeLease(lease) };
        }
        const failed = await this.leases.fail(lease.leaseId);
        return { run: this.leaseSummary(failed), lease: sanitizeLease(failed) };
      }
      throw safeCoordinatorError(cause);
    }
  }

  /**
   * List only durable, non-secret bindings owned by the authenticated caller.
   * Pack status is fetched lazily for the selected run, keeping this overview
   * bounded even when a developer has a longer execution history.
   */
  async list(rawInput: ManagedRuntimeListInput): Promise<ManagedRuntimeLifecycleResult[]> {
    const parsed = listInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_lifecycle_request', 'managed runtime list request is invalid');
    }
    const input = parsed.data;
    const leases = await this.leases.listByPrincipal(
      input.principal,
      input.packId,
      input.adapterId,
      input.limit,
    );
    return Promise.all(leases.map(async lease => {
      if (this.isTerminalLease(lease)) {
        return { run: this.leaseSummary(lease), lease: sanitizeLease(lease) };
      }
      try {
        const result = await this.adapters.getManagedRunStatus({
          packId: input.packId,
          adapterId: input.adapterId,
          runId: lease.runId,
          rootTraceId: lease.rootTraceId,
        });
        const settled = await this.syncTerminalLease(lease, result.run.state);
        return { run: result.run, lease: sanitizeLease(settled) };
      } catch (cause) {
        // A Pack restart can legitimately forget an old native run. Once the
        // Pack authoritatively reports 404, Core terminalizes the lease so the
        // UI cannot advertise a runner that no longer exists. Transient peer
        // errors deliberately retain the durable Core state for a later poll.
        if (this.isMissingManagedRun(cause)) {
          const failed = await this.leases.fail(lease.leaseId);
          return { run: this.leaseSummary(failed), lease: sanitizeLease(failed) };
        }
        return { run: this.leaseSummary(lease), lease: sanitizeLease(lease) };
      }
    }));
  }

  /**
   * Close Core's MCP side first, then ask the Pack to stop the native run.
   * If the Pack call is interrupted, the revoking lease still blocks further
   * tool access and a later cancel/status reconciliation can finish cleanup.
   */
  async cancel(rawInput: ManagedRuntimeCancelInput): Promise<ManagedRuntimeLifecycleResult> {
    const parsed = cancelInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_lifecycle_request', 'managed runtime cancellation request is invalid');
    }
    const input = parsed.data;
    const lease = await this.boundLease(input);
    if (this.isTerminalLease(lease)) {
      // Cancellation is safe to retry. We do not reopen a terminal lease or
      // ask the Pack to execute a second cancellation. Core's durable terminal
      // binding remains authoritative even if the Pack was restarted.
      return { run: this.leaseSummary(lease), lease: sanitizeLease(lease) };
    }
    try {
      const revoking = await this.leases.beginRevocation(lease.leaseId);
      const result = await this.adapters.cancelManagedRun({
        packId: input.packId,
        adapterId: input.adapterId,
        runId: lease.runId,
        rootTraceId: lease.rootTraceId,
        requestId: input.requestId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      const settledLease = await this.syncTerminalLease(revoking, result.run.state);
      return { run: result.run, lease: sanitizeLease(settledLease) };
    } catch (cause) {
      if (this.isMissingManagedRun(cause)) {
        const failed = await this.leases.fail(lease.leaseId);
        return { run: this.leaseSummary(failed), lease: sanitizeLease(failed) };
      }
      throw safeCoordinatorError(cause);
    }
  }

  /**
   * Return Core-validated, bounded normalized Pack evidence as JSON. This is
   * deliberately not a raw native-runtime SSE proxy.
   */
  async getEvents(rawInput: ManagedRuntimeEventInput): Promise<{
    run: ManagedRuntimeRunSummary;
    events: ManagedRuntimeRunEventsResult['events'];
    lastEventId?: string;
  }> {
    const parsed = eventInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_lifecycle_request', 'managed runtime event request is invalid');
    }
    const input = parsed.data;
    const lease = await this.boundLease(input);
    try {
      const result = await this.adapters.getManagedRunEvents({
        packId: input.packId,
        adapterId: input.adapterId,
        runId: lease.runId,
        rootTraceId: lease.rootTraceId,
        ...(input.after === undefined ? {} : { after: input.after }),
      });
      const last = result.events.at(-1);
      if (last) await this.syncTerminalLease(lease, last.run.state);
      return {
        run: {
          id: lease.runId,
          mode: 'managed',
          rootTraceId: lease.rootTraceId,
          state: last?.run.state ?? this.leaseState(lease),
          acceptedAt: lease.issuedAt,
          updatedAt: last?.occurredAt ?? lease.terminalAt ?? lease.activatedAt ?? lease.issuedAt,
          ...(result.lastEventId === undefined ? {} : { eventCursor: result.lastEventId }),
        },
        events: result.events,
        ...(result.lastEventId === undefined ? {} : { lastEventId: result.lastEventId }),
      };
    } catch (cause) {
      if (this.isMissingManagedRun(cause)) {
        if (this.isTerminalLease(lease)) {
          return { run: this.leaseSummary(lease), events: [] };
        }
        const failed = await this.leases.fail(lease.leaseId);
        return { run: this.leaseSummary(failed), events: [] };
      }
      throw safeCoordinatorError(cause);
    }
  }

  private parseLifecycle(rawInput: ManagedRuntimeLifecycleInput): z.output<typeof lifecycleInputSchema> {
    const parsed = lifecycleInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ManagedRuntimeCoordinatorError(400, 'invalid_managed_runtime_lifecycle_request', 'managed runtime lifecycle request is invalid');
    }
    return parsed.data;
  }

  private async boundLease(input: z.output<typeof lifecycleInputSchema>): Promise<RuntimeMcpLease> {
    const lease = await this.leases.getByRun(input.runId, input.principal);
    if (!lease || lease.packId !== input.packId || lease.adapterId !== input.adapterId) {
      throw new ManagedRuntimeCoordinatorError(404, 'managed_runtime_run_not_found', 'managed runtime run was not found');
    }
    return lease;
  }

  private async syncTerminalLease(
    lease: RuntimeMcpLease,
    state: ManagedRuntimeRunSummary['state'],
  ): Promise<RuntimeMcpLease> {
    if (this.isTerminalLease(lease)) return lease;
    if (state === 'completed') return this.leases.complete(lease.leaseId);
    if (state === 'cancelled') return this.leases.revoke(lease.leaseId);
    if (state === 'failed') return this.leases.fail(lease.leaseId);
    return lease;
  }

  private isTerminalLease(lease: RuntimeMcpLease): boolean {
    return ['revoked', 'expired', 'failed', 'completed'].includes(lease.status);
  }

  private leaseState(lease: RuntimeMcpLease): ManagedRuntimeRunSummary['state'] {
    if (lease.status === 'active') return 'running';
    if (lease.status === 'revoked') return 'cancelled';
    if (lease.status === 'failed' || lease.status === 'expired') return 'failed';
    if (lease.status === 'completed') return 'completed';
    return 'queued';
  }

  private leaseSummary(lease: RuntimeMcpLease): ManagedRuntimeRunSummary {
    return {
      id: lease.runId,
      mode: 'managed',
      rootTraceId: lease.rootTraceId,
      state: this.leaseState(lease),
      acceptedAt: lease.issuedAt,
      updatedAt: lease.terminalAt ?? lease.activatedAt ?? lease.issuedAt,
    };
  }

  private isMissingManagedRun(cause: unknown): boolean {
    return (cause as { code?: unknown } | null)?.code === 'managed_run_not_found';
  }

  private async assertAdapterReady(packId: string, adapterId: string): Promise<void> {
    const [capabilityResult, statusResult] = await Promise.all([
      this.adapters.getCapabilities(packId, adapterId),
      this.adapters.getStatus(packId, adapterId),
    ]);
    const declared = capabilityResult.capabilities;
    const managedStatus = statusResult.status.modes.find(mode => mode.mode === 'managed');
    if (!declared.modes.includes('managed')
      || !declared.capabilities.includes('runs')
      || !declared.capabilities.includes('mcp-fabric')
      || statusResult.status.state !== 'ready'
      || managedStatus?.state !== 'ready') {
      throw new ManagedRuntimeCoordinatorError(
        409,
        'managed_runtime_not_ready',
        'managed runtime adapter is not ready for a governed launch',
      );
    }
  }

  private deadline(claims: ExecutionGrantClaims, requestedSeconds: number): Date {
    const now = this.now().getTime();
    // Leave a small margin so the Pack will never receive a deadline equal to
    // an already-expired lease after normal transport latency.
    const grantDeadline = claims.exp * 1_000 - 5_000;
    const requestedDeadline = now + requestedSeconds * 1_000;
    const deadline = new Date(Math.min(grantDeadline, requestedDeadline));
    if (deadline.getTime() <= now + 5_000) {
      throw new ManagedRuntimeCoordinatorError(409, 'managed_runtime_grant_too_short', 'managed runtime grant lifetime is too short to start safely');
    }
    return deadline;
  }

  private async cancelAfterFailedLaunch(input: z.output<typeof launchInputSchema>, lease: RuntimeMcpLease): Promise<void> {
    await this.adapters.cancelManagedRun({
      packId: input.packId,
      adapterId: input.adapterId,
      runId: lease.runId,
      rootTraceId: lease.rootTraceId,
      requestId: this.randomId(),
      reason: 'Core could not complete managed runtime lease activation',
    });
  }
}
