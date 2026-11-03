import type { ServiceTemplate } from '../../serviceTemplates.js';

export const mysqlTemplate: ServiceTemplate = {
  id: 'mysql',
  name: 'MySQL',
  description: 'MySQL-Datenbank über einen REST-Proxy anbinden.',
  icon: '\uD83D\uDC2C',
  category: 'database',
  subcategory: 'relational',
  tags: ['mysql', 'sql', 'database', 'relational', 'mariadb'],
  docsUrl: 'https://dev.mysql.com/doc/refman/8.0/en/',

  fields: [
    {
      name: 'base_url',
      label: 'REST-Proxy URL',
      type: 'string',
      required: true,
      placeholder: 'https://mysql-proxy.example.com',
    },
    {
      name: 'auth_type',
      label: 'Auth-Typ',
      type: 'select',
      required: true,
      default: 'none',
      options: ['none', 'bearer', 'basic'],
    },
    {
      name: 'auth_value',
      label: 'Auth-Wert',
      type: 'password',
      required: false,
      placeholder: 'Token oder user:password',
    },
  ],

  tools: [
    {
      nameSuffix: 'list_tables',
      description: 'Alle Tabellen in der MySQL-Datenbank auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /tables',
      parameters: [],
      category: 'Database',
    },
    {
      nameSuffix: 'describe_table',
      description: 'Spalten und Datentypen einer MySQL-Tabelle anzeigen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /tables/{{table_name}}/columns',
      parameters: [
        {
          name: 'table_name',
          type: 'string',
          description: 'Name der Tabelle',
          required: true,
        },
      ],
      category: 'Database',
    },
    {
      nameSuffix: 'execute_query',
      description: 'Eine SQL-Abfrage auf der MySQL-Datenbank ausführen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /query\n\n{{sql}}',
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
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: (fields) => fields.auth_type || 'none',

  buildAuthValue: (fields) => fields.auth_value || '',
};
