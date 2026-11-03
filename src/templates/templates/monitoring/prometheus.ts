import type { ServiceTemplate } from '../../serviceTemplates.js';

export const prometheusTemplate: ServiceTemplate = {
  id: 'prometheus',
  name: 'Prometheus',
  description: 'Prometheus-Metriken abfragen, Alerts und Targets überwachen.',
  icon: '🔥',
  category: 'monitoring',
  tags: ['prometheus', 'metrics', 'promql', 'monitoring', 'alerts'],
  docsUrl: 'https://prometheus.io/docs/prometheus/latest/querying/api/',

  fields: [
    {
      name: 'base_url',
      label: 'Prometheus URL',
      type: 'string',
      required: true,
      placeholder: 'http://prometheus:9090',
    },
    {
      name: 'auth_type',
      label: 'Authentifizierung',
      type: 'select',
      required: true,
      default: 'none',
      options: ['none', 'bearer', 'basic'],
    },
    {
      name: 'auth_value',
      label: 'Auth-Wert (Token oder user:pass)',
      type: 'password',
      required: false,
      placeholder: 'Bearer-Token oder user:password',
    },
  ],

  tools: [
    {
      nameSuffix: 'query',
      description: 'Eine PromQL-Abfrage zu einem bestimmten Zeitpunkt ausführen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/query?query={{query}}&time={{time}}',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'PromQL-Abfrage',
          required: true,
        },
        {
          name: 'time',
          type: 'string',
          description: 'Zeitpunkt (RFC3339 oder Unix-Timestamp)',
          required: false,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'query_range',
      description: 'Eine PromQL-Abfrage über einen Zeitbereich ausführen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/query_range?query={{query}}&start={{start}}&end={{end}}&step={{step}}',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'PromQL-Abfrage',
          required: true,
        },
        {
          name: 'start',
          type: 'string',
          description: 'Startzeitpunkt (RFC3339 oder Unix-Timestamp)',
          required: true,
        },
        {
          name: 'end',
          type: 'string',
          description: 'Endzeitpunkt (RFC3339 oder Unix-Timestamp)',
          required: true,
        },
        {
          name: 'step',
          type: 'string',
          description: 'Schrittweite (z.B. 15s, 1m, 5m)',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'alerts',
      description: 'Alle aktiven Alerts von Prometheus abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/alerts',
      parameters: [],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'targets',
      description: 'Alle Scrape-Targets und deren Status auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/targets?state={{state}}',
      parameters: [
        {
          name: 'state',
          type: 'string',
          description: 'Target-Status filtern (active, dropped, any)',
          required: false,
          default: 'active',
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'label_values',
      description: 'Alle Werte eines bestimmten Labels abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/label/{{label_name}}/values',
      parameters: [
        {
          name: 'label_name',
          type: 'string',
          description: 'Name des Labels',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: (fields) => fields.auth_type || 'none',

  buildAuthValue: (fields) => fields.auth_value || '',

  buildHealthPath: () => '/api/v1/status/buildinfo',
};
