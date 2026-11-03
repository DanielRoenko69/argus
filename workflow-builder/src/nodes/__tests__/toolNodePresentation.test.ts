import { describe, expect, it } from 'vitest';
import type { Palette } from '@/api/palette';
import { describeToolNode } from '../toolNodePresentation';

const palette: Palette = {
  agents: [],
  skills: [],
  rag_indexes: [],
  integrations: [{
    id: 'github', label: 'GitHub', description: 'Source control', category: 'Development',
    brand: 'github', fallback_icon: 'GitBranch', state: 'ready', tool_count: 1,
    connection_count: 1, can_configure: false, configure_href: '/mcp-fabric',
  }, {
    id: 'slack', label: 'Slack', description: 'Messaging', category: 'Communication',
    brand: 'slack', fallback_icon: 'MessageSquare', state: 'unconfigured', tool_count: 0,
    connection_count: 0, can_configure: true, configure_href: '/mcp-fabric?catalog=slack',
  }],
  tools: [{
    id: 9, name: 'github_create_issue', description: 'Create an issue', backend: 'github_primary',
    tool_type: 'remote', connection_id: 4, connection_name: 'Production GitHub', integration_id: 'github',
    integration_label: 'GitHub', integration_brand: 'github', action_label: 'Create issue',
    is_write: true, risk_level: 'high',
  }],
};

describe('describeToolNode', () => {
  it('shows the concrete Fabric connection and write risk for an accessible tool', () => {
    expect(describeToolNode({ tool: 'github_create_issue', integration_id: 'github' }, palette)).toMatchObject({
      state: 'ready', actionLabel: 'Create issue', providerLabel: 'GitHub',
      connectionLabel: 'Production GitHub', brand: 'github', isWrite: true, riskLevel: 'high',
    });
  });

  it('preserves provider identity and explains an unconfigured Fabric connection', () => {
    expect(describeToolNode({ tool: 'slack_post_message', integration_id: 'slack' }, palette)).toMatchObject({
      state: 'missing', providerLabel: 'Slack', brand: 'slack',
      detail: 'Slack muss im MCP Fabric verbunden werden.',
    });
  });

  it('distinguishes an empty node from a catalog lookup in progress', () => {
    expect(describeToolNode({}, undefined, { loading: true })).toMatchObject({
      state: 'unconfigured', actionLabel: 'Tool auswählen',
    });
    expect(describeToolNode({ tool: 'github_search' }, undefined, { loading: true })).toMatchObject({
      state: 'checking', actionLabel: 'github_search',
    });
  });

  it('fails visibly when the Fabric catalog itself cannot be loaded', () => {
    expect(describeToolNode({ tool: 'github_search' }, undefined, { error: true })).toMatchObject({
      state: 'error', detail: 'Der MCP-Fabric-Katalog ist nicht erreichbar.',
    });
  });
});
