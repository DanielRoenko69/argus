import type { ServiceTemplate } from '../../serviceTemplates.js';

export const falcoTemplate: ServiceTemplate = {
  id: 'falco',
  name: 'Falco',
  description: 'Falco-Sicherheitsevents und Regeln überwachen.',
  icon: '🦅',
  category: 'security',
  tags: ['falco', 'runtime', 'security', 'kubernetes', 'alerts'],
  docsUrl: 'https://falco.org/docs/reference/daemon/web-api/',

  fields: [
    {
      name: 'base_url',
      label: 'Falco URL',
      type: 'string',
      required: true,
      placeholder: 'http://falco:8765',
    },
  ],

  tools: [
    {
      nameSuffix: 'get_events',
      description: 'Sicherheitsevents abfragen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/events?limit={{limit}}',
      parameters: [
        {
          name: 'limit',
          type: 'string',
          description: 'Maximale Anzahl der Events',
          required: false,
          default: '100',
        },
      ],
      category: 'Security',
    },
    {
      nameSuffix: 'get_version',
      description: 'Falco-Versionsinformationen abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/version',
      parameters: [],
      category: 'Security',
    },
    {
      nameSuffix: 'list_rules',
      description: 'Alle Falco-Regeln auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/rules',
      parameters: [],
      category: 'Security',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'none',

  buildHealthPath: () => '/healthz',
};
