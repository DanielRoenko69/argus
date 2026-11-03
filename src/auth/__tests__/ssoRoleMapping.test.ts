import { resolveSsoRoleMapping } from '../ssoRoleMapping.js';

describe('SSO role mapping', () => {
  it('uses the strongest valid group mapping and keeps evidence', () => {
    expect(resolveSsoRoleMapping('viewer', ['devs', 'ops', 'ignored'], {
      devs: 'developer',
      ops: 'operations_admin',
      ignored: 'unknown',
    })).toEqual({
      effectiveRole: 'operations_admin',
      matched: [
        { group: 'devs', role: 'developer' },
        { group: 'ops', role: 'operations_admin' },
      ],
      usedDefault: false,
    });
  });

  it('uses a normalized default only when no valid mapping matched', () => {
    expect(resolveSsoRoleMapping('editor', ['unknown'], {})).toMatchObject({
      effectiveRole: 'developer',
      matched: [],
      usedDefault: true,
    });
  });

  it('allows an explicit group mapping below the configured default', () => {
    expect(resolveSsoRoleMapping('viewer', ['staff'], { staff: 'chat_user' }).effectiveRole).toBe('chat_user');
  });
});
