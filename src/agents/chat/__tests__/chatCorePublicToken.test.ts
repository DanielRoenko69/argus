/**
 * chatCorePublicToken.test.ts — TDD for P3-9 Task 9b
 *
 * Tests the `authMode: 'public-token'` branch of chatCoreScript.
 *
 * PCT1. chatCoreScript({authMode:'public-token', publicSlug:'x'}) contains
 *       the /session path: /public/widget/x/session
 * PCT2. Contains the /chat path: /public/widget/x/chat
 * PCT3. Contains Authorization header injection (Bearer token)
 * PCT4. Contains X-Widget-Token response header refresh logic
 * PCT5. Contains ensureSession function
 * PCT6. Contains 401 retry / clear token logic
 * PCT7. credentials:'omit' is used for the session endpoint (not same-origin cookie auth)
 * PCT8. authMode:'session' still contains /sessions/ path (no regression)
 * PCT9. authMode:'session' still uses credentials:'same-origin' (no regression)
 * PCT10. Shared SSE stream reader is not duplicated per-mode (ensureSession defined
 *        in public-token mode, sendMessage still present)
 */

import { describe, it, expect } from '@jest/globals';
import { chatCoreScript } from '../chatCore.js';

const SESSION_OPTS = {
  authMode: 'session' as const,
  features: { sessions: true, attachments: true, modelOverride: false },
  sessionsApiBase: '/api/agents',
  agentsJson: '[]',
};

const PUBLIC_TOKEN_OPTS = {
  authMode: 'public-token' as const,
  features: { sessions: false, attachments: false, modelOverride: false },
  sessionsApiBase: '',
  publicSlug: 'x',
  agentsJson: JSON.stringify([{ id: 1, label: 'Assistant' }]),
};

describe('chatCoreScript — authMode:public-token', () => {
  it('PCT1 — contains /public/widget/x/session path', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    expect(script).toContain('/public/widget/x/session');
  });

  it('PCT2 — contains /public/widget/x/chat path', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    expect(script).toContain('/public/widget/x/chat');
  });

  it('PCT3 — contains Authorization header with Bearer token', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    expect(script).toContain('Authorization');
    expect(script).toContain('Bearer');
  });

  it('PCT4 — contains X-Widget-Token header refresh', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    expect(script).toContain('X-Widget-Token');
  });

  it('PCT5 — contains ensureSession function', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    expect(script).toContain('ensureSession');
  });

  it('PCT6 — contains 401 retry / token clear logic', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    // Must handle 401 by clearing token and retrying ensureSession
    expect(script).toContain('401');
    expect(script).toContain('widgetToken');
  });

  it('PCT7 — uses credentials omit for session endpoint (not cookie auth)', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    // Allow either 'credentials: omit' or 'credentials:omit' (spacing variant)
    expect(script).toMatch(/credentials:\s*'omit'/);
  });

  it('PCT8 — authMode:session still contains /sessions/ path (no regression)', () => {
    const script = chatCoreScript(SESSION_OPTS);
    expect(script).toContain('/sessions/');
  });

  it('PCT9 — authMode:session still uses credentials:same-origin (no regression)', () => {
    const script = chatCoreScript(SESSION_OPTS);
    expect(script).toContain("credentials:'same-origin'");
  });

  it('PCT10 — public-token mode still contains sendMessage function', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    expect(script).toContain('sendMessage');
  });

  it('PCT11 — public-token mode does NOT contain same-origin session API calls', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    // The session-mode API base (/api/agents/...) should not appear in public-token mode
    expect(script).not.toContain('/api/agents');
  });

  it('PCT12 — public-token mode contains widgetToken and publicSessionId state vars', () => {
    const script = chatCoreScript(PUBLIC_TOKEN_OPTS);
    expect(script).toContain('widgetToken');
    expect(script).toContain('publicSessionId');
  });
});
