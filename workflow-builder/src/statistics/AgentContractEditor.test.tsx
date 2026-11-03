import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBuilderStore } from '@/stores/builderStore';
import { AgentContractEditor } from './AgentContractEditor';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  get: vi.fn(),
  flow: {
    id: 9,
    name: 'portable_delivery',
    description: 'Delivery',
    steps: [],
    input_params: [],
    canvas_state: {},
    trigger_config: {},
    block_definitions: [{
      id: 'agent-step', type: 'argus.agent', position: { x: 0, y: 0 },
      data: { label: 'Implement', agent_id: 42 },
    }],
    source: 'visual' as const,
    enabled: true,
    updated_at: '2026-08-19T10:00:00.000Z',
    can_edit: true,
    agent_requirements: [{
      role: 'coder', label: 'Coder', stepIds: ['agent-step'], agentName: 'delivery_coder',
      presetName: 'argus-dev-coder', minimumPresetVersion: 2,
      allowedModes: ['worker'] as Array<'worker'>,
      requiredSkillNames: ['typescript'], requiredToolPatterns: ['github_*'], minimumBundleCount: 1,
    }],
  },
}));

vi.mock('@/api/workflows', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/workflows')>();
  return {
    ...actual,
    useFlow: () => ({ data: mocks.flow }),
    useSaveFlow: () => ({ mutateAsync: mocks.save, isPending: false }),
  };
});

vi.mock('@/api/palette', () => ({
  usePalette: () => ({ data: { skills: [], tools: [], agents: [{
    id: 42, name: 'delivery_coder', label: 'Delivery Coder', agent_mode: 'worker', model: 'gpt-5.6-terra',
  }] } }),
}));

vi.mock('@/api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, api: { ...actual.api, get: mocks.get } };
});

describe('AgentContractEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flow.agent_requirements.splice(0, mocks.flow.agent_requirements.length, {
      role: 'coder', label: 'Coder', stepIds: ['agent-step'], agentName: 'delivery_coder',
      presetName: 'argus-dev-coder', minimumPresetVersion: 2,
      allowedModes: ['worker'], requiredSkillNames: ['typescript'],
      requiredToolPatterns: ['github_*'], minimumBundleCount: 1,
    });
    useBuilderStore.setState({
      nodes: [{
        id: 'agent-step', type: 'argus.agent', position: { x: 0, y: 0 },
        data: { label: 'Implement', agent_id: 42, args: { prompt: 'Ship it' } },
      }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      dirty: false,
      readOnly: false,
      selectedNodeId: null,
      past: [],
      future: [],
    });
    mocks.save.mockResolvedValue({ ok: true });
    mocks.get.mockResolvedValue({
      workflowId: 9, workflowName: 'portable_delivery', checkedAt: '2026-08-19T10:01:00.000Z',
      ready: true, inferredLegacyContract: false, blockers: [], warnings: [], assignments: [{
        role: 'coder', label: 'Coder', stepIds: ['agent-step'], status: 'ready', agentId: 42,
        agentName: 'delivery_coder', agentLabel: 'Delivery Coder', agentMode: 'worker', model: 'gpt-5.6-terra',
        presetName: 'argus-dev-coder', installedPresetVersion: 3, requiredPresetVersion: 2,
        skillNames: ['typescript'], bundleIds: [3], toolNames: ['github_get_file'],
        runtime: { type: 'codex', profileLabel: 'Codex Terra', state: 'ready', detail: 'Ready' },
        blockers: [], warnings: [],
      }],
    });
  });

  it('saves the portable role with the current graph and displays resolved evidence', async () => {
    render(<AgentContractEditor workflowId={9} open onClose={() => undefined} />);

    expect(await screen.findByRole('dialog', { name: 'Workflow Agent contract' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('coder')).toBeInTheDocument();
    expect(screen.getByDisplayValue('argus-dev-coder')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Save & check/ }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const call = mocks.save.mock.calls[0]![0];
    expect(call.payload.agent_requirements[0]).toMatchObject({ role: 'coder', stepIds: ['agent-step'] });
    expect(call.payload.steps[0]).toMatchObject({ agent_role: 'coder' });
    expect(call.payload.steps[0]).not.toHaveProperty('agent_id');
    expect(await screen.findByText('Delivery Coder')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('infers a legacy Agent role when canvas restoration finishes after the drawer opens', async () => {
    mocks.flow.agent_requirements.splice(0);
    useBuilderStore.setState({ nodes: [] });
    render(<AgentContractEditor workflowId={9} open onClose={() => undefined} />);

    act(() => useBuilderStore.setState({
      nodes: [{
        id: 'agent-step', type: 'argus.agent', position: { x: 0, y: 0 },
        data: { label: 'Implement', agent_id: 42, args: { prompt: 'Ship it' } },
      }],
    }));

    expect(await screen.findByDisplayValue('delivery_coder')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save & check/ })).toBeEnabled();
  });
});
