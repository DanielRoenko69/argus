import { describe, it, expect } from 'vitest';
import { resolveActivePath, variantInfo } from '../messageTree.js';
import type { ChatMessage } from '../../data-provider/types.js';
const m = (id: string, parentId: string | null, role: ChatMessage['role']): ChatMessage => ({ id, parentId, role, content: id });

describe('SPA messageTree', () => {
  it('null leaf ⇒ whole array', () => {
    const msgs = [m('a', null, 'user'), m('b', 'a', 'assistant')];
    expect(resolveActivePath(msgs, null).map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('selects the active branch', () => {
    const msgs = [m('u', null, 'user'), m('a1', 'u', 'assistant'), m('a2', 'u', 'assistant')];
    expect(resolveActivePath(msgs, 'a1').map((x) => x.id)).toEqual(['u', 'a1']);
    expect(variantInfo(msgs, 'a2')).toEqual({ index: 1, count: 2, siblingIds: ['a1', 'a2'] });
  });
});
