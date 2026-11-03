/**
 * Unit tests for normalizeNodeArgs — server-side normalization of copilot-generated
 * tool node data. Flat arg keys that the LLM places directly in `data` (e.g.
 * `issueKey`, `comment`) must be moved into `data.args` so the canvas and the
 * workflow serializer see consistent structure.
 *
 * Tests run against the exported pure helper; no mocks needed.
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeNodeArgs } from '../copilotNormalize.js';

describe('normalizeNodeArgs', () => {
  it('moves flat arg key (issueKey) into data.args for argus.tool node', () => {
    const block = {
      id: 'step.1',
      type: 'argus.tool',
      position: { x: 50, y: 150 },
      data: {
        label: 'Jira-Issue laden',
        tool: 'atlassian_jira_get_issue',
        issueKey: '{{ input.ticket }}',
      },
    };

    const result = normalizeNodeArgs(block);

    expect(result.data['label']).toBe('Jira-Issue laden');
    expect(result.data['tool']).toBe('atlassian_jira_get_issue');
    expect(result.data['issueKey']).toBeUndefined();
    expect(result.data['args']).toEqual({ issueKey: '{{ input.ticket }}' });
  });

  it('merges flat keys into existing data.args without overwriting existing args keys', () => {
    const block = {
      type: 'argus.tool',
      data: {
        label: 'Comment',
        tool: 'atlassian_jira_add_comment',
        args: { issueKey: 'EXISTING-123' },
        comment: 'New comment text',
        // issueKey also at flat level — existing data.args wins
        issueKey: 'FLAT-999',
      },
    };

    const result = normalizeNodeArgs(block);

    // existing args key wins
    expect((result.data['args'] as Record<string, unknown>)['issueKey']).toBe('EXISTING-123');
    // flat non-conflicting key is merged in
    expect((result.data['args'] as Record<string, unknown>)['comment']).toBe('New comment text');
    // flat key that conflicts is consumed but existing wins
    expect(result.data['issueKey']).toBeUndefined();
    expect(result.data['comment']).toBeUndefined();
  });

  it('keeps all reserved keys at data level and does not move them into args', () => {
    const block = {
      type: 'argus.memory',
      data: {
        label: 'Store memory',
        agent_id: 7,
        agent_role: 'planner',
        skill_id: 11,
        condition: 'input.ok === true',
        on_error: 'continue',
        operation: 'store',
        cron_expr: '0 9 * * *',
        webhook_path: '/hook',
        webhook_secret_env: 'ARGUS_HOOK_SECRET',
        index_name: 'my-index',
        function_code: 'return x;',
        cred_ref: 'my-cred',
        args: { existingArg: 'val' },
        // a non-reserved key that should move
        query: 'find stuff',
      },
    };

    const result = normalizeNodeArgs(block);

    // reserved keys stay at data level
    expect(result.data['label']).toBe('Store memory');
    expect(result.data['agent_id']).toBe(7);
    expect(result.data['agent_role']).toBe('planner');
    expect(result.data['skill_id']).toBe(11);
    expect(result.data['condition']).toBe('input.ok === true');
    expect(result.data['on_error']).toBe('continue');
    expect(result.data['operation']).toBe('store');
    expect(result.data['cron_expr']).toBe('0 9 * * *');
    expect(result.data['webhook_path']).toBe('/hook');
    expect(result.data['webhook_secret_env']).toBe('ARGUS_HOOK_SECRET');
    expect(result.data['index_name']).toBe('my-index');
    expect(result.data['function_code']).toBe('return x;');
    expect(result.data['cred_ref']).toBe('my-cred');
    // args itself stays at data level
    expect(result.data['args']).toEqual({ existingArg: 'val', query: 'find stuff' });
    // non-reserved key moved
    expect(result.data['query']).toBeUndefined();
  });

  it('block without data property is returned unchanged', () => {
    const block = { id: 'node.1', type: 'trigger.manual' } as Record<string, unknown>;

    // normalizeNodeArgs accepts anything; cast as needed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = normalizeNodeArgs(block as any);

    expect(result).toEqual({ id: 'node.1', type: 'trigger.manual' });
    expect(result.data).toBeUndefined();
  });

  it('data.args that is not an object is treated as {} (non-object overwritten with merged args)', () => {
    const block = {
      type: 'argus.tool',
      data: {
        label: 'Run',
        tool: 'k8s_get_pods',
        args: 'not-an-object',
        namespace: 'default',
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = normalizeNodeArgs(block as any);

    expect(result.data['args']).toEqual({ namespace: 'default' });
  });

  it('node with no flat non-reserved keys leaves data.args unchanged (or creates empty {})', () => {
    const block = {
      id: 'step.t',
      type: 'trigger.schedule',
      position: { x: 0, y: 0 },
      data: {
        label: 'Every morning',
        cron_expr: '0 9 * * *',
      },
    };

    const result = normalizeNodeArgs(block);

    // No non-reserved flat keys → args stays absent or empty {}
    // We allow either absent or {} as long as reserved keys are intact
    expect(result.data['label']).toBe('Every morning');
    expect(result.data['cron_expr']).toBe('0 9 * * *');
    // args is either absent or an empty object — both valid
    const args = result.data['args'];
    expect(args === undefined || (typeof args === 'object' && Object.keys(args as object).length === 0)).toBe(true);
  });

  it('preserves id, type, and position; does not touch them', () => {
    const block = {
      id: 'step.abc',
      type: 'argus.tool',
      position: { x: 300, y: 200 },
      data: { label: 'Do thing', tool: 'some_tool', repo: 'my-repo' },
    };

    const result = normalizeNodeArgs(block);

    expect(result.id).toBe('step.abc');
    expect(result.type).toBe('argus.tool');
    expect(result.position).toEqual({ x: 300, y: 200 });
    expect((result.data['args'] as Record<string, unknown>)['repo']).toBe('my-repo');
    expect(result.data['repo']).toBeUndefined();
  });

  it('repairs an Agent binding that was mistakenly nested below data.args', () => {
    const result = normalizeNodeArgs({
      id: 'step.plan',
      type: 'argus.agent',
      data: {
        label: 'Plan',
        args: { agent_role: ' Planner ', prompt: 'Plan {{ input.task }}' },
      },
    });

    expect(result.data['agent_role']).toBe('planner');
    expect(result.data['args']).toEqual({ prompt: 'Plan {{ input.task }}' });
  });

  it('keeps portable MCP Fabric metadata outside tool args', () => {
    const toolBinding = {
      integration_id: 'github',
      action_hints: ['create_issue'],
      access: 'write',
      required_parameters: ['owner', 'repo', 'title'],
    };
    const result = normalizeNodeArgs({
      id: 'step.github',
      type: 'argus.tool',
      data: {
        label: 'Create issue',
        tool: 'github_create_issue',
        integration_id: 'github',
        tool_binding: toolBinding,
        owner: 'argus',
      },
    });

    expect(result.data['integration_id']).toBe('github');
    expect(result.data['tool_binding']).toEqual(toolBinding);
    expect(result.data['args']).toEqual({ owner: 'argus' });
  });
});
