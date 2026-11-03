// @vitest-environment node
// Keep Fetch response buffers and Web Crypto in one realm. Node 20 rejects
// jsdom-realm ArrayBuffers; this API-client test does not need a DOM.
import { webcrypto } from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { downloadEvaluationComparison } from './api';
const content=new TextEncoder().encode('{"test":true}');
async function response(bytes:Uint8Array=content,filename='argus-evaluation-7-123456789abc.json') {
  const hash=Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',content)),b => b.toString(16).padStart(2,'0')).join('');
  return new Response(new Uint8Array(bytes).buffer,{ headers:{ 'X-Argus-Artifact-Sha256':hash,'X-Argus-Artifact-Filename':filename } });
}
afterEach(() => vi.unstubAllGlobals());
describe('evaluation artifact client',() => {
  it('verifies bytes before returning the blob',async() => {
    vi.stubGlobal('crypto',webcrypto);const fetch=vi.fn().mockResolvedValue(await response());vi.stubGlobal('fetch',fetch);
    const result=await downloadEvaluationComparison(7,'json','stable-key');expect(result.blob.size).toBe(content.length);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/7/export/content?format=json'),expect.objectContaining({ cache:'no-store',headers:expect.objectContaining({ 'Idempotency-Key':'stable-key' }) }));
  });
  it.each(['corrupt','empty','unsafe-name'])('rejects %s artifacts',async kind => {
    vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('fetch',vi.fn().mockResolvedValue(await response(kind==='empty' ? new Uint8Array() : kind==='corrupt' ? new TextEncoder().encode('bad') : content,kind==='unsafe-name' ? '../oops.json' : undefined)));
    await expect(downloadEvaluationComparison(7,'json','stable-key')).rejects.toThrow();
  });
  it('preserves MFA error code and never treats error JSON as an export',async() => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({ error:'Fresh MFA required',code:'MFA_STEP_UP_REQUIRED' }),{ status:428 })));
    await expect(downloadEvaluationComparison(7,'json','stable-key')).rejects.toMatchObject({ status:428,code:'MFA_STEP_UP_REQUIRED' });
  });
  it('returns the PDF MIME type and checks the format-specific filename',async() => {
    vi.stubGlobal('crypto',webcrypto);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(await response(content,'argus-evaluation-7-123456789abc.pdf')));
    expect((await downloadEvaluationComparison(7,'pdf','stable-pdf-key')).blob.type).toBe('application/pdf');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(await response()));
    await expect(downloadEvaluationComparison(7,'pdf','stable-pdf-key')).rejects.toThrow(/filename/);
  });
});
