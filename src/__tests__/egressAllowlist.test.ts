import { describe, it, expect } from '@jest/globals';
import { isEgressAllowed } from '../backends/customBackends.js';

describe('isEgressAllowed', () => {
  it('allows everything when allowlist is empty (feature disabled)', () => {
    expect(isEgressAllowed('https://anything.example/x', [])).toBe(true);
  });
  it('allows exact host match', () => {
    expect(isEgressAllowed('https://api.github.com/x', ['api.github.com'])).toBe(true);
  });
  it('allows subdomain of an allowlisted domain', () => {
    expect(isEgressAllowed('https://raw.github.com/x', ['github.com'])).toBe(true);
  });
  it('denies a non-allowlisted host', () => {
    expect(isEgressAllowed('https://evil.example/x', ['api.github.com'])).toBe(false);
  });
  it('denies an unparseable URL when allowlist is active', () => {
    expect(isEgressAllowed('not a url', ['api.github.com'])).toBe(false);
  });
});
