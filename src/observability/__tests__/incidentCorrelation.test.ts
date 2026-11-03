import {
  changedFieldNames,
  getIncidentChangeCorrelations,
  incidentChangeKind,
} from '../incidentCorrelation.js';

describe('incident change correlation', () => {
  it('classifies platform objects and never exposes sensitive changed fields', () => {
    expect(incidentChangeKind('mcp_backends')).toBe('connection');
    expect(incidentChangeKind('mcp_agents')).toBe('agent');
    expect(incidentChangeKind('mcp_bundle_tool_assignments')).toBe('capability');
    expect(changedFieldNames(
      { name: 'old', client_secret: 'old', api_key_hash: 'hash' },
      { name: 'new', client_secret: 'new', api_key_hash: 'other', enabled: true },
    )).toEqual(['enabled', 'name']);
  });

  it('prioritizes direct and contextual changes around an incident', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 81,
        metric: 'latency_regression_percent',
        scope_kind: 'all',
        scope_value: null,
        context: { exemplars: [{ title: 'Release workflow', dominantSpanLabel: 'deploy_cluster' }] },
        triggered_at: '2026-08-01T10:00:00.000Z',
        recovered_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 9,
        action: 'updated',
        table_name: 'mcp_backends',
        object_id: '12',
        object_label: 'Production cluster',
        changed_by: 'alex',
        before_state: { name: 'Production cluster', timeout_ms: 1000, client_secret: 'hidden' },
        after_state: { name: 'Production cluster', timeout_ms: 5000, client_secret: 'still-hidden' },
        created_at: '2026-08-01T09:48:00.000Z',
      }, {
        id: 10,
        action: 'updated',
        table_name: 'mcp_tools',
        object_id: 'deploy_cluster',
        object_label: 'deploy_cluster',
        changed_by: 'platform-bot',
        before_state: { enabled: false },
        after_state: { enabled: true },
        created_at: '2026-08-01T09:55:00.000Z',
      }] });

    const result = await getIncidentChangeCorrelations({ query } as never, 81);

    expect(result?.changes).toHaveLength(2);
    expect(result?.changes[0]).toMatchObject({
      id: 10,
      relevance: 'direct',
      kind: 'capability',
      minutesFromTrigger: -5,
      phase: 'before',
      changedFields: ['enabled'],
    });
    expect(result?.changes[1]).toMatchObject({
      relevance: 'contextual',
      changedFields: ['timeout_ms'],
    });
    expect(result?.summary).toEqual({ total: 2, direct: 1, contextual: 1, temporal: 0 });
    expect(query.mock.calls[1]?.[0]).not.toContain('mcp_immutable_audit_log');
  });

  it('returns null for an unknown incident without querying changes', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    await expect(getIncidentChangeCorrelations({ query } as never, 999)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
