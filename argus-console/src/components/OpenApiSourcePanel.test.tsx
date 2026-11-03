import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  OpenApiCapabilitySource,
  OpenApiSourceCheckResult,
  OpenApiSourceOperationRef,
  OpenApiSourceRetirementPreview,
  OpenApiSourceRetirementResult,
} from '../types';
import { OpenApiSourcePanel } from './OpenApiSourcePanel';

function source(overrides: Partial<OpenApiCapabilitySource> = {}): OpenApiCapabilitySource {
  return {
    id: 4,
    name: 'Catalog API',
    prefix: 'catalog',
    backendId: 17,
    backendEnabled: false,
    source: { kind: 'url', url: 'https://catalog.example/openapi.json', canCheck: true, baseUrlOverride: null },
    status: 'drifted',
    importedAt: '2026-07-28T10:00:00.000Z',
    checkedAt: '2026-07-30T10:00:00.000Z',
    baseline: { specDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), operationCount: 2 },
    lastCheck: {
      status: 'drifted',
      checkedAt: '2026-07-30T10:00:00.000Z',
      observedSpecDigest: 'c'.repeat(64),
      observedManifestDigest: 'd'.repeat(64),
      summary: { added: 1, changed: 1, removed: 1, authChanged: true, baseUrlChanged: true },
      errorCode: null,
    },
    ...overrides,
  };
}

function operation(overrides: Partial<OpenApiSourceOperationRef> = {}): OpenApiSourceOperationRef {
  return {
    key: 'GET /items',
    name: 'catalog__list_items',
    method: 'GET',
    path: '/items',
    isWrite: false,
    supported: true,
    signature: 'signature',
    workflowCount: 0,
    ...overrides,
  };
}

function driftResult(sourceKind: 'url' | 'text' = 'url'): OpenApiSourceCheckResult {
  return {
    source: { id: 4, name: 'Catalog API', prefix: 'catalog', sourceKind },
    checkedAt: '2026-07-31T10:00:00.000Z',
    status: 'drifted',
    baseline: { specDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) },
    observed: {
      specDigest: 'c'.repeat(64),
      manifestDigest: 'd'.repeat(64),
      title: 'Catalog API v2',
      openapiVersion: '3.1.0',
      baseUrl: 'https://catalog-v2.example',
      auth: { type: 'bearer', headerName: null },
    },
    diff: {
      added: [operation()],
      changed: [{
        before: operation({ key: 'POST /items', name: 'catalog__create_item', method: 'POST', isWrite: true, workflowCount: 2 }),
        after: operation({ key: 'POST /items', name: 'catalog__create_item', method: 'POST', isWrite: true, signature: 'changed', workflowCount: 2 }),
        changes: ['implementation'],
      }],
      removed: [operation({ key: 'DELETE /items/{id}', name: 'catalog__delete_item', method: 'DELETE', path: '/items/{id}', isWrite: true, workflowCount: 3 })],
      baseUrl: { changed: true, before: 'https://catalog.example', after: 'https://catalog-v2.example' },
      auth: { changed: true, before: { type: 'header', headerName: 'X-Api-Key' }, after: { type: 'bearer', headerName: null } },
      summary: { added: 1, changed: 1, removed: 1, authChanged: true, baseUrlChanged: true },
    },
  };
}

function retirementPreview(): OpenApiSourceRetirementPreview {
  return {
    source: {
      id: 4,
      name: 'Catalog API',
      prefix: 'catalog',
      revision: '7',
      manifestDigest: 'b'.repeat(64),
      operationCount: 2,
    },
    backend: { id: 17, name: 'catalog', enabled: false },
    impact: {
      capabilities: [
        { id: 41, name: 'catalog__list_items', isWrite: false, enabled: true, bundleIds: [2], workflowCount: 0 },
        { id: 42, name: 'catalog__create_item', isWrite: true, enabled: false, bundleIds: [2], workflowCount: 1 },
      ],
      bundles: [{ id: 2, name: 'catalog-team', label: 'Catalog team', connectionAssigned: true, capabilityIds: [41, 42], capabilityNames: ['catalog__create_item', 'catalog__list_items'] }],
      workflows: [{ id: 9, name: 'Refresh catalog', capabilityNames: ['catalog__create_item'] }],
    },
    confirmation: {
      expectedPrefix: 'catalog',
      expectedRevision: '7',
      expectedManifestDigest: 'b'.repeat(64),
      expectedImpactDigest: 'c'.repeat(64),
    },
  };
}

function retirementResult(): OpenApiSourceRetirementResult {
  return {
    sourceId: 4,
    backendId: 17,
    prefix: 'catalog',
    deletedCapabilities: [{ id: 41, name: 'catalog__list_items' }, { id: 42, name: 'catalog__create_item' }],
    deletedCapabilityCount: 2,
    preservedBundleIds: [2],
    preservedWorkflowIds: [9],
    retiredAt: '2026-07-31T10:00:00.000Z',
    warnings: [],
  };
}

