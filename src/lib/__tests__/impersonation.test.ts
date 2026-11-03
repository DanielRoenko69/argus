import { describe, it, expect, beforeEach } from '@jest/globals';
import { buildImpersonationHeaders, setK8sImpersonationConfig } from '../platformConfig.js';

// Locks the K8s-impersonation header contract (T6 verification). The setter does
// a partial merge, so beforeEach fully resets all fields for test isolation.
describe('buildImpersonationHeaders', () => {
  beforeEach(() => {
    setK8sImpersonationConfig({
      enabled: false, userSource: 'username',
      userHeader: undefined, defaultGroup: undefined, groupMap: undefined,
    });
  });

  it('returns no headers when impersonation is disabled', () => {
    expect(buildImpersonationHeaders({ username: 'alice' })).toEqual({});
  });

  it('returns no headers when there is no calling user', () => {
    setK8sImpersonationConfig({ enabled: true, userSource: 'username' });
    expect(buildImpersonationHeaders(undefined)).toEqual({});
  });

  it('injects Impersonate-User from the configured source (email)', () => {
    setK8sImpersonationConfig({ enabled: true, userSource: 'email' });
    expect(buildImpersonationHeaders({ email: 'alice@example.com' }))
      .toEqual({ 'Impersonate-User': 'alice@example.com' });
  });

  it('returns no headers when the configured source yields no value', () => {
    setK8sImpersonationConfig({ enabled: true, userSource: 'email' });
    expect(buildImpersonationHeaders({ username: 'alice' })).toEqual({});
  });

  it('maps role → Impersonate-Group via groupMap, else defaultGroup', () => {
    setK8sImpersonationConfig({
      enabled: true, userSource: 'username',
      defaultGroup: 'viewers', groupMap: { operations_admin: 'cluster-admins' },
    });
    expect(buildImpersonationHeaders({ username: 'alice', role: 'operations_admin' }))
      .toEqual({ 'Impersonate-User': 'alice', 'Impersonate-Group': 'cluster-admins' });
    expect(buildImpersonationHeaders({ username: 'bob', role: 'viewer' }))
      .toEqual({ 'Impersonate-User': 'bob', 'Impersonate-Group': 'viewers' });
  });
});
