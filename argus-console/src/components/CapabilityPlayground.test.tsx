import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityPlaygroundMutation, CapabilityPlaygroundResult, CapabilityStudioItem } from '../types';
import { CapabilityPlayground, supportsCapabilityPlayground } from './CapabilityPlayground';

function capability(overrides: Partial<CapabilityStudioItem> = {}): CapabilityStudioItem {
  return {
    id: 'managed:42',
    managedId: 42,
    managedBy: null,
    name: 'catalog__get_item',
    description: 'Read an item',
    source: 'managed',
    backend: 'custom:catalog',
    backendId: 7,
    backendLabel: 'Catalog API',
    queryTemplate: 'GET /items/{{itemId}}',
    parameters: [
      { name: 'itemId', type: 'number', description: 'Numeric item ID', required: true },
      { name: 'verbose', type: 'boolean', description: 'Include detail', required: false, default: 'true' },
    ],
    inputSchema: null,
    category: 'Catalog',
    enabled: false,
    isWrite: false,
    riskLevel: 'low',
    requiredAuthMode: 'service-account',
    bundleIds: [3],
    workflowCount: 0,
    editable: true,
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:00:00.000Z',
    ...overrides,
  };
}

function result(
  input: CapabilityPlaygroundMutation,
  overrides: Partial<CapabilityPlaygroundResult> = {},
): CapabilityPlaygroundResult {
  return {
    capability: {
      id: 'managed:42',
      name: 'catalog__get_item',
      enabled: false,
      isWrite: false,
      riskLevel: 'low',
    },
    request: {
      method: 'GET',
      target: `https://catalog.example/items/${String(input.parameters.itemId)}`,
      headers: { Authorization: 'Bearer ••••••••', Accept: 'application/json' },
      body: null,
    },
    executed: input.execute,
    ...(input.execute ? {
      response: {
        status: 200,
        statusText: 'OK',
        contentType: 'application/json',
        body: '{"id":17,"name":"Argus"}',
        truncated: false,
        durationMs: 38,
      },
    } : {}),
    ...overrides,
  };
}

function renderPlayground(overrides: {
  capability?: CapabilityStudioItem;
  onRun?: (input: CapabilityPlaygroundMutation) => Promise<CapabilityPlaygroundResult>;
  onActivate?: () => Promise<void>;
} = {}) {
  const onRun = vi.fn(overrides.onRun ?? ((input: CapabilityPlaygroundMutation) => Promise.resolve(result(input))));
  const onActivate = vi.fn(overrides.onActivate ?? (() => Promise.resolve()));
  render(
    <CapabilityPlayground
      capability={overrides.capability ?? capability()}
      running={false}
      activating={false}
      error={null}
      onRun={onRun}
      onActivate={onActivate}
      onClose={vi.fn()}
    />,
  );
  return { onRun, onActivate };
}

