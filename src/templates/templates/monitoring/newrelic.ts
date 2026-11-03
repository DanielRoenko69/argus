import type { ServiceTemplate } from '../../serviceTemplates.js';

export const newrelicTemplate: ServiceTemplate = {
  id: 'newrelic',
  name: 'New Relic',
  description: 'New Relic NRQL-Abfragen ausführen, Applikationen und Alert-Violations abrufen.',
  icon: '🟢',
  category: 'monitoring',
  tags: ['newrelic', 'apm', 'monitoring', 'observability'],
  docsUrl: 'https://docs.newrelic.com/docs/apis/',

  fields: [
    {
      name: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
    },
    {
      name: 'account_id',
      label: 'Account ID',
      type: 'string',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'run_nrql',
      description: 'Eine NRQL-Abfrage über die GraphQL-API ausführen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /graphql\n\n{"query": "{ actor { account(id: {{account_id}}) { nrql(query: \\"{{nrql}}\\") { results } } } }"}',
      parameters: [
        {
          name: 'account_id',
          type: 'string',
          description: 'New Relic Account-ID',
          required: true,
        },
        {
          name: 'nrql',
          type: 'string',
          description: 'NRQL-Abfrage',
          required: true,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'list_applications',
      description: 'Applikationen nach Name filtern und auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v2/applications.json?filter[name]={{filter}}',
      parameters: [
        {
          name: 'filter',
          type: 'string',
          description: 'Namensfilter für Applikationen',
          required: false,
        },
      ],
      category: 'Monitoring',
    },
    {
      nameSuffix: 'get_alerts',
      description: 'Aktuelle Alert-Violations abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v2/alerts_violations.json?only_open={{only_open}}',
      parameters: [
        {
          name: 'only_open',
          type: 'boolean',
          description: 'Nur offene Violations anzeigen',
          required: false,
          default: 'true',
        },
      ],
      category: 'Monitoring',
    },
  ],

  buildBaseUrl: () => 'https://api.newrelic.com',

  buildAuthType: () => 'header',

  buildAuthValue: (fields) => `Api-Key:${fields.api_key}`,

  buildHealthPath: () => '/v2/applications.json?page=1&per_page=1',
};
