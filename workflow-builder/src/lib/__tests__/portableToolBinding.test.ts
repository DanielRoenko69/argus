import { describe, expect, it } from 'vitest';
import type { PaletteTool } from '@/api/palette';
import { portableToolNodeSeed, portableToolSelection } from '../portableToolBinding';

function tool(overrides: Partial<PaletteTool> = {}): PaletteTool {
  return {
    id: -7,
    name: 'github_primary_create_issue',
    description: 'Create an issue',
    backend: 'remote:github_primary',
    tool_type: 'remote',
    integration_id: 'github',
    integration_label: 'GitHub',
    integration_brand: 'github',
    action_label: 'Create Issue',
    is_write: true,
    risk_level: 'medium',
    parameters: [
      { name: 'owner', type: 'string', required: true },
      { name: 'repo', type: 'string', required: true },
      { name: 'title', type: 'string', required: true },
      { name: 'body', type: 'string', required: false },
    ],
    ...overrides,
  };
}

describe('portable MCP Fabric tool bindings', () => {
  it('captures provider, semantic action, access and required schema fields', () => {
    expect(portableToolSelection(tool())).toEqual({
      tool: 'github_primary_create_issue',
      integration_id: 'github',
      tool_binding: {
        integration_id: 'github',
        action_hints: ['create_issue'],
        access: 'write',
        required_parameters: ['owner', 'repo', 'title'],
      },
    });
  });

  it('derives a stable action from older palettes without action labels', () => {
    expect(portableToolSelection(tool({
      name: 'slack_ops_post_message', integration_id: 'slack', action_label: undefined,
    })).tool_binding).toMatchObject({ action_hints: ['post_message'], access: 'write' });
  });

  it('keeps an unclassified tool usable without inventing a provider contract', () => {
    expect(portableToolSelection(tool({ integration_id: undefined }))).toEqual({
      tool: 'github_primary_create_issue', integration_id: null, tool_binding: null,
    });
  });

  it('builds the complete seed used by click and drag creation', () => {
    expect(portableToolNodeSeed(tool())).toMatchObject({
      label: 'Create Issue',
      tool: 'github_primary_create_issue',
      integration_id: 'github',
      tool_binding: { action_hints: ['create_issue'] },
      args: {},
    });
  });
});
