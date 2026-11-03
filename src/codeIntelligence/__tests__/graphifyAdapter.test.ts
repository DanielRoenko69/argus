import { describe, expect, it, jest } from '@jest/globals';
import { normalizeGraphifyGraph } from '../graphifyAdapter.js';
import { CodeIndexValidationError } from '../store.js';

const commit = '78fbbe4c8b08fc948d2f11fba333581e037b5b78';
const files: Record<string, string> = {
  'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n',
  'test/math.test.js': "import { add } from '../src/math.js';\ntest('add', () => expect(add(1, 2)).toBe(3));\n",
};

function graph() {
  return {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      { id: 'src_math', label: 'math.js', file_type: 'code', source_file: 'src/math.js', source_location: 'L1', _origin: 'ast' },
      { id: 'src_math_add', label: 'add()', file_type: 'code', source_file: 'src/math.js', source_location: 'L1-L3', _origin: 'ast' },
      { id: 'test_math', label: 'math.test.js', file_type: 'code', source_file: 'test/math.test.js', source_location: 'L1', _origin: 'ast' },
      { id: 'external_expect', label: 'expect()', file_type: 'external' },
    ],
    links: [
      { source: 'src_math', target: 'src_math_add', relation: 'contains', confidence: 'EXTRACTED', confidence_score: 1, _origin: 'ast' },
      { source: 'test_math', target: 'src_math', relation: 'imports_from', confidence: 'INFERRED', weight: 0.8, context: 'import' },
      { source: 'test_math', target: 'external_expect', relation: 'calls', confidence: 'AMBIGUOUS' },
    ],
    hyperedges: [],
    built_at_commit: commit,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    repositoryKey: 'argus/argus-dev-sample',
    branchName: 'main',
    commitSha: commit,
    bundleIds: [12],
    parserVersion: '0.9.32',
    readFile: jest.fn(async (path: string) => Buffer.from(files[path] ?? '')),
    ...overrides,
  };
}

describe('Graphify native code intelligence adapter', () => {
  it('normalizes the real Graphify node-link shape into commit-bound files, symbols, edges and documents', async () => {
    const adapterContext = context();
    const result = await normalizeGraphifyGraph(JSON.stringify(graph()), adapterContext);

    expect(result.provider).toBe('graphify');
    expect(result.commitSha).toBe(commit);
    expect(result.bundleIds).toEqual([12]);
    expect(result.parserVersion).toBe('0.9.32');
    expect(result.graphSchemaVersion).toBe('argus-graphify-v3');
    expect(result.files.map(file => file.path)).toEqual(['src/math.js', 'test/math.test.js']);
    expect(result.symbols).toHaveLength(3);
    expect(result.symbols.find(symbol => symbol.key === 'graphify:src_math_add')).toMatchObject({
      kind: 'function', startLine: 1, endLine: 3, signature: 'add()',
    });
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'CONTAINS', provenance: 'extracted', confidence: 1 }),
      expect.objectContaining({ relation: 'IMPORTS_FROM', provenance: 'inferred', confidence: 0.8 }),
      expect.objectContaining({ relation: 'TESTS', provenance: 'inferred', confidence: 0.95 }),
    ]));
    expect(result.documents.some(document => document.chunkKind === 'file')).toBe(true);
    expect(result.documents.find(document => document.symbolKey === 'graphify:src_math')?.content)
      .toContain('file src/math.js#src_math');
    expect(result.documents.find(document => document.symbolKey === 'graphify:src_math_add')?.content)
      .toContain('return a + b');
    expect(result.sourceGraphDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.metadata).toMatchObject({ skippedNodeCount: 1, skippedLinkCount: 1, inferredTestEdgeCount: 1 });
    expect(adapterContext.readFile).toHaveBeenCalledTimes(2);
  });

  it('rejects a graph built from another commit before reading repository files', async () => {
    const adapterContext = context({ commitSha: 'a'.repeat(40) });
    await expect(normalizeGraphifyGraph(JSON.stringify(graph()), adapterContext))
      .rejects.toThrow('does not match requested commit');
    expect(adapterContext.readFile).not.toHaveBeenCalled();
  });

  it('rejects links to node ids absent from the provider graph', async () => {
    const invalid = graph();
    invalid.links[0]!.target = 'missing';
    await expect(normalizeGraphifyGraph(JSON.stringify(invalid), context()))
      .rejects.toThrow('references an unknown node');
  });

  it('rejects unsafe source paths before the repository reader is invoked', async () => {
    const invalid = graph();
    invalid.nodes[0]!.source_file = '../secret.txt';
    const adapterContext = context();
    await expect(normalizeGraphifyGraph(JSON.stringify(invalid), adapterContext))
      .rejects.toBeInstanceOf(CodeIndexValidationError);
    expect(adapterContext.readFile).not.toHaveBeenCalled();
  });

  it('produces the same digest when Graphify changes node and link ordering', async () => {
    const first = graph();
    const second = graph();
    second.nodes.reverse();
    second.links.reverse();

    const [left, right] = await Promise.all([
      normalizeGraphifyGraph(JSON.stringify(first), context()),
      normalizeGraphifyGraph(JSON.stringify(second), context()),
    ]);
    expect(right.sourceGraphDigest).toBe(left.sourceGraphDigest);
  });

  it('deduplicates identical provider links before persistence', async () => {
    const duplicate = graph();
    duplicate.links.push({ ...duplicate.links[0]! });
    const result = await normalizeGraphifyGraph(JSON.stringify(duplicate), context());
    expect(result.edges).toHaveLength(3);
  });

  it('normalizes source-shaped multiline labels without accepting arbitrary control characters', async () => {
    const multiline = graph();
    multiline.nodes[1]!.label = '{\r\n  add,\r\n  subtract\r\n}';
    const result = await normalizeGraphifyGraph(JSON.stringify(multiline), context());
    expect(result.symbols.find(symbol => symbol.key === 'graphify:src_math_add')?.name)
      .toBe('{ add, subtract }');

    const controlled = graph();
    controlled.nodes[1]!.label = 'add\u0000subtract';
    await expect(normalizeGraphifyGraph(JSON.stringify(controlled), context()))
      .rejects.toThrow('contains control characters');
  });

  it('rejects malformed provider output with a bounded validation error', async () => {
    await expect(normalizeGraphifyGraph('{', context())).rejects.toThrow('not valid JSON');
    await expect(normalizeGraphifyGraph(JSON.stringify({ nodes: [], links: [], built_at_commit: commit }), context()))
      .rejects.toThrow('no repository-backed nodes');
  });
});
