import type { ServiceTemplate } from '../../serviceTemplates.js';

export const graphqlTemplate: ServiceTemplate = {
  id: 'graphql',
  name: 'GraphQL API',
  description: 'Beliebige GraphQL API als MCP-Tool anbinden.',
  icon: '\u25FC\uFE0F',
  category: 'api',
  tags: ['graphql', 'api', 'query'],

  fields: [
    {
      name: 'base_url',
      label: 'Base URL',
      type: 'string',
      required: true,
      placeholder: 'https://api.example.com',
    },
    {
      name: 'auth_type',
      label: 'Auth-Typ',
      type: 'select',
      required: true,
      default: 'none',
      options: ['none', 'bearer', 'basic', 'header'],
    },
    {
      name: 'auth_value',
      label: 'Auth-Wert',
      type: 'password',
      required: false,
      placeholder: 'Token, user:password oder Header-Wert',
    },
  ],

  tools: [
    {
      nameSuffix: 'execute_query',
      description: 'Eine GraphQL-Abfrage ausführen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /graphql\n\n{"query": "{{query}}", "variables": {{variables}}}',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'GraphQL-Abfrage (Query oder Mutation)',
          required: true,
        },
        {
          name: 'variables',
          type: 'string',
          description: 'Variablen als JSON-Objekt',
          required: false,
          default: '{}',
        },
      ],
      category: 'API',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: (fields) => fields.auth_type || 'none',

  buildAuthValue: (fields) => fields.auth_value || '',

  buildHealthPath: () => '/graphql',
};
