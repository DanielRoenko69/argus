import type { ServiceTemplate } from '../../serviceTemplates.js';

export const asanaTemplate: ServiceTemplate = {
  id: 'asana',
  name: 'Asana',
  description: 'Asana-Aufgaben und Projekte abfragen und verwalten.',
  icon: '🎯',
  category: 'projectmanagement',
  tags: ['asana', 'tasks', 'project-management', 'agile'],
  docsUrl: 'https://developers.asana.com/reference/rest-api-reference',

  fields: [
    {
      name: 'personal_access_token',
      label: 'Personal Access Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_tasks',
      description: 'Aufgaben eines Projekts auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/1.0/tasks?project={{project_gid}}&completed_since={{completed_since}}&limit={{limit}}&opt_fields=name,assignee.name,due_on,completed,notes',
      parameters: [
        {
          name: 'project_gid',
          type: 'string',
          description: 'Projekt-GID',
          required: true,
        },
        {
          name: 'completed_since',
          type: 'string',
          description: 'Nur Aufgaben seit diesem Datum (ISO 8601)',
          required: false,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '50',
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'get_task',
      description: 'Details einer bestimmten Aufgabe abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/1.0/tasks/{{task_gid}}?opt_fields=name,assignee.name,due_on,completed,notes,projects.name,tags.name',
      parameters: [
        {
          name: 'task_gid',
          type: 'string',
          description: 'Aufgaben-GID',
          required: true,
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'list_projects',
      description: 'Alle Projekte eines Workspace auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/1.0/projects?workspace={{workspace_gid}}&limit={{limit}}&opt_fields=name,owner.name,due_on,current_status',
      parameters: [
        {
          name: 'workspace_gid',
          type: 'string',
          description: 'Workspace-GID',
          required: true,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '50',
        },
      ],
      category: 'Projektmanagement',
    },
  ],

  buildBaseUrl: () => 'https://app.asana.com',

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.personal_access_token,

  buildHealthPath: () => '/api/1.0/users/me',
};
