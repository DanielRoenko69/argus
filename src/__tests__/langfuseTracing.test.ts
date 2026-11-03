/**
 * Tests for src/lib/langfuseTracing.ts
 *
 * Strategy: jest.mock the langfuseClient module to inject a recording
 * fake. Walks the trace/span/generation tree to verify structure,
 * lifecycle (every node ends), and error-path behavior.
 */

interface RecordedNode {
  type: 'trace' | 'span' | 'generation';
  params: Record<string, unknown>;
  ended: { level?: string; output?: unknown; usage?: unknown; metadata?: unknown; statusMessage?: string } | null;
  updates: Array<Record<string, unknown>>;
  children: RecordedNode[];
}

const recorded: RecordedNode[] = [];
const flushCount = { n: 0 };
const clientCtl = { enabled: true };

function makeGen(params: Record<string, unknown>, parent: RecordedNode): any {
  const node: RecordedNode = { type: 'generation', params, ended: null, updates: [], children: [] };
  parent.children.push(node);
  return {
    id: `gen-${Math.random().toString(36).slice(2, 8)}`,
    end:    (p: Record<string, unknown>) => { node.ended = p as RecordedNode['ended']; },
    update: (p: Record<string, unknown>) => { node.updates.push(p); },
  };
}

function makeSpan(params: Record<string, unknown>, parent: RecordedNode): any {
  const node: RecordedNode = { type: 'span', params, ended: null, updates: [], children: [] };
  parent.children.push(node);
  return {
    id: `span-${Math.random().toString(36).slice(2, 8)}`,
    end:        (p: Record<string, unknown>) => { node.ended = p as RecordedNode['ended']; },
    update:     (p: Record<string, unknown>) => { node.updates.push(p); },
    span:       (p: Record<string, unknown>) => makeSpan(p, node),
    generation: (p: Record<string, unknown>) => makeGen(p, node),
    event:      () => {},
  };
}

function makeTrace(params: Record<string, unknown>): any {
  const node: RecordedNode = { type: 'trace', params, ended: null, updates: [], children: [] };
  recorded.push(node);
  return {
    id: (params['id'] as string | undefined) ?? `trace-${Math.random().toString(36).slice(2, 8)}`,
    span:       (p: Record<string, unknown>) => makeSpan(p, node),
    generation: (p: Record<string, unknown>) => makeGen(p, node),
    event:      () => {},
    update:     (p: Record<string, unknown>) => { node.updates.push(p); },
    score:      () => {},
  };
}

const fakeClient = {
  trace: (params: Record<string, unknown>) => makeTrace(params),
  flushAsync: async () => { flushCount.n++; },
};

