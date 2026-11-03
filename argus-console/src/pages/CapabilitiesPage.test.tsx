import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CapabilityStudioItem,
  CapabilityStudioResponse,
  OpenApiCapabilitySource,
  OpenApiCapabilitySourcesResponse,
} from '../types';
import { CapabilitiesPage } from './CapabilitiesPage';

const api = vi.hoisted(() => ({
  checkOpenApiCapabilitySource: vi.fn(),
  deleteCapability: vi.fn(),
  getCapabilityStudio: vi.fn(),
  getOpenApiCapabilitySources: vi.fn(),
  getOpenApiSourceRetirement: vi.fn(),
  importOpenApiCapabilities: vi.fn(),
  previewOpenApiImport: vi.fn(),
  retireOpenApiSource: vi.fn(),
  runCapabilityPlayground: vi.fn(),
  saveCapability: vi.fn(),
  setCapabilityState: vi.fn(),
}));

vi.mock('../api', () => api);

function capability(overrides: Partial<CapabilityStudioItem> = {}): CapabilityStudioItem {
  return {
    id: 'managed:41',
    managedId: 41,
    managedBy: null,
    name: 'catalog__list_items',
    description: 'List catalog items',
    source: 'managed',
    backend: 'custom:catalog',
    backendId: 17,
    backendLabel: 'Catalog API',
    queryTemplate: 'GET /items',
    parameters: [],
    inputSchema: null,
    category: 'Catalog',
    enabled: true,
    isWrite: false,
    riskLevel: 'low',
    requiredAuthMode: 'strict',
    bundleIds: [],
    workflowCount: 0,
    editable: true,
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

function studioResponse(capabilities: CapabilityStudioItem[]): CapabilityStudioResponse {
  return {
    generatedAt: '2026-07-31T10:00:00.000Z',
    stats: {
      total: capabilities.length,
      active: capabilities.filter(item => item.enabled).length,
      managed: capabilities.filter(item => item.source === 'managed').length,
      remote: capabilities.filter(item => item.source === 'remote').length,
      writeFlagged: capabilities.filter(item => item.isWrite).length,
      unscoped: capabilities.filter(item => item.bundleIds.length === 0).length,
      disabled: capabilities.filter(item => !item.enabled).length,
    },
    bundles: [],
    backends: [{ id: 17, name: 'Catalog API', description: '', type: 'http', enabled: true }],
    capabilities,
  };
}

function openApiSource(): OpenApiCapabilitySource {
  return {
    id: 7,
    name: 'Catalog API',
    prefix: 'catalog',
    backendId: 17,
    backendEnabled: true,
    source: {
      kind: 'url',
      url: 'https://catalog.example/openapi.json',
      canCheck: true,
      baseUrlOverride: null,
    },
    status: 'current',
    importedAt: '2026-07-28T10:00:00.000Z',
    checkedAt: '2026-07-31T09:00:00.000Z',
    baseline: {
      specDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      operationCount: 1,
    },
    lastCheck: {
      status: 'current',
      checkedAt: '2026-07-31T09:00:00.000Z',
      observedSpecDigest: 'a'.repeat(64),
      observedManifestDigest: 'b'.repeat(64),
      summary: { added: 0, changed: 0, removed: 0, authChanged: false, baseUrlChanged: false },
      errorCode: null,
    },
  };
}

function renderPage(
  capabilities: CapabilityStudioItem[],
  sources: OpenApiCapabilitySource[] = [],
) {
  api.getCapabilityStudio.mockResolvedValue(studioResponse(capabilities));
  api.getOpenApiCapabilitySources.mockResolvedValue({
    generatedAt: '2026-07-31T10:00:00.000Z',
    sources,
  } satisfies OpenApiCapabilitySourcesResponse);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CapabilitiesPage />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('CapabilitiesPage source ownership', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.classList.remove('has-dialog');
    window.history.replaceState({}, '', '/mcp-fabric/capabilities');
  });

  it('labels OpenAPI-owned capabilities and opens Source Health from their locked action', async () => {
    renderPage([
      capability({ managedBy: 'openapi', editable: false, category: 'openapi:catalog' }),
    ], [openApiSource()]);

    await screen.findByText('catalog__list_items');
    expect(screen.getByText('OpenAPI managed')).toBeInTheDocument();
    expect(screen.getByLabelText('OpenAPI-managed source')).toBeInTheDocument();
    expect(screen.queryByText('Read only')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: 'Manage OpenAPI source for catalog__list_items',
    }));

    const dialog = await screen.findByRole('dialog', { name: 'OpenAPI source health' }, { timeout: 3_000 });
    expect(await within(dialog).findByRole('heading', { name: 'Catalog API' })).toBeInTheDocument();
  });

  it('preserves the regular managed, builtin, and remote ownership actions', async () => {
    renderPage([
      capability(),
      capability({
        id: 'builtin:kubernetes_status',
        managedId: 42,
        name: 'kubernetes_status',
        source: 'builtin',
        backend: 'kubernetes',
        backendId: null,
        backendLabel: 'Kubernetes',
        editable: false,
      }),
      capability({
        id: 'remote:43',
        managedId: null,
        name: 'github_get_issue',
        source: 'remote',
        backend: 'remote:github',
        backendId: 18,
        backendLabel: 'GitHub MCP',
        editable: false,
      }),
    ]);

    await screen.findByText('catalog__list_items');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Connection$/ })).toHaveAttribute('href', '/mcp-fabric#connections');
    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Manage OpenAPI source/ })).not.toBeInTheDocument();
  });

  it('opens and clears a source deep link from the Connections view', async () => {
    window.history.replaceState({}, '', '/mcp-fabric/capabilities?source=7');
    renderPage([
      capability({ managedBy: 'openapi', editable: false, category: 'openapi:catalog' }),
    ], [openApiSource()]);

    const dialog = await screen.findByRole('dialog', { name: 'OpenAPI source health' }, { timeout: 3_000 });
    expect(await within(dialog).findByRole('heading', { name: 'Catalog API' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close OpenAPI source health' }));

    expect(window.location.search).toBe('');
  });
});
