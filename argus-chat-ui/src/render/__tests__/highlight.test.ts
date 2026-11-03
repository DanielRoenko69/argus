import { describe, it, expect } from 'vitest';
import { highlightToHtml } from '../highlight.js';

describe('highlightToHtml', () => {
  it('escapes HTML special chars (no live tags leak)', () => {
    const out = highlightToHtml('const x = "<script>alert(1)</script>";', 'javascript');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });
  it('returns a string for an unknown language (auto-detect)', () => {
    expect(typeof highlightToHtml('print(1)', 'no-such-lang')).toBe('string');
  });
});
