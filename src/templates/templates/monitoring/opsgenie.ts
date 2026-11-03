import type { ServiceTemplate } from '../../serviceTemplates.js';

export const opsgenieTemplate: ServiceTemplate = {
  id: 'opsgenie',
  name: 'OpsGenie',
  description: 'OpsGenie-Alerts, Alert-Details und Bereitschaftsplaene über die REST-API abfragen.',
  icon: '🔔',
  category: 'monitoring',
  tags: ['opsgenie', 'alerts', 'oncall', 'incidents', 'atlassian'],
  docsUrl: 'https://docs.opsgenie.com/docs/api-overview',

  fields: [
    {
      name: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_alerts',
      description: 'Alerts nach Suchkriterien auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v2/alerts?query={{query}}&limit={{limit}}',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'Suchabfrage für Alerts',
          required: false,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '20',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'get_alert',
      description: 'Details eines einzelnen Alerts abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v2/alerts/{{alert_id}}',
      parameters: [
        {
          name: 'alert_id',
          type: 'string',
          description: 'ID des Alerts',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'list_schedules',
      description: 'Alle Bereitschaftsplaene auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v2/schedules',
      parameters: [],
      category: 'Monitoring',
    },
  ],

  buildBaseUrl: () => 'https://api.opsgenie.com',

  buildAuthType: () => 'header',

  buildAuthValue: (fields) => `Authorization:GenieKey ${fields.api_key}`,

  buildHealthPath: () => '/v2/heartbeats',
};
