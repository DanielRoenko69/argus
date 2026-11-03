import type { ServiceTemplate } from '../../serviceTemplates.js';

export const langgraphTemplate: ServiceTemplate = {
  id: 'langgraph',
  name: 'LangGraph',
  description: 'Inspect LangGraph workflows and runs through governed, read-only MCP capabilities. Workflow execution remains behind the Argus A2A control plane.',
  icon: 'workflow',
  category: 'devops',
  tags: ['langgraph', 'agents', 'workflows', 'a2a', 'self-hosted'],
  docsUrl: 'https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html',

  fields: [
    {
      name: 'base_url',
      label: 'LangGraph Base URL',
      type: 'string',
      required: true,
      placeholder: 'http://langgraph:2025',
    },
    {
      name: 'workspace_secret',
      label: 'Workspace Secret',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_workflows',
      description: 'List registered LangGraph assistants and workflow definitions',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /assistants/search\nContent-Type: application/json\n\n{"limit":20}',
      parameters: [],
      category: 'Agent Workflows',
      readOnly: true,
    },
    {
      nameSuffix: 'list_threads',
      description: 'List recent LangGraph workflow threads',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /threads/search\nContent-Type: application/json\n\n{"limit":{{limit}}}',
      parameters: [
        { name: 'limit', type: 'number', description: 'Maximum threads', required: false, default: '20' },
      ],
      category: 'Agent Workflows',
      readOnly: true,
    },
    {
      nameSuffix: 'get_thread',
      description: 'Get one LangGraph workflow thread and its current metadata',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /threads/{{thread_id}}',
      parameters: [
        { name: 'thread_id', type: 'string', description: 'LangGraph thread ID', required: true },
      ],
      category: 'Agent Workflows',
      readOnly: true,
    },
  ],

  buildBaseUrl: fields => fields.base_url.replace(/\/+$/, ''),
  buildAuthType: () => 'header',
  buildAuthValue: fields => `X-Workspace-Secret:${fields.workspace_secret}`,
  buildDefaultHeaders: () => ({ Accept: 'application/json' }),
  buildHealthPath: () => '/healthz',
  buildConfig: () => ({
    kind: 'langgraph',
    execution_transport: 'a2a',
    capability_scope: 'read-only-observability',
  }),
};
