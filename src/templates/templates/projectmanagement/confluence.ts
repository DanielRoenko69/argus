import type { ServiceTemplate } from '../../serviceTemplates.js';

export const confluenceTemplate: ServiceTemplate = {
  id: 'confluence',
  name: 'Confluence',
  description: 'Confluence-Seiten, Bereiche und Inhalte durchsuchen und abrufen.',
  icon: '📖',
  category: 'projectmanagement',
  tags: ['confluence', 'atlassian', 'wiki', 'documentation', 'knowledge'],
  docsUrl: 'https://developer.atlassian.com/cloud/confluence/rest/v2/',

  fields: [
    {
      name: 'base_url',
      label: 'Confluence URL',
      type: 'string',
      required: true,
      placeholder: 'https://your-domain.atlassian.net',
    },
    {
      name: 'email',
      label: 'E-Mail',
      type: 'string',
      required: true,
    },
    {
      name: 'api_token',
      label: 'API Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'search_content',
      description: 'Confluence-Inhalte per CQL durchsuchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /wiki/rest/api/content/search?cql={{cql}}&limit={{limit}}',
      parameters: [
        {
          name: 'cql',
          type: 'string',
          description: 'CQL-Abfrage (Confluence Query Language)',
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
      nameSuffix: 'get_page',
      description: 'Eine Confluence-Seite mit Inhalt abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /wiki/rest/api/content/{{page_id}}?expand=body.storage,version,space',
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
      nameSuffix: 'list_spaces',
      description: 'Alle Confluence-Bereiche auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /wiki/rest/api/space?limit={{limit}}&type={{type}}',
      parameters: [
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '25',
        },
        {
          name: 'type',
          type: 'string',
          description: 'Typ des Bereichs (global, personal)',
          required: false,
          default: 'global',
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'get_page_children',
      description: 'Unterseiten einer Confluence-Seite abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /wiki/rest/api/content/{{page_id}}/child/page?limit={{limit}}',
      parameters: [
        {
          name: 'page_id',
          type: 'string',
          description: 'Seiten-ID',
          required: true,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '25',
        },
      ],
      category: 'Projektmanagement',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'basic',

  buildAuthValue: (fields) => `${fields.email}:${fields.api_token}`,

  buildDefaultHeaders: () => ({
    'Accept': 'application/json',
  }),

  buildHealthPath: () => '/wiki/rest/api/space?limit=1',
};
