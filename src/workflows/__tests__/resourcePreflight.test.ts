import { preflightWorkflowResources } from '../resourcePreflight.js';
import type { WorkflowPaletteIntegration, WorkflowPaletteTool } from '../integrationCatalog.js';
import type { WorkflowStep } from '../types.js';

const github: WorkflowPaletteTool = {
  id: 1, name: 'github_create_issue', description: '', backend: 'remote:github', tool_type: 'remote',
  parameters: [{ name: 'owner', type: 'string', required: true }, { name: 'repo', type: 'string', required: true }],
  schema: 'typed', connection_id: 8, connection_name: 'github_prod', integration_id: 'github',
  integration_label: 'GitHub', integration_brand: 'github', action_label: 'Create Issue',
  is_write: true, risk_level: 'high',
};
const integrations: WorkflowPaletteIntegration[] = [{
  id: 'github', label: 'GitHub', description: '', category: 'Development', brand: 'github', fallback_icon: 'GitBranch',
  state: 'ready', tool_count: 1, connection_count: 1, can_configure: false, configure_href: '/mcp-fabric?catalog=github',
}, {
  id: 'slack', label: 'Slack', description: '', category: 'Communication', brand: null, fallback_icon: 'MessageSquare',
  state: 'unconfigured', tool_count: 0, connection_count: 0, can_configure: true, configure_href: '/mcp-fabric?catalog=ref-slack',
}];

function step(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id: 'notify', label: 'Create issue', type: 'argus.tool', tool: github.name, args: { owner: 'argus', repo: 'core' }, ...overrides };
}

describe('workflow resource preflight', () => {
  it('returns connection, provider and risk evidence for a ready Fabric tool', () => {
    const result = preflightWorkflowResources({
      workflowId: 7, workflowName: 'triage', steps: [step()], tools: [github], integrations,
      validation: { valid: true, errors: [], warnings: [] }, allowedBundleIds: null, checkedAt: '2026-08-21T10:00:00.000Z',
    });
    expect(result.ready).toBe(true);
    expect(result.tools[0]).toMatchObject({
      status: 'ready', integrationLabel: 'GitHub', connectionName: 'github_prod', access: 'write', riskLevel: 'high',
    });
  });

  it('blocks a stale tool and retains its saved provider configuration link', () => {
    const result = preflightWorkflowResources({
      workflowId: 7, workflowName: 'triage',
      steps: [step({ tool: 'slack_post_message', integration_id: 'slack' })], tools: [github], integrations,
      validation: { valid: true, errors: [], warnings: [] }, allowedBundleIds: null,
    });
    expect(result.ready).toBe(false);
    expect(result.tools[0]).toMatchObject({
      status: 'blocked', integrationLabel: 'Slack', configureHref: '/mcp-fabric?catalog=ref-slack',
      issue: 'Slack is not connected in MCP Fabric.',
    });
  });

  it('collects every structural, parameter and credential-scope blocker', () => {
    const result = preflightWorkflowResources({
      workflowId: 7, workflowName: 'triage',
      steps: [
        step({ id: 'missing-args', args: { owner: 'argus' } }),
        step({ id: 'denied', cred_ref: { bundle_id: 99 } }),
      ],
      tools: [github], integrations, allowedBundleIds: [3],
      validation: { valid: false, errors: [{ stepId: 'graph', issue: 'cycle detected' }], warnings: [] },
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toHaveLength(3);
    expect(result.tools[0]).toMatchObject({ status: 'blocked', missingParameters: ['repo'] });
    expect(result.tools[1]?.issue).toContain('bundle #99');
  });
});
