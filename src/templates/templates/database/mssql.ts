import type { ServiceTemplate } from '../../serviceTemplates.js';

export const mssqlTemplate: ServiceTemplate = {
  id: 'mssql',
  name: 'Microsoft SQL Server',
  description: 'Microsoft SQL Server über einen REST-Proxy anbinden.',
  icon: '\uD83C\uDFE2',
  category: 'database',
  subcategory: 'relational',
  tags: ['mssql', 'sqlserver', 'microsoft', 'sql', 'relational'],

  fields: [
    {
      name: 'base_url',
      label: 'REST-Proxy URL',
      type: 'string',
      required: true,
      placeholder: 'https://mssql-proxy.example.com',
    },
    {
      name: 'username',
      label: 'Benutzername',
      type: 'string',
      required: true,
    },
    {
      name: 'password',
      label: 'Passwort',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_tables',
      description: 'Alle Tabellen im SQL Server auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /tables',
      parameters: [],
      category: 'Database',
    },
    {
      nameSuffix: 'execute_query',
      description: 'Eine SQL-Abfrage auf dem SQL Server ausführen',
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

  buildAuthType: () => 'basic',

  buildAuthValue: (fields) => `${fields.username}:${fields.password}`,

  buildHealthPath: () => '/health',
};
