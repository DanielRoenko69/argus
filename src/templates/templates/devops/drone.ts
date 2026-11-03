import type { ServiceTemplate } from '../../serviceTemplates.js';

export const droneTemplate: ServiceTemplate = {
  id: 'drone',
  name: 'Drone CI',
  description: 'Drone-CI-Repositories und Builds überwachen und verwalten.',
  icon: '✈️',
  category: 'devops',
  tags: ['drone', 'ci', 'cd', 'build'],
  docsUrl: 'https://docs.drone.io/api/overview/',

  fields: [
    {
      name: 'base_url',
      label: 'Drone URL',
      type: 'string',
      required: true,
      placeholder: 'https://drone.example.com',
    },
    {
      name: 'token',
      label: 'Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_repos',
      description: 'Alle Repositories des Benutzers auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/user/repos?latest=true',
      parameters: [],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_builds',
      description: 'Builds eines Repositories auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/repos/{{owner}}/{{repo}}/builds?page={{page}}',
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
      nameSuffix: 'get_build',
      description: 'Details eines bestimmten Builds abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/repos/{{owner}}/{{repo}}/builds/{{build_number}}',
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
          name: 'build_number',
          type: 'number',
          description: 'Build-Nummer',
          required: true,
        },
      ],
      category: 'DevOps',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildHealthPath: () => '/healthz',
};
