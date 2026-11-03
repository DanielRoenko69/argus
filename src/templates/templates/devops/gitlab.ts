import type { ServiceTemplate } from '../../serviceTemplates.js';

export const gitlabTemplate: ServiceTemplate = {
  id: 'gitlab',
  name: 'GitLab',
  description: 'GitLab-Projekte, Pipelines, Merge Requests und Issues verwalten.',
  icon: '🦊',
  category: 'devops',
  tags: ['gitlab', 'git', 'ci', 'cd', 'pipelines', 'merge-requests'],
  docsUrl: 'https://docs.gitlab.com/ee/api/rest/',

  fields: [
    {
      name: 'base_url',
      label: 'GitLab URL',
      type: 'string',
      required: true,
      placeholder: 'https://gitlab.example.com',
    },
    {
      name: 'private_token',
      label: 'Private Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_projects',
      description: 'Alle Projekte auflisten, auf die der Benutzer Zugriff hat',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v4/projects?membership=true&per_page={{per_page}}&page={{page}}',
      parameters: [
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
        {
          name: 'page',
          type: 'number',
          description: 'Seitennummer',
          required: false,
          default: '1',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_project',
      description: 'Details eines bestimmten Projekts abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v4/projects/{{project_id}}',
      parameters: [
        {
          name: 'project_id',
          type: 'string',
          description: 'Projekt-ID oder URL-kodierter Pfad',
          required: true,
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_pipelines',
      description: 'Pipelines eines Projekts auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v4/projects/{{project_id}}/pipelines?per_page={{per_page}}&status={{status}}',
      parameters: [
        {
          name: 'project_id',
          type: 'string',
          description: 'Projekt-ID oder URL-kodierter Pfad',
          required: true,
        },
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
        {
          name: 'status',
          type: 'string',
          description: 'Pipeline-Status filtern (running, pending, success, failed, canceled, skipped)',
          required: false,
          default: '',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_merge_requests',
      description: 'Merge Requests eines Projekts auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v4/projects/{{project_id}}/merge_requests?state={{state}}&per_page={{per_page}}',
      parameters: [
        {
          name: 'project_id',
          type: 'string',
          description: 'Projekt-ID oder URL-kodierter Pfad',
          required: true,
        },
        {
          name: 'state',
          type: 'string',
          description: 'Status der Merge Requests (opened, closed, merged, all)',
          required: false,
          default: 'opened',
        },
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_issues',
      description: 'Issues eines Projekts auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v4/projects/{{project_id}}/issues?state={{state}}&per_page={{per_page}}',
      parameters: [
        {
          name: 'project_id',
          type: 'string',
          description: 'Projekt-ID oder URL-kodierter Pfad',
          required: true,
        },
        {
          name: 'state',
          type: 'string',
          description: 'Status der Issues (opened, closed, all)',
          required: false,
          default: 'opened',
        },
        {
          name: 'per_page',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
      ],
      category: 'DevOps',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'header',

  buildAuthValue: (fields) => `PRIVATE-TOKEN:${fields.private_token}`,

  buildHealthPath: () => '/api/v4/version',
};
