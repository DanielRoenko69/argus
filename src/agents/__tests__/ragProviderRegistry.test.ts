import { describe, expect, it } from '@jest/globals';
import { getRagProviderDefinition, listRagProviderDefinitions, validateRagProviderInput } from '../ragProviderRegistry.js';

describe('Knowledge provider registry', () => {
  it('publishes the built-in provider plus seven external adapters', () => {
    expect(listRagProviderDefinitions().map(provider => provider.id)).toEqual([
      'pgvector', 'qdrant', 'azure_ai_search', 'opensearch', 'elasticsearch', 'weaviate', 'pinecone', 'milvus',
    ]);
    expect(getRagProviderDefinition('pgvector')?.capabilities).toEqual({ ingest: true, evaluation: true });
    expect(getRagProviderDefinition('pinecone')?.capabilities.evaluation).toBe(false);
  });

  it('validates provider-declared required fields while applying declared defaults', () => {
    expect(validateRagProviderInput('opensearch', {
      endpoint: 'https://search.example.com',
      index_name: 'knowledge',
      vector_field: 'embedding',
      adapter_config: {},
      top_k: 5,
    })).toBeNull();
    expect(validateRagProviderInput('opensearch', {
      endpoint: 'https://search.example.com',
      index_name: 'knowledge',
      adapter_config: {},
    })).toBe('Vector field is required for OpenSearch');
  });

  it('rejects providers that are not registered', () => {
    expect(validateRagProviderInput('mystery-db', {})).toBe('Unsupported knowledge provider "mystery-db"');
  });
});
