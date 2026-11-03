import type { ServiceTemplate } from '../../serviceTemplates.js';

export const jiraTemplate: ServiceTemplate = {
  id: 'jira',
  name: 'Jira',
  description: 'Jira-Issues, Projekte und Sprints abfragen und verwalten.',
  icon: '📋',
  category: 'projectmanagement',
  tags: ['jira', 'atlassian', 'issues', 'agile', 'tickets'],
  docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',

  fields: [
    {
      name: 'base_url',
      label: 'Jira URL',
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
      nameSuffix: 'search_issues',
      description: 'Jira-Issues per JQL-Abfrage suchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /rest/api/3/search?jql={{jql}}&maxResults={{max_results}}&fields=summary,status,assignee,priority,created,updated',
      parameters: [
        {
          name: 'jql',
          type: 'string',
          description: 'JQL-Abfrage (Jira Query Language)',
          required: true,
        },
        {
          name: 'max_results',
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
      description: 'Details eines bestimmten Jira-Issues abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /rest/api/3/issue/{{issue_key}}?fields=summary,description,status,assignee,reporter,priority,created,updated,comment',
      parameters: [
        {
          name: 'issue_key',
          type: 'string',
          description: 'Issue-Schlüssel (z.B. PROJ-123)',
          required: true,
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'list_projects',
      description: 'Alle Jira-Projekte auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /rest/api/3/project?maxResults={{max_results}}&orderBy=name',
      parameters: [
        {
          name: 'max_results',
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '50',
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'get_sprint',
      description: 'Aktive Sprints eines Boards abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /rest/agile/1.0/board/{{board_id}}/sprint?state=active',
      parameters: [
        {
          name: 'board_id',
          type: 'string',
          description: 'Board-ID',
          required: true,
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'get_issue_comments',
      description: 'Kommentare eines Jira-Issues abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /rest/api/3/issue/{{issue_key}}/comment?maxResults={{max_results}}&orderBy=-created',
      parameters: [
        {
          name: 'issue_key',
          type: 'string',
          description: 'Issue-Schlüssel (z.B. PROJ-123)',
          required: true,
        },
        {
          name: 'max_results',
          type: 'number',
          description: 'Maximale Anzahl Kommentare',
          required: false,
          default: '10',
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

  buildHealthPath: () => '/rest/api/3/serverInfo',
};
