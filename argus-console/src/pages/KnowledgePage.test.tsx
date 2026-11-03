import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeCatalog, KnowledgeProviderDefinition, KnowledgeProviderId, NativeCodeIndexSnapshot } from '../types';
import { KnowledgePage } from './KnowledgePage';

const api = vi.hoisted(() => ({
  deleteKnowledgeDocument: vi.fn(),
  deleteKnowledgeSource: vi.fn(),
  evaluateKnowledgeSource: vi.fn(),
  getKnowledgeCatalog: vi.fn(),
  getNativeCodeIndexes: vi.fn(),
  saveKnowledgeSource: vi.fn(),
  testKnowledgeSource: vi.fn(),
  uploadKnowledgeDocuments: vi.fn(),
}));

vi.mock('../api', () => api);
vi.mock('../features/repository-graph', () => ({
  RepositoryGraphDialog: ({ snapshot, onClose }: { snapshot: NativeCodeIndexSnapshot; onClose: () => void }) => <div role="dialog" aria-label={`Graphify snapshot ${snapshot.id}`}><span>{snapshot.repositoryKey}</span><button type="button" onClick={onClose}>Close graph</button></div>,
}));

const providerDefinition = (id: KnowledgeProviderId, label: string, kind: 'built_in' | 'external' = 'external'): KnowledgeProviderDefinition => ({
  id,
  label,
  kind,
  description: `${label} adapter`,
  target_label: kind === 'built_in' ? 'Argus-managed corpus' : 'Index',
  credential: { mode: kind === 'built_in' ? 'none' : 'optional', label: `${label} credential`, placeholder: '$PROVIDER_KEY' },
  capabilities: { ingest: kind === 'built_in', evaluation: id !== 'pinecone' && id !== 'milvus' },
  fields: kind === 'built_in' ? [] : [
    { key: 'endpoint', label: 'Endpoint', required: true, input: 'url' },
    { key: 'index_name', label: 'Index', required: id !== 'pinecone' },
  ],
});

const catalog: KnowledgeCatalog = {
  providers: [
    providerDefinition('pgvector', 'Built-in Knowledge', 'built_in'),
    providerDefinition('qdrant', 'Qdrant'),
    providerDefinition('azure_ai_search', 'Azure AI Search'),
    providerDefinition('opensearch', 'OpenSearch'),
    providerDefinition('elasticsearch', 'Elasticsearch'),
    providerDefinition('weaviate', 'Weaviate'),
    providerDefinition('pinecone', 'Pinecone'),
    providerDefinition('milvus', 'Milvus / Zilliz'),
  ],
  sources: [
    {
      id: 4,
      name: 'runbooks',
      label: 'Operations Runbooks',
      description: 'Production operations knowledge.',
      provider: 'pgvector',
      endpoint: '',
      index_name: '',
      api_key: null,
      semantic_config: null,
      top_k: 5,
      enabled: true,
      updated_at: '2026-07-31T10:00:00.000Z',
      documents: [{ id: 11, name: 'kubernetes.md', chunk_count: 8, created_at: '2026-07-31T09:00:00.000Z' }],
    },
    {
      id: 8,
      name: 'external-architecture',
      label: 'Architecture Search',
      description: 'Existing Qdrant corpus.',
      provider: 'qdrant',
      endpoint: 'http://qdrant:6333',
      index_name: 'architecture',
      api_key: '••••••••',
      semantic_config: null,
      top_k: 8,
      enabled: true,
      updated_at: '2026-07-31T10:00:00.000Z',
      documents: [],
    },
  ],
};

const codeIndex: NativeCodeIndexSnapshot = {
  id: 3,
  repositoryKey: 'argus/argus-dev-sample',
  branchName: 'main',
  commitSha: '8d832c7a0f3102c4040ce7f840fff87e18332944',
  provider: 'graphify',
  sourceGraphDigest: 'b'.repeat(64),
  parserVersion: '0.9.32',
  graphSchemaVersion: 'argus-graphify-v2',
  embeddingModel: null,
  status: 'ready',
  fileCount: 5,
  symbolCount: 24,
  edgeCount: 24,
  documentCount: 29,
  errorMessage: null,
  metadata: {},
  createdAt: '2026-08-14T10:00:00.000Z',
  finishedAt: '2026-08-14T10:00:02.000Z',
  bundleNames: ['argus-dev-demo'],
  languages: { javascript: 3 },
};

