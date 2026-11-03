import { describe, expect, it } from '@jest/globals';
import { canReadLegacyTimeWindowEvidence } from '../legacyRunEvidence.js';

const defaultScope = { tenantKey: 'default', workspaceKey: 'default' };

describe('legacy run inspector time-window gate', () => {
  it('withholds uncorrelated memories/hooks/audit rows from roles without audit.read', () => {
    expect(canReadLegacyTimeWindowEvidence({ role: 'viewer' }, defaultScope)).toBe(false);
    expect(canReadLegacyTimeWindowEvidence({ role: 'chat_user' }, defaultScope)).toBe(false);
    expect(canReadLegacyTimeWindowEvidence(undefined, defaultScope)).toBe(false);
    expect(canReadLegacyTimeWindowEvidence({ role: null }, defaultScope)).toBe(false);
  });

  it('allows audit readers only in the historical default workspace', () => {
    expect(canReadLegacyTimeWindowEvidence({ role: 'agent_operator' }, defaultScope)).toBe(true);
    expect(canReadLegacyTimeWindowEvidence({ role: 'platform_admin' }, defaultScope)).toBe(true);
    expect(canReadLegacyTimeWindowEvidence({ role: 'platform_admin' }, { tenantKey: 'acme', workspaceKey: 'default' }))
      .toBe(false);
  });
});
