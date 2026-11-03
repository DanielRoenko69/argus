import type pg from 'pg';
import { getRemoteConnections } from '../backends/remoteMcpClients.js';

export interface WorkflowToolParameter {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  default?: string | number | boolean;
}

export interface WorkflowPaletteTool {
  id: number;
  name: string;
  description: string;
  backend: string;
  tool_type: string;
  parameters: WorkflowToolParameter[];
  schema: 'typed' | 'freeform';
  connection_id: number | null;
  connection_name: string | null;
  integration_id: string;
  integration_label: string;
  integration_brand: string | null;
  action_label: string;
  is_write: boolean;
  risk_level: 'low' | 'medium' | 'high';
}

export interface WorkflowPaletteIntegration {
  id: string;
  label: string;
  description: string;
  category: string;
  brand: string | null;
  fallback_icon: string;
  state: 'ready' | 'unconfigured' | 'unavailable';
  tool_count: number;
  connection_count: number;
  can_configure: boolean;
  configure_href: string;
}

interface IntegrationDefinition {
  id: string;
  label: string;
  description: string;
  category: string;
  brand: string | null;
  fallbackIcon: string;
  match: string[];
  toolHints?: string[];
  showWhenEmpty?: boolean;
  catalogId?: string;
  serviceTemplateId?: string;
}

