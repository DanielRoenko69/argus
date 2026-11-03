import type { ServiceTemplate } from '../../serviceTemplates.js';

export const influxdbTemplate: ServiceTemplate = {
  id: 'influxdb',
  name: 'InfluxDB',
  description: 'InfluxDB v2 anbinden für Zeitreihendaten, Metriken und IoT-Daten.',
  icon: '\uD83D\uDCC8',
  category: 'database',
  subcategory: 'timeseries',
  tags: ['influxdb', 'timeseries', 'metrics', 'iot'],
  docsUrl: 'https://docs.influxdata.com/influxdb/v2/api/',

  fields: [
    {
      name: 'base_url',
      label: 'InfluxDB URL',
      type: 'string',
      required: true,
      placeholder: 'https://influxdb.example.com:8086',
    },
    {
      name: 'token',
      label: 'API Token',
      type: 'password',
      required: true,
    },
    {
      name: 'org',
      label: 'Organisation',
      type: 'string',
      required: true,
      placeholder: 'my-org',
    },
  ],

  tools: [
    {
      nameSuffix: 'query',
      description: 'Eine Flux-Abfrage auf InfluxDB ausführen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /api/v2/query\n\n{{flux_query}}',
      parameters: [
        {
          name: 'flux_query',
          type: 'string',
          description: 'Flux-Abfrage',
          required: true,
        },
      ],
      category: 'Database',
    },
    {
      nameSuffix: 'list_buckets',
      description: 'Alle Buckets in der Organisation auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v2/buckets?org={{org}}',
      parameters: [
        {
          name: 'org',
          type: 'string',
          description: 'Name der Organisation',
          required: true,
        },
      ],
      category: 'Database',
    },
    {
      nameSuffix: 'get_health',
      description: 'Gesundheitsstatus der InfluxDB-Instanz abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /health',
      parameters: [],
      category: 'Database',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildHealthPath: () => '/health',

  buildDefaultHeaders: () => ({ 'Content-Type': 'application/vnd.flux' }),
};
