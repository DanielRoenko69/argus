import type { ServiceTemplate } from '../../serviceTemplates.js';

export const elasticsearchTemplate: ServiceTemplate = {
  id: 'elasticsearch',
  name: 'Elasticsearch',
  description: 'Elasticsearch-Cluster anbinden für Suche, Index-Verwaltung und Monitoring.',
  icon: '\uD83D\uDD0D',
  category: 'database',
  subcategory: 'search',
  tags: ['elasticsearch', 'elastic', 'search', 'opensearch', 'logging'],
  docsUrl: 'https://www.elastic.co/docs/api',

  fields: [
    {
      name: 'base_url',
      label: 'Elasticsearch URL',
      type: 'string',
      required: true,
      placeholder: 'https://elasticsearch.example.com:9200',
    },
    {
      name: 'username',
      label: 'Benutzername',
      type: 'string',
      required: false,
      placeholder: 'elastic',
    },
    {
      name: 'password',
      label: 'Passwort',
      type: 'password',
      required: false,
    },
  ],

  tools: [
    {
      nameSuffix: 'search',
      description: 'Eine Suchabfrage auf einem Elasticsearch-Index ausführen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /{{index}}/_search\n\n{{query_json}}',
      parameters: [
        {
          name: 'index',
          type: 'string',
          description: 'Name des Index',
          required: true,
        },
        {
          name: 'query_json',
          type: 'string',
          description: 'Elasticsearch Query DSL als JSON',
          required: true,
        },
      ],
      category: 'Database',
    },
    {
      nameSuffix: 'get_indices',
      description: 'Alle Indices im Cluster auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /_cat/indices?format=json',
      parameters: [],
      category: 'Database',
    },
    {
      nameSuffix: 'get_cluster_health',
      description: 'Cluster-Gesundheitsstatus abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /_cluster/health',
      parameters: [],
      category: 'Database',
    },
    {
      nameSuffix: 'get_mapping',
      description: 'Mapping (Schema) eines Index abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /{{index}}/_mapping',
      parameters: [
        {
          name: 'index',
          type: 'string',
          description: 'Name des Index',
          required: true,
        },
      ],
      category: 'Database',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: (fields) => (fields.username ? 'basic' : 'none'),

  buildAuthValue: (fields) =>
    fields.username ? `${fields.username}:${fields.password}` : '',

  buildHealthPath: () => '/_cluster/health',
};
