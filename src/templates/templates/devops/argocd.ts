import type { ServiceTemplate } from '../../serviceTemplates.js';

export const argocdTemplate: ServiceTemplate = {
  id: 'argocd',
  name: 'ArgoCD',
  description: 'ArgoCD-Anwendungen verwalten, Sync-Status und Health prüfen.',
  icon: '🐙',
  category: 'devops',
  tags: ['argocd', 'gitops', 'kubernetes', 'deployment', 'cd'],
  docsUrl: 'https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/',

  fields: [
    {
      name: 'base_url',
      label: 'ArgoCD URL',
      type: 'string',
      required: true,
      placeholder: 'https://argocd.example.com',
    },
    {
      name: 'auth_token',
      label: 'Auth Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_applications',
      description: 'Alle ArgoCD-Anwendungen auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/applications?project={{project}}',
      parameters: [
        {
          name: 'project',
          type: 'string',
          description: 'ArgoCD-Projekt filtern',
          required: false,
          default: '',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_app',
      description: 'Details einer ArgoCD-Anwendung abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/applications/{{app_name}}',
      parameters: [
        {
          name: 'app_name',
          type: 'string',
          description: 'Name der Anwendung',
          required: true,
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_app_health',
      description: 'Ressourcen-Baum und Health-Status einer Anwendung abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/applications/{{app_name}}/resource-tree',
      parameters: [
        {
          name: 'app_name',
          type: 'string',
          description: 'Name der Anwendung',
          required: true,
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'sync_app',
      description: 'Eine ArgoCD-Anwendung synchronisieren',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /api/v1/applications/{{app_name}}/sync',
      parameters: [
        {
          name: 'app_name',
          type: 'string',
          description: 'Name der Anwendung',
          required: true,
        },
      ],
      category: 'DevOps',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.auth_token,

  buildHealthPath: () => '/api/v1/session/userinfo',
};