const DEFINITIONS: IntegrationDefinition[] = [
  {
    id: 'github', label: 'GitHub', category: 'Development', brand: 'github', fallbackIcon: 'GitBranch',
    description: 'Repositories, issues, pull requests, Actions and code search.',
    match: ['github'],
    toolHints: ['search_repositories', 'get_file_contents', 'create_pull_request', 'merge_pull_request'],
    showWhenEmpty: true,
    catalogId: 'github',
  },
  {
    id: 'gitlab', label: 'GitLab', category: 'Development', brand: 'gitlab', fallbackIcon: 'GitBranch',
    description: 'Projects, merge requests, pipelines, issues and code search.',
    match: ['gitlab'],
    toolHints: ['create_merge_request', 'list_merge_requests', 'list_pipelines'],
    showWhenEmpty: true,
    catalogId: 'gitlab',
  },
  {
    id: 'jira', label: 'Jira', category: 'Planning', brand: 'atlassian', fallbackIcon: 'SquareKanban',
    description: 'Issues, projects, comments, transitions and work tracking.',
    match: ['jira'], toolHints: ['jira_get_issue', 'jira_search', 'jira_create_issue'], showWhenEmpty: true,
    catalogId: 'atlassian',
  },
  {
    id: 'bitbucket', label: 'Bitbucket', category: 'Development', brand: 'bitbucket', fallbackIcon: 'GitBranch',
    description: 'Repositories, pull requests and pipelines.',
    match: ['bitbucket'], showWhenEmpty: true, catalogId: 'bitbucket',
  },
  {
    id: 'jenkins', label: 'Jenkins', category: 'Development', brand: 'jenkins', fallbackIcon: 'Hammer',
    description: 'Build jobs, queues, logs, artifacts and delivery status.',
    match: ['jenkins'], toolHints: ['trigger_build', 'get_build_log', 'list_jobs'], showWhenEmpty: true,
    catalogId: 'jenkins',
  },
  {
    id: 'confluence', label: 'Confluence', category: 'Knowledge', brand: 'atlassian', fallbackIcon: 'BookText',
    description: 'Pages, spaces, comments and workspace search.',
    match: ['confluence'], toolHints: ['confluence_get_page', 'confluence_search'], showWhenEmpty: true,
    catalogId: 'atlassian',
  },
  {
    id: 'notion', label: 'Notion', category: 'Knowledge', brand: 'notion', fallbackIcon: 'NotebookTabs',
    description: 'Pages, databases, comments and workspace search.',
    match: ['notion'], toolHints: ['notion_get_page', 'notion_search', 'notion_create_page'], showWhenEmpty: true,
    catalogId: 'notion',
  },
  {
    id: 'google-drive', label: 'Google Drive', category: 'Knowledge', brand: 'ref-gdrive', fallbackIcon: 'HardDrive',
    description: 'Files, folders, document search and controlled content retrieval.',
    match: ['google-drive', 'google_drive', 'gdrive'], toolHints: ['gdrive_search', 'gdrive_read_file'], showWhenEmpty: true,
    catalogId: 'ref-gdrive',
  },
  {
    id: 'slack', label: 'Slack', category: 'Communication', brand: 'slack', fallbackIcon: 'MessageSquare',
    description: 'Channels, messages, users and governed notifications.',
    match: ['slack'], toolHints: ['slack_list_channels', 'slack_post_message', 'slack_search_messages'], showWhenEmpty: true,
    serviceTemplateId: 'slack',
  },
  {
    id: 'microsoft-teams', label: 'Microsoft Teams', category: 'Communication', brand: null, fallbackIcon: 'MessagesSquare',
    description: 'Chats, channel messages, teams and notifications.',
    match: ['microsoft-teams', 'teams-webhook', 'teams_webhook', 'teams'],
    toolHints: ['send_channel_message', 'send_chat_message'], showWhenEmpty: true, catalogId: 'microsoft-teams',
  },
  {
    id: 'email', label: 'Email', category: 'Communication', brand: null, fallbackIcon: 'Mail',
    description: 'Send, search, read and organize mail through a connected Gmail, Outlook or SMTP capability provider.',
    match: ['gmail', 'outlook', 'smtp', 'email'],
    toolHints: ['send_email', 'send_mail', 'search_emails', 'list_messages'], showWhenEmpty: true,
  },
  {
    id: 'grafana', label: 'Grafana', category: 'Operations', brand: 'grafana', fallbackIcon: 'LineChart',
    description: 'Dashboards, alerts, metrics and logs.',
    match: ['grafana'], toolHints: ['query_prometheus', 'query_loki_logs'], showWhenEmpty: true,
    catalogId: 'grafana',
  },
  {
    id: 'sentry', label: 'Sentry', category: 'Operations', brand: 'sentry', fallbackIcon: 'Bug',
    description: 'Errors, issues, releases, events and performance evidence.',
    match: ['sentry'], toolHints: ['list_issues', 'list_events', 'get_issue'], showWhenEmpty: true,
    catalogId: 'sentry',
  },
  {
    id: 'pagerduty', label: 'PagerDuty', category: 'Operations', brand: 'pagerduty', fallbackIcon: 'Siren',
    description: 'Incidents, services, on-call schedules and escalation workflows.',
    match: ['pagerduty', 'pager_duty'], toolHints: ['list_incidents', 'list_oncalls'], showWhenEmpty: true,
    catalogId: 'pagerduty',
  },
  {
    id: 'kubernetes', label: 'Kubernetes', category: 'Operations', brand: 'kubernetes', fallbackIcon: 'Boxes',
    description: 'Clusters, namespaces, workloads, events and logs.',
    match: ['kubernetes', 'k8s'], toolHints: ['get_pods', 'list_pods', 'get_deployments'], showWhenEmpty: true,
    catalogId: 'kubernetes',
  },
  {
    id: 'http', label: 'HTTP / Webhook', category: 'Automation', brand: null, fallbackIcon: 'Globe',
    description: 'Generic REST requests and webhook-driven automation.',
    match: ['builtin:http', 'custom:http', 'rest', 'webhook'], toolHints: ['http_request'], showWhenEmpty: true,
  },
  {
    id: 'snowflake', label: 'Snowflake', category: 'Data', brand: 'snowflake', fallbackIcon: 'Database',
    description: 'Governed SQL, Cortex Search, Cortex Analyst and Cortex Agents exposed through Snowflake MCP.',
    match: ['snowflake'],
    toolHints: ['run_sql_query', 'execute_sql', 'cortex_search', 'cortex_analyst', 'cortex_agent'],
    showWhenEmpty: true,
    catalogId: 'snowflake',
  },
  // Gitea remains supported for local/self-hosted environments, but is not
  // advertised in a clean public workspace until such a connection exists.
  {
    id: 'gitea', label: 'Gitea', category: 'Development', brand: null, fallbackIcon: 'GitBranch',
    description: 'Self-hosted repositories, issues, pull requests and Actions.',
    match: ['gitea'], showWhenEmpty: false,
  },
];

interface DynamicToolRow {
  id: number;
  name: string;
  description: string;
  backend: string;
  tool_type: string;
  parameters: WorkflowToolParameter[] | null;
  connection_id: number | null;
  connection_name: string | null;
  is_write: boolean | null;
  risk_level: string | null;
}

interface RemoteToolRow {
  id: number;
  backend_id: number;
  backend_name: string;
  prefixed_name: string;
  tool_name: string;
  description: string;
  input_schema: Record<string, unknown> | null;
}

function normalizeRisk(value: string | null | undefined): 'low' | 'medium' | 'high' {
  return value === 'high' || value === 'medium' ? value : 'low';
}

