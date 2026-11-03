import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  assertAIOpsKubernetesCertification,
  executionGrantSurface,
  ExecutionGrantError,
  ExecutionGrantIssuer,
  signExecutionGrant,
  verifyExecutionGrant,
  type ExecutionGrantClaims,
} from '../executionGrant.js';

const secret = 'argus-execution-grant-test-secret-32-bytes-minimum';
const nowMs = Date.parse('2026-08-02T10:00:00.000Z');
const now = Math.floor(nowMs / 1000);

function claims(): ExecutionGrantClaims {
  return {
    v: 1,
    jti: '6dbc13b5-bd57-4c2b-b503-24e381b6c8d6',
    iss: 'argus.core',
    aud: 'argus.dev',
    agent: 'coding-orchestrator',
    sub: 'user:7',
    principalKind: 'user',
    principalId: '7',
    tenantKey: 'acme',
    workspaceKey: 'payments',
    bundleIds: [11],
    coreAgentIds: [2, 3, 4, 5, 6],
    coreAgents: [
      { name: 'coder', id: 2 },
      { name: 'knowledge', id: 3 },
      { name: 'planner', id: 4 },
      { name: 'researcher', id: 5 },
      { name: 'reviewer', id: 6 },
    ],
    messageId: 'message-42',
    rootTraceId: 'c295ea44-7543-4f78-b524-7a38915ad6e4',
    workspaceRoot: '/workspace/ARGUS-42',
    workspaceAccess: 'write',
    codeContextVariant: 'baseline',
    policy: 'mcp-bundle-v1',
    iat: now,
    exp: now + 900,
  };
}

