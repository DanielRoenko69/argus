import type { ServiceTemplate } from '../../serviceTemplates.js';

export const notionTemplate: ServiceTemplate = {
  id: 'notion',
  name: 'Notion',
  description: 'Notion-Seiten und Datenbanken durchsuchen und abrufen.',
  icon: '📓',
  category: 'projectmanagement',
  tags: ['notion', 'wiki', 'documentation', 'knowledge', 'database'],
  docsUrl: 'https://developers.notion.com/reference',

  fields: [
    {
      name: 'integration_token',
      label: 'Integration Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'search',
      description: 'Notion-Inhalte durchsuchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /v1/search\n\n{"query": "{{query}}", "page_size": {{page_size}}}',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'Suchbegriff',
          required: true,
        },
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '10',
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'get_page',
      description: 'Eine Notion-Seite abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v1/pages/{{page_id}}',
      parameters: [
        {
          name: 'page_id',
          type: 'string',
          description: 'Seiten-ID',
          required: true,
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'list_databases',
      description: 'Alle Notion-Datenbanken auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /v1/search\n\n{"filter": {"property": "object", "value": "database"}, "page_size": {{page_size}}}',
      parameters: [
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
      ],
      category: 'Projektmanagement',
    },
  ],

  buildBaseUrl: () => 'https://api.notion.com',

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.integration_token,

  buildDefaultHeaders: () => ({
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  }),

  buildHealthPath: () => '/v1/users/me',
};
