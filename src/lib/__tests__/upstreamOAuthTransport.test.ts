import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { postOAuthForm, readOAuthTokenResponse } from '../upstreamOAuthTransport.js';

beforeEach(() => {
  process.env['MCP_API_KEYS'] = 'test-key';
  process.env['SESSION_SECRET'] = 's'.repeat(32);
  process.env['DB_ENCRYPTION_KEY'] = 'e'.repeat(64);
});
afterEach(() => { jest.restoreAllMocks(); });
describe('OAuth transport', () => {
  it('bounds requests and never follows a redirect with credentials', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await postOAuthForm('https://8.8.8.8/token', new URLSearchParams({ code: 'fixture' }));
    expect(spy).toHaveBeenCalledWith('https://8.8.8.8/token', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });
  it.each(['file:///etc/passwd', 'https://user:secret@8.8.8.8/token', 'http://169.254.169.254/token'])('does not send credentials to unsafe target %s', async url => {
    const spy = jest.spyOn(globalThis, 'fetch');
    await expect(postOAuthForm(url, new URLSearchParams())).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
  it('does not expose failed fetch details', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-code'));
    await expect(postOAuthForm('https://8.8.8.8/token', new URLSearchParams())).rejects.toThrow('OAuth endpoint transport failed');
  });
  it('does not expose an OAuth error body', async () => {
    await expect(readOAuthTokenResponse(new Response('private-token-and-code', { status: 400 }))).rejects.toThrow('HTTP 400');
  });
  it('accepts valid bearer tokens and preserves an explicitly empty scope', async () => {
    expect(await readOAuthTokenResponse(Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: '' })))
      .toEqual({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: '', username: undefined });
  });
  it.each([
    {}, [], null, { access_token: 12 }, { access_token: 'bad\nheader' },
    { access_token: 'access', refresh_token: {} }, { access_token: 'access', token_type: 'mac' },
    { access_token: 'access', expires_in: -1 }, { access_token: 'access', expires_in: '3600' },
    { access_token: 'access', scope: [] },
  ])('rejects malformed response %p', async value => {
    await expect(readOAuthTokenResponse(Response.json(value))).rejects.toThrow('Invalid OAuth token response');
  });
  it('caps response bytes before parsing', async () => {
    await expect(readOAuthTokenResponse(new Response('x'.repeat(65_537)))).rejects.toThrow('safely');
  });
});
