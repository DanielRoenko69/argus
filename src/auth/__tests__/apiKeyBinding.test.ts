import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { assertCanBindKeyToUser, canBindApiKeyToUser, listApiKeyBindingTargets, parseApiKeyBinding } from '../apiKeyBinding.js';

describe('API key identity binding', () => {
  const creator = { id: 3, role: 'operations_admin' };
  const target = { id: 4, role: 'developer', enabled: true };

  it('allows an explicit service identity and only valid numeric user IDs', () => {
    expect(parseApiKeyBinding(null)).toBeNull();
    expect(parseApiKeyBinding(undefined)).toBeNull();
    expect(parseApiKeyBinding(3)).toBe(3);
    for (const value of ['3', '', 0, -1, 1.5, NaN, Infinity, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseApiKeyBinding(value)).toThrow('positive integer');
    }
  });

  it('allows self and strictly lower roles, never another peer or a higher role', () => {
    expect(canBindApiKeyToUser(creator, target)).toBe(true);
    expect(canBindApiKeyToUser(creator, { ...target, id: 3, role: creator.role })).toBe(true);
    expect(canBindApiKeyToUser(creator, { ...target, role: creator.role })).toBe(false);
    expect(canBindApiKeyToUser(creator, { ...target, role: 'platform_admin' })).toBe(false);
    expect(canBindApiKeyToUser(creator, { ...target, id: 3, role: 'platform_admin' })).toBe(false);
    expect(canBindApiKeyToUser({ id: 3, role: 'admin' }, { ...target, id: 3, role: 'platform_admin' })).toBe(true);
  });

  it('fails closed for missing identity, disabled target and unknown roles', () => {
    expect(canBindApiKeyToUser(undefined, target)).toBe(false);
    expect(canBindApiKeyToUser({ ...creator, id: 0 }, target)).toBe(false);
    expect(canBindApiKeyToUser(creator, { ...target, enabled: false })).toBe(false);
    expect(canBindApiKeyToUser(creator, { ...target, role: 'unknown' })).toBe(false);
    expect(canBindApiKeyToUser({ ...creator, role: 'unknown' }, target)).toBe(false);
  });

  it('rechecks the current target on submission, including a disabled self', async () => {
    const query = jest.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ ...target, id: 3, role: creator.role }] }));
    const pool = { query } as unknown as pg.Pool;
    await expect(assertCanBindKeyToUser(pool, creator, 3)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [3]);
    query.mockResolvedValueOnce({ rows: [] });
    await expect(assertCanBindKeyToUser(pool, creator, 3)).rejects.toThrow('not permitted');
    query.mockResolvedValueOnce({ rows: [{ ...target, id: 3, role: creator.role, enabled: false }] });
    await expect(assertCanBindKeyToUser(pool, creator, 3)).rejects.toThrow('not permitted');
    query.mockClear();
    await expect(assertCanBindKeyToUser(pool, creator, null)).resolves.toBeUndefined();
    await expect(assertCanBindKeyToUser(pool, undefined, 3)).rejects.toThrow('authenticated');
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the same policy for discovery and returns only safe eligible labels', async () => {
    const rows = [
      { ...target, username: 'dev', display_name: 'Developer' },
      { ...target, id: 3, role: creator.role, username: 'self', display_name: 'Self' },
      { ...target, id: 5, role: creator.role, username: 'peer', display_name: 'Peer' },
      { ...target, id: 6, enabled: false, username: 'off', display_name: 'Disabled' },
    ];
    const pool = { query: jest.fn(async () => ({ rows })) } as unknown as pg.Pool;
    expect(await listApiKeyBindingTargets(pool, creator)).toEqual([
      { id: 4, role: 'developer', username: 'dev', display_name: 'Developer', is_self: false },
      { id: 3, role: creator.role, username: 'self', display_name: 'Self', is_self: true },
    ]);
    expect(await listApiKeyBindingTargets(pool, undefined)).toEqual([]);
  });
});