function renderPanel(
  sources: OpenApiCapabilitySource[],
  onCheck = vi.fn().mockResolvedValue(driftResult(sources[0]?.source.kind ?? 'url')),
) {
  const onReimport = vi.fn();
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onPreviewRetirement = vi.fn().mockResolvedValue(retirementPreview());
  const onRetire = vi.fn().mockResolvedValue(retirementResult());
  const onRetired = vi.fn().mockResolvedValue(undefined);
  render(
    <OpenApiSourcePanel
      sources={sources}
      loading={false}
      error={null}
      onCheck={onCheck}
      onRefresh={onRefresh}
      onReimport={onReimport}
      onPreviewRetirement={onPreviewRetirement}
      onRetire={onRetire}
      onRetired={onRetired}
      onClose={vi.fn()}
    />,
  );
  return { onCheck, onRefresh, onReimport, onPreviewRetirement, onRetire, onRetired };
}

describe('OpenApiSourcePanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('checks a URL source, reviews structural drift, and hands a fresh source to the importer', async () => {
    const { onCheck, onReimport } = renderPanel([source({
      source: {
        kind: 'url',
        url: 'https://catalog.example/openapi.json',
        canCheck: true,
        baseUrlOverride: 'https://catalog-runtime.example/v2',
      },
    })]);
    await screen.findByRole('heading', { name: 'Catalog API' });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    await screen.findByRole('heading', { name: 'Catalog API v2' });
    expect(onCheck).toHaveBeenCalledWith(4, undefined);
    expect(screen.getByText('BASE URL CHANGED')).toBeInTheDocument();
    expect(screen.getByText('API key · X-Api-Key')).toBeInTheDocument();
    expect(screen.getByText('Bearer token')).toBeInTheDocument();
    expect(screen.getByText('3 workflows')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review reimport' }));
    expect(onReimport).toHaveBeenCalledWith({
      specUrl: 'https://catalog.example/openapi.json',
      namePrefix: 'catalog',
      baseUrl: 'https://catalog-runtime.example/v2',
    });
  });

  it('keeps a manual specification browser-local and invalidates its diff when the text changes', async () => {
    const manual = source({
      source: { kind: 'text', url: null, canCheck: true, baseUrlOverride: null },
      status: 'unchecked',
      checkedAt: null,
      lastCheck: null,
    });
    const onCheck = vi.fn().mockResolvedValue(driftResult('text'));
    const { onReimport } = renderPanel([manual], onCheck);
    const documentInput = await screen.findByLabelText('Current OpenAPI document');
    fireEvent.change(documentInput, { target: { value: 'openapi: 3.1.0\ninfo: {title: V2}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await screen.findByRole('button', { name: 'Review reimport' });

    fireEvent.change(documentInput, { target: { value: 'openapi: 3.1.0\ninfo: {title: Unchecked V3}' } });
    expect(screen.queryByRole('button', { name: 'Review reimport' })).not.toBeInTheDocument();
    expect(screen.getByText('Establish current source health')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    const reimport = await screen.findByRole('button', { name: 'Review reimport' });
    fireEvent.click(reimport);
    expect(onCheck).toHaveBeenLastCalledWith(4, 'openapi: 3.1.0\ninfo: {title: Unchecked V3}');
    expect(onReimport).toHaveBeenCalledWith({
      specText: 'openapi: 3.1.0\ninfo: {title: Unchecked V3}',
      namePrefix: 'catalog',
    });
  });

  it('renders a legacy nullable baseline and error check summary without crashing', async () => {
    renderPanel([source({
      status: 'error',
      baseline: { specDigest: null, manifestDigest: null, operationCount: 0 },
      lastCheck: {
        status: 'error',
        checkedAt: '2026-07-31T09:00:00.000Z',
        observedSpecDigest: null,
        observedManifestDigest: null,
        summary: null,
        errorCode: 'source_fetch_failed',
      },
    })]);

    await screen.findByRole('heading', { name: 'Catalog API' });
    expect(screen.getByText(/source_fetch_failed/)).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText('spec —')).toBeInTheDocument();
  });

  it('reviews exact retirement impact and requires the source prefix before retiring', async () => {
    const { onPreviewRetirement, onRetire, onRetired } = renderPanel([source()]);
    await screen.findByRole('heading', { name: 'Catalog API' });

    fireEvent.click(screen.getByRole('button', { name: 'Review retirement' }));

    expect(await screen.findByText('This cannot be undone from Argus.')).toBeInTheDocument();
    expect(onPreviewRetirement).toHaveBeenCalledWith(4);
    expect(screen.getByText('2', { selector: '.openapi-retirement-impact b' })).toBeInTheDocument();
    expect(screen.getByText('Catalog team')).toBeInTheDocument();
    expect(screen.getByText('Refresh catalog')).toBeInTheDocument();
    expect(screen.getByText('catalog__create_item · WRITE')).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: 'Retire catalog' });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type catalog to confirm retirement'), { target: { value: 'catalog' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(onRetire).toHaveBeenCalledWith(4, retirementPreview().confirmation));
    expect(onRetired).toHaveBeenCalledWith(retirementResult());
  });
});
