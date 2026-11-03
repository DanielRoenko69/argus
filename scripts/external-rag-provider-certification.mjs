#!/usr/bin/env node
/**
 * Deterministic contract journeys for Argus's external Knowledge adapters.
 *
 * The fixture is local and in-process. The compiled Argus adapters still make
 * real HTTP requests, so request paths, auth headers, embedding calls and
 * result mapping are exercised without cloud credentials or external data.
 */

import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

process.env.OPENAI_API_KEY ||= 'argus-external-rag-fixture-key';
process.env.RAG_RERANKER_PROVIDER = 'none';

const reportPath = process.env.ARGUS_EXTERNAL_RAG_REPORT || 'test-results/external-rag-provider-certification.json';
const originalFetch = globalThis.fetch;

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 320) || 'unknown error';
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function expectedAuth(request, provider) {
  if (provider === 'qdrant') return true;
  const header = request.headers.authorization || '';
  if (provider === 'azure_ai_search') return request.headers['api-key'] === 'fixture-azure';
  if (provider === 'pinecone') return request.headers['api-key'] === 'fixture-pinecone';
  if (provider === 'opensearch') return header === `Basic ${Buffer.from('fixture-opensearch').toString('base64')}`;
  if (provider === 'elasticsearch') return header === 'ApiKey fixture-elasticsearch';
  return header === 'Bearer fixture-bearer';
}

function providerFromPath(path) {
  if (path.startsWith('/azure/')) return 'azure_ai_search';
  if (path.startsWith('/opensearch/')) return 'opensearch';
  if (path.startsWith('/elasticsearch/')) return 'elasticsearch';
  if (path.startsWith('/weaviate/')) return 'weaviate';
  if (path.startsWith('/pinecone/')) return 'pinecone';
  if (path.startsWith('/milvus/')) return 'milvus';
  if (path.startsWith('/qdrant/')) return 'qdrant';
  return null;
}

function providerResponse(provider) {
  const marker = `ARGUS_EXTERNAL_RAG_${provider.toUpperCase()}_OK`;
  const payload = { id: `${provider}-doc-1`, content: marker, source: `${provider}.md` };
  if (provider === 'azure_ai_search') return { value: [{ ...payload, '@search.score': 0.93 }] };
  if (provider === 'opensearch' || provider === 'elasticsearch') {
    return { hits: { hits: [{ _id: payload.id, _score: 0.93, _source: payload }] } };
  }
  if (provider === 'weaviate') {
    return { data: { Get: { Knowledge: [{ content: payload.content, source: payload.source, _additional: { id: payload.id, certainty: 0.93 } }] } } };
  }
  if (provider === 'pinecone') return { matches: [{ id: payload.id, score: 0.93, metadata: payload }] };
  if (provider === 'qdrant') return { result: [{ id: payload.id, score: 0.93, payload }] };
  return { code: 0, data: [{ id: payload.id, distance: 0.93, entity: payload }] };
}

