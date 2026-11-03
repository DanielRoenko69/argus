import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCodexTaskPolicy, getCodexRuntimeStatus, isCodexCoderRuntime, resolveCodexRuntimeConfig } from './codex.js';

test('Codex coder runtime is opt-in and case insensitive', () => {
  const previous = process.env['ARGUS_DEV_CODER_RUNTIME'];
  try {
    delete process.env['ARGUS_DEV_CODER_RUNTIME'];
    assert.equal(isCodexCoderRuntime(), false);
    process.env['ARGUS_DEV_CODER_RUNTIME'] = ' CoDeX ';
    assert.equal(isCodexCoderRuntime(), true);
    process.env['ARGUS_DEV_CODER_RUNTIME'] = 'argus';
    assert.equal(isCodexCoderRuntime(), false);
  } finally {
    if (previous === undefined) delete process.env['ARGUS_DEV_CODER_RUNTIME'];
    else process.env['ARGUS_DEV_CODER_RUNTIME'] = previous;
  }
});

test('Codex status is read through the authenticated workspace boundary', async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = '';
  try {
    globalThis.fetch = async input => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        enabled: true,
        authenticated: true,
        authMethod: 'chatgpt',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const status = await getCodexRuntimeStatus();
    assert.equal(requestedUrl, 'http://localhost:3001/codex/status');
    assert.deepEqual(status, {
      enabled: true,
      authenticated: true,
      authMethod: 'chatgpt',
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Codex status surfaces workspace-side failures', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('disabled', { status: 503 });
    await assert.rejects(getCodexRuntimeStatus(), /Codex status HTTP 503/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Codex role policy uses advisory phase budgets without a hard stop', () => {
  const review = applyCodexTaskPolicy('Review this diff.', 'review');
  const implementation = applyCodexTaskPolicy('Implement the ticket.', 'implement_ticket');
  assert.match(review, /about 6 tool calls/);
  assert.match(implementation, /about 25 tool calls/);
  assert.match(review, /soft budget: exceed it/i);
  assert.ok(review.startsWith('Review this diff.'));
});

test('Codex runtime selection gives the control-plane model and reasoning priority', () => {
  assert.deepEqual(resolveCodexRuntimeConfig({ model: ' gpt-deep ', reasoningEffort: ' xhigh ' }), {
    configuredModel: 'gpt-deep',
    reasoningEffort: 'xhigh',
    telemetryModel: 'gpt-deep',
  });
});
