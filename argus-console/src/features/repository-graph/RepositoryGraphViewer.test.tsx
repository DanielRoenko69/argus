import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepositoryGraphViewer } from './RepositoryGraphViewer';
import type { RepositoryFullGraph, RepositoryFullGraphLoader, RepositoryGraphLoader, RepositoryGraphNeighborhood, RepositoryGraphNode, RepositoryGraphOverview, RepositoryGraphOverviewLoader } from './types';

function neighborhood(overrides: Partial<RepositoryGraphNeighborhood> = {}): RepositoryGraphNeighborhood {
  return {
    schemaVersion: 1,
    snapshot: {
      id: '42', repository: 'argus-project/argus-core', branch: 'main',
      commitSha: 'e623a76f00000000000000000000000000000000',
      graphDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      provider: 'graphify', parserVersion: 'tree-sitter-v1', schemaVersion: 'argus-graphify-v3',
      status: 'ready', immutable: true,
    },
    query: { seed: 'symbol:501', q: null, nodeTypes: ['file', 'symbol'], edgeTypes: [], direction: 'both', depth: 1, limit: 100 },
    nodes: [
      { id: 'symbol:501', type: 'symbol', label: 'runAgent', href: null, metadata: { filePath: 'src/agents/agentRunner.ts', kind: 'function', startLine: 400 } },
      { id: 'file:71', type: 'file', label: 'agentRunner.ts', href: null, metadata: { path: 'src/agents/agentRunner.ts', language: 'typescript' } },
    ],
    edges: [{ id: 'declares:71:501', source: 'file:71', target: 'symbol:501', type: 'declares' }],
    truncated: false,
    truncationReasons: [],
    nextCursor: null,
    appliedLimits: { maxDepth: 3, maxNodes: 400, maxEdges: 800, maxResponseBytes: 262144, requestedDepth: 1, requestedLimit: 100, returnedNodes: 2, returnedEdges: 1, elapsedMs: 8 },
    authorizedLinks: [],
    ...overrides,
  };
}

function overview(): RepositoryGraphOverview {
  return {
    schemaVersion: 1,
    snapshot: neighborhood().snapshot,
    totals: { files: 20, symbols: 64, edges: 91, documents: 22, testFiles: 4, modules: 3, dependencies: 1 },
    modules: [
      { id: 'module:c3Jj', path: 'src', fileCount: 14, symbolCount: 58, documentCount: 16, testFileCount: 3, languages: { typescript: 14 } },
      { id: 'module:dGVzdHM', path: 'tests', fileCount: 4, symbolCount: 6, documentCount: 4, testFileCount: 4, languages: { typescript: 4 } },
      { id: 'module:ZG9jcw', path: 'docs', fileCount: 2, symbolCount: 0, documentCount: 2, testFileCount: 0, languages: { markdown: 2 } },
    ],
    dependencies: [{ id: 'module-edge:c3Jj:dGVzdHM', source: 'module:c3Jj', target: 'module:dGVzdHM', relationCount: 5, relations: ['calls'] }],
    truncated: false,
    appliedLimits: { maxModules: 40, maxDependencies: 120, maxLanguagesPerModule: 8, returnedModules: 3, returnedDependencies: 1, elapsedMs: 7 },
  };
}

function completeGraph(): RepositoryFullGraph {
  return {
    schemaVersion: 1,
    snapshot: neighborhood().snapshot,
    files: [
      ['71', 'src/agents/agentRunner.ts', 'typescript', 'src'],
      ['72', 'tests/agentRunner.test.ts', 'typescript', 'tests'],
    ],
    symbols: [
      ['501', 'runAgent', 'function', 0, 400, 430],
      ['502', 'runTool', 'function', 0, 440, 470],
      ['503', 'tests runAgent', 'test', 1, 20, 40],
    ],
    relationTypes: ['calls', 'tests'],
    edges: [[0, 1, 0], [2, 0, 1]],
    truncated: false,
    truncationReasons: [],
    appliedLimits: { maxNodes: 50_000, maxEdges: 150_000, maxResponseBytes: 25_165_824, returnedNodes: 5, returnedEdges: 5, elapsedMs: 19 },
  };
}

