import { ARGUS_ROLES, ROLE_WEIGHTS, ROLE_COLORS, normalizeRole, parseArgusRole, hasRole } from '../roles.js';

describe('ArgusRole — chat_user', () => {
  it('chat_user weight is defined', () => {
    expect(ROLE_WEIGHTS['chat_user']).toBeDefined();
  });

  it('chat_user weight is less than viewer weight', () => {
    expect(ROLE_WEIGHTS['chat_user']).toBeLessThan(ROLE_WEIGHTS['viewer']);
  });

  it('chat_user weight is 5', () => {
    expect(ROLE_WEIGHTS['chat_user']).toBe(5);
  });

  it('normalizeRole("chat_user") returns "chat_user"', () => {
    expect(normalizeRole('chat_user')).toBe('chat_user');
  });

  it('hasRole("chat_user", "viewer") is false — chat_user lacks viewer rights', () => {
    expect(hasRole('chat_user', 'viewer')).toBe(false);
  });

  it('hasRole("viewer", "chat_user") is true — viewer has at least chat_user rights', () => {
    expect(hasRole('viewer', 'chat_user')).toBe(true);
  });

  it('normalizeRole for unknown role still falls back to viewer (not chat_user)', () => {
    expect(normalizeRole('totally_unknown')).toBe('viewer');
  });

  it('ROLE_COLORS has an entry for chat_user', () => {
    expect(ROLE_COLORS['chat_user']).toBeDefined();
    expect(typeof ROLE_COLORS['chat_user']).toBe('string');
  });

  it('accepts every managed role at administration boundaries', () => {
    for (const role of ARGUS_ROLES) expect(parseArgusRole(role)).toBe(role);
  });

  it('normalizes legacy aliases but rejects unknown administration input', () => {
    expect(parseArgusRole('admin')).toBe('platform_admin');
    expect(parseArgusRole('editor')).toBe('developer');
    expect(parseArgusRole('totally_unknown')).toBeNull();
  });
});
