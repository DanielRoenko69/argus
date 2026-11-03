import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FabricManagementBundle, ServiceTemplateCatalogResponse } from '../types';
import { ServiceTemplateMarketplace } from './ServiceTemplateMarketplace';

const api = vi.hoisted(() => ({ getServiceTemplateCatalog: vi.fn(), installServiceTemplate: vi.fn() }));
vi.mock('../api', () => api);

const bundles: FabricManagementBundle[] = [{
  id: 4, name: 'platform_ops', label: 'Platform Operations', description: '', icon: '◈', agentRole: null,
  systemPrompt: null, backendIds: [], skillIds: [], workflowIds: [], workflowCount: 0, toolPolicies: [],
  backendCount: 0, toolCount: 0, compositeCount: 0, createdAt: '2026-08-02T10:00:00.000Z', updatedAt: '2026-08-02T10:00:00.000Z',
}];
const catalog: ServiceTemplateCatalogResponse = {
  generatedAt: '2026-08-02T10:00:00.000Z',
  categories: [{ id: 'devops', label: 'DevOps & CI/CD', icon: '🔧', templateCount: 1 }, { id: 'database', label: 'Database', icon: '🗄️', templateCount: 1 }],
  templates: [
    {
      id: 'github', name: 'GitHub', description: 'Repositories and pull requests.', icon: '🐙', category: 'devops', subcategory: null,
      tags: ['github', 'git'], backendType: 'http', docsUrl: 'https://docs.github.com/en/rest', installable: true, unavailableReason: null,
      certification: { level: 'contract', status: 'certified', certifiedCount: 2, totalCount: 2 },
      fields: [{ name: 'token', label: 'Personal Access Token', type: 'password', required: true, placeholder: null, options: [] }],
      tools: [{ nameSuffix: 'list_repos', description: 'List repositories', method: 'GET' }, { nameSuffix: 'create_issue', description: 'Create issue', method: 'POST' }],
    },
    {
      id: 'postgresql', name: 'PostgreSQL', description: 'Legacy database template.', icon: '🐘', category: 'database', subcategory: null,
      tags: ['postgres'], backendType: 'http', docsUrl: null, installable: false, unavailableReason: 'Requires a credential-safe database adapter.',
      certification: { level: 'contract', status: 'certified', certifiedCount: 0, totalCount: 0 },
      fields: [], tools: [],
    },
  ],
};

function renderMarketplace(onInstalled = vi.fn(), onClose = vi.fn(), initialSelection: string | null = null) {
  api.getServiceTemplateCatalog.mockResolvedValue(catalog);
  api.installServiceTemplate.mockResolvedValue({
    templateId: 'github', connection: { id: 12, name: 'github_prod' }, capabilities: [{ id: 21, name: 'github_prod_list_repos' }], warnings: [],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ServiceTemplateMarketplace bundles={bundles} initialSelection={initialSelection} onClose={onClose} onInstalled={onInstalled} /></QueryClientProvider>);
  return { onInstalled, onClose };
}

describe('ServiceTemplateMarketplace', () => {
  afterEach(() => vi.clearAllMocks());

  it('installs a secret-bearing connector staged inside a required bundle', async () => {
    const callbacks = renderMarketplace();
    fireEvent.click(await screen.findByRole('button', { name: /GitHub/ }));
    expect(screen.getByText(/1 write-capable operation/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Technical prefix/), { target: { value: 'github_prod' } });
    fireEvent.change(screen.getByLabelText(/Personal Access Token/), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: /Install staged connector/ }));
    await waitFor(() => expect(api.installServiceTemplate).toHaveBeenCalledWith('github', {
      prefix: 'github_prod', fields: { token: 'secret-token' }, bundleId: 4,
    }));
    expect(callbacks.onInstalled).toHaveBeenCalled();
    expect(callbacks.onClose).toHaveBeenCalled();
  });

  it('explains why an unsafe legacy template cannot be installed', async () => {
    renderMarketplace();
    fireEvent.click(await screen.findByRole('button', { name: /PostgreSQL/ }));
    expect(screen.getByText('Native installation blocked')).toBeInTheDocument();
    expect(screen.getByText(/credential-safe database adapter/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install staged connector/ })).toBeDisabled();
  });

  it('opens a connector passed through a workflow integration deep-link', async () => {
    renderMarketplace(vi.fn(), vi.fn(), 'github');
    expect(await screen.findByRole('heading', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Technical prefix/)).toHaveValue('github');
    expect(screen.getByLabelText(/Personal Access Token/)).toBeInTheDocument();
  });
});
