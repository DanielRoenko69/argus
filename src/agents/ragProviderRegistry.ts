import type pg from 'pg';
import type { RagIndex } from './types.js';
import { searchAzureAISearch, searchQdrantRag, resolveRagApiKey, type RagResult } from './ragClient.js';
import { searchPgvectorRag } from './kb/searchPgvector.js';
import {
  sampleSearchEngine,
  sampleWeaviate,
  searchElasticsearch,
  searchMilvus,
  searchOpenSearch,
  searchPinecone,
  searchWeaviate,
  type RagSample,
} from './ragExternalProviders.js';

export type RagProviderId =
  | 'pgvector'
  | 'qdrant'
  | 'azure_ai_search'
  | 'opensearch'
  | 'elasticsearch'
  | 'weaviate'
  | 'pinecone'
  | 'milvus';

export interface RagProviderField {
  key: 'endpoint' | 'index_name' | 'semantic_config' | 'vector_field' | `adapter_config.${string}`;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  input?: 'text' | 'url' | 'select';
  default_value?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface RagProviderDefinition {
  id: RagProviderId;
  label: string;
  description: string;
  kind: 'built_in' | 'external';
  target_label: string;
  credential: { mode: 'none' | 'optional' | 'required'; label: string; placeholder: string };
  capabilities: { ingest: boolean; evaluation: boolean };
  fields: RagProviderField[];
}

interface RagProviderAdapter {
  definition: RagProviderDefinition;
  search: (index: RagIndex, query: string, pool?: pg.Pool, signal?: AbortSignal) => Promise<RagResult[]>;
  sample?: (index: RagIndex, n: number, pool?: pg.Pool) => Promise<RagSample[]>;
}

const endpoint = (placeholder: string): RagProviderField => ({
  key: 'endpoint', label: 'Endpoint', input: 'url', required: true, placeholder,
});
const target = (label: string, placeholder: string, required = true): RagProviderField => ({
  key: 'index_name', label, input: 'text', required, placeholder,
});
const vectorField = (placeholder = 'embedding'): RagProviderField => ({
  key: 'vector_field', label: 'Vector field', input: 'text', required: true, placeholder,
  description: 'Must match the dimensions produced by the configured Argus embedding model.',
});
const contentFields: RagProviderField[] = [
  { key: 'adapter_config.text_field', label: 'Content field', input: 'text', default_value: 'content', placeholder: 'content', required: true },
  { key: 'adapter_config.source_field', label: 'Source field', input: 'text', default_value: 'source', placeholder: 'source' },
  { key: 'adapter_config.id_field', label: 'ID field', input: 'text', default_value: 'id', placeholder: 'id' },
];
const authField = (defaultValue: 'api_key' | 'basic' | 'bearer'): RagProviderField => ({
  key: 'adapter_config.auth_mode', label: 'Authentication', input: 'select', default_value: defaultValue,
  options: [
    { value: 'api_key', label: 'API key' },
    { value: 'basic', label: 'Basic (username:password)' },
    { value: 'bearer', label: 'Bearer token' },
  ],
});

async function samplePgvector(index: RagIndex, n: number, pool?: pg.Pool): Promise<RagSample[]> {
  if (!pool) throw new Error(`pgvector source '${index.name}' requires a database connection`);
  const { rows } = await pool.query<{ id: number | string; content: string; path: string }>(
    `SELECT c.id, c.content, d.name AS path
       FROM mcp_kb_chunks c
       JOIN mcp_kb_documents d ON d.id = c.document_id
      WHERE c.rag_index_id = $1
      ORDER BY random()
      LIMIT $2`,
    [index.id, n],
  );
  if (rows.length === 0) throw new Error(`Knowledge source '${index.label}' has no indexed chunks`);
  return rows.map(row => ({ id: String(row.id), content: row.content, path: row.path }));
}

async function sampleQdrant(index: RagIndex, n: number): Promise<RagSample[]> {
  const apiKey = resolveRagApiKey(index.api_key);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['api-key'] = apiKey;
  const response = await fetch(
    `${index.endpoint.replace(/\/+$/, '')}/collections/${encodeURIComponent(index.index_name)}/points/scroll`,
    { method: 'POST', headers, body: JSON.stringify({ limit: n, with_payload: true, with_vector: false }) },
  );
  if (!response.ok) throw new Error(`Qdrant sample fetch failed: ${response.status} ${await response.text().catch(() => '')}`);
  const data = await response.json() as { result?: { points?: Array<{ id: string | number; payload?: Record<string, unknown> }> } };
  const points = data.result?.points ?? [];
  if (points.length === 0) throw new Error(`Qdrant collection '${index.index_name}' has no points`);
  const cfg = index.adapter_config ?? {};
  return points.map(point => ({
    id: String(point.id),
    content: String(point.payload?.[cfg.text_field ?? 'text'] ?? point.payload?.['text'] ?? point.payload?.['content'] ?? point.payload?.['body'] ?? ''),
    path: String(point.payload?.[cfg.source_field ?? 'source'] ?? point.payload?.['url'] ?? point.payload?.['title'] ?? ''),
  }));
}

async function sampleAzure(index: RagIndex, n: number): Promise<RagSample[]> {
  const apiKey = resolveRagApiKey(index.api_key);
  if (!apiKey) throw new Error(`No API key configured for Azure AI Search source "${index.name}"`);
  const headers = { 'api-key': apiKey, 'Content-Type': 'application/json' };
  const base = index.endpoint.replace(/\/+$/, '');
  const apiVersion = '2023-11-01';
  const countResponse = await fetch(`${base}/indexes/${encodeURIComponent(index.index_name)}/docs/$count?api-version=${apiVersion}`, { headers });
  const total = Number.parseInt(await countResponse.text(), 10);
  if (!countResponse.ok || !Number.isFinite(total) || total === 0) throw new Error(`Azure index '${index.index_name}' is empty or count failed`);
  const skip = Math.floor(Math.random() * Math.max(1, total - n + 1));
  const response = await fetch(`${base}/indexes/${encodeURIComponent(index.index_name)}/docs?api-version=${apiVersion}&$top=${n}&$skip=${skip}&$select=*`, { headers });
  if (!response.ok) throw new Error(`Azure Search sample fetch failed: ${response.status} ${await response.text().catch(() => '')}`);
  const data = await response.json() as { value?: Record<string, unknown>[] };
  const cfg = index.adapter_config ?? {};
  return (data.value ?? []).map((record, position) => ({
    id: String(record[cfg.id_field ?? 'id'] ?? record['chunk_id'] ?? position),
    content: String(record[cfg.text_field ?? 'content'] ?? record['chunk'] ?? record['text'] ?? record['body'] ?? ''),
    path: String(record[cfg.source_field ?? 'source'] ?? record['sourcefile'] ?? record['url'] ?? record['title'] ?? ''),
  }));
}

const adapters: RagProviderAdapter[] = [
  {
    definition: {
      id: 'pgvector', label: 'Built-in Knowledge', kind: 'built_in', target_label: 'Argus-managed corpus',
      description: 'PostgreSQL + pgvector, managed completely by Argus.',
      credential: { mode: 'none', label: '', placeholder: '' },
      capabilities: { ingest: true, evaluation: true }, fields: [],
    },
    search: (index, query, pool, signal) => {
      if (!pool) throw new Error(`pgvector source "${index.name}" requires a DB pool`);
      return searchPgvectorRag(index, query, pool, signal);
    },
    sample: samplePgvector,
  },
  {
    definition: {
      id: 'qdrant', label: 'Qdrant', kind: 'external', target_label: 'Collection',
      description: 'Connect a self-hosted or managed Qdrant collection.',
      credential: { mode: 'optional', label: 'Qdrant API key', placeholder: '$QDRANT_API_KEY or raw key' },
      capabilities: { ingest: false, evaluation: true },
      fields: [endpoint('http://qdrant:6333'), target('Collection', 'argus-knowledge'), ...contentFields],
    },
    search: (index, query, _pool, signal) => searchQdrantRag(index, query, signal),
    sample: sampleQdrant,
  },
  {
    definition: {
      id: 'azure_ai_search', label: 'Azure AI Search', kind: 'external', target_label: 'Index',
      description: 'Hybrid or semantic retrieval from an Azure AI Search index.',
      credential: { mode: 'required', label: 'Azure admin/query key', placeholder: '$AZURE_SEARCH_API_KEY or raw key' },
      capabilities: { ingest: false, evaluation: true },
      fields: [
        endpoint('https://service.search.windows.net'), target('Index name', 'engineering-docs'),
        { key: 'semantic_config', label: 'Semantic configuration', placeholder: 'default-semantic' },
        { ...vectorField('contentVector'), required: false }, ...contentFields,
      ],
    },
    search: (index, query, _pool, signal) => searchAzureAISearch(index, query, signal),
    sample: sampleAzure,
  },
  {
    definition: {
      id: 'opensearch', label: 'OpenSearch', kind: 'external', target_label: 'Index',
      description: 'Native k-NN retrieval from OpenSearch, including self-hosted clusters.',
      credential: { mode: 'optional', label: 'OpenSearch credential', placeholder: '$OPENSEARCH_AUTH or username:password' },
      capabilities: { ingest: false, evaluation: true },
      fields: [endpoint('https://opensearch.example.com'), target('Index name', 'knowledge'), vectorField(), ...contentFields, authField('basic')],
    },
    search: (index, query) => searchOpenSearch(index, query), sample: sampleSearchEngine,
  },
  {
    definition: {
      id: 'elasticsearch', label: 'Elasticsearch', kind: 'external', target_label: 'Index',
      description: 'Native Elasticsearch kNN retrieval using the Search API.',
      credential: { mode: 'optional', label: 'Elasticsearch credential', placeholder: '$ELASTIC_API_KEY or raw key' },
      capabilities: { ingest: false, evaluation: true },
      fields: [endpoint('https://elasticsearch.example.com'), target('Index name', 'knowledge'), vectorField(), ...contentFields, authField('api_key')],
    },
    search: (index, query) => searchElasticsearch(index, query), sample: sampleSearchEngine,
  },
  {
    definition: {
      id: 'weaviate', label: 'Weaviate', kind: 'external', target_label: 'Collection',
      description: 'GraphQL nearVector retrieval from a Weaviate collection.',
      credential: { mode: 'optional', label: 'Weaviate API key', placeholder: '$WEAVIATE_API_KEY or raw key' },
      capabilities: { ingest: false, evaluation: true },
      fields: [endpoint('http://weaviate:8080'), target('Collection', 'KnowledgeChunk'), ...contentFields],
    },
    search: (index, query) => searchWeaviate(index, query), sample: sampleWeaviate,
  },
  {
    definition: {
      id: 'pinecone', label: 'Pinecone', kind: 'external', target_label: 'Namespace',
      description: 'Query a Pinecone index host with optional namespace isolation.',
      credential: { mode: 'required', label: 'Pinecone API key', placeholder: '$PINECONE_API_KEY or raw key' },
      capabilities: { ingest: false, evaluation: false },
      fields: [endpoint('https://your-index.svc.region.pinecone.io'), target('Namespace', 'production', false), ...contentFields],
    },
    search: (index, query) => searchPinecone({ ...index, adapter_config: { ...(index.adapter_config ?? {}), namespace: index.adapter_config?.namespace ?? index.index_name } }, query),
  },
  {
    definition: {
      id: 'milvus', label: 'Milvus / Zilliz', kind: 'external', target_label: 'Collection',
      description: 'Milvus REST v2 retrieval for self-hosted Milvus and Zilliz Cloud.',
      credential: { mode: 'optional', label: 'Milvus token', placeholder: '$MILVUS_TOKEN, API key or username:password' },
      capabilities: { ingest: false, evaluation: false },
      fields: [endpoint('http://milvus:19530'), target('Collection', 'knowledge'), { ...vectorField('vector'), default_value: 'vector' }, ...contentFields],
    },
    search: (index, query) => searchMilvus(index, query),
  },
];

const registry = new Map<RagProviderId, RagProviderAdapter>(adapters.map(adapter => [adapter.definition.id, adapter]));

export function listRagProviderDefinitions(): RagProviderDefinition[] {
  return adapters.map(adapter => adapter.definition);
}

export function getRagProviderDefinition(provider: string): RagProviderDefinition | null {
  return registry.get(provider as RagProviderId)?.definition ?? null;
}

export function validateRagProviderInput(provider: string, input: Record<string, unknown>): string | null {
  const definition = getRagProviderDefinition(provider);
  if (!definition) return `Unsupported knowledge provider "${provider}"`;
  const adapterConfig = input['adapter_config'];
  if (adapterConfig !== undefined && (!adapterConfig || typeof adapterConfig !== 'object' || Array.isArray(adapterConfig))) {
    return 'adapter_config must be an object';
  }
  const configRecord = (adapterConfig ?? {}) as Record<string, unknown>;
  for (const field of definition.fields) {
    if (!field.required) continue;
    const configuredValue = field.key.startsWith('adapter_config.')
      ? configRecord[field.key.slice('adapter_config.'.length)]
      : input[field.key];
    const value = configuredValue ?? field.default_value;
    if (typeof value !== 'string' || !value.trim()) return `${field.label} is required for ${definition.label}`;
  }
  const topK = input['top_k'];
  if (topK !== undefined && (typeof topK !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > 50)) return 'top_k must be an integer between 1 and 50';
  if (definition.credential.mode === 'required' && (typeof input['api_key'] !== 'string' || !input['api_key'])) {
    return `${definition.credential.label} is required for ${definition.label}`;
  }
  return null;
}

export async function searchRagProvider(
  index: RagIndex,
  query: string,
  pool?: pg.Pool,
  signal?: AbortSignal,
): Promise<RagResult[]> {
  const adapter = registry.get(index.provider as RagProviderId);
  if (!adapter) throw new Error(`Unsupported RAG provider "${index.provider}" for knowledge source "${index.name}"`);
  return adapter.search(index, query, pool, signal);
}

export async function sampleRagProvider(index: RagIndex, n: number, pool?: pg.Pool): Promise<RagSample[]> {
  const adapter = registry.get(index.provider as RagProviderId);
  if (!adapter) throw new Error(`Unsupported RAG provider "${index.provider}" for knowledge source "${index.name}"`);
  if (!adapter.sample) throw new Error(`${adapter.definition.label} does not support schema-independent evaluation samples`);
  const samples = await adapter.sample(index, n, pool);
  if (samples.length === 0) throw new Error(`${adapter.definition.label} returned no sample chunks`);
  return samples;
}
