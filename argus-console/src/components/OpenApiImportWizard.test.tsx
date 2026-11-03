import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OpenApiImportMutation, OpenApiImportResult, OpenApiImportSource, OpenApiPreview } from '../types';
import { OpenApiImportWizard } from './OpenApiImportWizard';

function previewWithSecurity(note?: string): OpenApiPreview {
  return {
    previewDigest: 'preview-digest',
    specDigest: 'spec-digest',
    title: 'Catalog API',
    openapiVersion: '3.1.0',
    sourceKind: 'url',
    prefix: 'catalog',
    baseUrl: 'https://api.example.com',
    security: {
      auth_type: 'none',
      ...(note ? { note } : {}),
    },
    existing: {
      backendId: null,
      backendOwned: true,
      authType: null,
      hasCredential: false,
      credentialReusable: false,
      importedToolCount: 0,
      assignedBundleIds: [],
      sourceRevision: null,
      sourceManifestDigest: null,
      defaultBundleId: null,
      defaultBundleOwned: true,
    },
    operations: [{
      key: 'GET /items',
      name: 'catalog__list_items',
      method: 'GET',
      path: '/items',
      description: 'List catalog items',
      parameterCount: 0,
      parameters: [],
      tags: ['catalog'],
      isWrite: false,
      riskLevel: 'low',
      supported: true,
      warnings: [],
      change: 'create',
      collisionReason: null,
    }],
    removals: [],
    counts: {
      total: 1,
      supported: 1,
      read: 1,
      write: 0,
      create: 1,
      update: 0,
      collisions: 0,
      unsupported: 0,
      removals: 0,
    },
    warnings: [],
  };
}

const importResult: OpenApiImportResult = {
  backendId: 7,
  bundleId: 8,
  bundleIds: [8],
  created: { read: 1, write: 0 },
  inserted: { read: 1, write: 0 },
  updated: { read: 0, write: 0 },
  removed: [],
  skipped: [],
  warnings: [],
};

function renderWizard(preview: OpenApiPreview, overrides: {
  onImport?: (input: OpenApiImportMutation) => Promise<OpenApiImportResult>;
  onComplete?: () => Promise<void> | void;
  initialSource?: OpenApiImportSource;
} = {}) {
  const onPreview = vi.fn().mockResolvedValue(preview);
  const onImport = vi.fn(overrides.onImport ?? ((_input: OpenApiImportMutation) => Promise.resolve(importResult)));
  const onComplete = vi.fn(overrides.onComplete ?? (() => undefined));

  render(
    <OpenApiImportWizard
      bundles={[]}
      initialSource={overrides.initialSource}
      onPreview={onPreview}
      onImport={onImport}
      onComplete={onComplete}
      onClose={vi.fn()}
    />,
  );

  return { onPreview, onImport, onComplete };
}

async function loadPreviewAndOpenGovernance() {
  fireEvent.change(screen.getByLabelText(/Specification URL/), {
    target: { value: 'https://api.example.com/openapi.json' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Preview operations/ }));
  await screen.findByText('Catalog API');
  fireEvent.click(screen.getByRole('button', { name: /Govern 1 selected/ }));
  await screen.findByText('Bundle scope');
}

describe('OpenApiImportWizard', () => {
  it('prefills a tracked source for a fresh governed reimport preview', async () => {
    const { onPreview } = renderWizard(previewWithSecurity(), {
      initialSource: {
        specUrl: 'https://api.example.com/openapi.json',
        namePrefix: 'catalog',
      },
    });

    expect(screen.getByLabelText(/Specification URL/)).toHaveValue('https://api.example.com/openapi.json');
    expect(screen.getByLabelText(/Capability prefix/)).toHaveValue('catalog');
    fireEvent.click(screen.getByRole('button', { name: /Preview operations/ }));
    await screen.findByText('Catalog API');
    expect(onPreview).toHaveBeenCalledWith({
      specUrl: 'https://api.example.com/openapi.json',
      namePrefix: 'catalog',
    });
  });

  it('keeps future steps locked and revalidates selection before returning to governance', async () => {
    renderWizard(previewWithSecurity());

    expect(screen.getByRole('button', { name: 'Review Select operations' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Govern Secure and scope' })).toBeDisabled();

    await loadPreviewAndOpenGovernance();
    fireEvent.click(screen.getByRole('button', { name: 'Review Select operations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear visible' }));
    fireEvent.click(screen.getByRole('button', { name: 'Govern Secure and scope' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Select at least one importable operation.');
    expect(screen.getByText('Import impact')).toBeInTheDocument();
  });

  it('does not turn a spec-derived server URL into a pinned override', async () => {
    const { onPreview, onImport } = renderWizard(previewWithSecurity());

    await loadPreviewAndOpenGovernance();
    fireEvent.click(screen.getByRole('button', { name: 'Import staged' }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onPreview.mock.calls[0]?.[0]).not.toHaveProperty('baseUrl');
    expect(onImport.mock.calls[0]?.[0]).not.toHaveProperty('baseUrl');
  });

  it('preserves an explicitly entered base URL override through preview and import', async () => {
    const { onPreview, onImport } = renderWizard(previewWithSecurity());
    fireEvent.change(screen.getByLabelText(/Specification URL/), {
      target: { value: 'https://api.example.com/openapi.json' },
    });
    fireEvent.change(screen.getByLabelText(/Base URL override/), {
      target: { value: 'https://runtime.example.com/v2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Preview operations/ }));
    await screen.findByText('Catalog API');
    fireEvent.click(screen.getByRole('button', { name: /Govern 1 selected/ }));
    await screen.findByText('Bundle scope');
    fireEvent.click(screen.getByRole('button', { name: 'Import staged' }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://runtime.example.com/v2' }));
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://runtime.example.com/v2' }));
  });

  it('forces unsupported authentication imports to remain staged and preserves success after refresh failure', async () => {
    const { onImport } = renderWizard(previewWithSecurity('OAuth2 is not supported yet.'), {
      onComplete: () => Promise.reject(new Error('refresh failed')),
    });

    await loadPreviewAndOpenGovernance();

    expect(screen.getByRole('checkbox', { name: /Activate imported capabilities immediately/ })).toBeDisabled();
    expect(screen.getByText(/Unavailable until the unsupported or ambiguous authentication/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /Acknowledge auth follow-up/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import staged' }));

    await screen.findByText('Catalog API is now governed by Argus');
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      acknowledgeUnsupportedAuth: true,
    })));
    expect(screen.getByText(/The import completed, but the capability list could not be refreshed/)).toBeInTheDocument();
  });
});
