import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export function registerResources(server: McpServer, config: Config): void {
  // Static resource: server configuration overview
  server.resource(
    'server-config',
    'config://server',
    { description: 'Argus configuration and enabled backends' },
    async () => ({
      contents: [{
        uri: 'config://server',
        mimeType: 'application/json',
        text: JSON.stringify({
          backends: {
            postgresql: config.postgresEnabled,
          },
          limits: {
            rateLimitPerMinute: config.rateLimitPerMinute,
            maxResultRows: config.maxResultRows,
          },
        }, null, 2),
      }],
    })
  );

  // PostgreSQL schema resource (if enabled)
  if (config.postgresEnabled) {
    server.resource(
      'pg-schema',
      'pg://schema',
      { description: 'PostgreSQL database schema: all tables, columns, and types. Use this to understand the database structure before writing queries.' },
      async () => {
        try {
          const pg = await import('pg');
          const client = new pg.default.Client({ connectionString: config.postgresConnectionUrl });
          await client.connect();
          const result = await client.query(`
            SELECT t.table_schema, t.table_name, c.column_name, c.data_type, c.is_nullable
            FROM information_schema.tables t
            JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
            WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY t.table_schema, t.table_name, c.ordinal_position
          `);
          await client.end();

          return {
            contents: [{
              uri: 'pg://schema',
              mimeType: 'application/json',
              text: JSON.stringify(result.rows, null, 2),
            }],
          };
        } catch (err) {
          logger.error({ err }, 'Failed to fetch PG schema resource');
          return { contents: [{ uri: 'pg://schema', mimeType: 'text/plain', text: 'Error fetching schema' }] };
        }
      }
    );
  }

  logger.info('MCP Resources registered');
}