async function startFixture() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const provider = providerFromPath(url.pathname);
      if (!provider || request.method !== 'POST') {
        json(response, 404, { error: 'unknown route' });
        return;
      }
      if (provider !== 'qdrant' && !expectedAuth(request, provider)) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      await readJson(request);
      json(response, 200, providerResponse(provider));
    } catch (error) {
      json(response, 500, { error: safeError(error) });
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('external RAG fixture did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function source(provider, baseUrl) {
  const common = {
    id: 1, name: `${provider}-fixture`, label: provider, description: '', provider,
    endpoint: `${baseUrl}/${provider}`, index_name: 'knowledge', api_key: null,
    semantic_config: null, vector_field: 'embedding', top_k: 3, enabled: true,
    created_at: '', updated_at: '', adapter_config: { text_field: 'content', source_field: 'source', id_field: 'id' },
  };
  if (provider === 'azure_ai_search') return { ...common, endpoint: `${baseUrl}/azure`, api_key: 'fixture-azure', vector_field: 'contentVector' };
  if (provider === 'opensearch') return { ...common, api_key: 'fixture-opensearch', adapter_config: { ...common.adapter_config, auth_mode: 'basic' } };
  if (provider === 'elasticsearch') return { ...common, api_key: 'fixture-elasticsearch', adapter_config: { ...common.adapter_config, auth_mode: 'api_key' } };
  if (provider === 'weaviate') return { ...common, endpoint: `${baseUrl}/weaviate`, index_name: 'Knowledge', api_key: 'fixture-bearer' };
  if (provider === 'pinecone') return { ...common, endpoint: `${baseUrl}/pinecone`, index_name: '', api_key: 'fixture-pinecone', adapter_config: { ...common.adapter_config, namespace: 'production' } };
  if (provider === 'qdrant') return { ...common, endpoint: `${baseUrl}/qdrant`, api_key: null };
  return { ...common, endpoint: `${baseUrl}/milvus`, api_key: 'fixture-bearer', vector_field: 'vector' };
}

function check(name, result) {
  return {
    name,
    status: result.status === 'passed' ? 'passed' : 'failed',
    observed: { latency_ms: result.latency_ms },
    ...(result.status === 'passed' ? {} : { reason: result.reason }),
  };
}

async function main() {
  const fixture = await startFixture();
  const checks = [];
  try {
    const { searchAzureAISearch, searchQdrantRag } = await import('../dist/agents/ragClient.js');
    const { searchElasticsearch, searchMilvus, searchOpenSearch, searchPinecone, searchWeaviate } = await import('../dist/agents/ragExternalProviders.js');

    // Intercept only the deterministic embedding request; provider calls still
    // traverse the local HTTP server above.
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('https://api.openai.com/v1/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(input, init);
    };

    const journeys = [
      ['azure_ai_search', searchAzureAISearch],
      ['opensearch', searchOpenSearch],
      ['elasticsearch', searchElasticsearch],
      ['weaviate', searchWeaviate],
      ['pinecone', searchPinecone],
      ['milvus', searchMilvus],
    ];
    for (const [provider, search] of journeys) {
      const started = Date.now();
      try {
        const results = await search(source(provider, fixture.baseUrl), 'platform restart');
        const marker = `ARGUS_EXTERNAL_RAG_${provider.toUpperCase()}_OK`;
        const passed = results.length > 0 && results[0]?.content === marker && results[0]?.source === `${provider}.md`;
        checks.push(check(provider, passed
          ? { status: 'passed', latency_ms: Date.now() - started }
          : { status: 'failed', latency_ms: Date.now() - started, reason: 'adapter result mapping did not match the deterministic fixture' }));
      } catch (error) {
        checks.push(check(provider, { status: 'failed', latency_ms: Date.now() - started, reason: safeError(error) }));
      }
    }
    // Keep Qdrant in this matrix too: its disposable real-container gate is
    // separate, while this journey proves the compiled Argus adapter mapping.
    const qdrantStarted = Date.now();
    try {
      const results = await searchQdrantRag(source('qdrant', fixture.baseUrl), 'platform restart');
      checks.push(check('qdrant', results.length > 0 && results[0]?.content === 'ARGUS_EXTERNAL_RAG_QDRANT_OK'
        ? { status: 'passed', latency_ms: Date.now() - qdrantStarted }
        : { status: 'failed', latency_ms: Date.now() - qdrantStarted, reason: 'adapter result mapping did not match the deterministic fixture' }));
    } catch (error) {
      checks.push(check('qdrant', { status: 'failed', latency_ms: Date.now() - qdrantStarted, reason: safeError(error) }));
    }
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise(resolveClose => fixture.server.close(resolveClose));
  }

  const report = {
    schema: 'argus.external-rag-provider-contracts.v1',
    generated_at: new Date().toISOString(),
    providers: checks,
    overall: checks.length === 7 && checks.every(item => item.status === 'passed') ? 'passed' : 'failed',
  };
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.overall === 'failed') process.exitCode = 2;
}

try { await main(); } catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
