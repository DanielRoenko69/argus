import { describe, expect, it } from '@jest/globals';
import {
  buildWorkflowIntegrations,
  classifyWorkflowIntegration,
  type WorkflowPaletteTool,
} from '../integrationCatalog.js';

function tool(overrides: Partial<WorkflowPaletteTool> = {}): WorkflowPaletteTool {
  return {
    id: -1,
    name: 'github_argus_core_search_repositories',
    description: 'Search repositories',
    backend: 'remote:github_argus_core',
    tool_type: 'remote',
    parameters: [],
    schema: 'freeform',
    connection_id: 12,
    connection_name: 'github_argus_core',
    integration_id: 'github',
    integration_label: 'GitHub',
    integration_brand: 'github',
    action_label: 'Search Repositories',
    is_write: false,
    risk_level: 'low',
    ...overrides,
  };
}

describe('workflow integration catalog', () => {
  it('turns a connected GitHub MCP tool into a ready branded provider', () => {
    const integrations = buildWorkflowIntegrations([tool()], true);
    expect(integrations.find(entry => entry.id === 'github')).toMatchObject({
      label: 'GitHub', brand: 'github', state: 'ready', tool_count: 1, connection_count: 1,
    });
  });

  it('offers unconfigured providers only to users allowed to configure them', () => {
    expect(buildWorkflowIntegrations([], true).find(entry => entry.id === 'github')).toMatchObject({
      state: 'unconfigured', can_configure: true, configure_href: '/mcp-fabric?catalog=github',
    });
    expect(buildWorkflowIntegrations([], false).find(entry => entry.id === 'github')).toMatchObject({
      state: 'unavailable', can_configure: false,
    });
  });

  it('includes everyday workflow providers without advertising local Gitea', () => {
    const integrations = buildWorkflowIntegrations([], true);
    expect(integrations.map(entry => entry.id)).toEqual(expect.arrayContaining([
      'github', 'gitlab', 'jenkins', 'notion', 'google-drive', 'email', 'sentry', 'pagerduty', 'snowflake',
    ]));
    expect(integrations.find(entry => entry.id === 'email')).toMatchObject({
      state: 'unconfigured', configure_href: '/mcp-fabric?new=mcp',
    });
    expect(integrations.find(entry => entry.id === 'slack')).toMatchObject({
      brand: 'slack', state: 'unconfigured', configure_href: '/mcp-fabric?serviceTemplate=slack',
    });
  });

  it('exposes Snowflake-managed MCP as a Fabric-first data integration', () => {
    expect(buildWorkflowIntegrations([], true).find(entry => entry.id === 'snowflake')).toMatchObject({
      label: 'Snowflake', brand: 'snowflake', state: 'unconfigured',
      configure_href: '/mcp-fabric?catalog=snowflake',
    });
    expect(classifyWorkflowIntegration({
      name: 'business_data_agent', backend: 'remote:snowflake-finance', connection_name: 'snowflake-finance',
    })).toMatchObject({ integration_id: 'snowflake', integration_label: 'Snowflake' });
  });

  it('uses action hints to split Jira and Confluence tools on a shared Atlassian connection', () => {
    expect(classifyWorkflowIntegration({
      name: 'atlassian_confluence_search', backend: 'remote:atlassian', connection_name: 'atlassian',
    })).toMatchObject({ integration_id: 'confluence', integration_label: 'Confluence' });
    expect(classifyWorkflowIntegration({
      name: 'atlassian_jira_search', backend: 'remote:atlassian', connection_name: 'atlassian',
    })).toMatchObject({ integration_id: 'jira', integration_label: 'Jira' });
  });

  it('does not advertise local Gitea unless it is actually connected', () => {
    expect(buildWorkflowIntegrations([], true).some(entry => entry.id === 'gitea')).toBe(false);
    expect(buildWorkflowIntegrations([tool({
      name: 'gitea_list_repositories', backend: 'custom:gitea', connection_name: 'gitea',
      integration_id: 'gitea', integration_label: 'Gitea', integration_brand: null,
    })], true).find(entry => entry.id === 'gitea')).toMatchObject({ state: 'ready', tool_count: 1 });
  });
});
