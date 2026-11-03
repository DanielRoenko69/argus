import type { ServiceTemplate } from '../../serviceTemplates.js';

export const redisTemplate: ServiceTemplate = {
  id: 'redis',
  name: 'Redis',
  description: 'Redis über einen REST-Proxy (z.B. Redis REST, Upstash) anbinden.',
  icon: '\uD83D\uDD34',
  category: 'database',
  subcategory: 'keyvalue',
  tags: ['redis', 'cache', 'keyvalue', 'nosql'],

  fields: [
    {
      name: 'base_url',
      label: 'REST-Proxy URL',
      type: 'string',
      required: true,
      placeholder: 'https://redis-proxy.example.com',
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
      nameSuffix: 'get_key',
      description: 'Einen Wert anhand des Schlüssels abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /get/{{key}}',
      parameters: [
        {
          name: 'key',
          type: 'string',
          description: 'Redis-Schlüssel',
          required: true,
        },
      ],
      category: 'Database',
    },
    {
      nameSuffix: 'list_keys',
      description: 'Schlüssel nach Muster auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /keys/{{pattern}}',
      parameters: [
        {
          name: 'pattern',
          type: 'string',
          description: 'Suchmuster (z.B. user:*)',
          required: true,
        },
      ],
      category: 'Database',
    },
    {
      nameSuffix: 'get_info',
      description: 'Redis-Server-Informationen abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /info',
      parameters: [],
      category: 'Database',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildHealthPath: () => '/health',
};
