import { describe, it, expect } from '@jest/globals';
import { buildUserContent, userPersistText } from '../agentRunner.js';

describe('vision content building', () => {
  it('plain string when no images', () => {
    expect(buildUserContent('hello', undefined)).toBe('hello');
    expect(buildUserContent('hello', [])).toBe('hello');
  });
  it('content-array (text + image_url) when images present', () => {
    expect(buildUserContent('describe', [{ dataUrl: 'data:image/png;base64,AAA', name: 'x.png' }])).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });
  it('persist text appends a [Bild: …] marker, never base64', () => {
    expect(userPersistText('describe', [{ dataUrl: 'data:image/png;base64,AAA', name: 'x.png' }])).toBe('describe [Bild: x.png]');
    expect(userPersistText('describe', undefined)).toBe('describe');
  });
});
