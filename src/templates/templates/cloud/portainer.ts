import type { ServiceTemplate } from '../../serviceTemplates.js';

export const portainerTemplate: ServiceTemplate = {
  id: 'portainer',
  name: 'Portainer',
  description: 'Portainer-Endpoints und Docker-Container über die API verwalten und überwachen.',
  icon: '🐳',
  category: 'cloud',
  tags: ['portainer', 'docker', 'containers', 'management'],
  docsUrl: 'https://docs.portainer.io/api/',

  fields: [
    {
      name: 'base_url',
      label: 'Portainer URL',
      type: 'string',
      required: true,
      placeholder: 'http://portainer:9000',
    },
    {
      name: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_endpoints',
      description: 'Alle konfigurierten Endpoints auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/endpoints',
      parameters: [],
      category: 'Cloud',
    },
    {
      nameSuffix: 'list_containers',
      description: 'Container eines Endpoints auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/endpoints/{{endpoint_id}}/docker/containers/json?all={{all}}',
      parameters: [
        {
          name: 'endpoint_id',
          type: 'string',
          description: 'ID des Endpoints',
          required: true,
        },
        {
          name: 'all',
          type: 'boolean',
          description: 'Auch gestoppte Container anzeigen',
          required: false,
          default: 'false',
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'get_container',
      description: 'Details zu einem bestimmten Container abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/endpoints/{{endpoint_id}}/docker/containers/{{container_id}}/json',
      parameters: [
        {
          name: 'endpoint_id',
          type: 'string',
          description: 'ID des Endpoints',
          required: true,
        },
        {
          name: 'container_id',
          type: 'string',
          description: 'ID des Containers',
          required: true,
        },
      ],
      category: 'Cloud',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'header',

  buildAuthValue: (fields) => `X-API-Key:${fields.api_key}`,

  buildHealthPath: () => '/api/status',
};
