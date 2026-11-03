import { EntraSidecarClient } from '../entra.js';

const fetchMock = jest.fn();
beforeEach(() => { fetchMock.mockReset(); global.fetch = fetchMock as unknown as typeof fetch; });

describe('EntraSidecarClient', () => {
  const client = new EntraSidecarClient({ sidecarUrl: 'http://localhost:5000', envSlug: 'test' });

  it('createAgentSP issues POST to sidecar with displayName and blueprintId', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      objectId: '11111111-1111-1111-1111-111111111111',
      appId:    '22222222-2222-2222-2222-222222222222',
      displayName: 'argus-agent-test-my-worker',
      blueprintId: 'argus-test-worker',
    }), { status: 201 }));

    const sp = await client.createAgentSP({
      agentName: 'my-worker', blueprintId: 'argus-test-worker',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5000/blueprints/argus-test-worker/spawn',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ displayName: 'argus-agent-test-my-worker' }),
      }),
    );
    expect(sp.objectId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('createAgentSP throws EntraError with graphCode on 403', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' },
    }), { status: 403 }));

    await expect(client.createAgentSP({ agentName: 'x', blueprintId: 'b' }))
      .rejects.toThrow(/Authorization_RequestDenied/);
  });

  it('deleteAgentSP issues DELETE and returns true on 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.deleteAgentSP('11111111-1111-1111-1111-111111111111')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5000/servicePrincipals/11111111-1111-1111-1111-111111111111',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deleteAgentSP returns false when SP already gone (404)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(client.deleteAgentSP('id')).resolves.toBe(false);
  });

  it('getHealth returns true when sidecar /health responds 200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));
    await expect(client.getHealth()).resolves.toBe(true);
  });
});
