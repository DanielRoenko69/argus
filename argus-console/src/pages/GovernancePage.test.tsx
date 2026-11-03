import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GovernanceResponse } from '../types';
import { GovernancePage } from './GovernancePage';

const api = vi.hoisted(() => ({
  decideRuntimeApproval: vi.fn(),
  decideWorkflowReview: vi.fn(),
  getGovernance: vi.fn(),
  resumeCodingWorkflow: vi.fn(),
}));
vi.mock('../api', () => api);

function governanceFixture(canManagePlatform: boolean): GovernanceResponse {
  return {
    generatedAt: '2026-08-01T10:00:00.000Z',
    user: { username: 'argus' },
    permissions: { canReview: true, canOverrideFourEyes: canManagePlatform, canManagePlatform },
    stats: { pending: 0, submittedByMe: 0, highRisk: 0, oldestSubmittedAt: null },
    approvals: [],
    recentDecisions: [],
  } satisfies GovernanceResponse;
}

function renderPage(canManagePlatform: boolean, initialEntry = '/governance', response = governanceFixture(canManagePlatform)) {
  api.getGovernance.mockResolvedValue(response);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}><GovernancePage /></QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('GovernancePage native destinations', () => {
  afterEach(() => vi.clearAllMocks());

  it('routes platform administrators exclusively into native Console pages', async () => {
    renderPage(true);
    expect(await screen.findByRole('link', { name: /Open audit trail/ })).toHaveAttribute('href', '/observe/audit');
    expect(screen.getByRole('link', { name: /Audit evidence/ })).toHaveAttribute('href', '/observe/audit');
    expect(screen.getByRole('link', { name: /Access policies/ })).toHaveAttribute('href', '/governance/policies');
    expect(screen.getByRole('link', { name: /Machine identities/ })).toHaveAttribute('href', '/settings/api-keys');
    expect(document.querySelector('a[href^="/admin"]')).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/audit"]')).not.toBeInTheDocument();
  });

  it('does not expose cross-user evidence and platform configuration to reviewers', async () => {
    renderPage(false);
    expect(await screen.findByRole('heading', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open audit trail/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Machine identities/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Access policies/ })).not.toBeInTheDocument();
  });

  it('opens the exact approval selected from a run deep link', async () => {
    const response = governanceFixture(true);
    response.stats.pending = 2;
    response.approvals = [
      {
        id: 'runtime-11', kind: 'runtime_tool', workflowId: null, runtimeApprovalId: 11,
        workflowExecutionId: 41, title: 'Write issue', description: 'First request', subjectLabel: 'GitHub',
        status: 'pending', risk: 'medium', submittedBy: 'alex', submittedAt: '2026-09-13T10:00:00.000Z',
        comment: null, version: null, bundles: [], tags: [], humanOversightRequired: true, history: [],
        href: '/runs/workflow/41', actions: { canApprove: true, canReject: true, blockedReason: null },
      },
      {
        id: 'runtime-12', kind: 'runtime_tool', workflowId: null, runtimeApprovalId: 12,
        workflowExecutionId: 42, title: 'Post notification', description: 'Exact request', subjectLabel: 'Slack',
        status: 'pending', risk: 'high', submittedBy: 'sam', submittedAt: '2026-09-13T10:01:00.000Z',
        comment: null, version: null, bundles: ['notifications'], tags: [], humanOversightRequired: true, history: [],
        href: '/runs/workflow/42', actions: { canApprove: true, canReject: true, blockedReason: null },
      },
    ];
    renderPage(true, '/governance?workflowExecutionId=42&run=42&kind=workflow', response);
    expect(await screen.findByRole('heading', { name: 'Post notification' })).toBeInTheDocument();
    expect(screen.getByText('Exact request')).toBeInTheDocument();
  });
});
