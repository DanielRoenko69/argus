import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { searchQdrantRag } from '../ragClient.js';
import type { RagIndex } from '../types.js';

const ORIGINAL_ENV = { ...process.env };

function source(overrides: Partial<RagIndex> = {}): RagIndex {
  return {
    id: 9,
    name: 'qdrant-e2e',
    label: 'Qdrant E2E',
    description: '',
    provider: 'qdrant',
    endpoint: 'http://qdrant:6333',
    index_name: 'argus-knowledge',
    api_key: '$QDRANT_API_KEY',
    semantic_config: null,
    vector_field: null,
    adapter_config: { text_field: 'content', source_field: 'path', id_field: 'id' },
    top_k: 3,
    enabled: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

describe('Qdrant Knowledge adapter', () => {
  it('embeds the query, searches the collection and maps configured payload fields', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test';
    process.env['QDRANT_API_KEY'] = 'qdrant-test-key';
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: 42, score: 0.91, payload: { id: 'doc-42', content: 'Restart the worker', path: 'runbooks/restart.md', team: 'platform' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const results = await searchQdrantRag(source(), 'worker restart');

    expect(results[0]).toMatchObject({ id: '42', score: 0.91, content: 'Restart the worker', source: 'runbooks/restart.md' });
    expect(results[0]?.metadata).toMatchObject({ team: 'platform' });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('http://qdrant:6333/collections/argus-knowledge/points/search');
    expect((init?.headers as Record<string, string>)['api-key']).toBe('qdrant-test-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({ vector: [0.1, 0.2, 0.3], limit: 3, with_payload: true });
  });

  it('surfaces a bounded Qdrant HTTP error without leaking a response body into the result', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test';
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"status":"error"}', { status: 503 }));

    await expect(searchQdrantRag(source({ api_key: null }), 'unavailable')).rejects.toThrow('Qdrant search error 503');
  });
});
