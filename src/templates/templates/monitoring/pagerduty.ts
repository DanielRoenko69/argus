import type { ServiceTemplate } from '../../serviceTemplates.js';

export const pagerdutyTemplate: ServiceTemplate = {
  id: 'pagerduty',
  name: 'PagerDuty',
  description: 'PagerDuty-Incidents, Services und OnCall-Plaene über die REST-API abfragen.',
  icon: '🚨',
  category: 'monitoring',
  tags: ['pagerduty', 'incidents', 'oncall', 'alerting'],
  docsUrl: 'https://developer.pagerduty.com/api-reference/',

  fields: [
    {
      name: 'api_token',
      label: 'API-Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_incidents',
      description: 'Incidents nach Status auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /incidents?statuses[]={{status}}&limit={{limit}}',
      parameters: [
        {
          name: 'status',
          type: 'string',
          description: 'Incident-Status (triggered, acknowledged, resolved)',
          required: false,
          default: 'triggered',
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '25',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'get_incident',
      description: 'Details eines einzelnen Incidents abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /incidents/{{incident_id}}',
      parameters: [
        {
          name: 'incident_id',
          type: 'string',
          description: 'ID des Incidents',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'list_services',
      description: 'Alle konfigurierten PagerDuty-Services auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /services?limit={{limit}}',
      parameters: [
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '25',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'list_oncalls',
      description: 'Aktuelle OnCall-Zuweisungen auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /oncalls?earliest={{earliest}}&limit={{limit}}',
      parameters: [
        {
          name: 'earliest',
          type: 'string',
          description: 'Fruehester Zeitpunkt (ISO 8601)',
          required: false,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '25',
        },
      ],
      category: 'Monitoring',
    },
  ],

  buildBaseUrl: () => 'https://api.pagerduty.com',

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.api_token,

  buildHealthPath: () => '/abilities',
};
