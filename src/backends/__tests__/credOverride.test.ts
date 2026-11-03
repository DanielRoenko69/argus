import { describe, it, expect } from '@jest/globals';
import { buildAuthHeaders, type CustomBackendRow } from '../customBackends.js';

function backend(overrides: Partial<CustomBackendRow>): CustomBackendRow {
  return {
    id: 1, name: 'jira', description: '', base_url: 'https://jira.test',
    auth_type: 'bearer', auth_value: null, health_path: null,
    default_headers: {}, timeout_ms: 30000, tls_skip_verify: false, enabled: true,
    backend_type: 'http', mcp_endpoint: null, transport_type: 'streamable-http',
    builtin_key: null, auth_mode: 'service-account',
    oauth_authorize_url: null, oauth_token_url: null, oauth_client_id: null,
    oauth_client_secret: null, oauth_scopes: null, oauth_revoke_url: null,
    config: {}, bundle_id: null, bundle_ids: [], created_at: '', updated_at: '',
    ...overrides,
  };
}

describe('buildAuthHeaders with cred override', () => {
  it('uses the backend stored creds when no override given', () => {
    const h = buildAuthHeaders(backend({ auth_type: 'bearer', auth_value: 'service-tok' }));
    expect(h['Authorization']).toBe('Bearer service-tok');
  });

  it('uses the override token when provided (does not mutate the backend)', () => {
    const b = backend({ auth_type: 'bearer', auth_value: 'service-tok' });
    const h = buildAuthHeaders(b, { token: 'bundle-tok' });
    expect(h['Authorization']).toBe('Bearer bundle-tok');
    expect(b.auth_value).toBe('service-tok'); // unchanged
  });

  it('falls back to stored creds when override token is null', () => {
    const h = buildAuthHeaders(backend({ auth_type: 'bearer', auth_value: 'service-tok' }), { token: null });
    expect(h['Authorization']).toBe('Bearer service-tok');
  });
});
