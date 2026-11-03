import type { ServiceTemplate } from '../../serviceTemplates.js';

export const signozTemplate: ServiceTemplate = {
  id: 'signoz',
  name: 'SigNoz',
  description: 'SigNoz-Services, Traces und Metriken über die API abfragen.',
  icon: '📡',
  category: 'monitoring',
  tags: ['signoz', 'observability', 'traces', 'metrics', 'logs', 'opentelemetry'],
  docsUrl: 'https://signoz.io/docs/',

  fields: [
    {
      name: 'base_url',
      label: 'SigNoz URL',
      type: 'string',
      required: true,
      placeholder: 'http://signoz:3301',
    },
    {
      name: 'auth_token',
      label: 'Auth-Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_services',
      description: 'Alle überwachten Services auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/services?start={{start}}&end={{end}}',
      parameters: [
        {
          name: 'start',
          type: 'string',
          description: 'Startzeitpunkt (Unix-Nanosekunden)',
          required: true,
        },
        {
          name: 'end',
          type: 'string',
          description: 'Endzeitpunkt (Unix-Nanosekunden)',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'get_service_overview',
      description: 'Übersicht eines Services mit Latenz, Fehlerrate und Durchsatz abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/service/overview?service={{service}}&start={{start}}&end={{end}}&step={{step}}',
      parameters: [
        {
          name: 'service',
          type: 'string',
          description: 'Name des Services',
          required: true,
        },
        {
          name: 'start',
          type: 'string',
          description: 'Startzeitpunkt (Unix-Nanosekunden)',
          required: true,
        },
        {
          name: 'end',
          type: 'string',
          description: 'Endzeitpunkt (Unix-Nanosekunden)',
          required: true,
        },
        {
          name: 'step',
          type: 'string',
          description: 'Schrittweite in Sekunden',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'query_traces',
      description: 'Traces eines Services nach Operation und Zeitraum abfragen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/traces?service={{service}}&operation={{operation}}&start={{start}}&end={{end}}&limit={{limit}}',
      parameters: [
        {
          name: 'service',
          type: 'string',
          description: 'Name des Services',
          required: true,
        },
        {
          name: 'operation',
          type: 'string',
          description: 'Name der Operation',
          required: false,
        },
        {
          name: 'start',
          type: 'string',
          description: 'Startzeitpunkt (Unix-Nanosekunden)',
          required: true,
        },
        {
          name: 'end',
          type: 'string',
          description: 'Endzeitpunkt (Unix-Nanosekunden)',
          required: true,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Traces',
          required: false,
          default: '20',
        },
      ],
      category: 'Monitoring',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.auth_token,

  buildHealthPath: () => '/api/v1/health',
};
