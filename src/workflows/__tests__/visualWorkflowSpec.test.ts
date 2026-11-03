import { describe, expect, it } from '@jest/globals';
import { buildVisualWorkflowSpec, VisualWorkflowSpecError } from '../visualWorkflowSpec.js';

const source = {
  id: 42,
  name: 'governed_delivery',
  description: 'Plan, review and approve.',
  updated_at: '2026-08-20T10:00:00.000Z',
  input_params: [{ name: 'task', type: 'string' as const, description: 'Task', required: true }],
  steps: [
    { id: 'start', label: 'Start', type: 'trigger.manual', args: {} },
    { id: 'plan', label: 'Plan', type: 'argus.agent', agent_role: 'planner', args: { prompt: '{{ input.task }}' }, depends_on: ['start'] },
    { id: 'approval', label: 'Approve', type: 'argus.approval', args: { message: 'Approve plan' }, depends_on: ['plan'] },
    { id: 'response', label: 'Result', type: 'logic.response', args: { value: '{{ steps.plan.result }}' }, depends_on: ['approval'] },
  ],
};

describe('Argus Workflow Spec v1', () => {
  it('exports portable roles, approval gates and stable Core identity', () => {
    const spec = buildVisualWorkflowSpec(source);
    expect(spec).toMatchObject({
      schemaVersion: 'argus.workflow/v1',
      id: 'visual-42-governed-delivery',
      graphId: 'visual_workflow_42',
      label: 'Governed Delivery',
      completion: { trueFields: ['visual_completed'], nonEmptyFields: ['delivery_summary'] },
    });
    expect(spec.nodes.find(node => node.id === 'plan')).toMatchObject({ agentRole: 'planner' });
    expect(spec.agentRequirements).toEqual([expect.objectContaining({ role: 'planner', stepIds: ['plan'] })]);
  });

  it('fails closed for unsupported or cyclic graphs', () => {
    expect(() => buildVisualWorkflowSpec({
      ...source,
      steps: [
        { id: 'one', label: 'Tool', type: 'argus.tool', tool: 'danger', args: {}, depends_on: ['two'] },
        { id: 'two', label: 'Response', type: 'logic.response', args: {}, depends_on: ['one'] },
      ],
    })).toThrow(VisualWorkflowSpecError);
  });

  it('normalizes and validates portable Router branches', () => {
    const spec = buildVisualWorkflowSpec({
      ...source,
      steps: [
        { id: 'start', label: 'Start', type: 'trigger.manual', args: {} },
        {
          id: 'route', label: 'Route request', type: 'logic.router', depends_on: ['start'],
          args: {
            route_on: '{{ input.task }}',
            routes: '{"implement":"implement","explain":"explain"}',
          },
        },
        { id: 'implement', label: 'Implement', type: 'argus.agent', agent_role: 'coder', args: { prompt: 'Implement' }, depends_on: ['route'] },
        { id: 'explain', label: 'Explain', type: 'argus.agent', agent_role: 'planner', args: { prompt: 'Explain' }, depends_on: ['route'] },
        { id: 'response', label: 'Result', type: 'logic.response', args: {}, depends_on: ['implement', 'explain'] },
      ],
    });

    expect(spec.nodes.find(node => node.id === 'route')?.args['routes']).toEqual({
      implement: 'implement',
      explain: 'explain',
    });
  });

  it('rejects Router targets that are not directly connected', () => {
    expect(() => buildVisualWorkflowSpec({
      ...source,
      steps: [
        { id: 'route', label: 'Route', type: 'logic.router', args: { route_on: '{{ input.task }}', routes: '{"a":"plan","b":"response"}' } },
        { id: 'plan', label: 'Plan', type: 'argus.agent', agent_role: 'planner', args: {}, depends_on: ['route'] },
        { id: 'response', label: 'Result', type: 'logic.response', args: {}, depends_on: ['plan'] },
      ],
    })).toThrow(/directly connected/);
  });
});