function schemaParameters(schema: Record<string, unknown> | null): WorkflowToolParameter[] {
  if (!schema || schema['type'] !== 'object') return [];
  const properties = schema['properties'];
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(schema['required']) ? schema['required'].map(String) : []);
  return Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const property = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const parameter: WorkflowToolParameter = {
      name,
      type: typeof property['type'] === 'string' ? property['type'] : 'string',
      required: required.has(name),
    };
    if (typeof property['description'] === 'string') parameter.description = property['description'];
    if (['string', 'number', 'boolean'].includes(typeof property['default'])) {
      parameter.default = property['default'] as string | number | boolean;
    }
    return parameter;
  });
}

function readLikeTool(name: string): boolean {
  return /(^|_)(get|list|search|query|describe|inspect|read|fetch|count|stats|info|status|show)(_|$)/i.test(name)
    && !/(^|_)(create|send|post|update|delete|merge|close|approve|write|push|run|trigger|deploy|restart|scale|patch|apply)(_|$)/i.test(name);
}

function definitionForTool(tool: Pick<WorkflowPaletteTool, 'name' | 'backend' | 'connection_name'>): IntegrationDefinition | null {
  const haystack = `${tool.backend} ${tool.connection_name ?? ''} ${tool.name}`.toLowerCase();
  const normalizedName = tool.name.toLowerCase();
  // A concrete provider identity wins. Generic action names such as get_issue
  // exist in GitHub, Jira and Sentry and must not reclassify a github-* backend.
  // Tool hints remain the fallback for shared/generic connections such as one
  // Atlassian MCP server exposing both Jira and Confluence actions.
  const provider = DEFINITIONS.find(definition => definition.match.some(term => haystack.includes(term)));
  if (provider) return provider;
  const hinted = DEFINITIONS.find(definition => definition.toolHints?.some(hint => normalizedName.includes(hint)));
  if (hinted) return hinted;
  return null;
}

