import { toolAllowedByPolicy } from '../toolPolicies.js';

describe('bundle backend tool policies', () => {
  it('keeps legacy and all-tool assignments open', () => {
    expect(toolAllowedByPolicy('pods_list', undefined)).toBe(true);
    expect(toolAllowedByPolicy('pods_list', {
      mode: 'all',
      allowedToolNames: [],
    })).toBe(true);
  });

  it('only allows explicitly selected tool names', () => {
    const policy = {
      mode: 'selected' as const,
      allowedToolNames: ['pods_list', 'deployments_get'],
    };

    expect(toolAllowedByPolicy('pods_list', policy)).toBe(true);
    expect(toolAllowedByPolicy('pods_delete', policy)).toBe(false);
  });

  it('fails closed for an empty selected-tool policy', () => {
    expect(toolAllowedByPolicy('newly_discovered_tool', {
      mode: 'selected',
      allowedToolNames: [],
    })).toBe(false);
  });
});
