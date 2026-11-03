import { describe, expect, it, jest } from '@jest/globals';
import {
  codeEmbeddingConfig,
  createCodeQueryEmbedding,
  embedCodeIndexDocuments,
  type CodeEmbeddingConfig,
} from '../embeddings.js';
import type { PersistCodeIndexInput } from '../types.js';

function fixture(): PersistCodeIndexInput {
  return {
    repositoryKey: 'argus/sample', branchName: 'main', commitSha: 'a'.repeat(40),
    bundleIds: [1], provider: 'graphify', sourceGraphDigest: 'b'.repeat(64),
    graphSchemaVersion: 'argus-graphify-v2', files: [{
      path: 'src/app.ts', contentHash: 'c'.repeat(64), byteSize: 20, lineCount: 1,
    }], symbols: [], edges: [], documents: [
      { filePath: 'src/app.ts', chunkKind: 'file', content: 'health endpoint' },
      { filePath: 'src/app.ts', chunkKind: 'symbol', symbolKey: null, content: 'createApp function' },
    ],
  };
}

const config: CodeEmbeddingConfig = {
  enabled: true, model: 'argus-local-embedding', identity: 'argus-local-embedding', profile: 'plain', batchSize: 1,
  maxDocuments: 10, maxInputBytes: 1_024, timeoutMs: 5_000,
};

describe('native code embeddings', () => {
  it('is explicitly disabled by default and resolves a configured model provider-neutrally', () => {
    expect(codeEmbeddingConfig({ EMBEDDING_MODEL: 'shared-model' })).toMatchObject({ enabled: false, model: null });
    expect(codeEmbeddingConfig({
      ARGUS_CODE_EMBEDDINGS_ENABLED: 'true', EMBEDDING_MODEL: 'shared-model',
    })).toMatchObject({ enabled: true, model: 'shared-model', identity: 'shared-model', profile: 'plain' });
    expect(codeEmbeddingConfig({
      ARGUS_CODE_EMBEDDINGS_ENABLED: 'true', EMBEDDING_MODEL: 'shared-model',
      ARGUS_CODE_EMBEDDING_PROFILE: 'nomic-retrieval',
    })).toMatchObject({
      identity: 'shared-model@argus/nomic-retrieval-v1', profile: 'nomic-retrieval',
    });
  });

  it('uses versioned asymmetric Nomic retrieval prefixes on both sides', async () => {
    const calls: Array<{ model: string; values: string | string[] }> = [];
    const client = jest.fn(async (model: string, values: string | string[]) => {
      calls.push({ model, values });
      const items = Array.isArray(values) ? values : [values];
      return { data: items.map((_value, index) => ({ index, embedding: [0.1, 0.2] })) };
    });
    const nomicConfig: CodeEmbeddingConfig = {
      ...config,
      identity: 'argus-local-embedding@argus/nomic-retrieval-v1',
      profile: 'nomic-retrieval',
    };
    const embedded = await embedCodeIndexDocuments(fixture(), nomicConfig, client);
    expect(embedded.embeddingModel).toBe('argus-local-embedding@argus/nomic-retrieval-v1');
    expect(calls[0]!.model).toBe('argus-local-embedding');
    expect((calls[0]!.values as string[])[0]).toMatch(/^search_document: path: src\/app\.ts/u);

    await createCodeQueryEmbedding(embedded.embeddingModel!, 'find health route', 5_000, client);
    expect(calls.at(-1)).toEqual({ model: 'argus-local-embedding', values: 'search_query: find health route' });
  });

  it('uses a versioned code-retrieval instruction for Qwen3 queries only', async () => {
    const calls: Array<{ model: string; values: string | string[] }> = [];
    const client = jest.fn(async (model: string, values: string | string[]) => {
      calls.push({ model, values });
      const items = Array.isArray(values) ? values : [values];
      return { data: items.map((_value, index) => ({ index, embedding: [0.1, 0.2] })) };
    });
    const qwenConfig: CodeEmbeddingConfig = {
      ...config,
      identity: 'argus-local-embedding@argus/qwen3-code-files-v2',
      profile: 'qwen3-code-retrieval',
    };
    const embedded = await embedCodeIndexDocuments(fixture(), qwenConfig, client);
    expect(embedded.documents.map(document => document.embedding)).toEqual([[0.1, 0.2], undefined]);
    expect(embedded.metadata).toMatchObject({
      embedding: { documents: 1, totalDocuments: 2, embeddedChunkKinds: ['file'] },
    });
    expect((calls[0]!.values as string[])[0]).toMatch(/^path: src\/app\.ts/u);
    await createCodeQueryEmbedding(embedded.embeddingModel!, 'records vanish across streams', 5_000, client);
    expect(calls.at(-1)).toEqual({
      model: 'argus-local-embedding',
      values: 'Instruct: Given a software issue, retrieve source code and tests that should be changed to resolve it.\nQuery:records vanish across streams',
    });
  });

  it('embeds every document in bounded batches without changing stored source content', async () => {
    const client = jest.fn(async (_model: string, values: string | string[]) => ({
      data: (Array.isArray(values) ? values : [values]).map((_value, index) => ({ index, embedding: [0.1, 0.2, 0.3] })),
      usage: { prompt_tokens: 4 },
    }));
    const source = fixture();
    const embedded = await embedCodeIndexDocuments(source, config, client);
    expect(client).toHaveBeenCalledTimes(2);
    expect(embedded.embeddingModel).toBe('argus-local-embedding');
    expect(embedded.documents.map(document => document.embedding)).toEqual([
      [0.1, 0.2, 0.3], [0.1, 0.2, 0.3],
    ]);
    expect(embedded.documents.map(document => document.content)).toEqual(source.documents.map(document => document.content));
    expect(embedded.metadata).toMatchObject({ embedding: { dimension: 3, documents: 2, promptTokens: 8 } });
  });

  it('rejects partial or dimension-inconsistent provider responses', async () => {
    const partial = jest.fn(async () => ({ data: [] }));
    await expect(embedCodeIndexDocuments(fixture(), config, partial)).rejects.toThrow('returned 0 vectors');

    const queryClient = jest.fn(async () => ({ data: [{ index: 0, embedding: [0.4, 0.5] }] }));
    await expect(createCodeQueryEmbedding('embed', 'health', 5_000, queryClient)).resolves.toEqual([0.4, 0.5]);
  });
});
