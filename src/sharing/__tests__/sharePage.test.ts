import { describe, it, expect } from '@jest/globals';
import { renderSharePage, renderPasswordGate } from '../sharePage.js';

describe('renderSharePage', () => {
  it('escapes message content (no XSS) and is read-only (no composer/form)', () => {
    const html = renderSharePage({ title: 'T', expires_at: '2099-01-01T00:00:00Z',
      messages: [{ role: 'user', content: '<script>alert(1)</script> hi' }, { role: 'assistant', content: 'ok' }] });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toMatch(/noindex/);
    expect(html).not.toMatch(/<textarea|<input|Senden/i);   // read-only, no composer
  });
  it('renders a password gate form posting to unlock', () => {
    const html = renderPasswordGate('tok123');
    expect(html).toMatch(/type="password"/);
    expect(html).toContain('/share/tok123/unlock');
  });
});
