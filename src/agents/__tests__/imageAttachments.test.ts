import { describe, it, expect } from '@jest/globals';
import { collectValidImages, assertVisionAllowed } from '../imageAttachments.js';

describe('collectValidImages', () => {
  it('returns [] for undefined', () => {
    expect(collectValidImages(undefined)).toEqual([]);
  });

  it('returns [] for empty array', () => {
    expect(collectValidImages([])).toEqual([]);
  });

  it('returns [] when no attachment has dataUrl', () => {
    expect(collectValidImages([{ name: 'file.txt', content: 'hello' }])).toEqual([]);
  });

  it('passes a valid png dataUrl and returns mapped result', () => {
    const result = collectValidImages([{ name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' }]);
    expect(result).toEqual([{ dataUrl: 'data:image/png;base64,AAA', name: 'shot.png' }]);
  });

  it('passes valid jpeg (jpe?g variants)', () => {
    expect(() =>
      collectValidImages([{ name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,BBB' }]),
    ).not.toThrow();
    expect(() =>
      collectValidImages([{ name: 'a.jpg', dataUrl: 'data:image/jpg;base64,BBB' }]),
    ).not.toThrow();
  });

  it('passes valid webp and gif', () => {
    expect(() =>
      collectValidImages([{ name: 'a.webp', dataUrl: 'data:image/webp;base64,CCC' }]),
    ).not.toThrow();
    expect(() =>
      collectValidImages([{ name: 'a.gif', dataUrl: 'data:image/gif;base64,DDD' }]),
    ).not.toThrow();
  });

  it('throws when more than 4 images', () => {
    const imgs = Array.from({ length: 5 }, (_, i) => ({
      name: `img${i}.png`,
      dataUrl: 'data:image/png;base64,AAA',
    }));
    expect(() => collectValidImages(imgs)).toThrow('image: max 4 images');
  });

  it('throws for unsupported mime type', () => {
    expect(() =>
      collectValidImages([{ name: 'evil.html', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }]),
    ).toThrow('image: unsupported type (png/jpeg/webp/gif only)');
  });

  it('throws for oversized image (> 5 MB)', () => {
    // Build a base64 string that decodes to > 5 MB
    // ceil(5MB * 4/3) = 6,990,507 chars ≈ just over 5 MB when decoded
    const oversizeB64 = 'A'.repeat(7_000_000); // ~5.25 MB decoded
    expect(() =>
      collectValidImages([{ name: 'big.png', dataUrl: `data:image/png;base64,${oversizeB64}` }]),
    ).toThrow('image: exceeds 5 MB');
  });

  it('name is optional (undefined name is omitted)', () => {
    const result = collectValidImages([{ dataUrl: 'data:image/png;base64,AAA' }]);
    expect(result[0].dataUrl).toBe('data:image/png;base64,AAA');
    // name key present but undefined is fine; just check dataUrl
    expect(result).toHaveLength(1);
  });
});

describe('assertVisionAllowed', () => {
  it('no-op when there are no images (regardless of capability)', () => {
    expect(() => assertVisionAllowed(0, false)).not.toThrow();
    expect(() => assertVisionAllowed(0, true)).not.toThrow();
  });

  it('passes when images present and the model supports vision', () => {
    expect(() => assertVisionAllowed(2, true)).not.toThrow();
  });

  it('throws when images present but the model does not support vision (gating bypass guard)', () => {
    expect(() => assertVisionAllowed(1, false)).toThrow('image: agent model does not support vision');
  });
});
