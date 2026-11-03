import { describe, expect, it } from '@jest/globals';
import { validateWorkflowSteps } from '../builderRoutes.js';
import { executeWorkflow } from '../executor.js';
import { findInlineWorkflowCredentials } from '../inlineCredentialPolicy.js';

describe('visual workflow MCP Fabric credential policy', () => {
  it('allows Fabric references without persisting a provider secret', () => {
    const steps = [{
      id: 'github', label: 'Read issue', type: 'argus.tool' as const,
      tool: 'github_issue_read', args: { owner: 'argus', repo: 'core', issue_number: 42 },
      cred_ref: { bundle_id: 7 },
    }];

    expect(findInlineWorkflowCredentials(steps)).toEqual([]);
    expect(validateWorkflowSteps(steps)).toMatchObject({ valid: true, errors: [] });
  });

  it.each([
    [{ authorization: 'Bearer leaked' }, 'args.authorization'],
    [{ headers: { 'X-API-Key': 'leaked' } }, 'args.headers.X-API-Key'],
    [{ access_token: '{{ input.value }}' }, 'args.access_token'],
  ])('rejects an inline connection credential in tool args', (args, expectedPath) => {
    const steps = [{ id: 'http', label: 'Call API', type: 'argus.tool' as const, tool: 'http_request', args }];
    const issues = findInlineWorkflowCredentials(steps);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ stepId: 'http', path: expectedPath });
    expect(validateWorkflowSteps(steps).errors[0]?.issue).toContain('MCP Fabric');
  });

  it('rejects credential-shaped workflow inputs and indirect input references', () => {
    const steps = [{
      id: 'http', label: 'Call API', type: 'argus.tool' as const, tool: 'http_request',
      args: { headers: { custom: '{{ input.api_key }}' } },
    }];
    const issues = findInlineWorkflowCredentials(steps, [], [{ name: 'api_key', type: 'string', required: true }]);

    expect(issues.map(issue => issue.path)).toEqual(expect.arrayContaining([
      'args.headers.custom -> input.api_key',
      'input_params.api_key',
    ]));
  });

  it('rejects secrets retained only in visual block data', () => {
    const issues = findInlineWorkflowCredentials([], [{
      id: 'http-node', type: 'argus.tool', data: { args: { client_secret: 'leaked' } },
    }]);

    expect(issues[0]).toMatchObject({ stepId: 'http-node', path: 'canvas.data.args.client_secret' });
  });

  it('fails closed before a legacy workflow with inline credentials can execute', async () => {
    const toolRunner = jest.fn();
    await expect(executeWorkflow({
      workflow: {
        id: 91,
        name: 'legacy_inline_secret',
        description: '',
        steps: [{
          id: 'http', label: 'Call API', type: 'argus.tool' as const, tool: 'http_request',
          args: { headers: { Authorization: 'Bearer leaked' } },
        }],
        input_params: [],
        enabled: true,
        bundle_ids: [],
        created_by: null,
        created_at: '',
        updated_at: '',
      },
      inputs: {},
      toolRunner,
      executionId: 901,
      triggeredBy: 'test',
    })).rejects.toThrow('Workflow credential policy blocked execution');
    expect(toolRunner).not.toHaveBeenCalled();
  });
});
