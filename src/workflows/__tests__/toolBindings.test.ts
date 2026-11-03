import { describe, expect, it, jest } from '@jest/globals';
import { executeWorkflow } from '../executor.js';
import type { WorkflowPaletteTool } from '../integrationCatalog.js';
import { resolveWorkflowToolBindings } from '../toolBindings.js';
import type { WorkflowRow, WorkflowStep } from '../types.js';

function tool(overrides: Partial<WorkflowPaletteTool> & Pick<WorkflowPaletteTool, 'id' | 'name'>): WorkflowPaletteTool {
  return {
    description: '',
    backend: 'remote:test',
    tool_type: 'remote',
    parameters: [],
    schema: 'typed',
    connection_id: 1,
    connection_name: 'test',
    integration_id: 'custom-test',
    integration_label: 'Test',
    integration_brand: null,
    action_label: overrides.name,
    is_write: false,
    risk_level: 'low',
    ...overrides,
  };
}

const catalog: WorkflowPaletteTool[] = [
  tool({
    id: 1,
    name: 'github_product_get_issue',
    connection_name: 'github-product',
    integration_id: 'github',
    integration_label: 'GitHub',
    action_label: 'Get Issue',
    parameters: [
      { name: 'owner', type: 'string', required: true },
      { name: 'repo', type: 'string', required: true },
      { name: 'issue_number', type: 'number', required: true },
      { name: 'method', type: 'string', required: true },
    ],
  }),
  tool({
    id: 2,
    name: 'slack_ops_post_message',
    connection_name: 'slack-ops',
    integration_id: 'slack',
    integration_label: 'Slack',
    action_label: 'Post Message',
    is_write: true,
    risk_level: 'medium',
    parameters: [
      { name: 'channel_id', type: 'string', required: true },
      { name: 'text', type: 'string', required: true },
    ],
  }),
];

function portableSteps(): WorkflowStep[] {
  return [
    { id: 'start', label: 'Start', type: 'trigger.manual', args: {} },
    {
      id: 'read_issue', label: 'Read issue', type: 'argus.tool',
      tool_binding: {
        integration_id: 'github', action_hints: ['get_issue'], access: 'read',
        required_parameters: ['method', 'owner', 'repo', 'issue_number'],
      },
      args: { method: 'get', owner: '{{ input.owner }}', repo: '{{ input.repo }}', issue_number: '{{ input.issue }}' },
      depends_on: ['start'],
    },
    {
      id: 'triage', label: 'Triage', type: 'argus.agent', agent_id: 7,
      args: { prompt: 'Triage this evidence: {{ steps.read_issue.result }}' }, depends_on: ['read_issue'],
    },
    {
      id: 'notify', label: 'Notify', type: 'argus.tool',
      tool_binding: {
        integration_id: 'slack', action_hints: ['post_message'], access: 'write',
        required_parameters: ['channel_id', 'text'],
      },
      args: { channel_id: '{{ input.channel }}', text: '{{ steps.triage.result }}' }, depends_on: ['triage'],
    },
    {
      id: 'response', label: 'Response', type: 'logic.response',
      args: { value: '{{ steps.triage.result }}' }, depends_on: ['notify'],
    },
  ];
}

describe('portable workflow tool bindings', () => {
  it('resolves provider capabilities to connection-specific tool names and canvas evidence', () => {
    const result = resolveWorkflowToolBindings(
      portableSteps(),
      portableSteps().map((step, index) => ({
        id: step.id, type: step.type, position: { x: index * 200, y: 100 }, data: { label: step.label },
      })),
      catalog,
    );

    expect(result.ready).toBe(true);
    expect(result.steps.find(step => step.id === 'read_issue')?.tool).toBe('github_product_get_issue');
    expect(result.steps.find(step => step.id === 'notify')?.tool).toBe('slack_ops_post_message');
    expect(result.resolutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: 'read_issue', connectionName: 'github-product', ready: true }),
      expect.objectContaining({ stepId: 'notify', connectionName: 'slack-ops', ready: true }),
    ]));
    expect(result.blockDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'notify', data: expect.objectContaining({ tool: 'slack_ops_post_message', integration_id: 'slack' }) }),
    ]));
  });

  it('fails closed when a required integration or compatible action is unavailable', () => {
    const result = resolveWorkflowToolBindings(portableSteps(), [], catalog.filter(entry => entry.integration_id === 'github'));
    expect(result.ready).toBe(false);
    expect(result.resolutions.find(resolution => resolution.stepId === 'notify')).toMatchObject({
      integrationId: 'slack', ready: false, toolName: null,
    });
    expect(result.steps.find(step => step.id === 'notify')?.tool).toBeUndefined();
  });

  it('rejects a typed tool when the template omits a provider-required argument', () => {
    const steps = portableSteps();
    const read = steps.find(step => step.id === 'read_issue')!;
    delete read.args['method'];

    const result = resolveWorkflowToolBindings(steps, [], catalog);
    expect(result.ready).toBe(false);
    expect(result.resolutions.find(resolution => resolution.stepId === 'read_issue')).toMatchObject({
      integrationId: 'github', ready: false, toolName: null,
    });
  });

  it('executes the resolved GitHub to Agent to Slack chain with rendered evidence', async () => {
    const resolved = resolveWorkflowToolBindings(portableSteps(), [], catalog);
    const workflow: WorkflowRow = {
      id: 200,
      name: 'github_issue_triage_slack',
      description: 'Integration smoke flow',
      steps: resolved.steps,
      input_params: [],
      enabled: true,
      bundle_ids: [],
      created_by: null,
      created_at: '',
      updated_at: '',
    };
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const agentRunner = jest.fn(async (_agentId: number, prompt: string) => {
      expect(prompt).toContain('"title":"Broken checkout"');
      return 'Severity: high. Owner: checkout team.';
    });
    const result = await executeWorkflow({
      workflow,
      inputs: { owner: 'argus', repo: 'core', issue: 42, channel: 'C-OPS' },
      executionId: 200,
      triggeredBy: 'portable-binding-e2e',
      runners: { agentRunner },
      toolRunner: async (name, args) => {
        calls.push({ tool: name, args });
        if (name === 'github_product_get_issue') {
          return { content: [{ type: 'text', text: '{"title":"Broken checkout","number":42}' }] };
        }
        return { content: [{ type: 'text', text: 'message posted' }] };
      },
    });

    expect(result.status).toBe('completed');
    expect(calls).toEqual([
      { tool: 'github_product_get_issue', args: { method: 'get', owner: 'argus', repo: 'core', issue_number: 42 } },
      { tool: 'slack_ops_post_message', args: { channel_id: 'C-OPS', text: 'Severity: high. Owner: checkout team.' } },
    ]);
    expect(agentRunner).toHaveBeenCalledTimes(1);
    expect(result.stepResults.response?.result).toBe('Severity: high. Owner: checkout team.');
  });
});
