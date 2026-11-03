import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ExecutionGrantClaims } from './executionGrant.js';

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export type RuntimeMcpLeaseMode = 'managed';
export type RuntimeMcpLeaseStatus = 'pending' | 'active' | 'revoking' | 'revoked' | 'expired' | 'failed' | 'completed';

export interface RuntimeMcpLease {
  leaseId: string;
  executionGrantId: string;
  packId: string;
  adapterId: string;
  coreAgentId: number;
  runId: string;
  requestId: string;
  rootTraceId: string;
  mode: RuntimeMcpLeaseMode;
  status: RuntimeMcpLeaseStatus;
  issuedAt: string;
  activatedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  terminalAt: string | null;
}

export interface CreateRuntimeMcpLeaseInput {
  /** A verified, active Core grant. Its bearer value is never accepted here. */
  claims: ExecutionGrantClaims;
  packId: string;
  adapterId: string;
  coreAgentId: number;
  runId?: string;
  requestId: string;
}

export interface RuntimeMcpLeaseBinding {
  lease: RuntimeMcpLease;
  agentName: string;
}

export interface RuntimeMcpLeasePrincipal {
  kind: 'user' | 'api_key' | 'service';
  id: string;
  tenantKey?: string;
  workspaceKey?: string;
}

export class RuntimeMcpLeaseError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type LeaseRow = {
  lease_id: string;
  execution_grant_id: string;
  pack_id: string;
  adapter_id: string;
  core_agent_id: number;
  run_id: string;
  request_id: string;
  root_trace_id: string;
  mode: RuntimeMcpLeaseMode;
  status: RuntimeMcpLeaseStatus;
  issued_at: Date | string;
  activated_at: Date | string | null;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  terminal_at: Date | string | null;
  agent_name?: string;
};

function asIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toLease(row: LeaseRow): RuntimeMcpLease {
  return {
    leaseId: row.lease_id,
    executionGrantId: row.execution_grant_id,
    packId: row.pack_id,
    adapterId: row.adapter_id,
    coreAgentId: row.core_agent_id,
    runId: row.run_id,
    requestId: row.request_id,
    rootTraceId: row.root_trace_id,
    mode: row.mode,
    status: row.status,
    issuedAt: asIso(row.issued_at)!,
    activatedAt: asIso(row.activated_at),
    expiresAt: asIso(row.expires_at)!,
    revokedAt: asIso(row.revoked_at),
    terminalAt: asIso(row.terminal_at),
  };
}

function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER.test(value) || value.length > 128) {
    throw new RuntimeMcpLeaseError(400, 'invalid_runtime_lease', `${field} must be a stable identifier`);
  }
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RuntimeMcpLeaseError(400, 'invalid_runtime_lease', `${field} must be a UUID`);
  }
}

function assertCreateInput(input: CreateRuntimeMcpLeaseInput): void {
  assertIdentifier(input.packId, 'packId');
  assertIdentifier(input.adapterId, 'adapterId');
  assertUuid(input.requestId, 'requestId');
  if (input.runId) assertUuid(input.runId, 'runId');
  if (!Number.isInteger(input.coreAgentId) || input.coreAgentId <= 0) {
    throw new RuntimeMcpLeaseError(400, 'invalid_runtime_lease', 'coreAgentId must be a positive integer');
  }
  if (input.claims.aud !== input.packId || !input.claims.coreAgentIds.includes(input.coreAgentId)) {
    throw new RuntimeMcpLeaseError(403, 'runtime_lease_scope_mismatch', 'execution grant does not cover this runtime lease');
  }
}

function assertIdempotent(existing: RuntimeMcpLease, input: CreateRuntimeMcpLeaseInput): void {
  const expectedRunId = input.runId;
  if (existing.executionGrantId !== input.claims.jti
    || existing.rootTraceId !== input.claims.rootTraceId
    || existing.coreAgentId !== input.coreAgentId
    || (expectedRunId !== undefined && existing.runId !== expectedRunId)) {
    throw new RuntimeMcpLeaseError(409, 'runtime_lease_request_conflict', 'requestId is already bound to a different runtime lease');
  }
}

