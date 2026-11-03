import { jest } from '@jest/globals';
import type pg from 'pg';
import type { IncidentAiopsTaskRecord } from '../incidentAiopsTasks.js';
import {
  IncidentRemediationError,
  PostgresIncidentRemediationStore,
} from '../incidentRemediations.js';

const createdAt = '2026-08-13T10:00:00.000Z';

function investigation(): IncidentAiopsTaskRecord {
  return {
    id: 15,
    incidentId: 81,
    packId: 'argus.aiops',
    agentId: 'incident-orchestrator',
    taskId: 'task-81',
    rootTraceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    state: 'TASK_STATE_COMPLETED',
    quality: 'reviewed',
    summary: 'PostgreSQL is a suspected contributor.',
    executionContext: {
      bundleIds: [28],
      resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
      service: 'checkout-api', environment: 'demo', capturedAt: createdAt,
      serviceProfile: null, trigger: null,
    },
    result: {
      schemaVersion: 1,
      sourceSchemaVersion: 2,
      generatedAt: createdAt,
      quality: 'reviewed',
      conclusion: 'suspected',
      executiveAssessment: 'PostgreSQL is a suspected contributor.',
      rootCause: null,
      hypotheses: [],
      evidence: [],
      recommendedActions: [{
        priority: 'now',
        action: 'Inspect PostgreSQL saturation.',
        rationale: 'The database is on the failing request path.',
        requiresApproval: true,
      }],
    },
    createdBy: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function remediationRow(status = 'approved', version = 2) {
  return {
    id: 91,
    incident_id: 81,
    task_link_id: 15,
    task_id: 'task-81',
    root_trace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    source_action_index: 0,
    priority: 'now',
    action: 'Inspect PostgreSQL saturation.',
    rationale: 'The database is on the failing request path.',
    requires_approval: true,
    risk_level: 'high',
    execution_mode: 'proposal_only',
    executor_bundle_id: null,
    executor_tool_name: null,
    target_scope: { kind: 'kubernetes', namespace: 'argus-demo' },
    execution_intent: null,
    status,
    version,
    created_by: 1,
    decided_by: 1,
    decided_by_username: 'Alex',
    decision_comment: 'Approved for governed validation.',
    decided_at: createdAt,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe('incident remediation store', () => {
  it('materializes normalized recommendations idempotently as proposal-only records', async () => {
    let insertCount = 0;
    const query = jest.fn(async (text: string, _params?: unknown[]) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('INSERT INTO mcp_observability_incident_remediations')) {
        insertCount++;
        return { rows: insertCount === 1 ? [{ id: 91 }] : [] };
      }
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;
    const store = new PostgresIncidentRemediationStore(pool);

    await expect(store.syncFromInvestigation(investigation())).resolves.toBe(1);
    await expect(store.syncFromInvestigation(investigation())).resolves.toBe(0);
    const proposalInsert = query.mock.calls.find(call => String(call[0]).includes('incident_remediations'));
    expect(String(proposalInsert?.[0])).toContain("'proposal_only'");
    expect(String(proposalInsert?.[0])).toContain('task.execution_resource_scope');
    expect(String(proposalInsert?.[0])).not.toContain('mcp_observability_alert_rules');
    expect(proposalInsert?.[1]).toEqual(expect.arrayContaining(['now', 'high']));
    expect(query.mock.calls.filter(call => String(call[0]).includes('incident_remediation_events'))).toHaveLength(1);
  });

  it('approves only the expected proposal version and appends a decision event', async () => {
    const clientQuery = jest.fn(async (text: string) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT status, version')) return { rows: [{ status: 'proposed', version: 1 }] };
      if (text.includes('UPDATE mcp_observability_incident_remediations')) return { rows: [remediationRow()] };
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });
    const poolQuery = jest.fn(async () => ({ rows: [{
      id: 2, remediation_id: 91, event_type: 'approved', actor_user_id: 1,
      actor_username: 'Alex', comment: 'Approved for governed validation.', metadata: {}, created_at: createdAt,
    }] }));
    const pool = {
      connect: jest.fn(async () => ({ query: clientQuery, release: jest.fn() })),
      query: poolQuery,
    } as unknown as pg.Pool;
    const store = new PostgresIncidentRemediationStore(pool);

    await expect(store.decide({
      incidentId: 81,
      remediationId: 91,
      expectedVersion: 1,
      decision: 'approve',
      reviewer: { id: 1, username: 'Alex' },
      comment: 'Approved for governed validation.',
    })).resolves.toMatchObject({ status: 'approved', version: 2, executionMode: 'proposal_only' });
    expect(clientQuery.mock.calls.some(call => String(call[0]).includes('incident_remediation_events'))).toBe(true);
  });

  it('requires rejection rationale and rejects stale decisions', async () => {
    const clientQuery = jest.fn(async (text: string) => {
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT status, version')) return { rows: [{ status: 'proposed', version: 2 }] };
      throw new Error(`unexpected query: ${text}`);
    });
    const pool = {
      connect: jest.fn(async () => ({ query: clientQuery, release: jest.fn() })),
    } as unknown as pg.Pool;
    const store = new PostgresIncidentRemediationStore(pool);
    const base = {
      incidentId: 81, remediationId: 91, expectedVersion: 1,
      reviewer: { id: 1, username: 'Alex' },
    };

    await expect(store.decide({ ...base, decision: 'reject', comment: 'no' }))
      .rejects.toMatchObject({ status: 400, code: 'rejection_comment_required' });
    await expect(store.decide({ ...base, decision: 'approve', comment: null }))
      .rejects.toEqual(expect.objectContaining<Partial<IncidentRemediationError>>({ status: 409, code: 'remediation_version_conflict' }));
  });
});
