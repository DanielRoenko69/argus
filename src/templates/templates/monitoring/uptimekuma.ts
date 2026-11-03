import type { ServiceTemplate } from '../../serviceTemplates.js';

export const uptimekumaTemplate: ServiceTemplate = {
  id: 'uptime-kuma',
  name: 'Uptime Kuma',
  description: 'Uptime Kuma Monitoring-Status abfragen.',
  icon: '🟩',
  category: 'monitoring',
  tags: ['uptimekuma', 'uptime', 'monitoring', 'status'],
  docsUrl: 'https://github.com/louislam/uptime-kuma',

  fields: [
    {
      name: 'base_url',
      label: 'Uptime Kuma URL',
      type: 'string',
      required: true,
      placeholder: 'http://uptime-kuma:3001',
    },
    {
      name: 'username',
      label: 'Benutzername',
      type: 'string',
      required: true,
    },
    {
      name: 'password',
      label: 'Passwort',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_monitors',
      description: 'Alle Monitors einer Status-Seite auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/status-page/{{slug}}',
      parameters: [
        {
          name: 'slug',
          type: 'string',
          description: 'Slug der Status-Seite',
          required: false,
          default: 'default',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'get_heartbeats',
      description: 'Heartbeat-Daten einer Status-Seite abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/status-page/heartbeat/{{slug}}',
      parameters: [
        {
          name: 'slug',
          type: 'string',
          description: 'Slug der Status-Seite',
          required: false,
          default: 'default',
        },
      ],
      category: 'Monitoring',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'basic',

  buildAuthValue: (fields) => `${fields.username}:${fields.password}`,

  buildHealthPath: () => '/api/status-page/default',
};
