import { afterEach, describe, expect, it, jest } from '@jest/globals';

const embedText = jest.fn(async () => [0.1, 0.2, 0.3]);
jest.mock('../ragClient.js', () => ({
  embedText,
  resolveRagApiKey: (raw: string | null) => raw ?? '',
}));

import {
  searchElasticsearch,
  searchMilvus,
  searchOpenSearch,
  searchPinecone,
  searchWeaviate,
} from '../ragExternalProviders.js';
import type { RagIndex } from '../types.js';

function source(provider: string, overrides: Partial<RagIndex> = {}): RagIndex {
  return {
    id: 7,
    name: `${provider}-source`,
    label: provider,
    description: '',
    provider,
    endpoint: `https://${provider}.example.com`,
    index_name: 'knowledge',
    api_key: 'secret',
    semantic_config: null,
    vector_field: 'embedding',
    adapter_config: { text_field: 'body', source_field: 'path', id_field: 'doc_id' },
    top_k: 4,
    enabled: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function mockJson(body: unknown): jest.SpiedFunction<typeof fetch> {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

afterEach(() => {
  jest.restoreAllMocks();
  embedText.mockClear();
});

describe('external Knowledge provider adapters', () => {
  it('uses the OpenSearch k-NN query shape and maps configured fields', async () => {
    const fetchMock = mockJson({ hits: { hits: [{ _id: 'fallback', _score: 0.87, _source: { doc_id: 'doc-1', body: 'Runbook text', path: '/runbooks/one' } }] } });
    const results = await searchOpenSearch(source('opensearch', { adapter_config: { text_field: 'body', source_field: 'path', id_field: 'doc_id', auth_mode: 'basic' } }), 'restart');
    expect(results[0]).toMatchObject({ id: 'doc-1', score: 0.87, content: 'Runbook text', source: '/runbooks/one' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://opensearch.example.com/knowledge/_search');
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: { knn: { embedding: { vector: [0.1, 0.2, 0.3], k: 4 } } } });
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('secret').toString('base64')}`);
  });

  it('uses Elasticsearch top-level kNN with an API-key credential', async () => {
    const fetchMock = mockJson({ hits: { hits: [] } });
    await searchElasticsearch(source('elasticsearch', { adapter_config: { auth_mode: 'api_key' } }), 'deploy');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ knn: { field: 'embedding', query_vector: [0.1, 0.2, 0.3], k: 4, num_candidates: 25 } });
    expect((init?.headers as Record<string, string>).Authorization).toBe('ApiKey secret');
  });

  it('queries Weaviate through nearVector and reads GraphQL metadata', async () => {
    const fetchMock = mockJson({ data: { Get: { Knowledge: [{ body: 'Architecture decision', path: 'adr-1.md', _additional: { id: 'uuid-1', certainty: 0.93 } }] } } });
    const results = await searchWeaviate(source('weaviate', { index_name: 'Knowledge', adapter_config: { text_field: 'body', source_field: 'path' } }), 'architecture');
    expect(results[0]).toMatchObject({ id: 'uuid-1', score: 0.93, content: 'Architecture decision', source: 'adr-1.md' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://weaviate.example.com/v1/graphql');
    expect(JSON.parse(String(init?.body)).query).toContain('nearVector: { vector: [0.1,0.2,0.3] }');
  });

  it('queries Pinecone at the index host with metadata and namespace', async () => {
    const fetchMock = mockJson({ matches: [{ id: 'vec-1', score: 0.81, metadata: { body: 'Policy text', path: 'policy.md' } }] });
    const results = await searchPinecone(source('pinecone', { index_name: '', adapter_config: { text_field: 'body', source_field: 'path', namespace: 'prod' } }), 'policy');
    expect(results[0]).toMatchObject({ id: 'vec-1', score: 0.81, content: 'Policy text', source: 'policy.md' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://pinecone.example.com/query');
    expect(JSON.parse(String(init?.body))).toMatchObject({ vector: [0.1, 0.2, 0.3], topK: 4, namespace: 'prod', includeMetadata: true });
    expect((init?.headers as Record<string, string>)['Api-Key']).toBe('secret');
  });

  it('uses the Milvus REST v2 search contract and maps returned entities', async () => {
    const fetchMock = mockJson({ code: 0, data: [{ id: 42, distance: 0.76, entity: { body: 'Cluster guide', path: 'cluster.md' } }] });
    const results = await searchMilvus(source('milvus'), 'cluster');
    expect(results[0]).toMatchObject({ id: '42', score: 0.76, content: 'Cluster guide', source: 'cluster.md' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://milvus.example.com/v2/vectordb/entities/search');
    expect(JSON.parse(String(init?.body))).toMatchObject({ collectionName: 'knowledge', data: [[0.1, 0.2, 0.3]], annsField: 'embedding', limit: 4 });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });
});
