import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewResponse } from '../types';
import { SettingsPage } from './SettingsPage';

const api = vi.hoisted(() => ({ getOverview: vi.fn() }));
vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: '2026-08-01T10:00:00.000Z',
  user: { id: 1, username: 'argus', displayName: 'Argus User', role: 'viewer' },
  attention: [],
  stats: { activeRuns: 0, successRate24h: null, completed24h: 0, failed24h: 0, workflowsInReview: 0, connectedTools: 0, agents: 0 },
  health: { state: 'healthy', healthy: 0, total: 0, degraded: 0 },
  runs: [],
};

function renderPage(role: string) {
  api.getOverview.mockResolvedValue({ ...overview, user: { ...overview.user, role } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('SettingsPage access-aware catalog', () => {
  afterEach(() => vi.clearAllMocks());

  it('keeps personal connections available without exposing admin destinations', async () => {
    renderPage('viewer');
    expect(await screen.findByRole('link', { name: /Identity & access/ })).toHaveAttribute('href', '/connections');
    expect(screen.getByRole('link', { name: /Sign-in & MFA/ })).toHaveAttribute('href', '/settings/identity');
    expect(screen.queryByRole('link', { name: /AI providers & models/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /API keys/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Users & roles/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Platform configuration/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Platform readiness/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Public channels/ })).not.toBeInTheDocument();
  });

  it('shows the complete platform catalog to platform administrators', async () => {
    renderPage('platform_admin');
    expect(await screen.findByRole('link', { name: /AI providers & models/ })).toHaveAttribute('href', '/settings/models');
    expect(screen.getByRole('link', { name: /Platform readiness/ })).toHaveAttribute('href', '/settings/readiness');
    expect(screen.getByRole('link', { name: /API keys/ })).toHaveAttribute('href', '/settings/api-keys');
    expect(screen.getByRole('link', { name: /Access policies/ })).toHaveAttribute('href', '/governance/policies?tab=users');
    expect(screen.getByRole('link', { name: /Platform configuration/ })).toHaveAttribute('href', '/settings/platform');
    expect(screen.queryByRole('link', { name: /Public channels/ })).not.toBeInTheDocument();
  });
});
