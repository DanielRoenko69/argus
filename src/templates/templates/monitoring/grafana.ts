import type { ServiceTemplate } from '../../serviceTemplates.js';

export const grafanaTemplate: ServiceTemplate = {
  id: 'grafana-api',
  name: 'Grafana API',
  description: 'Grafana-Dashboards, Datenquellen, Annotationen und Alerts über die HTTP-API verwalten.',
  icon: '📊',
  category: 'monitoring',
  tags: ['grafana', 'dashboards', 'monitoring', 'visualization'],
  docsUrl: 'https://grafana.com/docs/grafana/latest/developers/http_api/',

  fields: [
    {
      name: 'base_url',
      label: 'Grafana URL',
      type: 'string',
      required: true,
      placeholder: 'http://grafana:3000',
    },
    {
      name: 'api_key',
      label: 'API-Schlüssel',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_dashboards',
      description: 'Alle Dashboards auflisten und durchsuchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/search?type=dash-db&limit={{limit}}',
      parameters: [
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '50',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'get_dashboard',
      description: 'Ein Dashboard anhand seiner UID abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/dashboards/uid/{{uid}}',
      parameters: [
        {
          name: 'uid',
          type: 'string',
          description: 'UID des Dashboards',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'list_datasources',
      description: 'Alle konfigurierten Datenquellen auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/datasources',
      parameters: [],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'search_annotations',
      description: 'Annotationen in einem Zeitbereich suchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/annotations?from={{from}}&to={{to}}&limit={{limit}}',
      parameters: [
        {
          name: 'from',
          type: 'string',
          description: 'Startzeitpunkt (Unix-Millisekunden)',
          required: false,
        },
        {
          name: 'to',
          type: 'string',
          description: 'Endzeitpunkt (Unix-Millisekunden)',
          required: false,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '100',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'get_alerts',
      description: 'Alle provisionierten Alert-Regeln abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/provisioning/alert-rules',
      parameters: [],
      category: 'Monitoring',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.api_key,

  buildHealthPath: () => '/api/health',
};
