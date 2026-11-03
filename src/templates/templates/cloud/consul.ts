import type { ServiceTemplate } from '../../serviceTemplates.js';

export const consulTemplate: ServiceTemplate = {
  id: 'consul',
  name: 'HashiCorp Consul',
  description: 'HashiCorp Consul Services, Nodes und Key-Value-Eintraege abfragen.',
  icon: '🌐',
  category: 'cloud',
  tags: ['consul', 'hashicorp', 'service-discovery', 'kv', 'mesh'],
  docsUrl: 'https://developer.hashicorp.com/consul/api-docs',

  fields: [
    {
      name: 'base_url',
      label: 'Consul URL',
      type: 'string',
      required: true,
      placeholder: 'http://consul:8500',
    },
    {
      name: 'token',
      label: 'ACL Token',
      type: 'password',
      required: false,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_services',
      description: 'Alle registrierten Services im Katalog auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v1/catalog/services',
      parameters: [],
      category: 'Cloud',
    },
    {
      nameSuffix: 'get_service',
      description: 'Details zu einem bestimmten Service abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v1/catalog/service/{{service_name}}',
      parameters: [
        {
          name: 'service_name',
          type: 'string',
          description: 'Name des Services',
          required: true,
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'list_nodes',
      description: 'Alle Nodes im Consul-Cluster auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v1/catalog/nodes',
      parameters: [],
      category: 'Cloud',
    },
    {
      nameSuffix: 'get_kv',
      description: 'Einen Wert aus dem Key-Value-Store abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v1/kv/{{key}}?raw={{raw}}',
      parameters: [
        {
          name: 'key',
          type: 'string',
          description: 'Schlüssel im KV-Store',
          required: true,
        },
        {
          name: 'raw',
          type: 'boolean',
          description: 'Rohwert ohne Metadaten zurückgeben',
          required: false,
          default: 'false',
        },
      ],
      category: 'Cloud',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: (fields) => fields.token ? 'header' : 'none',

  buildAuthValue: (fields) => fields.token ? `X-Consul-Token:${fields.token}` : '',

  buildHealthPath: () => '/v1/status/leader',
};
