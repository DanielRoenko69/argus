import { ensureCodegraphReady } from '../codegraphPrejob.js';

const fetchMock = jest.fn();
beforeEach(() => { fetchMock.mockReset(); global.fetch = fetchMock as unknown as typeof fetch; });

const okExec = (stdout = '') => new Response(JSON.stringify({
  stdout, stderr: '', exit_code: 0, duration_ms: 100,
}), { status: 200 });

const failExec = (stderr: string) => new Response(JSON.stringify({
  stdout: '', stderr, exit_code: 1, duration_ms: 50,
}), { status: 200 });

describe('ensureCodegraphReady', () => {
  it('skips silently when codegraph_enabled is false', async () => {
    await ensureCodegraphReady({ codegraph_enabled: false, gitea_project: 'org/repo' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when no gitea_project on the agent', async () => {
    await ensureCodegraphReady({ codegraph_enabled: true, gitea_project: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('locally excludes generated graph evidence before running `graphify update .`', async () => {
    fetchMock.mockResolvedValueOnce(okExec('updated 5 files'));
    await ensureCodegraphReady({
      codegraph_enabled: true,
      gitea_project: 'org/repo',
      workspace_dir: '/workspace/ARGUS-123',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as {
      cmd: string;
      cwd: string;
      timeoutSec: number;
    };
    expect(body.cmd).toContain('graphify update');
    expect(body.cmd).toContain('git rev-parse --git-dir');
    expect(body.cmd).toContain('/graphify-out/');
    expect(body.cmd).not.toContain('.gitignore');
    expect(body.cwd).toBe('/workspace/ARGUS-123');
    expect(body.timeoutSec).toBe(120);
  });

  it('refuses to index without an exact execution workspace', async () => {
    await ensureCodegraphReady({
      codegraph_enabled: true,
      gitea_project: 'org/repo',
      workspace_dir: '/workspace',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws on graphify failure — fail-open like the entra hook', async () => {
    fetchMock.mockResolvedValueOnce(failExec('graphify crashed'));
    await expect(ensureCodegraphReady({
      codegraph_enabled: true,
      gitea_project: 'org/repo',
      workspace_dir: '/workspace/ARGUS-123',
    })).resolves.toBeUndefined();
  });

  it('never throws on network failure (workspace sidecar down)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(ensureCodegraphReady({
      codegraph_enabled: true,
      gitea_project: 'org/repo',
      workspace_dir: '/workspace/ARGUS-123',
    })).resolves.toBeUndefined();
  });
});
