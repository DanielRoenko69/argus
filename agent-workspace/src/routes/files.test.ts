import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyExactTextEdit } from './files.js';

describe('applyExactTextEdit', () => {
  it('replaces one unique block and reports the replacement count', () => {
    assert.deepEqual(
      applyExactTextEdit('before\nold block\nafter\n', 'old block', 'new block'),
      { content: 'before\nnew block\nafter\n', replacements: 1 },
    );
  });

  it('fails closed when the precondition is missing or ambiguous', () => {
    assert.throws(() => applyExactTextEdit('current', 'stale', 'next'), /not found/);
    assert.throws(() => applyExactTextEdit('same same', 'same', 'next'), /matched 2 locations/);
  });

  it('allows an explicit replace-all operation', () => {
    assert.deepEqual(
      applyExactTextEdit('same same', 'same', 'next', true),
      { content: 'next next', replacements: 2 },
    );
  });
});
