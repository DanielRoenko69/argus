import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from 'reactflow';
import { useBuilderStore } from '@/stores/builderStore';
import { CopilotPanel } from './CopilotPanel';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  validate: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@/api/copilot', () => ({
  useCopilot: () => ({ mutateAsync: mocks.generate, isPending: false }),
}));

vi.mock('@/api/builder', () => ({
  useValidate: () => ({ mutateAsync: mocks.validate, isPending: false }),
}));

vi.mock('@/api/workflows', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/workflows')>();
  return {
    ...actual,
    useFlow: () => ({ data: {
      agent_requirements: [],
      input_params: [{ name: 'issue_number', type: 'number', description: 'Issue number', required: true }],
    } }),
    useSaveFlow: () => ({ mutateAsync: mocks.save, isPending: false }),
  };
});

const existingNodes: Node[] = [
  { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 }, data: { label: 'Start' } },
  { id: 'read', type: 'argus.tool', position: { x: 200, y: 0 }, data: { label: 'Read issue', tool: 'github_read_issue' } },
];
const existingEdges: Edge[] = [{ id: 'start-read', source: 'start', target: 'read' }];

describe('CopilotPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBuilderStore.getState().reset();
    useBuilderStore.getState().loadFlow(existingNodes, existingEdges, { x: 0, y: 0, zoom: 1 });
    mocks.generate.mockResolvedValue({
      rationale: 'Priorisiert das Issue und sendet die Zusammenfassung.',
      add_nodes: [
        {
          id: 'triage',
          type: 'argus.agent',
          position: { x: 400, y: 0 },
          data: { label: 'Priorisieren', agent_role: 'planner' },
        },
        {
          id: 'notify',
          type: 'argus.tool',
          position: { x: 600, y: 0 },
          data: {
            label: 'Slack senden',
            tool: 'slack_post_message',
            integration_id: 'slack',
            args: { channel: 'coding-ops', text: '{{ steps.triage.result }}' },
            tool_binding: { integration_id: 'slack', action_hints: ['post_message'], access: 'write' },
          },
        },
      ],
      add_edges: [
        { source: 'read', target: 'triage' },
        { source: 'triage', target: 'notify' },
      ],
      input_params: [{
        name: 'notification_channel',
        type: 'string',
        description: 'Slack channel ID for requested destination "coding-ops" (for example C01234567)',
        required: true,
      }],
    });
    mocks.validate.mockResolvedValue({ valid: true, errors: [], warnings: [] });
    mocks.save.mockResolvedValue({ ok: true });
  });

  it('uses the complete canvas topology and saves an independently validated draft atomically', async () => {
    render(<CopilotPanel open workflowId={161} onClose={() => undefined} />);

    fireEvent.change(screen.getByPlaceholderText(/GitHub Issues/), {
      target: { value: 'Priorisiere das Issue und poste es nach Slack.' },
    });
    fireEvent.click(screen.getByTitle('Senden (Strg+Enter)'));

    await waitFor(() => expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 161,
      current_edges: [{ source: 'start', target: 'read' }],
    })));
    expect(await screen.findByText('slack')).toBeInTheDocument();
    expect(screen.getByText('1 Write-Schritte')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Prüfen & als Entwurf speichern/ }));

    await waitFor(() => expect(mocks.validate).toHaveBeenCalledTimes(1));
    expect(mocks.validate.mock.calls[0]?.[0]).toMatchObject({ workflowId: 161 });
    expect(mocks.validate.mock.calls[0]?.[0].steps.map((step: { id: string }) => step.id)).toEqual([
      'start', 'read', 'triage', 'notify',
    ]);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ id: 161 });
    expect(mocks.save.mock.calls[0]?.[0].payload.input_params).toEqual([
      { name: 'issue_number', type: 'number', description: 'Issue number', required: true },
      expect.objectContaining({ name: 'notification_channel', required: true }),
    ]);
    expect(await screen.findByText('Geprüft und als Entwurf gespeichert')).toBeInTheDocument();

    const state = useBuilderStore.getState();
    expect(state.nodes.map(node => node.id)).toEqual(['start', 'read', 'triage', 'notify']);
    expect(state.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['start', 'read'],
      ['read', 'triage'],
      ['triage', 'notify'],
    ]);
    expect(state.dirty).toBe(false);
    expect(state.past).toHaveLength(1);
  });

  it('can safely patch an existing node while preserving its identity and unrelated configuration', async () => {
    mocks.generate.mockResolvedValueOnce({
      rationale: 'Parameterisiert den bestehenden Slack-ähnlichen Tool-Schritt.',
      add_nodes: [],
      update_nodes: [{
        id: 'read',
        data: { label: 'Read configured issue', args: { issue_number: '{{ input.issue_number }}' } },
      }],
      add_edges: [],
    });
    render(<CopilotPanel open workflowId={161} onClose={() => undefined} />);

    fireEvent.change(screen.getByPlaceholderText(/GitHub Issues/), {
      target: { value: 'Fix the existing read node.' },
    });
    fireEvent.click(screen.getByTitle('Senden (Strg+Enter)'));

    expect(await screen.findByText('0 neu · 1 geändert · 0 Kanten')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Prüfen & als Entwurf speichern/ }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const readNode = useBuilderStore.getState().nodes.find(node => node.id === 'read');
    expect(readNode).toMatchObject({
      id: 'read', type: 'argus.tool', position: { x: 200, y: 0 },
      data: {
        label: 'Read configured issue', tool: 'github_read_issue',
        args: { issue_number: '{{ input.issue_number }}' },
      },
    });
  });

  it('enables the draft action when a stale Agent-binding warning is repaired locally', async () => {
    mocks.generate.mockResolvedValueOnce({
      rationale: 'Bindet den Planner portabel.',
      add_nodes: [{
        id: 'plan',
        type: 'argus.agent',
        position: { x: 400, y: 0 },
        data: { label: 'Plan', args: { agent_role: 'planner', prompt: 'Plan it' } },
      }],
      add_edges: [{ source: 'read', target: 'plan' }],
      warnings: ["plan: argus.agent step needs `agent_role` or `agent_id`"],
    });
    render(<CopilotPanel open workflowId={161} onClose={() => undefined} />);

    fireEvent.change(screen.getByPlaceholderText(/GitHub Issues/), {
      target: { value: 'Add a planner.' },
    });
    fireEvent.click(screen.getByTitle('Senden (Strg+Enter)'));

    const saveButton = await screen.findByRole('button', { name: /Prüfen & als Entwurf speichern/ });
    expect(saveButton).toBeEnabled();
    expect(screen.queryByText('Noch nicht ausführbar')).not.toBeInTheDocument();
    fireEvent.click(saveButton);

    await waitFor(() => expect(mocks.validate).toHaveBeenCalledTimes(1));
    const plan = mocks.validate.mock.calls[0]?.[0].steps.find((step: { id: string }) => step.id === 'plan');
    expect(plan).toMatchObject({ agent_role: 'planner', args: { prompt: 'Plan it' } });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  });
});