/**
 * Persistence boundary for the Managed Runtime MCP Lease protocol.
 *
 * This does not issue credentials.  A caller first verifies an existing
 * execution grant, then creates an opaque, idempotent lease that narrows that
 * grant to exactly one Pack adapter, Core agent, run and root trace.
 */
export class RuntimeMcpLeaseStore {
  constructor(
    private readonly pool: Pick<pg.Pool, 'query'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createPending(input: CreateRuntimeMcpLeaseInput): Promise<RuntimeMcpLease> {
    assertCreateInput(input);
    const existing = await this.findByRequest(input.packId, input.adapterId, input.requestId);
    if (existing) {
      const lease = toLease(existing);
      assertIdempotent(lease, input);
      return lease;
    }

    const expiresAt = new Date(input.claims.exp * 1000);
    if (expiresAt.getTime() <= this.now().getTime()) {
      throw new RuntimeMcpLeaseError(409, 'runtime_lease_expired', 'execution grant expires before the managed runtime can start');
    }
    try {
      const created = await this.pool.query<LeaseRow>(
        `INSERT INTO argus_runtime_mcp_leases (
           lease_id, execution_grant_id, pack_id, adapter_id, core_agent_id,
           run_id, request_id, root_trace_id, mode, status, issued_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'managed', 'pending', $9, $10)
         RETURNING lease_id, execution_grant_id, pack_id, adapter_id, core_agent_id,
                   run_id, request_id, root_trace_id, mode, status, issued_at,
                   activated_at, expires_at, revoked_at, terminal_at`,
        [
          randomUUID(), input.claims.jti, input.packId, input.adapterId,
          input.coreAgentId, input.runId ?? randomUUID(), input.requestId,
          input.claims.rootTraceId, this.now(), expiresAt,
        ],
      );
      return toLease(created.rows[0]!);
    } catch (cause) {
      // The unique (pack, adapter, request) key makes an HTTP retry idempotent
      // even when two callers race the initial SELECT. Read the winning row and
      // still reject it if the retry attempts to rebind it to a different run.
      if ((cause as { code?: string }).code !== '23505') throw cause;
      const raced = await this.findByRequest(input.packId, input.adapterId, input.requestId);
      if (!raced) throw cause;
      const lease = toLease(raced);
      assertIdempotent(lease, input);
      return lease;
    }
  }

  private async findByRequest(packId: string, adapterId: string, requestId: string): Promise<LeaseRow | null> {
    const result = await this.pool.query<LeaseRow>(
      `SELECT lease_id, execution_grant_id, pack_id, adapter_id, core_agent_id,
              run_id, request_id, root_trace_id, mode, status, issued_at,
              activated_at, expires_at, revoked_at, terminal_at
         FROM argus_runtime_mcp_leases
        WHERE pack_id=$1 AND adapter_id=$2 AND request_id=$3`,
      [packId, adapterId, requestId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Resolve an existing idempotency binding before a coordinator issues a new
   * execution grant. The caller gets only durable, non-secret lease metadata;
   * the bearer grant is deliberately never recoverable from this store.
   */
  async getByRequest(packId: string, adapterId: string, requestId: string): Promise<RuntimeMcpLease | null> {
    assertIdentifier(packId, 'packId');
    assertIdentifier(adapterId, 'adapterId');
    assertUuid(requestId, 'requestId');
    const row = await this.findByRequest(packId, adapterId, requestId);
    return row ? toLease(row) : null;
  }

  /**
   * Resolve a Pack lifecycle callback without accepting a bearer grant.
   * Browser-facing callers additionally provide their server-derived
   * principal so a guessed run UUID can never reveal or stop another user's
   * runtime. Internal reconciliation deliberately omits that filter.
   */
  async getByRun(runId: string, principal?: RuntimeMcpLeasePrincipal): Promise<RuntimeMcpLease | null> {
    assertUuid(runId, 'runId');
    const result = await this.pool.query<LeaseRow>(
      `SELECT lease.lease_id, lease.execution_grant_id, lease.pack_id,
              lease.adapter_id, lease.core_agent_id, lease.run_id,
              lease.request_id, lease.root_trace_id, lease.mode, lease.status,
              lease.issued_at, lease.activated_at, lease.expires_at,
              lease.revoked_at, lease.terminal_at
         FROM argus_runtime_mcp_leases lease
         JOIN argus_execution_grants execution_grant
           ON execution_grant.grant_id=lease.execution_grant_id
        WHERE lease.run_id=$1
          AND ($2::text IS NULL OR (
            execution_grant.principal_kind=$2 AND execution_grant.principal_id=$3
            AND execution_grant.tenant_key=$4 AND execution_grant.workspace_key=$5
          ))`,
      [runId, principal?.kind ?? null, principal?.id ?? null,
        principal ? principal.tenantKey ?? 'default' : null,
        principal ? principal.workspaceKey ?? 'default' : null],
    );
    return result.rows[0] ? toLease(result.rows[0]) : null;
  }

  /** Recent non-secret lifecycle bindings owned by one authenticated principal. */
  async listByPrincipal(
    principal: RuntimeMcpLeasePrincipal,
    packId: string,
    adapterId: string,
    limit = 20,
  ): Promise<RuntimeMcpLease[]> {
    assertIdentifier(packId, 'packId');
    assertIdentifier(adapterId, 'adapterId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RuntimeMcpLeaseError(400, 'invalid_runtime_lease', 'runtime lease list limit must be between 1 and 100');
    }
    const result = await this.pool.query<LeaseRow>(
      `SELECT lease.lease_id, lease.execution_grant_id, lease.pack_id,
              lease.adapter_id, lease.core_agent_id, lease.run_id,
              lease.request_id, lease.root_trace_id, lease.mode, lease.status,
              lease.issued_at, lease.activated_at, lease.expires_at,
              lease.revoked_at, lease.terminal_at
         FROM argus_runtime_mcp_leases lease
         JOIN argus_execution_grants execution_grant
           ON execution_grant.grant_id=lease.execution_grant_id
        WHERE lease.pack_id=$1 AND lease.adapter_id=$2
          AND execution_grant.principal_kind=$3 AND execution_grant.principal_id=$4
          AND execution_grant.tenant_key=$5 AND execution_grant.workspace_key=$6
        ORDER BY lease.issued_at DESC
        LIMIT $7`,
      [packId, adapterId, principal.kind, principal.id,
        principal.tenantKey ?? 'default', principal.workspaceKey ?? 'default', limit],
    );
    return result.rows.map(toLease);
  }

  async activate(leaseId: string): Promise<RuntimeMcpLease> {
    assertUuid(leaseId, 'leaseId');
    const result = await this.pool.query<LeaseRow>(
      `UPDATE argus_runtime_mcp_leases
          SET status='active', activated_at=COALESCE(activated_at, now())
        WHERE lease_id=$1 AND status IN ('pending', 'active') AND expires_at > now()
        RETURNING lease_id, execution_grant_id, pack_id, adapter_id, core_agent_id,
                  run_id, request_id, root_trace_id, mode, status, issued_at,
                  activated_at, expires_at, revoked_at, terminal_at`,
      [leaseId],
    );
    if (!result.rows[0]) {
      throw new RuntimeMcpLeaseError(409, 'runtime_lease_not_activatable', 'runtime lease is not pending or active');
    }
    return toLease(result.rows[0]);
  }

  async beginRevocation(leaseId: string): Promise<RuntimeMcpLease> {
    assertUuid(leaseId, 'leaseId');
    const result = await this.pool.query<LeaseRow>(
      `UPDATE argus_runtime_mcp_leases
          SET status='revoking'
        WHERE lease_id=$1 AND status IN ('pending', 'active', 'revoking')
        RETURNING lease_id, execution_grant_id, pack_id, adapter_id, core_agent_id,
                  run_id, request_id, root_trace_id, mode, status, issued_at,
                  activated_at, expires_at, revoked_at, terminal_at`,
      [leaseId],
    );
    if (!result.rows[0]) {
      throw new RuntimeMcpLeaseError(409, 'runtime_lease_not_revocable', 'runtime lease is already terminal');
    }
    return toLease(result.rows[0]);
  }

  async revoke(leaseId: string): Promise<RuntimeMcpLease> {
    assertUuid(leaseId, 'leaseId');
    const result = await this.pool.query<LeaseRow>(
      `UPDATE argus_runtime_mcp_leases
          SET status='revoked', revoked_at=COALESCE(revoked_at, now()), terminal_at=COALESCE(terminal_at, now())
        WHERE lease_id=$1 AND status IN ('pending', 'active', 'revoking', 'revoked')
        RETURNING lease_id, execution_grant_id, pack_id, adapter_id, core_agent_id,
                  run_id, request_id, root_trace_id, mode, status, issued_at,
                  activated_at, expires_at, revoked_at, terminal_at`,
      [leaseId],
    );
    if (!result.rows[0]) {
      throw new RuntimeMcpLeaseError(409, 'runtime_lease_not_revocable', 'runtime lease is already terminal');
    }
    return toLease(result.rows[0]);
  }

  /**
   * A terminal runtime result makes the lease unusable even if its signed
   * grant has not yet reached TTL. Both transitions are idempotent so a
   * Pack-event replay or a Core reconciliation retry cannot reopen a lease.
   */
  async complete(leaseId: string): Promise<RuntimeMcpLease> {
    return this.terminal(leaseId, 'completed');
  }

  async fail(leaseId: string): Promise<RuntimeMcpLease> {
    return this.terminal(leaseId, 'failed');
  }

  private async terminal(leaseId: string, status: 'completed' | 'failed'): Promise<RuntimeMcpLease> {
    assertUuid(leaseId, 'leaseId');
    const result = await this.pool.query<LeaseRow>(
      `UPDATE argus_runtime_mcp_leases
          SET status=$2, terminal_at=COALESCE(terminal_at, now())
        WHERE lease_id=$1
          -- A native completion/failure may win the race after Core has
          -- already closed tool access for a cancellation. Preserve the
          -- observed terminal truth without ever making the lease active
          -- again.
          AND status IN ('pending', 'active', 'revoking', $2)
        RETURNING lease_id, execution_grant_id, pack_id, adapter_id, core_agent_id,
                  run_id, request_id, root_trace_id, mode, status, issued_at,
                  activated_at, expires_at, revoked_at, terminal_at`,
      [leaseId, status],
    );
    if (!result.rows[0]) {
      throw new RuntimeMcpLeaseError(409, 'runtime_lease_not_terminalizable', 'runtime lease is already terminal');
    }
    return toLease(result.rows[0]);
  }

  async getActiveBinding(leaseId: string, claims: ExecutionGrantClaims): Promise<RuntimeMcpLeaseBinding> {
    assertUuid(leaseId, 'leaseId');
    const result = await this.pool.query<LeaseRow>(
      `SELECT l.lease_id, l.execution_grant_id, l.pack_id, l.adapter_id,
              l.core_agent_id, l.run_id, l.request_id, l.root_trace_id,
              l.mode, l.status, l.issued_at, l.activated_at, l.expires_at,
              l.revoked_at, l.terminal_at, a.name AS agent_name
         FROM argus_runtime_mcp_leases l
         JOIN mcp_agents a ON a.id=l.core_agent_id AND a.enabled=true
         JOIN argus_execution_grants g ON g.grant_id=l.execution_grant_id
        WHERE l.lease_id=$1
          AND l.execution_grant_id=$2
          AND l.pack_id=$3
          AND l.root_trace_id=$4
          AND g.tenant_key=$5
          AND g.workspace_key=$6
          AND l.mode='managed'
          AND l.status='active'
          AND l.expires_at > now()`,
      [leaseId, claims.jti, claims.aud, claims.rootTraceId,
        claims.tenantKey ?? 'default', claims.workspaceKey ?? 'default'],
    );
    const row = result.rows[0];
    if (!row || !claims.coreAgentIds.includes(row.core_agent_id)) {
      throw new RuntimeMcpLeaseError(403, 'runtime_lease_scope_mismatch', 'runtime lease is not active for this execution grant');
    }
    return { lease: toLease(row), agentName: row.agent_name ?? `agent-${row.core_agent_id}` };
  }
}
