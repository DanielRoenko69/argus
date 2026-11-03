import { describe, it, expect } from 'vitest';
import { ep } from '../endpoints';
describe('endpoints', () => {
  it('builds session + chat URLs', () => {
    expect(ep.agents()).toBe('/api/agents');
    expect(ep.sessions(7)).toBe('/api/agents/7/sessions');
    expect(ep.session(7, 'abc')).toBe('/api/agents/7/sessions/abc');
    expect(ep.chat(7, 'abc')).toBe('/api/agents/7/sessions/abc/chat');
    expect(ep.allowedModels(7)).toBe('/api/agents/7/allowed-models');
    expect(ep.me()).toBe('/api/me');
  });
});
