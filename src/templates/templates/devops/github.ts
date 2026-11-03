import type { ServiceTemplate } from '../../serviceTemplates.js';

export const githubTemplate: ServiceTemplate = {
  id: 'github',
  name: 'GitHub',
  description: 'GitHub-Repositories, Pull Requests, Issues und Actions verwalten.',
  icon: '🐙',
  category: 'devops',
  tags: ['github', 'git', 'ci', 'actions', 'pull-requests', 'issues'],
  docsUrl: 'https://docs.github.com/en/rest',

  fields: [
    {
      name: 'token',
      label: 'Personal Access Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_repos',
      description: 'Repositories des authentifizierten Benutzers auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /user/repos?per_page={{per_page}}&page={{page}}&sort={{sort}}',
      parameters: [
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '30',
        },
        {
          name: 'page',
          type: 'number',
          description: 'Seitennummer',
          required: false,
          default: '1',
        },
        {
          name: 'sort',
          type: 'string',
          description: 'Sortierung (created, updated, pushed, full_name)',
          required: false,
          default: 'updated',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_repo',
      description: 'Details eines Repositories abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /repos/{{owner}}/{{repo}}',
      parameters: [
        {
          name: 'owner',
          type: 'string',
          description: 'Eigentuemer des Repositories',
          required: true,
        },
        {
          name: 'repo',
          type: 'string',
          description: 'Name des Repositories',
          required: true,
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_pulls',
      description: 'Pull Requests eines Repositories auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /repos/{{owner}}/{{repo}}/pulls?state={{state}}&per_page={{per_page}}',
      parameters: [
        {
          name: 'owner',
          type: 'string',
          description: 'Eigentuemer des Repositories',
          required: true,
        },
        {
          name: 'repo',
          type: 'string',
          description: 'Name des Repositories',
          required: true,
        },
        {
          name: 'state',
          type: 'string',
          description: 'Status der Pull Requests (open, closed, all)',
          required: false,
          default: 'open',
        },
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '30',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_issues',
      description: 'Issues eines Repositories auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /repos/{{owner}}/{{repo}}/issues?state={{state}}&per_page={{per_page}}',
      parameters: [
        {
          name: 'owner',
          type: 'string',
          description: 'Eigentuemer des Repositories',
          required: true,
        },
        {
          name: 'repo',
          type: 'string',
          description: 'Name des Repositories',
          required: true,
        },
        {
          name: 'state',
          type: 'string',
          description: 'Status der Issues (open, closed, all)',
          required: false,
          default: 'open',
        },
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '30',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_actions_runs',
      description: 'GitHub Actions Workflow-Läufe eines Repositories auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /repos/{{owner}}/{{repo}}/actions/runs?per_page={{per_page}}&status={{status}}',
      parameters: [
        {
          name: 'owner',
          type: 'string',
          description: 'Eigentuemer des Repositories',
          required: true,
        },
        {
          name: 'repo',
          type: 'string',
          description: 'Name des Repositories',
          required: true,
        },
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '10',
        },
        {
          name: 'status',
          type: 'string',
          description: 'Status filtern (queued, in_progress, completed, success, failure)',
          required: false,
          default: '',
        },
      ],
      category: 'DevOps',
    },
  ],

  buildBaseUrl: () => 'https://api.github.com',

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildDefaultHeaders: () => ({
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }),

  buildHealthPath: () => '/rate_limit',
};