// jest.mock is hoisted; the factory closure captures clientCtl by reference.
jest.mock('../lib/langfuseClient.js', () => ({
  getLangfuseClient: () => (clientCtl.enabled ? fakeClient : null),
  isLangfuseConfigured: () => clientCtl.enabled,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withTrace, isTracingEnabled } = require('../lib/langfuseTracing.js') as typeof import('../lib/langfuseTracing.js');

beforeEach(() => {
  recorded.length = 0;
  flushCount.n = 0;
  clientCtl.enabled = true;
});

// ───────────────────────────────────────────────────────────────────

describe('withTrace — real mode', () => {
  test('emits a trace with given name, tags, and metadata', async () => {
    const result = await withTrace(
      { name: 'agent.chat', sessionId: 's1', userId: 'u1', tags: ['a:b'], metadata: { agent_id: 5 }, input: 'hi' },
      async () => 'ok',
    );
    expect(result).toBe('ok');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.params['name']).toBe('agent.chat');
    expect(recorded[0]!.params['sessionId']).toBe('s1');
    expect(recorded[0]!.params['userId']).toBe('u1');
    expect(recorded[0]!.params['tags']).toEqual(['a:b']);
  });

  test('nested span + generation produce correct parent hierarchy', async () => {
    await withTrace({ name: 'agent.chat' }, async (trace) => {
      await trace.span({ name: 'rag.search' }, async (span) => {
        await span.generation(
          { name: 'rag.embedQuery', model: 'text-embedding-3-large', input: 'q' },
          async (gen) => {
            gen.setUsage({ input: 9, output: 0, total: 9 });
            gen.setOutput({ dim: 3072 });
          },
        );
      });
    });

    expect(recorded).toHaveLength(1);
    const trace = recorded[0]!;
    expect(trace.children).toHaveLength(1);
    expect(trace.children[0]!.type).toBe('span');
    expect(trace.children[0]!.params['name']).toBe('rag.search');
    expect(trace.children[0]!.children).toHaveLength(1);
    expect(trace.children[0]!.children[0]!.type).toBe('generation');
    expect(trace.children[0]!.children[0]!.params['model']).toBe('text-embedding-3-large');
  });

  test('every span and generation is ended on success', async () => {
    await withTrace({ name: 'agent.chat' }, async (trace) => {
      await trace.span({ name: 'rag.search' }, async (span) => {
        await span.generation({ name: 'rag.embedQuery', model: 'm' }, async () => {});
      });
    });

    const trace = recorded[0]!;
    const span = trace.children[0]!;
    const gen  = span.children[0]!;
    expect(span.ended).not.toBeNull();
    expect(span.ended!.level).toBe('DEFAULT');
    expect(gen.ended).not.toBeNull();
    expect(gen.ended!.level).toBe('DEFAULT');
    expect(trace.updates).toHaveLength(1); // trace.update() at end
  });

  test('error inside span marks span ERROR and rethrows', async () => {
    await expect(
      withTrace({ name: 'agent.chat' }, async (trace) => {
        await trace.span({ name: 'rag.search' }, async () => {
          throw new Error('boom');
        });
      }),
    ).rejects.toThrow('boom');

    const trace = recorded[0]!;
    expect(trace.children[0]!.ended!.level).toBe('ERROR');
    expect(trace.children[0]!.ended!.statusMessage).toBe('boom');
    expect(trace.updates[0]!['output']).toBe('ERROR: boom');
  });

  test('setOutput on trace flows into trace.update()', async () => {
    await withTrace({ name: 'agent.chat' }, async (trace) => {
      trace.setOutput('final-answer');
    });
    expect(recorded[0]!.updates[0]!['output']).toBe('final-answer');
  });

  test('setUsage maps to Langfuse usage shape with TOKENS unit', async () => {
    await withTrace({ name: 'agent.chat' }, async (trace) => {
      await trace.generation({ name: 'g', model: 'm' }, async (gen) => {
        gen.setUsage({
          input: 100, output: 50,
          inputCost: 0.001, totalCost: 0.0015,
          cacheReadInputTokens: 80, cacheCreationInputTokens: 20,
        });
      });
    });
    const usage = recorded[0]!.children[0]!.ended!.usage as Record<string, unknown>;
    expect(usage['input']).toBe(100);
    expect(usage['output']).toBe(50);
    expect(usage['total']).toBe(150);
    expect(usage['unit']).toBe('TOKENS');
    expect(usage['inputCost']).toBe(0.001);
    expect(usage['inputDetails']).toEqual({
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    });
  });

  test('flushAsync called after success and after error', async () => {
    await withTrace({ name: 'a' }, async () => 'ok');
    expect(flushCount.n).toBe(1);

    await expect(
      withTrace({ name: 'a' }, async () => { throw new Error('x'); }),
    ).rejects.toThrow('x');
    expect(flushCount.n).toBe(2);
  });

  test('isTracingEnabled mirrors isLangfuseConfigured', () => {
    expect(isTracingEnabled()).toBe(true);
  });
});

describe('withTrace — no-op mode (client null)', () => {
  test('still runs the user fn and returns its result, no recording', async () => {
    clientCtl.enabled = false;
    const r = await withTrace({ name: 'agent.chat' }, async (t) => {
      expect(t.enabled).toBe(false);
      const inner = await t.span({ name: 'rag' }, async (s) => {
        expect(s.enabled).toBe(false);
        return await s.generation({ name: 'g', model: 'm' }, async (g) => {
          expect(g.enabled).toBe(false);
          return 42;
        });
      });
      return inner * 2;
    });
    expect(r).toBe(84);
    expect(recorded).toHaveLength(0);
  });
});
