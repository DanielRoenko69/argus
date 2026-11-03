import { describe, it, expect } from '@jest/globals';
import { chunkText } from '../chunk.js';

describe('chunkText', () => {
  it('returns one chunk for a short doc', () => {
    expect(chunkText('short text')).toEqual(['short text']);
  });
  it('returns [] for empty/whitespace', () => {
    expect(chunkText('   \n  ')).toEqual([]);
  });
  it('splits a long doc into overlapping windows', () => {
    const text = 'x'.repeat(2500);
    const chunks = chunkText(text, 1000, 150);
    expect(chunks.length).toBe(3);          // 0..1000, 850..1850, 1700..2500
    expect(chunks[0].length).toBe(1000);
    expect(chunks[2].length).toBe(800);
  });
});
