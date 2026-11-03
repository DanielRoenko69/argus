import type { RagAdapterConfig, RagIndex } from './types.js';
import { embedText, resolveRagApiKey, type RagResult } from './ragClient.js';

export interface RagSample {
  id: string;
  content: string;
  path?: string;
}

function baseUrl(index: RagIndex): string {
  return index.endpoint.replace(/\/+$/, '');
}

function config(index: RagIndex): RagAdapterConfig {
  return index.adapter_config ?? {};
}

function readPath(record: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, record);
}

function firstValue(record: Record<string, unknown>, configured: string | undefined, fallbacks: string[]): unknown {
  const selected = readPath(record, configured);
  if (selected !== undefined && selected !== null) return selected;
  for (const key of fallbacks) {
    const value = readPath(record, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function mapRecord(index: RagIndex, record: Record<string, unknown>, fallbackId: string, score: number): RagResult {
  const cfg = config(index);
  const id = stringValue(firstValue(record, cfg.id_field, ['id', '_id', 'uuid'])) || fallbackId;
  const content = stringValue(firstValue(record, cfg.text_field, ['content', 'text', 'chunk', 'body', 'document']));
  const source = stringValue(firstValue(record, cfg.source_field, ['source', 'sourcefile', 'url', 'path', 'title']));
  return { id, score, content: content || JSON.stringify(record), source, metadata: record };
}

async function jsonRequest<T>(provider: string, url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${provider} error ${response.status}: ${detail}`);
  }
  return response.json() as Promise<T>;
}

function authorizationHeaders(index: RagIndex, defaultMode: RagAdapterConfig['auth_mode']): Record<string, string> {
  const secret = resolveRagApiKey(index.api_key);
  if (!secret) return {};
  const mode = config(index).auth_mode ?? defaultMode;
  if (mode === 'basic') return { Authorization: `Basic ${Buffer.from(secret).toString('base64')}` };
  if (mode === 'api_key') return { Authorization: `ApiKey ${secret}` };
  return { Authorization: `Bearer ${secret}` };
}

function searchEngineHeaders(index: RagIndex): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...authorizationHeaders(index, index.provider === 'elasticsearch' ? 'api_key' : 'basic'),
  };
}

type SearchHit = { _id?: string; _score?: number; _source?: Record<string, unknown>; fields?: Record<string, unknown> };
type SearchResponse = { hits?: { hits?: SearchHit[] } };

function mapSearchHits(index: RagIndex, data: SearchResponse): RagResult[] {
  return (data.hits?.hits ?? []).map((hit, position) => {
    const record = { ...(hit._source ?? {}), ...(hit.fields ?? {}) };
    return mapRecord(index, record, hit._id ?? String(position), hit._score ?? 0);
  });
}

export async function searchOpenSearch(index: RagIndex, query: string): Promise<RagResult[]> {
  const vectorField = index.vector_field?.trim();
  if (!vectorField) throw new Error(`OpenSearch source "${index.name}" requires a vector field`);
  const vector = await embedText(query);
  const data = await jsonRequest<SearchResponse>('OpenSearch', `${baseUrl(index)}/${encodeURIComponent(index.index_name)}/_search`, {
    method: 'POST',
    headers: searchEngineHeaders(index),
    body: JSON.stringify({
      size: index.top_k,
      query: { knn: { [vectorField]: { vector, k: index.top_k } } },
    }),
  });
  return mapSearchHits(index, data);
}

export async function searchElasticsearch(index: RagIndex, query: string): Promise<RagResult[]> {
  const vectorField = index.vector_field?.trim();
  if (!vectorField) throw new Error(`Elasticsearch source "${index.name}" requires a vector field`);
  const vector = await embedText(query);
  const data = await jsonRequest<SearchResponse>('Elasticsearch', `${baseUrl(index)}/${encodeURIComponent(index.index_name)}/_search`, {
    method: 'POST',
    headers: searchEngineHeaders(index),
    body: JSON.stringify({
      size: index.top_k,
      knn: {
        field: vectorField,
        query_vector: vector,
        k: index.top_k,
        num_candidates: Math.min(10_000, Math.max(index.top_k * 3, 25)),
      },
    }),
  });
  return mapSearchHits(index, data);
}

function graphqlName(value: string, label: string): string {
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(value)) throw new Error(`${label} must be a valid GraphQL identifier`);
  return value;
}

function weaviateUrl(index: RagIndex): string {
  const base = baseUrl(index);
  return base.endsWith('/v1') ? `${base}/graphql` : `${base}/v1/graphql`;
}

function weaviateFields(index: RagIndex): { collection: string; text: string; source?: string } {
  const cfg = config(index);
  const collection = graphqlName(index.index_name, 'Weaviate collection');
  const text = graphqlName(cfg.text_field ?? 'content', 'Weaviate content field');
  const source = cfg.source_field ? graphqlName(cfg.source_field, 'Weaviate source field') : undefined;
  return { collection, text, ...(source && source !== text ? { source } : {}) };
}

interface WeaviateResponse {
  data?: { Get?: Record<string, Array<Record<string, unknown> & { _additional?: { id?: string; certainty?: number; distance?: number } }>> };
  errors?: Array<{ message?: string }>;
}

async function queryWeaviate(index: RagIndex, operator: string): Promise<RagResult[]> {
  const fields = weaviateFields(index);
  const query = `{ Get { ${fields.collection}(${operator} limit: ${index.top_k}) { ${fields.text}${fields.source ? ` ${fields.source}` : ''} _additional { id certainty distance } } } }`;
  const data = await jsonRequest<WeaviateResponse>('Weaviate', weaviateUrl(index), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authorizationHeaders(index, 'bearer') },
    body: JSON.stringify({ query }),
  });
  if (data.errors?.length) throw new Error(`Weaviate query failed: ${data.errors.map(error => error.message).filter(Boolean).join('; ')}`);
  return (data.data?.Get?.[fields.collection] ?? []).map((item, position) => {
    const additional = item._additional ?? {};
    const record: Record<string, unknown> = { ...item };
    delete record['_additional'];
    const score = additional.certainty ?? (typeof additional.distance === 'number' ? 1 - additional.distance : 0);
    return mapRecord(index, record, additional.id ?? String(position), score);
  });
}

export async function searchWeaviate(index: RagIndex, query: string): Promise<RagResult[]> {
  const vector = await embedText(query);
  return queryWeaviate(index, `nearVector: { vector: ${JSON.stringify(vector)} },`);
}

export async function searchPinecone(index: RagIndex, query: string): Promise<RagResult[]> {
  const vector = await embedText(query);
  const secret = resolveRagApiKey(index.api_key);
  if (!secret) throw new Error(`No API key configured for Pinecone source "${index.name}"`);
  const namespace = config(index).namespace?.trim();
  const data = await jsonRequest<{ matches?: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }> }>(
    'Pinecone',
    `${baseUrl(index)}/query`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': secret, 'X-Pinecone-Api-Version': '2025-04' },
      body: JSON.stringify({ vector, topK: index.top_k, includeMetadata: true, ...(namespace ? { namespace } : {}) }),
    },
  );
  return (data.matches ?? []).map((match, position) => mapRecord(index, match.metadata ?? {}, match.id || String(position), match.score ?? 0));
}

export async function searchMilvus(index: RagIndex, query: string): Promise<RagResult[]> {
  const vectorField = index.vector_field?.trim() || 'vector';
  const vector = await embedText(query);
  const cfg = config(index);
  const outputFields = Array.from(new Set([cfg.id_field ?? 'id', cfg.text_field ?? 'content', cfg.source_field ?? 'source']));
  const data = await jsonRequest<{ code?: number; message?: string; data?: Array<Record<string, unknown> & { id?: string | number; distance?: number; entity?: Record<string, unknown> }> }>(
    'Milvus',
    `${baseUrl(index)}/v2/vectordb/entities/search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authorizationHeaders(index, 'bearer') },
      body: JSON.stringify({ collectionName: index.index_name, data: [vector], annsField: vectorField, limit: index.top_k, outputFields }),
    },
  );
  if (data.code !== undefined && data.code !== 0) throw new Error(`Milvus search failed (${data.code}): ${data.message ?? 'unknown error'}`);
  return (data.data ?? []).map((hit, position) => {
    const record = { ...hit, ...(hit.entity ?? {}) };
    delete record['entity'];
    return mapRecord(index, record, stringValue(hit.id) || String(position), typeof hit.distance === 'number' ? hit.distance : 0);
  });
}

export async function sampleSearchEngine(index: RagIndex, n: number): Promise<RagSample[]> {
  const data = await jsonRequest<SearchResponse>(index.provider, `${baseUrl(index)}/${encodeURIComponent(index.index_name)}/_search`, {
    method: 'POST',
    headers: searchEngineHeaders(index),
    body: JSON.stringify({ size: n, query: { match_all: {} } }),
  });
  return mapSearchHits(index, data).map(result => ({ id: result.id, content: result.content, path: result.source }));
}

export async function sampleWeaviate(index: RagIndex, n: number): Promise<RagSample[]> {
  const results = await queryWeaviate({ ...index, top_k: n }, '');
  return results.map(result => ({ id: result.id, content: result.content, path: result.source }));
}
