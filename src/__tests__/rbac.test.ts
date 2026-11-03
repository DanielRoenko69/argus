import { isToolAllowed, isToolAllowedByPatterns, hashApiKey, generateApiKey } from '../auth/apiKeyRbac.js';
import type { ApiKeyRbacEntry } from '../auth/apiKeyRbac.js';

const entry = (overrides: Partial<ApiKeyRbacEntry> = {}): ApiKeyRbacEntry => ({
  key_prefix: 'ak_test',
  label: 'test',
  allowed_bundles: null,
  allowed_tools: null,
  denied_tools: null,
  scope: 'both',
  enabled: true,
  key_hash: null,
  ...overrides,
});

describe('isToolAllowed — RBAC tool filtering', () => {
  test('allows everything when no restrictions set', () => {
    const e = entry();
    expect(isToolAllowed(e, 'kubernetes_list_pods')).toBe(true);
    expect(isToolAllowed(e, 'grafana_query')).toBe(true);
  });

  test('whitelist: allows matching tool', () => {
    const e = entry({ allowed_tools: ['kubernetes_*'] });
    expect(isToolAllowed(e, 'kubernetes_list_pods')).toBe(true);
    expect(isToolAllowed(e, 'kubernetes_get_deployment')).toBe(true);
  });

  test('whitelist: blocks non-matching tool', () => {
    const e = entry({ allowed_tools: ['kubernetes_*'] });
    expect(isToolAllowed(e, 'grafana_query')).toBe(false);
    expect(isToolAllowed(e, 'opensearch_search')).toBe(false);
  });

  test('blacklist: blocks matching tool', () => {
    // '*_delete' matches tools that end with '_delete' exactly
    // '*_delete_*' matches tools that contain '_delete_' in the middle
    const e = entry({ denied_tools: ['*_delete_*', '*_exec'] });
    expect(isToolAllowed(e, 'kubernetes_delete_pod')).toBe(false);  // contains _delete_
    expect(isToolAllowed(e, 'grafana_query')).toBe(true);
  });

  test('blacklist: exact suffix match', () => {
    const e = entry({ denied_tools: ['kubernetes_delete'] });
    expect(isToolAllowed(e, 'kubernetes_delete')).toBe(false);
    expect(isToolAllowed(e, 'kubernetes_delete_pod')).toBe(true);  // suffix only, no match
  });

  test('whitelist + blacklist: whitelist first, then blacklist', () => {
    const e = entry({
      allowed_tools: ['kubernetes_*'],
      denied_tools: ['kubernetes_delete_*'],
    });
    expect(isToolAllowed(e, 'kubernetes_list_pods')).toBe(true);
    expect(isToolAllowed(e, 'kubernetes_delete_pod')).toBe(false);
  });

  test('shared pattern policy keeps deny precedence for Agent runtimes', () => {
    const policy = {
      allowedTools: ['e2e_prometheus_*'],
      deniedTools: ['e2e_prometheus_query_range'],
      apiKeyPrefix: 'ak_e2e',
    };
    expect(isToolAllowedByPatterns(policy, 'e2e_prometheus_query')).toBe(true);
    expect(isToolAllowedByPatterns(policy, 'e2e_prometheus_query_range')).toBe(false);
    expect(isToolAllowedByPatterns(policy, 'e2e_fabric_fabric_status')).toBe(false);
  });

  test('SQL LIKE % wildcard also works', () => {
    const e = entry({ allowed_tools: ['kubernetes_%'] });
    expect(isToolAllowed(e, 'kubernetes_list_pods')).toBe(true);
    expect(isToolAllowed(e, 'grafana_query')).toBe(false);
  });

  test('exact match without wildcard', () => {
    const e = entry({ allowed_tools: ['grafana_query'] });
    expect(isToolAllowed(e, 'grafana_query')).toBe(true);
    expect(isToolAllowed(e, 'grafana_query_advanced')).toBe(false);
  });

  test('case-insensitive matching', () => {
    const e = entry({ allowed_tools: ['Kubernetes_*'] });
    expect(isToolAllowed(e, 'kubernetes_list_pods')).toBe(true);
  });

  test('empty allowed_tools array = no tools allowed', () => {
    const e = entry({ allowed_tools: [] });
    // Empty array: length === 0, so the whitelist check is skipped → all allowed
    expect(isToolAllowed(e, 'kubernetes_list_pods')).toBe(true);
  });
});

describe('hashApiKey', () => {
  test('returns consistent SHA-256 hex', () => {
    const h1 = hashApiKey('ak_testkey');
    const h2 = hashApiKey('ak_testkey');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).toMatch(/^[0-9a-f]+$/);
  });

  test('different keys produce different hashes', () => {
    expect(hashApiKey('key_a')).not.toBe(hashApiKey('key_b'));
  });
});

describe('generateApiKey', () => {
  test('starts with ak_ prefix', () => {
    expect(generateApiKey()).toMatch(/^ak_[0-9a-f]{64}$/);
  });

  test('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
    expect(keys.size).toBe(100);
  });
});
