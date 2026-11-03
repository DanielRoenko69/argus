import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewResponse, PublicWidgetCatalog, PublicWidgetRecord } from '../types';
import { PublicWidgetsPage } from './PublicWidgetsPage';

const api = vi.hoisted(() => ({
  deletePublicWidget: vi.fn(),
  disablePublicWidgetDemo: vi.fn(),
  getOverview: vi.fn(),
  getPublicWidgets: vi.fn(),
  provisionPublicWidgetDemo: vi.fn(),
  savePublicWidget: vi.fn(),
}));

vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: '2026-08-01T10:00:00.000Z',
  user: { id: 1, username: 'admin', displayName: 'Argus Admin', role: 'platform_admin' },
  attention: [],
  stats: { activeRuns: 0, successRate24h: null, completed24h: 0, failed24h: 0, workflowsInReview: 0, connectedTools: 0, agents: 2 },
  health: { state: 'healthy', healthy: 0, total: 0, degraded: 0 },
  runs: [],
};

const widget: PublicWidgetRecord = {
  id: 9,
  agentId: 41,
  agent: { id: 41, name: 'support', label: 'Support Agent', enabled: true, visibility: 'public' },
  slug: 'support',
  allowedOrigins: ['https://example.com'],
  enabled: true,
  runtimeState: 'active',
  greeting: 'How can we help?',
  accent: '#7c3aed',
  title: 'Support chat',
  inputPlaceholder: 'Ask the support team...',
  launcherIconUrl: 'https://example.com/support-mark.svg',
  launcherIconAlt: 'Open support chat',
  launcherPosition: 'right',
  rateLimitPerIp: 20,
  dailyTokenCap: 50_000,
  createdBy: 'admin',
  createdAt: '2026-08-01T10:00:00.000Z',
  publicPath: '/public/widget/support',
  scriptPath: '/public/widget.js',
};

const catalog: PublicWidgetCatalog = {
  generatedAt: '2026-08-01T10:00:00.000Z',
  masterEnabled: true,
  demo: {
    configured: false, reachable: false, agentId: null, agentReady: false,
    widgetId: null, widgetEnabled: false, origin: null, publicPath: null,
  },
  widgets: [widget],
  agents: [
    { id: 41, name: 'support', label: 'Support Agent' },
    { id: 42, name: 'sales', label: 'Sales Agent' },
  ],
  limits: { maxOrigins: 20, minDailyTokenCap: 1_000, maxDailyTokenCap: 10_000_000, maxRateLimitPerIp: 1_000 },
};

