import { describe, expect, it } from '@jest/globals';
import { decodeRunCursor, encodeRunCursor, parseRunReadModelQuery } from '../validation.js';

describe('run read model query validation', () => {
  it('supplies bounded root-view defaults', () => {
    expect(parseRunReadModelQuery({})).toEqual({
      view: 'root', includeChildren: 'summary', limit: 50, cursor: null,
      kinds: [], statuses: [], tagIds: [], query: '', hours: 2160,
    });
  });

  it('normalizes supported lists and limits', () => {
    expect(parseRunReadModelQuery({
      view: 'all', include_children: 'full', kind: 'workflow,agent,workflow',
      status: 'active,failed', tag: '2,7,2', limit: '25', hours: '24', q: 'payments',
    })).toMatchObject({
      view: 'all', includeChildren: 'full', kinds: ['workflow', 'agent'],
      statuses: ['active', 'failed'], tagIds: ['2', '7'], limit: 25, hours: 24, query: 'payments',
    });
  });

  it('rejects unsupported filters and malformed cursors', () => {
    expect(() => parseRunReadModelQuery({ kind: 'shell' })).toThrow('unsupported');
    expect(() => parseRunReadModelQuery({ tag: 'all' })).toThrow('positive integer');
    expect(() => decodeRunCursor('not-json')).toThrow('cursor is invalid');
  });

  it('round-trips an opaque deterministic cursor', () => {
    const cursor = { updatedAt: '2026-09-07T12:00:00.000Z', id: 'workflow:42' };
    expect(decodeRunCursor(encodeRunCursor(cursor))).toEqual(cursor);
  });
});
