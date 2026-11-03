import { afterEach, describe, expect, it, vi } from 'vitest';
import { anchorAuditEvidencePack, ApiRequestError, downloadAuditReportArtifact } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('audit report artifact downloads', () => {
  it('uses a fresh idempotency key when requesting an external anchor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      anchor: { anchorId: 'anchor-1' }, auditEventId: 'event-1', replayed: false,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await anchorAuditEvidencePack('report-1', 'worm_object');

    expect(fetchMock).toHaveBeenCalledWith('/api/ui/audit/report-runs/v1/report-1/external-anchors', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) }),
      body: JSON.stringify({ anchorKind: 'worm_object' }),
    }));
  });

  it('preserves the server filename, content type and digest', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      status: 200,
      headers: {
        'content-type': 'application/vnd.argus.audit-artifact',
        'content-digest': 'sha-256=:test:',
        'x-argus-artifact-content-type': 'application/pdf',
        'x-argus-artifact-filename': 'argus-audit-report-123.pdf',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const artifact = await downloadAuditReportArtifact('123', 'pdf');

    expect(fetchMock).toHaveBeenCalledWith('/api/ui/audit/report-runs/v1/123/artifacts/pdf/content', expect.objectContaining({ credentials: 'same-origin' }));
    expect(artifact.filename).toBe('argus-audit-report-123.pdf');
    expect(artifact.blob.type).toBe('application/pdf');
    expect(artifact.blob.size).toBe(4);
    expect(artifact.contentDigest).toBe('sha-256=:test:');
  });

  it('explains an empty response caused by a browser download interceptor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(downloadAuditReportArtifact('123', 'csv')).rejects.toMatchObject({
      code: 'EMPTY_REPORT_ARTIFACT',
    } satisfies Partial<ApiRequestError>);
  });
});
