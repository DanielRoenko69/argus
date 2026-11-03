import { describe, expect, it } from '@jest/globals';
import { normalizePublicWidgetMutation, normalizePublicWidgetOriginList } from '../widgetAdmin.js';

describe('public widget administration validation', () => {
  it('normalizes exact origins and bounded public runtime controls', () => {
    expect(normalizePublicWidgetMutation({
      slug: 'support_assistant',
      agentId: 7,
      allowedOrigins: ['https://Example.com/', 'https://example.com', 'http://localhost:5173'],
      enabled: true,
      greeting: ' Hello ',
      accent: '#7C3AED',
      title: ' Acme Assistant ',
      inputPlaceholder: ' Ask Acme... ',
      launcherIconUrl: 'https://cdn.example.com/assistant.svg',
      launcherIconAlt: ' Open assistant ',
      launcherPosition: 'left',
      rateLimitPerIp: 25,
      dailyTokenCap: 75_000,
    }, true)).toEqual({
      slug: 'support_assistant',
      agentId: 7,
      allowedOrigins: ['https://example.com', 'http://localhost:5173'],
      enabled: true,
      greeting: 'Hello',
      accent: '#7c3aed',
      title: 'Acme Assistant',
      inputPlaceholder: 'Ask Acme...',
      launcherIconUrl: 'https://cdn.example.com/assistant.svg',
      launcherIconAlt: 'Open assistant',
      launcherPosition: 'left',
      rateLimitPerIp: 25,
      dailyTokenCap: 75_000,
    });
  });

  it.each([
    ['wildcard', ['https://*.example.com']],
    ['path', ['https://example.com/support']],
    ['credentials', ['https://user:pass@example.com']],
    ['script scheme', ['javascript:alert(1)']],
  ])('rejects a %s origin', (_label, origins) => {
    expect(() => normalizePublicWidgetOriginList(origins)).toThrow(/Origin|Origins/);
  });

  it('rejects CSS injection and unsafe quota values', () => {
    expect(() => normalizePublicWidgetMutation({ slug: 'safe', agentId: 1, accent: 'red;}</style><script>' }, true)).toThrow('accent');
    expect(() => normalizePublicWidgetMutation({ slug: 'safe', agentId: 1, rateLimitPerIp: 0 }, true)).toThrow('rateLimitPerIp');
    expect(() => normalizePublicWidgetMutation({ slug: 'safe', agentId: 1, dailyTokenCap: 999 }, true)).toThrow('dailyTokenCap');
  });

  it('accepts root-relative launcher assets and rejects unsafe launcher URLs', () => {
    expect(normalizePublicWidgetMutation({ launcherIconUrl: '/brand/assistant.svg' }, false))
      .toEqual({ launcherIconUrl: '/brand/assistant.svg' });
    expect(() => normalizePublicWidgetMutation({ launcherIconUrl: 'javascript:alert(1)' }, false)).toThrow('launcherIconUrl');
    expect(() => normalizePublicWidgetMutation({ launcherIconUrl: '//evil.example/assistant.svg' }, false)).toThrow('launcherIconUrl');
    expect(() => normalizePublicWidgetMutation({ launcherIconUrl: 'https://user:secret@example.com/icon.svg' }, false)).toThrow('launcherIconUrl');
    expect(() => normalizePublicWidgetMutation({ launcherPosition: 'top' }, false)).toThrow('launcherPosition');
  });

  it('supports a minimal partial update without silently adding fields', () => {
    expect(normalizePublicWidgetMutation({ enabled: false }, false)).toEqual({ enabled: false });
  });
});
