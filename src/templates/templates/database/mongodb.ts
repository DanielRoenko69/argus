import type { ServiceTemplate } from '../../serviceTemplates.js';

export const mongodbTemplate: ServiceTemplate = {
  id: 'mongodb',
  name: 'MongoDB Atlas',
  description: 'MongoDB Atlas über die Atlas Administration API anbinden.',
  icon: '\uD83C\uDF43',
  category: 'database',
  subcategory: 'nosql',
  tags: ['mongodb', 'mongo', 'nosql', 'atlas', 'document'],
  docsUrl: 'https://www.mongodb.com/docs/atlas/api/',

  fields: [
    {
      name: 'base_url',
      label: 'Atlas API URL',
      type: 'string',
      required: true,
      placeholder: 'https://cloud.mongodb.com',
    },
    {
      name: 'public_key',
      label: 'Public Key',
      type: 'string',
      required: true,
      placeholder: 'Atlas Public Key',
    },
    {
      name: 'private_key',
      label: 'Private Key',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_databases',
      description: 'Alle Datenbanken eines Atlas-Clusters auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/atlas/v2/groups/{{group_id}}/clusters/{{cluster_name}}/databases',
      parameters: [
        {
          name: 'group_id',
          type: 'string',
          description: 'Atlas Projekt-/Gruppen-ID',
          required: true,
        },
        {
          name: 'cluster_name',
          type: 'string',
          description: 'Name des Clusters',
          required: true,
        },
      ],
      category: 'Database',
    },
    {
      nameSuffix: 'list_collections',
      description: 'Alle Collections in einer Datenbank auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/atlas/v2/groups/{{group_id}}/clusters/{{cluster_name}}/databases/{{database_name}}/collections',
      parameters: [
        {
          name: 'group_id',
          type: 'string',
          description: 'Atlas Projekt-/Gruppen-ID',
          required: true,
        },
        {
          name: 'cluster_name',
          type: 'string',
          description: 'Name des Clusters',
          required: true,
        },
        {
          name: 'database_name',
          type: 'string',
          description: 'Name der Datenbank',
          required: true,
        },
      ],
      category: 'Database',
    },
    {
      nameSuffix: 'get_cluster_status',
      description: 'Status und Konfiguration eines Atlas-Clusters abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/atlas/v2/groups/{{group_id}}/clusters/{{cluster_name}}',
      parameters: [
        {
          name: 'group_id',
          type: 'string',
          description: 'Atlas Projekt-/Gruppen-ID',
          required: true,
        },
        {
          name: 'cluster_name',
          type: 'string',
          description: 'Name des Clusters',
          required: true,
        },
      ],
      category: 'Database',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'basic',

  buildAuthValue: (fields) => `${fields.public_key}:${fields.private_key}`,

  buildHealthPath: () => '/api/atlas/v2',
};
