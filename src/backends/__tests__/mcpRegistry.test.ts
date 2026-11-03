import {
  diffRemoteToolCatalogs,
  fingerprintRemoteToolCatalog,
  type RegistryToolDescriptor,
} from '../mcpRegistry.js';

const tool = (
  name: string,
  description = `${name} description`,
  inputSchema: Record<string, unknown> = { type: 'object', properties: {} },
): RegistryToolDescriptor => ({ name, description, inputSchema });

describe('MCP registry catalog identity', () => {
  it('produces the same fingerprint regardless of tool and object-key order', () => {
    const left = [
      tool('search', 'Search', {
        required: ['query'],
        properties: { limit: { type: 'number' }, query: { type: 'string' } },
        type: 'object',
      }),
      tool('deploy'),
    ];
    const right = [
      tool('deploy'),
      tool('search', 'Search', {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      }),
    ];

    expect(fingerprintRemoteToolCatalog(right)).toBe(fingerprintRemoteToolCatalog(left));
    expect(fingerprintRemoteToolCatalog(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('detects added, removed and materially changed tools', () => {
    const previous = [
      tool('keep'),
      tool('remove'),
      tool('schema_change', 'Before', { type: 'object' }),
      tool('description_change', 'Before'),
    ];
    const current = [
      tool('added'),
      tool('keep'),
      tool('schema_change', 'Before', { type: 'object', required: ['id'] }),
      tool('description_change', 'After'),
    ];

    expect(diffRemoteToolCatalogs(previous, current)).toEqual({
      added: ['added'],
      removed: ['remove'],
      changed: ['description_change', 'schema_change'],
    });
  });

  it('reports no drift for an unchanged catalog', () => {
    const catalog = [tool('one'), tool('two')];
    expect(diffRemoteToolCatalogs(catalog, catalog)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });
});
