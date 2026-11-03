import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compactRuntimePrompt } from './codexPrompt.js';

describe('Codex runtime prompt budget', () => {
  it('leaves prompts within the controlled budget unchanged', () => {
    const result = compactRuntimePrompt('ticket and evidence', 512);

    assert.equal(result.compacted, false);
    assert.equal(result.prompt, 'ticket and evidence');
    assert.equal(result.omittedChars, 0);
  });

  it('retains the beginning and failure tail of an oversized retry prompt', () => {
    const input = `TEST COMMAND\n${'passing output\n'.repeat(80)}FAILURE SUMMARY\nTicket and plan`;
    const result = compactRuntimePrompt(input, 512);

    assert.equal(result.compacted, true);
    assert.equal(result.prompt.length, 512);
    assert.match(result.prompt, /^TEST COMMAND/u);
    assert.match(result.prompt, /ARGUS_RUNTIME_PROMPT_COMPACTED/u);
    assert.match(result.prompt, /FAILURE SUMMARY\nTicket and plan$/u);
    assert.equal(result.originalChars, input.length);
    assert.equal(result.finalChars, 512);
    assert.ok(result.omittedChars > 0);
  });

  it('rejects nonsensical prompt budgets', () => {
    assert.throws(() => compactRuntimePrompt('prompt', 100), /at least 256/u);
  });
});
