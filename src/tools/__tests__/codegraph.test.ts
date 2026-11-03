import { executeCodegraphTool, CODEGRAPH_TOOLS } from '../codegraph.js';

// Mock the workspace-exec HTTP call
const fetchMock = jest.fn();
beforeEach(() => { fetchMock.mockReset(); global.fetch = fetchMock as unknown as typeof fetch; });

const stdoutResponse = (stdout: string) => new Response(JSON.stringify({
  stdout, stderr: '', exit_code: 0, duration_ms: 42,
}), { status: 200 });

describe('CODEGRAPH_TOOLS catalog', () => {
  it('exposes three tools: codegraph_query, codegraph_path, codegraph_explain', () => {
    const names = CODEGRAPH_TOOLS.map(t => t.function.name).sort();
    expect(names).toEqual(['codegraph_explain', 'codegraph_path', 'codegraph_query']);
  });
});

describe('executeCodegraphTool', () => {
  it('codegraph_query shells `graphify query "<q>" --budget <n>`', async () => {
    fetchMock.mockResolvedValueOnce(stdoutResponse('NODE foo\nEDGE foo->bar\n'));
    const r = await executeCodegraphTool('codegraph_query', { question: 'how does X work?', budget: 1500 }, '/workspace/ARGUS-42');
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('NODE foo');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/exec'),
      expect.objectContaining({
        body: expect.stringContaining('graphify query'),
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { cmd: string; cwd: string };
    expect(body.cmd).toContain('--budget 1500');
    expect(body.cwd).toBe('/workspace/ARGUS-42');
  });

  it('codegraph_path shells `graphify path "<A>" "<B>"`', async () => {
    fetchMock.mockResolvedValueOnce(stdoutResponse('a -> b -> c'));
    const r = await executeCodegraphTool('codegraph_path', { from: 'agentRunner', to: 'EntraSidecarClient' }, '/workspace/ARGUS-42');
    expect(r.content[0]?.text).toBe('a -> b -> c');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { cmd: string };
    expect(body.cmd).toBe('graphify path "agentRunner" "EntraSidecarClient"');
  });

  it('codegraph_explain shells `graphify explain "<X>"`', async () => {
    fetchMock.mockResolvedValueOnce(stdoutResponse('Node: X\nConnections: ...'));
    const r = await executeCodegraphTool('codegraph_explain', { concept: 'EntraSidecarClient' }, '/workspace/ARGUS-42');
    expect(r.content[0]?.text).toContain('Node: X');
  });

  it('returns isError=true when graphify exits non-zero', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      stdout: '', stderr: 'graph.json not found', exit_code: 1, duration_ms: 5,
    }), { status: 200 }));
    const r = await executeCodegraphTool('codegraph_query', { question: 'x' }, '/workspace/ARGUS-42');
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('graph.json not found');
  });

  it('escapes shell-special characters in user input', async () => {
    fetchMock.mockResolvedValueOnce(stdoutResponse('ok'));
    await executeCodegraphTool('codegraph_query', { question: 'foo"; rm -rf /' }, '/workspace/ARGUS-42');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { cmd: string };
    // Inner double-quote must be escaped so the rm command is NOT separated from the quoted string
    expect(body.cmd).not.toMatch(/"; rm -rf/);
  });

  it('rejects unknown tool name', async () => {
    await expect(executeCodegraphTool('codegraph_nope', {})).rejects.toThrow(/unknown/i);
  });

  it('refuses to query the shared workspace root without an exact execution scope', async () => {
    await expect(executeCodegraphTool('codegraph_query', { question: 'x' }))
      .rejects.toThrow(/exact execution-grant-bound workspace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
