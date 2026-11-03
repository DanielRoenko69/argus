import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowSummary } from '../types';
import { WorkflowsPage } from './WorkflowsPage';

const api = vi.hoisted(() => ({ getRuns: vi.fn(), getWorkflows: vi.fn(), getWorkflowAgentPreflight: vi.fn() }));

vi.mock('../api', () => api);

const workflows: WorkflowSummary[] = [
  {
    id: 9,
    name: 'Catalog release',
    description: 'Publishes a catalog release',
    steps: [],
    input_params: [],
    enabled: true,
    bundle_ids: [3],
    created_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-31T10:00:00.000Z',
    agent_requirements: [{
      role: 'coder',
      label: 'Coder',
      stepIds: ['implement'],
      allowedModes: ['worker'],
      requiredSkillNames: ['typescript'],
      requiredToolPatterns: ['github_*'],
      minimumBundleCount: 1,
    }],
  },
  {
    id: 12,
    name: 'Cluster review',
    description: 'Reviews cluster state',
    steps: [],
    input_params: [],
    enabled: true,
    bundle_ids: [8],
    created_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-31T10:00:00.000Z',
  },
];

function renderPage() {
  api.getWorkflows.mockResolvedValue(workflows);
  api.getRuns.mockResolvedValue({
    generatedAt: '2026-08-22T10:00:00.000Z',
    runs: [{
      id: '8', numericId: 8, workflowId: 9, kind: 'workflow', title: 'Catalog release',
      subtitle: 'Triggered by Alex', status: 'completed', risk: 'low',
      startedAt: '2026-08-22T09:59:00.000Z', updatedAt: '2026-08-22T10:00:00.000Z',
      durationMs: 60_000, error: null, href: '/runs/workflow/8',
    }],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/build/workflows?bundles=3']}>
      <QueryClientProvider client={queryClient}>
        <WorkflowsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('WorkflowsPage bundle impact scope', () => {
  afterEach(() => vi.clearAllMocks());

  it('filters workflows from a Fabric impact link and can clear that scope', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Catalog release' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cluster review' })).not.toBeInTheDocument();
    expect(screen.getByText(/showing workflows connected to 1 access bundle/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /New workflow/ })).toHaveAttribute('href', '/build/workflows/studio');
    expect(screen.getByRole('link', { name: /Open builder/ })).toHaveAttribute('href', '/build/workflows/studio/9');

    fireEvent.click(screen.getByRole('button', { name: 'Clear scope' }));

    expect(await screen.findByRole('heading', { name: 'Cluster review' })).toBeInTheDocument();
  });

  it('renders the resolved Agent contract and its capability evidence', async () => {
    api.getWorkflowAgentPreflight.mockResolvedValue({
      workflowId: 9,
      workflowName: 'Catalog release',
      checkedAt: '2026-08-19T10:00:00.000Z',
      ready: true,
      inferredLegacyContract: false,
      contractFingerprint: 'abc',
      blockers: [],
      warnings: [],
      assignments: [{
        role: 'coder',
        label: 'Coder',
        stepIds: ['implement'],
        status: 'ready',
        agentId: 42,
        agentName: 'catalog_coder',
        agentLabel: 'Catalog Coder',
        agentMode: 'worker',
        model: 'gpt-5.6-terra',
        presetName: 'argus-dev-coder',
        installedPresetVersion: 2,
        requiredPresetVersion: 1,
        skillNames: ['typescript'],
        bundleIds: [3],
        toolNames: ['github_get_file', 'github_create_pull_request'],
        runtime: {
          type: 'codex', profileId: 7, profileName: 'codex-terra', profileLabel: 'Codex Terra',
          model: 'gpt-5.6-terra', state: 'ready', authenticated: true, activeRuns: 0,
          maxConcurrentRuns: 2, availableSlots: 2, detail: 'Ready',
        },
        catalogFingerprint: 'def',
        blockers: [],
        warnings: [],
      }],
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Check agents/ }));

    expect(await screen.findByText('Ready for execution')).toBeInTheDocument();
    expect(screen.getByText('Catalog Coder')).toBeInTheDocument();
    expect(screen.getByText('Codex Terra')).toBeInTheDocument();
    expect(screen.getByText('2 tools · 1 bundles')).toBeInTheDocument();
    expect(api.getWorkflowAgentPreflight).toHaveBeenCalledWith(9);
  });

  it('opens a persisted execution inside the visual builder run inspector', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Run log' }));

    expect(await screen.findByRole('link', { name: /Catalog release/ })).toHaveAttribute(
      'href', '/build/workflows/studio/9?execution=8',
    );
    expect(screen.getByRole('link', { name: /Full run detail/ })).toHaveAttribute('href', '/runs/workflow/8');
  });
});
