import type { ServiceTemplate } from '../../serviceTemplates.js';

export const jenkinsTemplate: ServiceTemplate = {
  id: 'jenkins',
  name: 'Jenkins',
  description: 'Jenkins-Jobs, Builds und Pipelines überwachen und verwalten.',
  icon: '🎩',
  category: 'devops',
  tags: ['jenkins', 'ci', 'cd', 'build', 'pipeline'],
  docsUrl: 'https://www.jenkins.io/doc/book/using/remote-access-api/',

  fields: [
    {
      name: 'base_url',
      label: 'Jenkins URL',
      type: 'string',
      required: true,
      placeholder: 'http://jenkins:8080',
    },
    {
      name: 'username',
      label: 'Benutzername',
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
      nameSuffix: 'list_jobs',
      description: 'Alle Jenkins-Jobs mit letztem Build-Status auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/json?tree=jobs[name,color,url,lastBuild[number,result,timestamp]]',
      parameters: [],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_job',
      description: 'Details eines bestimmten Jenkins-Jobs abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /job/{{job_name}}/api/json',
      parameters: [
        {
          name: 'job_name',
          type: 'string',
          description: 'Name des Jobs',
          required: true,
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_build',
      description: 'Details eines bestimmten Builds abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /job/{{job_name}}/{{build_number}}/api/json',
      parameters: [
        {
          name: 'job_name',
          type: 'string',
          description: 'Name des Jobs',
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
    {
      nameSuffix: 'trigger_build',
      description: 'Einen neuen Build für einen Job auslösen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /job/{{job_name}}/build',
      parameters: [
        {
          name: 'job_name',
          type: 'string',
          description: 'Name des Jobs',
          required: true,
        },
      ],
      category: 'DevOps',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'basic',

  buildAuthValue: (fields) => `${fields.username}:${fields.api_token}`,

  buildHealthPath: () => '/api/json',
};
