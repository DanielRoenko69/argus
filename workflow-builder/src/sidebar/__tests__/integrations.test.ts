import { describe, it, expect } from 'vitest';
import { groupIntegrations, resolveIntegrations, toolsForIntegration } from '../integrations';
import type { Palette, PaletteTool } from '@/api/palette';

const tools: PaletteTool[] = [
  { id: 1, name: 'jira_create_issue', description: '', backend: 'jira-cloud', tool_type: 'builtin' },
  { id: 2, name: 'grafana_query',     description: '', backend: 'grafana',     tool_type: 'builtin' },
  { id: 3, name: 'http_request',      description: '', backend: 'http',        tool_type: 'builtin' },
  { id: 4, name: 'k8s_get_pods',      description: '', backend: 'kubernetes',  tool_type: 'builtin' },
];

describe('toolsForIntegration', () => {
  it('scopes tools to the matching backend', () => {
    const jira = resolveIntegrations({ tools } as Palette).find((i) => i.id === 'jira')!;
    expect(toolsForIntegration(jira, tools).map((t) => t.name)).toEqual(['jira_create_issue']);
  });
  it('matches HTTP across http/rest/webhook backends', () => {
    const http = resolveIntegrations({ tools } as Palette).find((i) => i.id === 'http')!;
    expect(toolsForIntegration(http, tools).map((t) => t.name)).toEqual(['http_request']);
  });
  it('returns empty when no backend matches', () => {
    const conf = resolveIntegrations({ tools } as Palette).find((i) => i.id === 'confluence')!;
    expect(toolsForIntegration(conf, tools)).toEqual([]);
  });

  it('prefers server-provided integration metadata for connected custom providers', () => {
    const githubTool: PaletteTool = {
      id: -8, name: 'github_argus_search_repositories', description: '', backend: 'remote:github_argus',
      tool_type: 'remote', integration_id: 'github', integration_label: 'GitHub', action_label: 'Search Repositories',
    };
    const integrations = resolveIntegrations({
      skills: [], agents: [], tools: [githubTool],
      integrations: [{
        id: 'github', label: 'GitHub', description: 'Repositories', category: 'Development', brand: 'github',
        fallback_icon: 'GitBranch', state: 'ready', tool_count: 1, connection_count: 1,
        can_configure: false, configure_href: '/mcp-fabric',
      }],
    });
    expect(integrations).toHaveLength(1);
    expect(toolsForIntegration(integrations[0], [githubTool])).toEqual([githubTool]);
  });

  it('groups the catalog for a scannable sidebar and keeps connected providers first', () => {
    const groups = groupIntegrations([
      {
        id: 'jira', label: 'Jira', description: '', category: 'Planning', brand: 'atlassian',
        fallback_icon: 'SquareKanban', state: 'unconfigured', tool_count: 0, connection_count: 0,
        can_configure: true, configure_href: '/mcp-fabric?catalog=atlassian',
      },
      {
        id: 'github', label: 'GitHub', description: '', category: 'Development', brand: 'github',
        fallback_icon: 'GitBranch', state: 'ready', tool_count: 4, connection_count: 1,
        can_configure: false, configure_href: '/mcp-fabric?catalog=github',
      },
      {
        id: 'gitlab', label: 'GitLab', description: '', category: 'Development', brand: 'gitlab',
        fallback_icon: 'GitBranch', state: 'unconfigured', tool_count: 0, connection_count: 0,
        can_configure: true, configure_href: '/mcp-fabric?catalog=gitlab',
      },
    ]);

    expect(groups.map(group => group.category)).toEqual(['Development', 'Planning']);
    expect(groups[0].integrations.map(integration => integration.id)).toEqual(['github', 'gitlab']);
  });
});
