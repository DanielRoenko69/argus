import { describe, it, expect } from '@jest/globals';
import { resolveActivePath, leafOf, variantInfo, chainBranch, normalizeLinear, ancestorsInclusive } from '../messageTree.js';
import type { ChatMessage } from '../types.js';

const m = (id: string, parentId: string | null, role: ChatMessage['role'], content = id): ChatMessage =>
  ({ id, parentId, role, content });

describe('resolveActivePath', () => {
  it('returns the whole array when activeLeafId is null (legacy/linear)', () => {
    const msgs = [m('a', null, 'user'), m('b', 'a', 'assistant')];
    expect(resolveActivePath(msgs, null).map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('returns the whole array when the leaf id is unknown (defensive fallback)', () => {
    const msgs = [m('a', null, 'user'), m('b', 'a', 'assistant')];
    expect(resolveActivePath(msgs, 'zzz').map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('walks root→leaf for the active branch, ignoring other branches', () => {
    const msgs = [m('u', null, 'user'), m('a1', 'u', 'assistant'), m('a2', 'u', 'assistant')];
    expect(resolveActivePath(msgs, 'a2').map((x) => x.id)).toEqual(['u', 'a2']);
    expect(resolveActivePath(msgs, 'a1').map((x) => x.id)).toEqual(['u', 'a1']);
  });
});

describe('leafOf', () => {
  it('returns the node itself when it has no children', () => {
    const msgs = [m('u', null, 'user'), m('a', 'u', 'assistant')];
    expect(leafOf(msgs, 'a')).toBe('a');
  });
  it('walks down to the most-recent descendant', () => {
    const msgs = [m('u', null, 'user'), m('a', 'u', 'assistant'), m('u2', 'a', 'user'), m('a2', 'u2', 'assistant')];
    expect(leafOf(msgs, 'u')).toBe('a2');
  });
});

describe('variantInfo', () => {
  it('reports index + count among same-parent siblings', () => {
    const msgs = [m('u', null, 'user'), m('a1', 'u', 'assistant'), m('a2', 'u', 'assistant')];
    expect(variantInfo(msgs, 'a1')).toEqual({ index: 0, count: 2, siblingIds: ['a1', 'a2'] });
    expect(variantInfo(msgs, 'a2')).toEqual({ index: 1, count: 2, siblingIds: ['a1', 'a2'] });
  });
  it('count 1 for a lone child', () => {
    const msgs = [m('u', null, 'user'), m('a', 'u', 'assistant')];
    expect(variantInfo(msgs, 'a')).toEqual({ index: 0, count: 1, siblingIds: ['a'] });
  });
});

describe('normalizeLinear (legacy session upgrade)', () => {
  it('assigns ids + a linear parent chain to id-less messages; leaf = last id', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'more' },
    ];
    const { messages, leafId } = normalizeLinear(msgs);
    expect(messages[0].id).toBeTruthy();
    expect(messages[0].parentId).toBe(null);
    expect(messages[1].parentId).toBe(messages[0].id);
    expect(messages[2].parentId).toBe(messages[1].id);
    expect(leafId).toBe(messages[2].id);
    // The normalized array + its leaf resolves back to the full linear conversation.
    expect(resolveActivePath(messages, leafId).map((x) => x.content)).toEqual(['hi', 'yo', 'more']);
  });
  it('preserves ids/parents already present', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'a', id: 'x', parentId: null }];
    const { messages, leafId } = normalizeLinear(msgs);
    expect(messages[0].id).toBe('x');
    expect(leafId).toBe('x');
  });
  it('empty array → null leaf', () => {
    expect(normalizeLinear([]).leafId).toBe(null);
  });
});

describe('ancestorsInclusive', () => {
  const msgs = [m('u', null, 'user'), m('a', 'u', 'assistant'), m('u2', 'a', 'user'), m('a2', 'u2', 'assistant')];
  it('returns [] for null/undefined (root edit has no prior context)', () => {
    expect(ancestorsInclusive(msgs, null)).toEqual([]);
    expect(ancestorsInclusive(msgs, undefined)).toEqual([]);
  });
  it('returns root→nodeId inclusive for a real id', () => {
    expect(ancestorsInclusive(msgs, 'a').map((x) => x.id)).toEqual(['u', 'a']);
    expect(ancestorsInclusive(msgs, 'u').map((x) => x.id)).toEqual(['u']);
  });
});

describe('edit-branch composition (the logic runAgentChat applies for an edit)', () => {
  it('editing a mid-conversation user turn branches a sibling at its parent; history stops there', () => {
    const msgs = [m('u1', null, 'user'), m('a1', 'u1', 'assistant'), m('u2', 'a1', 'user'), m('a2', 'u2', 'assistant')];
    const edited = msgs.find((x) => x.id === 'u2')!;
    const branchParent = edited.parentId ?? null; // 'a1'
    // History fed to the LLM = root→branchParent (excludes the edited turn u2 + its answer a2).
    expect(ancestorsInclusive(msgs, branchParent).map((x) => x.id)).toEqual(['u1', 'a1']);
    // The new user turn chains under branchParent → a SIBLING of the edited message.
    const { chained } = chainBranch(branchParent, [{ role: 'user', content: 'edited' }]);
    expect(chained[0].parentId).toBe(branchParent);
    expect(chained[0].parentId).toBe(edited.parentId);
    // With both siblings present, that user turn now reports 2 variants.
    expect(variantInfo([...msgs, chained[0]], 'u2').count).toBe(2);
  });
  it('editing the first (root) user message starts a fresh root with empty history', () => {
    const msgs = [m('u1', null, 'user'), m('a1', 'u1', 'assistant')];
    const edited = msgs.find((x) => x.id === 'u1')!;
    expect(ancestorsInclusive(msgs, edited.parentId)).toEqual([]); // parentId null → []
    const { chained } = chainBranch(edited.parentId ?? null, [{ role: 'user', content: 'edited' }]);
    expect(chained[0].parentId).toBe(null);
  });
});

describe('chainBranch', () => {
  it('assigns ids + chains parentId from the given parent, returns the leaf', () => {
    const { chained, leafId } = chainBranch('u', [
      { role: 'assistant', content: 'hi' },
      { role: 'tool', content: 'res', name: 't' },
    ]);
    expect(chained[0].parentId).toBe('u');
    expect(chained[0].id).toBeTruthy();
    expect(chained[1].parentId).toBe(chained[0].id);
    expect(leafId).toBe(chained[1].id);
  });
  it('leaf is the parent when there are no messages', () => {
    expect(chainBranch('p', []).leafId).toBe('p');
  });
});
