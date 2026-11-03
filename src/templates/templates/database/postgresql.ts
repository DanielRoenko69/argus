import type { ServiceTemplate } from '../../serviceTemplates.js';

export const postgresqlTemplate: ServiceTemplate = {
  id: 'postgresql',
  name: 'PostgreSQL Server',
  description: 'PostgreSQL-Datenbank direkt anbinden. Ermoeglicht Abfragen, Schema-Inspektion und Statistiken.',
  icon: '\uD83D\uDC18',
  category: 'database',
  subcategory: 'relational',
  tags: ['postgresql', 'postgres', 'sql', 'database', 'relational'],

  fields: [
    {
      name: 'host',
      label: 'Host',
      type: 'string',
      required: true,
      placeholder: 'localhost',
    },
    {
      name: 'port',
      label: 'Port',
      type: 'number',
      required: true,
      default: '5432',
      placeholder: '5432',
    },
    {
      name: 'database',
      label: 'Datenbank',
      type: 'string',
      required: true,
      placeholder: 'mydb',
    },
    {
      name: 'username',
      label: 'Benutzername',
      type: 'string',
      required: true,
      placeholder: 'postgres',
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
      description: 'Alle Tabellen in der PostgreSQL-Datenbank auflisten',
      backend: 'postgresql',
      queryTemplate: "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name",
      parameters: [],
      category: 'Database',
    },
    {
      nameSuffix: 'describe_table',
      description: 'Spalten und Datentypen einer Tabelle anzeigen',
      backend: 'postgresql',
      queryTemplate: "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '{{table_name}}' ORDER BY ordinal_position",
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
      description: 'Eine beliebige SQL-Abfrage ausführen',
      backend: 'postgresql',
      queryTemplate: '{{sql}}',
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
      nameSuffix: 'table_stats',
      description: 'Statistiken einer Tabelle anzeigen (Zeilenanzahl, Größe)',
      backend: 'postgresql',
      queryTemplate: "SELECT relname AS table_name, n_live_tup AS row_count, pg_size_pretty(pg_total_relation_size(relid)) AS total_size FROM pg_stat_user_tables WHERE relname = '{{table_name}}'",
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
      nameSuffix: 'list_schemas',
      description: 'Alle Schemas in der Datenbank auflisten',
      backend: 'postgresql',
      queryTemplate: "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') ORDER BY schema_name",
      parameters: [],
      category: 'Database',
    },
  ],

  buildBaseUrl: (fields) =>
    `postgresql://${fields.username}:${fields.password}@${fields.host}:${fields.port || '5432'}/${fields.database}`,

  buildAuthType: () => 'none',

  buildHealthPath: () => null as unknown as string,
};
