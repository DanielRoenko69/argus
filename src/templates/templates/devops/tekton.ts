import type { ServiceTemplate } from '../../serviceTemplates.js';

export const tektonTemplate: ServiceTemplate = {
  id: 'tekton',
  name: 'Tekton Dashboard',
  description: 'Tekton-PipelineRuns und TaskRuns überwachen und verwalten.',
  icon: '🔧',
  category: 'devops',
  tags: ['tekton', 'kubernetes', 'ci', 'cd', 'pipelines'],

  fields: [
    {
      name: 'base_url',
      label: 'Tekton Dashboard URL',
      type: 'string',
      required: true,
      placeholder: 'http://tekton-dashboard:9097',
    },
    {
      name: 'auth_type',
      label: 'Authentifizierung',
      type: 'select',
      required: true,
      default: 'none',
      options: ['none', 'bearer'],
    },
    {
      name: 'auth_value',
      label: 'Auth-Wert (Bearer-Token)',
      type: 'password',
      required: false,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_pipelineruns',
      description: 'PipelineRuns in einem Namespace auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /apis/tekton.dev/v1/namespaces/{{namespace}}/pipelineruns?limit={{limit}}',
      parameters: [
        {
          name: 'namespace',
          type: 'string',
          description: 'Kubernetes-Namespace',
          required: false,
          default: 'default',
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '20',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_pipelinerun',
      description: 'Details eines bestimmten PipelineRuns abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /apis/tekton.dev/v1/namespaces/{{namespace}}/pipelineruns/{{name}}',
      parameters: [
        {
          name: 'namespace',
          type: 'string',
          description: 'Kubernetes-Namespace',
          required: false,
          default: 'default',
        },
        {
          name: 'name',
          type: 'string',
          description: 'Name des PipelineRuns',
          required: true,
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_taskruns',
      description: 'TaskRuns in einem Namespace auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /apis/tekton.dev/v1/namespaces/{{namespace}}/taskruns?limit={{limit}}',
      parameters: [
        {
          name: 'namespace',
          type: 'string',
          description: 'Kubernetes-Namespace',
          required: false,
          default: 'default',
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse',
          required: false,
          default: '20',
        },
      ],
      category: 'DevOps',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: (fields) => fields.auth_type || 'none',

  buildAuthValue: (fields) => fields.auth_value || '',

  buildHealthPath: () => '/healthz',
};
