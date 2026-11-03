import type { ServiceTemplate } from '../../serviceTemplates.js';

export const linearTemplate: ServiceTemplate = {
  id: 'linear',
  name: 'Linear',
  description: 'Linear-Issues und Projekte über die GraphQL-API abfragen.',
  icon: '📐',
  category: 'projectmanagement',
  tags: ['linear', 'issues', 'agile', 'project-management'],
  docsUrl: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',

  fields: [
    {
      name: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'search_issues',
      description: 'Linear-Issues durchsuchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /graphql\n\n{"query": "{ issues(filter: { search: { contains: \\"{{query}}\\" } }, first: {{limit}}) { nodes { id identifier title state { name } assignee { name } priority createdAt } } }"}',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'Suchbegriff',
          required: true,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '20',
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'get_issue',
      description: 'Details eines Linear-Issues abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /graphql\n\n{"query": "{ issue(id: \\"{{issue_id}}\\") { id identifier title description state { name } assignee { name } priority labels { nodes { name } } createdAt updatedAt } }"}',
      parameters: [
        {
          name: 'issue_id',
          type: 'string',
          description: 'Issue-ID',
          required: true,
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'list_projects',
      description: 'Alle Linear-Projekte auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /graphql\n\n{"query": "{ projects(first: {{limit}}) { nodes { id name state { type } lead { name } startDate targetDate } } }"}',
      parameters: [
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '20',
        },
      ],
      category: 'Projektmanagement',
    },
  ],

  buildBaseUrl: () => 'https://api.linear.app',

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.api_key,

  buildDefaultHeaders: () => ({
    'Content-Type': 'application/json',
  }),

  buildHealthPath: () => '/graphql',
};
