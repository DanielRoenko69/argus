import type { ServiceTemplate } from '../../serviceTemplates.js';

export const sentryTemplate: ServiceTemplate = {
  id: 'sentry',
  name: 'Sentry',
  description: 'Sentry-Issues, Events und Projekte über die REST-API abfragen.',
  icon: '🐛',
  category: 'monitoring',
  tags: ['sentry', 'errors', 'monitoring', 'crash-reporting'],
  docsUrl: 'https://docs.sentry.io/api/',

  fields: [
    {
      name: 'base_url',
      label: 'Sentry URL',
      type: 'string',
      required: true,
      default: 'https://sentry.io',
      placeholder: 'https://sentry.io',
    },
    {
      name: 'auth_token',
      label: 'Auth-Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_issues',
      description: 'Issues eines Projekts auflisten und durchsuchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/0/projects/{{organization_slug}}/{{project_slug}}/issues/?query={{query}}&limit={{limit}}',
      parameters: [
        {
          name: 'organization_slug',
          type: 'string',
          description: 'Slug der Organisation',
          required: true,
        },
        {
          name: 'project_slug',
          type: 'string',
          description: 'Slug des Projekts',
          required: true,
        },
        {
          name: 'query',
          type: 'string',
          description: 'Suchbegriff für Issues',
          required: false,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '25',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'get_issue_events',
      description: 'Events eines bestimmten Issues abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/0/issues/{{issue_id}}/events/?limit={{limit}}',
      parameters: [
        {
          name: 'issue_id',
          type: 'string',
          description: 'ID des Issues',
          required: true,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Events',
          required: false,
          default: '10',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'list_projects',
      description: 'Alle Projekte einer Organisation auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/0/organizations/{{organization_slug}}/projects/',
      parameters: [
        {
          name: 'organization_slug',
          type: 'string',
          description: 'Slug der Organisation',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.auth_token,

  buildHealthPath: () => '/api/0/',
};
