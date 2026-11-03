import { describe, expect, it } from '@jest/globals';
import {
  PublicWidgetDemoError,
  normalizePublicWidgetDemoOrigin,
} from '../publicWidgetDemo.js';

describe('normalizePublicWidgetDemoOrigin', () => {
  it.each([
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173'],
    ['https://[::1]:3000', 'https://[::1]:3000'],
  ])('accepts an exact loopback origin %s', (input, expected) => {
    expect(normalizePublicWidgetDemoOrigin(input)).toBe(expected);
  });

  it.each([
    'https://argus.example.com',
    'http://localhost:3000/path',
    'http://user:secret@localhost:3000',
    'http://*.localhost:3000',
    'file:///tmp/widget.html',
    '',
  ])('rejects a non-local or non-origin value %s', input => {
    expect(() => normalizePublicWidgetDemoOrigin(input)).toThrow(PublicWidgetDemoError);
  });

  it('rejects non-string values', () => {
    expect(() => normalizePublicWidgetDemoOrigin(null)).toThrow('A local HTTP(S) origin is required');
  });
});
