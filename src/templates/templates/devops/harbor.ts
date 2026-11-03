import type { ServiceTemplate } from '../../serviceTemplates.js';

export const harborTemplate: ServiceTemplate = {
  id: 'harbor',
  name: 'Harbor',
  description: 'Harbor-Container-Registry verwalten, Repositories und Schwachstellen prüfen.',
  icon: '⚓',
  category: 'devops',
  tags: ['harbor', 'registry', 'container', 'docker', 'vulnerabilities'],
  docsUrl: 'https://goharbor.io/docs/',

  fields: [
    {
      name: 'base_url',
      label: 'Harbor URL',
      type: 'string',
      required: true,
      placeholder: 'https://harbor.example.com',
    },
    {
      name: 'username',
      label: 'Benutzername',
      type: 'string',
      required: true,
    },
    {
      name: 'password',
      label: 'Passwort',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_projects',
      description: 'Alle Harbor-Projekte auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v2.0/projects?page={{page}}&page_size={{page_size}}',
      parameters: [
        {
          name: 'page',
          type: 'number',
          description: 'Seitennummer',
          required: false,
          default: '1',
        },
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_repositories',
      description: 'Repositories eines Projekts auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v2.0/projects/{{project_name}}/repositories?page={{page}}&page_size={{page_size}}',
      parameters: [
        {
          name: 'project_name',
          type: 'string',
          description: 'Name des Projekts',
          required: true,
        },
        {
          name: 'page',
          type: 'number',
          description: 'Seitennummer',
          required: false,
          default: '1',
        },
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_artifacts',
      description: 'Artefakte eines Repositories auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v2.0/projects/{{project_name}}/repositories/{{repository_name}}/artifacts?page={{page}}&page_size={{page_size}}',
      parameters: [
        {
          name: 'project_name',
          type: 'string',
          description: 'Name des Projekts',
          required: true,
        },
        {
          name: 'repository_name',
          type: 'string',
          description: 'Name des Repositories',
          required: true,
        },
        {
          name: 'page',
          type: 'number',
          description: 'Seitennummer',
          required: false,
          default: '1',
        },
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_vulnerabilities',
      description: 'Schwachstellen eines Artefakts abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v2.0/projects/{{project_name}}/repositories/{{repository_name}}/artifacts/{{reference}}/additions/vulnerabilities',
      parameters: [
        {
          name: 'project_name',
          type: 'string',
          description: 'Name des Projekts',
          required: true,
        },
        {
          name: 'repository_name',
          type: 'string',
          description: 'Name des Repositories',
          required: true,
        },
        {
          name: 'reference',
          type: 'string',
          description: 'Referenz des Artefakts (Tag oder Digest)',
          required: true,
        },
      ],
      category: 'DevOps',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'basic',

  buildAuthValue: (fields) => `${fields.username}:${fields.password}`,

  buildHealthPath: () => '/api/v2.0/health',
};
