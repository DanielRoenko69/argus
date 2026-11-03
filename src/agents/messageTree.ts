import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './types.js';

/** Root→leaf messages of the active branch. Null/unknown leaf ⇒ the whole array (legacy/linear, defensive). */
export function resolveActivePath(messages: ChatMessage[], activeLeafId: string | null | undefined): ChatMessage[] {
  if (!activeLeafId) return messages;
  const byId = new Map<string, ChatMessage>();
  for (const m of messages) if (m.id) byId.set(m.id, m);
  if (!byId.has(activeLeafId)) return messages; // defensive fallback — never throw into the chat path
  const path: ChatMessage[] = [];
  const seen = new Set<string>();
  let cur: ChatMessage | undefined = byId.get(activeLeafId);
  while (cur && cur.id && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** Walk down (most-recent child each level) from nodeId to a leaf id. */
export function leafOf(messages: ChatMessage[], nodeId: string): string {
  const childrenOf = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const p = m.parentId ?? null;
    if (p === null) continue;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(m);
  }
  let cur = nodeId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const kids = childrenOf.get(cur);
    if (!kids || kids.length === 0) break;
    const last = kids[kids.length - 1];
    if (!last.id) break;
    cur = last.id;
  }
  return cur;
}

/** Index + count of a node among its same-parent siblings, with their ids in array order. */
export function variantInfo(messages: ChatMessage[], id: string): { index: number; count: number; siblingIds: string[] } {
  const target = messages.find((x) => x.id === id);
  if (!target) return { index: 0, count: 1, siblingIds: [id] };
  const sibs = messages.filter((x) => x.id && (x.parentId ?? null) === (target.parentId ?? null));
  const siblingIds = sibs.map((x) => x.id as string);
  const index = siblingIds.indexOf(id);
  return { index: index < 0 ? 0 : index, count: siblingIds.length, siblingIds };
}

/** Assign ids + a parentId chain to new messages rooted at parentId; returns them + the new leaf id. */
export function chainBranch(
  parentId: string | null,
  messages: ChatMessage[],
): { chained: ChatMessage[]; leafId: string } {
  let prev: string | null = parentId;
  const chained = messages.map((msg) => {
    const id = randomUUID();
    const out: ChatMessage = { ...msg, id, parentId: prev };
    prev = id;
    return out;
  });
  return { chained, leafId: (prev ?? '') as string };
}

/**
 * Upgrade a legacy (pre-tree, id-less) message array to a linear tree: assign an id to every
 * message that lacks one and a linear parentId chain (preserving any ids/parents already present).
 * Returns the normalized array + the last message's id (the new leaf). Used to migrate an existing
 * session in place on first touch so continuation/regenerate connect to prior history.
 */
export function normalizeLinear(messages: ChatMessage[]): { messages: ChatMessage[]; leafId: string | null } {
  let prev: string | null = null;
  const out = messages.map((m) => {
    const id = m.id ?? randomUUID();
    const parentId = m.parentId === undefined ? prev : m.parentId;
    prev = id;
    return { ...m, id, parentId };
  });
  return { messages: out, leafId: prev };
}

/** Root→nodeId path (inclusive); [] when nodeId is null/undefined. Distinct from resolveActivePath,
 *  which falls back to the WHOLE array on a null leaf (legacy/linear read). Used for the edit branch
 *  point: editing the first message (parentId null) starts a fresh root with no prior context. */
export function ancestorsInclusive(messages: ChatMessage[], nodeId: string | null | undefined): ChatMessage[] {
  if (!nodeId) return [];
  return resolveActivePath(messages, nodeId);
}
