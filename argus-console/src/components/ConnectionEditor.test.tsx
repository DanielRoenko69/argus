import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FabricConnectionMutation, FabricManagementBackend, FabricManagementBundle } from '../types';
import { ConnectionEditor } from './ConnectionEditor';

const connection: FabricManagementBackend = {
  id: 17,
  name: 'aiops-kubernetes',
  description: 'Kubernetes evidence connector',
  type: 'mcp',
  managed: true,
  managedBy: null,
  sourceId: null,
  enabled: true,
  state: 'healthy',
  endpoint: 'http://aiops-kubernetes:3010/mcp',
  baseUrl: 'http://aiops-kubernetes:3010',
  mcpEndpoint: '/mcp',
  authType: 'none',
  hasAuthValue: false,
  healthPath: null,
  defaultHeaders: {},
  timeoutMs: 10_000,
  tlsSkipVerify: false,
  authMode: 'service-account',
  oauthAuthorizeUrl: null,
  oauthTokenUrl: null,
  oauthClientId: null,
  hasOauthClientSecret: false,
  oauthScopes: [],
  oauthRevokeUrl: null,
  toolCount: 8,
  bundleIds: [8],
  executionTargets: [{
    kind: 'kubernetes',
    platform: 'kubernetes',
    backendId: 17,
    backendName: 'aiops-kubernetes',
    targetId: 'argus-aiops-kind',
    label: 'Local Kind cluster · argus-demo',
    targetLabel: 'Local Kind cluster',
    cluster: 'argus-aiops',
    namespace: 'argus-demo',
    environment: 'local-demo',
    bundleIds: [8],
  }],
  workflowCount: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const bundles: FabricManagementBundle[] = [{
  id: 8,
  name: 'operations-readonly',
  label: 'Operations read-only',
  description: '',
  icon: '',
  agentRole: null,
  systemPrompt: null,
  backendIds: [17],
  skillIds: [],
  workflowIds: [],
  workflowCount: 1,
  toolPolicies: [],
  backendCount: 1,
  toolCount: 8,
  capabilityCategories: ['runtime'],
  capabilitySignals: [],
  compositeCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}];

describe('ConnectionEditor Kubernetes execution target', () => {
  it('loads, edits and saves only the governed target contract', async () => {
    const onSave = vi.fn(async (_input: FabricConnectionMutation) => ({
      connection: { id: 17, name: 'aiops-kubernetes', type: 'mcp' as const, enabled: true },
      warning: null,
    }));
    render(<ConnectionEditor
      connection={connection}
      bundles={bundles}
      saving={false}
      deleting={false}
      error={null}
      onClose={vi.fn()}
      onSave={onSave}
      onTest={vi.fn(async () => ({ type: 'mcp' as const, reachable: false, latencyMs: null, error: 'offline' }))}
      onDiscover={vi.fn()}
      onTrust={vi.fn()}
      onDelete={null}
    />);

    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    expect(screen.getByRole('checkbox', { name: /Publish as governed Kubernetes target/ })).toBeChecked();
    expect(screen.getByLabelText(/Target ID/)).toHaveValue('argus-aiops-kind');
    expect(screen.getByLabelText('Kubernetes platform')).toHaveValue('kubernetes');
    expect(screen.getByLabelText(/Cluster identity/)).toHaveValue('argus-aiops');
    fireEvent.change(screen.getByLabelText(/Allowed namespaces/), { target: { value: 'argus-demo\nobservability' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & verify/ }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      bundleIds: [8],
      executionTarget: {
        kind: 'kubernetes',
        platform: 'kubernetes',
        targetId: 'argus-aiops-kind',
        label: 'Local Kind cluster',
        cluster: 'argus-aiops',
        environment: 'local-demo',
        namespaces: ['argus-demo', 'observability'],
      },
    });
  });
});
