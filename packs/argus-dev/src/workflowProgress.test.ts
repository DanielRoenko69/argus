import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowTestProgressReporter } from './workflowProgress.js';

test('reports one durable span lifecycle for a deterministic project phase', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const reporter = createWorkflowTestProgressReporter(
    '11111111-1111-4111-8111-111111111111',
    {
      endpoint: 'http://argus.test',
      secret: 'workspace-secret',
      fetcher: (async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ spanId: '22222222-2222-4222-8222-222222222222' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    },
  );
  const base = {
    profileId: 'node:.', runner: 'node' as const, root: '.', phase: 'setup' as const,
    label: 'npm dependency setup', command: 'npm ci',
  };

  await reporter({ ...base, status: 'started' });
  await reporter({ ...base, status: 'completed', exitCode: 0, output: 'dependencies ready' });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.['event'], 'started');
  assert.equal(requests[1]?.['event'], 'completed');
  assert.equal(requests[1]?.['spanId'], '22222222-2222-4222-8222-222222222222');
  assert.equal(requests[1]?.['output'], 'dependencies ready');
});

test('silently skips progress reporting without the internal workspace secret', async () => {
  let calls = 0;
  const reporter = createWorkflowTestProgressReporter('thread', {
    secret: '',
    fetcher: (async () => {
      calls += 1;
      return new Response();
    }) as typeof fetch,
  });

  await reporter({
    profileId: 'node:.', runner: 'node', root: '.', phase: 'test', label: 'npm test',
    command: 'npm test', status: 'started',
  });
  assert.equal(calls, 0);
});