function renderPage(indexes: NativeCodeIndexSnapshot[] = [codeIndex], initialEntry = '/build/knowledge') {
  api.getKnowledgeCatalog.mockResolvedValue(catalog);
  api.getNativeCodeIndexes.mockResolvedValue(indexes);
  api.uploadKnowledgeDocuments.mockResolvedValue({ documents: [{ id: 12, name: 'incident.md', chunkCount: 3 }], failed: [] });
  api.testKnowledgeSource.mockResolvedValue({ ok: true, query: 'How do I restart?', results_count: 1, results: [{ id: '17', score: 0.91, source: 'kubernetes.md', content: 'Restart the deployment with a controlled rollout.' }] });
  api.evaluateKnowledgeSource.mockResolvedValue({ index: 'runbooks', sample_size: 10, evaluated: 10, hits: 8, hit_at_5: 0.8, details: [] });
  api.saveKnowledgeSource.mockResolvedValue(catalog.sources[1]);
  api.deleteKnowledgeDocument.mockResolvedValue({ deleted: true });
  api.deleteKnowledgeSource.mockResolvedValue({ deleted: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter initialEntries={[initialEntry]}><QueryClientProvider client={queryClient}><KnowledgePage /></QueryClientProvider></MemoryRouter>);
}

describe('KnowledgePage', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses built-in pgvector as the default and provides upload plus retrieval workflows', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Argus Knowledge' })).toBeInTheDocument();
    expect(screen.getByText('Built-in PostgreSQL + pgvector')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'RAGs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Operations Runbooks' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Architecture Search' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Filter knowledge sources')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Repository snapshots' }));
    const codeCard = (await screen.findByRole('heading', { name: 'argus/argus-dev-sample' })).closest('article')!;
    expect(codeCard).toHaveTextContent('24 relations');
    fireEvent.click(within(codeCard).getByRole('button', { name: 'View Graphify' }));
    expect(screen.getByRole('dialog', { name: 'Graphify snapshot 3' })).toHaveTextContent('argus/argus-dev-sample');
    fireEvent.click(screen.getByRole('button', { name: 'Close graph' }));
    expect(screen.queryByRole('dialog', { name: 'Graphify snapshot 3' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'RAGs' }));
    const runbooksCard = screen.getByRole('heading', { name: 'Operations Runbooks' }).closest('article')!;
    fireEvent.click(within(runbooksCard).getByRole('button', { name: 'Open workbench' }));

    const workbench = await screen.findByRole('dialog', { name: 'Operations Runbooks' });
    expect(workbench).toBeInTheDocument();
    const file = new File(['# Incident\nRestart safely.'], 'incident.md', { type: 'text/markdown' });
    fireEvent.change(within(workbench).getByLabelText(/Choose knowledge documents/), { target: { files: [file] } });
    fireEvent.click(within(workbench).getByRole('button', { name: 'Index files' }));
    await waitFor(() => expect(api.uploadKnowledgeDocuments).toHaveBeenCalledWith(4, [file]));

    fireEvent.change(within(workbench).getByPlaceholderText(/Ask a question grounded/), { target: { value: 'How do I restart?' } });
    fireEvent.click(within(workbench).getByRole('button', { name: 'Run retrieval' }));
    expect(await screen.findByText('Restart the deployment with a controlled rollout.')).toBeInTheDocument();
    expect(api.testKnowledgeSource).toHaveBeenCalledWith(4, 'How do I restart?');
  });

  it('treats repository snapshots as a first-class filter and keeps incomplete graphs unavailable', async () => {
    const building = { ...codeIndex, id: 4, repositoryKey: 'argus/indexing', status: 'building' as const };
    renderPage([codeIndex, building]);
    await screen.findByRole('heading', { name: 'Argus Knowledge' });

    fireEvent.click(screen.getByRole('link', { name: 'Repository snapshots' }));
    expect(screen.getByRole('heading', { name: 'argus/argus-dev-sample' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'argus/indexing' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Operations Runbooks' })).not.toBeInTheDocument();
    const buildingCard = screen.getByRole('heading', { name: 'argus/indexing' }).closest('article')!;
    expect(within(buildingCard).getByRole('button', { name: 'View Graphify' })).toBeDisabled();

    fireEvent.click(screen.getByRole('link', { name: 'RAGs' }));
    expect(screen.queryByLabelText('Repository snapshots')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Architecture Search' })).toBeInTheDocument();
  });

  it('keeps an external provider credential opaque and preserves it during configuration updates', async () => {
    renderPage();
    const externalCard = (await screen.findByRole('heading', { name: 'Architecture Search' })).closest('article')!;
    fireEvent.click(within(externalCard).getByRole('button', { name: 'Configure' }));
    expect(await screen.findByRole('heading', { name: 'Configure Architecture Search' })).toBeInTheDocument();
    expect(screen.getByText('CONFIGURED')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('••••••••')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Architecture Knowledge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save source' }));
    await waitFor(() => expect(api.saveKnowledgeSource).toHaveBeenCalledTimes(1));
    const [payload, id] = api.saveKnowledgeSource.mock.calls[0];
    expect(id).toBe(8);
    expect(payload.label).toBe('Architecture Knowledge');
    expect(payload.api_key).toBeUndefined();
  });

  it('renders all provider adapters supplied by the backend registry', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Argus Knowledge' });
    fireEvent.click(screen.getByRole('button', { name: 'Add RAG source' }));
    const editor = await screen.findByRole('dialog', { name: 'Add knowledge source' });
    for (const label of ['Qdrant', 'Azure AI Search', 'OpenSearch', 'Elasticsearch', 'Weaviate', 'Pinecone', 'Milvus / Zilliz']) {
      expect(within(editor).getByText(label)).toBeInTheDocument();
    }
  });
});
