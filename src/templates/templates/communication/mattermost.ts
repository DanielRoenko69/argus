import type { ServiceTemplate } from '../../serviceTemplates.js';

export const mattermostTemplate: ServiceTemplate = {
  id: 'mattermost',
  name: 'Mattermost',
  description: 'Mattermost-Kanaele und Beitraege abfragen sowie Nachrichten durchsuchen.',
  icon: '💭',
  category: 'communication',
  tags: ['mattermost', 'chat', 'messaging', 'open-source'],
  docsUrl: 'https://api.mattermost.com/',

  fields: [
    {
      name: 'base_url',
      label: 'Mattermost URL',
      type: 'string',
      required: true,
      placeholder: 'http://mattermost:8065',
    },
    {
      name: 'token',
      label: 'Personal Access Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_channels',
      description: 'Kanaele eines Teams auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v4/teams/{{team_id}}/channels?per_page={{per_page}}',
      parameters: [
        {
          name: 'team_id',
          type: 'string',
          description: 'ID des Teams',
          required: true,
        },
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '50',
        },
      ],
      category: 'Communication',
    },
    {
      nameSuffix: 'get_posts',
      description: 'Beitraege eines Kanals abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v4/channels/{{channel_id}}/posts?per_page={{per_page}}',
      parameters: [
        {
          name: 'channel_id',
          type: 'string',
          description: 'ID des Kanals',
          required: true,
        },
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
      ],
      category: 'Communication',
    },
    {
      nameSuffix: 'search',
      description: 'Beitraege in einem Team durchsuchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /api/v4/teams/{{team_id}}/posts/search\n\n{"terms": "{{terms}}", "is_or_search": false}',
      parameters: [
        {
          name: 'team_id',
          type: 'string',
          description: 'ID des Teams',
          required: true,
        },
        {
          name: 'terms',
          type: 'string',
          description: 'Suchbegriffe',
          required: true,
        },
      ],
      category: 'Communication',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildHealthPath: () => '/api/v4/system/ping',
};
