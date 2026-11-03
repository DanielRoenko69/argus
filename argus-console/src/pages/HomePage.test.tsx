import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewResponse } from '../types';
import { HomePage } from './HomePage';

const api = vi.hoisted(() => ({ getConsoleUser: vi.fn(), getOverview: vi.fn() }));
vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: '2026-08-31T10:00:00.000Z',
  user: { id: 7, username: 'alex', displayName: 'Alex', role: 'platform_admin' },
  attention: [],
  stats: { activeRuns: 2, successRate24h: 100, completed24h: 4, failed24h: 0, workflowsInReview: 1, connectedTools: 25, agents: 3 },
  health: { state: 'healthy', healthy: 7, total: 7, degraded: 0 },
  runs: [],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/home']}>
      <QueryClientProvider client={queryClient}><HomePage /></QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  afterEach(() => vi.clearAllMocks());

  it('keeps the command center useful while the live Overview is still pending', async () => {
    api.getConsoleUser.mockResolvedValue(overview.user);
    api.getOverview.mockReturnValue(new Promise(() => undefined));

    renderPage();

    expect(await screen.findByRole('heading', { name: /Alex/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse workflows' })).toHaveAttribute('href', '/build/workflows');
    expect(screen.queryByText('Build your agent')).not.toBeInTheDocument();
    expect(screen.getByText('Loading live workspace')).toBeInTheDocument();
    expect(screen.queryByText('Loading command center…')).not.toBeInTheDocument();
  });

  it('renders live metrics once the Overview arrives', async () => {
    api.getConsoleUser.mockResolvedValue(overview.user);
    api.getOverview.mockResolvedValue(overview);

    renderPage();

    expect(await screen.findByText('25 tools available')).toBeInTheDocument();
    expect(screen.getByText('MCP tool registry')).toBeInTheDocument();
    expect(screen.queryByText('Loading live workspace')).not.toBeInTheDocument();
  });
});
