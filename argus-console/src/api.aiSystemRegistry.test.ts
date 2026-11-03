import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyAiSystem, createAiSystem, getAiSystemRegistryDetail, releaseAiSystem } from './api';
import type { AiSystemClassificationInput, AiSystemCreateInput, AiSystemReleaseInput } from './types';

afterEach(() => vi.unstubAllGlobals());

const response = () => new Response(JSON.stringify({ schemaVersion: 1, kind: 'ai-system-registry-detail', aiSystem: {} }), {
  status: 201,
  headers: { 'content-type': 'application/json' },
});

describe('AI-system registry API', () => {
  it('reads one immutable registry detail', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    await getAiSystemRegistryDetail('10000000-0000-4000-8000-000000000001');
    expect(fetchMock).toHaveBeenCalledWith('/api/ui/compliance/ai-systems/10000000-0000-4000-8000-000000000001', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('creates a registry draft with a unique operation identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    const input = { displayName: 'Claims copilot' } as AiSystemCreateInput;
    await createAiSystem(input);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ui/compliance/ai-systems');
    expect(init.headers).toEqual(expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^console-ai-system-create-/) }));
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it('pins classification and release decisions to the selected revision', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    const classification = { expectedRevision: 4, expectedRevisionSha256: 'a'.repeat(64) } as AiSystemClassificationInput;
    const release = { expectedRevision: 5, expectedRevisionSha256: 'b'.repeat(64) } as AiSystemReleaseInput;
    await classifyAiSystem('10000000-0000-4000-8000-000000000001', classification);
    await releaseAiSystem('10000000-0000-4000-8000-000000000001', release);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/classifications$/);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^console-ai-system-classify-/) }) }));
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/release$/);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^console-ai-system-release-/) }) }));
  });
});
