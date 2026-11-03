import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { loadActiveRunSources, loadTelemetryRunSources, loadWorkflowRunSources } from '../store.js';

const viewer: SessionUser = {
  id: 17, username: 'alex', display_name: 'Alex', role: 'viewer', allowed_bundles: [2], entra_groups: [],
};
const defaultScope = { tenantKey: 'default', workspaceKey: 'default' };

describe('authorized run source loading', () => {
  it('applies ownership, time and bundle scope before reading workflow rows', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    await loadWorkflowRunSources({ query } as unknown as pg.Pool, viewer, false, defaultScope, 24);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('w.created_by=$2');
    expect(sql).toContain("e.triggered_by=('builder:' || $3)");
    expect(sql).toContain('visible_wb.bundle_id=ANY($5::int[])');
    expect(sql).toContain('e.tenant_key=$6');
    expect(sql).toContain('e.workspace_key=$7');
    expect(sql).not.toContain("COALESCE(execution_scope.tenant_key, 'default')");
    expect(params).toEqual([false, 17, 'alex', 24, [2], 'default', 'default', 500]);
  });

  it('scopes by the persisted execution owner and uses Golden Path rows only as a consistency check', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const selected = { tenantKey: 'acme', workspaceKey: 'engineering' };
    await loadWorkflowRunSources({ query } as unknown as pg.Pool, viewer, false, selected, 24);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('FROM mcp_golden_path_runs golden');
    expect(sql).toContain('golden.workflow_execution_id=e.id');
    // A foreign execution without a Golden Path row must not fall into the
    // selected (or default) scope.
    expect(sql).toMatch(/WHERE e\.tenant_key=\$6\s+AND e\.workspace_key=\$7/);
    expect(sql).toContain('execution_scope.tenant_key IS NULL');
    expect(sql).toContain('execution_scope.tenant_key=e.tenant_key AND execution_scope.workspace_key=e.workspace_key');
    expect(params).toEqual([false, 17, 'alex', 24, [2], 'acme', 'engineering', 500]);
  });

  it('pushes the selected scope into the telemetry SQL instead of filtering after loading', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    await loadTelemetryRunSources(
      { query } as unknown as pg.Pool,
      viewer,
      false,
      { tenantKey: 'acme', workspaceKey: 'engineering' },
      24,
    );
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("trace.metadata->>'tenantKey'");
    expect(sql).toContain("trace.metadata->>'workspaceKey'");
    expect(params).toEqual([17, false, [2], 24, 'acme', 'engineering', 500]);
  });

  it('does not expose foreign or unattributed process-local sessions to read-own users', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const records = await loadActiveRunSources(
      { query } as unknown as pg.Pool,
      { ...viewer, allowed_bundles: null },
      false,
      [
        { sessionId: 'foreign', agentId: 2, agentName: 'Foreign', agentMode: 'worker', callingUserId: 99,
          startedAt: 1, lastActivityAt: 2, iteration: 0, status: 'thinking', toolCalls: [], toolCallCount: 0,
          inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        { sessionId: 'unattributed', agentId: 3, agentName: 'Unknown', agentMode: 'worker',
          startedAt: 1, lastActivityAt: 2, iteration: 0, status: 'thinking', toolCalls: [], toolCallCount: 0,
          inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      ],
      new Set(),
      defaultScope,
    );
    expect(records).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not project legacy default active sessions into a secondary scope', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const records = await loadActiveRunSources(
      { query } as unknown as pg.Pool,
      { ...viewer, allowed_bundles: null },
      true,
      [{ sessionId: 'legacy', agentId: 2, agentName: 'Legacy', agentMode: 'worker',
        startedAt: 1, lastActivityAt: 2, iteration: 0, status: 'thinking', toolCalls: [], toolCallCount: 0,
        inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }],
      new Set(),
      { tenantKey: 'acme', workspaceKey: 'engineering' },
    );
    expect(records).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
