import type { ServiceTemplate } from '../../serviceTemplates.js';

export const datadogTemplate: ServiceTemplate = {
  id: 'datadog',
  name: 'Datadog',
  description: 'Datadog-Metriken abfragen, Monitors und Events verwalten sowie Downtimes auflisten.',
  icon: '🐕',
  category: 'monitoring',
  tags: ['datadog', 'monitoring', 'apm', 'metrics', 'logs'],
  docsUrl: 'https://docs.datadoghq.com/api/',

  fields: [
    {
      name: 'site',
      label: 'Datadog-Site',
      type: 'select',
      required: true,
      default: 'datadoghq.com',
      options: ['datadoghq.com', 'datadoghq.eu', 'us3.datadoghq.com', 'us5.datadoghq.com'],
    },
    {
      name: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
    },
    {
      name: 'app_key',
      label: 'Application Key',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'query_metrics',
      description: 'Metriken mit einer Datadog-Query abfragen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /api/v1/query?query={{query}}&from={{from}}&to={{to}}',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'Datadog-Metrik-Abfrage',
          required: true,
        },
        {
          name: 'from',
          type: 'string',
          description: 'Startzeitpunkt (Unix-Timestamp)',
          required: true,
        },
        {
          name: 'to',
          type: 'string',
          description: 'Endzeitpunkt (Unix-Timestamp)',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'list_monitors',
      description: 'Alle konfigurierten Monitors auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/monitor?page={{page}}&page_size={{page_size}}',
      parameters: [
        {
          name: 'page',
          type: 'number',
          description: 'Seitennummer (beginnend bei 0)',
          required: false,
          default: '0',
        },
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '50',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'get_events',
      description: 'Events innerhalb eines Zeitbereichs abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/events?start={{start}}&end={{end}}&priority={{priority}}',
      parameters: [
        {
          name: 'start',
          type: 'string',
          description: 'Startzeitpunkt (Unix-Timestamp)',
          required: true,
        },
        {
          name: 'end',
          type: 'string',
          description: 'Endzeitpunkt (Unix-Timestamp)',
          required: true,
        },
        {
          name: 'priority',
          type: 'string',
          description: 'Event-Prioritaet (normal oder low)',
          required: false,
          default: 'normal',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'list_downtimes',
      description: 'Alle geplanten Downtimes auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/downtime',
      parameters: [],
      category: 'Monitoring',
    },
  ],

  buildBaseUrl: (fields) => `https://api.${fields.site}`,

  buildAuthType: () => 'none',

  buildDefaultHeaders: (fields) => ({
    'DD-API-KEY': fields.api_key,
    'DD-APPLICATION-KEY': fields.app_key,
  }),

  buildHealthPath: () => '/api/v1/validate',
};