describe('RepositoryGraphViewer', () => {
  it('keeps immutable identity visible and exposes the same nodes in a keyboard-accessible list', async () => {
    const loader = vi.fn<RepositoryGraphLoader>().mockResolvedValue(neighborhood());
    render(<RepositoryGraphViewer snapshotId="42" initialEntry={{ kind: 'seed', value: 'symbol:501' }} loadGraph={loader} />);

    const identity = await screen.findByLabelText('Immutable snapshot identity');
    expect(identity).toHaveTextContent('e623a76f00000000000000000000000000000000');
    expect(identity).toHaveTextContent('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(screen.getByRole('button', { name: 'symbol runAgent' })).toHaveAttribute('tabindex', '0');

    fireEvent.click(screen.getByRole('button', { name: /Accessible list/ }));
    const table = screen.getByRole('table', { name: /Nodes in the current/ });
    expect(within(table).getByRole('button', { name: 'runAgent' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(table).getByRole('button', { name: 'agentRunner.ts' }));
    expect(screen.getByLabelText('Graph node details')).toHaveTextContent('src/agents/agentRunner.ts');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('starts with bounded search and applies graph filters', async () => {
    const loader = vi.fn<RepositoryGraphLoader>().mockResolvedValue(neighborhood({ query: { seed: null, q: 'runAgent', nodeTypes: ['symbol'], edgeTypes: [], direction: 'outbound', depth: 2, limit: 100 } }));
    render(<RepositoryGraphViewer snapshotId="42" loadGraph={loader} />);

    expect(screen.getByText('Start with a bounded search')).toBeInTheDocument();
    expect(loader).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Find a file or symbol'), { target: { value: 'runAgent' } });
    fireEvent.click(screen.getByLabelText('Files'));
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'outbound' } });
    fireEvent.change(screen.getByLabelText('Depth'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(loader).toHaveBeenCalledWith(expect.objectContaining({
      snapshotId: '42', entry: { kind: 'search', value: 'runAgent' }, nodeTypes: ['symbol'],
      direction: 'outbound', depth: 2, limit: 100,
    }), expect.any(AbortSignal)));
  });

  it('focuses a clicked code node and its loaded direct neighbors without another request', async () => {
    const disconnected: RepositoryGraphNode = { id: 'symbol:999', type: 'symbol', label: 'unrelatedHelper', href: null, metadata: { filePath: 'src/unrelated.ts' } };
    const loader = vi.fn<RepositoryGraphLoader>().mockResolvedValue(neighborhood({
      nodes: [...neighborhood().nodes, disconnected],
    }));
    render(<RepositoryGraphViewer snapshotId="42" initialEntry={{ kind: 'seed', value: 'symbol:501' }} loadGraph={loader} />);

    expect(await screen.findByRole('button', { name: 'symbol unrelatedHelper' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'symbol runAgent' }));

    expect(screen.queryByRole('button', { name: 'symbol unrelatedHelper' })).not.toBeInTheDocument();
    expect(screen.getByText('2 visible of 3 loaded nodes · 1 direct relation · 8 ms')).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show loaded neighborhood' }));
    expect(screen.getByRole('button', { name: 'symbol unrelatedHelper' })).toBeInTheDocument();
  });

  it('merges a selected node expansion without repeating successful nodes', async () => {
    const addedNode: RepositoryGraphNode = { id: 'symbol:502', type: 'symbol', label: 'runTool', href: null, metadata: { filePath: 'src/tools.ts' } };
    const loader = vi.fn<RepositoryGraphLoader>()
      .mockResolvedValueOnce(neighborhood())
      .mockResolvedValueOnce(neighborhood({
        query: { seed: 'symbol:501', q: null, nodeTypes: ['file', 'symbol'], edgeTypes: [], direction: 'both', depth: 1, limit: 100 },
        nodes: [neighborhood().nodes[0]!, addedNode],
        edges: [{ id: 'calls:501:502', source: 'symbol:501', target: 'symbol:502', type: 'calls' }],
      }));
    render(<RepositoryGraphViewer snapshotId="42" initialEntry={{ kind: 'seed', value: 'symbol:501' }} loadGraph={loader} />);

    await screen.findByText('2 nodes · 1 relations · 8 ms');
    fireEvent.click(screen.getByRole('button', { name: /Load direct neighborhood/ }));
    await screen.findByText('3 visible of 3 loaded nodes · 2 direct relations · 8 ms');
    expect(loader).toHaveBeenLastCalledWith(expect.objectContaining({ entry: { kind: 'seed', value: 'symbol:501' } }), expect.any(AbortSignal));
  });

  it('aborts a stale request when another snapshot is opened', async () => {
    let firstSignal: AbortSignal | undefined;
    const loader = vi.fn<RepositoryGraphLoader>()
      .mockImplementationOnce((_request, signal) => {
        firstSignal = signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValueOnce(neighborhood({ snapshot: { ...neighborhood().snapshot, id: '43' } }));
    const entry = { kind: 'seed', value: 'symbol:501' } as const;
    const rendered = render(<RepositoryGraphViewer snapshotId="42" initialEntry={entry} loadGraph={loader} />);
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    rendered.rerender(<RepositoryGraphViewer snapshotId="43" initialEntry={entry} loadGraph={loader} />);
    expect(await screen.findByLabelText('Immutable snapshot identity')).toHaveTextContent('argus-project/argus-core · main · graphify');
    expect(firstSignal?.aborted).toBe(true);
  });

  it('marks client-side truncation and retries a failed first request', async () => {
    const manyNodes: RepositoryGraphNode[] = Array.from({ length: 201 }, (_, index) => ({ id: `symbol:${index}`, type: 'symbol', label: `symbol${index}`, href: null, metadata: {} }));
    const loader = vi.fn<RepositoryGraphLoader>()
      .mockRejectedValueOnce(new Error('Temporary graph failure'))
      .mockResolvedValueOnce(neighborhood({ nodes: manyNodes, edges: [] }));
    render(<RepositoryGraphViewer snapshotId="42" initialEntry={{ kind: 'search', value: 'symbol' }} loadGraph={loader} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary graph failure');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByText(/first 200 nodes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Accessible list/ }));
    expect(within(screen.getByRole('table', { name: /Nodes in the current/ })).getAllByRole('row')).toHaveLength(201);
  });

  it('opens with architecture and drills from a module into its bounded code neighborhood', async () => {
    const overviewLoader = vi.fn<RepositoryGraphOverviewLoader>().mockResolvedValue(overview());
    const graphLoader = vi.fn<RepositoryGraphLoader>().mockResolvedValue(neighborhood({
      query: { seed: null, q: 'src/', nodeTypes: ['file', 'symbol'], edgeTypes: [], direction: 'both', depth: 1, limit: 100 },
    }));
    render(<RepositoryGraphViewer snapshotId="42" initialView="architecture" loadOverview={overviewLoader} loadGraph={graphLoader} />);

    expect(await screen.findByRole('heading', { name: 'Repository graph' })).toBeInTheDocument();
    expect(screen.getByLabelText('Architecture summary')).toHaveTextContent('20');
    expect(screen.getByRole('button', { name: 'module src' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'module docs' })).toBeInTheDocument();
    expect(overviewLoader).toHaveBeenCalledWith('42', expect.any(AbortSignal));
    expect(graphLoader).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'module src' }));
    expect(screen.queryByRole('button', { name: 'module docs' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'module tests' })).toBeInTheDocument();
    expect(screen.getByLabelText('Repository graph path')).toHaveTextContent('src');

    fireEvent.click(screen.getByRole('button', { name: 'Show full architecture' }));
    expect(screen.getByRole('button', { name: 'module docs' })).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: 'module src' }));

    await waitFor(() => expect(graphLoader).toHaveBeenCalledWith(expect.objectContaining({
      snapshotId: '42', entry: { kind: 'search', value: 'src/' }, depth: 1, limit: 100,
    }), expect.any(AbortSignal)));
    expect(screen.getByLabelText('Repository graph path')).toHaveTextContent('srcCode neighborhood');
    expect(screen.queryByLabelText('Repository graph scope')).not.toBeInTheDocument();
  });

  it('keeps the full architecture readable by previewing only its strongest dependencies', async () => {
    const modules = Array.from({ length: 14 }, (_, index) => ({
      id: `module:${index}`,
      path: `module-${index}`,
      fileCount: 1,
      symbolCount: 1,
      documentCount: 1,
      testFileCount: 0,
      languages: { typescript: 1 },
    }));
    const dependencies = modules.slice(1).map((module, index) => ({
      id: `edge:${index}`,
      source: modules[0]!.id,
      target: module.id,
      relationCount: index + 1,
      relations: ['calls'],
    }));
    const boundedOverview: RepositoryGraphOverview = {
      ...overview(),
      totals: { ...overview().totals, modules: modules.length, dependencies: dependencies.length },
      modules,
      dependencies,
      appliedLimits: { ...overview().appliedLimits, returnedModules: modules.length, returnedDependencies: dependencies.length },
    };
    const overviewLoader = vi.fn<RepositoryGraphOverviewLoader>().mockResolvedValue(boundedOverview);
    render(<RepositoryGraphViewer snapshotId="42" initialView="architecture" loadOverview={overviewLoader} />);

    expect(await screen.findByText(/14 modules · 12 of 13 strongest dependencies/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'module module-0' }));
    expect(screen.getByText(/14 visible modules · 13 direct dependencies/)).toBeInTheDocument();
  });

  it('loads the complete file, function and relationship graph with one button and no drill-down', async () => {
    const context = {
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(),
      fillText: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), translate: vi.fn(),
      scale: vi.fn(), drawImage: vi.fn(), restore: vi.fn(),
    };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const fullLoader = vi.fn<RepositoryFullGraphLoader>().mockResolvedValue(completeGraph());
    const graphLoader = vi.fn<RepositoryGraphLoader>();
    render(<RepositoryGraphViewer
      snapshotId="42"
      initialView="architecture"
      loadOverview={vi.fn<RepositoryGraphOverviewLoader>().mockResolvedValue(overview())}
      loadGraph={graphLoader}
      loadFullGraph={fullLoader}
    />);

    fireEvent.click(await screen.findByRole('button', { name: /Show complete code graph/ }));

    await waitFor(() => expect(fullLoader).toHaveBeenCalledWith('42', expect.any(AbortSignal)));
    expect(await screen.findByRole('img', { name: /Complete repository graph with 5 nodes and 5 relations/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Complete repository graph controls')).toHaveTextContent('Canvas overview · no drill-down required');
    expect(screen.getByLabelText('Repository graph path')).toHaveTextContent('Complete code graph');
    expect(graphLoader).not.toHaveBeenCalled();
    getContext.mockRestore();
  });
});
