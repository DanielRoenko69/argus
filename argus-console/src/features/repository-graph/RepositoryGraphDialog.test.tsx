import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NativeCodeIndexSnapshot } from '../../types';
import { RepositoryGraphDialog } from './RepositoryGraphDialog';
import type { RepositoryGraphLoader, RepositoryGraphNeighborhood, RepositoryGraphOverview, RepositoryGraphOverviewLoader } from './types';

const snapshot: NativeCodeIndexSnapshot = {
  id: 42,
  repositoryKey: 'argus-project/argus-core',
  branchName: 'main',
  commitSha: 'a'.repeat(40),
  provider: 'graphify',
  sourceGraphDigest: 'b'.repeat(64),
  parserVersion: '0.9.32',
  graphSchemaVersion: 'argus-graphify-v3',
  embeddingModel: null,
  status: 'ready',
  fileCount: 1,
  symbolCount: 1,
  edgeCount: 1,
  documentCount: 2,
  errorMessage: null,
  metadata: {},
  createdAt: '2026-09-01T10:00:00.000Z',
  finishedAt: '2026-09-01T10:00:02.000Z',
  bundleNames: ['argus.dev'],
  languages: { typescript: 1 },
};

function neighborhood(): RepositoryGraphNeighborhood {
  return {
    schemaVersion: 1,
    snapshot: {
      id: '42', repository: snapshot.repositoryKey, branch: snapshot.branchName,
      commitSha: snapshot.commitSha, graphDigest: `sha256:${snapshot.sourceGraphDigest}`,
      provider: 'graphify', parserVersion: snapshot.parserVersion,
      schemaVersion: snapshot.graphSchemaVersion!, status: 'ready', immutable: true,
    },
    query: { seed: null, q: '*', nodeTypes: ['file', 'symbol'], edgeTypes: [], direction: 'both', depth: 1, limit: 100 },
    nodes: [{ id: 'file:1', type: 'file', label: 'server.ts', href: null, metadata: { path: 'src/server.ts' } }],
    edges: [],
    truncated: false,
    truncationReasons: [],
    nextCursor: null,
    appliedLimits: { maxDepth: 3, maxNodes: 400, maxEdges: 800, maxResponseBytes: 262144, requestedDepth: 1, requestedLimit: 100, returnedNodes: 1, returnedEdges: 0, elapsedMs: 5 },
    authorizedLinks: [],
  };
}

function overview(): RepositoryGraphOverview {
  return {
    schemaVersion: 1,
    snapshot: neighborhood().snapshot,
    totals: { files: 1, symbols: 1, edges: 1, documents: 2, testFiles: 0, modules: 1, dependencies: 0 },
    modules: [{ id: 'module:c3Jj', path: 'src', fileCount: 1, symbolCount: 1, documentCount: 2, testFileCount: 0, languages: { typescript: 1 } }],
    dependencies: [],
    truncated: false,
    appliedLimits: { maxModules: 40, maxDependencies: 120, maxLanguagesPerModule: 8, returnedModules: 1, returnedDependencies: 0, elapsedMs: 4 },
  };
}

describe('RepositoryGraphDialog', () => {
  it('opens the immutable snapshot with a bounded overview and closes with Escape', async () => {
    const onClose = vi.fn();
    const graphLoader = vi.fn<RepositoryGraphLoader>().mockResolvedValue(neighborhood());
    const overviewLoader = vi.fn<RepositoryGraphOverviewLoader>().mockResolvedValue(overview());
    render(<RepositoryGraphDialog snapshot={snapshot} loadGraph={graphLoader} loadOverview={overviewLoader} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Graphify snapshot 42 for argus-project/argus-core' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    await waitFor(() => expect(overviewLoader).toHaveBeenCalledWith('42', expect.any(AbortSignal)));
    expect(graphLoader).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Repository graph' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Repository graph scope')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Immutable snapshot identity')).toHaveTextContent(snapshot.commitSha);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
