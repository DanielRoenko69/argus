import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsPage } from './AgentsPage';

const api = vi.hoisted(() => ({
  deleteAgentStudioAgent: vi.fn(),
  getAgents: vi.fn(),
  getAgentStudio: vi.fn(),
  getConsoleUser: vi.fn(),
  saveAgentStudioAgent: vi.fn(),
}));

vi.mock('../api', () => api);
vi.mock('../components/AgentEditor', () => ({
  AgentEditor: ({ agent, onClose }: { agent: { label: string } | null; onClose: () => void }) => (
    <div role="dialog" aria-label={agent ? `Configure ${agent.label}` : 'Create agent'}>
      <button type="button" onClick={onClose}>Close editor</button>
    </div>
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(initialEntry = '/build/agents') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <AgentsPage />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const summary = {
  id: 7,
  name: 'planner',
  label: 'Planner',
  description: 'Plans governed delivery.',
  model: 'gpt-5.3-codex-spark',
  effective_model: 'gpt-5.6-terra',
  runtime_label: 'Codex subscription',
  runtime_type: 'codex',
  reasoning_effort: 'xhigh',
  supports_vision: false,
};

describe('AgentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAgents.mockResolvedValue([summary]);
    api.getConsoleUser.mockResolvedValue({ id: 1, username: 'alex', displayName: 'Alex', role: 'platform_admin' });
    api.getAgentStudio.mockResolvedValue({
      agents: [{ ...summary, agent_mode: 'worker' }], templates: [], drafts: [], credentialProfiles: [],
      models: [], composites: [], bundles: [], ragIndexes: [], skills: [], runtimeProfiles: [],
    });
  });

  it('loads management data lazily and opens Configure over the unchanged catalog route', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Planner' })).toBeInTheDocument();
    expect(api.getAgentStudio).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Configure/ }));

    expect(await screen.findByRole('dialog', { name: 'Configure Planner' })).toBeInTheDocument();
    expect(api.getAgentStudio).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/build/agents');

    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
    expect(screen.queryByRole('dialog', { name: 'Configure Planner' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Planner' })).toBeInTheDocument();
  });

  it('opens direct Agent creation without rendering the getting-started roadmap', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: 'Create new agent' })).toBeInTheDocument();
    expect(screen.queryByText('Build your agent')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create new agent' }));

    expect(await screen.findByRole('dialog', { name: 'Create agent' })).toBeInTheDocument();
    expect(api.getAgentStudio).toHaveBeenCalledTimes(1);
  });

  it('opens a search deep-link in the same catalog dialog and clears only that query on close', async () => {
    renderPage('/build/agents?agent=7');

    expect(await screen.findByRole('dialog', { name: 'Configure Planner' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/build/agents?agent=7');
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/build/agents');
  });

  it('keeps Agent-specific Blueprints, Evaluations and Channels reachable inside the Agent workspace', async () => {
    renderPage();
    expect(await screen.findByRole('navigation', { name: 'Agent workspace' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Blueprints/ })).toHaveAttribute('href', '/build/agents/manage');
    expect(screen.getByRole('link', { name: /Evaluations/ })).toHaveAttribute('href', '/build/evaluations');
    expect(screen.getByRole('link', { name: /Channels/ })).toHaveAttribute('href', '/build/agents/channels');
  });

  it('shows the effective configured execution runtime instead of the stale base model', async () => {
    renderPage();

    expect(await screen.findByText('Codex subscription · gpt-5.6-terra · xhigh')).toBeInTheDocument();
    expect(screen.queryByText('gpt-5.3-codex-spark')).not.toBeInTheDocument();
  });
});
