import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiRequestError,
  downloadAiComplianceDossierArtifact,
  generateAiComplianceDossier,
} from './api';

afterEach(() => vi.unstubAllGlobals());

describe('AI compliance dossier API', () => {
  it('pins the released revision and sends a unique idempotency key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ dossier: {}, auditEventId: 'event-1' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await generateAiComplianceDossier({
      aiSystemId: '10000000-0000-4000-8000-000000000001',
      revision: 3,
      revisionSha256: 'a'.repeat(64),
    }, '20000000-0000-4000-8000-000000000001');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ui/compliance/ai-systems/10000000-0000-4000-8000-000000000001/dossiers');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^console-dossier-/) }));
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRevision: 3,
      expectedRevisionSha256: 'a'.repeat(64),
      sourceReportRunId: '20000000-0000-4000-8000-000000000001',
    });
  });

  it('preserves the protected artifact filename, media type and digest', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: {
        'content-type': 'application/vnd.argus.ai-compliance-dossier-artifact',
        'content-digest': 'sha-256=:test:',
        'x-argus-artifact-content-type': 'application/octet-stream',
        'x-argus-artifact-filename': 'argus-dossier-checkpoint.sig',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const artifact = await downloadAiComplianceDossierArtifact('40000000-0000-4000-8000-000000000001', 'signature');

    expect(fetchMock).toHaveBeenCalledWith('/api/ui/compliance/dossiers/40000000-0000-4000-8000-000000000001/artifacts/signature/content', expect.objectContaining({ credentials: 'same-origin' }));
    expect(artifact.filename).toBe('argus-dossier-checkpoint.sig');
    expect(artifact.blob.type).toBe('application/octet-stream');
    expect(artifact.blob.size).toBe(4);
    expect(artifact.contentDigest).toBe('sha-256=:test:');
  });

  it('surfaces structured fail-closed errors from the dossier service', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'AI_DOSSIER_SOURCE_NOT_RELEASE_BOUND', message: 'Source report is not connected to the exact release decision' },
    }), { status: 422, headers: { 'content-type': 'application/json' } })));

    await expect(downloadAiComplianceDossierArtifact('40000000-0000-4000-8000-000000000001', 'json')).rejects.toMatchObject({
      status: 422,
      code: 'AI_DOSSIER_SOURCE_NOT_RELEASE_BOUND',
      message: 'Source report is not connected to the exact release decision',
    } satisfies Partial<ApiRequestError>);
  });
});
