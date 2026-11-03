import { describe, it, expect } from 'vitest';
import { isArtifactLang } from '../artifactLang.js';

describe('isArtifactLang', () => {
  it('true for renderable artifact langs', () => {
    expect(isArtifactLang('mermaid')).toBe(true);
    expect(isArtifactLang('html')).toBe(true);
    expect(isArtifactLang('svg')).toBe(true);
  });
  it('false for other langs / undefined / empty', () => {
    expect(isArtifactLang('js')).toBe(false);
    expect(isArtifactLang('python')).toBe(false);
    expect(isArtifactLang(undefined)).toBe(false);
    expect(isArtifactLang('')).toBe(false);
  });
});