function humanize(value: string): string {
  return value
    .replace(/[-.:/]+/g, '_')
    .split('_')
    .filter(Boolean)
    .map(word => word.length <= 3 && word.toUpperCase() === word ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
}

const ACTION_VERBS = new Set([
  'get', 'list', 'search', 'query', 'describe', 'inspect', 'read', 'fetch', 'count', 'show',
  'create', 'send', 'post', 'update', 'delete', 'merge', 'close', 'approve', 'write', 'push',
  'run', 'trigger', 'deploy', 'restart', 'scale', 'patch', 'apply', 'download', 'upload', 'reply',
]);

function actionLabel(toolName: string): string {
  const segments = toolName.toLowerCase().split('_').filter(Boolean);
  const verbIndex = segments.findIndex(segment => ACTION_VERBS.has(segment));
  return humanize((verbIndex >= 0 ? segments.slice(verbIndex) : segments).join('_')) || toolName;
}

function customDefinition(tool: Pick<WorkflowPaletteTool, 'backend' | 'connection_name'>): IntegrationDefinition {
  const rawName = tool.connection_name
    ?? tool.backend.replace(/^(?:custom|remote):/, '')
    ?? 'custom';
  const id = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom';
  return {
    id: `custom-${id}`,
    label: humanize(rawName),
    description: 'Connected capability provider discovered through the Argus MCP Fabric.',
    category: 'Connected',
    brand: null,
    fallbackIcon: 'Plug',
    match: [],
    showWhenEmpty: false,
  };
}

export function classifyWorkflowIntegration(
  tool: Pick<WorkflowPaletteTool, 'name' | 'backend' | 'connection_name'>,
): Pick<WorkflowPaletteTool, 'integration_id' | 'integration_label' | 'integration_brand'> {
  const definition = definitionForTool(tool) ?? customDefinition(tool);
  return {
    integration_id: definition.id,
    integration_label: definition.label,
    integration_brand: definition.brand,
  };
}

function enrichTool(tool: Omit<WorkflowPaletteTool, 'integration_id' | 'integration_label' | 'integration_brand' | 'action_label'>): WorkflowPaletteTool {
  return {
    ...tool,
    ...classifyWorkflowIntegration(tool),
    action_label: actionLabel(tool.name),
  };
}

export async function loadAccessibleWorkflowTools(
  pool: pg.Pool,
  allowedBundles: number[] | null,
): Promise<WorkflowPaletteTool[]> {
  const admin = allowedBundles === null;
  const dynamicSql = `SELECT t.id, t.name, t.description, t.backend, t.tool_type, t.parameters,
                              backend.id AS connection_id, backend.name AS connection_name,
                              t.is_write, t.risk_level
                       FROM mcp_tools t
                       LEFT JOIN mcp_backends backend ON t.backend = ('custom:' || backend.name)
                       WHERE t.enabled = true
                         AND (t.backend NOT LIKE 'custom:%' OR backend.enabled = true)
                         ${admin ? '' : `AND (
                           NOT EXISTS (SELECT 1 FROM mcp_tool_bundles tb WHERE tb.tool_id = t.id)
                           OR EXISTS (SELECT 1 FROM mcp_tool_bundles tb WHERE tb.tool_id = t.id AND tb.bundle_id = ANY($1::int[]))
                         )`}
                       ORDER BY t.name`;
  const remoteSql = `SELECT remote.id, remote.backend_id, backend.name AS backend_name,
                             remote.prefixed_name, remote.tool_name, remote.description, remote.input_schema
                      FROM mcp_remote_tools remote
                      JOIN mcp_backends backend ON backend.id = remote.backend_id
                      WHERE backend.enabled = true
                        ${admin ? '' : `AND (
                          NOT EXISTS (SELECT 1 FROM mcp_backend_bundles bb WHERE bb.backend_id = backend.id)
                          OR EXISTS (SELECT 1 FROM mcp_backend_bundles bb WHERE bb.backend_id = backend.id AND bb.bundle_id = ANY($1::int[]))
                        )`}
                      ORDER BY remote.prefixed_name`;
  const params = admin ? [] : [allowedBundles ?? []];
  const [dynamic, remote] = await Promise.all([
    pool.query<DynamicToolRow>(dynamicSql, params).catch(() => ({ rows: [] as DynamicToolRow[] })),
    pool.query<RemoteToolRow>(remoteSql, params).catch(() => ({ rows: [] as RemoteToolRow[] })),
  ]);
  const tools: WorkflowPaletteTool[] = dynamic.rows.map(row => {
    const parameters = Array.isArray(row.parameters) ? row.parameters : [];
    return enrichTool({
      id: row.id,
      name: row.name,
      description: row.description,
      backend: row.backend,
      tool_type: row.tool_type,
      parameters,
      schema: parameters.length > 0 ? 'typed' : 'freeform',
      connection_id: row.connection_id,
      connection_name: row.connection_name,
      is_write: Boolean(row.is_write),
      risk_level: normalizeRisk(row.risk_level),
    });
  });

  const connections = getRemoteConnections();
  for (const row of remote.rows) {
    const connection = connections.get(row.backend_id);
    if (!connection?.connected || connection.trustStatus === 'changed' || connection.trustStatus === 'quarantined') continue;
    const parameters = schemaParameters(row.input_schema);
    const isWrite = !readLikeTool(row.tool_name);
    tools.push(enrichTool({
      id: -row.id,
      name: row.prefixed_name,
      description: row.description ?? '',
      backend: `remote:${row.backend_name}`,
      tool_type: 'remote',
      parameters,
      schema: parameters.length > 0 ? 'typed' : 'freeform',
      connection_id: row.backend_id,
      connection_name: row.backend_name,
      is_write: isWrite,
      risk_level: isWrite ? 'medium' : 'low',
    }));
  }

  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

export function buildWorkflowIntegrations(
  tools: WorkflowPaletteTool[],
  canConfigure: boolean,
): WorkflowPaletteIntegration[] {
  const groups = new Map<string, { definition: IntegrationDefinition; tools: WorkflowPaletteTool[] }>();
  for (const definition of DEFINITIONS) {
    if (definition.showWhenEmpty) groups.set(definition.id, { definition, tools: [] });
  }
  for (const tool of tools) {
    const definition = DEFINITIONS.find(candidate => candidate.id === tool.integration_id) ?? customDefinition(tool);
    const group = groups.get(definition.id) ?? { definition, tools: [] };
    group.tools.push(tool);
    groups.set(definition.id, group);
  }
  return [...groups.values()]
    .map(({ definition, tools: groupedTools }) => {
      const ready = groupedTools.length > 0;
      return {
        id: definition.id,
        label: definition.label,
        description: definition.description,
        category: definition.category,
        brand: definition.brand,
        fallback_icon: definition.fallbackIcon,
        state: ready ? 'ready' as const : canConfigure ? 'unconfigured' as const : 'unavailable' as const,
        tool_count: groupedTools.length,
        connection_count: new Set(groupedTools.map(tool => tool.connection_id).filter(id => id != null)).size,
        can_configure: !ready && canConfigure,
        configure_href: definition.serviceTemplateId
          ? `/mcp-fabric?serviceTemplate=${encodeURIComponent(definition.serviceTemplateId)}`
          : definition.catalogId
            ? `/mcp-fabric?catalog=${encodeURIComponent(definition.catalogId)}`
            : '/mcp-fabric?new=mcp',
      };
    })
    .sort((left, right) => {
      if (left.state === 'ready' && right.state !== 'ready') return -1;
      if (right.state === 'ready' && left.state !== 'ready') return 1;
      return left.label.localeCompare(right.label);
    });
}
