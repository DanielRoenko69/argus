import { describe, expect, it } from '@jest/globals';
import { searchRagIndex } from '../ragSearch.js';
import type { RagIndex } from '../types.js';

describe('searchRagIndex provider dispatch', () => {
  it('rejects unknown adapters instead of silently dispatching them as Azure AI Search', async () => {
    const source = {
      id: 1,
      name: 'unsupported-source',
      provider: 'mystery-vector-db',
      top_k: 5,
    } as RagIndex;

    await expect(searchRagIndex(source, 'deployment runbook')).rejects.toThrow(
      'Unsupported RAG provider "mystery-vector-db"',
    );
  });
});
