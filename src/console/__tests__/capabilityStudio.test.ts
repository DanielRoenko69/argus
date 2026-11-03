import { inferCapabilityIsWrite, normalizeCapabilityMutation } from '../capabilityStudio.js';

describe('Capability Studio mutation validation', () => {
  it('normalizes a parameterized read-only PostgreSQL capability', () => {
    expect(normalizeCapabilityMutation({
      name: 'incident_lookup',
      description: ' Find an incident ',
      backend: 'postgresql',
      queryTemplate: 'SELECT * FROM incidents WHERE id = {{incidentId}}',
      parameters: [{
        name: 'incidentId',
        type: 'number',
        description: 'Incident identifier',
        required: true,
      }],
      category: 'operations',
      enabled: true,
      bundleIds: [7, 7, 3],
      allowUnscoped: false,
      riskLevel: 'low',
      requiredAuthMode: null,
    })).toEqual(expect.objectContaining({
      name: 'incident_lookup',
      description: 'Find an incident',
      bundleIds: [7, 3],
      isWrite: false,
      riskLevel: 'low',
    }));
  });

  it('infers state-changing HTTP methods and requires an appropriate risk level', () => {
    expect(inferCapabilityIsWrite('custom:jira', 'POST /issues\n\n{}')).toBe(true);
    expect(inferCapabilityIsWrite('http', 'GET https://example.com/issues')).toBe(false);
    expect(() => normalizeCapabilityMutation({
      name: 'jira_create_issue',
      backend: 'custom:jira',
      queryTemplate: 'POST /issues\n\n{}',
      parameters: [],
      enabled: true,
      bundleIds: [1],
      allowUnscoped: false,
      riskLevel: 'low',
    })).toThrow('mindestens ein mittleres Risiko');
  });

  it('rejects unknown placeholders, unsafe URLs and mutating SQL', () => {
    const base = {
      name: 'unsafe_tool',
      description: '',
      parameters: [],
      category: null,
      enabled: true,
      bundleIds: [],
      allowUnscoped: true,
      riskLevel: 'low',
      requiredAuthMode: null,
    };
    expect(() => normalizeCapabilityMutation({
      ...base,
      backend: 'postgresql',
      queryTemplate: 'DELETE FROM incidents',
    })).toThrow('PostgreSQL-Capabilities');
    expect(() => normalizeCapabilityMutation({
      ...base,
      backend: 'postgresql',
      queryTemplate: 'SELECT 1; SELECT 2',
    })).toThrow('nur ein Statement');
    expect(() => normalizeCapabilityMutation({
      ...base,
      backend: 'http',
      queryTemplate: 'GET http://127.0.0.1/secrets',
    })).toThrow('interne/private');
    expect(() => normalizeCapabilityMutation({
      ...base,
      backend: 'custom:jira',
      queryTemplate: 'GET /issues/{{issueId}}',
    })).toThrow('nicht definiert');
  });

  it('requires an explicit decision before creating a globally unscoped capability', () => {
    expect(() => normalizeCapabilityMutation({
      name: 'public_lookup',
      description: '',
      backend: 'http',
      queryTemplate: 'GET https://example.com/data',
      parameters: [],
      category: null,
      enabled: true,
      bundleIds: [],
      allowUnscoped: false,
      riskLevel: 'low',
      requiredAuthMode: null,
    })).toThrow('Unscoped-Zugriff');
  });
});
