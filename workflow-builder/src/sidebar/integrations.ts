import type { Palette, PaletteIntegration, PaletteTool } from '@/api/palette';

export type Integration = PaletteIntegration;

// Compatibility for a Builder served by an older Core. New Core versions
// provide this list dynamically and include connected custom MCP providers.
const FALLBACK_INTEGRATIONS: Integration[] = [
  fallback('github', 'GitHub', 'Development', 'github', 'GitBranch'),
  fallback('gitlab', 'GitLab', 'Development', 'gitlab', 'GitBranch'),
  fallback('jira', 'Jira', 'Planning', 'atlassian', 'SquareKanban'),
  fallback('bitbucket', 'Bitbucket', 'Development', 'bitbucket', 'GitBranch'),
  fallback('jenkins', 'Jenkins', 'Development', 'jenkins', 'Hammer'),
  fallback('confluence', 'Confluence', 'Knowledge', 'atlassian', 'BookText'),
  fallback('notion', 'Notion', 'Knowledge', 'notion', 'NotebookTabs'),
  fallback('google-drive', 'Google Drive', 'Knowledge', 'ref-gdrive', 'HardDrive'),
  fallback('slack', 'Slack', 'Communication', 'slack', 'MessageSquare'),
  fallback('microsoft-teams', 'Microsoft Teams', 'Communication', null, 'MessagesSquare'),
  fallback('email', 'Email', 'Communication', null, 'Mail'),
  fallback('grafana', 'Grafana', 'Operations', 'grafana', 'LineChart'),
  fallback('sentry', 'Sentry', 'Operations', 'sentry', 'Bug'),
  fallback('pagerduty', 'PagerDuty', 'Operations', 'pagerduty', 'Siren'),
  fallback('kubernetes', 'Kubernetes', 'Operations', 'kubernetes', 'Boxes'),
  fallback('http', 'HTTP / Webhook', 'Automation', null, 'Globe'),
];

function fallback(id: string, label: string, category: string, brand: string | null, icon: string): Integration {
  return {
    id, label, category, brand, fallback_icon: icon,
    description: `${label} workflow integration`,
    state: 'unavailable', tool_count: 0, connection_count: 0,
    can_configure: false, configure_href: '/mcp-fabric',
  };
}

export function resolveIntegrations(palette: Palette | undefined): Integration[] {
  if (palette?.integrations?.length) return palette.integrations;
  return FALLBACK_INTEGRATIONS.map((integration) => {
    const matching = toolsForIntegration(integration, palette?.tools ?? []);
    return matching.length > 0
      ? { ...integration, state: 'ready', tool_count: matching.length }
      : integration;
  });
}

export function toolsForIntegration(integration: Integration, tools: PaletteTool[]): PaletteTool[] {
  return tools.filter((tool) => {
    if (tool.integration_id) return tool.integration_id === integration.id;
    const haystack = `${tool.backend ?? ''} ${tool.name}`.toLowerCase();
    if (integration.id === 'http') return /http|rest|webhook/.test(haystack);
    if (integration.id === 'microsoft-teams') return /microsoft.?teams|teams.?webhook/.test(haystack);
    return haystack.includes(integration.id);
  });
}

const CATEGORY_ORDER = ['Development', 'Planning', 'Communication', 'Knowledge', 'Operations', 'Automation', 'Connected'];

export interface IntegrationGroup {
  category: string;
  integrations: Integration[];
}

export function groupIntegrations(integrations: Integration[]): IntegrationGroup[] {
  const grouped = new Map<string, Integration[]>();
  for (const integration of integrations) {
    const entries = grouped.get(integration.category) ?? [];
    entries.push(integration);
    grouped.set(integration.category, entries);
  }
  return [...grouped.entries()]
    .map(([category, entries]) => ({
      category,
      integrations: entries.sort((left, right) => {
        if (left.state === 'ready' && right.state !== 'ready') return -1;
        if (right.state === 'ready' && left.state !== 'ready') return 1;
        return left.label.localeCompare(right.label);
      }),
    }))
    .sort((left, right) => {
      const leftIndex = CATEGORY_ORDER.indexOf(left.category);
      const rightIndex = CATEGORY_ORDER.indexOf(right.category);
      if (leftIndex === -1 && rightIndex === -1) return left.category.localeCompare(right.category);
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
}