describe('CapabilityPlayground', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is offered for managed connected-HTTP capabilities independently of definition editing', () => {
    expect(supportsCapabilityPlayground(capability())).toBe(true);
    expect(supportsCapabilityPlayground(capability({ editable: false }))).toBe(true);
    expect(supportsCapabilityPlayground(capability({ backend: 'http' }))).toBe(false);
    expect(supportsCapabilityPlayground(capability({ backend: 'postgresql' }))).toBe(false);
    expect(supportsCapabilityPlayground(capability({ source: 'remote', editable: false }))).toBe(false);
  });

  it('previews first, preserves typed parameters, executes a read, and offers activation after success', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onRun, onActivate } = renderPlayground();

    expect(screen.queryByRole('button', { name: 'Run read test' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/itemId/), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview request' }));

    await screen.findByText('https://catalog.example/items/17');
    expect(onRun).toHaveBeenLastCalledWith({
      parameters: { itemId: 17, verbose: true },
      execute: false,
      confirmWrite: false,
    });
    expect(screen.getByText('Bearer ••••••••')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Run read test' }));
    await screen.findByText('200 OK');
    expect(screen.getByText('38 ms')).toBeInTheDocument();
    expect(screen.getByText(/"name": "Argus"/)).toBeInTheDocument();
    expect(onRun).toHaveBeenLastCalledWith({
      parameters: { itemId: 17, verbose: true },
      execute: true,
      confirmWrite: false,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Activate capability' }));
    await waitFor(() => expect(onActivate).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith('Activate catalog__get_item for authorized runtimes?');
  });

  it('requires a fresh preview and explicit confirmation before executing a write', async () => {
    const writeCapability = capability({
      name: 'catalog__create_item',
      queryTemplate: 'POST /items',
      parameters: [{ name: 'title', type: 'string', description: 'Item title', required: true }],
      isWrite: true,
      riskLevel: 'high',
    });
    const onRun = vi.fn(async (input: CapabilityPlaygroundMutation) => result(input, {
      capability: { id: 'managed:42', name: writeCapability.name, enabled: false, isWrite: true, riskLevel: 'high' },
      request: {
        method: 'POST',
        target: 'https://catalog.example/items',
        headers: { Authorization: 'Bearer ••••••••', 'Content-Type': 'application/json' },
        body: `{"title":"${String(input.parameters.title)}"}`,
      },
      ...(input.execute ? {
        response: {
          status: 201,
          statusText: 'Created',
          contentType: 'application/json',
          body: '{"id":99}',
          truncated: true,
          durationMs: 71,
        },
      } : {}),
    }));
    renderPlayground({ capability: writeCapability, onRun });

    expect(screen.getByRole('button', { name: 'Execute confirmed write' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/title/), { target: { value: '  New item  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview request' }));

    await screen.findByText('Confirm this write request');
    expect(screen.getByRole('button', { name: 'Execute confirmed write' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Activate capability' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Confirm this write request/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Execute confirmed write' }));

    await screen.findByText('201 Created');
    expect(onRun).toHaveBeenLastCalledWith({
      parameters: { title: '  New item  ' },
      execute: true,
      confirmWrite: true,
    });
    expect(screen.getByText(/Response truncated/)).toBeInTheDocument();
  });

  it('honors a server-side write promotion instead of trusting the registry flag', async () => {
    const onRun = vi.fn(async (input: CapabilityPlaygroundMutation) => result(input, {
      capability: { id: 'managed:42', name: 'catalog__get_item', enabled: false, isWrite: true, riskLevel: 'high' },
      request: {
        method: 'DELETE',
        target: 'https://catalog.example/items/17',
        headers: {},
        body: null,
      },
      executed: false,
      response: undefined,
    }));
    renderPlayground({ onRun });
    fireEvent.change(screen.getByLabelText(/itemId/), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview request' }));

    await screen.findByText('Confirm this write request');
    expect(screen.queryByRole('button', { name: 'Run read test' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Execute confirmed write' })).toBeDisabled();
    expect(screen.getByText('DELETE')).toBeInTheDocument();
  });

  it('removes a stale preview and activation path before a failed execution', async () => {
    const onRun = vi.fn(async (input: CapabilityPlaygroundMutation) => {
      if (input.execute) throw new Error('Connection became unavailable');
      return result(input);
    });
    renderPlayground({ onRun });
    fireEvent.change(screen.getByLabelText(/itemId/), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview request' }));
    await screen.findByText('https://catalog.example/items/17');

    fireEvent.click(screen.getByRole('button', { name: 'Run read test' }));
    await waitFor(() => expect(screen.queryByText('https://catalog.example/items/17')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Activate capability' })).not.toBeInTheDocument();
    expect(screen.getByText('Request preview appears here')).toBeInTheDocument();
  });

  it('does not treat a manual redirect as a passed activation test', async () => {
    const onRun = vi.fn(async (input: CapabilityPlaygroundMutation) => result(input, input.execute ? {
      response: {
        status: 302,
        statusText: 'Found',
        contentType: null,
        body: '',
        truncated: false,
        durationMs: 4,
      },
    } : {}));
    renderPlayground({ onRun });
    fireEvent.change(screen.getByLabelText(/itemId/), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview request' }));
    await screen.findByText('https://catalog.example/items/17');
    fireEvent.click(screen.getByRole('button', { name: 'Run read test' }));

    await screen.findByText('302 Found');
    expect(screen.queryByRole('button', { name: 'Activate capability' })).not.toBeInTheDocument();
  });
});
