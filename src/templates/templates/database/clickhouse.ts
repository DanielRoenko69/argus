import type { ServiceTemplate } from '../../serviceTemplates.js';

export const clickhouseTemplate: ServiceTemplate = {
  id: 'clickhouse',
  name: 'ClickHouse',
  description: 'ClickHouse-Datenbank über das HTTP-Interface anbinden für analytische Abfragen.',
  icon: '\uD83C\uDFE0',
  category: 'database',
  subcategory: 'analytics',
  tags: ['clickhouse', 'analytics', 'olap', 'columnar'],
  docsUrl: 'https://clickhouse.com/docs/en/interfaces/http',

  fields: [
    {
      name: 'base_url',
      label: 'ClickHouse URL',
      type: 'string',
      required: true,
      placeholder: 'http://clickhouse:8123',
    },
    {
      name: 'username',
      label: 'Benutzername',
      type: 'string',
      required: false,
      placeholder: 'default',
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
      nameSuffix: 'query',
      description: 'Eine SQL-Abfrage auf ClickHouse ausführen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /\n\n{{sql}} FORMAT JSON',
      parameters: [
        {
          name: 'sql',
          type: 'string',
          description: 'SQL-Abfrage',
          required: true,
        },
      ],
      category: 'Database',
    },
    {
      nameSuffix: 'list_tables',
      description: 'Alle Tabellen in ClickHouse auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: "POST /\n\nSELECT database, name, engine, total_rows FROM system.tables WHERE database NOT IN ('system', 'information_schema') FORMAT JSON",
      parameters: [],
      category: 'Database',
    },
    {
      nameSuffix: 'get_stats',
      description: 'Tabellenstatistiken (Größe, Zeilenanzahl) abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /\n\nSELECT database, name, formatReadableSize(total_bytes) as size, total_rows FROM system.tables ORDER BY total_bytes DESC LIMIT {{limit}} FORMAT JSON',
      parameters: [
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '20',
        },
      ],
      category: 'Database',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: (fields) => (fields.username ? 'basic' : 'none'),

  buildAuthValue: (fields) =>
    fields.username ? `${fields.username}:${fields.password}` : '',

  buildHealthPath: () => '/ping',
};
