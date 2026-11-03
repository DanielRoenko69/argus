import type { ServiceTemplate } from '../../serviceTemplates.js';

export const vaultTemplate: ServiceTemplate = {
  id: 'vault',
  name: 'HashiCorp Vault',
  description: 'HashiCorp Vault Secrets lesen, Mounts auflisten und den Gesundheitsstatus prüfen.',
  icon: '🔐',
  category: 'cloud',
  tags: ['vault', 'hashicorp', 'secrets', 'security', 'encryption'],
  docsUrl: 'https://developer.hashicorp.com/vault/api-docs',

  fields: [
    {
      name: 'base_url',
      label: 'Vault URL',
      type: 'string',
      required: true,
      placeholder: 'http://vault:8200',
    },
    {
      name: 'token',
      label: 'Vault Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'read_secret',
      description: 'Ein Secret aus der angegebenen Secret-Engine lesen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v1/{{mount}}/data/{{path}}',
      parameters: [
        {
          name: 'mount',
          type: 'string',
          description: 'Name der Secret-Engine',
          required: false,
          default: 'secret',
        },
        {
          name: 'path',
          type: 'string',
          description: 'Pfad zum Secret',
          required: true,
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'list_secrets',
      description: 'Secrets in einem bestimmten Pfad auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v1/{{mount}}/metadata/{{path}}?list=true',
      parameters: [
        {
          name: 'mount',
          type: 'string',
          description: 'Name der Secret-Engine',
          required: false,
          default: 'secret',
        },
        {
          name: 'path',
          type: 'string',
          description: 'Pfad zum Auflisten',
          required: false,
          default: '',
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'get_health',
      description: 'Den Gesundheitsstatus des Vault-Servers abfragen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v1/sys/health',
      parameters: [],
      category: 'Cloud',
    },
    {
      nameSuffix: 'list_mounts',
      description: 'Alle konfigurierten Secret-Engines auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v1/sys/mounts',
      parameters: [],
      category: 'Cloud',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'header',

  buildAuthValue: (fields) => `X-Vault-Token:${fields.token}`,

  buildHealthPath: () => '/v1/sys/health',
};
