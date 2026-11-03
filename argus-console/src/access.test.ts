import { describe, expect, it } from 'vitest';
import { isPlatformAdminRole } from './access';

describe('Console platform administration access', () => {
  it('accepts the canonical role and its legacy alias only', () => {
    expect(isPlatformAdminRole('platform_admin')).toBe(true);
    expect(isPlatformAdminRole('admin')).toBe(true);
    expect(isPlatformAdminRole('operations_admin')).toBe(false);
    expect(isPlatformAdminRole('viewer')).toBe(false);
    expect(isPlatformAdminRole(undefined)).toBe(false);
  });
});
