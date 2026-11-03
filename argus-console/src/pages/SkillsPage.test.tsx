import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillAdoptionResponse, SkillOption } from '../types';
import { SkillsPage } from './SkillsPage';

const api = vi.hoisted(() => ({
  deleteSkill: vi.fn(),
  getSkillAdoption: vi.fn(),
  getSkills: vi.fn(),
  saveSkill: vi.fn(),
}));
vi.mock('../api', () => api);

const skills: SkillOption[] = [
  {
    id: 4,
    name: 'incident-triage',
    label: 'Incident Triage',
    description: 'Investigate operational incidents with evidence first.',
    content: '## Triage\n\nGather logs, metrics and recent deployment evidence.',
    category: 'operations',
    icon: '🚨',
    updated_at: '2026-08-01T10:00:00.000Z',
    assigned_agents: [{ id: 2, name: 'cluster-investigator', label: 'Cluster Investigator', enabled: true }],
  },
  {
    id: 7,
    name: 'review-protocol',
    label: 'Review Protocol',
    description: 'A synced code review policy.',
    content: '## Review\n\nReport findings in severity order.',
    category: 'coding',
    icon: '🔍',
    source_url: 'https://example.test/skills/review.md',
    source_ref: 'v2.1.0',
    imported_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-30T10:00:00.000Z',
    assigned_agents: [],
  },
];

const adoption: SkillAdoptionResponse = {
  generatedAt: '2026-08-02T15:00:00.000Z',
  windowDays: 30,
  kpis: {
    activeConsumers1d: 2, activeConsumers7d: 4, activeConsumers30d: 6,
    totalSkills: 4, activeSkills: 2, adoptionRate: 50, totalUses: 82,
    averageUsesPerConsumer: 13.7, p50Ms: 18, p95Ms: 44, errorCount: 1, errorRate: 1.2,
  },
  bySkill: [{
    skill: 'incident-triage', label: 'Incident Triage', uses: 64, activeConsumers: 5,
    averageContextLength: 640, p95Ms: 44, errorCount: 1, errorRate: 1.6,
  }],
  consumers: [{ id: 'runtime-8bdf91a2', skillFetches: 64, distinctSkills: 2 }],
  timeSeries: [{ day: '2026-08-01', uses: 32, errors: 0 }, { day: '2026-08-02', uses: 50, errors: 1 }],
  stale: [{ id: 7, name: 'review-protocol', label: 'Review Protocol', icon: '🔍', daysSinceLastUse: 41 }],
  trending: [{ skill: 'incident-triage', label: 'Incident Triage', recent: 50, prior: 20, delta: 30 }],
  heatmap: [{ dayOfWeek: 1, hour: 9, uses: 24 }],
};

function renderPage() {
  api.getSkills.mockResolvedValue(skills);
  api.getSkillAdoption.mockImplementation(async days => ({ ...adoption, windowDays: days }));
  api.saveSkill.mockImplementation(async input => ({ id: 12, ...input, assigned_agents: [] }));
  api.deleteSkill.mockResolvedValue({ deleted: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><SkillsPage /></QueryClientProvider></MemoryRouter>);
}

describe('SkillsPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows assignment impact, provenance, filters and creates a reusable skill', async () => {
    renderPage();
    const incidentCard = (await screen.findByRole('heading', { name: 'Incident Triage' })).closest('article');
    expect(incidentCard).not.toBeNull();
    expect(within(incidentCard!).getByText('Cluster Investigator')).toBeInTheDocument();
    expect(screen.getAllByText('Imported')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'assigned' }));
    expect(screen.queryByRole('heading', { name: 'Review Protocol' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'all' }));

    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'change-validation' } });
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Change Validation' } });
    fireEvent.change(screen.getByLabelText(/Markdown content/), { target: { value: '## Validation\n\nCheck the proposed change before execution.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));

    await waitFor(() => expect(api.saveSkill).toHaveBeenCalledWith({
      name: 'change-validation',
      label: 'Change Validation',
      description: '',
      content: '## Validation\n\nCheck the proposed change before execution.',
      category: null,
      icon: '✦',
    }, undefined));
  });

  it('shows imported-source risk and requires the exact technical name before deletion', async () => {
    renderPage();
    const reviewCard = (await screen.findByRole('heading', { name: 'Review Protocol' })).closest('article');
    fireEvent.click(within(reviewCard!).getByRole('button', { name: 'Edit' }));
    expect(screen.getByText(/Manual edits can be overwritten/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete skill' }));
    const confirm = screen.getByRole('button', { name: 'Confirm delete' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type review-protocol to confirm deletion'), { target: { value: 'review-protocol' } });
    fireEvent.click(confirm);

    await waitFor(() => expect(api.deleteSkill).toHaveBeenCalledWith(7));
  });

  it('loads privacy-safe adoption analytics and supports a 90-day window', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Incident Triage' });
    expect(api.getSkillAdoption).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Adoption' }));
    expect(await screen.findByRole('heading', { name: 'Skill usage trend' })).toBeInTheDocument();
    expect(screen.getByText('runtime-8bdf91a2')).toBeInTheDocument();
    expect(screen.getByText('41d ago')).toBeInTheDocument();
    expect(screen.getByText('+30')).toBeInTheDocument();
    expect(api.getSkillAdoption).toHaveBeenCalledWith(30);

    fireEvent.change(screen.getByLabelText('Skill adoption window'), { target: { value: '90' } });
    await waitFor(() => expect(api.getSkillAdoption).toHaveBeenCalledWith(90));
    expect(screen.queryByText('argus-secret-prefix')).not.toBeInTheDocument();
  });
});
