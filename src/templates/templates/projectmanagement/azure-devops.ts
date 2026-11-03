import type { ServiceTemplate } from '../../serviceTemplates.js';

export const azureDevopsTemplate: ServiceTemplate = {
  id: 'azure-devops',
  name: 'Azure DevOps',
  description: 'Azure DevOps Work Items, Builds und Releases verwalten.',
  icon: '🔷',
  category: 'projectmanagement',
  tags: ['azure', 'devops', 'microsoft', 'work-items', 'pipelines'],
  docsUrl: 'https://learn.microsoft.com/en-us/rest/api/azure/devops/',

  fields: [
    {
      name: 'base_url',
      label: 'Base URL',
      type: 'string',
      required: true,
      placeholder: 'https://dev.azure.com/{organization}',
    },
    {
      name: 'project',
      label: 'Projekt',
      type: 'string',
      required: true,
    },
    {
      name: 'pat',
      label: 'Personal Access Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_work_items',
      description: 'Work Items per WIQL-Abfrage suchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /wit/wiql?api-version=7.0\n\n{"query": "{{wiql}}"}',
      parameters: [
        {
          name: 'wiql',
          type: 'string',
          description: 'WIQL-Abfrage',
          required: true,
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'get_work_item',
      description: 'Details eines Work Items abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /wit/workitems/{{id}}?api-version=7.0&$expand=all',
      parameters: [
        {
          name: 'id',
          type: 'string',
          description: 'Work Item ID',
          required: true,
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'list_builds',
      description: 'Alle Builds auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /build/builds?api-version=7.0&$top={{top}}',
      parameters: [
        {
          name: 'top',
          type: 'string',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '20',
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'list_pipelines',
      description: 'Alle Pipelines auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /pipelines?api-version=7.0',
      parameters: [],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'list_releases',
      description: 'Alle Releases auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /release/releases?api-version=7.0&$top={{top}}',
      parameters: [
        {
          name: 'top',
          type: 'string',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '20',
        },
      ],
      category: 'Projektmanagement',
    },
  ],

  buildBaseUrl: (fields) => `${fields.base_url}/${fields.project}/_apis`,

  buildAuthType: () => 'basic',

  buildAuthValue: (fields) => `:${fields.pat}`,

  buildHealthPath: () => '/connectionData',
};