function renderPage(data: PublicWidgetCatalog = catalog, role = 'platform_admin') {
  api.getOverview.mockResolvedValue({ ...overview, user: { ...overview.user, role } });
  api.getPublicWidgets.mockResolvedValue(data);
  api.savePublicWidget.mockResolvedValue(widget);
  api.deletePublicWidget.mockResolvedValue({ success: true });
  api.provisionPublicWidgetDemo.mockResolvedValue({
    demo: {
      configured: true, reachable: data.masterEnabled, agentId: 51, agentReady: true,
      widgetId: 19, widgetEnabled: true, origin: 'http://localhost', publicPath: '/public/widget/argus-public-demo',
    },
  });
  api.disablePublicWidgetDemo.mockResolvedValue({
    demo: {
      configured: true, reachable: false, agentId: 51, agentReady: false,
      widgetId: 19, widgetEnabled: false, origin: 'http://localhost', publicPath: '/public/widget/argus-public-demo',
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/build/public-widgets']}>
      <QueryClientProvider client={queryClient}><PublicWidgetsPage /></QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('PublicWidgetsPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows effective runtime state, protected embed code and persists agent reassignment', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'How can we help?' })).toBeInTheDocument();
    expect(screen.getByText('Publicly reachable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
    expect(screen.getByText(/data-slug="support"/)).toBeInTheDocument();
    expect(screen.getByText(/data-title="Support chat"/)).toBeInTheDocument();
    expect(screen.getByText(/data-icon-url="https:\/\/example.com\/support-mark.svg"/)).toBeInTheDocument();
    expect(screen.getByText(/Host policy remains server-enforced/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close embed code' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Public agent'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('Widget title'), { target: { value: 'Customer care' } });
    fireEvent.change(screen.getByLabelText('Launcher position'), { target: { value: 'left' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.savePublicWidget).toHaveBeenCalledTimes(1));
    expect(api.savePublicWidget).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 42,
      allowedOrigins: ['https://example.com'],
      enabled: true,
      title: 'Customer care',
      inputPlaceholder: 'Ask the support team...',
      launcherIconUrl: 'https://example.com/support-mark.svg',
      launcherIconAlt: 'Open support chat',
      launcherPosition: 'left',
    }), 9);
  });

  it('creates an origin-bound widget while the global runtime is paused', async () => {
    renderPage({ ...catalog, masterEnabled: false, widgets: [] });

    expect(await screen.findByText('Public runtime is globally paused')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create widget' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Widget slug'), { target: { value: 'docs_assistant' } });
    fireEvent.change(screen.getByLabelText('Allowed origins'), {
      target: { value: 'https://docs.example.com\nhttps://support.example.com, https://docs.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Public agent'), { target: { value: '42' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create widget' }).at(-1)!);

    await waitFor(() => expect(api.savePublicWidget).toHaveBeenCalledTimes(1));
    expect(api.savePublicWidget).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'docs_assistant',
      agentId: 42,
      allowedOrigins: ['https://docs.example.com', 'https://support.example.com'],
      rateLimitPerIp: 20,
      dailyTokenCap: 50_000,
      enabled: true,
    }), undefined);
  });

  it('prepares a dedicated loopback demo without weakening the master switch', async () => {
    renderPage({
      ...catalog,
      masterEnabled: false,
      widgets: [],
      agents: [],
      demo: {
        configured: false, reachable: false, agentId: null, agentReady: false,
        widgetId: null, widgetEnabled: false, origin: null, publicPath: null,
      },
    });

    expect(await screen.findByText('Launch a governed website assistant')).toBeInTheDocument();
    expect(screen.getByText(/public-widget-runtime\.ps1 enable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare local demo' }));

    await waitFor(() => expect(api.provisionPublicWidgetDemo).toHaveBeenCalledWith(window.location.origin, [
      'http://localhost:4173',
      'http://127.0.0.1:4173',
    ]));
    expect(await screen.findByText(/Public demo prepared/)).toBeInTheDocument();
  });

  it('opens an integrated website preview and disables all demo resources together', async () => {
    const demoWidget = { ...widget, slug: 'argus-public-demo', publicPath: '/public/widget/argus-public-demo' };
    renderPage({
      ...catalog,
      widgets: [demoWidget],
      demo: {
        configured: true, reachable: true, agentId: 41, agentReady: true,
        widgetId: 9, widgetEnabled: true, origin: 'http://localhost', publicPath: '/public/widget/argus-public-demo',
      },
    });

    expect(await screen.findByRole('link', { name: 'Open demo website' })).toHaveAttribute('href', 'http://localhost:4173');
    fireEvent.click(await screen.findByRole('button', { name: 'Preview widget' }));
    const frame = screen.getByTitle('Public widget argus-public-demo');
    expect(frame).toHaveAttribute('src', '/public/widget/argus-public-demo');
    fireEvent.click(screen.getByRole('button', { name: 'Close widget preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable demo' }));

    await waitFor(() => expect(api.disablePublicWidgetDemo).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Public demo disabled/)).toBeInTheDocument();
  });

  it('requires the exact slug before deleting a public endpoint', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'How can we help?' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const deleteButton = screen.getByRole('button', { name: 'Delete widget' });
    expect(deleteButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Confirm widget slug'), { target: { value: 'support' } });
    expect(deleteButton).toBeEnabled();
    fireEvent.click(deleteButton);

    await waitFor(() => expect(api.deletePublicWidget).toHaveBeenCalledWith(9));
  });

  it('fails closed for non-admin users even if widget data is returned', async () => {
    renderPage(catalog, 'viewer');
    expect(await screen.findByText('Platform administrator access required.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'How can we help?' })).not.toBeInTheDocument();
  });
});
