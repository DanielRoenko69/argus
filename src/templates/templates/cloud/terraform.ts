import type { ServiceTemplate } from '../../serviceTemplates.js';

export const terraformCloudTemplate: ServiceTemplate = {
  id: 'terraform-cloud',
  name: 'Terraform Cloud',
  description: 'Terraform Cloud Workspaces und Runs über die API verwalten und überwachen.',
  icon: '🏗️',
  category: 'cloud',
  tags: ['terraform', 'hashicorp', 'iac', 'infrastructure', 'cloud'],
  docsUrl: 'https://developer.hashicorp.com/terraform/cloud-docs/api-docs',

  fields: [
    {
      name: 'token',
      label: 'API Token',
      type: 'password',
      required: true,
    },
    {
      name: 'organization',
      label: 'Organisation',
      type: 'string',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_workspaces',
      description: 'Alle Workspaces einer Organisation auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v2/organizations/{{organization}}/workspaces?page[size]={{page_size}}',
      parameters: [
        {
          name: 'organization',
          type: 'string',
          description: 'Name der Organisation',
          required: true,
        },
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '20',
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'get_workspace',
      description: 'Details zu einem bestimmten Workspace abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v2/organizations/{{organization}}/workspaces/{{workspace_name}}',
      parameters: [
        {
          name: 'organization',
          type: 'string',
          description: 'Name der Organisation',
          required: true,
        },
        {
          name: 'workspace_name',
          type: 'string',
          description: 'Name des Workspaces',
          required: true,
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'list_runs',
      description: 'Runs eines Workspaces auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v2/workspaces/{{workspace_id}}/runs?page[size]={{page_size}}',
      parameters: [
        {
          name: 'workspace_id',
          type: 'string',
          description: 'ID des Workspaces',
          required: true,
        },
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '10',
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'get_run',
      description: 'Details zu einem bestimmten Run abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v2/runs/{{run_id}}',
      parameters: [
        {
          name: 'run_id',
          type: 'string',
          description: 'ID des Runs',
          required: true,
        },
      ],
      category: 'Cloud',
    },
  ],

  buildBaseUrl: () => 'https://app.terraform.io',

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildDefaultHeaders: () => ({ 'Content-Type': 'application/vnd.api+json' }),

  buildHealthPath: () => '/api/v2/ping',
};
