// Import only the pure functions — avoids pulling in MCP SDK server.tool()
// which causes TS2589 (type instantiation too deep) in ts-jest
import {
  assertSingleSqlStatement,
  executePg,
  renderSqlTemplate,
  renderTemplate,
} from '../tools/dynamic/index.js';
import type { ToolParameter } from '../tools/dynamic/index.js';
import type pg from 'pg';

const strParam = (name: string, def?: string): ToolParameter => ({
  name, type: 'string', description: name, required: !def, default: def,
});
const numParam = (name: string, def?: string): ToolParameter => ({
  name, type: 'number', description: name, required: !def, default: def,
});

describe('renderSqlTemplate — SQL injection prevention', () => {
  test('replaces single placeholder with $1', () => {
    const { sql, values } = renderSqlTemplate(
      'SELECT * FROM pods WHERE namespace = {{ns}}',
      { ns: 'default' },
      [strParam('ns')],
    );
    expect(sql).toBe('SELECT * FROM pods WHERE namespace = $1');
    expect(values).toEqual(['default']);
  });

  test('replaces multiple placeholders in order', () => {
    const { sql, values } = renderSqlTemplate(
      'SELECT * FROM logs WHERE app = {{app}} AND level = {{level}} LIMIT {{limit}}',
      { app: 'argus', level: 'error', limit: 100 },
      [strParam('app'), strParam('level'), numParam('limit')],
    );
    expect(sql).toBe('SELECT * FROM logs WHERE app = $1 AND level = $2 LIMIT $3');
    expect(values).toEqual(['argus', 'error', 100]);
  });

  test('SQL injection attempt stays in values, never in SQL string', () => {
    const malicious = "'; DROP TABLE pods; --";
    const { sql, values } = renderSqlTemplate(
      'SELECT * FROM pods WHERE name = {{name}}',
      { name: malicious },
      [strParam('name')],
    );
    expect(sql).toBe('SELECT * FROM pods WHERE name = $1');
    expect(sql).not.toContain('DROP');
    expect(values[0]).toBe(malicious);
  });

  test('uses default value when param not provided', () => {
    const { sql, values } = renderSqlTemplate(
      'SELECT * FROM logs LIMIT {{limit}}',
      {},
      [numParam('limit', '50')],
    );
    expect(sql).toBe('SELECT * FROM logs LIMIT $1');
    expect(values).toEqual(['50']);
  });

  test('uses null when no value and no default', () => {
    const { sql, values } = renderSqlTemplate(
      'SELECT * FROM pods WHERE label = {{label}}',
      {},
      [strParam('label')],
    );
    expect(values[0]).toBeNull();
  });

  test('handles repeated placeholders correctly', () => {
    // Same placeholder used twice — both get separate $N
    const { sql, values } = renderSqlTemplate(
      'SELECT {{col}} FROM t WHERE {{col}} IS NOT NULL',
      { col: 'name' },
      [strParam('col')],
    );
    expect(sql).toBe('SELECT $1 FROM t WHERE $1 IS NOT NULL');
    expect(values).toEqual(['name']);
  });
});

describe('executePg — single-statement guard', () => {
  test.each([
    'SELECT 1',
    'SELECT 1;',
    'SELECT 1; -- one optional trailing terminator',
    'SELECT 1 /* ; inside a comment */;',
    "SELECT 'semi;colon and ''quoted;value''' AS value;",
    'SELECT "semi;colon" FROM "quoted;table";',
    "SELECT E'escaped\\';still-string' AS value;",
    'SELECT $$dollar;quoted$$ AS value;',
    'SELECT $body$begin; perform work(); end$body$ AS value;',
    'SELECT 1 /* outer ; /* nested ; */ still outer ; */;',
  ])('accepts one statement: %s', (sql) => {
    expect(() => assertSingleSqlStatement(sql)).not.toThrow();
  });

  test.each([
    'SELECT 1; SELECT 2',
    'SELECT 1;;',
    'SELECT 1; /* harmless comment */ DROP TABLE dynamic_tools',
    "SELECT 'value;inside'; -- comment ;\nSELECT 2",
    'SELECT $$body;inside$$; DELETE FROM dynamic_tools',
    'SELECT foo$tag$bar; DROP TABLE dynamic_tools',
  ])('rejects multiple statements: %s', (sql) => {
    expect(() => assertSingleSqlStatement(sql)).toThrow(/exactly one SQL statement/i);
  });

  test('rejects before acquiring a database connection', async () => {
    const connect = jest.fn();
    const pool = { connect } as unknown as pg.Pool;

    await expect(executePg(pool, 'SELECT 1; DROP TABLE dynamic_tools'))
      .rejects.toThrow(/exactly one SQL statement/i);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('renderTemplate — HTTP URL encoding', () => {
  test('URL-encodes parameter values', () => {
    const result = renderTemplate(
      'GET /api/search?q={{query}}',
      { query: 'hello world' },
      [strParam('query')],
    );
    expect(result).toBe('GET /api/search?q=hello%20world');
  });

  test('encodes special characters', () => {
    const result = renderTemplate(
      '/api/ns/{{ns}}/pods',
      { ns: 'my-ns/test' },
      [strParam('ns')],
    );
    expect(result).toContain('%2F');
    expect(result).not.toContain('my-ns/test');
  });
});
