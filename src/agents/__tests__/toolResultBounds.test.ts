import { boundAgentToolResult } from '../toolResultBounds.js';

describe('boundAgentToolResult', () => {
  it('retains small provider results unchanged', () => {
    expect(boundAgentToolResult('aiops_prometheus_query', '{"status":"success"}', 4096))
      .toBe('{"status":"success"}');
  });

  it('projects large Kubernetes event lists into bounded valid JSON with newest events first', () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      kind: 'Event',
      lastTimestamp: new Date(Date.UTC(2026, 7, 13, 20, index)).toISOString(),
      message: `event-${index}-${'x'.repeat(300)}`,
      metadata: {
        name: `event-${index}`,
        managedFields: [{ very: 'large' }],
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': 'noise' },
      },
    }));
    const bounded = boundAgentToolResult(
      'aiops_kubernetes_k8s_get_events',
      JSON.stringify({ apiVersion: 'v1', kind: 'List', items }),
      8_192,
    );

    expect(bounded.length).toBeLessThanOrEqual(8_192);
    const parsed = JSON.parse(bounded) as { items: Array<{ message: string; metadata: Record<string, unknown> }>; argusProjection: { truncated: boolean; originalItemCount: number } };
    expect(parsed.argusProjection).toEqual(expect.objectContaining({ truncated: true, originalItemCount: 100 }));
    expect(parsed.items[0]?.message).toContain('event-99-');
    expect(parsed.items[0]?.metadata).not.toHaveProperty('managedFields');
  });

  it('projects large GitHub text resources with deterministic size and line evidence', () => {
    const text = Array.from({ length: 6_788 }, (_, index) => `line-${index + 1}`).join('\n');
    const raw = [
      'successfully downloaded text file (SHA: abc123)',
      JSON.stringify({
        type: 'resource',
        resource: {
          uri: 'repo://argus-project/argus_core/contents/src/index.ts',
          mimeType: 'text/plain; charset=utf-8',
          text,
        },
      }),
    ].join('\n');

    const bounded = boundAgentToolResult('github_argus_core_get_file_contents', raw, 512 * 1_024);
    const parsed = JSON.parse(bounded) as {
      resource: { text: string };
      argusProjection: {
        truncated: boolean;
        originalCharacterCount: number;
        originalByteCount: number;
        originalLineCount: number;
        retainedCharacterCount: number;
      };
    };

    expect(bounded.length).toBeLessThanOrEqual(64 * 1_024);
    expect(parsed.argusProjection).toEqual(expect.objectContaining({
      truncated: true,
      originalCharacterCount: text.length,
      originalByteCount: Buffer.byteLength(text, 'utf8'),
      originalLineCount: 6_788,
    }));
    expect(parsed.argusProjection.retainedCharacterCount).toBeLessThan(text.length);
    expect(parsed.resource.text).toContain('[ARGUS: middle of text resource omitted');
  });

  it('marks oversized non-JSON output as truncated', () => {
    const bounded = boundAgentToolResult('generic_tool', 'x'.repeat(10_000), 2_048);
    expect(bounded.length).toBeLessThanOrEqual(2_048);
    expect(bounded).toContain('[ARGUS: tool result truncated');
  });
});
