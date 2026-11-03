import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBuilderStore } from '@/stores/builderStore';
import { useExecutionStore } from '@/stores/executionStore';

const client = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: client,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message);
    }
  },
}));

import '@/nodes/triggers';
import { PropertiesPanel } from '../PropertiesPanel';

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PropertiesPanel workflowId={161} />
    </QueryClientProvider>,
  );
}

describe('Webhook local test inspector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBuilderStore.getState().reset();
    useExecutionStore.getState().reset();
    useBuilderStore.setState({
      nodes: [{
        id: 'trigger.webhook.test',
        type: 'trigger.webhook',
        position: { x: 0, y: 0 },
        data: {
          label: 'GitHub issues',
          webhook_path: '/github-issues',
          webhook_provider: 'github',
          webhook_allowed_events: 'issues',
          webhook_static_inputs: '{}',
          webhook_test_payload: '',
          args: {},
        },
      }],
      selectedNodeId: 'trigger.webhook.test',
      dirty: false,
    });
    client.post.mockResolvedValue({
      workflow_id: 161,
      workflow_name: 'github_issue_triage',
      execution_id: 42,
      started: true,
      duplicate: false,
      inputs: { repository_owner: 'argus-local' },
      event: {
        source: 'github', event_id: 'local-42', event_type: 'issues.opened', mode: 'local_test',
      },
    });
    client.get.mockResolvedValue({
      id: 161,
      name: 'github_issue_triage',
      description: '',
      enabled: true,
      source: 'visual',
      steps: [],
      input_params: [],
      canvas_state: { viewport: { x: 0, y: 0, zoom: 1 }, theme: 'dark' },
      block_definitions: [],
      trigger_config: {},
      agent_requirements: [],
      updated_at: '2026-08-22T12:00:00.000Z',
    });
    client.put.mockResolvedValue({ ok: true });
  });

  it('starts an authenticated local provider delivery and opens its execution log', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Lokalen Testlauf starten' }));

    await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/workflows/161/test-webhook', {
      provider: 'github',
      event: 'issues',
      action: undefined,
      payload: undefined,
    }));
    expect(useExecutionStore.getState()).toMatchObject({ executionId: 42, running: true, logOpen: true });
    expect(useBuilderStore.getState().selectedNodeId).toBeNull();
  });

  it('atomically saves an edited fixture before testing that server revision', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Provider-Payload (optional)'), {
      target: { value: '{"action":"opened"}' },
    });

    expect(screen.getByText(/vor dem Test automatisch gespeichert/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Speichern & lokalen Test starten' });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => expect(client.put).toHaveBeenCalledWith('/api/workflows/161/flow', expect.objectContaining({
      block_definitions: [expect.objectContaining({
        id: 'trigger.webhook.test',
        data: expect.objectContaining({ webhook_test_payload: '{"action":"opened"}' }),
      })],
    })));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/workflows/161/test-webhook', {
      provider: 'github',
      event: 'issues',
      action: undefined,
      payload: { action: 'opened' },
    }));
    expect(useBuilderStore.getState().dirty).toBe(false);
    expect(useExecutionStore.getState()).toMatchObject({ executionId: 42, running: true, logOpen: true });
  });
});
