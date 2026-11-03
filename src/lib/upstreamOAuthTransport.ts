import { lookup } from 'node:dns/promises';
import { assertSsrfSafeResolved, assertEgressAllowed } from '../backends/customBackends.js';

/** Never include provider bodies, URLs, codes or credentials in thrown errors. */
export async function postOAuthForm(url: string, form: URLSearchParams, headers: Record<string, string> = {}): Promise<Response> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) {
    throw new Error('Invalid OAuth endpoint');
  }
  await assertSsrfSafeResolved(url, lookup, { failClosedOnDnsError: true });
  assertEgressAllowed(url);
  try {
    return await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
      body: form,
    });
  } catch { throw new Error('OAuth endpoint transport failed'); }
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  username?: string;
}

export async function readOAuthTokenResponse(response: Response): Promise<OAuthTokenResponse> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`OAuth token endpoint rejected request (HTTP ${response.status})`);
  }
  // No JSON parsing before a byte cap. Fetch's abort signal also bounds body reads.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OAuth token endpoint returned no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new Error('OAuth token response too large');
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('OAuth token response could not be read safely');
  } finally { reader.releaseLock(); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('OAuth token response is not valid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid OAuth token response');
  const d = data as Record<string, unknown>;
  const validToken = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 32_768 && !/\s|[\x00-\x1f\x7f]/.test(v);
  if (!validToken(d.access_token)
    || (d.refresh_token !== undefined && !validToken(d.refresh_token))
    || (d.token_type !== undefined && (typeof d.token_type !== 'string' || d.token_type.toLowerCase() !== 'bearer'))
    || (d.expires_in !== undefined && (typeof d.expires_in !== 'number' || !Number.isFinite(d.expires_in) || d.expires_in <= 0 || d.expires_in > 31_536_000))
    || (d.scope !== undefined && typeof d.scope !== 'string')
    || (d.username !== undefined && typeof d.username !== 'string')) throw new Error('Invalid OAuth token response');
  return { access_token: d.access_token, refresh_token: d.refresh_token as string | undefined,
    expires_in: d.expires_in as number | undefined, scope: d.scope as string | undefined,
    username: d.username as string | undefined };
}
