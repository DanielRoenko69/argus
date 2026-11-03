import type { ServiceTemplate } from '../../serviceTemplates.js';

export const restApiTemplate: ServiceTemplate = {
  id: 'rest-api',
  name: 'REST API',
  description: 'Beliebige REST API als MCP-Tool anbinden. Endpunkte werden manuell konfiguriert.',
  icon: '\uD83D\uDD0C',
  category: 'api',
  tags: ['rest', 'api', 'http', 'custom'],

  fields: [
    {
      name: 'base_url',
      label: 'Base URL',
      type: 'string',
      required: true,
      placeholder: 'https://api.example.com',
    },
    {
      name: 'auth_type',
      label: 'Auth-Typ',
      type: 'select',
      required: true,
      default: 'none',
      options: ['none', 'bearer', 'basic', 'header'],
    },
    {
      name: 'auth_value',
      label: 'Auth-Wert',
      type: 'password',
      required: false,
      placeholder: 'Token, user:password oder Header-Wert',
    },
    {
      name: 'health_path',
      label: 'Health-Pfad',
      type: 'string',
      required: false,
      placeholder: '/health',
    },
  ],

  tools: [],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: (fields) => fields.auth_type || 'none',

  buildAuthValue: (fields) => fields.auth_value || '',

  buildHealthPath: (fields) => fields.health_path || '',
};