describe('Solution Pack execution grants', () => {
  it('signs reusable workspace authority explicitly without changing bundle or output scope', () => {
    const current = { ...claims(), testEnvironmentPolicy: 'workspace-session-v1' as const,
      codeGeneration: { version: 1 as const, allowedPaths: ['client.ts'] } };
    const verified = verifyExecutionGrant(secret, signExecutionGrant(secret, current), {}, nowMs);
    expect(verified.testEnvironmentPolicy).toBe('workspace-session-v1');
    expect(verified.bundleIds).toEqual(claims().bundleIds);
    expect(verified.codeGeneration).toEqual(current.codeGeneration);
    for (const delta of [{ workspaceRoot: undefined }, { aud: 'argus.aiops' }, { executionSurface: 'runtime_mcp' as const }])
      expect(() => signExecutionGrant(secret, { ...current, ...delta })).toThrow();
  });
  it('binds generator write scope separately and never upgrades legacy stack grants', () => {
    const old = { ...claims(), testEnvironmentPolicy: 'general-stack-v1' as const };
    expect(verifyExecutionGrant(secret, signExecutionGrant(secret, old), {}, nowMs).codeGeneration).toBeUndefined();
    const current = { ...old, codeGeneration: { version: 1 as const, allowedPaths: ['client.ts'] } };
    expect(verifyExecutionGrant(secret, signExecutionGrant(secret, current), {}, nowMs).codeGeneration).toEqual(current.codeGeneration);
    for (const delta of [{ testEnvironmentPolicy: undefined }, { workspaceRoot: undefined }, { executionSurface: 'runtime_mcp' as const },
      { codeGeneration: { version: 1 as const, allowedPaths: ['.env'] } }]) expect(() => signExecutionGrant(secret, { ...current, ...delta })).toThrow();
    expect(() => signExecutionGrant(secret, { ...current, codeGeneration: { version: 1,
      allowedPaths: Array.from({ length: 64 }, (_, i) => `${i}-${'x'.repeat(225)}.ts`) } })).toThrow('size limit');
  });
  it('binds optional general-stack authority in the signature and never adds it to legacy grants', () => {
    const old = verifyExecutionGrant(secret, signExecutionGrant(secret, claims()), {}, nowMs);
    expect(old.testEnvironmentPolicy).toBeUndefined();
    const current = { ...claims(), testEnvironmentPolicy: 'general-stack-v1' as const };
    expect(verifyExecutionGrant(secret, signExecutionGrant(secret, current), {}, nowMs).testEnvironmentPolicy).toBe('general-stack-v1');
    expect(() => signExecutionGrant(secret, { ...current, workspaceRoot: undefined })).toThrow();
    expect(() => signExecutionGrant(secret, { ...current, executionSurface: 'runtime_mcp' })).toThrow();
  });
  it('fails closed for missing, failed or stale AIOps connector evidence', async () => {
    const scope = {
      kind: 'kubernetes' as const,
      backendId: 17,
      targetId: 'argus-aiops-kind',
      cluster: 'local-kind',
      namespace: 'argus-demo',
      environment: 'local-demo',
    };
    const policy = { warningAgeHours: 120, maxAgeHours: 168, enforceAIOps: true };
    const pool = (rows: unknown[]) => ({
      query: jest.fn().mockResolvedValue({ rows } as never),
    }) as unknown as pg.Pool;
    const row = (status: 'passed' | 'failed', generatedAt: string) => ({
      id: 1,
      backend_id: 17,
      target_id: 'argus-aiops-kind',
      platform: 'kubernetes',
      profile: 'in-cluster-read-only',
      status,
      contract_sha256: 'a'.repeat(64),
      report_sha256: 'b'.repeat(64),
      checks: [{ id: 'deployment.available', status, detail: status }],
      check_count: 1,
      passed_count: status === 'passed' ? 1 : 0,
      failed_count: status === 'failed' ? 1 : 0,
      generated_at: generatedAt,
      imported_at: generatedAt,
      imported_by: 'test',
    });

    await expect(assertAIOpsKubernetesCertification(pool([]), 'argus.aiops', scope, policy))
      .rejects.toMatchObject({ code: 'kubernetes_certification_required' });
    await expect(assertAIOpsKubernetesCertification(pool([row('failed', new Date().toISOString())]), 'argus.aiops', scope, policy))
      .rejects.toMatchObject({ code: 'kubernetes_certification_failed' });
    await expect(assertAIOpsKubernetesCertification(pool([row('passed', '2025-01-01T00:00:00.000Z')]), 'argus.aiops', scope, policy))
      .rejects.toMatchObject({ code: 'kubernetes_certification_stale' });
    await expect(assertAIOpsKubernetesCertification(pool([row('passed', new Date().toISOString())]), 'argus.aiops', scope, policy))
      .resolves.toMatchObject({ status: 'passed', freshness: 'fresh' });
  });

  it('binds a signed grant to Pack, Agent, trace, Core agents and bundles', () => {
    const token = signExecutionGrant(secret, claims());
    expect(token).toMatch(/^eg_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyExecutionGrant(secret, token, {
      packId: 'argus.dev',
      agentId: 'coding-orchestrator',
      messageId: 'message-42',
      rootTraceId: 'c295ea44-7543-4f78-b524-7a38915ad6e4',
      coreAgentId: 4,
      bundleId: 11,
      tenantKey: 'acme',
      workspaceKey: 'payments',
    }, nowMs)).toMatchObject({
      principalId: '7',
      tenantKey: 'acme',
      workspaceKey: 'payments',
      bundleIds: [11],
      coreAgents: expect.arrayContaining([{ name: 'reviewer', id: 6 }]),
      workspaceRoot: '/workspace/ARGUS-42',
      workspaceAccess: 'write',
      codeContextVariant: 'baseline',
    });
  });

  it('signs an exact AIOps service profile and tool boundary', () => {
    const aiops: ExecutionGrantClaims = {
      ...claims(),
      aud: 'argus.aiops',
      agent: 'incident-orchestrator',
      toolNames: ['aiops_loki_query_range'],
      aiopsServiceContext: {
        profileId: 41,
        revision: 3,
        profileSha256: 'a'.repeat(64),
        resolvedContextSha256: 'b'.repeat(64),
      },
    };
    delete aiops.workspaceRoot;
    delete aiops.workspaceAccess;
    const token = signExecutionGrant(secret, aiops);
    expect(verifyExecutionGrant(secret, token, {}, nowMs)).toMatchObject({
      toolNames: ['aiops_loki_query_range'],
      aiopsServiceContext: aiops.aiopsServiceContext,
    });
  });

  it('treats legacy grants as Agent-only and enforces an explicit protected surface', () => {
    const legacyClaims = claims();
    delete legacyClaims.tenantKey;
    delete legacyClaims.workspaceKey;
    const legacyToken = signExecutionGrant(secret, legacyClaims);
    const legacy = verifyExecutionGrant(secret, legacyToken, { executionSurface: 'agent' }, nowMs);
    expect(legacy.executionSurface).toBeUndefined();
    expect(executionGrantSurface(legacy)).toBe('agent');
    expect(verifyExecutionGrant(secret, legacyToken, {
      tenantKey: 'default', workspaceKey: 'default',
    }, nowMs)).toBeDefined();
    expect(() => verifyExecutionGrant(secret, legacyToken, { executionSurface: 'runtime_mcp' }, nowMs))
      .toThrow(expect.objectContaining({ code: 'execution_grant_scope_mismatch' }));

    const runtimeToken = signExecutionGrant(secret, { ...claims(), executionSurface: 'runtime_mcp' });
    expect(verifyExecutionGrant(secret, runtimeToken, { executionSurface: 'runtime_mcp' }, nowMs))
      .toMatchObject({ executionSurface: 'runtime_mcp' });
    expect(() => verifyExecutionGrant(secret, runtimeToken, { executionSurface: 'agent' }, nowMs))
      .toThrow(expect.objectContaining({ code: 'execution_grant_scope_mismatch' }));
  });

  it('issues normal workflow grants as Agent-surface grants by default', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [] } as never),
      release: jest.fn(),
    };
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM mcp_agents')) return { rows: [{ id: 42, name: 'coder' }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      connect: jest.fn().mockResolvedValue(client as never),
    } as unknown as pg.Pool;
    const issued = await new ExecutionGrantIssuer(pool, secret).issue({
      packId: 'argus.hermes',
      agentId: 'hermes-http',
      principalKind: 'user',
      principalId: '7',
      principalAllowedBundleIds: null,
      requestedBundleIds: [],
      coreAgentNames: ['coder'],
      messageId: 'managed-run-42',
      rootTraceId: 'd0a56a28-8dd4-4640-b4b6-6c6d4c2ccd8d',
    });

    const verified = verifyExecutionGrant(secret, issued, { executionSurface: 'agent' });
    expect(verified).toMatchObject({ executionSurface: 'agent', coreAgentIds: [42] });
    expect(verified.exp - verified.iat).toBe(60 * 60);
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('binds Managed Hermes to only the Coder for one Argus Dev task', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [] } as never),
      release: jest.fn(),
    };
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM mcp_service_bundles')) return { rows: [{ id: 3 }, { id: 161 }] };
        if (sql.includes('FROM mcp_agents')) return { rows: [{ id: 4, name: 'planner' }, { id: 5, name: 'coder' }] };
        if (sql.includes('FROM mcp_agent_runtime_profiles')) return { rows: [{
          id: 37,
          name: 'hermes-managed-dev',
          runtime_type: 'hermes',
          enabled: true,
          allowed_task_types: ['implement_ticket', 'review'],
          pack_id: 'argus.hermes',
          adapter_id: 'hermes-http',
          execution_strategy: 'managed',
        }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      connect: jest.fn().mockResolvedValue(client as never),
    } as unknown as pg.Pool;

    const issued = await new ExecutionGrantIssuer(pool, secret, undefined, undefined, [161]).issueWithClaims({
      packId: 'argus.dev',
      agentId: 'coding-orchestrator',
      principalKind: 'user',
      principalId: '7',
      principalAllowedBundleIds: null,
      requestedBundleIds: [3, 161],
      coreAgentNames: ['planner', 'coder'],
      messageId: 'managed-hermes-task-42',
      rootTraceId: 'd0a56a28-8dd4-4640-b4b6-6c6d4c2ccd8d',
      workspaceRoot: '/workspace/ARGUS-42',
      runtimeMode: 'managed-hermes',
      runtimeSelection: {
        source: 'argus.core',
        kind: 'runtime-selection',
        requestedMode: 'auto',
        effectiveMode: 'managed-hermes',
        reason: 'workflow_requires_coder_workspace_write',
        workflowId: 'ticket-to-pull-request',
      },
    });

    expect(issued.claims.runtimeProfileOverrides).toEqual([{
      agentId: 5,
      runtimeProfileId: 37,
      runtimeType: 'hermes',
      runtimeProfileName: 'hermes-managed-dev',
    }]);
    expect(verifyExecutionGrant(secret, issued.token).runtimeProfileOverrides)
      .toEqual(issued.claims.runtimeProfileOverrides);
    expect(verifyExecutionGrant(secret, issued.token).runtimeSelection)
      .toEqual(issued.claims.runtimeSelection);
    const traceInsert = client.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO mcp_observability_traces'));
    expect(traceInsert).toBeDefined();
    expect(String(traceInsert?.[0])).toContain('metadata=EXCLUDED.metadata || mcp_observability_traces.metadata');
    expect(JSON.parse(String((traceInsert?.[1] as unknown[])[5]))).toMatchObject({
      runtime_selection: issued.claims.runtimeSelection,
    });
  });

  it('requires a Core-approved read-only Bundle before Managed Hermes preflight or grant issuance', async () => {
    const pool = { query: jest.fn() } as unknown as pg.Pool;
    const issuer = new ExecutionGrantIssuer(pool, secret, undefined, undefined, [161]);

    await expect(issuer.assertRuntimeSelection('argus.dev', [3], 'managed-hermes'))
      .rejects.toMatchObject({ code: 'managed_hermes_read_bundle_required' });
    await expect(issuer.assertRuntimeSelection('argus.dev', [3, 161], 'managed-hermes'))
      .resolves.toBeUndefined();
    await expect(issuer.assertRuntimeSelection('argus.dev', [3], 'default'))
      .resolves.toBeUndefined();
  });

  it('rejects tampering, cross-task replay, bundle widening and expiry', () => {
    const token = signExecutionGrant(secret, claims());
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(() => verifyExecutionGrant(secret, tampered, {}, nowMs)).toThrow(ExecutionGrantError);
    expect(() => verifyExecutionGrant(secret, token, { messageId: 'another-message' }, nowMs))
      .toThrow(expect.objectContaining({ code: 'execution_grant_scope_mismatch' }));
    expect(() => verifyExecutionGrant(secret, token, { bundleId: 12 }, nowMs))
      .toThrow(expect.objectContaining({ code: 'execution_grant_scope_mismatch' }));
    expect(() => verifyExecutionGrant(secret, token, {
      tenantKey: 'acme', workspaceKey: 'another-workspace',
    }, nowMs)).toThrow(expect.objectContaining({ code: 'execution_grant_scope_mismatch' }));
    expect(() => verifyExecutionGrant(secret, token, {}, nowMs + 901_000))
      .toThrow(expect.objectContaining({ code: 'execution_grant_expired' }));
  });

  it('refuses to issue a non-default user grant without exact workspace membership', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [] } as never),
      connect: jest.fn(),
    } as unknown as pg.Pool;
    await expect(new ExecutionGrantIssuer(pool, secret).issue({
      packId: 'argus.dev',
      agentId: 'coding-orchestrator',
      principalKind: 'user',
      principalId: '7',
      tenantKey: 'acme',
      workspaceKey: 'payments',
      principalAllowedBundleIds: null,
      requestedBundleIds: [],
      coreAgentNames: ['coder'],
      messageId: 'membership-negative',
      rootTraceId: 'd0a56a28-8dd4-4640-b4b6-6c6d4c2ccd8d',
    })).rejects.toMatchObject({ code: 'workspace_scope_denied', status: 403 });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('refuses weak signing configuration', () => {
    expect(() => signExecutionGrant('short', claims()))
      .toThrow(expect.objectContaining({ code: 'execution_grants_unavailable' }));
  });
});
